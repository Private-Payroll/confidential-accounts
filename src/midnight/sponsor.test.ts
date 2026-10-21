/**
 * The fee payer.
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
import {
  WalletFeeSponsor, CUSTOMER_BALANCES, SPONSOR_BALANCES, FeeNotPaid, NetworkRefused, feeAnswerCodeOf, poolRefusalOf,
  VIEW_TIMING, type FeePayerView, type SponsorWallet, type ViewTiming,
} from './sponsor.js';
import { FeeRefused } from './fee-ceiling.js';
import { CUSTOMER_TOKEN_KINDS, SPONSOR_TOKEN_KINDS } from './wallet.js';
import { saysNothingWasSent } from '../core/jobs.js';

/** A ceiling well above what the double below spends, so the cases that are not about it pass. */
const CEILING = { perTransaction: 1_000n };

/** A balanced transaction as the ledger shapes one: intents, DUST actions, spends with their fee. */
const spending = (...fees: bigint[]) =>
  new Map([[1, { dustActions: { spends: fees.map(vFee => ({ vFee })) } }]]);

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
      return { submittable: true, from: recipe, intents: spending(5n) };
    },
    async submitTransaction(tx) {
      calls.push({ method: 'submitTransaction', args: [tx] });
      return 'tx_sponsored';
    },
    async revert(booking) {
      calls.push({ method: 'revert', args: [booking] });
    },
    async estimateFee(tx, ttl) {
      calls.push({ method: 'estimateFee', args: [tx, ttl] });
      return 7n;
    },
    async paidFee(ref) {
      calls.push({ method: 'paidFee', args: [ref] });
      return 9n;
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
    await new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date());

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

  it('and the OTHER pair of the same two constants agrees with this one', () => {
    /*
     * **THERE ARE FOUR CONSTANTS FOR TWO SETS, IN TWO FILES, AND EACH PAIR'S
     * OWN COMMENT SAYS IT EXISTS SO NOBODY EDITS ONE WITHOUT SEEING THE
     * OTHER.** That is true within each file and false across them: the fee
     * payer reads one pair and the company reads the other, and nothing made
     * them agree. Two things that must agree and are written in two places is
     * how this project describes most of what it has had to correct.
     *
     * The consequence of a divergence is loud rather than silent - a node
     * refusing a double spend - which is why this is a case here rather than a
     * collapse into one definition today. It is a case AT ALL because the pair
     * that runs is not the pair a reader of either file would check.
     *
     * RED WHEN: either constant in either file is widened, narrowed or
     * reordered without the other.
     */
    expect([...CUSTOMER_BALANCES]).toEqual([...CUSTOMER_TOKEN_KINDS]);
    expect([...SPONSOR_BALANCES]).toEqual([...SPONSOR_TOKEN_KINDS]);
  });

  it('proves and merges the balancing transaction rather than returning a recipe', async () => {
    /*
     * `balanceFinalizedTransaction` hands back a recipe whose
     * `balancingTransaction` is UNPROVEN. Returning that as though it were
     * submittable fails inside the SDK at submission, with an error that names
     * none of this.
     */
    const { wallet, calls } = fakeWallet();
    const out: any = await new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date());

    expect(calls.map(c => c.method))
      .toEqual(['estimateFee', 'balanceFinalizedTransaction', 'finalizeRecipe']);
    expect(out.submittable).toBe(true);
  });

  it('reads what it is about to pay BEFORE it books anything', async () => {
    /*
     * **THE ORDER IS THE WHOLE OF IT.** The estimate is the only moment the
     * expected cost exists: the balance below converges on a fee and then hands
     * back a transaction rather than a price, so a reading taken afterwards is
     * a reading of something else. It is also the only moment at which a
     * decision could still be made, which is what a cap would one day need.
     *
     * RED WHEN: the `estimateFee` call is moved below the balance, or removed.
     */
    const { wallet, calls } = fakeWallet();
    await new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date());
    expect(calls[0]?.method,
      'the fee was estimated after the coins were already booked, or not at all')
      .toBe('estimateFee');
  });

  it('pays anyway when the estimate cannot be read, and records that it was not read', async () => {
    /*
     * **AN INSTRUMENT MUST NOT BE ABLE TO REFUSE A PAYMENT.** Nothing caps what
     * a fee payer pays today and nothing here decides anything on this number;
     * it is a record. A measurement that failed a transaction would be an
     * outage caused by bookkeeping.
     *
     * RED WHEN: the `.catch(() => null)` around `estimateFee` is removed, so a
     * failed reading throws out of the balance.
     */
    const recorded: Array<{ estimated: bigint | null }> = [];
    const { wallet } = fakeWallet({
      estimateFee: async () => { throw new Error('the indexer would not answer'); },
    });
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, { record: (e) => recorded.push(e) });
    await expect(sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).resolves.toBeTruthy();
    await sponsor.submit({ done: true });
    expect(recorded[0]?.estimated,
      'a reading nobody took was written down as a number').toBeNull();
  });

  it('records which company it paid for, and both numbers', async () => {
    /*
     * **THE COMPANY CANNOT BE RECOVERED AFTERWARDS AND THAT IS WHY IT IS
     * RECORDED NOW.** What a fee payer is handed is a bound, shielded
     * transaction; whose it is is not in it, is not on the chain, and is not in
     * a receipt. The caller is the only thing that knows.
     *
     * RED WHEN: `payingFor` stops storing the id, or `submit` stops passing it
     * to the record - in either case the record is written with `null` where a
     * company was named, which is a record nobody can bill, audit or explain.
     */
    const recorded: Array<{ company: string | null; estimated: bigint | null; actual: bigint | null; ref: string }> = [];
    const { wallet } = fakeWallet();
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, { record: (e) => recorded.push(e) });
    sponsor.payingFor('acc_the_company');
    await sponsor.addFeeAndFinalise({ tx: 1 }, new Date());
    await sponsor.submit({ done: true });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.company).toBe('acc_the_company');
    expect(recorded[0]?.estimated, 'the estimate was not the one taken before balancing').toBe(7n);
    expect(recorded[0]?.actual, 'the charged fee was not read off the chain').toBe(9n);
    expect(recorded[0]?.ref).toBe('tx_sponsored');
  });

  it('does not file one transaction\'s estimate against the next one', async () => {
    /*
     * **AN ESTIMATE BELONGS TO ONE TRANSACTION.** Left standing, the previous
     * one is written against this one as though it had been measured for it -
     * a number that looks measured and is not, which is worse than an absent
     * one because nothing distinguishes it.
     *
     * RED WHEN: `payingFor` stops clearing the stored estimate.
     */
    const recorded: Array<{ company: string | null; estimated: bigint | null }> = [];
    const { wallet } = fakeWallet();
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, { record: (e) => recorded.push(e) });
    sponsor.payingFor('acc_one');
    await sponsor.addFeeAndFinalise({ tx: 1 }, new Date());
    await sponsor.submit({ done: true });
    // the second company's transaction never reaches a balance, so nothing measured it
    sponsor.payingFor('acc_two');
    await sponsor.submit({ done: true });

    expect(recorded[1]?.company).toBe('acc_two');
    expect(recorded[1]?.estimated,
      'the previous transaction\'s estimate was filed against this one').toBeNull();
  });

  it('a record that throws does not turn a payment that landed into a failure', async () => {
    /*
     * **EVERYTHING AFTER THE SUBMIT IS AFTER THE MONEY HAS MOVED.** A
     * transaction that settled and then reported a failure is the worst answer
     * available on this path: whoever reads it raises the same round again.
     *
     * RED WHEN: the `try` around the record is removed.
     */
    const { wallet } = fakeWallet();
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, {
      record: () => { throw new Error('the disk is full'); },
    });
    await expect(sponsor.submit({ done: true })).resolves.toEqual(
      expect.objectContaining({ ref: 'tx_sponsored' }));
  });

  it('and neither does a charged fee that never comes back', async () => {
    /*
     * RED WHEN: the `.catch(() => null)` around `paidFee` is removed. The chain
     * read runs after the submission, so a throw from it would be reported as a
     * failed payment for a payment that succeeded.
     */
    const recorded: Array<{ actual: bigint | null }> = [];
    const { wallet } = fakeWallet({
      paidFee: async () => { throw new Error('the indexer never answered'); },
    });
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, { record: (e) => recorded.push(e) });
    await expect(sponsor.submit({ done: true })).resolves.toBeTruthy();
    expect(recorded[0]?.actual, 'a reading nobody took was written down as a number').toBeNull();
  });

  it('uses the SPONSOR\'s keys, not the customer\'s', async () => {
    // The dust being spent is ours. Passing the customer's keys here would ask
    // them to pay, which is the entire thing this component exists to avoid.
    const { wallet, calls } = fakeWallet();
    await new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date());
    const balance = calls.find(c => c.method === 'balanceFinalizedTransaction')!;
    const keys = balance.args[1] as { dustSecretKey: string };
    expect(keys.dustSecretKey).toBe('sponsor-dust');
  });

  it('passes the caller\'s deadline through untouched', async () => {
    // A sponsor quietly extending a TTL would keep a transaction submittable
    // after the customer intended it to expire.
    const ttl = new Date('2026-01-01T00:00:00Z');
    const { wallet, calls } = fakeWallet();
    await new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, ttl);
    const balance = calls.find(c => c.method === 'balanceFinalizedTransaction')!;
    expect((balance.args[2] as { ttl: Date }).ttl).toBe(ttl);
    /* And the estimate is measured against the same deadline, because a fee
     * quoted for one expiry is not a fee for another. */
    const estimate = calls.find(c => c.method === 'estimateFee')!;
    expect(estimate.args[1]).toBe(ttl);
  });

  it('submits exactly once', async () => {
    // `callTx` already submits one layer up, and a second submission would be
    // handed the wrong type entirely.
    const { wallet, calls } = fakeWallet();
    const ref = await new WalletFeeSponsor(wallet, CEILING).submit({ done: true });
    expect(calls.filter(c => c.method === 'submitTransaction')).toHaveLength(1);
    expect(ref.ref).toBe('tx_sponsored');
  });

  it('reports remaining capacity after paying, so an operator can alarm', async () => {
    // This is the only component in the system that spends. An operator who
    // cannot watch it finds out DUST ran out when customers start failing.
    const seen: Array<{ fee?: bigint; remaining?: bigint }> = [];
    const { wallet } = fakeWallet();
    await new WalletFeeSponsor(wallet, CEILING, (i) => seen.push(i)).submit({ done: true });
    /*
     * **THE FEE IS THE CHAIN'S CHARGED NUMBER, AND IT USED TO BE ABSENT
     * ALWAYS** - the field existed on this callback and nothing ever filled it.
     * What it is not is a difference of the balance below against a previous
     * one: that figure lags its own spend, dust regenerates from held NIGHT
     * while nothing is happening, and a second sponsored transaction in the
     * window contaminates it.
     */
    expect(seen).toEqual([{ fee: 9n, remaining: 5_000n }]);
  });

  it('still submits if the balance lookup fails', async () => {
    // Reporting is not worth failing a customer's transaction over, and the
    // transaction is already on the node by the time we ask.
    const { wallet } = fakeWallet({ balances: async () => { throw new Error('indexer down'); } });
    const ref = await new WalletFeeSponsor(wallet, CEILING, () => {}).submit({ done: true });
    expect(ref.ref).toBe('tx_sponsored');
  });

  it('reports both DUST and NIGHT, because running out is a rate problem', async () => {
    /*
     * DUST regenerates from held NIGHT rather than being bought, so a burst of
     * customer activity can outrun generation while the NIGHT balance looks
     * perfectly healthy. One number cannot express that.
     */
    const { wallet } = fakeWallet();
    expect(await new WalletFeeSponsor(wallet, CEILING).capacity()).toEqual({ dust: 5_000n, night: 100n });
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
    await expect(new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date()))
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
    await expect(new WalletFeeSponsor(wallet, CEILING).submit(submitted))
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
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
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
    await expect(new WalletFeeSponsor(wallet, CEILING).submit({ tx: 1 }))
      .rejects.toThrow(/the node closed the socket/);
  });

  it('and it survives on the OTHER failure path too, which nothing covered', async () => {
    /*
     * RED WHEN: a release that fails while proving the fee leg replaces the error that says why the proof failed.
     */
    const { wallet } = fakeWallet({
      async finalizeRecipe() { throw new Error('the prover refused'); },
      async revert() { throw new Error('nothing to revert'); },
    });
    await expect(new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date()))
      .rejects.toThrow(/the prover refused/);
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
    await expect(new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date()))
      .rejects.toThrow();

    const balance = calls.find(c => c.method === 'balanceFinalizedTransaction')!;
    const options = balance.args[2] as { tokenKindsToBalance?: string[] };
    expect(options.tokenKindsToBalance, 'the argument was omitted').toBeDefined();
    expect(options.tokenKindsToBalance).toEqual(['dust']);
  });
});

/**
 * **WHAT ONE TRANSACTION MAY SPEND FROM OUR DUST IS CAPPED, AND ABOVE THE CAP
 * NOTHING IS SENT.**
 *
 * The fee payer pays for transactions it did not compose. These cases hold the
 * two places it refuses: before booking, on the estimate, and after balancing,
 * on the DUST the balanced transaction declares it will spend.
 */
describe('a sponsor refuses to pay more than its ceiling', () => {
  /*
   * RED WHEN: a fee whose estimate is over the ceiling is booked before it is refused.
   */
  it('refuses on the estimate before anything is booked', async () => {
    const { wallet, calls } = fakeWallet({ estimateFee: async () => 1_001n });
    const refusal: any = await new WalletFeeSponsor(wallet, CEILING)
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch((e: any) => e);
    expect(refusal, 'a transaction expected to cost more than the ceiling was paid for')
      .toBeInstanceOf(Error);
    expect(String(refusal.message)).toMatch(/expected to cost 1001 SPECKs/);
    expect(calls.map(c => c.method), 'coins were booked for a refused payment')
      .not.toContain('balanceFinalizedTransaction');
  });

  /*
   * RED WHEN: `FeeRefused` stops carrying the mark, so the queue and the server
   * would report a refusal as a payment that may have landed.
   */
  it('and says that nothing was sent', async () => {
    const { wallet } = fakeWallet({ estimateFee: async () => 1_001n });
    const refusal: any = await new WalletFeeSponsor(wallet, CEILING)
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch((e: any) => e);
    expect(saysNothingWasSent(refusal)).toBe(true);
  });

  /*
   * RED WHEN: the `refusalForCommitted` check after `finalizeRecipe` is removed,
   * so a transaction declaring more DUST than the ceiling is handed back to be
   * submitted. The estimate is unread here on purpose: the deciding check must
   * not depend on it.
   */
  it('refuses on what the balanced transaction would spend, with no estimate at all', async () => {
    const { wallet, calls } = fakeWallet({
      estimateFee: async () => { throw new Error('the estimate did not come back'); },
      async finalizeRecipe(recipe) {
        calls.push({ method: 'finalizeRecipe', args: [recipe] });
        return { dear: true, intents: spending(600n, 401n) };
      },
    });
    const refusal: any = await new WalletFeeSponsor(wallet, CEILING)
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch((e: any) => e);
    expect(refusal, 'a transaction spending more than the ceiling was handed back to submit')
      .toBeInstanceOf(Error);
    expect(String(refusal.message)).toMatch(/would spend 1001 SPECKs/);
    expect(saysNothingWasSent(refusal)).toBe(true);
    expect(calls.map(c => c.method)).not.toContain('submitTransaction');
  });

  /*
   * RED WHEN: the release before the committed-amount refusal is removed, so a
   * refused transaction leaves our DUST marked in flight for ever.
   */
  it('releases what it booked when it refuses after balancing', async () => {
    const dear = { dear: true, intents: spending(2_000n) };
    const { wallet, calls } = fakeWallet({ async finalizeRecipe() { return dear; } });
    await new WalletFeeSponsor(wallet, CEILING)
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch(() => undefined);
    const released = calls.find(c => c.method === 'revert');
    expect(released, 'a refused transaction left its booking standing').toBeDefined();
    expect(released!.args[0], 'the wrong object was released').toBe(dear);
  });

  /*
   * RED WHEN: an unreadable amount is treated as zero or as a pass - for
   * example `refusalForCommitted` returning `null` for `null`.
   */
  it('refuses a balanced transaction whose DUST spend cannot be read', async () => {
    const { wallet, calls } = fakeWallet({ async finalizeRecipe() { return { shapeless: true }; } });
    const refusal: any = await new WalletFeeSponsor(wallet, CEILING)
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch((e: any) => e);
    expect(refusal, 'a transaction nobody could measure was paid for').toBeInstanceOf(Error);
    expect(String(refusal.message)).toMatch(/could not be read off it/);
    expect(calls.map(c => c.method)).toContain('revert');
  });

  /*
   * THE POSITIVE CONTROL AT THE EDGE. RED WHEN: either comparison becomes
   * strict, so a transaction costing exactly the ceiling is refused.
   */
  it('pays a transaction that costs exactly the ceiling', async () => {
    const { wallet, calls } = fakeWallet({
      estimateFee: async () => 1_000n,
      async finalizeRecipe() { return { exact: true, intents: spending(400n, 600n) }; },
    });
    await expect(new WalletFeeSponsor(wallet, CEILING).addFeeAndFinalise({ tx: 1 }, new Date()))
      .resolves.toEqual(expect.objectContaining({ exact: true }));
    expect(calls.map(c => c.method)).not.toContain('revert');
  });

  /* RED WHEN: the constructor's ceiling guard is removed. */
  it('is not built without a ceiling', () => {
    const { wallet } = fakeWallet();
    expect(() => new WalletFeeSponsor(wallet, undefined as never))
      .toThrow(/no ceiling on what one transaction may spend/);
    expect(() => new WalletFeeSponsor(wallet, { perTransaction: 0n }))
      .toThrow(/no ceiling on what one transaction may spend/);
  });
});

/* ------------------------------------------------------------------ *
 * One fee at a time, from a view that is current
 * ------------------------------------------------------------------ */

/** A view the test moves by hand: where it has got, where the network is, which payments its history shows. */
function fakeView(start: { applied: bigint | null; tip: bigint }) {
  const notes: string[] = [];
  const shown = new Set<string>();
  const state = { applied: start.applied, tip: start.tip, tipFails: false };
  const view: FeePayerView & { notes: string[]; shown: Set<string>; state: typeof state } = {
    notes, shown, state,
    lastAccepted: null,
    applied: () => state.applied,
    tip: async () => { if (state.tipFails) throw new Error('the indexer is away'); return state.tip; },
    shows: async (h: string) => shown.has(h),
    numbers: () => `dust applied ${state.applied ?? 0n} of ${state.tip}; 3 coins free to spend`,
    note: (line: string) => { notes.push(line); },
  };
  return view;
}

/** A clock that only moves when the fee payer sleeps, and a hook run at every sleep. */
function fakeTiming(onSleep: (sleptMs: number) => void = () => {}) {
  let t = 0;
  const timing: ViewTiming = {
    waitMs: 45_000, pollMs: 1_000, writeLimitMs: 1e12, sendReserveMs: 0,
    now: () => t,
    sleep: async (ms) => { t += ms; onSleep(t); },
  };
  return timing;
}

/** A finalised transaction the fake wallet hands back, carrying its hash. */
const withHash = (hash: string, extra: Record<string, unknown> = {}) => ({ submittable: true, intents: spending(5n), transactionHash: () => hash, ...extra });

/** The error a submission throws when the node refuses at its door, as the real wallet library and node client build it. */
async function refusedAtTheDoor(code: number, data?: string): Promise<unknown> {
  const { Effect } = await import('effect');
  const { SubmissionError } = await import('@midnightntwrk/wallet-sdk-capabilities');
  const { NodeClientError } = await import('@midnightntwrk/wallet-sdk-node-client/effect');
  const { default: RpcError } = await import('@polkadot/rpc-provider/coder/error');
  const rpc = new RpcError(`${code}: refused${data ? `: ${data}` : ''}`, code, data);
  const inner = new NodeClientError.SubmissionError({ message: 'Transaction submission failed', txData: new Uint8Array(1) as never, cause: rpc });
  return Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: inner })))
    .then(() => { throw new Error('the stand-in did not fail'); }, (e: unknown) => e);
}

describe('the fee payer pays one fee at a time, from a view that is current', () => {
  /*
   * RED WHEN: a fee is balanced from a view that has not applied every DUST event the network holds.
   */
  it('waits until its view reaches the network before it balances', async () => {
    const view = fakeView({ applied: 10n, tip: 13n });
    let appliedWhenBalanced: bigint | null = null;
    const { wallet } = fakeWallet({
      view, async balanceFinalizedTransaction(tx) { appliedWhenBalanced = view.state.applied; return { from: tx }; },
    });
    const timing = fakeTiming((t) => { if (t >= 3_000) view.state.applied = 13n; });
    await new WalletFeeSponsor(wallet, CEILING, undefined, undefined, timing).addFeeAndFinalise({ tx: 1 }, new Date());
    expect(appliedWhenBalanced, 'balanced before the view was current').toBe(13n);
  });

  /*
   * RED WHEN: a view one event short of the network counts as current.
   */
  it('a view one event short of the network is behind, with no tolerance', async () => {
    const view = fakeView({ applied: 12n, tip: 13n });
    const { wallet, calls } = fakeWallet({ view });
    const e: any = await new WalletFeeSponsor(wallet, CEILING, undefined, undefined, fakeTiming())
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch((x) => x);
    expect(feeAnswerCodeOf(e)).toBe('fee-not-paid');
    expect(calls.map(c => c.method)).not.toContain('balanceFinalizedTransaction');
  });

  /*
   * RED WHEN: a fee payer whose view never gets there waits for ever, or pays anyway.
   * RED WHEN: a refusal is not written down with the view's numbers.
   */
  it('refuses at the bound with nothing booked and nothing sent, and writes the numbers down', async () => {
    const view = fakeView({ applied: 10n, tip: 20n });
    const { wallet, calls } = fakeWallet({ view });
    const timing = fakeTiming();
    const e: any = await new WalletFeeSponsor(wallet, CEILING, undefined, undefined, timing)
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch((x) => x);
    expect(e).toBeInstanceOf(FeeNotPaid);
    expect(saysNothingWasSent(e)).toBe(true);
    expect(timing.now()).toBe(45_000);
    expect(e.message).toMatch(/behind/);
    expect(e.message).toMatch(/nothing was lost/);
    expect(e.message).toContain('dust applied 10 of 20');
    expect(calls.map(c => c.method)).not.toContain('balanceFinalizedTransaction');
    expect(view.notes.join('\n')).toContain('dust applied 10 of 20');
  });

  /*
   * RED WHEN: a tip the indexer did not give is taken as reached.
   */
  it('refuses when the indexer cannot say how far the network has got', async () => {
    const view = fakeView({ applied: 10n, tip: 10n });
    view.state.tipFails = true;
    const { wallet, calls } = fakeWallet({ view });
    const e: any = await new WalletFeeSponsor(wallet, CEILING, undefined, undefined, fakeTiming())
      .addFeeAndFinalise({ tx: 1 }, new Date()).catch((x) => x);
    expect(feeAnswerCodeOf(e)).toBe('fee-not-paid');
    expect(e.message).toMatch(/the indexer is away/);
    expect(calls.map(c => c.method)).not.toContain('balanceFinalizedTransaction');
  });

  /*
   * RED WHEN: the next fee is balanced before the view shows the last payment the network accepted.
   * RED WHEN: the last accepted payment is remembered per fee payer, so a fee payer built per request forgets it.
   */
  it('the next fee waits until the view shows the last payment the network accepted, across fee payers', async () => {
    const view = fakeView({ applied: 30n, tip: 30n });
    const { wallet } = fakeWallet({ view, async finalizeRecipe() { return withHash('h-paid'); } });
    const first = new WalletFeeSponsor(wallet, CEILING, undefined, undefined, fakeTiming());
    await first.submit(await first.addFeeAndFinalise({ tx: 1 }, new Date()));
    expect(view.lastAccepted).toBe('h-paid');

    let shownWhenBalanced: boolean | null = null;
    const { wallet: same } = fakeWallet({
      view, async balanceFinalizedTransaction(tx) { shownWhenBalanced = view.shown.has('h-paid'); return { from: tx }; },
    });
    const timing = fakeTiming((t) => { if (t >= 2_000) view.shown.add('h-paid'); });
    await new WalletFeeSponsor(same, CEILING, undefined, undefined, timing).addFeeAndFinalise({ tx: 2 }, new Date());
    expect(shownWhenBalanced, 'balanced before the last payment was shown').toBe(true);
    expect(view.lastAccepted).toBeNull();
  });

  /*
   * RED WHEN: a payment whose submission failed is waited for, so one dropped payment stops every fee after it.
   */
  it('a payment whose submission failed is never waited for', async () => {
    const view = fakeView({ applied: 30n, tip: 30n });
    const { wallet } = fakeWallet({
      view, async finalizeRecipe() { return withHash('h-lost'); },
      async submitTransaction() { throw new Error('the socket closed'); },
    });
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, undefined, fakeTiming());
    await expect(sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date()))).rejects.toThrow('the socket closed');
    expect(view.lastAccepted).toBeNull();
  });
});

describe('a refusal at the node\'s door is nothing sent, and a refused spend proof is answered once', () => {
  /*
   * RED WHEN: the node's code is no longer found through the wallet library's failure cause, so every refusal reads as unknown.
   */
  it('reads the node\'s code from the error the real wallet library throws, never from its words', async () => {
    const e = await refusedAtTheDoor(1010, 'Custom error: 170');
    expect(String((e as Error).message)).not.toMatch(/1010|170/);
    expect(poolRefusalOf(e)).toEqual(expect.objectContaining({ rpcCode: 1010, custom: 170 }));
    expect(poolRefusalOf(await refusedAtTheDoor(1002, 'Runtime error'))).toEqual(expect.objectContaining({ rpcCode: 1002 }));
  });

  /*
   * RED WHEN: a code that means the transaction is, or may be, in the pool or already landed reads as refused at the door.
   */
  it('reads no other code as refused at the door, nor an intent the network already holds, nor plain words', async () => {
    for (const code of [1012, 1013, 1014, 1016]) expect(poolRefusalOf(await refusedAtTheDoor(code)), String(code)).toBeNull();
    expect(poolRefusalOf(await refusedAtTheDoor(1010, 'Custom error: 230'))).toBeNull();
    expect(poolRefusalOf(new Error('1010: Invalid Transaction: Custom error: 170'))).toBeNull();
  });

  /*
   * RED WHEN: a transaction the node refused at its door is reported as one that may have landed.
   */
  it('a refusal at the door that is not a spend proof is network-refused, released, and not sent again', async () => {
    const refusal = await refusedAtTheDoor(1002, 'Runtime error');
    const { wallet, calls } = fakeWallet({ async submitTransaction() { calls.push({ method: 'submitTransaction', args: [] }); throw refusal; } });
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const e: any = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).catch((x) => x);
    expect(e).toBeInstanceOf(NetworkRefused);
    expect(feeAnswerCodeOf(e)).toBe('network-refused');
    expect(e.message).toMatch(/nothing was lost/);
    expect(calls.filter(c => c.method === 'submitTransaction')).toHaveLength(1);
    expect(calls.map(c => c.method)).toContain('revert');
  });

  /*
   * RED WHEN: a refused spend proof is not paid again with a fresh proof.
   * RED WHEN: the page is given the hash of the refused transaction rather than the one that was sent.
   */
  it('a refused spend proof is balanced again from the same transaction and sent once more', async () => {
    const refusal = await refusedAtTheDoor(1010, 'Custom error: 170');
    let made = 0;
    let sent = 0;
    const { wallet, calls } = fakeWallet({
      async finalizeRecipe() { made += 1; return withHash(`h${made}`); },
      async submitTransaction(tx: any) { sent += 1; calls.push({ method: 'submitTransaction', args: [tx] }); if (sent === 1) throw refusal; return 'ref-again'; },
    });
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const ref = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 'the same' }, new Date()));
    expect(ref).toEqual(expect.objectContaining({ ref: 'ref-again', transactionHash: 'h2' }));
    const balanced = calls.filter(c => c.method === 'balanceFinalizedTransaction');
    expect(balanced).toHaveLength(2);
    expect(balanced[1]!.args[0]).toEqual({ tx: 'the same' });
    expect(calls.filter(c => c.method === 'submitTransaction').map(c => (c.args[0] as any).transactionHash())).toEqual(['h1', 'h2']);
  });

  /*
   * RED WHEN: a second refused spend proof is answered with a third attempt.
   */
  it('a second refused spend proof is network-refused and not sent a third time', async () => {
    const refusal = await refusedAtTheDoor(1010, 'Custom error: 170');
    let made = 0;
    const { wallet, calls } = fakeWallet({
      async finalizeRecipe() { made += 1; return withHash(`h${made}`); },
      async submitTransaction() { calls.push({ method: 'submitTransaction', args: [] }); throw refusal; },
    });
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const e: any = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).catch((x) => x);
    expect(feeAnswerCodeOf(e)).toBe('network-refused');
    expect(e.message).toMatch(/again after the fee was paid with a fresh proof/);
    expect(calls.filter(c => c.method === 'submitTransaction')).toHaveLength(2);
  });

  /*
   * RED WHEN: a refusal of a second copy of a transaction already handed in is read as nothing sent, when the first may have landed.
   */
  it('a copy handed in a second time is never read as refused at the door', async () => {
    const refusal = await refusedAtTheDoor(1010, 'Custom error: 170');
    let sent = 0;
    const { wallet } = fakeWallet({
      async finalizeRecipe() { return withHash('h-once'); },
      async submitTransaction() { sent += 1; if (sent === 1) throw new Error('the socket closed'); throw refusal; },
    });
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const tx = await sponsor.addFeeAndFinalise({ tx: 1 }, new Date());
    await expect(sponsor.submit(tx)).rejects.toThrow('the socket closed');
    const e: any = await sponsor.submit(tx).catch((x) => x);
    expect(saysNothingWasSent(e)).toBe(false);
  });

  /*
   * RED WHEN: a failure after the door (or a dropped connection) is reported as nothing sent.
   */
  it('any other failure of the submission is raised as it came, because it may have landed', async () => {
    const { wallet } = fakeWallet({ async submitTransaction() { throw await refusedAtTheDoor(1013); } });
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const e: any = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).catch((x) => x);
    expect(saysNothingWasSent(e)).toBe(false);
    expect(feeAnswerCodeOf(e)).toBeNull();
  });
});

describe('after a refused spend proof, paying again never reads as possibly landed', () => {
  /** A wallet whose first hand-in is refused for its spend proof, and whose second balance does what the test says. */
  const refusedThen = async (secondBalance: () => Promise<unknown>) => {
    const refusal = await refusedAtTheDoor(1010, 'Custom error: 170');
    let balanced = 0;
    let made = 0;
    return fakeWallet({
      async balanceFinalizedTransaction(tx) { balanced += 1; return balanced === 1 ? { from: tx } : secondBalance(); },
      async finalizeRecipe() { made += 1; return withHash(`h${made}`); },
      async submitTransaction() { throw refusal; },
    });
  };

  /*
   * RED WHEN: a second balance that fails after a refused spend proof is raised as it came, so the step reads as
   * possibly landed though nothing reached the pool.
   */
  it('a second balance that cannot be made is a fee not paid, and nothing sent', async () => {
    const { wallet } = await refusedThen(async () => { throw new Error('could not balance dust'); });
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const e: any = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).catch((x) => x);
    expect(saysNothingWasSent(e)).toBe(true);
    expect(feeAnswerCodeOf(e)).toBe('fee-not-paid');
    expect(e.message).toMatch(/could not balance dust/);
  });

  /*
   * RED WHEN: a ceiling refusal on the second balance is given a code that tells the person to try again.
   */
  it('a second balance over the ceiling keeps its own words and no code', async () => {
    const { wallet } = await refusedThen(async () => ({ from: 'dear' }));
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const first = await sponsor.addFeeAndFinalise({ tx: 1 }, new Date());
    (wallet as any).estimateFee = async () => 5_000n;
    const e: any = await sponsor.submit(first).catch((x) => x);
    expect(e).toBeInstanceOf(FeeRefused);
    expect(saysNothingWasSent(e)).toBe(true);
    expect(feeAnswerCodeOf(e)).toBeNull();
  });

  /*
   * RED WHEN: the second wait for the view is given its full bound however long the write has already run, so one
   * write outlasts the time a write is given and every company's queued fee is refused.
   */
  it('the second wait is bounded by the time left in the write, keeping room to send', async () => {
    const view = fakeView({ applied: 10n, tip: 10n });
    const refusal = await refusedAtTheDoor(1010, 'Custom error: 170');
    let made = 0;
    const { wallet, calls } = fakeWallet({
      view,
      async finalizeRecipe() { made += 1; return withHash(`h${made}`); },
      async submitTransaction() { view.state.tip = 99n; throw refusal; },
    });
    const timing: ViewTiming = { ...fakeTiming(), writeLimitMs: 100_000, sendReserveMs: 35_000 };
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, undefined, timing);
    sponsor.payingFor('acc_1');
    await timing.sleep(40_000);
    const e: any = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).catch((x) => x);
    expect(feeAnswerCodeOf(e)).toBe('fee-not-paid');
    expect(timing.now(), 'waited past the time left in the write').toBe(65_000);
    expect(calls.filter(c => c.method === 'balanceFinalizedTransaction')).toHaveLength(1);
  });

  /* RED WHEN: a write with no time left still pays again, past the time a write is given. */
  it('with no time left in the write, it does not pay again', async () => {
    const view = fakeView({ applied: 10n, tip: 10n });
    const refusal = await refusedAtTheDoor(1010, 'Custom error: 170');
    const { wallet, calls } = fakeWallet({ view, async finalizeRecipe() { return withHash('h'); }, async submitTransaction() { throw refusal; } });
    const timing: ViewTiming = { ...fakeTiming(), writeLimitMs: 100_000, sendReserveMs: 35_000 };
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, undefined, timing);
    sponsor.payingFor('acc_1');
    await timing.sleep(70_000);
    const e: any = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).catch((x) => x);
    expect(feeAnswerCodeOf(e)).toBe('fee-not-paid');
    expect(e.message).toMatch(/no time is left/);
    expect(calls.filter(c => c.method === 'balanceFinalizedTransaction')).toHaveLength(1);
  });

  /* RED WHEN: the bound a write is given drifts from the limit after which the lane counts a write as overdue. */
  it('uses the same limit as the lane', async () => {
    const { WRITE_OVERDUE_AFTER_MS } = await import('../wiring/chain.js');
    expect(VIEW_TIMING.writeLimitMs).toBe(WRITE_OVERDUE_AFTER_MS);
  });
});

describe('a step that may already be on the chain, and a history that never shows a payment', () => {
  /*
   * RED WHEN: the node's refusal of an intent the chain already holds is read as nothing sent, so a step that
   * landed is answered as one to try again and its lock is freed.
   */
  it('a refusal naming an intent the chain already holds is raised as it came, never as nothing sent', async () => {
    const already = await refusedAtTheDoor(1010, 'Custom error: 244');
    expect(poolRefusalOf(already)).toBeNull();
    const { wallet } = fakeWallet({ async submitTransaction() { throw already; } });
    const sponsor = new WalletFeeSponsor(wallet, CEILING);
    const e: any = await sponsor.submit(await sponsor.addFeeAndFinalise({ tx: 1 }, new Date())).catch((x) => x);
    expect(e).toBe(already);
    expect(saysNothingWasSent(e)).toBe(false);
  });

  /*
   * RED WHEN: a history that never shows the last payment (its write failed) refuses every fee after it, not one.
   * RED WHEN: forgetting the last payment is not written down for the operator.
   */
  it('refuses one fee when the view is at the tip but its history never shows the last payment, then forgets it', async () => {
    const view = fakeView({ applied: 30n, tip: 30n });
    view.lastAccepted = 'h-never-shown';
    const { wallet, calls } = fakeWallet({ view });
    const timing = fakeTiming();
    const sponsor = new WalletFeeSponsor(wallet, CEILING, undefined, undefined, timing);
    const e: any = await sponsor.addFeeAndFinalise({ tx: 1 }, new Date()).catch((x) => x);
    expect(feeAnswerCodeOf(e)).toBe('fee-not-paid');
    expect(calls.map(c => c.method)).not.toContain('balanceFinalizedTransaction');
    expect(view.lastAccepted).toBeNull();
    expect(view.notes.join('\n')).toMatch(/h-never-shown/);
    const before = timing.now();
    await sponsor.addFeeAndFinalise({ tx: 2 }, new Date());
    expect(calls.map(c => c.method)).toContain('balanceFinalizedTransaction');
    expect(timing.now(), 'the next fee waited for the forgotten payment').toBe(before);
  });
});
