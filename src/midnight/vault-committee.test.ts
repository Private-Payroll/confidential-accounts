import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { committeeOf, committeeReplacement, sameCommittee, whyNoCommittee } from './vault-committee.js';

const key = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });

describe('THE COMPANY\'S COMMITTEE', () => {
  it('exists only when every signer has given a key, and none twice', () => {
    expect(whyNoCommittee({ keys: [key(1), key(2)], threshold: 2, signerCount: 2 })).toBeNull();
    expect(whyNoCommittee({ keys: [key(1), null], threshold: 1, signerCount: 2 })).toMatch(/1 of this company's 2 signers has not/);
    expect(whyNoCommittee({ keys: [key(1)], threshold: 1, signerCount: 2 })).toMatch(/1 of this company's 2 signers/);
    expect(whyNoCommittee({ keys: [], threshold: 1, signerCount: 0 })).toMatch(/no signers/);
    expect(whyNoCommittee({ keys: [key(1), key(1)], threshold: 1, signerCount: 2 })).toMatch(/same committee key/);
    expect(whyNoCommittee({ keys: [key(1), { tag: 'ecdsa', value: key(2).value }], threshold: 1, signerCount: 2 })).toMatch(/not one a wallet derives/);
    expect(whyNoCommittee({ keys: [key(1), { tag: 'schnorr', value: 'AB'.repeat(32) }], threshold: 1, signerCount: 2 })).toMatch(/not one a wallet derives/);
  });

  it('never at a threshold of nothing, or above the signers', () => {
    expect(whyNoCommittee({ keys: [key(1)], threshold: 0, signerCount: 1 })).toMatch(/threshold is 0/);
    expect(whyNoCommittee({ keys: [key(1)], threshold: 2, signerCount: 1 })).toMatch(/threshold is 2/);
    expect(whyNoCommittee({ keys: [key(1)], threshold: 1.5, signerCount: 1 })).toMatch(/threshold is 1.5/);
  });

  it('is one value in one order, whichever order the signers gave their keys in', () => {
    const a = committeeOf([key(2), key(1)], 2, 2);
    const b = committeeOf([key(1), key(2)], 2, 2);
    expect(a).toEqual(b);
    expect(a.committee.map((k) => k.value)).toEqual([key(1).value, key(2).value]);
    expect(sameCommittee(a, b)).toBe(true);
    expect(sameCommittee(a, { ...a, threshold: 1 })).toBe(false);
    expect(sameCommittee(a, { committee: [...a.committee].reverse(), threshold: 2 })).toBe(false);
    expect(() => committeeOf([key(1), null], 1, 2)).toThrow(/has not yet opened/);
  });
});

describe('THE ONE UPDATE THE TEMPORARY KEY SIGNS', () => {
  const vault = 'ab'.repeat(32);
  const vk = (n: number) => L.signatureVerifyingKey(L.signingKeyFromBip340(new Uint8Array(32).fill(n)));
  const to = { committee: [vk(1), vk(2)].sort((a, b) => (a.value < b.value ? -1 : 1)), threshold: 2 };

  it('replaces the whole authority with the committee, carrying the next counter', () => {
    const u = committeeReplacement(L as never, { vault, counter: 4n, to }) as any;
    expect(u.counter).toBe(4n);
    expect(u.updates).toHaveLength(1);
    const installed = u.updates[0].authority;
    expect(installed.committee.map((k: { value: string }) => k.value)).toEqual(to.committee.map((k) => k.value));
    expect(installed.threshold).toBe(2);
    expect(installed.counter).toBe(5n);
  });

  it('a signature over it is worth nothing against another counter, vault or committee', () => {
    const data = (committeeReplacement(L as never, { vault, counter: 0n, to }) as any).dataToSign;
    for (const other of [
      { vault, counter: 1n, to },
      { vault: 'cd'.repeat(32), counter: 0n, to },
      { vault, counter: 0n, to: { ...to, threshold: 1 } },
    ]) {
      expect(Buffer.from((committeeReplacement(L as never, other) as any).dataToSign).equals(Buffer.from(data))).toBe(false);
    }
  });

  it('refuses what is not a committee, and a vault or counter that cannot be', () => {
    expect(() => committeeReplacement(L as never, { vault, counter: 0n, to: { committee: [], threshold: 1 } })).toThrow(/no signers/);
    expect(() => committeeReplacement(L as never, { vault, counter: 0n, to: { ...to, threshold: 3 } })).toThrow(/threshold is 3/);
    expect(() => committeeReplacement(L as never, { vault: 'xyz', counter: 0n, to })).toThrow(/sixty-four character/);
    expect(() => committeeReplacement(L as never, { vault, counter: -1n, to })).toThrow(/never below zero/);
  });
});
