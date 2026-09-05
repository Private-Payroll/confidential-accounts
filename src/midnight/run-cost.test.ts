import { describe, it, expect } from 'vitest';
import { circuitsForRun, circuitsForRetry, describeRunCost } from './run-cost.js';

describe('V-73: what a payroll run costs in transactions', () => {
  it('THE POINT: the count scales with the payroll, so no constant can be right', () => {
    /*
     * `run-preview.ts` budgeted 11 for a run that submitted 14 and would have
     * died on the twelfth call — the exact failure the gate exists to prevent.
     * A payroll run makes that inevitable rather than unlucky.
     */
    expect(circuitsForRun({ payees: 5, threshold: 3 }).total).toBe(10);
    expect(circuitsForRun({ payees: 200, threshold: 3 }).total).toBe(205);
  });

  it('itemises, so a wrong total is visible rather than merely wrong', () => {
    const cost = circuitsForRun({ payees: 50, threshold: 2 });
    expect(cost.items).toEqual([
      { what: 'proposeRun', calls: 1 },
      { what: 'approvals', calls: 2 },
      { what: 'payments', calls: 50 },
      { what: 'closeExpiredRun', calls: 1 },
    ]);
    expect(describeRunCost(cost)).toBe(
      '54 transactions — 1 proposeRun, 2 approvals, 50 payments, 1 closeExpiredRun');
  });

  it('budgets retries when asked, because 99 of 100 paid is a failed payroll', () => {
    expect(circuitsForRun({ payees: 100, threshold: 3, retries: 5 }).total).toBe(110);
  });

  it('A RETRY IS A WHOLE SECOND RUN, not just the stragglers', () => {
    // Ten missed people on a three-of-five account is fourteen calls, not ten:
    // a retry needs its own proposal and its own full approval round.
    expect(circuitsForRetry(10, 3).total).toBe(15);
  });

  it('refuses nonsense rather than budgeting for it', () => {
    expect(() => circuitsForRun({ payees: 0, threshold: 2 })).toThrow(/at least one person/i);
    expect(() => circuitsForRun({ payees: 5, threshold: 0 })).toThrow(/at least one/i);
    expect(() => circuitsForRun({ payees: 5, threshold: 2, retries: -1 })).toThrow(/negative/i);
  });
});
