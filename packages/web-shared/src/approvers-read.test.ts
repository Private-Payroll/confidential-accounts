import { describe, expect, it } from 'vitest';
import { activeSeatsOnTheChain, approversFrom, rightsBelievedIn, seatAndThreshold, unnamedSeatsRefusal } from './approvers-read.js';
import { approversOf, EVERY_RIGHT, seatThresholdRefusal } from '../../../src/core/vault-approvers.js';
import { invitedSeatRightsOf, scopeOfRole } from '../../../src/core/seat-rights.js';
import type { Hex } from '../../../src/core/crypto.js';

const PAYROLL = 'aa'.repeat(32) as Hex;
const TREASURY = 'bb'.repeat(32) as Hex;
const WIDE = 'cc'.repeat(32);
const SEATS = ['e1', 'e2', 'e3'];
const signers = SEATS.map((leaf, i) => ({ id: `s${i}`, status: 'active', leafCommitment: leaf }));
const held = { seats: SEATS, approvals: 1, vaultThresholds: [], adoptedVaults: [PAYROLL, TREASURY] };
const onPayroll = invitedSeatRightsOf({ role: 'approver', vaults: [PAYROLL] }, scopeOfRole('approver', [PAYROLL]));

describe('the count of who approves each vault is made from reads, on the page and in the wallet alike', () => {
  it('each seat is counted on the vaults its directory entry names, and a seat with no entry on none', () => {
    /* RED WHEN: a seat's count is not read from its directory entry's rights, or a seat with no entry is counted on every vault. */
    const rights = rightsBelievedIn([{ seat: 'E1', retired: null, rights: EVERY_RIGHT }, { seat: 'e2', retired: null, rights: onPayroll }]);
    const roster = approversFrom({ account: { signers }, held, companyWide: WIDE, rights });
    expect(approversOf(roster, PAYROLL)).toBe(2);
    expect(approversOf(roster, TREASURY)).toBe(1);
    expect(roster.seats.get('e3')).toEqual({ every: false, mayApprove: false, everyVault: false, onVaults: [] });
  });

  it('a retired entry, or one with no rights, gives its seat no rights', () => {
    /* RED WHEN: a retired seat's rights, or an entry that carries none, are counted. */
    const rights = rightsBelievedIn([{ seat: 'e1', retired: 4, rights: EVERY_RIGHT }, { seat: 'e2', retired: null }]);
    expect(rights.size).toBe(0);
  });

  it('only active seats the chain holds are counted', () => {
    /* RED WHEN: a pending signer, or one the chain no longer holds, is counted as seated. */
    const mixed = [{ status: 'pending', leafCommitment: 'e1' }, { status: 'active', leafCommitment: 'E2' }, { status: 'active', leafCommitment: 'e9' }, { status: 'active', leafCommitment: null }];
    expect(activeSeatsOnTheChain(mixed, ['e1', 'e2'])).toEqual(['E2']);
  });

  it('a seat the roster names no one for stops the count and says why', () => {
    /* RED WHEN: a count that leaves out a seat the chain holds is let stand. */
    expect(unnamedSeatsRefusal({ notBelieved: [] })).toBeNull();
    expect(unnamedSeatsRefusal({ notBelieved: ['x'] })).toMatch(/names no signer for 1 seat the company's account holds/u);
    expect(unnamedSeatsRefusal({ notBelieved: ['x', 'y'] })).toMatch(/names no signer for 2 seats the/u);
  });

  it('removals since an open run are counted on every vault the account holds, naming the run', () => {
    /* RED WHEN: the signers removed since a run was raised are not counted against every vault. */
    const rights = rightsBelievedIn(SEATS.map((seat) => ({ seat, retired: null, rights: EVERY_RIGHT })));
    const roster = approversFrom({ account: { signers }, held, companyWide: WIDE, rights, outrun: { removals: 1, run: 'run-1' } });
    expect(roster.removals).toBe(1);
    expect(roster.outrunBy).toBe('run-1');
    expect([...(roster.openRuns ?? [])].sort()).toEqual([PAYROLL, TREASURY, WIDE].sort());
    /* RED WHEN: an open run with no removal is counted for anything but a removal. */
    const open = { removals: 0, run: null, open: 'run-2' };
    expect(approversFrom({ account: { signers }, held, companyWide: WIDE, rights, outrun: open }).openRuns).toBeUndefined();
    expect(approversFrom({ account: { signers }, held, companyWide: WIDE, rights, outrun: open, removal: true }).openRun).toBe('run-2');
  });

  it('a seat invited with a threshold is checked as the change the wallet checks: its rights and the approvals then needed', () => {
    /* RED WHEN: the invited seat's rights or the approvals asked for are not the ones the threshold check counts. */
    expect(seatAndThreshold(onPayroll, 3)).toEqual({ kind: 'seatAndThreshold', rights: onPayroll, threshold: 3 });
    const rights = rightsBelievedIn(SEATS.map((seat) => ({ seat, retired: null, rights: EVERY_RIGHT })));
    const roster = approversFrom({ account: { signers }, held, companyWide: WIDE, rights });
    expect(seatThresholdRefusal(roster, { seats: SEATS.length }, seatAndThreshold(EVERY_RIGHT, 5))).toMatch(/cannot need 5 approvals/u);
    expect(seatThresholdRefusal(roster, { seats: SEATS.length }, seatAndThreshold(EVERY_RIGHT, 4))).toBeNull();
  });
});
