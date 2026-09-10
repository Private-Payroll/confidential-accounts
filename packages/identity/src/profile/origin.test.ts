import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCALHOST_FLAG, SiteRefusal, embedderFrom, frameAncestorsFor, isLoopbackOrigin,
  localhostOriginsAllowed, relyingPartyIdFor, sharedSite, usableOrigin,
} from './origin.js';
import { parseAsk } from './request.js';
import { REQUEST_SCHEMA } from './request.js';

/**
 * **ONE ORIGIN CHECK, PARSED, WITH ONE EXACT EXCEPTION.**
 *
 * ── THE EXCEPTION IS NOT A RELAXATION ─────────────────────────────────────
 *
 * The wallet refuses any origin that is not `https://`, and the reason is
 * right: an origin nobody can authenticate is a name, not an identity. **But
 * `localhost` is the one origin the platform authenticates without TLS** —
 * browsers define it as a secure context by specification, which is why
 * WebAuthn works there over plain `http`. **This wallet already depends on
 * that**: its passkey verification is tested against real WebAuthn responses
 * captured from `http://localhost:8951` with `rpId: 'localhost'`
 * (`packages/identity/src/passkey/verify.fixtures.ts:33-34`).
 *
 * So `§2` below is the exception, and `§1` is every refusal that must survive
 * it — **`https://localhost.evil.com` first**, because the `.com` is the whole
 * of the attack and any check that asks whether a host *contains* `localhost`
 * hands this wallet to whoever registers that name.
 *
 * ── AND `§4` IS THE GATE ──────────────────────────────────────────────────
 *
 * Nothing here is on in a production build. The default posture of this file is
 * the strict one — no test opts into development except the ones that are about
 * development — so every assertion in `§1` is made as production sees it.
 */

/* THE DEFAULT IS PRODUCTION. A test that wants the exception says so. */
beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv(LOCALHOST_FLAG, ''); });
afterEach(() => { vi.unstubAllEnvs(); });

const inDevelopment = () => vi.stubEnv(LOCALHOST_FLAG, '1');

/* ======================================================================== */

describe('§1 — THE HOST MATCH IS EXACT, AND THESE ARE THE FIVE THAT MUST NEVER PASS', () => {
  /*
   * **ASSERTED AGAINST `isLoopbackOrigin` AS WELL AS `usableOrigin`**, and the
   * first is the one that matters. `usableOrigin` refuses these in production
   * for TWO reasons — not loopback, and not a development build — so a test
   * that only checked it would still pass if the host match were a prefix test.
   * `isLoopbackOrigin` answers the exactness question on its own.
   */

  it('`https://localhost.evil.com` IS NOT LOCALHOST — the `.com` is the attack', () => {
    expect(isLoopbackOrigin('https://localhost.evil.com')).toBe(false);
    inDevelopment();
    expect(isLoopbackOrigin('https://localhost.evil.com')).toBe(false);

    /*
     * **AND IT IS STILL AN ORDINARY `https` ORIGIN, WHICH IS NOT A CONTRADICTION.**
     * This change joins the `https` rule with an exception; it does not add
     * refusals to it. `https://localhost.evil.com` is a site with a valid
     * certificate and the wallet treats it as one — it shows the person the
     * origin it observed, which is exactly the name in question. What must
     * never happen is that it is admitted as LOOPBACK, and that is the line
     * above.
     */
    expect(usableOrigin('https://localhost.evil.com')).toBe(true);
  });

  it('`http://localhost.evil.com` IS REFUSED, in development and in production', () => {
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false);
    expect(usableOrigin('http://localhost.evil.com')).toBe(false);
    inDevelopment();
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false);
    expect(usableOrigin('http://localhost.evil.com')).toBe(false);
  });

  it('`http://localhost.evil.com:3000` IS REFUSED — a port changes nothing', () => {
    inDevelopment();
    expect(isLoopbackOrigin('http://localhost.evil.com:3000')).toBe(false);
    expect(usableOrigin('http://localhost.evil.com:3000')).toBe(false);
  });

  it('`http://notlocalhost` IS REFUSED — the match is the whole host', () => {
    inDevelopment();
    expect(isLoopbackOrigin('http://notlocalhost')).toBe(false);
    expect(usableOrigin('http://notlocalhost')).toBe(false);
  });

  it('AND NO OTHER `http://` HOST IS ACCEPTED, whatever it is called', () => {
    inDevelopment();
    for (const origin of [
      'http://payroll-a.example',
      'http://localhost.example.com',
      'http://my-localhost',
      'http://localhost-staging',
      'http://127.0.0.2',
      'http://0.0.0.0',
      'http://[::2]',
      'http://192.168.0.10:5173',
      'http://evil.com/localhost',
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(false);
      expect(usableOrigin(origin), origin).toBe(false);
    }
  });
});

describe('§2 — THE THREE HOSTS A BROWSER CALLS SECURE WITHOUT TLS', () => {
  it('localhost, 127.0.0.1 and [::1] ARE ACCEPTED IN DEVELOPMENT, on any port', () => {
    inDevelopment();
    for (const origin of [
      'http://localhost', 'http://localhost:8951', 'http://localhost:5173',
      'http://127.0.0.1', 'http://127.0.0.1:5173',
      'http://[::1]', 'http://[::1]:5173',
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(true);
      expect(usableOrigin(origin), origin).toBe(true);
    }
  });

  it('THE WALLET`S OWN PASSKEY FIXTURE ORIGIN IS ONE OF THEM', () => {
    /*
     * `http://localhost:8951` is not an example chosen here — it is the origin
     * the wallet's real captured WebAuthn responses came from. The channel
     * being stricter than the credential layer beneath it is the thing this
     * change removed.
     */
    inDevelopment();
    expect(usableOrigin('http://localhost:8951')).toBe(true);
  });
});

describe('§3 — IT IS PARSED, NOT PATTERN-MATCHED — always', () => {
  it('`https://a b.example` IS REFUSED — the prefix test that accepted it is gone', () => {
    /*
     * **THE DEFECT.** The shared parser tested `startsWith('https://')` and looked
     * no further, so a name with a space in it was accepted as an origin and
     * only `unlock.ts` refused it. A URL parser refuses it at the host.
     */
    expect(usableOrigin('https://a b.example')).toBe(false);
  });

  it('AND SO IS ANYTHING CARRYING MORE THAN AN ORIGIN', () => {
    /*
     * A serialised origin is a scheme, a host and an optional port. `URL.origin`
     * drops everything else, so requiring the string to equal its own origin
     * refuses all of these without a clause for each.
     */
    inDevelopment();
    for (const origin of [
      'http://localhost/',
      'http://localhost/path',
      'http://localhost?x=1',
      'http://localhost:8951/#fragment',
      'http://user:pw@localhost',
      'http://LOCALHOST',
      'https://payroll.example/',
      'https://payroll.example/path',
    ]) {
      expect(usableOrigin(origin), origin).toBe(false);
    }
  });

  it('and an internationalised host is refused in the spelling a browser never emits', () => {
    /* A browser punycodes a host before it serialises an origin, so the unicode
     * spelling is not one it observed. The punycode spelling is fine. */
    expect(usableOrigin('https://例え.jp')).toBe(false);
    expect(usableOrigin('https://xn--r8jz45g.jp')).toBe(true);
  });

  it('AND EVERY REFUSAL THAT CAME BEFORE STILL REFUSES', () => {
    /* The `https` rule is joined by an exception, never relaxed. */
    for (const origin of ['', 'null', 'http://payroll-a.example', 'ftp://payroll.example']) {
      expect(usableOrigin(origin), origin).toBe(false);
    }
    expect(usableOrigin(undefined)).toBe(false);
    expect(usableOrigin(42)).toBe(false);
    expect(usableOrigin({ toString: () => 'https://payroll.example' })).toBe(false);
  });
});

describe('§4 — A PRODUCTION BUILD REFUSES LOCALHOST OUTRIGHT', () => {
  it('THE SAME ORIGIN IS ACCEPTED IN DEVELOPMENT AND REFUSED IN PRODUCTION', () => {
    /*
     * **THE GATE IS THE WHOLE OF THE SAFETY, so it is asserted as a
     * difference** rather than as two separate facts: one origin, one call,
     * two postures, and nothing else changed between them.
     */
    expect(localhostOriginsAllowed()).toBe(false);
    expect(usableOrigin('http://localhost:5173')).toBe(false);

    inDevelopment();
    expect(localhostOriginsAllowed()).toBe(true);
    expect(usableOrigin('http://localhost:5173')).toBe(true);

    vi.stubEnv(LOCALHOST_FLAG, '0');
    expect(localhostOriginsAllowed()).toBe(false);
    expect(usableOrigin('http://localhost:5173')).toBe(false);
  });

  it('AND `https` IS UNAFFECTED BY THE GATE, in either posture', () => {
    expect(usableOrigin('https://payroll.example')).toBe(true);
    inDevelopment();
    expect(usableOrigin('https://payroll.example')).toBe(true);
  });
});

describe('§5 — AND ALL THREE KINDS GO THROUGH IT', () => {
  const ask = (kind: string) => ({
    schema: REQUEST_SCHEMA,
    kind,
    requester: { name: 'Payroll', rdns: 'example.payroll' },
    purpose: 'so it can be shown to somebody',
    nonce: 'n',
    expiresAt: 60_000,
    ...(kind === 'disclosure'
      ? { wants: [{ attribute: 'legal-name', required: true }] }
      : {}),
    ...(kind === 'unlock' ? { company: 'a1'.repeat(32) } : {}),
  });

  it('SIGN-IN, DISCLOSURE AND UNLOCK ALL REFUSE localhost.evil.com', () => {
    /*
     * The real cost was that the strict door was on ONE of the three.
     * This is the assertion that the rule is shared rather than copied.
     */
    inDevelopment();
    for (const kind of ['sign-in', 'disclosure', 'unlock']) {
      expect(() => parseAsk(ask(kind), 'http://localhost.evil.com', 0), kind).toThrow();
    }
  });

  it('AND ALL THREE ACCEPT A REAL LOCALHOST ORIGIN IN DEVELOPMENT', () => {
    inDevelopment();
    for (const kind of ['sign-in', 'disclosure', 'unlock']) {
      expect(parseAsk(ask(kind), 'http://localhost:5173', 0).requester.origin, kind)
        .toBe('http://localhost:5173');
    }
  });

  it('AND ALL THREE REFUSE IT IN A PRODUCTION BUILD', () => {
    for (const kind of ['sign-in', 'disclosure', 'unlock']) {
      expect(() => parseAsk(ask(kind), 'http://localhost:5173', 0), kind).toThrow();
    }
  });
});

describe('§6 - A NAME BENEATH `localhost` IS A DEVELOPMENT ORIGIN, AND `localhost.evil.com` IS STILL NOT', () => {
  it('`http://app.pp.localhost:5173` IS ACCEPTED IN DEVELOPMENT and REFUSED IN PRODUCTION', () => {
    for (const origin of ['http://app.pp.localhost:5173', 'http://identity.pp.localhost:5180']) {
      expect(isLoopbackOrigin(origin), origin).toBe(true);
      expect(usableOrigin(origin), `${origin} in production`).toBe(false);
      inDevelopment();
      expect(usableOrigin(origin), `${origin} in development`).toBe(true);
      vi.stubEnv(LOCALHOST_FLAG, '');
    }
  });

  it('the LAST LABEL decides: every lookalike stays refused, in development too', () => {
    inDevelopment();
    for (const origin of [
      'http://localhost.evil.com', 'http://pp.localhost.evil.com', 'http://evil-localhost',
      'http://xlocalhost', 'http://.localhost', 'http://app.localhostx',
    ]) {
      expect(usableOrigin(origin), origin).toBe(false);
    }
  });
});

describe('§7 - THE SITE TWO SURFACES SHARE IS WHAT A PASSKEY AND A SIGN-IN BELONG TO', () => {
  it('two subdomains share their parent - the name the passkey must be made for', () => {
    expect(sharedSite('identity.privatepayroll.com', 'app.privatepayroll.com')).toBe('privatepayroll.com');
    expect(sharedSite('identity.pp.localhost', 'app.pp.localhost')).toBe('pp.localhost');
  });

  it('one host shares itself, which is every port of `localhost`', () => {
    expect(sharedSite('localhost', 'localhost')).toBe('localhost');
  });

  it('REFUSES a top-level name, no name at all, and an address, by name', () => {
    expect(() => sharedSite('app.example.com', 'identity.other.com')).toThrow(SiteRefusal);
    expect(() => sharedSite('app.example.com', 'identity.other.com')).toThrow(/share only "com"/);
    expect(() => sharedSite('app.example.com', 'identity.example.org')).toThrow(/share no name/);
    expect(() => sharedSite('127.0.0.1', 'localhost')).toThrow(/an address is only ever its own/);
    expect(() => sharedSite('', 'localhost')).toThrow(SiteRefusal);
  });

  it('the RELYING PARTY is the shared site whenever an embedder is configured - never the host', () => {
    expect(relyingPartyIdFor('identity.privatepayroll.com', 'https://app.privatepayroll.com'))
      .toBe('privatepayroll.com');
    expect(relyingPartyIdFor('identity.pp.localhost', 'http://app.pp.localhost:5173')).toBe('pp.localhost');
    expect(relyingPartyIdFor('localhost', 'http://localhost:5173')).toBe('localhost');
  });

  it('and a standalone wallet - no embedder - keeps its passkeys on its own host, exactly as before', () => {
    expect(relyingPartyIdFor('wallet.example.com', null)).toBe('wallet.example.com');
  });
});

describe('§8 - WHO MAY FRAME THE WALLET', () => {
  it('no embedder is `none`; one embedder is that origin and nothing else', () => {
    expect(frameAncestorsFor(null)).toBe("frame-ancestors 'none'");
    expect(frameAncestorsFor('https://app.privatepayroll.com'))
      .toBe('frame-ancestors https://app.privatepayroll.com');
  });

  it('an embedder must be an origin the wallet would accept a request from at all', () => {
    expect(embedderFrom(undefined)).toBeNull();
    expect(embedderFrom('')).toBeNull();
    expect(embedderFrom('https://app.privatepayroll.com')).toBe('https://app.privatepayroll.com');
    expect(() => embedderFrom('http://app.pp.localhost:5173')).toThrow(SiteRefusal);
    inDevelopment();
    expect(embedderFrom('http://app.pp.localhost:5173')).toBe('http://app.pp.localhost:5173');
    expect(() => embedderFrom('https://app.privatepayroll.com/')).toThrow(SiteRefusal);
  });
});
