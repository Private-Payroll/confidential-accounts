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
const developmentBuild = (name: string): boolean => {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  if (env && name in env) return env[name] === '1';
  const proc = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return proc?.env?.[name] === '1';
};

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
  url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

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
