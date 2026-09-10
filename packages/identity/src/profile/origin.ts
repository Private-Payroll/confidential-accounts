/**
 * **WHO IS ASKING — ONE CHECK, USED BY ALL THREE KINDS.**
 *
 * Every request that crosses into this wallet carries the address of the site
 * making it, and **that address is the whole of the security**: it decides
 * which company's key is released, whose facts a disclosure names, and who a
 * sign-in is for. It is also the only place an answer is ever posted.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────
 *
 * The shared parser tested `observedOrigin.startsWith('https://')` and looked
 * no further, **so a name with a space in it — `https://a b.example` — was
 * accepted as an origin.** `unlock.ts` found that and built its own
 * stricter door rather than change shared code mid-round, which was right then
 * and left sign-in and disclosure standing behind the loose one.
 *
 * **ONE RULE NOW, IN ONE PLACE, AND BOTH DOORS CALL IT.** `unlock.ts` keeps its
 * door — a caller that assembled an ask by hand never went through the parser —
 * but it no longer keeps a second copy of the RULE, which is the thing that
 * drifts.
 *
 * ── IT IS PARSED, NOT PATTERN-MATCHED, AND THAT IS THE POINT ──────────────
 *
 * A regex that looks right here is how it happened. **`URL` is the
 * browser's own parser** — the same one that produced the string in the first
 * place — and `URL.origin` re-serialises it canonically. So the exactness test
 * is one line: **parse it, then require that its canonical origin is the whole
 * of what arrived.** Measured rather than reasoned, every one of these fails
 * that equality and needs no clause of its own:
 *
 *   · `http://localhost/`, `http://localhost/path`, `http://localhost?x=1`,
 *     `http://localhost:8951/#f` — a path, a query, a fragment or a trailing
 *     slash; `URL.origin` drops all four, so the string is not its own origin.
 *   · `http://user:pw@localhost` — credentials, dropped the same way.
 *   · `http://LOCALHOST` — a browser lower-cases a host before it serialises
 *     one, so a spelling it would never emit is not one it emitted.
 *   · `https://例え.jp` — an internationalised host reaches a page as punycode,
 *     so the unicode spelling is not what a browser observed either.
 *
 * And `https://a b.example` does not parse at all, which is the defect closed by
 * the parser rather than by a longer pattern.
 */

/**
 * **THE THREE HOSTS A BROWSER TREATS AS A SECURE CONTEXT WITHOUT TLS.**
 *
 * Not a convenience list. Browsers define these as **secure contexts by
 * specification**, which is why `crypto.subtle`, service workers and **WebAuthn**
 * all work on them over plain `http` — and **this wallet already depends on
 * that one layer down**: its passkey verification is tested against real
 * WebAuthn responses captured from `http://localhost:8951` with
 * `rpId: 'localhost'` (`packages/identity/src/passkey/verify.fixtures.ts:33-34`). The action
 * channel being stricter than the credential layer beneath it had no stated
 * reason.
 *
 * **EXACT HOSTS, MATCHED AS WHOLE STRINGS.** `https://localhost.evil.com` is
 * the attack this list is written against and **the `.com` is the whole of
 * it**: anything that asks whether a host *starts with* or *contains*
 * `localhost` hands the wallet to whoever registers that name.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Long enough for any real origin; short enough that nothing pathological
 * becomes a permanent value. Carried over from `unlock.ts`'s own door.
 */
const MAX_ORIGIN = 255;

/**
 * The environment flag, read the way it is established in the neighbouring
 * repository: **switched on inside the development script itself, never by
 * anything a person types.**
 *
 * **IT READS TWO PLACES BECAUSE THIS FILE RUNS IN TWO RUNTIMES, AND THAT IS ONE
 * RULE RATHER THAN TWO MECHANISMS.** A bundled wallet page has
 * `import.meta.env` and no `process`; a server importing this package has
 * `process.env` and an `import.meta` with no `env` on it. Each runtime is asked
 * for the same name, and a build that was not started by its own dev script has
 * neither.
 *
 * **`name in env` RATHER THAN A TRUTHINESS TEST**, and it is load-bearing:
 * under `vitest` `import.meta.env` EXISTS but `vi.stubEnv` writes only
 * `process.env` — measured, not assumed. A truthiness test would stop at the
 * empty first source and the flag would be untestable, which is how a gate ends
 * up with no test that it ever closes.
 */
export const buildSetting = (name: string): unknown => {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  if (env && name in env) return env[name];
  const proc = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return proc?.env?.[name];
};

const developmentBuild = (name: string): boolean => buildSetting(name) === '1';

/** The one name. Exported so a caller can say why it refused. */
export const LOCALHOST_FLAG = 'VITE_ALLOW_LOCALHOST_ORIGIN';

/** Whether this build was started by a development script. */
export const localhostOriginsAllowed = (): boolean => developmentBuild(LOCALHOST_FLAG);

/**
 * The origin as its own parser sees it, or null if the string is not exactly
 * one serialised origin and nothing else.
 */
function asOrigin(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORIGIN) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  /*
   * **THE WHOLE EXACTNESS TEST, AND IT IS THIS LINE.** `URL.origin` is the
   * canonical serialisation of scheme, host and port — nothing else. If the
   * string that arrived is not identical to it, the string carried something a
   * browser's own serialiser would never have put there.
   */
  if (url.origin !== value) return null;
  /* Belt and braces: credentials already fail the equality above, and a reader
   * should not have to work that out to believe they are refused. */
  if (url.username !== '' || url.password !== '') return null;
  return url;
}

/**
 * **THE HOST MATCH, IN ONE PLACE.**
 *
 * **THIS FUNCTION EXISTS BECAUSE A MUTATION FOUND ITS ABSENCE.** The first
 * version of this file had the match written out twice — once in
 * `isLoopbackOrigin` and once in `usableOrigin` — and breaking one of them
 * left the other correct, so three tests died where four should have.
 * **That is the same defect in miniature, in the file written to close it**: two copies
 * of one rule, agreeing until somebody edits one.
 */
const isLoopback = (url: URL): boolean =>
  url.protocol === 'http:' && (LOOPBACK_HOSTS.has(url.hostname) || isLocalhostName(url.hostname));

/**
 * **A NAME BENEATH `localhost`, MATCHED ON THE WHOLE LAST LABEL.**
 *
 * `app.pp.localhost` and `identity.pp.localhost` are the only way to run the
 * product's real shape - two surfaces under one shared name - on one machine
 * without a certificate. `localhost` on its own cannot do it: a browser treats
 * it as a public suffix, so two ports of it share no name a passkey or a cookie
 * could belong to. One label deeper, `pp.localhost` is a name both surfaces
 * share, and a browser that resolves `*.localhost` to this machine treats every
 * such host as a secure context.
 *
 * **THE TEST IS THE LAST LABEL, AND `localhost.evil.com` IS STILL REFUSED**,
 * because its last label is `com`. A check that asked whether a host
 * *contains* `localhost` is the attack this file is written against; this asks
 * whether the name ENDS in the label `localhost`, which a registered domain on
 * the public internet cannot do. **And it is still a development build's
 * exception only** - `usableOrigin` gates it exactly as it gates the other three.
 */
const isLocalhostName = (host: string): boolean =>
  host.endsWith('.localhost') && host.length > '.localhost'.length;

/**
 * **IS THIS ONE OF THE THREE LOOPBACK ORIGINS?** Independent of whether they
 * are allowed, so that the exactness of the host match can be tested on its
 * own — a predicate that can only be reached through a flag is a predicate
 * whose flag gets tested instead of it.
 */
export function isLoopbackOrigin(value: unknown): boolean {
  const url = asOrigin(value);
  return url !== null && isLoopback(url);
}

/**
 * **THE CHECK ITSELF. `https` ALWAYS; THE THREE LOOPBACK HOSTS IN DEVELOPMENT.**
 *
 * **THIS IS NOT A RELAXATION OF THE `https` RULE.** Every origin refused before
 * is refused now — the rule is joined by one exact exception, and outside a
 * development build not even that.
 */
export function usableOrigin(value: unknown): boolean {
  const url = asOrigin(value);
  if (url === null) return false;
  if (url.protocol === 'https:') return true;
  return isLoopback(url) && localhostOriginsAllowed();
}

/**
 * What to tell somebody, and it says which of the two reasons it was.
 *
 * A build that refuses `http://localhost:5173` because it is a production build
 * is a different fact from one that refuses `http://localhost.evil.com` because
 * that is not localhost at all, and a person debugging the first should not be
 * reading the sentence written for the second.
 */
export function whyNotUsable(value: unknown): string {
  if (isLoopbackOrigin(value) && !localhostOriginsAllowed()) {
    return 'this wallet only talks to a site over a secure connection. It can be built to '
      + 'allow a local development address as well, and this build was not.';
  }
  return 'this wallet could not observe a secure origin for whoever is asking, so it cannot '
    + 'tell you who they are. Nothing has been shown to them.';
}

/* ======================================================================== *
 * THE SITE TWO SURFACES SHARE
 * ======================================================================== */

/**
 * **WHY A SITE IS REFUSED, IN WORDS A PERSON CAN ACT ON.**
 *
 * Thrown when two hosts share no name a browser would let a passkey or a cookie
 * belong to. It is a configuration fault, never a runtime one: the two hosts
 * are fixed when a surface is built or started, so this is said once, loudly,
 * at start-up, rather than discovered by the first person who signs in.
 */
export class SiteRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteRefusal';
  }
}

const isIpLiteral = (host: string): boolean =>
  host.startsWith('[') || /^[0-9.]+$/.test(host);

/**
 * **THE NAME TWO HOSTS SHARE, WHICH IS WHAT A PASSKEY AND A COOKIE ARE SCOPED TO.**
 *
 * `app.privatepayroll.com` and `identity.privatepayroll.com` share
 * `privatepayroll.com`. A passkey whose relying party is that name is offered
 * on both hosts, and a cookie whose `Domain` is that name is sent to both. A
 * passkey bound to `identity.privatepayroll.com` is refused on
 * `app.privatepayroll.com` with `SecurityError` - that is the defect this
 * function exists to end.
 *
 * **COMPUTED FROM THE TWO HOSTS RATHER THAN CONFIGURED BESIDE THEM**, so the
 * relying party and the cookie cannot be set to a name neither host sits under.
 *
 * **WHAT IT REFUSES, AND WHY EACH IS A REFUSAL RATHER THAN A FALLBACK:**
 *   - no name in common at all - there is no site;
 *   - only a top-level name in common (`com`, `io`) - no browser lets a
 *     passkey or a cookie belong to one, so the answer would fail later and
 *     further from its cause;
 *   - an address rather than a name - two addresses share no site, and one
 *     address is only ever its own.
 *
 * **WHAT IT DOES NOT KNOW: the public suffix list.** A shared name such as
 * `co.uk` passes here and is refused by the browser at the first ceremony,
 * loudly. The hosts this is given are this product's own configuration, not
 * input from a stranger.
 */
export function sharedSite(first: string, second: string): string {
  const a = first.toLowerCase();
  const b = second.toLowerCase();
  if (a.length === 0 || b.length === 0) {
    throw new SiteRefusal('a surface was configured with no host, so there is no site to share.');
  }
  if (a === b) return a;
  if (isIpLiteral(a) || isIpLiteral(b)) {
    throw new SiteRefusal(
      `${a} and ${b} are not two names under one site - an address is only ever its own - `
      + 'so a passkey or a sign-in made on one cannot be used on the other. Serve both surfaces '
      + 'under one name.');
  }
  const x = a.split('.').reverse();
  const y = b.split('.').reverse();
  const common: string[] = [];
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i += 1) common.push(x[i]!);
  const site = common.reverse().join('.');
  if (common.length === 0) {
    throw new SiteRefusal(
      `${a} and ${b} share no name, so a passkey or a sign-in made on one cannot be used on the `
      + 'other. Serve both surfaces under one name.');
  }
  if (common.length === 1 && site !== 'localhost') {
    throw new SiteRefusal(
      `${a} and ${b} share only "${site}", which no browser lets a passkey or a sign-in belong `
      + 'to. Serve both surfaces under one name you own.');
  }
  return site;
}

/**
 * **THE ONE PAGE ALLOWED TO PUT THIS WALLET INSIDE ITSELF, OR NULL.**
 *
 * Read from a build's configuration. Absent means the wallet is standalone and
 * is framed by nobody. Present, it must be an origin this wallet would accept
 * a request from at all - the same `usableOrigin` rule, so a production build
 * cannot be told to trust an `http` page.
 */
export function embedderFrom(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!usableOrigin(value)) {
    throw new SiteRefusal(
      `the page this wallet was built to sit inside, ${String(value)}, is not an address it can `
      + `trust: ${whyNotUsable(value)}`);
  }
  return value as string;
}

/**
 * **THE RELYING PARTY A PASSKEY IS MADE FOR.**
 *
 * With no embedder the wallet stands alone and its passkeys belong to its own
 * host, exactly as before. **With one, they belong to the site the two share**,
 * so the one passkey works on both. The host is never the answer when an
 * embedder is configured - that is what `SecurityError` looked like.
 */
export function relyingPartyIdFor(ownHost: string, embedder: string | null): string {
  if (embedder === null) return ownHost;
  return sharedSite(ownHost, new URL(embedder).hostname);
}

/**
 * **WHO MAY FRAME THIS WALLET, AS THE BROWSER ENFORCES IT.**
 *
 * `frame-ancestors` is honoured only as a response header - a `<meta>` policy
 * ignores it - so this is the value whatever serves the wallet must send with
 * every document. This repository's development and preview servers send it;
 * a host that serves a build has to be configured to.
 * No embedder is `'none'`: nothing may frame it, which is what a standalone
 * wallet has always needed and never said.
 */
export function frameAncestorsFor(embedder: string | null): string {
  return `frame-ancestors ${embedder ?? "'none'"}`;
}

/**
 * **THE HEADERS EVERY DOCUMENT OF A SURFACE IS SERVED WITH, SO WHO MAY FRAME IT IS DECIDED IN ONE PLACE.**
 *
 * `X-Frame-Options: DENY` joins `'none'` for browsers that predate
 * `frame-ancestors`. It is left off when an embedder is named, because it has
 * no way to name one: a browser that reads both honours the policy, and one
 * that reads only the older header would refuse the embedder too.
 */
export function framingHeadersFor(embedder: string | null): Readonly<Record<string, string>> {
  return embedder === null
    ? { 'Content-Security-Policy': frameAncestorsFor(null), 'X-Frame-Options': 'DENY' }
    : { 'Content-Security-Policy': frameAncestorsFor(embedder) };
}
