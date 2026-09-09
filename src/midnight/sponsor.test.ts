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
    async revert(booking) {
      calls.push({ method: 'revert', args: [booking] });
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

/**
 * **COINS BOOKED BY A BALANCE THAT WAS NOT SPENT ARE RELEASED, ON EVERY WAY
 * OUT.**
 *
 * The property is not "the failure propagates" - it did that already. It is
 * that the wallet is told to let the coins go before it does, because nothing
 * else ever will: the vendor's time-based sweep for this is documented as a
 * no-op, and its own cleanup poller only acts on transactions that acquired a
 * result from chain sync, which a transaction that was never submitted never
 * does. **A booking made by a call that then threw stands for ever.**
 *
 * And it compounds rather than costing once. The next attempt balances onto a
 * fresh coin set, because coin selection filters out anything already marked
 * in-flight - so the fee budget falls a little on every failure and the balance
 * that is reported looks healthy right up until it does not.
 */
describe('a sponsor releases what it booked and did not spend', () => {
  /*
   * RED WHEN: the release around `finalizeRecipe` is removed. This is the
   * narrow window - the coins are booked by the line above and the proof of the
   * fee leg has not been made yet.
   */
  it('releases when proving the fee leg throws', async () => {
    const { wallet, calls } = fakeWallet({
      async finalizeRecipe() { throw new Error('the prover refused'); },
    });
    await expect(new WalletFeeSponsor(wallet).addFeeAndFinalise({ tx: 1 }, new Date()))
      .rejects.toThrow(/the prover refused/);

    /*
     * **THE ARGUMENT IS THE LOAD-BEARING PART AND IT IS ASSERTED.** Checking
     * only that a method called `revert` ran leaves the wallet free to be
     * handed the wrong object - the customer's transaction rather than the
     * sponsor's own booking - and nothing would notice. Measured: it did not.
     */
    const released = calls.find(c => c.method === 'revert');
    expect(released, 'nothing was released').toBeDefined();
    const balanced = calls.find(c => c.method === 'balanceFinalizedTransaction')!;
    expect(released!.args[0], 'the wrong object was released')
      .toEqual({ type: 'FINALIZED_TRANSACTION', originalTransaction: balanced.args[0], balancingTransaction: 'unproven' });
  });

  /*
   * **AND ON THE PATH WHERE THE OUTCOME IS UNKNOWN, WHICH IS THE ONE MOST
   * LIKELY TO BE TRIED AGAIN.**
   *
   * RED WHEN: the release around `submitTransaction` is removed.
   */
  it('releases when the submission throws', async () => {
    const submitted = { tx: 1 };
    const { wallet, calls } = fakeWallet({
      async submitTransaction() { throw new Error('the node closed the socket'); },
    });
    await expect(new WalletFeeSponsor(wallet).submit(submitted))
      .rejects.toThrow(/the node closed the socket/);

    /* The transaction that was submitted, and not something else. */
    const released = calls.find(c => c.method === 'revert');
    expect(released, 'nothing was released').toBeDefined();
    expect(released!.args[0], 'the wrong object was released').toBe(submitted);
  });

  /*
   * **THE POSITIVE CONTROL. Without it both cases above also pass against a
   * sponsor that releases every time**, which would throw away the coins of
   * every transaction that worked.
   *
   * RED WHEN: the release is moved out of the failure path.
   */
  it('releases nothing when the transaction goes out', async () => {
    const { wallet, calls } = fakeWallet();
    const sponsor = new WalletFeeSponsor(wallet);
    await sponsor.addFeeAndFinalise({ tx: 1 }, new Date());
    await sponsor.submit({ tx: 1 });
    expect(calls.map(c => c.method)).not.toContain('revert');
  });

  /*
   * **A RELEASE THAT FAILS MUST NOT REPLACE THE FAILURE THAT CAUSED IT.**
   *
   * RED WHEN: the release stops being guarded, so a wallet that refuses to
   * release swaps the error naming what actually happened for a complaint about
   * tidying up - and sends whoever reads it to the wrong place.
   */
  it('the original failure survives a release that fails too', async () => {
    const { wallet } = fakeWallet({
      async submitTransaction() { throw new Error('the node closed the socket'); },
      async revert() { throw new Error('nothing to revert'); },
    });
    await expect(new WalletFeeSponsor(wallet).submit({ tx: 1 }))
      .rejects.toThrow(/the node closed the socket/);
  });

  /*
   * **THE BALANCING ARGUMENT IS NEVER OMITTED, ON ANY PATH THROUGH THIS
   * CLASS.** Its default is *everything*, which would pay a customer's shielded
   * and unshielded legs out of the sponsor's own coins, silently.
   *
   * RED WHEN: the argument is dropped, or widened, anywhere.
   */
  it('never leaves the token kinds to the argument\'s own default', async () => {
    const { wallet, calls } = fakeWallet({
      async finalizeRecipe() { throw new Error('stopped after balancing'); },
    });
    await expect(new WalletFeeSponsor(wallet).addFeeAndFinalise({ tx: 1 }, new Date()))
      .rejects.toThrow();

    const balance = calls.find(c => c.method === 'balanceFinalizedTransaction')!;
    const options = balance.args[2] as { tokenKindsToBalance?: string[] };
    expect(options.tokenKindsToBalance, 'the argument was omitted').toBeDefined();
    expect(options.tokenKindsToBalance).toEqual(['dust']);
  });
});
