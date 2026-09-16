// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from '../keys/derivation.js';
import { ASK_KINDS, RequestError, parseAsk, parseRequest } from './request.js';
import { listen } from './channel.js';
import type { ChannelState, ChannelWindow } from './channel.js';
import { addressOfVerifyingKey, mint, verify } from './disclosure.js';
import { RESPONSE_SCHEMA, preimage, readPreimage } from './payload.js';
import type { Sent } from './model.js';

/**
 * **SIGNING IN IS ITS OWN KIND OF ASK.**
 *
 * The design's first draft said a sign-in was *"the same thing with an empty attribute
 * list"* and corrected itself the same day by checking: `request.ts` refuses a
 * request whose `wants` is empty — *the request asks for nothing* — and that
 * guard is right, because a disclosure asking for nothing is a bug in the
 * requester. **So this file is the other half of that correction**: a second
 * kind was ADDED, and every assertion the first kind already had is still in
 * `request.test.ts`, unchanged, running on fixtures that carry no `kind` at all.
 *
 * The second half of §4's sentence is the one that survived, and the last
 * describe below is it made executable: **the signature over origin + nonce +
 * address IS the authentication, and a verifier written for one kind accepts
 * the other with no new code.**
 */

/* jsdom has no `Buffer`, and the address codec needs one. The same line
 * `approve-screen.test.tsx` carries, for the same reason. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';
const NETWORK = 'stagenet' as const;
const identity = identityFromWords(TEST_MNEMONIC);
const SUBWALLET = 3;

/** A sign-in on the wire. **No `wants` key**, which is the point of the type. */
const signIn = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'sign-in',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So we know it is you.',
  nonce: 'n1',
  expiresAt: NOW + 60_000,
  ...over,
});

/** A disclosure on the wire, in the shape first shipped — no `kind` at all. */
const disclosure = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'To pay you, we need to know who you are.',
  wants: [{ attribute: 'given-name', required: true }],
  nonce: 'n1',
  expiresAt: NOW + 60_000,
  ...over,
});

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(RequestError);
    return (e as RequestError).code;
  }
  throw new Error('should have refused');
};

describe('§4 — A REQUEST DECLARES WHAT IT IS', () => {
  it('a sign-in parses, and the type it parses to has no attribute list at all', () => {
    const ask = parseAsk(signIn(), ORIGIN, NOW);
    expect(ask.kind).toBe('sign-in');
    /* Not an empty array. ABSENT — the same shape as the absent `origin`, and
     * for the same reason: a field that is sometimes read can be made to be
     * read, and a field that is never there cannot. */
    expect('wants' in ask).toBe(false);
    expect(ask.requester.origin).toBe(ORIGIN);
  });

  it('A SIGN-IN THAT CARRIES ATTRIBUTES IS REFUSED BY NAME, NOT IGNORED', () => {
    expect(codeOf(() => parseAsk(
      signIn({ wants: [{ attribute: 'given-name', required: true }] }), ORIGIN, NOW)))
      .toBe('attributes-on-a-sign-in');
  });

  it('and an EMPTY list on a sign-in is refused too — by presence, not by content', () => {
    /* `wants: []` is not "nothing asked for" here; it is a field that has no
     * business on this kind. Answering it would leave whoever sent it entitled
     * to believe the wallet had considered it. */
    expect(codeOf(() => parseAsk(signIn({ wants: [] }), ORIGIN, NOW)))
      .toBe('attributes-on-a-sign-in');
  });

  it('THE EMPTY-`wants` REFUSAL IS UNTOUCHED FOR A DISCLOSURE, named and stated', () => {
    /* The guard this change was told not to loosen. Both spellings of the ask
     * meet it: the one first shipped, and the one that names its kind. */
    expect(codeOf(() => parseAsk(disclosure({ wants: [] }), ORIGIN, NOW)))
      .toBe('nothing-asked-for');
    expect(codeOf(() => parseAsk(
      disclosure({ kind: 'disclosure', wants: [] }), ORIGIN, NOW)))
      .toBe('nothing-asked-for');
  });

  it('AN UNKNOWN KIND IS REFUSED BY NAME AND BECOMES NEITHER OF THE TWO', () => {
    /* `approve` is §4's third kind and is NOT built. A wallet that treated it
     * as one of these two would approve the wrong thing behind the right
     * screen. The message names what it was asked for and what it answers. */
    for (const kind of ['approve', 'sign_in', 'SIGN-IN', '', 'disclose']) {
      expect(codeOf(() => parseAsk(signIn({ kind }), ORIGIN, NOW))).toBe('unknown-kind');
    }
    try {
      parseAsk(signIn({ kind: 'approve' }), ORIGIN, NOW);
    } catch (e) {
      expect((e as Error).message).toContain('approve');
      expect((e as Error).message).toContain('sign-in');
      expect((e as Error).message).toContain('disclosure');
    }
  });

  it('a kind that is not even a string is refused the same way', () => {
    for (const kind of [null, 0, 1, true, ['sign-in'], { kind: 'sign-in' }]) {
      expect(codeOf(() => parseAsk(signIn({ kind }), ORIGIN, NOW))).toBe('unknown-kind');
    }
  });

  it('the kinds this wallet answers are the ones it has screens for', () => {
    /*
     * **THIS LINE MOVED, AND IT IS THE ONE EXISTING EXPECTATION THAT ROUND
     * CHANGED.** It read `['disclosure', 'sign-in']` and the title said *the
     * two*. The claim is `request.ts`'s and is unchanged — *a name in this
     * array is a promise that the screen behind it exists* — and the design
     * A change ordered a third kind and its screen. This is a CENSUS of what exists,
     * of the same family as `reachability.test.tsx`'s exempt-list pin: it is
     * here so that growth is loud in a diff, and it grew.
     *
     * `unlock.test.ts` asserts the stronger thing this change actually owes —
     * that the first two entries did not move — so nothing about the two older
     * kinds rests on this line alone.
     *
     * **IT MOVED AGAIN, WHICH IS THE CENSUS WORKING RATHER THAN THE CENSUS
     * FAILING.** It read `['disclosure', 'sign-in', 'unlock']` and this was the
     * only assertion in the repository that went red when `join` was appended.
     * The claim behind it is unchanged and is `request.ts`'s: **a name in this
     * array is a promise that the screen behind it exists**, and that change built the
     * screen it promises in `screens/approve.tsx`, in the frame the disclosure
     * already had. `join.test.ts` carries the stronger assertion for the fourth
     * kind — that it is APPENDED and not inserted, because `namedKinds` reads
     * this array out onto a screen a person is standing in front of.
     */
    /* **AND AGAIN FOR `keyring`**, appended fifth, with a screen of its own in
     * `screens/approve.tsx`. */
    /* **AND FOR `balance`**, appended sixth, with its screen in
     * `screens/approve-balance.tsx`. */
    expect([...ASK_KINDS]).toEqual(['disclosure', 'sign-in', 'unlock', 'join', 'keyring', 'balance']);
  });
});

describe('AN ABSENT KIND FAILS CLOSED, IN BOTH DIRECTIONS', () => {
  /*
   * The reasoning is in `request.ts`'s header and this is the check under it.
   * An omitted `kind` is a DISCLOSURE, which is the kind that demands MORE —
   * so a field that goes missing can never produce the attribute-free ask, and
   * a field that is added can never turn a real disclosure into one.
   */
  it('a disclosure with no `kind` is still exactly the disclosure first shipped', () => {
    const ask = parseAsk(disclosure(), ORIGIN, NOW);
    expect(ask.kind).toBe('disclosure');
    expect(ask.kind === 'disclosure' && ask.wants.map((w) => w.attribute))
      .toEqual(['given-name']);
  });

  it('STRIPPING `kind` OFF A SIGN-IN IN FLIGHT REFUSES IT — it does not become one', () => {
    const { kind, ...stripped } = signIn();
    expect(kind).toBe('sign-in');
    expect(codeOf(() => parseAsk(stripped, ORIGIN, NOW))).toBe('nothing-asked-for');
  });

  it('ADDING `kind: sign-in` TO A REAL DISCLOSURE REFUSES IT TOO', () => {
    expect(codeOf(() => parseAsk(disclosure({ kind: 'sign-in' }), ORIGIN, NOW)))
      .toBe('attributes-on-a-sign-in');
  });
});

describe('the disclosure-only door stays a disclosure-only door', () => {
  it('`parseRequest` refuses a sign-in BY NAME rather than returning an empty list', () => {
    expect(codeOf(() => parseRequest(signIn(), ORIGIN, NOW))).toBe('not-a-disclosure');
  });

  it('and every rule that was true of a disclosure is true of a sign-in', () => {
    /* The four §5.3 refusals, on the new kind, so none of them was reached
     * through the `wants` branch by accident. */
    expect(codeOf(() => parseAsk(signIn(), 'http://payroll-a.example', NOW)))
      .toBe('malformed-field');
    expect(codeOf(() => parseAsk(
      signIn({ requester: { name: 'A', rdns: 'a', origin: ORIGIN } }), ORIGIN, NOW)))
      .toBe('claims-its-own-origin');
    expect(codeOf(() => parseAsk(signIn({ origin: ORIGIN }), ORIGIN, NOW)))
      .toBe('claims-its-own-origin');
    expect(codeOf(() => parseAsk(signIn(), ORIGIN, NOW + 60_001))).toBe('expired');
    expect(codeOf(() => parseAsk(signIn({ schema: 'something/else' }), ORIGIN, NOW)))
      .toBe('wrong-schema');
  });
});

describe('the channel carries a sign-in and reads no kind of its own', () => {
  const channelFor = (opener: { postMessage: ReturnType<typeof vi.fn> }) => {
    const handlers: ((event: MessageEvent) => void)[] = [];
    const states: ChannelState[] = [];
    const view: ChannelWindow = {
      opener: opener as unknown as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => { /* not exercised here */ },
    };
    listen(view, () => NOW, (s) => states.push(s));
    const deliver = (event: Partial<MessageEvent>): void => {
      for (const h of handlers) h(event as MessageEvent);
    };
    return { states, deliver };
  };

  it('a sign-in arrives with the BROWSER\'S origin on it, like everything else', () => {
    const opener = { postMessage: vi.fn() };
    const { states, deliver } = channelFor(opener);
    deliver({ source: opener as never, origin: ORIGIN, data: signIn() });
    const last = states[states.length - 1]!;
    expect(last.of).toBe('request');
    expect(last.of === 'request' && last.request.kind).toBe('sign-in');
    expect(last.of === 'request' && last.request.requester.origin).toBe(ORIGIN);
  });

  it('an unknown kind becomes a REFUSED state that names the reason', () => {
    const opener = { postMessage: vi.fn() };
    const { states, deliver } = channelFor(opener);
    deliver({ source: opener as never, origin: ORIGIN, data: signIn({ kind: 'approve' }) });
    const last = states[states.length - 1]!;
    expect(last.of).toBe('refused');
    expect(last.of === 'refused' && last.error.code).toBe('unknown-kind');
  });
});

/* ---------------- one verifier, both kinds, and no new code --------------- */

const addressOf = (account: number): string =>
  addressOfVerifyingKey(
    signatureVerifyingKey({
      tag: 'schnorr',
      value: Buffer.from(identity.moneyAt(account).night).toString('hex'),
    }).value, NETWORK);

const AT = 1_755_000_000_000;

const minted = (disclosed: readonly Sent[], declined: readonly string[]) => mint(
  identity, SUBWALLET, {
    origin: ORIGIN,
    nonce: 'n1',
    address: addressOf(SUBWALLET),
    at: AT,
    disclosed,
    declined,
    requesterSaidItWas: { name: 'Payroll A', rdns: 'example.payroll-a' },
  });

const asSent = (id: string, about: string, text: string): Sent => ({
  id, about, says: { of: 'value', value: text }, asserted: { by: 'self', formerly: null },
});

const atA = {
  atOrigin: ORIGIN,
  expectingNonce: 'n1',
  payingAddress: addressOf(SUBWALLET),
  networkId: NETWORK,
  now: AT + 1000,
};

describe('§4 — THE PAYLOAD DOES NOT CHANGE, AND THAT IS THE POINT', () => {
  /*
   * **`verify`, `mint`, `preimage` AND `readPreimage` ARE IMPORTED FROM TWO
   * MODULES THIS CHANGE DID NOT OPEN.** `packages/identity/src/profile/disclosure.ts` and
   * `packages/identity/src/profile/payload.ts` are byte-identical to their earlier versions and the
   * entry carries their digests. So *a verifier written for one kind accepts
   * the other with no new code* is not an argument here — it is the only way
   * these assertions can pass at all.
   */
  it('ONE VERIFIER TAKES BOTH KINDS, and it is the same function both times', () => {
    const aDisclosure = minted([asSent('v1', 'given-name', 'Sarah')], []).response;
    const aSignIn = minted([], []).response;
    expect(verify(aDisclosure, atA)).toEqual({ ok: true });
    expect(verify(aSignIn, atA)).toEqual({ ok: true });
  });

  it('a sign-in IS that payload with `disclosed` empty — nothing else differs', () => {
    const aDisclosure = minted([asSent('v1', 'given-name', 'Sarah')], ['email']).response;
    const aSignIn = minted([], []).response;
    expect(aSignIn.payload.schema).toBe(RESPONSE_SCHEMA);
    expect(aSignIn.payload.disclosed).toEqual([]);
    expect(aSignIn.payload.declined).toEqual([]);
    /* Everything a recipient binds against is present and identical. */
    expect({ ...aSignIn.payload, disclosed: [], declined: [] })
      .toEqual({ ...aDisclosure.payload, disclosed: [], declined: [] });
    expect(aSignIn.scheme).toBe(aDisclosure.scheme);
  });

  it('the bytes a sign-in was signed over read back as the payload they are', () => {
    const { response, signedBytes } = minted([], []);
    expect(signedBytes.length).toBeGreaterThan(0);
    expect(readPreimage(preimage(response.payload))).toEqual(response.payload);
  });
});

describe('THE REPLAY BINDING, ON THE ACTION MOST LIKELY TO BE REPLAYED', () => {
  /*
   * §4: *a sign-in minted for one site cannot be replayed at another.* It is
   * the ask that happens constantly, so it is the one an attacker collects.
   * Each of the four bindings is dropped in turn and each has its own verdict.
   */
  it('a sign-in for A is REFUSED at B', () => {
    const aSignIn = minted([], []).response;
    expect(verify(aSignIn, { ...atA, atOrigin: 'https://payroll-b.example' }))
      .toMatchObject({ ok: false, code: 'origin-mismatch' });
  });

  it('a sign-in answering an earlier nonce is refused against a later request', () => {
    const aSignIn = minted([], []).response;
    expect(verify(aSignIn, { ...atA, expectingNonce: 'n2' }))
      .toMatchObject({ ok: false, code: 'nonce-mismatch' });
  });

  it('a sign-in is refused when the address about to be paid is a different one', () => {
    const aSignIn = minted([], []).response;
    expect(verify(aSignIn, { ...atA, payingAddress: addressOf(4) }))
      .toMatchObject({ ok: false, code: 'address-mismatch' });
  });

  it('AND REWRITING THE PAYLOAD TO AGREE WITH ITSELF DOES NOT HELP', () => {
    /* The tampering replay: change the origin in the payload so the recipient's
     * own check passes, and the signature — which is over the ORIGINAL bytes —
     * stops matching. This is what `verify` recomputing the preimage buys. */
    const aSignIn = minted([], []).response;
    const rewritten = {
      ...aSignIn,
      payload: { ...aSignIn.payload, origin: 'https://payroll-b.example' },
    };
    expect(verify(rewritten, { ...atA, atOrigin: 'https://payroll-b.example' }))
      .toMatchObject({ ok: false, code: 'signature-invalid' });
  });
});
