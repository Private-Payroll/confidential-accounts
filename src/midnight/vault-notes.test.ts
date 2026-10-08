/**
 * V-74: the vault's private state, which IS the money.
 *
 * The chain holds 32 opaque bytes per note. Everything needed to spend one
 * lives here, so a disagreement between this and the chain is a vault whose
 * balance is permanently stuck — not stolen, just unspendable.
 *
 * ------------------------------------------------------------------------
 * WHAT LEFT THIS FILE, AND IT IS NOT A DELETED TEST.
 *
 * Four tests used to stand at the top of this file, over `noteBlindingFor` and
 * `nextBlindingFor`, and the first of them was the one to read first: the
 * change's blinding and the blinding the change is later spent under had to be
 * the same bytes, an equality that was invisible, load-bearing, and would fail
 * on a vault's very first payment.
 *
 * **They are gone because the thing they guarded is gone, not because they were
 * weak.** The blinding rule moved into the contract — `noteBlindingOf(vault,
 * coin)` in `Vault.compact` — where nobody chooses it and no second
 * implementation exists to disagree with it. The equality those tests asserted
 * cannot be false any more: there are no longer two derivations to compare.
 *
 * The contract-side property they became is in `contracts/test/the-new-vault.test.ts`
 * and in `vault-payout.test.ts`'s "two vaults holding the SAME coin publish
 * different bytes", which now plays what its name says because a blinding is a
 * function of the vault's address.
 *
 * What is still tested here is what is still a client rule: which note to
 * spend, and how the pool moves after a payment or a deposit.
 */
import { describe, it, expect } from 'vitest';
import {
  notesToSpend, afterPayment, afterStep, afterDeposit, paymentsFit,
  balanceOf, witnessesOver, withIndexRead, type VaultNotes, type Note,
  choosingNotesToSpend, aPaymentCanSpend,
} from './vault-notes.js';
import type { ChainReadIndex } from './note-index.js';
import { planRun } from './payment-plan.js';
import { changeNonceOf } from './vault-recovery.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';

/** The item at a place in a list; an item that is not there fails the test here rather than being read through. */
const itemAt = <T,>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`expected an item at place ${i}, and the list holds ${xs.length}`);
  return x;
};

/**
 * The change coin a payment handed back, as `changeCoinOf` reads it off the
 * call's own outputs.
 *
 * **BUILT FROM THE SPENT NOTE AND THE AMOUNT, WHICH IS WHAT THE CONTRACT
 * DOES** — `sendShielded` returns the remainder — so these tests describe a
 * chain that is behaving, and the ones that pass a mismatching coin describe
 * one that is not. The NONCE is arbitrary here on purpose: the whole point of
 * `C239` is that it is not a function of anything this side holds, which is why
 * a test that computed it would be testing the derivation this round removed.
 */
const changeOf = (spent: Note, amount: bigint, nonce = 'f0'.repeat(32)) =>
  ({ nonce: nonce as Hex, token: spent.token, value: spent.value - amount });

const GBP = 'aa'.repeat(32);
const USD = 'bb'.repeat(32);

const note = (n: number, value: bigint, token = GBP, index?: bigint): Note =>
  ({ nonce: String(n).padStart(2, '0').repeat(32), token, value, ...(index === undefined ? {} : { index }) });

/** Two transaction hashes, as a finalised result reports them. */
const TX_A = 'a1'.repeat(32);
const TX_B = 'b2'.repeat(32);

/** An index as `noteIndexFrom` hands one over. Only a test may make one this way. */
const readFromChain = (n: bigint) => n as ChainReadIndex;

const pool = (notes: Note[]): VaultNotes => ({ notes });

/** A note a payment can spend: it records the transaction that created it. */
const recorded = (n: number, value: bigint, token = GBP, index?: bigint): Note =>
  ({ ...note(n, value, token, index), createdIn: TX_A });

describe('V-74: choosing the notes a payment spends', () => {
  it('takes the largest note first, as few as cover it, as the run planner does', () => {
    const notes = [recorded(1, 1_000n), recorded(2, 300n), recorded(3, 50n)];
    /* RED WHEN the payment's choice is not the planner's: the smallest covering note would be 300. */
    expect(notesToSpend(notes, GBP, 200n).map((n) => n.value)).toEqual([1_000n]);
    expect(notesToSpend(notes, GBP, 1_100n).map((n) => n.value)).toEqual([1_000n, 300n]);
  });

  it('is the planner\'s choice for every pool and amount in the table, never a second rule', () => {
    const values = [900n, 150n, 150n, 400n, 100n, 5_000n];
    for (let mask = 0; mask < 1 << values.length; mask += 1) {
      const notes = values.map((v, i) => ((mask >> i) & 1 ? recorded(i + 1, v) : note(i + 1, v)));
      for (const amount of [1n, 100n, 150n, 151n, 900n, 5_000n, 5_001n, 5_900n, 6_000n]) {
        const plan = planRun({
          token: GBP,
          notes: notes.map((n) => ({ id: n.nonce, token: n.token, value: n.value, spendable: aPaymentCanSpend(n) })),
          units: [{ kind: 'payment', payees: [{ id: 'p', amount, nonce: 'p' }] }],
        });
        const step = plan.ok ? plan.steps[0] : undefined;
        const choice = choosingNotesToSpend(notes, GBP, amount);
        if (step !== undefined && step.kind !== 'merge') {
          expect(
            choice.of === 'chosen' && choice.notes.map((n) => n.nonce),
            `RED WHEN: the payment chooses by a rule other than the planner's (mask ${mask}, ${amount})`,
          ).toEqual(step.notes.map((r) => (r.kind === 'held' ? r.id : '')));
        } else {
          expect(choice.of, `mask ${mask}, ${amount}`).not.toBe('chosen');
        }
      }
    }
  });

  it('is deterministic on ties, so two operators pick the same notes and collide visibly', () => {
    /*
     * Two devices running the same payroll must not both half-succeed. If they
     * pick the same note the chain refuses the second, which is a conflict an
     * operator can see.
     */
    const notes = [recorded(9, 500n), recorded(2, 500n), recorded(5, 500n)];
    expect(notesToSpend(notes, GBP, 100n)).toEqual(notesToSpend([...notes].reverse(), GBP, 100n));
    /* RED WHEN the tie-break changes: the lowest nonce is the one every operator picks. */
    expect(notesToSpend(notes, GBP, 100n).map((n) => n.nonce)).toEqual([note(2, 0n).nonce]);
  });

  it('never spends a note of the wrong token', () => {
    const notes = [recorded(1, 1_000n, USD), recorded(2, 400n, GBP)];
    expect(notesToSpend(notes, GBP, 100n).map((n) => n.token)).toEqual([GBP]);
    expect(() => notesToSpend(notes, 'cc'.repeat(32) as Hex, 1n)).toThrow(/holds no notes/i);
  });

  it('DRAWS ON TWO NOTES AT MOST, AND REFUSES TO MERGE, saying what the pool holds', () => {
    /* Two notes of 60 pay 100 together: one payment takes two notes. */
    expect(notesToSpend([recorded(1, 60n), recorded(2, 60n)], GBP, 100n).map((n) => n.value)).toEqual([60n, 60n]);
    /*
     * Three notes of 40 cannot: that needs a merge, which is maintenance and
     * not something a payment discovers it needs on a payroll deadline.
     */
    const notes = [recorded(1, 40n), recorded(2, 40n), recorded(3, 40n)];
    expect(() => notesToSpend(notes, GBP, 100n))
      .toThrow(/no 2 notes a payment can spend cover 100: the largest is 40 and the pool holds 120 across 3.*Merge them first/i);
  });
});

describe('ONE FUNCTION DECIDES WHICH NOTES A PAYMENT SPENDS, AND EVERY QUESTION ABOUT IT ASKS THAT FUNCTION', () => {
  /*
   * A payment spends a note at the place the chain filed it, read from the
   * transaction that created it. A note that records none is still the vault's
   * and still on chain; a payment cannot take it.
   */
  const unrecorded = (n: number, value: bigint) => note(n, value);

  it('PASSES OVER a larger note that records no transaction, spends the ones that do, and NAMES what it passed over', () => {
    const notes = [unrecorded(2, 5_000n), recorded(1, 150n)];
    const choice = choosingNotesToSpend(notes, GBP, 100n);
    expect(
      choice.of === 'chosen' && choice.notes.map((n) => n.nonce),
      'RED WHEN: the choice takes the largest note whether or not a payment can spend it, which refuses a vault that can pay',
    ).toEqual([note(1, 0n).nonce]);
    expect(
      choice.of === 'chosen' && choice.passedOver.map((n) => n.nonce),
      'RED WHEN: a note the payment could not reach is passed over silently, so nobody is told the vault holds money a payment cannot spend',
    ).toEqual([note(2, 0n).nonce]);
  });

  it('SAYS STRANDED, naming the notes it could not spend, when only they would make the payment', () => {
    const notes = [unrecorded(9, 700n), unrecorded(3, 200n), recorded(1, 50n)];
    const choice = choosingNotesToSpend(notes, GBP, 800n);
    expect(
      choice,
      'RED WHEN: stranded money is reported as "nothing covers it" or loses a note from the list, which sends a person to pay in money the vault already holds',
    ).toEqual({ of: 'stranded', notes: [unrecorded(9, 700n), unrecorded(3, 200n)] });
    const refused = (() => { try { notesToSpend(notes, GBP, 800n); } catch (e) { return (e as Error).message; } return ''; })();
    expect(refused, 'RED WHEN: the refusal does not name the notes it is about').toContain(`${note(3, 0n).nonce} (200)`);
    expect(refused).toContain(`${note(9, 0n).nonce} (700)`);
    expect(refused, 'RED WHEN: the refusal implies the money is gone').toMatch(/still on chain and still the vault's/);
    expect(refused, 'RED WHEN: the refusal names nothing a person can do').toMatch(/recordCreatingTransaction, or rebuild the pool/);
    expect(refused, 'RED WHEN: stranded money is told to merge').not.toMatch(/Merge/);
    expect(refused).toMatch(/None of them records which transaction created it/);
    expect(() => notesToSpend([unrecorded(3, 200n)], GBP, 100n)).toThrow(/one more note would: .*\. It does not record which transaction/);
  });

  it('counts a recorded value that no spend could read as not recorded', () => {
    const malformed = { ...note(1, 950n), createdIn: 'not-a-hash' as Hex };
    const upper = { ...note(4, 160n), createdIn: 'A1'.repeat(32) as Hex };
    expect(
      aPaymentCanSpend(malformed),
      'RED WHEN: any recorded value counts, so a note whose index can never be read is chosen and refused at the spend',
    ).toBe(false);
    expect(aPaymentCanSpend({ ...note(1, 1n), createdIn: TX_A })).toBe(true);
    expect(aPaymentCanSpend(note(1, 1n))).toBe(false);
    /* The walk's own marker for a change it has not made yet is not a transaction, on any real note. */
    expect(
      aPaymentCanSpend({ ...note(1, 1n), createdIn: 'sim:recorded-by-the-payment-that-makes-it' as Hex }),
      'RED WHEN: a note read from anywhere that carries the walk\'s marker counts as spendable, though no spend can read it',
    ).toBe(false);
    /* The product's shape reads a hash in either case, so either case can be spent. */
    expect(aPaymentCanSpend(upper)).toBe(true);
    expect(choosingNotesToSpend([malformed, recorded(2, 900n)], GBP, 100n))
      .toEqual({ of: 'chosen', notes: [recorded(2, 900n)], passedOver: [malformed] });
  });

  it('still tells "no notes of this token" and "nothing covers it" apart, and the second counts every note of the token', () => {
    expect(choosingNotesToSpend([recorded(1, 10n, USD)], GBP, 1n)).toEqual({ of: 'no-notes-of-token' });
    expect(
      choosingNotesToSpend([recorded(1, 60n), unrecorded(2, 30n)], GBP, 100n),
      'RED WHEN: the merge refusal forgets notes a payment cannot spend, understating what the vault holds',
    ).toEqual({ of: 'none-covers', largest: 60n, held: 90n, count: 2 });
  });

  it('THE WALK AND THE PAYMENT AGREE: a run fits exactly when the payment would choose its notes, for every pool in the table', () => {
    const table: Array<[string, Note[], bigint]> = [
      ['the pool this was filed about', [recorded(1, 5_000n), unrecorded(2, 150n)], 100n],
      ['the other way round', [unrecorded(1, 5_000n), recorded(2, 150n)], 100n],
      ['only unrecorded', [unrecorded(1, 5_000n)], 100n],
      ['nothing big enough', [recorded(1, 50n)], 100n],
      ['two notes together', [recorded(1, 60n), recorded(2, 60n)], 100n],
      ['three notes needed', [recorded(1, 40n), recorded(2, 40n), recorded(3, 40n)], 100n],
      ['another token', [recorded(1, 5_000n, USD)], 100n],
      ['exact', [recorded(1, 100n), unrecorded(2, 100n)], 100n],
    ];
    for (const [what, notes, amount] of table) {
      const pays = choosingNotesToSpend(notes, GBP, amount).of === 'chosen';
      let fits = true;
      try { paymentsFit(pool(notes), [{ token: GBP, amount }]); } catch { fits = false; }
      expect(fits, `RED WHEN: the affordability walk and the payment answer differently - ${what}`).toBe(pays);
    }
  });

  it('THE WALK AGREES WITH A RUN OF PAYMENTS MADE ONE AFTER ANOTHER, change and all', () => {
    /*
     * A walk that chose by one rule and a payment that spent by another could
     * say a run fits and then stop half way: the pool [12, 8, 5, 5] paying
     * 4, 6, 4, 11 is one such run. RED WHEN the walk and the payments made in
     * turn by `notesToSpend` and `afterStep` disagree for any run here.
     */
    const runs: Array<[bigint[], bigint[]]> = [
      [[12n, 8n, 5n, 5n], [4n, 6n, 4n, 11n]],
      [[11n, 1n, 7n, 8n], [1n, 3n, 4n, 8n, 11n]],
      [[9n, 5n, 2n], [4n, 1n, 2n, 1n, 7n]],
      [[100n, 60n], [50n, 90n]],
      [[40n, 40n, 40n], [100n]],
    ];
    for (const [values, amounts] of runs) {
      const start = values.map((v, i) => recorded(i + 1, v));
      let fits = true;
      try { paymentsFit(pool(start), amounts.map((amount) => ({ token: GBP, amount }))); } catch { fits = false; }
      let paid = true;
      let now = pool(start);
      amounts.forEach((amount, i) => {
        if (!paid) return;
        try {
          const spent = notesToSpend(now.notes, GBP, amount);
          const left = spent.reduce((t, n) => t + n.value, 0n) - amount;
          const change = left === 0n ? undefined : { nonce: note(100 + i, 0n).nonce, token: GBP, value: left };
          now = afterStep(now, { spent: spent.map((n) => n.nonce), pays: amount, kept: change }, TX_B);
        } catch { paid = false; }
      });
      expect(fits, `RED WHEN: the walk says ${fits ? 'fits' : 'does not fit'} and the payments ${paid ? 'were all made' : 'stopped'}: ${values} paying ${amounts}`).toBe(paid);
    }
  });

  it('THE WITNESS THE CIRCUIT CALLS HANDS OVER EXACTLY THE NOTE IT IS OFFERED, and chooses nothing', () => {
    /* As `call` builds it: the chosen notes carry the index read for this call. */
    const pooled = pool([recorded(1, 30n), recorded(2, 90n), unrecorded(3, 150n)]);
    const [first, second] = notesToSpend(pooled.notes, GBP, 100n);
    const forTheCall = withIndexRead(withIndexRead(pooled, first!.nonce, readFromChain(7n)), second!.nonce, readFromChain(8n));
    const pending: { spending?: string } = {};
    const w = witnessesOver(() => forTheCall, pending, first!.nonce);
    const [, coin] = w.noteToSpend({}, fromHex(GBP), 100n) as [unknown, any];
    expect(
      pending.spending,
      'RED WHEN: the witness makes a choice of its own instead of handing over the note the payment was offered',
    ).toBe(first!.nonce);
    /* The planner offers the larger note first; a witness choosing for itself would hand over the smaller. */
    expect(coin.value).toBe(90n);
    expect(coin.mt_index).toBe(7n);
    /* Offered the note no rule would pick first, it hands over exactly that one. RED WHEN the witness chooses by any rule. */
    const asked: { spending?: string } = {};
    const [, other] = witnessesOver(() => forTheCall, asked, second!.nonce).noteToSpend({}, fromHex(GBP), 100n) as [unknown, any];
    expect([asked.spending, other.value]).toEqual([second!.nonce, 30n]);
    /* RED WHEN a call offered nothing is handed a note anyway. */
    expect(() => witnessesOver(() => forTheCall, {}).noteToSpend({}, fromHex(GBP), 100n)).toThrow(/was offered none/);
    /* RED WHEN the witness hands over a note of another token than the call pays. */
    expect(() => witnessesOver(() => forTheCall, {}, first!.nonce).noteToSpend({}, fromHex(USD), 1n)).toThrow(/of another token/);
  });
});

describe('a step that spends several notes is recorded as the chain holds it', () => {
  const kept = (value: bigint, nonce = 'f2'.repeat(32)) => ({ nonce: nonce as Hex, token: GBP, value });

  it('takes EVERY note a two-note payment spent out of the pool, and adds its change', () => {
    const a = recorded(1, 60n);
    const b = recorded(2, 60n);
    const other = recorded(3, 7n);
    const s = afterStep(pool([a, b, other]), { spent: [a.nonce, b.nonce], pays: 100n, kept: kept(20n) }, TX_B);
    /* RED WHEN only the first note leaves: the pool would offer a note the chain has nullified. */
    expect(s.notes.map((n) => n.nonce).sort()).toEqual([other.nonce, 'f2'.repeat(32)].sort());
    expect(balanceOf(s, GBP)).toBe(27n);
    expect(s.notes.find((n) => n.nonce === 'f2'.repeat(32))?.createdIn).toBe(TX_B);
  });

  it('records a merge: every note it spent gone, and the one coin it kept, worth all of them', () => {
    const notes = [recorded(1, 10n), recorded(2, 20n), recorded(3, 30n)];
    const s = afterStep(pool(notes), { spent: notes.map((n) => n.nonce), pays: 0n, kept: kept(60n), merge: true }, TX_B);
    /* RED WHEN a merge is recorded as spending its first note only. */
    expect(s.notes).toEqual([{ ...kept(60n), createdIn: TX_B }]);
    /* RED WHEN a merge's coin is recorded at a value the arithmetic does not give. */
    expect(() => afterStep(pool(notes), { spent: notes.map((n) => n.nonce), pays: 0n, kept: kept(59n), merge: true }))
      .toThrow(/arithmetic says 60/);
    /* RED WHEN a "merge" that sends money out, or merges one note, is recorded. */
    expect(() => afterStep(pool(notes), { spent: notes.map((n) => n.nonce), pays: 1n, kept: kept(59n), merge: true }))
      .toThrow(/a merge spends at least two notes and sends nothing/);
    expect(() => afterStep(pool(notes), { spent: [notes[0]!.nonce], pays: 0n, kept: kept(10n), merge: true }))
      .toThrow(/a merge spends at least two notes/);
  });

  it('refuses a step whose notes are of two tokens, rather than dropping one of them', () => {
    /* RED WHEN a note of another token is taken out of the pool by a step that pays in one. */
    expect(() => afterStep(pool([recorded(1, 60n), recorded(2, 50n, USD)]), { spent: [note(1, 0n).nonce, note(2, 0n).nonce], pays: 100n, kept: kept(10n) }))
      .toThrow(/more than one token/);
  });

  it('refuses a step naming a note the pool does not hold, or one note twice, and changes nothing', () => {
    const a = recorded(1, 60n);
    /* RED WHEN a step is half-applied to a pool that holds only some of its notes. */
    expect(() => afterStep(pool([a]), { spent: [a.nonce, note(9, 0n).nonce], pays: 50n, kept: kept(10n) }))
      .toThrow(/no note 0909.* to spend/);
    expect(() => afterStep(pool([a]), { spent: [a.nonce, a.nonce], pays: 50n, kept: kept(70n) }))
      .toThrow(/names one note twice/);
  });
});

describe('V-74: carrying the pool forward', () => {
  it('THE DEFECT THIS PREVENTS: a vault that can make exactly one payment', () => {
    /*
     * The first test helper written for the vault did not carry the coin
     * forward. It could pay once; every later payment was refused as not
     * matching what the vault held. The same mistake in a client is a payroll
     * that pays its first employee and stops.
     */
    const first = note(1, 1_000n);
    let s = pool([first]);
    s = afterPayment(s, first.nonce, 250n, changeOf(first, 250n), TX_A);
    expect(balanceOf(s, GBP)).toBe(750n);

    const [next] = notesToSpend(s.notes, GBP, 200n) as [Note];
    expect(next.value).toBe(750n);
    /* Where to read its index from, and no index: that is read when it is spent. */
    expect(next.createdIn).toBe(TX_A);
    expect(next.index).toBeUndefined();

    s = afterPayment(s, next.nonce, 200n, changeOf(next, 200n, 'f1'.repeat(32)), TX_B);
    expect(balanceOf(s, GBP)).toBe(550n);
  });

  it('C239: the change note carries the nonce the call REPORTED, not one derived here', () => {
    /*
     * **THIS TEST IS THE ROUND'S CHANGE, INVERTED.** It used to assert the
     * opposite — that the nonce equalled `changeNonceOf(spent)` — and that
     * assertion passing is exactly what a second source of truth looks like
     * while it still agrees.
     *
     * The derivation has not been deleted; it has been demoted. It lives in
     * `vault-recovery.ts` as the fallback for a reading nobody captured, which
     * is what `V-47` says it should be, and this asserts that the everyday path
     * no longer consults it: a change coin whose nonce is NOTHING the kernel
     * would have produced is recorded verbatim, because the chain is what says
     * what the coin is.
     */
    const spent = note(1, 1_000n);
    const read = changeOf(spent, 400n);
    const s = afterPayment(pool([spent]), spent.nonce, 400n, read, TX_A);
    expect(itemAt(s.notes, 0).nonce).toBe(read.nonce);
    expect(itemAt(s.notes, 0).nonce).not.toBe(toHex(changeNonceOf(fromHex(spent.nonce))));
  });

  it('C239: REFUSES when the read and the arithmetic disagree, in both directions', () => {
    /*
     * The read is not trusted over the subtraction, nor the other way round.
     * Two claims about the same money have no correct resolution, and choosing
     * either silently is how a pool comes to hold a note the chain does not.
     */
    const spent = note(1, 1_000n);
    expect(() => afterPayment(pool([spent]), spent.nonce, 400n, changeOf(spent, 250n)))
      .toThrow(/two claims about the same money/);

    /* The contract kept change and the read says it did not — B1's shape. */
    expect(() => afterPayment(pool([spent]), spent.nonce, 400n, undefined))
      .toThrow(/no coin coming back to it/);

    /* Spent exactly, and yet a coin came back. */
    expect(() => afterPayment(pool([spent]), spent.nonce, 1_000n, changeOf(spent, 400n)))
      .toThrow(/spent exactly/);

    /* A coin of another token is not this payout's change. */
    const wrongToken = { nonce: 'f0'.repeat(32) as Hex, token: USD, value: 600n };
    expect(() => afterPayment(pool([spent]), spent.nonce, 400n, wrongToken))
      .toThrow(/is not this payout's change/);
  });

  it('records the change note with NO INDEX when the chain has not filed one yet', () => {
    /*
     * The ordinary case at the moment of a payment, and the reason
     * `Note.index` is optional. A zero here would be a plausible wrong number
     * — the one thing this repository has paid for most.
     */
    const spent = note(1, 1_000n);
    const s = afterPayment(pool([spent]), spent.nonce, 400n, changeOf(spent, 400n));
    expect(itemAt(s.notes, 0).index).toBeUndefined();
    expect(s.notes[0]).not.toHaveProperty('createdIn');
  });

  it('records WHERE the change note\'s index is to be read, and never an index', () => {
    const spent = note(1, 1_000n, GBP, 5n);
    const s = afterPayment(pool([spent]), spent.nonce, 400n, changeOf(spent, 400n), TX_B);
    expect(itemAt(s.notes, 0).createdIn).toBe(TX_B);
    expect(s.notes[0]).not.toHaveProperty('index');
  });

  it('DROPS a zero change rather than keeping a note the chain does not have', () => {
    /*
     * The contract emits no change coin when a note is spent exactly. A zero
     * note kept here is a pool that disagrees with the chain, which is the
     * divergence that makes a vault unspendable.
     */
    const spent = note(1, 500n);
    const s = afterPayment(pool([spent]), spent.nonce, 500n, undefined, TX_A);
    expect(s.notes).toEqual([]);
    expect(balanceOf(s, GBP)).toBe(0n);
  });

  it('refuses to spend a note the pool does not have, or more than it holds', () => {
    const s = pool([note(1, 100n)]);
    expect(() => afterPayment(s, note(2, 1n).nonce, 1n, undefined)).toThrow(/no note .* to spend/i);
    expect(() => afterPayment(s, note(1, 100n).nonce, 101n, undefined))
      .toThrow(/holds 100 and the payment is 101/);
  });

  it('refuses a duplicate deposit and a deposit of nothing', () => {
    const s = afterDeposit(pool([]), note(1, 100n));
    expect(() => afterDeposit(s, note(1, 100n))).toThrow(/already holds a note/i);
    expect(() => afterDeposit(s, note(2, 0n))).toThrow(/not a deposit/i);
  });

  it('keeps tokens apart', () => {
    const s = afterDeposit(afterDeposit(pool([]), note(1, 100n, GBP)), note(2, 70n, USD));
    expect(balanceOf(s, GBP)).toBe(100n);
    expect(balanceOf(s, USD)).toBe(70n);
  });

  it('REFUSES a deposit that arrives already carrying an index, because a deposit cannot know one', () => {
    expect(() => afterDeposit(pool([]), note(1, 100n, GBP, 616n)))
      .toThrow(/was not read from the chain/);
    expect(() => afterDeposit(pool([]), note(1, 100n, GBP, 0n)))
      .toThrow(/was not read from the chain/);
  });
});

describe('an index is set on one note of a copy, and only as the chain reported it', () => {
  it('writes the index against that note and leaves every other note as it was', () => {
    const a = { ...note(1, 100n), createdIn: TX_A };
    const b = note(2, 70n);
    const s = withIndexRead(pool([a, b]), a.nonce, readFromChain(616n));
    expect(s.notes.find((n) => n.nonce === a.nonce)).toEqual({ ...a, index: 616n });
    expect(s.notes.find((n) => n.nonce === b.nonce)).toEqual(b);
  });

  it('replaces an earlier index with the chain\'s current answer', () => {
    const s = withIndexRead(pool([note(1, 100n, GBP, 3n)]), note(1, 0n).nonce, readFromChain(9n));
    expect(itemAt(s.notes, 0).index).toBe(9n);
  });

  it('refuses a note the pool does not hold', () => {
    expect(() => withIndexRead(pool([note(1, 100n)]), note(2, 1n).nonce, readFromChain(1n)))
      .toThrow(/has no note/);
  });

  it('does not accept a plain number: the type is the pin', () => {
    // @ts-expect-error a bigint that did not come from noteIndexFrom is not an index
    const s = withIndexRead(pool([note(1, 100n)]), note(1, 0n).nonce, 616n);
    expect(itemAt(s.notes, 0).index).toBe(616n);
  });
});

describe('V-74: the witnesses the contract actually calls', () => {
  it('hand the contract a qualified coin, and record which note was chosen', () => {
    const state = pool([recorded(1, 1_000n, GBP, 4n)]);
    const pending: { spending?: string } = {};
    const w = witnessesOver(() => state, pending, note(1, 0n).nonce);

    const [, coin] = w.noteToSpend({}, fromHex(GBP), 250n) as [unknown, any];
    expect(coin.value).toBe(1_000n);
    expect(coin.mt_index).toBe(4n);
    /*
     * The index is the half that is NOT derivable — the chain assigns it — and
     * it is what makes the coin spendable. Losing it costs a rescan.
     */
    expect(pending.spending).toBe(note(1, 0n).nonce);
  });

  it('S6f: REFUSES a note whose place in the commitment tree has never been read', () => {
    /*
     * **THE REFUSAL THAT REPLACES AN INVENTED NUMBER.** A change note or a
     * deposit is recorded before the chain has filed its commitment, so its
     * index is `undefined` — and handing the contract a zero builds a
     * transaction whose Zswap input carries a merkle path for a different leaf.
     * The chain refuses that, and the refusal names nothing a person can act
     * on. This one names the note.
     *
     * It is refused at SELECTION rather than skipped, because a vault that
     * quietly pays around a note it cannot spend is a vault whose pool is
     * drifting with nobody told. `balance`'s reconciliation cannot catch it:
     * the note IS on chain and IS the vault's.
     */
    const unread = { nonce: '07'.repeat(32), token: GBP, value: 900n, createdIn: TX_A } as Note;
    const w = witnessesOver(() => pool([unread]), {}, unread.nonce);
    expect(() => w.noteToSpend({}, fromHex(GBP), 100n))
      .toThrow(/has not been read for this call/);
    expect(() => w.noteToSpend({}, fromHex(GBP), 100n))
      .toThrow(/NOTHING HERE MAY SUBSTITUTE A NUMBER/);
  });

  it('DECLARES THE TWO WITNESSES THE VAULT ASKS FOR, and no blinding, which is not the device\'s to choose', () => {
    /*
     * Two more used to be here — `noteBlinding` and `nextBlinding` — and
     * a client that still offered them would be offering the contract
     * something it does not ask for, which is how a rule survives in two
     * places after only one of them was changed. The vault's secret is the
     * second witness the vault declares; this pool has none to give.
     */
    const w = witnessesOver(() => pool([note(1, 1n)]), {});
    expect(Object.keys(w)).toEqual(['noteToSpend', 'nonceSecret']);
    /* RED WHEN the pool answers for a secret it does not hold. */
    expect(() => (w as unknown as { nonceSecret: (c: unknown) => unknown }).nonceSecret({})).toThrow();
  });
});

describe('T-38: whether a run fits the pool, one payment at a time', () => {
  /* A note a payment can spend: it records the transaction that created it. */
  const spendable = (n: number, value: bigint, token = GBP): Note => ({ ...note(n, value, token), createdIn: TX_A });

  it('THE QUESTION A SUM ANSWERS WRONGLY: 120 across three notes cannot pay 100', () => {
    /*
     * The check is only worth having if it asks the right question. A pool of
     * 40 + 40 + 40 has a balance of 120 and cannot make a payment of 100,
     * because one payment draws on two notes at most and does not merge - so
     * an affordability check built on the balance alone passes a run that
     * stops on its first payee.
     */
    const p = pool([spendable(1, 40n), spendable(2, 40n), spendable(3, 40n)]);
    expect(() => paymentsFit(p, [{ token: GBP, amount: 100n }]))
      .toThrow(/payment 1 of 1 cannot be made/);
    expect(() => paymentsFit(p, [{ token: GBP, amount: 100n }]))
      .toThrow(/no 2 notes a payment can spend cover 100/);
    /* And two notes of 60 do pay it, together, as one payment can. */
    expect(() => paymentsFit(pool([spendable(1, 60n), spendable(2, 60n)]), [{ token: GBP, amount: 100n }])).not.toThrow();
  });

  it('carries the change forward, so a run of many payments out of one note fits', () => {
    const p = pool([spendable(1, 1_000n)]);
    expect(() => paymentsFit(p, [
      { token: GBP, amount: 250n }, { token: GBP, amount: 250n }, { token: GBP, amount: 400n },
    ])).not.toThrow();
  });

  it('names WHICH payment fails, because a run that stops mid-way is the failure', () => {
    /*
     * Three payments of 400 out of one note of 1,000: the first two fit and the
     * third does not. A check that answered "cannot afford" without saying
     * where would leave an operator guessing at a run they have not started.
     */
    const p = pool([spendable(1, 1_000n)]);
    expect(() => paymentsFit(p, [
      { token: GBP, amount: 400n }, { token: GBP, amount: 400n }, { token: GBP, amount: 400n },
    ])).toThrow(/payment 3 of 3/);
  });

  it('drops a note spent exactly rather than carrying a zero forward', () => {
    /*
     * The same rule `afterPayment` keeps, for the same reason: a zero note is a
     * note the chain does not have. Here it would also let a later payment
     * appear to have a note to come out of.
     */
    const p = pool([spendable(1, 300n)]);
    /*
     * A zero note carried forward would answer "no single note covers 1: the
     * largest is 0". The note being GONE is what "holds no notes" says, and
     * that is the difference this asserts.
     */
    expect(() => paymentsFit(p, [{ token: GBP, amount: 300n }, { token: GBP, amount: 1n }]))
      .toThrow(/holds no notes/);
  });

  it('keeps tokens apart, so a euro balance never pays a pound', () => {
    const p = pool([spendable(1, 1_000n, USD)]);
    expect(() => paymentsFit(p, [{ token: GBP, amount: 10n }]))
      .toThrow(/holds no notes/);
  });

  it('does NOT look at indices, and says so by fitting a run of unread notes', () => {
    /*
     * Deliberate, and recorded here rather than left as a surprise: a note
     * whose `mt_index` has never been read cannot be SPENT, and this walk
     * cannot see that. `witnessesOver` is the refusal. An affordability check
     * that also checked indices would need a read nothing in this repository
     * performs — which is `S6f`'s `changeIndex` finding, not this function's.
     */
    const unread = { nonce: '07'.repeat(32), token: GBP, value: 900n, createdIn: TX_A } as Note;
    expect(() => paymentsFit(pool([unread]), [{ token: GBP, amount: 100n }])).not.toThrow();
  });

  it('REFUSES a run whose note a payment could not spend, because it records no creating transaction', () => {
    /*
     * A payment reads the note's place in the commitment tree from the
     * transaction that created it, and refuses a note that does not say. A walk
     * that answered "fits" for it would let a proposal be raised and approved,
     * fees and all, for a payment the vault client refuses.
     */
    const legacy = note(1, 1_000n);
    expect(() => paymentsFit(pool([legacy]), [{ token: GBP, amount: 100n }]))
      .toThrow(/payment 1 of 1 cannot be made out of this vault: the notes this vault can spend do not cover 100, and one more note would: 0101.* It does not record which transaction created it/);
    expect(() => paymentsFit(pool([legacy]), [{ token: GBP, amount: 100n }]))
      .toThrow(/recordCreatingTransaction/);
  });

  it('FITS a run out of a recorded note when a note beside it records no transaction', () => {
    /*
     * This used to be refused: the walk chose the smallest covering note and
     * then asked whether it could be spent, so a vault holding 5,000 it could
     * spend was told it could not pay 100 - and for a run already raised, the
     * pay step said the vault no longer held the money.
     */
    const p = pool([spendable(1, 5_000n), note(2, 150n)]);
    expect(
      () => paymentsFit(p, [{ token: GBP, amount: 100n }]),
      'RED WHEN: an unrecorded small note blocks a payment a recorded large one can make',
    ).not.toThrow();
    /* And the other way round: the note chosen records one, so a larger note that does not is never asked. */
    const q = pool([spendable(1, 150n), note(2, 5_000n)]);
    expect(() => paymentsFit(q, [{ token: GBP, amount: 100n }])).not.toThrow();
    /* A second payment that only the unrecorded note could cover is refused, and names it. */
    expect(() => paymentsFit(p, [{ token: GBP, amount: 100n }, { token: GBP, amount: 4_950n }]))
      .toThrow(/payment 2 of 2 cannot be made out of this vault: the notes this vault can spend do not cover 4950/);
  });

  it('does not ask it of the change the walk puts back, which the payment itself records', () => {
    const p = pool([spendable(1, 1_000n)]);
    expect(() => paymentsFit(p, [{ token: GBP, amount: 100n }, { token: GBP, amount: 100n }])).not.toThrow();
  });
});
