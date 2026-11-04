/**
 * **A ONE-OFF PAYMENT'S RECORD IS OPENED WHERE ITS PAYEE'S ADDRESS CAN BE DECODED.**
 *
 * Opening a one-off decodes its payee's address, and a page's own code loads no address decoder, so the page asks its
 * vault builder's worker to open it. The worker opens it as the wallet does (`openOneOff`) and hands back only what a
 * page reads of it, all plain, with the one-off's payment leaf built from the record's own secrets as the wallet builds it
 * to pay (`oneOffBuiltHere`), never the secrets; a record the key does not open, or one not as sealed, is refused, never read.
 */
import { describe, expect, it } from 'vitest';
import { newSymmetricKey, type Hex } from '../../../src/core/crypto.js';
import { SEED_ASSETS } from '../../../src/core/assets.js';
import { newOneOffId, newOneOffSeed, openOneOff, sealOneOff } from '../../../src/midnight/one-off-record.js';
import { buildOneOffRun } from '../../../src/midnight/payout-tree.js';
import { oneOffSecretsOf } from '../../../src/midnight/run-keys.js';
import { unshieldedPayeeFor } from '../../../src/testing/payees.js';
import { vaultDetails } from '../../../src/testing/vault-details.js';
import { oneOffBuiltHere } from './one-off-here.js';
import { answerVaultAsk, type WorkerDeps } from './vault-worker-entry.js';
import type { VaultAsk } from './vault-worker-client.js';

const NET = 'undeployed' as const;
const NIGHT = SEED_ASSETS.find((a) => a.symbol === 'NIGHT')!;
const KEY = newSymmetricKey();
const PAYEE = unshieldedPayeeFor('b1'.repeat(32), NET).bech32;
const record = () => sealOneOff({
  company: 'acme', id: newOneOffId(), keyEpoch: 0, key: KEY,
  given: {
    vault: 'fa'.repeat(32) as Hex, asset: NIGHT.code, amount: 123_456_789_012_345_678_901n, form: 'public',
    payee: { ref: null, name: 'Northwind Paper Ltd', address: PAYEE, network: NET }, reason: 'Invoice 2026-118, office paper',
    proposal: { id: 'prp_ABCDEFGHIJKL', chainId: 'c4'.repeat(32) as Hex }, run: { opensAt: 1_000n, closesAt: 2_000n, required: 0n }, seed: newOneOffSeed(),
  },
});
const inTheWorker = (rec: unknown, key: string, deps: Partial<WorkerDeps> = { vaultDetails }) =>
  answerVaultAsk(async () => deps as WorkerDeps, { id: 9, network: NET, ask: 'one-off-opened', rec, key } as unknown as VaultAsk);
/* The leaf the wallet pays the one-off by: the one leaf of the tree it builds from the record to pay it (`oneOffBuiltHere`, as its pay order reads it). */
const leafTheWalletPays = (rec: ReturnType<typeof record>): string =>
  oneOffBuiltHere(openOneOff(rec, KEY), { detailsOf: vaultDetails, treeOf: buildOneOffRun }).tree.tree.leaves[0]!.toLowerCase();

describe('a one-off payment opened in the page\'s worker', () => {
  /*
   * RED WHEN: the worker cannot open a one-off, hands back anything but what was sealed of the vault, currency, amount,
   * payee, reason and proposal, carries its amount as anything but a whole number in decimal, hands back a payment leaf
   * other than the one the wallet pays it by, or hands back its seed, its window or anything else a page does not read.
   */
  it('opens it with the company\'s key and hands back only what a page reads, the amount in decimal and the leaf the wallet pays it by', async () => {
    const rec = record();
    const answer = await inTheWorker(rec, KEY);
    expect(answer).toEqual({
      id: 9, ok: true, ask: 'one-off-opened',
      oneOff: {
        vault: 'fa'.repeat(32), asset: NIGHT.code, token: NIGHT.ledger.unshielded, amount: '123456789012345678901', reason: 'Invoice 2026-118, office paper',
        payee: { ref: null, name: 'Northwind Paper Ltd', address: PAYEE }, proposal: { id: 'prp_ABCDEFGHIJKL', chainId: 'c4'.repeat(32) },
        leaf: leafTheWalletPays(rec),
      },
    });
    /* RED WHEN: the leaf is one any other one-off would share, so a payment made of one would show another paid. */
    expect(leafTheWalletPays(record())).not.toBe(leafTheWalletPays(rec));
  });

  /* RED WHEN: the worker's answer carries the one-off's seed or any secret made from it, which would let a page make its payment's once-mark or blinding. */
  it('hands back none of the one-off\'s secrets, only the leaf made from them', async () => {
    const rec = record();
    const { seed } = openOneOff(rec, KEY);
    const said = JSON.stringify(await inTheWorker(rec, KEY)).toLowerCase();
    expect([seed, ...Object.values(oneOffSecretsOf(seed))].filter((x) => said.includes(x.toLowerCase()))).toEqual([]);
  });

  /* RED WHEN: a worker that holds no vault details circuits hands back a leaf it could not have built as the wallet does, or refuses to open the one-off at all. */
  it('hands back no leaf from a worker that cannot build one, and still opens the one-off', async () => {
    const answer = await inTheWorker(record(), KEY, {});
    expect(answer).toMatchObject({ ok: true, oneOff: { amount: '123456789012345678901', leaf: null } });
  });

  /* RED WHEN: a one-off the company's key does not open is read as one. */
  it('refuses a record the key it is given does not open', async () => {
    await expect(inTheWorker(record(), newSymmetricKey())).rejects.toThrow(/does not open with the company's key/u);
  });
});
