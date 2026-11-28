import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity/keys/derivation';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../../src/core/crypto.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { FOUNDING_SEAT, foundingSeatOf } from './founding-seat.js';
import { seatAt, type SeatAt } from './seat-at.js';

/*
 * A seat made from the words is the seat already on the chain: every founded and every taken seat was made by the
 * derivations seatAt replaced, so its outputs are pinned to theirs, recorded before the change on these inputs (two
 * companies, every vault and no vault, seats 0, 1 and 7, and both founding seats). A changed output is a seat that no
 * longer matches the chain.
 */
const CO_A = 'co_dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as CompanyLabel;
const CO_B = 'co_54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e' as CompanyLabel;
const identity = identityFromWords(TEST_MNEMONIC);
const C = MidnightCommitments;
const ALL = String(C.allVaults()).toLowerCase() as Hex;
const NONE = String(C.noVault()).toLowerCase() as Hex;

/** The outputs as the replaced derivations shaped them: the founding seat whole, and the taken seat as the seating keeps it. */
const asTaken = (s: SeatAt) => ({
  n: s.n,
  signingSecret: s.signingSecret,
  wrappingSecret: s.wrappingSecret,
  blinding: s.blinding,
  scope: s.scope,
  leaf: s.leaf,
  leafAtAll: s.leafAtAll,
  opening: { publicKey: s.publicKey, scope: s.scope, blinding: s.blinding, walletKey: s.walletKey, salt: s.salt }
});
const sorted = (v: unknown): unknown =>
  v === null || typeof v !== 'object'
    ? v
    : Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted((v as Record<string, unknown>)[k])])
      );
const digest = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(sorted(v)))
    .digest('hex');

describe('ONE SEAT DERIVATION', () => {
  it('makes the seats the replaced derivations made, on every recorded input', async () => {
    /* RED WHEN: any part of a seat (a secret, the salt, the blinding, a leaf, a public key or the wallet key) is made differently. */
    const derive: Record<string, unknown> = {};
    for (const [name, label] of [
      ['A', CO_A],
      ['B', CO_B]
    ] as const) {
      for (const [where, scope] of [
        ['all', ALL],
        ['none', NONE]
      ] as const) {
        for (const n of [0, 1, 7]) derive[`${name}/${where}/${n}`] = asTaken(seatAt(identity, label, n, scope, C));
      }
    }
    const founding = { A: await foundingSeatOf(identity, CO_A), B: await foundingSeatOf(identity, CO_B) };
    expect(founding.A.leaf).toBe('a2a6803b41de93e80a48514920911c927ab2c247f720044c1a36b86ea82f18da');
    expect(founding.A.publicKey).toBe('752eadcbdb04883e17af2a77b9376ecf73da81183504b3c7cd05d76f25dcff1f');
    expect((derive['A/none/1'] as { leafAtAll: string }).leafAtAll).toBe(
      '4514ea874dd19d2fdc7cbdb95d3dbf0ca36d82b6b4b9a9e0d60b9e0ec053b194'
    );
    expect(digest({ founding, derive })).toBe('139308eaacc2352aace215ad1d8fbde63004e68dd471afae6a3fc80b2ad48b79');
  });

  it('is the founding seat at seat 0 over every vault', async () => {
    /* RED WHEN: the founding seat is made by its own derivation again, or at another seat or scope. */
    const s = seatAt(identity, CO_A, FOUNDING_SEAT, ALL, C);
    const { n: _n, leafAtAll, ...rest } = s;
    expect(leafAtAll).toBe(s.leaf);
    expect(await foundingSeatOf(identity, CO_A)).toEqual(rest);
  });

  it("draws a seat's leaf at its own scope, and at every vault beside it", () => {
    /* RED WHEN: the leaf ignores its scope, or the every-vault leaf is the scope's. */
    const none = seatAt(identity, CO_A, 1, NONE, C);
    const all = seatAt(identity, CO_A, 1, ALL, C);
    expect(none.leaf).not.toBe(all.leaf);
    expect(none.leafAtAll).toBe(all.leaf);
    expect(seatAt(identity, CO_A, 2, ALL, C).signingSecret).not.toBe(all.signingSecret);
  });
});
