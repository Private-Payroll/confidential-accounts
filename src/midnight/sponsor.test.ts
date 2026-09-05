/**
 * The fee sponsor. M-4, decision 0001.
 *
 * These run offline against a recording stand-in for the wallet facade, because
 * the property that matters is not "does it work on chain" — it is "does it
 * balance the right token kinds", and getting that wrong is a double spend the
 * node rejects after a block time and a fee.
 *
 * The real proof is `SPONSOR-TEST.command`, which runs two wallets against
 * Stagenet with the customer holding no DUST at all. This is the part that can
 * be checked in thirty milliseconds instead of four minutes.
 */
import { describe, it, expect } from 'vitest';
import { WalletFeeSponsor, CUSTOMER_BALANCES, SPONSOR_BALANCES, type SponsorWallet } from './sponsor.js';

interface Call { method: string; args: unknown[] }

function fakeWallet(overrides: Partial<SponsorWallet> = {}) {
  const calls: Call[] = [];
  const wallet: SponsorWallet = {
    shieldedSecretKeys: 'sponsor-shielded',
    dustSecretKey: 'sponsor-dust',
    async balanceFinalizedTransaction(tx, keys, options) {
      calls.push({ method: 'balanceFinalizedTransaction', args: [tx, keys, options] });
      return { type: 'FINALIZED_TRANSACTION', originalTransaction: tx, balancingTransaction: 'unproven' };
    },
    async finalizeRecipe(recipe) {
      calls.push({ method: 'finalizeRecipe', args: [recipe] });
      return { submittable: true, from: recipe };
    },
    async submitTransaction(tx) {
      calls.push({ method: 'submitTransaction', args: [tx] });
      return 'tx_sponsored';
    },
    async balances() { return { dust: 5_000n, night: 100n }; },
    ...overrides,
  };
  return { wallet, calls };
}

describe('WalletFeeSponsor', () => {
  it('balances DUST and nothing else', async () => {
    /*
     * The invariant the whole design rests on. The customer has already
     * balanced shielded and unshielded; re-balancing either here is a double
     * spend and the node rejects the whole transaction.
     */
    const { wallet, calls } = fakeWallet();
    await new WalletFeeSponsor(wallet).addFeeAndFinalise({ tx: 1 }, new Date());

    const balance = calls.find(c => c.method === 'balanceFinalizedTransaction')!;
    const options = balance.args[2] as { tokenKindsToBalance: string[] };
    expect(options.tokenKindsToBalance).toEqual(['dust']);
    expect(options.tokenKindsToBalance).not.toContain('shielded');
    expect(options.tokenKindsToBalance).not.toContain('unshielded');
  });

  it('the two parties balance disjoint token kinds', () => {
    // Stated as a test because it is the rule, and because a future edit that
    // widens either constant should fail here rather than on chain.
    const overlap = CUSTOMER_BALANCES.filter(k => (SPONSOR_BALANCES as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
    expect([...CUSTOMER_BALANCES, ...SPONSOR_BALANCES].sort())
      .toEqual(['dust', 'shielded', 'unshielded']);
  });

  it('proves and merges the balancing transaction rather than returning a recipe', async () => {
    /*
     * `balanceFinalizedTransaction` hands back a recipe whose
     * `balancingTransaction` is UNPROVEN. Returning that as though it were
     * submittable fails inside the SDK at submission, with an error that names
     * none of this.
     */
    const { wallet, calls } = fakeWallet();
    const out: any = await new WalletFeeSponsor(wallet).addFeeAndFinalise({ tx: 1 }, new Date());

    expect(calls.map(c => c.method)).toEqual(['balanceFinalizedTransaction', 'finalizeRecipe']);
    expect(out.submittable).toBe(true);
  });

  it('uses the SPONSOR\'s keys, not the customer\'s', async () => {
    // The dust being spent is ours. Passing the customer's keys here would ask
    // them to pay, which is the entire thing this component exists to avoid.
    const { wallet, calls } = fakeWallet();
    await new WalletFeeSponsor(wallet).addFeeAndFinalise({ tx: 1 }, new Date());
    const keys = calls[0].args[1] as { dustSecretKey: string };
    expect(keys.dustSecretKey).toBe('sponsor-dust');
  });

  it('passes the caller\'s deadline through untouched', async () => {
    // A sponsor quietly extending a TTL would keep a transaction submittable
    // after the customer intended it to expire.
    const ttl = new Date('2026-01-01T00:00:00Z');
    const { wallet, calls } = fakeWallet();
    await new WalletFeeSponsor(wallet).addFeeAndFinalise({ tx: 1 }, ttl);
    expect((calls[0].args[2] as { ttl: Date }).ttl).toBe(ttl);
  });

  it('submits exactly once', async () => {
    // M-28 was this class of bug one layer up: `callTx` already submits, and a
    // second submission was handed the wrong type entirely.
    const { wallet, calls } = fakeWallet();
    const ref = await new WalletFeeSponsor(wallet).submit({ done: true });
    expect(calls.filter(c => c.method === 'submitTransaction')).toHaveLength(1);
    expect(ref.ref).toBe('tx_sponsored');
  });

  it('reports remaining capacity after paying, so an operator can alarm', async () => {
    // This is the only component in the system that spends. An operator who
    // cannot watch it finds out DUST ran out when customers start failing.
    const seen: Array<{ remaining?: bigint }> = [];
    const { wallet } = fakeWallet();
    await new WalletFeeSponsor(wallet, (i) => seen.push(i)).submit({ done: true });
    expect(seen).toEqual([{ remaining: 5_000n }]);
  });

  it('still submits if the balance lookup fails', async () => {
    // Reporting is not worth failing a customer's transaction over, and the
    // transaction is already on the node by the time we ask.
    const { wallet } = fakeWallet({ balances: async () => { throw new Error('indexer down'); } });
    const ref = await new WalletFeeSponsor(wallet, () => {}).submit({ done: true });
    expect(ref.ref).toBe('tx_sponsored');
  });

  it('reports both DUST and NIGHT, because running out is a rate problem', async () => {
    /*
     * DUST regenerates from held NIGHT rather than being bought, so a burst of
     * customer activity can outrun generation while the NIGHT balance looks
     * perfectly healthy. One number cannot express that.
     */
    const { wallet } = fakeWallet();
    expect(await new WalletFeeSponsor(wallet).capacity()).toEqual({ dust: 5_000n, night: 100n });
  });
});
