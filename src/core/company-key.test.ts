import { describe, expect, it } from 'vitest';
import { newSymmetricKey, newWrappingKeypair, seal, toHex, randomBytes, type Hex } from './crypto.js';
import { recordsKeypairFrom } from '../midnight/company-nonce-secret.js';
import { sealGovernanceProposal, seatStillProposedFor } from './proposal-filing.js';
import {
  epochInForce, keyCheckOf, keyInForce, keyOf, keysHeld, openedPrevious, openedSeed, openedWithAnyKey, openedWrap, rotationSeedsOf,
  sealedPrevious, sealedSeed, sealedSeedShaped, sealingWith, wrapsFor, type CompanyKeys,
} from './company-key.js';

const CO = 'acc_key';

describe('A NEW COMPANY KEY: NAMED BY ITS CHECK, WRAPPED TO EACH STAYING SEAT, AND CHAINED BACK TO THE KEY IT REPLACES', () => {
  it('a key check changes with the company, the epoch and the key, and is the same for the same three', () => {
    const key = newSymmetricKey();
    const check = keyCheckOf(CO, 1, key);
    expect(check).toMatch(/^[0-9a-f]{64}$/u);
    expect(keyCheckOf(CO, 1, key.toUpperCase() as Hex)).toBe(check);
    /* RED WHEN: a key check leaves out the company, so one company's check matches another's. */
    expect(keyCheckOf('acc_other', 1, key)).not.toBe(check);
    /* RED WHEN: a key check leaves out the epoch, so an old key passes for the new one. */
    expect(keyCheckOf(CO, 2, key)).not.toBe(check);
    /* RED WHEN: a key check leaves out the key, so any key passes for the one the directory names. */
    expect(keyCheckOf(CO, 1, newSymmetricKey())).not.toBe(check);
    expect(() => keyCheckOf(CO, -1, key)).toThrow(/epoch/u);
    expect(() => keyCheckOf(CO, 1, 'ab' as Hex)).toThrow(/32-byte key/u);
  });

  it('the key replaced opens only under the new key, and the new key never opens from the old one', () => {
    const old = newSymmetricKey();
    const next = newSymmetricKey();
    const sealed = sealedPrevious(next, old);
    expect(openedPrevious(next, sealed)).toBe(old);
    /* RED WHEN: the key replaced is sealed under itself, or under anything the old key opens. */
    expect(openedPrevious(old, sealed)).toBeNull();
    /* RED WHEN: the key replaced is sealed under the new key itself, not a key made from it for this one use. */
    expect(openedPrevious(next, seal(old, next))).toBeNull();
    /* RED WHEN: a payout seed sealed under the new key is opened as the key it replaced. */
    expect(openedPrevious(next, sealedSeed(next, old))).toBeNull();
  });

  it('a seat\'s copy opens with the records key its wallet works out, and not with the wrapping key a person\'s saved keys hold', () => {
    const key = newSymmetricKey();
    const released = randomBytes(32);
    const records = recordsKeypairFrom(released);
    const saved = newWrappingKeypair();
    /* The seat as the directory holds it beside the person's saved wrapping key: the copy goes to the directory's key only. */
    const seat = { seat: 'ab'.repeat(32), wrappingKey: records.publicKey, wrappingPublicKey: saved.publicKey };
    const [copy] = wrapsFor(key, [seat]);
    expect(copy!.seat).toBe(seat.seat);
    /* RED WHEN: the copy is wrapped to the person's saved wrapping key in place of the directory's records key. */
    expect(openedWrap(copy!.wrap, recordsKeypairFrom(released).secret)).toBe(key);
    expect(openedWrap(copy!.wrap, saved.secret)).toBeNull();
    /* RED WHEN: a copy for one seat opens with another seat's records key. */
    expect(openedWrap(copy!.wrap, recordsKeypairFrom(randomBytes(32)).secret)).toBeNull();
  });

  it('a payout seed opens only under its own key, and a sealed seed is judged 32 bytes without being opened', () => {
    const key = newSymmetricKey();
    const seed = toHex(randomBytes(32));
    const sealed = sealedSeed(key, seed);
    expect(openedSeed(key, sealed)).toBe(seed);
    /* RED WHEN: a seed opens with another key. */
    expect(openedSeed(newSymmetricKey(), sealed)).toBeNull();
    expect(sealedSeedShaped(sealed)).toBe(true);
    /* RED WHEN: a seal of anything but one 32-byte seed passes for a seed. */
    expect(sealedSeedShaped(seal(toHex(randomBytes(31)), key))).toBe(false);
    expect(sealedSeedShaped(seal(toHex(randomBytes(33)), key))).toBe(false);
    expect(sealedSeedShaped({ ...sealed, tag: 'aa' })).toBe(false);
    expect(sealedSeedShaped({ ...sealed, extra: 1 })).toBe(false);
    expect(sealedSeedShaped(null)).toBe(false);
  });
});

describe('THE COMPANY\'S KEYS AS A READER OR SEALER IS GIVEN THEM', () => {
  const k0 = newSymmetricKey();
  const k1 = newSymmetricKey();
  const keys: CompanyKeys = {
    epoch: 1, key: k1, newest: 1, seeds: [{ epoch: 1, seed: '5e'.repeat(32) }],
    keyAt: (e) => { if (e === 0) return k0; if (e === 1) return k1; throw new Error(`no key at epoch ${e}`); },
    sealing: () => ({ key: k1, epoch: 1 }),
  };

  it('opens each record under its own epoch\'s key, seals under the key in force, and tries every key held, newest first', () => {
    /* RED WHEN: a record is opened under the key in force rather than the key of the epoch it names. */
    expect([keyOf(keys, 0), keyOf(keys, 1), keyOf(keys, undefined)]).toEqual([k0, k1, k0]);
    /* RED WHEN: a new record is sealed under a key a removed signer holds. */
    expect(sealingWith(keys, 0)).toEqual({ key: k1, epoch: 1 });
    expect(keysHeld(keys)).toEqual([k1, k0]);
    expect(keyInForce(keys)).toBe(k1);
    expect(rotationSeedsOf(keys)).toEqual([{ epoch: 1, seed: '5e'.repeat(32) }]);
    /* RED WHEN: a record naming no epoch is tried with only one key, or the oldest first. */
    expect(openedWithAnyKey(keys, (k) => { if (k !== k0) throw new Error('not this one'); return 'opened'; })).toBe('opened');
    /* A spending policy's label: the epoch in force, never the pause. */
    expect(epochInForce({ ...keys, sealing: () => { throw new Error('paused'); } }, 0)).toBe(1);
  });

  it('takes a bare key as the one key of a company never changed', () => {
    /* RED WHEN: a bare key is not used for every record whatever its epoch, or seals at another epoch than its caller names. */
    expect([keyOf(k0, 3), keyInForce(k0), keysHeld(k0)]).toEqual([k0, k0, [k0]]);
    expect(sealingWith(k0, 0)).toEqual({ key: k0, epoch: 0 });
    expect(rotationSeedsOf(k0)).toEqual([]);
  });

  it('finds a proposal to add a seat sealed after the change of the key only under that change\'s key', () => {
    const add = (key: Hex, keyEpoch: number) => ({
      accountId: 'acc_k', keyEpoch, chainId: 'c1'.repeat(32),
      sealed: sealGovernanceProposal({
        accountId: 'acc_k', viewingKey: key, kind: 'add-signer', summary: 'Seat Dee', noVault: '00'.repeat(32) as Hex,
        body: { signerId: 'sgn_dee' } as never, change: { asset: '00', amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: '11'.repeat(32) as Hex }, proposedBy: 'ada',
      }),
    });
    /* RED WHEN: a proposal to add a seat sealed after the change is opened under the founding key, so it names no seat. */
    expect(seatStillProposedFor([add(k1, 1) as never], 'acc_k', keys, 'sgn_dee', ['c1'.repeat(32)])).toBe(true);
    expect(seatStillProposedFor([add(k0, 0) as never], 'acc_k', keys, 'sgn_dee', ['c1'.repeat(32)])).toBe(true);
    /* The signer who left, holding only the founding key, reads none sealed after the change. */
    expect(seatStillProposedFor([add(k1, 1) as never], 'acc_k', k0, 'sgn_dee', ['c1'.repeat(32)])).toBe(false);
  });
});
