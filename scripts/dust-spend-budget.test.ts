/**
 * THE DUST-SPEND CEILING, PINNED.
 *
 * Every assertion names the change that turns it red, and each mutation was
 * applied to a COPY of the module outside this repository and watched failing
 * before the assertion was kept.
 *
 * THE FIXTURE IS A MEASUREMENT. The one-output case below is the shape the
 * funding wallet was actually in when this was written: read off the chain, one
 * unspent NIGHT output, registered. It is here because it is the case that
 * fails, and a guard whose failing case is hypothetical is a guard nobody has
 * watched fail.
 */
import { describe, expect, it } from 'vitest';

import {
  budgetFrom, budgetVerdict, escapeClearsRefusal, ESCAPE_ARITHMETIC,
  SPENDS_AN_ORDINARY_DEPOSIT_CARRIES, SPENDS_TO_ESCAPE_A_SIZE_REFUSAL, type HeldUtxo,
} from './dust-spend-budget.js';

const NIGHT = '0'.repeat(64);
const OTHER = '1'.repeat(64);
const held = (type: string, registered: boolean): HeldUtxo =>
  ({ utxo: { type, value: 1n }, meta: { registeredForDustGeneration: registered } });

describe('COUNTING — what can mint a dust spend', () => {
  it('counts NIGHT outputs and, separately, the registered ones', () => {
    // TURNS RED IF: registration stops being counted separately from holding.
    // An unregistered NIGHT output mints no dust and buys no spend, so counting
    // the two together is the error that makes this check pass wrongly.
    const b = budgetFrom([held(NIGHT, true), held(NIGHT, false), held(OTHER, true)], NIGHT, 1);
    expect(b.nightUtxos).toBe(2);
    expect(b.registered).toBe(1);
  });

  it('counts nothing from a wallet that reported nothing', () => {
    // TURNS RED IF: an unreadable coin list starts counting as anything but
    // zero. Guessing high here turns a refusal into a pass.
    expect(budgetFrom(undefined, NIGHT, 2).registered).toBe(0);
    expect(budgetFrom([{}, { utxo: {} }], NIGHT, 2).registered).toBe(0);
  });

  it('treats a missing registration flag as NOT registered', () => {
    // TURNS RED IF: the strict `=== true` is loosened. An absent flag means
    // the wallet did not say, and "did not say" must not read as "yes".
    expect(budgetFrom([{ utxo: { type: NIGHT } }], NIGHT, 1).registered).toBe(0);
  });
});

describe('THE VERDICT — a sentence someone can act on', () => {
  it('REFUSES the consolidated wallet, and names both numbers', () => {
    // TURNS RED IF: the comparison is dropped, or the sentence stops naming the
    // counts. "It will not work" without the numbers is not actionable, and
    // this is the case the funding wallet was actually in.
    const v = budgetVerdict(budgetFrom([held(NIGHT, true)], NIGHT, 2));
    expect(v.ok).toBe(false);
    expect(v.line).toContain('1 spendable NIGHT output');
    expect(v.line).toContain('at most 1 dust spend');
    expect(v.line).toContain('needs 2');
    expect(v.remedy).toContain('splitting the one it has');
  });

  it('REFUSES the measured wallet when asked for the ESCAPE, not for an ordinary deposit', () => {
    /*
     * TURNS RED IF: the escape constant is set back to one, or a caller passes
     * its own number.
     *
     * THIS IS THE ASSERTION THE FIRST VERSION OF THIS WORK NEEDED AND DID NOT
     * HAVE. A check asking for one dust spend passes on every wallet that can
     * pay a fee at all, including the one measured here — so it would print a
     * reassurance immediately before the refusal it was written to explain.
     */
    expect(SPENDS_AN_ORDINARY_DEPOSIT_CARRIES).toBe(1);
    expect(SPENDS_TO_ESCAPE_A_SIZE_REFUSAL).toBe(2);
    const v = budgetVerdict(budgetFrom([held(NIGHT, true)], NIGHT, SPENDS_TO_ESCAPE_A_SIZE_REFUSAL));
    expect(v.ok).toBe(false);
    expect(v.remedy).toContain('splitting the one it has');
  });

  it('passes when the wallet holds enough registered outputs', () => {
    // TURNS RED IF: the check refuses unconditionally, which would make it
    // useless the moment the wallet is split and would read as a false alarm.
    const v = budgetVerdict(budgetFrom([held(NIGHT, true), held(NIGHT, true)], NIGHT, 2));
    expect(v.ok).toBe(true);
    expect(v.remedy).toBeUndefined();
  });

  it('does not let unregistered NIGHT outputs satisfy the precondition', () => {
    // TURNS RED IF: the verdict is keyed on `nightUtxos` instead of
    // `registered`. Holding four outputs that mint no dust buys no spends, and
    // this is the substitution that looks correct and is not.
    const v = budgetVerdict(budgetFrom([held(NIGHT, false), held(NIGHT, false)], NIGHT, 2));
    expect(v.ok).toBe(false);
    expect(v.line).toContain('2 spendable NIGHT output');
    expect(v.line).toContain('at most 0 dust spend');
  });

  it('says "output" and "spend" in the singular when there is one', () => {
    // TURNS RED IF: the pluralisation is dropped. This sentence is read by
    // someone deciding whether to act on it, and "1 outputs" reads as generated
    // noise rather than a measurement.
    const v = budgetVerdict(budgetFrom([held(NIGHT, true)], NIGHT, 1));
    expect(v.line).toContain('1 spendable NIGHT output,');
    expect(v.line).toContain('at most 1 dust spend in one transaction');
  });
});

describe('THE ESCAPE ARITHMETIC — derived, so it moves when the inputs do', () => {
  it('no extra spend clears the refusal, and one does', () => {
    /*
     * TURNS RED IF: any of the four measured inputs is edited, or the
     * comparison loses the knee.
     *
     * This is the whole argument for the constant being two, written as
     * arithmetic instead of as a sentence. Below the knee the allowance is flat
     * at 15 ms and the transaction already costs 15.038, so adding nothing
     * cannot help. One extra spend takes it to 10,090 bytes, an allowance of
     * 20.18 ms, against a cost of 17.69 ms.
     */
    expect(escapeClearsRefusal(0)).toBe(false);
    expect(escapeClearsRefusal(1)).toBe(true);
    expect(SPENDS_TO_ESCAPE_A_SIZE_REFUSAL).toBe(2);
  });

  it('needs MORE spends when a spend costs more, rather than staying at two', () => {
    // TURNS RED IF: the constant stops being derived. A hand-typed 2 survives a
    // change in the ledger's arithmetic; this does not.
    const dearer = { ...ESCAPE_ARITHMETIC, costMsPerExtraSpend: 12 };
    expect(escapeClearsRefusal(1, dearer)).toBe(false);
  });

  it('uses the FLAT allowance below the knee, not the per-byte one', () => {
    /*
     * TURNS RED IF: the flat minimum is dropped from the comparison.
     *
     * The first version of this test could not catch that: it chose a case that
     * comes out false either way, so removing `Math.max` left it green. This
     * one is a case that is only clearable BECAUSE of the flat minimum — a
     * small, cheap transaction whose per-byte allowance alone would be 2 ms.
     */
    const small = {
      ...ESCAPE_ARITHMETIC, refusedSizeBytes: 1_000, refusedCostMs: 14,
      bytesPerExtraSpend: 0, costMsPerExtraSpend: 0.5,
    };
    expect(0.002 * 1_000).toBeLessThan(14.5);   // the per-byte allowance alone would refuse
    expect(escapeClearsRefusal(1, small)).toBe(true);
  });

  it('pins the four measured inputs through the size and cost they produce', () => {
    /*
     * TURNS RED IF: any of the four numbers read off S122's measurement and the
     * node's own refusal is edited.
     *
     * Asserting only the boolean was not enough: a spend that got CHEAPER still
     * clears the refusal, so the verdict survived an edited input and the
     * mutation run caught that. These are the intermediate quantities the
     * verdict is computed from, so an edit moves one of them.
     */
    const a = ESCAPE_ARITHMETIC;
    const size = a.refusedSizeBytes + a.bytesPerExtraSpend;
    const cost = a.refusedCostMs + a.costMsPerExtraSpend;
    expect(size).toBe(10_090);
    expect(Number(cost.toFixed(3))).toBe(17.690);
    expect(Number((a.allowanceMsPerByte * size).toFixed(2))).toBe(20.18);
    // and the margin is wide, not marginal
    expect(a.allowanceMsPerByte * size - cost).toBeGreaterThan(2);
  });
});
