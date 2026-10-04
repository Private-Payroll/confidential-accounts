/**
 * **THE PROPOSAL THAT COMMITS A COMPANY'S ACCOUNT TO ITS PAY-RECORD KEY IS THE
 * SAME PROPOSAL ON EVERY DEVICE**, made from the key alone with the account's own
 * functions, and a signer's sealed copy is read under the keys only they can
 * work out.
 */
import { describe, expect, it } from 'vitest';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { payKeyCommitmentIn, payKeyRoundOf, sealedPayKeyIn, payKeyStandingOf, type PayKeyPure } from './pay-key-round.js';
import { payKeyCommitmentOf, payKeyPayloadOf } from './run-keys.js';

const P = pureCircuits as unknown as PayKeyPure;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const KEY = '9a'.repeat(32);
const ADDRESS = 'c0'.repeat(32);
const SK = '1c'.repeat(32);

/** A roles map as the account's ledger serves one. */
const rolesOf = (entries: Array<[Uint8Array, Uint8Array]>) => {
  const m = new Map(entries.map(([k, v]) => [hex(k), v]));
  return { member: (k: Uint8Array) => m.has(hex(k)), lookup: (k: Uint8Array) => m.get(hex(k))! };
};

describe('THE PAY-RECORD KEY\'S PROPOSAL', () => {
  it('IS MADE FROM THE KEY ALONE, WITH THE ACCOUNT\'S OWN FUNCTIONS, AND IS THE SAME EVERY TIME', () => {
    const round = payKeyRoundOf(P, KEY);
    /* RED WHEN: the commitment or the payload is made any way but the contract's own. */
    expect(round.commitment).toBe(payKeyCommitmentOf(KEY));
    expect(round.payload).toBe(payKeyPayloadOf(round.commitment));
    expect(round.proposal).toBe(hex(P.proposalIdOf(Buffer.from(round.payload, 'hex'), P.noVault(), Buffer.from(round.salt, 'hex'))));
    /* RED WHEN: the salt is drawn afresh, so a device that stopped half way, or another device, raises a second proposal. */
    expect(payKeyRoundOf(P, KEY)).toEqual(round);
    /* RED WHEN: the salt does not follow from the key, so two keys share a proposal's salt. */
    expect(payKeyRoundOf(P, '9b'.repeat(32)).salt).not.toBe(round.salt);
    expect(() => payKeyRoundOf(P, 'zz')).toThrow(/thirty-two bytes/);
  });
});

describe('A SIGNER\'S SEALED COPY, AND THE COMMITMENT, AS THE ACCOUNT HOLDS THEM', () => {
  const parts = [1, 2, 3, 4].map((n) => new Uint8Array(32).fill(n));
  const wrapKeys = (address: string, sk: string) => [0n, 1n, 2n, 3n].map((i) => P.payKeyWrapKeyOf(Buffer.from(address, 'hex'), Buffer.from(sk, 'hex'), i));
  const roles = rolesOf([
    ...wrapKeys(ADDRESS, SK).map((k, i) => [k, parts[i]!] as [Uint8Array, Uint8Array]),
    [P.payKeyCommitmentKey(), Buffer.from(payKeyCommitmentOf(KEY), 'hex')],
  ]);

  it('READS THE FOUR ENTRIES UNDER THE KEYS THE ACCOUNT\'S ADDRESS AND THE SIGNER\'S SECRET MAKE, AND NONE FOR ANYBODY ELSE', () => {
    /* RED WHEN: the entries are looked up under keys made from other bytes than the address's own, or another secret. */
    expect(sealedPayKeyIn(P, roles, ADDRESS, SK)).toEqual(parts.map(hex));
    expect(sealedPayKeyIn(P, roles, `0x${ADDRESS.toUpperCase()}`, SK)).toEqual(parts.map(hex));
    expect(sealedPayKeyIn(P, roles, 'c1'.repeat(32), SK)).toBeNull();
    expect(sealedPayKeyIn(P, roles, ADDRESS, '1d'.repeat(32))).toBeNull();
    expect(() => sealedPayKeyIn(P, roles, 'c0'.repeat(31), SK)).toThrow(/not 32 bytes/);
    expect(payKeyCommitmentIn(P, roles)).toBe(payKeyCommitmentOf(KEY));
    expect(payKeyCommitmentIn(P, rolesOf([]))).toBeNull();
  });

  it('WHERE IT STANDS: COMMITTED TO THIS KEY OR ANOTHER, SEALED OR NOT, AND THE PROPOSAL OPEN AT ITS APPROVALS', () => {
    const round = payKeyRoundOf(P, KEY);
    const id = Buffer.from(round.proposal, 'hex');
    const ledger = (r: ReturnType<typeof rolesOf>, open: boolean, approvals: bigint) => ({
      threshold: 2n, signerRoles: r,
      openProposals: { member: (k: Uint8Array) => open && hex(k) === hex(id) },
      approvalCounts: { member: (k: Uint8Array) => hex(k) === hex(id), lookup: () => approvals },
      proposalHolds: { member: () => false, lookup: () => ({ needed: 0n, removals: 0n }) },
    });
    const sealed = payKeyStandingOf(P, { address: ADDRESS, account: ledger(roles, false, 0n), key: KEY, secretKey: SK });
    expect([sealed.committed, sealed.isThisKey, sealed.sealedMine]).toEqual([payKeyCommitmentOf(KEY), true, true]);
    /* RED WHEN: a commitment to another key is read as this one's. */
    const other = payKeyStandingOf(P, { address: ADDRESS, account: ledger(roles, false, 0n), key: '9b'.repeat(32), secretKey: SK });
    expect(other.isThisKey).toBe(false);
    /* RED WHEN: the proposal's approvals or the bar it needs are read from anything but the account's own ledger. */
    const open = payKeyStandingOf(P, { address: ADDRESS, account: ledger(rolesOf([]), true, 1n), key: KEY, secretKey: SK });
    expect([open.committed, open.sealedMine, open.round.open, open.round.approvals, open.round.needed]).toEqual([null, false, true, 1, 2]);
  });
});
