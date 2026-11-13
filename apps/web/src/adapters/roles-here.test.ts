// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mayInvite, READER_PURPOSES, RIGHTS_PRESET, ROLES, type SignerRole } from '../../../../src/core/roles.js';
import { ACT_REFUSAL } from './refusals.js';

/*
 * THE ROLES PAGE'S READ OF WHO HOLDS A SEAT AND ITS ASK OF THE WALLET TO CHANGE A SIGNER'S ROLE: the seats as the company's directory
 * holds them with the names the roster gives them, the two steps a role change takes, what the page keeps for the second step
 * for the visit only (never an invitation token), and what the page says the wallet's stops come to. The keyring and the seat read are stood in for; the page's
 * own checks and choices are the product's.
 */
const COMPANY = 'c-1';
const ACCOUNT = 'c0'.repeat(32);
const PRIVATE = 'mn_shield-addr_stagenet1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kkcvfvr0u';
const leaf = (n: number): string => n.toString(16).padStart(64, '0');
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, seat: null as unknown, fail: null as Error | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => { kr.acts.push(intent); return kr.ended; },
}));
vi.mock('./vault-private-money.js', async (real) => ({
  ...(await real<typeof import('./vault-private-money.js')>()),
  seatAndRecordsHere: async () => kr.seat,
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./roles-here.js');
}

const seat = (n: number, over: Record<string, unknown> = {}) => ({ seat: leaf(n).toUpperCase(), person: `p${n}`, role: 'approver', retired: null, ...over });
const HOLDERS = { seats: [leaf(1), leaf(2), leaf(3)], approvals: 2, vaultThresholds: [], policyBar: null, seatBar: 2 };
const hereWith = (seats: readonly unknown[], held: readonly string[] = HOLDERS.seats) => ({
  leaf: leaf(2),
  directory: async () => {
    if (kr.fail !== null) throw kr.fail;
    return { dir: { seats }, holders: { ...HOLDERS, seats: held } };
  },
  opened: { signers: [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: `Name ${n}`, leafCommitment: leaf(n), status: 'active' })) },
});
const SEATS = [seat(1, { role: 'admin' }), seat(2), seat(3, { role: 'initiator' })];
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({ of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', ...(refused === undefined ? {} : { refused }), ...over });
const ask = { leaf: leaf(3), current: 'initiator', role: 'approver', address: PRIVATE, name: 'Name 3' };
const reset = (): void => {
  kr.user = { id: 'u1' }; kr.acts = []; kr.ended = { of: 'done', steps: 1, relayed: 0 }; kr.seat = hereWith(SEATS); kr.fail = null;
  sessionStorage.clear(); localStorage.clear();
};

describe('what the page reads of who holds a seat', () => {
  /* RED WHEN: a seat the directory holds is missing from the page, carries another person's name, or is not marked as the person's own. */
  it('lists the seats with the roster\'s names, their roles and which is this person\'s own', async () => {
    reset();
    const { readRoles, ROLES_READ } = await load();
    const read = await readRoles('u1', COMPANY);
    expect(read).toMatchObject({ of: ROLES_READ.read, seats: [
      { leaf: leaf(1), name: 'Name 1', role: 'admin', you: false, leaving: false },
      { leaf: leaf(2), name: 'Name 2', role: 'approver', you: true, leaving: false },
      { leaf: leaf(3), name: 'Name 3', role: 'initiator', you: false, leaving: false },
    ] });
  });

  /* RED WHEN: the founding seat, which holds no role, is dropped from the list or shown as a role it does not hold. */
  it('keeps the founding seat, which holds no role, as one with none', async () => {
    reset();
    kr.seat = hereWith([seat(1, { role: null }), seat(2)]);
    const { readRoles } = await load();
    expect(await readRoles('u1', COMPANY)).toMatchObject({ seats: [{ leaf: leaf(1), role: null }, { leaf: leaf(2), role: 'approver' }] });
  });

  /* RED WHEN: a seat being removed is listed as one that stays, or a seat the network no longer holds is listed at all. */
  it('marks a seat that is being removed and leaves out one the removal has carried out', async () => {
    reset();
    kr.seat = hereWith([seat(1), seat(2), seat(3, { retired: { version: 4 } }), seat(4, { retired: { version: 3 } })], [leaf(1), leaf(2), leaf(3)]);
    const { readRoles } = await load();
    const read = await readRoles('u1', COMPANY);
    expect(read).toMatchObject({ seats: [{ leaf: leaf(1) }, { leaf: leaf(2) }, { leaf: leaf(3), leaving: true }] });
    expect(read).toMatchObject({ seats: { length: 3 } });
  });

  /* RED WHEN: a seat's name falls back to nothing when the roster has none, or the seat's id is shown in a name's place. */
  it('names a seat the roster does not name by the directory\'s person', async () => {
    reset();
    kr.seat = hereWith([seat(9)], [leaf(9)]);
    const { readRoles } = await load();
    expect(await readRoles('u1', COMPANY)).toMatchObject({ seats: [{ leaf: leaf(9), name: 'p9' }] });
  });

  /* RED WHEN: what a role change costs is read from anything but the approvals the account holds, or the seats held is miscounted. */
  it('reads the account\'s approvals as the holders of a change', async () => {
    reset();
    const { readRoles } = await load();
    expect(await readRoles('u1', COMPANY)).toMatchObject({ holders: { approvals: 2, vaultThresholds: [], policyBar: null, seatBar: 2, seated: 3 } });
  });

  /* RED WHEN: a page that has no company key released reads the seats anyway, or a read that fails is shown as an empty company. */
  it('refuses with the seat read\'s own reason, and with the reason the directory could not be read', async () => {
    reset();
    kr.seat = ACT_REFUSAL.noKeysHere;
    const { readRoles, ROLES_READ } = await load();
    expect(await readRoles('u1', COMPANY)).toEqual({ of: ROLES_READ.refused, why: ACT_REFUSAL.noKeysHere });
    kr.seat = hereWith(SEATS); kr.fail = new Error('withheld');
    expect(await readRoles('u1', COMPANY)).toMatchObject({ of: ROLES_READ.refused });
  });
});

describe('what each role may do', () => {
  /* RED WHEN: a role the company has is missing from the page, or one it does not have is shown, or the five are not the signer roles first. */
  it('has a row for every role the company has, signer roles first', async () => {
    const { ROLE_TABLE } = await load();
    expect(ROLE_TABLE.map((r) => r.role)).toEqual(ROLES);
    expect(ROLE_TABLE.map((r) => r.seat)).toEqual([true, true, true, false, false]);
  });

  /* RED WHEN: a role is shown as raising, approving or holding a run that the rights its seat's leaf commits to do not give it. */
  it('shows what each signer may do with a run as the rights the leaf commits to give it', async () => {
    const { ROLE_TABLE } = await load();
    for (const r of ROLE_TABLE.filter((x) => x.seat)) {
      expect({ raise: r.mayRaise, approve: r.mayApprove, hold: r.mayHold }).toEqual({
        raise: RIGHTS_PRESET[r.role as SignerRole].mayRaise, approve: RIGHTS_PRESET[r.role as SignerRole].mayApprove, hold: RIGHTS_PRESET[r.role as SignerRole].mayHold,
      });
    }
    expect(ROLE_TABLE.map((r) => [r.role, r.mayRaise, r.mayApprove, r.mayHold])).toEqual([
      ['admin', true, true, true], ['approver', false, true, true], ['initiator', true, false, false], ['limited', false, false, false], ['accountant', false, false, false],
    ]);
  });

  /* RED WHEN: a role that may not file a proposal is shown as inviting, or one that files every kind of record is not shown so. */
  it('shows who invites and who files every kind of record as the one list of what each role may file gives it', async () => {
    const { ROLE_TABLE } = await load();
    for (const r of ROLE_TABLE) expect(r.mayInvite).toBe(mayInvite({ role: r.role }));
    expect(ROLE_TABLE.map((r) => [r.role, r.mayInvite, r.filesEvery])).toEqual([
      ['admin', true, true], ['approver', true, false], ['initiator', true, false], ['limited', false, false], ['accountant', false, false],
    ]);
  });

  /* RED WHEN: a reader is shown reading what its read grant does not open, or not reading what it does. */
  it('shows what each reader reads as the purposes its read grant names', async () => {
    const { ROLE_TABLE } = await load();
    expect(ROLE_TABLE.filter((r) => !r.seat).map((r) => [r.role, r.reads])).toEqual([
      ['limited', READER_PURPOSES.limited], ['accountant', READER_PURPOSES.accountant],
    ]);
    expect(ROLE_TABLE.filter((r) => r.seat).map((r) => r.reads)).toEqual([[], [], []]);
  });
});

describe('what a role change makes public', () => {
  /* RED WHEN: a role change is shown as making nothing public, or only one of the seat leaving and the seat joining is told, or the approvals are not the seat bar. */
  it('says a seat leaving and a seat joining are public, and how many approvals each step needs', async () => {
    const { roleChangeCosts } = await load();
    expect(roleChangeCosts({ approvals: 2, vaultThresholds: [], policyBar: null, seatBar: 2, seated: 3 })).toEqual({ leaves: true, joins: true, needed: 2 });
    expect(roleChangeCosts({ approvals: 2, vaultThresholds: [], policyBar: 3, seatBar: 3, seated: 4 })).toMatchObject({ needed: 3 });
  });
});

describe('what the page asks of the wallet', () => {
  const NAMED = { name: 'change-role', record: COMPANY, company: 'label-1', account: ACCOUNT };

  /* RED WHEN: a change names a seat other than the one chosen, loses the role, the address or the name, or carries an invitation token. */
  it('sends the seat, the new role, the full address and the name, and no token', async () => {
    reset();
    const { changeRole } = await load();
    await changeRole('u1', COMPANY, { ...ask, leaf: leaf(3).toUpperCase(), address: ` ${PRIVATE} ` });
    expect(kr.acts).toEqual([{ ...NAMED, leaf: leaf(3), role: 'approver', address: PRIVATE, personName: 'Name 3' }]);
  });

  /* RED WHEN: a change the page can see is no change reaches the wallet: no name, an address that is not private, a role no seat holds, or the role the seat holds. */
  it('asks nothing of the wallet for a change it can see is not one', async () => {
    reset();
    const { changeRole, CHANGE_ACTED } = await load();
    const problem = (over: Record<string, unknown>) => changeRole('u1', COMPANY, { ...ask, ...over });
    expect(await problem({ leaf: ' ' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'no-seat' });
    expect(await problem({ name: ' ' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'no-name' });
    expect(await problem({ address: 'mn_addr_stagenet1egv3hww6lmsahjy3gldaqn778hcpwvhhw8udud6k859906yynmmq8wsdsd' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'bad-address' });
    expect(await problem({ address: '' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'bad-address' });
    expect(await problem({ role: 'accountant' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'no-role' });
    expect(await problem({ role: '' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'no-role' });
    expect(await problem({ role: 'initiator' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'same-role' });
    expect(await problem({ current: null, role: 'admin' })).toEqual({ of: CHANGE_ACTED.problem, problem: 'same-role' });
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: a changed role or address replaces the change begun, so the first step can no longer be finished from the page. */
  it('keeps the first change begun when the second ask is not the one the first made', async () => {
    reset();
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'remove' } };
    const { changeRole, startedRoleChanges } = await load();
    await changeRole('u1', COMPANY, ask);
    await changeRole('u1', COMPANY, { ...ask, role: 'admin' });
    expect(startedRoleChanges(COMPANY)).toEqual([{ leaf: leaf(3), name: 'Name 3', role: 'approver', address: PRIVATE }]);
  });

  /* RED WHEN: a change that has been finished is still offered to be continued. */
  it('forgets the change once the invitation is filed', async () => {
    reset();
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'remove' } };
    const { changeRole, startedRoleChanges } = await load();
    await changeRole('u1', COMPANY, ask);
    expect(startedRoleChanges(COMPANY)).toHaveLength(1);
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'invite' } };
    await changeRole('u1', COMPANY, ask);
    expect(startedRoleChanges(COMPANY)).toEqual([]);
  });

  /* RED WHEN: what the page keeps of a change begun is written where a reload, another tab or another script could read it. */
  it('keeps the change begun in memory for the visit only, never in the browser\'s storage', async () => {
    reset();
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'remove' } };
    const { changeRole } = await load();
    await changeRole('u1', COMPANY, ask);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(leaf(3));
    expect(JSON.stringify({ ...localStorage })).not.toContain(leaf(3));
    vi.resetModules();
    const again = await import('./roles-here.js');
    expect(again.startedRoleChanges(COMPANY)).toEqual([]);
  });

  /* RED WHEN: a change that was not asked of the wallet at all (refused before it was sent) is remembered as begun. */
  it('does not remember a change the wallet was never asked for', async () => {
    reset();
    const { changeRole, startedRoleChanges } = await load();
    await changeRole('u1', COMPANY, { ...ask, name: '' });
    kr.user = null;
    await changeRole('u1', COMPANY, ask);
    kr.user = { id: 'u1' };
    for (const refused of ['removal-under-way', 'fewer-approvals-first', 'seat-not-held', 'not-an-address']) {
      kr.ended = stopped(`act.change-role.why.${refused}`);
      await changeRole('u1', COMPANY, ask);
    }
    expect(startedRoleChanges(COMPANY)).toEqual([]);
    kr.ended = stopped(undefined, { relayed: 1 });
    await changeRole('u1', COMPANY, ask);
    expect(startedRoleChanges(COMPANY)).toHaveLength(1);
  });

  /* RED WHEN: a begun change cannot be continued from what the page remembers, or the continue asks for another seat, role or address. */
  it('continues a begun change with the seat, role, address and token it began with', async () => {
    reset();
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'remove' } };
    const { changeRole, continueRoleChange } = await load();
    await changeRole('u1', COMPANY, ask);
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'invite', state: 'waiting-for-approvals', approvals: 0, needed: 2 } };
    const ended = await continueRoleChange('u1', COMPANY, leaf(3).toUpperCase());
    expect(kr.acts[1]).toEqual(kr.acts[0]);
    expect(ended).toEqual({ of: 'done', stage: 'invite', state: 'waiting-for-approvals', approvals: 0, needed: 2 });
    expect(await continueRoleChange('u1', COMPANY, leaf(3))).toEqual({ of: 'problem', problem: 'not-begun' });
  });

  /* RED WHEN: the page is not told which step ran, where it stands, or the approvals it has of those it needs. */
  it('hands back which step ran, where it stands and the approvals', async () => {
    reset();
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { stage: 'remove', state: 'waiting-for-approvals', approvals: 1, needed: 2 } };
    const { changeRole } = await load();
    expect(await changeRole('u1', COMPANY, ask)).toEqual({ of: 'done', stage: 'remove', state: 'waiting-for-approvals', approvals: 1, needed: 2 });
    kr.ended = { of: 'done', steps: 1, relayed: 0 };
    expect(await changeRole('u1', COMPANY, ask)).toEqual({ of: 'done', stage: null, state: null, approvals: null, needed: null });
  });

  /* RED WHEN: a wallet's stop is shown as the wrong reason, or a stop that may have part-filed is not marked so. */
  it('says why the wallet stopped, and whether part of it may have gone through', async () => {
    reset();
    const { changeRole } = await load();
    const why = async (refused?: string, over: Record<string, unknown> = {}) => { kr.ended = stopped(refused, over); return changeRole('u1', COMPANY, ask); };
    expect(await why('act.change-role.why.removal-under-way')).toEqual({ of: 'stopped', why: 'removal-under-way', partial: false, handedOver: false });
    expect(await why('act.change-role.why.fewer-approvals-first')).toMatchObject({ why: 'fewer-approvals-first' });
    expect(await why('act.change-role.why.not-as-started')).toMatchObject({ why: 'not-as-started' });
    expect(await why('act.change-role.why.not-started-here')).toMatchObject({ why: 'not-started-here' });
    expect(await why('act.change-role.why.not-an-address')).toMatchObject({ why: 'not-an-address' });
    expect(await why('act.change-role.why.refused')).toMatchObject({ why: 'not-as-asked', partial: false });
    expect(await why('act.change-role.why.no-seat')).toMatchObject({ why: 'seat' });
    expect(await why('act.change-role.why.seat-not-held')).toMatchObject({ why: 'seat' });
    expect(await why(undefined, { relayed: 1 })).toMatchObject({ why: 'stopped', partial: true, handedOver: true });
    expect(await why('act.remove-signer.why.something-new')).toMatchObject({ why: 'other', partial: true });
  });

  /* RED WHEN: a signed-out page or a company with no wallet record still asks the wallet. */
  it('asks the wallet nothing when nobody is signed in or the company has no record of its own', async () => {
    reset();
    const { changeRole } = await load();
    kr.user = null;
    expect(await changeRole('u1', COMPANY, ask)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' }; kr.named = null;
    expect(await changeRole('u1', COMPANY, ask)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.acts).toEqual([]);
    kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
  });
});


describe('dropping a change begun', () => {
  /* RED WHEN: the wallet is asked to drop another seat's change than the one named, or the page goes on listing a change the wallet says it no longer keeps, or forgets one the wallet may still keep. */
  it('asks the wallet to drop the seat named, and forgets the change only once the wallet holds none', async () => {
    reset();
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'remove' } };
    const { changeRole, dropRoleChange, startedRoleChanges } = await load();
    await changeRole('u1', COMPANY, ask);
    kr.acts = [];
    kr.ended = stopped('act.change-role.why.no-saved-keys');
    expect(await dropRoleChange('u1', COMPANY, leaf(3))).toEqual({ of: 'stopped', why: 'seat', partial: false, handedOver: false });
    expect(startedRoleChanges(COMPANY)).toHaveLength(1);
    kr.user = null;
    expect(await dropRoleChange('u1', COMPANY, leaf(3))).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' };
    expect(startedRoleChanges(COMPANY)).toHaveLength(1);
    kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'dropped' } };
    expect(await dropRoleChange('u1', COMPANY, leaf(3).toUpperCase())).toEqual({ of: 'dropped', state: 'dropped' });
    expect(kr.acts.at(-1)).toMatchObject({ name: 'drop-role-change', leaf: leaf(3) });
    expect(kr.acts.at(-1)).toHaveProperty('record');
    expect(startedRoleChanges(COMPANY)).toEqual([]);
  });

  /* RED WHEN: a change the wallet kept none of stays listed, or a state the wallet did not tell is taken as a drop. */
  it('forgets a change the wallet kept none of, and keeps one when the wallet says nothing of it', async () => {
    reset();
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { stage: 'remove' } };
    const { changeRole, dropRoleChange, startedRoleChanges } = await load();
    await changeRole('u1', COMPANY, ask);
    kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: {} };
    expect(await dropRoleChange('u1', COMPANY, leaf(3))).toEqual({ of: 'dropped', state: null });
    expect(startedRoleChanges(COMPANY)).toHaveLength(1);
    kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'not-kept' } };
    expect(await dropRoleChange('u1', COMPANY, leaf(3))).toEqual({ of: 'dropped', state: 'not-kept' });
    expect(startedRoleChanges(COMPANY)).toEqual([]);
  });
});
