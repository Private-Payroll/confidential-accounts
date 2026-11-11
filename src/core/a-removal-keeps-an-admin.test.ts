import { describe, expect, it } from 'vitest';
import type { Role } from './roles.js';
import { noAdminLeftRefusal } from './vault-approvers.js';
import { approversFrom } from '../../packages/web-shared/src/approvers-read.js';

/*
 * A removal that would leave no seat that may file the company's list of signers is refused on the raising device:
 * only such a seat - an admin, or the founding seat - admits a new signer, so nobody could seat another admin again.
 */
const seat = (seat: string, role: Role | null, retired: Readonly<Record<string, number>> | null = null) => ({ seat, role, retired });

describe('A REMOVAL ALWAYS LEAVES THE COMPANY A SEAT THAT MAY ADMIT A NEW SIGNER', () => {
  it('a removal leaving another admin, or the founding seat, is let through', () => {
    /* RED WHEN: a removal is refused while another admin stays seated. */
    expect(noAdminLeftRefusal([seat('aa', 'admin'), seat('bb', 'admin'), seat('cc', 'approver')], ['aa', 'bb', 'cc'], 'aa')).toBeNull();
    /* RED WHEN: the founding seat, which holds no role and files every record, is not counted as one that may admit. */
    expect(noAdminLeftRefusal([seat('aa', null), seat('bb', 'admin')], ['aa', 'bb'], 'bb')).toBeNull();
  });

  it('REFUSES a removal leaving only approvers and initiators, and names inviting another admin first', () => {
    /* RED WHEN: the last admin is removed while only seats that may not admit a new signer stay. */
    const refused = noAdminLeftRefusal([seat('aa', 'admin'), seat('bb', 'approver'), seat('cc', 'initiator')], ['aa', 'bb', 'cc'], 'AA');
    expect(refused).toMatch(/nobody left is an admin in the company's records/u);
    expect(refused).toMatch(/Invite another admin first/u);
  });

  it('counts no seat the chain no longer holds or the roster has not admitted, no retired seat and no seat the company\'s records do not believe', () => {
    /* RED WHEN: an admin the chain has already removed counts as staying. */
    expect(noAdminLeftRefusal([seat('aa', 'admin'), seat('bb', 'admin'), seat('cc', 'approver')], ['aa', 'cc'], 'aa')).not.toBeNull();
    /* RED WHEN: an admin whose retirement is believed counts as staying. */
    expect(noAdminLeftRefusal([seat('aa', 'admin'), seat('bb', 'admin', {}), seat('cc', 'approver')], ['aa', 'bb', 'cc'], 'aa')).not.toBeNull();
    /* RED WHEN: a chain seat with no believed entry counts as an admin: only the directory's believed seats carry a role. */
    expect(noAdminLeftRefusal([seat('aa', 'admin')], ['aa', 'dd'], 'aa')).not.toBeNull();
  });

  it('counts no admin the roster has not admitted: only an admitted admin admits anybody', () => {
    const seats = [seat('aa', 'admin'), seat('bb', 'admin'), seat('cc', 'approver')];
    /* The seats a removing device counts, as it counts them: the roster's admitted signers that the chain holds. */
    const admittedOf = (bb: string) => [...approversFrom({
      account: { signers: [{ status: 'active', leafCommitment: 'aa' }, { status: bb, leafCommitment: 'bb' }, { status: 'active', leafCommitment: 'cc' }] },
      held: { seats: ['aa', 'bb', 'cc'], approvals: 1, vaultThresholds: [], adoptedVaults: [] }, companyWide: 'ff', rights: new Map(),
    }).seats.keys()];
    /* RED WHEN: an admin whose seat the chain holds but whom the roster has not admitted counts as staying. */
    expect(noAdminLeftRefusal(seats, admittedOf('pending'), 'aa')).toMatch(/nobody left is an admin in the company's records/u);
    /* RED WHEN: the same admin, once the roster admits them, is not counted. */
    expect(noAdminLeftRefusal(seats, admittedOf('active'), 'aa')).toBeNull();
  });
});
