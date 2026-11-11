import { describe, expect, it } from 'vitest';
import { approversHere, seatsWithNoRightsRead } from './approvers-here.js';
import { approversOf } from '../../../../src/core/vault-approvers.js';
import { invitedSeatRightsOf, scopeOfRole } from '../../../../src/core/seat-rights.js';
import { EVERY_RIGHT, type SeatRights } from '../../../../src/core/vault-approvers.js';
import type { Hex } from '../../../../src/core/crypto.js';

const PAYROLL = 'aa'.repeat(32) as Hex;
const TREASURY = 'bb'.repeat(32) as Hex;
const WIDE = 'cc'.repeat(32);
const SEATS = ['e1', 'e2', 'e3'];

/** A wallet's reach into a company of three seats on the chain, its directory believing each with `rights`. */
const reachWith = (rights: ReadonlyArray<SeatRights | undefined>) => ({
  accountId: 'acc_1', label: 'co_1', account: 'ac'.repeat(32), companyKeys: {},
  roster: async () => ({ notBelieved: [], signers: SEATS.map((leaf, i) => ({ id: `s${i}`, status: 'active', leafCommitment: leaf })) }),
  holders: async () => ({ seats: SEATS, approvals: 1, vaultThresholds: [], adoptedVaults: [PAYROLL, TREASURY] }),
  builder: { companyWide: async () => WIDE },
  judges: {
    directoryHereFor: () => async () => ({
      dir: { seats: SEATS.flatMap((seat, i) => (rights[i] === undefined ? [] : [{ seat, retired: null, rights: rights[i] }])) },
    }),
  },
}) as never;

describe('who may approve each vault is counted from each seat\'s own rights', () => {
  it('a seat scoped to one vault is counted on that vault only, and an initiator on none', async () => {
    /* RED WHEN: a seat's count is not read from its directory entry's rights, or a seat with none is counted on every vault. */
    const onPayroll = invitedSeatRightsOf({ role: 'approver', vaults: [PAYROLL] }, scopeOfRole('approver', [PAYROLL]));
    const initiator = invitedSeatRightsOf({ role: 'initiator' }, scopeOfRole('initiator'));
    const roster = await approversHere(reachWith([EVERY_RIGHT, onPayroll, initiator]));
    expect(approversOf(roster, PAYROLL)).toBe(2);
    expect(approversOf(roster, TREASURY)).toBe(1);
    expect(approversOf(roster, WIDE as Hex)).toBe(1);
  });

  it('a seat the chain holds with no entry in the directory is counted on no vault and named, and nothing stops', async () => {
    /* RED WHEN: a seat whose rights this wallet cannot read stops the count, or is counted as holding every right. */
    const roster = await approversHere(reachWith([EVERY_RIGHT, EVERY_RIGHT, undefined]));
    expect(roster.seats.get('e3')).toEqual({ every: false, mayApprove: false, everyVault: false, onVaults: [] });
    expect(approversOf(roster, PAYROLL)).toBe(2);
    /* RED WHEN: the seat counted on no vault is not the one named to the person. */
    expect(await seatsWithNoRightsRead(reachWith([EVERY_RIGHT, EVERY_RIGHT, undefined]))).toEqual(['e3']);
    expect(await seatsWithNoRightsRead(reachWith([EVERY_RIGHT, EVERY_RIGHT, EVERY_RIGHT]))).toEqual([]);
  });
});
