/**
 * THE FEE FLOOR'S RULES, PINNED WHERE A TEST CAN REACH THEM.
 *
 * The wallet install behind these rules is a door nobody runs by hand, so the
 * rules were moved into their own module and are pinned here instead. Each
 * assertion below names the change that turns it red, and each of those
 * mutations was applied to a COPY of the module outside this repository and
 * watched failing before the assertion was kept.
 *
 * WHAT THIS CANNOT PIN: that the wallet library keeps reading the overhead out
 * of the configuration it is handed. That is measured against the library
 * itself, not asserted here, and it is why the door takes a BEHAVIOURAL reading
 * as well as a structural one.
 */
import { describe, expect, it } from 'vitest';

import {
  appliedOverhead,
  arrivedOverhead,
  feeFloorVerdict,
  floorKnownAbsent,
} from './dust-fee-floor.js';

describe('THE VERDICT — what makes a floor in force, and what stops a run', () => {
  it('passes when all three numbers agree, and says the number the wallet carries', () => {
    // TURNS RED IF: the verdict stops requiring agreement, or reports `passed`
    // instead of `arrived` — which is the defect this whole module exists for.
    const v = feeFloorVerdict({ passed: 1_000_000n, arrived: 1_000_000n, applied: 1_000_000n });
    expect(v.ok).toBe(true);
    expect(v.line).toContain('1000000');
    expect(v.line).toContain('read back off the wallet that will pay');
  });

  it('REFUSES when the wallet carries a different floor from the one asked for', () => {
    // TURNS RED IF: the arrived/passed comparison is dropped or weakened to a
    // truthiness check. This is the case where the swap silently did not take
    // and the library's own default — nothing — is what would be paid.
    const v = feeFloorVerdict({ passed: 1_000_000n, arrived: 0n, applied: 0n });
    expect(v.ok).toBe(false);
    expect(v.line).toContain('asked for 1000000');
    expect(v.line).toContain('carries 0');
  });

  it('REFUSES when the floor cannot be read back at all', () => {
    // TURNS RED IF: an unreadable floor is allowed to pass as though it agreed.
    // Silence is the one answer that must never count as agreement here.
    const v = feeFloorVerdict({ passed: 1_000_000n, arrived: null, applied: null, problem: 'no cost parameters' });
    expect(v.ok).toBe(false);
    expect(v.line).toContain('could not be read back');
    expect(v.line).toContain('no cost parameters');
  });

  it('REFUSES when the floor is stored but the arithmetic does not add it', () => {
    // TURNS RED IF: the applied reading is dropped, or compared to `passed`
    // rather than to `arrived`. A number that is configured but never spent is
    // exactly the failure a structural read alone cannot see.
    const v = feeFloorVerdict({ passed: 1_000_000n, arrived: 1_000_000n, applied: 0n });
    expect(v.ok).toBe(false);
    expect(v.line).toContain('stored but not spent');
  });

  it('REFUSES a floor of zero even when all three numbers agree', () => {
    // TURNS RED IF: the positive check is dropped. The floor is overridable
    // from the environment and "0" is a string that reads as present and
    // converts to nothing, so all three readings agree at zero and every other
    // check here passes — while the wallet has exactly the defect the floor
    // exists to prevent. Agreement at zero must not be agreement.
    const v = feeFloorVerdict({ passed: 0n, arrived: 0n, applied: 0n });
    expect(v.ok).toBe(false);
    expect(v.line).toContain('is not a floor');
  });

  it('REFUSES a negative floor rather than treating it as merely unusual', () => {
    // TURNS RED IF: the check is written as `=== 0n` instead of `<= 0n`.
    expect(feeFloorVerdict({ passed: -1n, arrived: -1n, applied: -1n }).ok).toBe(false);
  });

  it('passes with the applied reading missing, and SAYS it is missing', () => {
    // TURNS RED IF: a missing behavioural reading starts being reported as
    // though it had been taken. The weaker check is allowed; pretending it was
    // the stronger one is not.
    const v = feeFloorVerdict({ passed: 7n, arrived: 7n, applied: null });
    expect(v.ok).toBe(true);
    expect(v.line).toContain('not measured here');
  });
});

describe('ARRIVED — read off the object that will be charged', () => {
  const walletCarrying = (v: unknown) =>
    Object.create({ constructor: { configuration: { costParameters: { additionalFeeOverhead: v } } } });

  it('reads the overhead off the installed wallet, not off any constant', () => {
    // TURNS RED IF: the read is re-pointed at the module's own constant.
    expect(arrivedOverhead(walletCarrying(1_000_000n)).value).toBe(1_000_000n);
    expect(arrivedOverhead(walletCarrying(0n)).value).toBe(0n);
  });

  it('answers null, with a reason, when there is no wallet or no configuration', () => {
    // TURNS RED IF: a missing wallet starts reading as zero, which would make
    // "no wallet installed" indistinguishable from "installed with no floor".
    expect(arrivedOverhead(undefined).value).toBeNull();
    expect(arrivedOverhead({}).value).toBeNull();
    expect(arrivedOverhead({}).problem).toContain('no cost parameters');
  });

  it('refuses a non-bigint rather than coercing it', () => {
    // TURNS RED IF: the type check is dropped. A string "0" from a serialised
    // configuration would otherwise compare unequal to 0n and read as a
    // disagreement, or worse, coerce and hide one.
    const r = arrivedOverhead(walletCarrying('1000000'));
    expect(r.value).toBeNull();
    expect(r.problem).toContain('not a bigint');
  });
});

describe('APPLIED — the overhead the arithmetic actually adds', () => {
  const deps = (fee: bigint, bare: bigint) => ({
    makeTransacting: () => ({ calculateFee: () => fee }),
    newTransaction: () => ({ feesWithMargin: () => bare }),
    params: () => ({}),
  });

  it('is the difference between the fee and the fee without the floor', () => {
    // TURNS RED IF: the subtraction is dropped and the configured value is
    // reported instead. That would rebuild the defect this module removes.
    expect(appliedOverhead({ feeBlocksMargin: 5 }, deps(1_831_100_897_546n, 1_831_099_897_546n)).value)
      .toBe(1_000_000n);
  });

  it('reads zero when the arithmetic adds nothing', () => {
    // TURNS RED IF: a zero difference is treated as a failed measurement. Zero
    // is the answer that must be reportable, because it is the bad one.
    expect(appliedOverhead({ feeBlocksMargin: 5 }, deps(500n, 500n)).value).toBe(0n);
  });

  it('answers null, with a reason, rather than throwing into the caller', () => {
    // TURNS RED IF: the guard is removed. This runs inside wallet set-up, where
    // a throw would be reported as a wallet failure rather than as a
    // measurement that could not be taken.
    const r = appliedOverhead({ feeBlocksMargin: 5 }, {
      makeTransacting: () => { throw new Error('the library moved'); },
      newTransaction: () => ({ feesWithMargin: () => 0n }),
      params: () => ({}),
    });
    expect(r.value).toBeNull();
    expect(r.problem).toContain('the library moved');
  });
});

describe('KNOWN ABSENT vs MERELY UNVERIFIED — what decides whether a door stops', () => {
  it('calls the three known-bad reasons known-bad', () => {
    // TURNS RED IF: any of them is dropped from the set. Each is a floor that
    // is wrong rather than unread, and no re-run clears one.
    expect(floorKnownAbsent('not-a-floor')).toBe(true);
    expect(floorKnownAbsent('disagrees')).toBe(true);
    expect(floorKnownAbsent('not-applied')).toBe(true);
  });

  it('does NOT call an unreadable floor known-bad', () => {
    /*
     * TURNS RED IF: 'unreadable' is folded in with the others.
     *
     * This is the single most consequential line in the module. Stopping on the
     * unknown case would stop every money door in this project, the payout door
     * included, whenever a library renames a field — in exchange for preventing
     * a failure that is already free and loud.
     */
    expect(floorKnownAbsent('unreadable')).toBe(false);
  });

  it('does not call a passing verdict absent', () => {
    // TURNS RED IF: the predicate is inverted, which would stop every run.
    expect(floorKnownAbsent('ok')).toBe(false);
  });

  it('gives each refusal its own reason, so no caller has to guess', () => {
    /*
     * TURNS RED IF: two refusals collapse onto one reason.
     *
     * The caller switches on this instead of re-reading the numbers. The first
     * version of that gate re-derived the case from `arrived !== null`, and a
     * floor of ZERO on a wallet whose parameters could not be read back came
     * out as "not known bad" — the exact state the zero check was added for.
     */
    expect(feeFloorVerdict({ passed: 0n, arrived: null, applied: null }).reason).toBe('not-a-floor');
    expect(feeFloorVerdict({ passed: 1n, arrived: null, applied: null }).reason).toBe('unreadable');
    expect(feeFloorVerdict({ passed: 1n, arrived: 2n, applied: null }).reason).toBe('disagrees');
    expect(feeFloorVerdict({ passed: 1n, arrived: 1n, applied: 0n }).reason).toBe('not-applied');
    expect(feeFloorVerdict({ passed: 1n, arrived: 1n, applied: 1n }).reason).toBe('ok');
  });
});
