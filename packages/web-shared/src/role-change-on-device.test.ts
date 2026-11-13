import { describe, expect, it } from 'vitest';
import { newSigningKeypair, sign } from '../../../src/core/crypto.js';
import { directoryChangeMessage, type DirectoryChange } from '../../../src/midnight/seat-directory.js';
import { withRoleChangeDone, withRoleChangeKept } from './keyring-blob.js';
import {
  addressTieOf, keptRoleChangeRefusal, retiredInTheDirectory, roleAskedRefusal, roleChangeStageOf,
} from './role-change-on-device.js';

/*
 * A signer's role changes by the seat's removal and an invitation by address at the new role. What the device
 * decides from the company's directory and the chain: which of the two is next, whether the role asked is one a seat
 * can be given, and whether the address given is the one the seat was invited at.
 */
const LEAF = 'a4'.repeat(32);
const OTHER = 'a1'.repeat(32);
const LINK = '7e'.repeat(32);

describe('A ROLE CHANGE GOES ON TO ITS NEXT STEP AS THE CHAIN AND THE DIRECTORY SAY', () => {
  it('a seat the chain holds is removed first; once retired and still held, the removal is under way; once off the chain, the person is invited', () => {
    /* RED WHEN: an invitation at the new role is raised while the chain still holds the seat, so the person would hold two seats. */
    expect(roleChangeStageOf([{ seat: LEAF, retired: null }], [OTHER, LEAF.toUpperCase()], LEAF)).toBe('remove');
    /* RED WHEN: a second removal is raised for a seat whose removal is already under way. */
    expect(roleChangeStageOf([{ seat: LEAF, retired: {} }], [OTHER, LEAF], LEAF)).toBe('removal-under-way');
    /* RED WHEN: a seat the chain no longer holds is removed again instead of the person being invited at the new role. */
    expect(roleChangeStageOf([{ seat: LEAF, retired: {} }], [OTHER], LEAF)).toBe('invite');
    expect(roleChangeStageOf([], [OTHER], LEAF)).toBe('invite');
  });
});

describe('THE ROLE ASKED IS ONE A SIGNER\'S SEAT CAN BE GIVEN', () => {
  it('a signer role other than the seat\'s own is let through', () => {
    expect(roleAskedRefusal('approver', 'admin')).toBeNull();
    expect(roleAskedRefusal('initiator', null)).toBeNull();
  });

  it('REFUSES a reader role, naming the removal that comes first and where read access is given, and a role no seat can hold', () => {
    /* RED WHEN: a signer's seat is changed into a reader's, which holds no seat on the chain, or the person is sent to a screen that does not exist. */
    expect(roleAskedRefusal('accountant', 'admin')).toMatch(/hold no seat.*remove them first with Remove\. Read access is given on the Roles tab in Settings$/u);
    expect(roleAskedRefusal('limited', 'admin')).not.toMatch(/\ba (?:accountant|limited)\b/u);
    expect(roleAskedRefusal('owner', 'admin')).toMatch(/not one a seat of a company can hold/u);
  });

  it('with no seat to compare, once the seat is removed, any signer role is let through, admin included', () => {
    /* RED WHEN: a promotion to admin is refused at its invitation because the removed seat reads as holding an admin's role. */
    expect(roleAskedRefusal('admin', undefined)).toBeNull();
  });

  it('REFUSES the role the seat already holds, the founding seat holding an admin\'s', () => {
    /* RED WHEN: a seat is removed and invited again at the role it already holds. */
    expect(roleAskedRefusal('approver', 'approver')).toMatch(/already holds the role approver/u);
    expect(roleAskedRefusal('admin', null)).toMatch(/already holds the role admin/u);
  });
});

describe('THE ADDRESS GIVEN IS THE ONE THE SEAT WAS INVITED AT, WHERE THE COMPANY\'S LIST OF SIGNERS RECORDS ONE', () => {
  it('an address whose coin key the list records for the seat is tied to it; one the list records none for is not, and said so', () => {
    expect(addressTieOf('ABCD', 'abcd')).toBe('tied');
    expect(addressTieOf(undefined, 'abcd')).toBe('untied');
  });

  it('REFUSES an address whose coin key is not the one the list records for the seat', () => {
    /* RED WHEN: another person's address is invited at the new role in place of the one removed. */
    expect(addressTieOf('abcd', 'ef01')).toMatch(/not the one this seat was invited at.*Give the address of the wallet that holds the seat/u);
  });
});

describe('THE INVITATION AFTER THE REMOVAL IS HELD TO WHAT THE REMOVAL WAS RAISED FOR', () => {
  const kept = withRoleChangeKept({ accounts: {} }, 'acc_1', LEAF.toUpperCase(), 'ABCD', 'approver', LINK.toUpperCase());
  it('the address and role confirmed at the removal are let through', () => {
    expect(keptRoleChangeRefusal(kept, 'acc_1', LEAF, 'abcd', 'approver')).toBeNull();
  });
  it('REFUSES another address or role, and a role change these saved keys did not start', () => {
    /* RED WHEN: the second press invites another person, or at another role, than the removal was raised for. */
    expect(keptRoleChangeRefusal(kept, 'acc_1', LEAF, 'ef01', 'approver')).toBe('not-as-started');
    expect(keptRoleChangeRefusal(kept, 'acc_1', LEAF, 'abcd', 'admin')).toBe('not-as-started');
    /* RED WHEN: a wallet that confirmed nothing for the seat invites at the second press on the page's word alone. */
    expect(keptRoleChangeRefusal(kept, 'acc_2', LEAF, 'abcd', 'approver')).toBe('not-started-here');
    expect(keptRoleChangeRefusal({ accounts: {} }, 'acc_1', LEAF, 'abcd', 'approver')).toBe('not-started-here');
  });
  it('raising the same seat\'s removal again replaces what was kept, and once the invitation is filed what was kept is taken out', () => {
    const again = withRoleChangeKept(kept, 'acc_1', LEAF, 'ef01', 'initiator', LINK);
    /* RED WHEN: a second raise of the same seat's removal keeps a second entry, so the saved keys grow with every press. */
    expect(Object.keys(again.roleChangesKept ?? {})).toHaveLength(1);
    expect(keptRoleChangeRefusal(again, 'acc_1', LEAF, 'ef01', 'initiator')).toBeNull();
    const done = withRoleChangeDone(again, 'acc_1', LEAF.toUpperCase());
    /* RED WHEN: a role change carried to its invitation stays kept for the life of the saved keys. */
    expect(done.roleChangesKept).toEqual({});
    expect(keptRoleChangeRefusal(done, 'acc_1', LEAF, 'ef01', 'initiator')).toBe('not-started-here');
    expect(withRoleChangeDone({ accounts: {} }, 'acc_1', LEAF)).toEqual({ accounts: {} });
  });
});

describe('A SEAT IS SET ASIDE ONLY WHEN THE COMPANY\'S DIRECTORY ALSO HOLDS ITS RETIREMENT', () => {
  const named = newSigningKeypair();
  const claim = { company: 'acc_1', version: 1, change: { kind: 'claim', entry: { statement: { signingKey: named.publicKey } } } };
  const second = newSigningKeypair();
  const claimed = { company: 'acc_1', version: 1, change: { kind: 'claim', entry: { statement: { signingKey: second.publicKey } } } };
  const retirementBy = (seat: string, by: ReadonlyArray<{ secret: string; publicKey: string }>, threshold: unknown = 1, version = 2, signedFor = version) => {
    const unsigned = { kind: 'retire', seat, filedUpTo: {}, threshold, signatures: [] } as unknown as DirectoryChange;
    const signatures = by.map((k) => ({ publicKey: k.publicKey, signature: sign(directoryChangeMessage('acc_1', signedFor, unsigned), k.secret as never) }));
    return { company: 'acc_1', version, change: { ...unsigned, signatures } };
  };
  const retirement = (seat: string, by: { secret: string; publicKey: string }, version = 2, signedFor = version) => retirementBy(seat, [by], 1, version, signedFor);
  it('a retirement of the seat signed by a seat the directory names is held', () => {
    expect(retiredInTheDirectory('acc_1', [claim, retirement(LEAF, named)], LEAF.toUpperCase())).toBe(true);
  });
  it('a retirement is held only when signed by as many named seats as its own threshold, whatever the chain\'s bar is now', () => {
    /* RED WHEN: a seat is set aside on a retirement signed by fewer seats than its own threshold. */
    expect(retiredInTheDirectory('acc_1', [claim, claimed, retirementBy(LEAF, [named], 2)], LEAF)).toBe(false);
    expect(retiredInTheDirectory('acc_1', [claim, claimed, retirementBy(LEAF, [named, second], 2)], LEAF)).toBe(true);
    /* RED WHEN: a retirement whose threshold is not a whole number of at least one is counted at all. */
    expect(retiredInTheDirectory('acc_1', [claim, retirementBy(LEAF, [named], 0)], LEAF)).toBe(false);
    expect(retiredInTheDirectory('acc_1', [claim, retirementBy(LEAF, [named], 1.5)], LEAF)).toBe(false);
  });
  it('REFUSES as not held: another seat\'s retirement, one signed for another version, and one signed by a key no entry names', () => {
    /* RED WHEN: another seat's retirement sets this seat aside. */
    expect(retiredInTheDirectory('acc_1', [claim, retirement(OTHER, named)], LEAF)).toBe(false);
    /* RED WHEN: a retirement whose signatures do not verify for the version it is filed at is taken as held. */
    expect(retiredInTheDirectory('acc_1', [claim, retirement(LEAF, named, 2, 3)], LEAF)).toBe(false);
    /* RED WHEN: a retirement signed by a key no entry of the directory names is taken as held. */
    expect(retiredInTheDirectory('acc_1', [claim, retirement(LEAF, newSigningKeypair())], LEAF)).toBe(false);
    expect(retiredInTheDirectory('acc_1', [], LEAF)).toBe(false);
  });
});
