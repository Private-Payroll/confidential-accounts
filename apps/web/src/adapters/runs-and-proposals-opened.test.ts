import { describe, expect, it } from 'vitest';
import { sealRecord, type Purpose } from '../../../../src/core/sealed-records.js';
import type { SealedProposal, SealedRun } from '../../../../src/core/types.js';
import { purposeKeysAt, type PurposeWrapsHeld } from 'vaults-web-shared/purpose-wraps.js';
import { openProposal, openRun } from './runs-and-proposals-opened.js';

/*
 * A RUN AND A PROPOSAL ARE OPENED WITH THE PURPOSE KEYS A READER WAS RELEASED, and with nothing a company key would
 * add: the key of the record's own purpose and of the epoch it was sealed at, or the record does not open.
 */
const KEY = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const held = (byEpoch: Record<number, Partial<Record<Purpose, string>>>): PurposeWrapsHeld => Object.freeze({
  kind: 'purpose-wraps' as const, accountId: 'c1',
  byEpoch: new Map(Object.entries(byEpoch).map(([e, keys]) => [Number(e), new Map(Object.entries(keys) as [Purpose, string][])])),
  unopened: [],
}) as PurposeWrapsHeld;
const WRAPPED = held({ 1: { payroll: KEY(1), proposals: KEY(2) } });

const run = (keyEpoch: number): SealedRun => ({
  id: 'r1', accountId: 'c1', period: '2026-10', status: 'draft', payslips: [], keyEpoch,
  sealed: sealRecord('payroll', 'c1', { employees: [{ id: 'e1', name: 'Ana', asset: 'a', amount: 5n }], totals: {}, proposalIds: { a: 'p1' } }, purposeKeysAt(WRAPPED, 1)),
} as unknown as SealedRun);
const proposal = (keyEpoch: number): SealedProposal => ({
  id: 'p1', accountId: 'c1', status: 'open', createdAt: '2026-09-20T10:00:00.000Z', digest: 'dd', chainId: 'cc', approvalCount: 1, keyEpoch,
  sealed: sealRecord('proposals', 'c1', { kind: 'payroll', summary: 'Pay October', proposedBy: 's1', approvals: [] }, purposeKeysAt(WRAPPED, 1)),
} as unknown as SealedProposal);

describe('A RUN AND A PROPOSAL OPENED WITH A READER\'S PURPOSE KEYS', () => {
  it('OPEN WITH THE KEY OF THEIR PURPOSE AT THE EPOCH THEY WERE SEALED', () => {
    /* RED WHEN: a run does not open with the payroll key a reader was released. */
    expect(openRun(run(1), WRAPPED).employees?.[0]?.name).toBe('Ana');
    /* RED WHEN: a proposal does not open with the proposals key a reader was released. */
    expect(openProposal(proposal(1), WRAPPED).summary).toBe('Pay October');
  });

  it('DO NOT OPEN AT AN EPOCH THE GRANT NEVER WRAPPED, OR FOR A PURPOSE IT DOES NOT NAME', () => {
    /* RED WHEN: a run sealed at an epoch the grant never wrapped opens with another epoch's key. */
    expect(() => openRun(run(2), WRAPPED)).toThrow();
    expect(() => openProposal(proposal(2), WRAPPED)).toThrow();
    /* RED WHEN: a run opens for a reader whose grant names the proposals and not the payroll. */
    expect(() => openRun(run(1), held({ 1: { proposals: KEY(2) } }))).toThrow();
    expect(() => openProposal(proposal(1), held({ 1: { payroll: KEY(1) } }))).toThrow();
  });
});
