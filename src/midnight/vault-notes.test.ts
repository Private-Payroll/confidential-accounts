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
 * The contract-side property they became is in `contracts/test/vault-split.test.ts`
 * and in `vault-payout.test.ts`'s "two vaults holding the SAME coin publish
 * different bytes", which now plays what its name says because a blinding is a
 * function of the vault's address.
 *
 * What is still tested here is what is still a client rule: which note to
 * spend, and how the pool moves after a payment or a deposit.
 */
import { describe, it, expect } from 'vitest';
import {
  noteToSpend, afterPayment, afterDeposit, paymentsFit,
  balanceOf, witnessesOver, type VaultNotes, type Note,
} from './vault-notes.js';
import { changeNonceOf } from './vault-recovery.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';

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

const note = (n: number, value: bigint, token = GBP, index = 0n): Note =>
  ({ nonce: String(n).padStart(2, '0').repeat(32), token, value, index });

const pool = (notes: Note[]): VaultNotes => ({ notes });

describe('V-74: choosing a note to spend', () => {
  it('takes the smallest note that covers it, keeping big notes whole', () => {
    const notes = [note(1, 1_000n), note(2, 300n), note(3, 50n)];
    expect(noteToSpend(notes, GBP, 200n).value).toBe(300n);
    expect(noteToSpend(notes, GBP, 400n).value).toBe(1_000n);
  });

  it('is deterministic on ties, so two operators pick the same note and collide visibly', () => {
    /*
     * B3. Two devices running the same payroll must not both half-succeed. If
     * they pick the same note the chain refuses the second, which is a
     * conflict an operator can see; if they picked differently they would both
     * land and the pool would be wrong in a way nobody notices.
     */
    const notes = [note(9, 500n), note(2, 500n), note(5, 500n)];
    expect(noteToSpend(notes, GBP, 100n).nonce).toBe(noteToSpend([...notes].reverse(), GBP, 100n).nonce);
  });

  it('never spends a note of the wrong token', () => {
    const notes = [note(1, 1_000n, USD), note(2, 400n, GBP)];
    expect(noteToSpend(notes, GBP, 100n).token).toBe(GBP);
    expect(() => noteToSpend(notes, 'cc'.repeat(32), 1n)).toThrow(/holds no notes/i);
  });

  it('REFUSES TO MERGE, and says what the pool actually holds', () => {
    /*
     * A vault with two notes of 60 cannot pay 100. Saying so is the whole
     * point: silently paying 60 would be worse than failing, and merging at
     * payment time is maintenance discovered on a payroll deadline (B12).
     */
    const notes = [note(1, 60n), note(2, 60n)];
    expect(() => noteToSpend(notes, GBP, 100n))
      .toThrow(/no single note covers 100: the largest is 60 and the pool holds 120 across 2/i);
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
    s = afterPayment(s, first.nonce, 250n, changeOf(first, 250n), 7n);
    expect(balanceOf(s, GBP)).toBe(750n);

    const next = noteToSpend(s.notes, GBP, 200n);
    expect(next.value).toBe(750n);
    expect(next.index).toBe(7n);

    s = afterPayment(s, next.nonce, 200n, changeOf(next, 200n, 'f1'.repeat(32)), 8n);
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
    const s = afterPayment(pool([spent]), spent.nonce, 400n, read, 3n);
    expect(s.notes[0].nonce).toBe(read.nonce);
    expect(s.notes[0].nonce).not.toBe(toHex(changeNonceOf(fromHex(spent.nonce))));
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
    expect(s.notes[0].index).toBeUndefined();
  });

  it('DROPS a zero change rather than keeping a note the chain does not have', () => {
    /*
     * The contract emits no change coin when a note is spent exactly. A zero
     * note kept here is a pool that disagrees with the chain, which is the
     * divergence that makes a vault unspendable.
     */
    const spent = note(1, 500n);
    const s = afterPayment(pool([spent]), spent.nonce, 500n, undefined, 3n);
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
});

describe('V-74: the witnesses the contract actually calls', () => {
  it('hand the contract a qualified coin, and record which note was chosen', () => {
    const state = pool([note(1, 1_000n, GBP, 4n)]);
    const pending: { spending?: string } = {};
    const w = witnessesOver(() => state, pending);

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
    const unread = { nonce: '07'.repeat(32), token: GBP, value: 900n } as Note;
    const w = witnessesOver(() => pool([unread]), {});
    expect(() => w.noteToSpend({}, fromHex(GBP), 100n))
      .toThrow(/never been read/);
    expect(() => w.noteToSpend({}, fromHex(GBP), 100n))
      .toThrow(/NOTHING HERE MAY SUBSTITUTE A NUMBER/);
  });

  it('DECLARES ONE WITNESS, because the blinding is no longer the device\'s to choose', () => {
    /*
     * Two more used to be here — `noteBlinding` and `nextBlinding` — and
     * a client that still offered them would be offering the contract
     * something it does not ask for, which is how a rule survives in two
     * places after only one of them was changed.
     */
    const w = witnessesOver(() => pool([note(1, 1n)]), {});
    expect(Object.keys(w)).toEqual(['noteToSpend']);
  });
});

describe('T-38: whether a run fits the pool, one payment at a time', () => {
  it('THE QUESTION A SUM ANSWERS WRONGLY: 120 across two notes cannot pay 100', () => {
    /*
     * `C203`'s mitigation is only worth having if it asks the right question.
     * A pool of 60 + 60 has a balance of 120 and cannot make a payment of 100,
     * because `noteToSpend` does not merge (`V-58`, `B12`) — so an
     * affordability check built on `balance` alone passes a run that stops on
     * its first payee.
     */
    const p = pool([note(1, 60n), note(2, 60n)]);
    expect(() => paymentsFit(p, [{ token: GBP, amount: 100n }]))
      .toThrow(/payment 1 of 1 cannot be made/);
    expect(() => paymentsFit(p, [{ token: GBP, amount: 100n }]))
      .toThrow(/no single note covers 100/);
  });

  it('carries the change forward, so a run of many payments out of one note fits', () => {
    const p = pool([note(1, 1_000n)]);
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
    const p = pool([note(1, 1_000n)]);
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
    const p = pool([note(1, 300n)]);
    /*
     * A zero note carried forward would answer "no single note covers 1: the
     * largest is 0". The note being GONE is what "holds no notes" says, and
     * that is the difference this asserts.
     */
    expect(() => paymentsFit(p, [{ token: GBP, amount: 300n }, { token: GBP, amount: 1n }]))
      .toThrow(/holds no notes/);
  });

  it('keeps tokens apart, so a euro balance never pays a pound', () => {
    const p = pool([note(1, 1_000n, USD)]);
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
    const unread = { nonce: '07'.repeat(32), token: GBP, value: 900n } as Note;
    expect(() => paymentsFit(pool([unread]), [{ token: GBP, amount: 100n }])).not.toThrow();
  });
});
