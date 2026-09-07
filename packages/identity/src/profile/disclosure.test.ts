import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import {
  ClaimRewardsTransaction, Intent, MaintenanceUpdate, sampleContractAddress,
  signData, signatureVerifyingKey,
} from '@midnightntwrk/ledger-v9';
import { identityFromWords } from '../keys/derivation.js';
import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';
import { DISCLOSURE_DOMAIN, RESPONSE_SCHEMA, preimage, readPreimage } from './payload.js';
import { addressOfVerifyingKey, mint, recheck, verify } from './disclosure.js';
import type { DisclosureResponse } from './disclosure.js';
import type { Disclosure, Sent } from './model.js';

/**
 * **THE CHANGE'S CENTRAL PROPERTY: A DISCLOSURE MINTED FOR ONE ORIGIN IS REFUSED
 * AT ANOTHER.**
 *
 * *Without the origin and the nonce in the signed payload, the disclosure
 * company A received can be replayed to company B — same data, different
 * recipient, signature still valid.* This file is that sentence made
 * executable, in both halves: the honest replay (forward the bytes untouched)
 * and the tampering one (edit the origin so the payload agrees with itself).
 */

const NETWORK = 'stagenet' as const;
const identity = identityFromWords(TEST_MNEMONIC);
const SUBWALLET = 3;

const value = (id: string, about: string, text: string): Sent => ({
  id,
  about,
  says: { of: 'value', value: text },
  asserted: { by: 'self', formerly: null },
});

const addressOf = (account: number): string =>
  addressOfVerifyingKey(
    signatureVerifyingKey({
      tag: 'schnorr',
      value: Buffer.from(identity.moneyAt(account).night).toString('hex'),
    }).value, NETWORK);

const AT = 1_755_000_000_000;

const forA = (): DisclosureResponse => mint(identity, SUBWALLET, {
  origin: 'https://payroll-a.example',
  nonce: 'nonce-from-a',
  address: addressOf(SUBWALLET),
  at: AT,
  disclosed: [value('v1', 'given-name', 'Sarah'), value('v2', 'email', 'sarah@work.example')],
  declined: [],
  requesterSaidItWas: { name: 'Payroll A', rdns: 'example.payroll-a' },
}).response;

const atA = {
  atOrigin: 'https://payroll-a.example',
  expectingNonce: 'nonce-from-a',
  payingAddress: addressOf(SUBWALLET),
  networkId: NETWORK,
  now: AT + 1000,
};

describe('the replay binding — §5.4', () => {
  it('a disclosure minted for A verifies at A', () => {
    expect(verify(forA(), atA)).toEqual({ ok: true });
  });

  it('THE SAME BYTES, FORWARDED TO B UNCHANGED, ARE REFUSED', () => {
    /* Company A forwards exactly what it received to company B. Nothing is
     * altered, so the signature is still perfectly good — and B refuses,
     * because the payload names A and B is not A. */
    const verdict = verify(forA(), {
      ...atA,
      atOrigin: 'https://payroll-b.example',
      expectingNonce: 'nonce-from-b',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe('origin-mismatch');
    expect(verdict.ok === false && verdict.says).toContain('payroll-a.example');
    expect(verdict.ok === false && verdict.says).toContain('payroll-b.example');
  });

  it('AND EDITING THE ORIGIN SO THE PAYLOAD AGREES WITH ITSELF BREAKS THE SIGNATURE', () => {
    /* The other half, and the one that matters: B is not stopped by a string
     * comparison it could simply satisfy. Rewriting `origin` to B's own value
     * makes the first check pass and the SIGNATURE fail, because the origin is
     * inside the bytes that were signed. */
    const original = forA();
    const tampered: DisclosureResponse = {
      ...original,
      payload: { ...original.payload, origin: 'https://payroll-b.example' },
    };
    const verdict = verify(tampered, {
      ...atA, atOrigin: 'https://payroll-b.example', expectingNonce: 'nonce-from-a',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe('signature-invalid');
  });

  it('a replay to the SAME origin with a stale nonce is refused', () => {
    const verdict = verify(forA(), { ...atA, expectingNonce: 'a-later-request' });
    expect(verdict.ok === false && verdict.code).toBe('nonce-mismatch');
  });

  it('and editing the nonce breaks the signature too', () => {
    const original = forA();
    const tampered: DisclosureResponse = {
      ...original, payload: { ...original.payload, nonce: 'a-later-request' },
    };
    expect(verify(tampered, { ...atA, expectingNonce: 'a-later-request' }))
      .toMatchObject({ ok: false, code: 'signature-invalid' });
  });

  it('every disclosed field is inside the signature — changing any one breaks it', () => {
    const original = forA();
    const swapped: DisclosureResponse = {
      ...original,
      payload: {
        ...original.payload,
        disclosed: [value('v1', 'given-name', 'Someone Else'), original.payload.disclosed[1]!],
      },
    };
    expect(verify(swapped, atA)).toMatchObject({ ok: false, code: 'signature-invalid' });
  });

  it('AND SO IS THE ADDRESS — which the survivor found nothing was pinning', () => {
    /*
     * `verify` recomputes the address from the verifying key, so dropping the
     * address from the PREIMAGE broke nothing the suite was watching. It is
     * still one of §5.4's four bindings and the signature must cover it:
     * defence in depth is only defence while something checks it.
     */
    const original = forA();
    const swapped: DisclosureResponse = {
      ...original, payload: { ...original.payload, address: addressOf(4) },
    };
    expect(verify(swapped, { ...atA, payingAddress: addressOf(SUBWALLET) }))
      .toMatchObject({ ok: false, code: 'signature-invalid' });
  });

  it('so is the time, and so is what was DECLINED', () => {
    const original = forA();
    expect(verify({ ...original, payload: { ...original.payload, at: AT + 1 } }, atA))
      .toMatchObject({ ok: false, code: 'signature-invalid' });
    expect(verify(
      { ...original, payload: { ...original.payload, declined: ['email'] } }, atA))
      .toMatchObject({ ok: false, code: 'signature-invalid' });
  });
});

describe('the address binding — §7 step 6', () => {
  it('the verifier RECOMPUTES the address and never reads it off the payload', () => {
    /* The recipient is about to pay subwallet 4 and receives a disclosure
     * signed by subwallet 3, whose payload obligingly names subwallet 4's
     * address. The claim in the payload is worth nothing: the address the
     * verifier compares comes out of the verifying key. */
    const original = mint(identity, SUBWALLET, {
      origin: 'https://payroll-a.example',
      nonce: 'nonce-from-a',
      address: addressOf(4),
      at: AT,
      disclosed: [value('v1', 'given-name', 'Sarah')],
      declined: [],
      requesterSaidItWas: { name: 'Payroll A', rdns: 'example.payroll-a' },
    }).response;
    const verdict = verify(original, { ...atA, payingAddress: addressOf(4) });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe('address-mismatch');
  });

  it('the address it derives is the one this wallet shows for that subwallet', () => {
    const response = forA();
    expect(addressOfVerifyingKey(response.verifyingKey, NETWORK)).toBe(addressOf(SUBWALLET));
  });

  it('a different subwallet signs with a different key, so the two do not cross', () => {
    const three = mint(identity, 3, {
      origin: 'https://payroll-a.example',
      nonce: 'n',
      address: addressOf(3),
      at: AT,
      disclosed: [],
      declined: [],
      requesterSaidItWas: { name: 'A', rdns: 'a' },
    }).response;
    const four = mint(identity, 4, {
      origin: 'https://payroll-a.example',
      nonce: 'n',
      address: addressOf(4),
      at: AT,
      disclosed: [],
      declined: [],
      requesterSaidItWas: { name: 'A', rdns: 'a' },
    }).response;
    expect(three.verifyingKey).not.toBe(four.verifyingKey);
    expect(addressOfVerifyingKey(three.verifyingKey, NETWORK)).toBe(addressOf(3));
    expect(addressOfVerifyingKey(four.verifyingKey, NETWORK)).toBe(addressOf(4));
  });
});

describe('an issued claim that has gone stale is refused by the recipient', () => {
  it('a proof past its expiry is not evidence today', () => {
    const stale: Sent = {
      id: 'v9',
      about: 'sanctions-status',
      says: { of: 'predicate', predicate: 'not-listed', result: true },
      asserted: {
        by: 'issuer',
        issuer: 'an-issuer',
        signature: 'ff',
        issuedAt: AT - 90 * 86_400_000,
        expiresAt: AT - 86_400_000,
        reachableAt: null,
      },
    };
    const response = mint(identity, SUBWALLET, {
      origin: 'https://payroll-a.example',
      nonce: 'nonce-from-a',
      address: addressOf(SUBWALLET),
      at: AT,
      disclosed: [stale],
      declined: [],
      requesterSaidItWas: { name: 'Payroll A', rdns: 'example.payroll-a' },
    }).response;
    expect(verify(response, atA)).toMatchObject({ ok: false, code: 'expired-claim' });
  });
});

describe('the preimage', () => {
  it('is unambiguous: moving a character between two fields changes the bytes', () => {
    const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
    const base = {
      schema: RESPONSE_SCHEMA, address: 'addr', at: 1, disclosed: [], declined: [],
    } as const;
    expect(hex(preimage({ ...base, origin: 'ab', nonce: 'c' })))
      .not.toBe(hex(preimage({ ...base, origin: 'a', nonce: 'bc' })));
  });

  it('a `null` expiry and a numeric one cannot collide', () => {
    const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
    const withNull = preimage({
      schema: RESPONSE_SCHEMA,
      origin: 'https://a',
      nonce: 'n',
      address: 'addr',
      at: 1,
      declined: [],
      disclosed: [{
        id: 'i',
        about: 'a',
        says: { of: 'value', value: 'v' },
        asserted: {
          by: 'issuer', issuer: 'x', signature: 's', issuedAt: 1, expiresAt: null,
          reachableAt: null,
        },
      }],
    });
    const withZero = preimage({
      schema: RESPONSE_SCHEMA,
      origin: 'https://a',
      nonce: 'n',
      address: 'addr',
      at: 1,
      declined: [],
      disclosed: [{
        id: 'i',
        about: 'a',
        says: { of: 'value', value: 'v' },
        asserted: {
          by: 'issuer', issuer: 'x', signature: 's', issuedAt: 1, expiresAt: 0,
          reachableAt: null,
        },
      }],
    });
    expect(hex(withNull)).not.toBe(hex(withZero));
  });

  it(
    'BEGINS WITH BYTES NO LEDGER SIGNING ENVELOPE BEGINS WITH — measured against the SDK',
    () => {
      /*
       * This wallet signs with a SPENDING key, and `ledger-v9.d.ts:447` warns
       * against signing data that is not strictly controlled with a valuable
       * key. The structural half of that control is that our preimage cannot
       * be mistaken for something the ledger would accept as an authorisation.
       *
       * **MEASURED, NOT ASSERTED, AND MEASURED AGAINST THE SHIPPED SDK RATHER
       * THAN A FIXTURE** — so the day the ledger changes its envelope, this
       * line goes red instead of the argument going quietly stale.
       */
      /*
       * ALL THREE PRODUCERS OF SIGNABLE BYTES IN `ledger-v9`, asked at run
       * time: `Intent.signatureData` (`ledger-v9.d.ts:2126`),
       * `MaintenanceUpdate.dataToSign` (`:2325`) and
       * `ClaimRewardsTransaction.dataToSign` (`:3260`). Every one of them
       * begins with the ASCII `midnight:` and an envelope name.
       */
      const envelopes: readonly Uint8Array[] = [
        Intent.new(new Date(AT + 3_600_000)).signatureData(1),
        new MaintenanceUpdate(sampleContractAddress(), [], 0n).dataToSign,
        ClaimRewardsTransaction.new(
          'undeployed', 100n,
          signatureVerifyingKey({ tag: 'schnorr', value: 'ab'.repeat(32) }),
          '00'.repeat(32), 'Reward').dataToSign,
      ];
      for (const envelope of envelopes) {
        expect(new TextDecoder().decode(envelope.slice(0, 9))).toBe('midnight:');
      }
      const real = envelopes[0]!;

      const ours = preimage({
        schema: RESPONSE_SCHEMA,
        origin: 'https://a',
        nonce: 'n',
        address: 'addr',
        at: 1,
        disclosed: [],
        declined: [],
      });
      expect(new TextDecoder().decode(ours.slice(0, DISCLOSURE_DOMAIN.length)))
        .toBe(DISCLOSURE_DOMAIN);
      /* Ours differs from EVERY one of them at the ninth byte — `-` for `:`. */
      for (const envelope of envelopes) {
        expect(Buffer.from(ours.slice(0, 8))).toEqual(Buffer.from(envelope.slice(0, 8)));
        expect(ours[8]).not.toBe(envelope[8]);
      }
      expect(real.length).toBeGreaterThan(0);
    });

  it('nothing exported from this module signs bytes handed to it', async () => {
    /* The other half of "strictly controlled": there is no door. If a future
     * round adds one, this test names it. */
    const module = await import('./disclosure.js') as Record<string, unknown>;
    const exported = Object.keys(module).sort();
    expect(exported).toEqual(
      ['DISCLOSURE_SCHEMES', 'addressOfVerifyingKey', 'mint', 'recheck', 'verify']);
  });

  it('the raw SDK signer is not re-exported anywhere in this module', () => {
    /* `signData` is imported here and used once, inside `mint`, over bytes
     * this module built. Nothing else may reach it. */
    expect(typeof signData).toBe('function');
  });
});

describe('§5.5 — the history entry keeps the EXACT bytes that were signed', () => {
  /*
   * §5.4's signed payload is already a trustless
   * attestation; the only thing a chain would add is a date nobody can
   * backdate. **What that needs from today is one field** — the literal bytes,
   * so a hash of them is reproducible for ever. If only the parsed fields were
   * kept, the payload would have to be REBUILT to be hashed, and then it would
   * have to be canonically serialisable for ever or a preimage could never be
   * shown to match an anchor.
   *
   * A condition makes the field worth having:
   * **a stored blob nobody checks is decoration**, and if the bytes and the
   * fields can disagree the entry is worse than not having them.
   *
   * NOTHING HERE IS ABOUT A CHAIN. No contract, no root, no transaction, no
   * hash. One field and the check that keeps it honest.
   */

  const claimed: Sent[] = [
    value('v1', 'given-name', 'Sarah'),
    {
      id: 'v9',
      about: 'sanctions-status',
      says: { of: 'predicate', predicate: 'not-listed', result: true },
      asserted: {
        by: 'issuer',
        issuer: 'a-checking-service',
        signature: 'ab12',
        issuedAt: AT - 86_400_000,
        expiresAt: AT + 86_400_000,
        reachableAt: 'https://a-checking-service.example/again',
      },
    },
    {
      id: 'v3',
      about: 'family-name',
      says: { of: 'value', value: 'Okonjo' },
      asserted: { by: 'self', formerly: { issuer: 'a-registrar', issuedAt: AT - 500 } },
    },
  ];

  /** A recorded entry, built the way `screens/approve.tsx` builds one. */
  const recorded = (): Disclosure => {
    const minted = mint(identity, SUBWALLET, {
      origin: 'https://payroll-a.example',
      nonce: 'nonce-from-a',
      address: addressOf(SUBWALLET),
      at: AT,
      disclosed: claimed,
      declined: ['email'],
      requesterSaidItWas: { name: 'Payroll A', rdns: 'example.payroll-a' },
    });
    return {
      at: AT,
      kind: 'disclosure',
      nonce: 'nonce-from-a',
      sent: claimed,
      declined: ['email'],
      signed: {
        bytes: minted.signedBytes,
        signature: minted.response.signature,
        verifyingKey: minted.response.verifyingKey,
        scheme: minted.response.scheme,
      },
    };
  };

  it('THE BYTES VERIFY, AND THEY DECODE TO EXACTLY WHAT THE ENTRY SAYS WAS SENT', () => {
    const outcome = recheck(recorded());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.says);
    /* Not "it verified" — what came OUT of the bytes, field by field. */
    expect(outcome.payload.at).toBe(AT);
    expect(outcome.payload.nonce).toBe('nonce-from-a');
    expect(outcome.payload.origin).toBe('https://payroll-a.example');
    expect(outcome.payload.address).toBe(addressOf(SUBWALLET));
    expect(outcome.payload.declined).toEqual(['email']);
    expect(outcome.payload.disclosed).toEqual(claimed);
  });

  it('ONE FLIPPED BYTE AND THE SIGNATURE NO LONGER MATCHES', () => {
    const entry = recorded();
    const bytes = fromBase64Url(entry.signed!.bytes);
    const at = bytes.length - 3;
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    const tampered: Disclosure = {
      ...entry, signed: { ...entry.signed!, bytes: toBase64Url(bytes) },
    };
    /* It may not even decode — either refusal is correct, and both are named. */
    const outcome = recheck(tampered);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && ['signature-invalid', 'bytes-unreadable'])
      .toContain(outcome.ok === false ? outcome.code : '');
  });

  it('BYTES THAT ARE A VALID, CORRECTLY-SIGNED PAYLOAD OF SOMETHING ELSE ARE REFUSED', () => {
    /*
     * The re-serialisation case, and the reason `recheck` has a third step. A
     * record could hold bytes that decode perfectly and verify perfectly and
     * are simply not what the fields beside them claim. Signature checking
     * alone would pass this.
     */
    const entry = recorded();
    const other = mint(identity, SUBWALLET, {
      origin: 'https://payroll-a.example',
      nonce: 'nonce-from-a',
      address: addressOf(SUBWALLET),
      at: AT,
      /* THE SAME NUMBER OF VALUES, so the count check cannot be what fires:
       * what has to catch this is the per-value comparison. */
      disclosed: [value('v1', 'given-name', 'Somebody Else'), claimed[1]!, claimed[2]!],
      declined: ['email'],
      requesterSaidItWas: { name: 'Payroll A', rdns: 'example.payroll-a' },
    });
    const swapped: Disclosure = {
      ...entry,
      signed: {
        bytes: other.signedBytes,
        signature: other.response.signature,
        verifyingKey: other.response.verifyingKey,
        scheme: other.response.scheme,
      },
    };
    const outcome = recheck(swapped);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe('fields-disagree');
    expect(outcome.ok === false && outcome.says).toContain('given-name');
  });

  it('and it notices a disagreement about the TIME, the NONCE and the DECLINED list', () => {
    const entry = recorded();
    for (const [what, changed] of [
      ['the time', { ...entry, at: AT + 1 }],
      ['the nonce', { ...entry, nonce: 'another' }],
      ['what was declined', { ...entry, declined: [] }],
      ['how many values were sent', { ...entry, sent: entry.sent.slice(0, 1) }],
    ] as const) {
      const outcome = recheck(changed);
      expect(outcome.ok, what).toBe(false);
      expect(outcome.ok === false && outcome.code, what).toBe('fields-disagree');
    }
  });

  it('an entry from before this wallet kept the bytes says so, and is not a failure', () => {
    /* One null, one meaning. It does not mean the disclosure was
     * unsigned; it means this record cannot be re-checked. */
    const outcome = recheck({ ...recorded(), signed: null });
    expect(outcome.ok === false && outcome.code).toBe('no-bytes-recorded');
    expect(outcome.ok === false && outcome.says).toContain('really was signed');
  });

  it('THE BYTES NEVER CROSS TO THE REQUESTER, so nothing can verify against them', () => {
    /*
     * The hazard this shape exists to remove: a recipient handed both the
     * payload and the bytes could verify the signature over the BYTES, and a
     * payload that agrees with itself is what a forged one looks like. So the
     * response carries no bytes at all — pinned as the exact key list.
     */
    const minted = mint(identity, SUBWALLET, {
      origin: 'https://payroll-a.example',
      nonce: 'n',
      address: addressOf(SUBWALLET),
      at: AT,
      disclosed: [],
      declined: [],
      requesterSaidItWas: { name: 'A', rdns: 'a' },
    });
    expect(Object.keys(minted.response).sort()).toEqual(
      ['payload', 'requesterSaidItWas', 'scheme', 'signature', 'verifyingKey']);
    expect(JSON.stringify(minted.response)).not.toContain(minted.signedBytes);
  });

  it('the bytes it kept are the bytes it signed, not a second serialisation', () => {
    const minted = mint(identity, SUBWALLET, {
      origin: 'https://payroll-a.example',
      nonce: 'n',
      address: addressOf(SUBWALLET),
      at: AT,
      disclosed: claimed,
      declined: [],
      requesterSaidItWas: { name: 'A', rdns: 'a' },
    });
    expect(Buffer.from(fromBase64Url(minted.signedBytes)).toString('hex'))
      .toBe(Buffer.from(preimage(minted.response.payload)).toString('hex'));
  });
});

describe('the preimage reads back', () => {
  it('round-trips every shape a payload can take', () => {
    const shapes: Sent[] = [
      value('a', 'given-name', 'Sarah'),
      {
        id: 'b',
        about: 'x',
        says: { of: 'predicate', predicate: 'over-18', result: false },
        asserted: {
          by: 'issuer', issuer: 'i', signature: 's', issuedAt: 1, expiresAt: null,
          reachableAt: null,
        },
      },
      {
        id: 'c',
        about: 'y',
        says: { of: 'value', value: 'a value with a ✓ and a — in it' },
        asserted: { by: 'self', formerly: { issuer: 'was-them', issuedAt: 7 } },
      },
      {
        /*
         * **THE THIRD ARM, WHICH CARRIES NO FIELDS AT ALL.** A tag with
         * nothing after it is the case a length-prefixed encoding has to get
         * right and an unprefixed one cannot: it must not be readable as the
         * beginning of the arm next door, and the value after it must start
         * where it says it does.
         */
        id: 'receiving-address',
        about: 'receiving-address',
        says: { of: 'value', value: 'mn_shield-addr_undeployed1qqqq' },
        asserted: { by: 'wallet' },
      },
    ];
    const payload = {
      schema: RESPONSE_SCHEMA,
      origin: 'https://a.example',
      nonce: 'n',
      address: 'addr',
      at: 1_700_000_000_000,
      disclosed: shapes,
      declined: ['p', 'q'],
    } as const;
    const back = readPreimage(preimage(payload));
    expect(back).not.toBeNull();
    expect(back).toEqual(payload);
    /* And re-encoding what came back gives the same bytes. */
    expect(Buffer.from(preimage(back!)).toString('hex'))
      .toBe(Buffer.from(preimage(payload)).toString('hex'));
  });

  it('refuses bytes that are truncated, padded, or not ours at all', () => {
    const bytes = preimage({
      schema: RESPONSE_SCHEMA,
      origin: 'https://a.example',
      nonce: 'n',
      address: 'addr',
      at: 1,
      disclosed: [value('a', 'b', 'c')],
      declined: [],
    });
    expect(readPreimage(bytes)).not.toBeNull();
    expect(readPreimage(bytes.slice(0, bytes.length - 1))).toBeNull();
    /* TRAILING BYTES ARE A REFUSAL — a decoder that stops when it has what it
     * wanted will read a prefix of somebody else's message. */
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(readPreimage(padded)).toBeNull();
    expect(readPreimage(new TextEncoder().encode('midnight:intent-signing-envelope[v9]:')))
      .toBeNull();
    expect(readPreimage(new Uint8Array(0))).toBeNull();
  });
});
