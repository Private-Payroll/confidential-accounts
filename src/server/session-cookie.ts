import { sharedSite } from 'midnight-identity/profile/origin';

/**
 * **THE SESSION, CARRIED BY A COOKIE SO A RELOAD DOES NOT END IT.**
 *
 * A session used to live in one variable in the page's memory, sent as a bearer
 * header. Nothing kept it, so every reload was another sign-in and another trip
 * through the wallet. It now arrives as a cookie the page's own code cannot
 * read, scoped to the site the application and the wallet share, and the server
 * reads it when no bearer header is sent.
 *
 * **A BEARER HEADER STILL WORKS AND STILL WINS.** Scripts and tests that sign in
 * over the API hold their token and send it; a request carrying one is judged by
 * it and never by a cookie that happens to ride along.
 *
 * **WHAT A COOKIE COSTS, AND WHERE IT IS PAID.** A header is only ever sent by
 * code that chose to send it; a cookie is sent by the browser on its own, which
 * is how a page elsewhere gets a signed-in person to change something without
 * knowing it. Three things stand against that and each is here: `SameSite=Strict`
 * keeps the cookie off every request another site starts; a write that arrives
 * on the cookie must show it came from the application's own origin; and the
 * cookie is `HttpOnly`, so nothing running in a page can copy it off the machine.
 */

export const SESSION_COOKIE = 'ca_session';

export interface CookieScope {
  /** The `Domain` attribute, or null for a cookie that belongs to one host only. */
  readonly domain: string | null;
  readonly secure: boolean;
}

/**
 * **WHERE THE COOKIE BELONGS: THE SITE BOTH SURFACES SHARE.**
 *
 * `app.privatepayroll.com` and `identity.privatepayroll.com` give
 * `Domain=privatepayroll.com`. **When the two surfaces are one host** - every
 * port of `localhost` - the cookie is left host-only: a browser will not store
 * a cookie scoped to a bare `localhost`, and a host-only cookie already reaches
 * every port of it. With no wallet origin configured there is no second surface
 * to share with, and the cookie belongs to the application's host.
 */
export function cookieScopeFor(appOrigin: string | undefined, walletOrigin: string | undefined): CookieScope {
  if (!appOrigin) return { domain: null, secure: false };
  const app = new URL(appOrigin);
  const secure = app.protocol === 'https:';
  if (!walletOrigin) return { domain: null, secure };
  const site = sharedSite(app.hostname, new URL(walletOrigin).hostname);
  return { domain: site === app.hostname ? null : site, secure };
}

const attributes = (scope: CookieScope): string =>
  `; Path=/; HttpOnly; SameSite=Strict${scope.secure ? '; Secure' : ''}`
  + `${scope.domain === null ? '' : `; Domain=${scope.domain}`}`;

/** The cookie a sign-in sets. It lives exactly as long as the session row it names. */
export function sessionCookie(token: string, expiresAt: string, scope: CookieScope, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${SESSION_COOKIE}=${token}${attributes(scope)}; Max-Age=${seconds}`;
}

/** The cookie a sign-out sets: the same name and scope, and already expired. */
export function clearedSessionCookie(scope: CookieScope): string {
  return `${SESSION_COOKIE}=${attributes(scope)}; Max-Age=0`;
}

/**
 * The session token in a `Cookie` header, or ''.
 *
 * **TWO SESSION COOKIES IS NO SESSION.** Every host under the site may set a
 * cookie for the whole site, so a sibling page can plant its own session beside
 * the real one, and a browser sends both. Taking the first would run this
 * person's page on whoever planted theirs; neither is trusted, and the person
 * signs in again.
 */
export function sessionFromCookieHeader(header: string | undefined): string {
  if (!header) return '';
  const found: string[] = [];
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === SESSION_COOKIE) found.push(part.slice(at + 1).trim());
  }
  return found.length === 1 ? found[0]! : '';
}

export interface Credential {
  readonly token: string;
  readonly via: 'bearer' | 'cookie' | 'none';
}

/** The bearer header if one was sent, otherwise the cookie. Never both. */
export function credentialOf(headers: { authorization?: string; cookie?: string }): Credential {
  const bearer = String(headers.authorization ?? '').replace(/^Bearer /, '');
  if (bearer !== '') return { token: bearer, via: 'bearer' };
  const cookie = sessionFromCookieHeader(headers.cookie);
  if (cookie !== '') return { token: cookie, via: 'cookie' };
  return { token: '', via: 'none' };
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const CROSS_SITE_WRITE =
  'this change was refused because it did not come from this application\'s own page. Nothing '
  + 'was changed. If you pressed something on this site, reload it and try again.';

/**
 * **A WRITE CARRIED BY THE COOKIE MUST COME FROM THE APPLICATION'S OWN ORIGIN.**
 *
 * `Origin` is set by the browser on every cross-origin request and every
 * non-`GET` same-origin one, and no page can forge it. Where it is missing the
 * browser's `Sec-Fetch-Site` stands in; a request with neither did not come
 * from a browser page and has no business arriving on a cookie. A bearer
 * request is not judged here - its credential is not sent by anybody but the
 * code holding it.
 *
 * Returns the refusal, or null when the request may proceed.
 */
export function crossSiteWriteRefusal(request: {
  readonly method: string;
  readonly via: Credential['via'];
  readonly origin: string | undefined;
  readonly fetchSite: string | undefined;
}, appOrigin: string | undefined): string | null {
  if (request.via !== 'cookie' || !WRITES.has(request.method.toUpperCase())) return null;
  if (request.origin !== undefined) {
    /* The configured origin as a browser serialises one, so a trailing slash
     * in configuration does not refuse every write the application makes. */
    return appOrigin !== undefined && request.origin === new URL(appOrigin).origin
      ? null : CROSS_SITE_WRITE;
  }
  return request.fetchSite === 'same-origin' ? null : CROSS_SITE_WRITE;
}

/**
 * **WHETHER THE SIGN-IN ANSWER MAY CARRY THE TOKEN ITSELF.** A browser sends
 * `Sec-Fetch-Site` on every request and no page can remove it; a browser gets
 * the cookie and never the token, so no script on the page ever holds one. A
 * client that is not a browser - a script, a test - gets the token it needs to
 * send as a bearer header.
 */
export const answerCarriesToken = (headers: Readonly<Record<string, unknown>>): boolean =>
  headers['sec-fetch-site'] === undefined;

/**
 * **A TAB SAYS WHO IT BELIEVES IT IS, AND A WRITE FOR SOMEBODY ELSE IS REFUSED.**
 *
 * A cookie belongs to the browser, not to the tab: a sign-in in one tab changes
 * the session every other tab sends. A tab still holding one person's keys would
 * otherwise write them under whoever signed in last - and the key bundle's
 * version counter, being a small number per person, can match by chance and let
 * one person's bundle replace another's. So a page names the person it was
 * prepared for, and the server refuses when the session is not that person.
 * **A client that names nobody is not judged**: a script holding its own token
 * knows whose it is.
 *
 * Returns the refusal, or null when the request may proceed.
 */
export const SIGNED_IN_AS_HEADER = 'x-signed-in-as';

export const ANOTHER_PERSON =
  'this tab was prepared for a different person from the one this browser is now signed in as - '
  + 'somebody signed in or out in another tab. Nothing was changed. Reload this page to continue '
  + 'as whoever is signed in now.';

export function anotherPersonRefusal(expected: unknown, userId: string): string | null {
  if (typeof expected !== 'string' || expected === '') return null;
  return expected === userId ? null : ANOTHER_PERSON;
}
