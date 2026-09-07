import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCALHOST_FLAG, isLoopbackOrigin, localhostOriginsAllowed, usableOrigin,
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
