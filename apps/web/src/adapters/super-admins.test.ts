import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE SUPER ADMINS' ADAPTER: what it reads (the chain only, never a seat or a record), what it refuses before the wallet
 * is asked, and what it hands the service after each press. The doors, the wallet and the service are stood in for;
 * the trace through the real doors, wallet presses and service routes is in
 * src/server/one-super-admin-change-lands-on-every-contract.test.ts.
 */
const st = vi.hoisted(() => ({
  chainHeld: null as unknown, seenWith: [] as unknown[], kept: [] as unknown[], raised: [] as unknown[], keptRaise: [] as unknown[],
  approvals: [] as unknown[], keptApprovals: [] as unknown[], noIndexer: false, keptThrows: null as unknown, held: null as string | null, rows: [] as unknown[], asked: [] as string[], walletAsked: 0, raiseThrows: null as unknown, superAdmins: null as unknown,
}));
/* Three keys a wallet could hold: the x of G, 2G and 3G on the curve. */
let approveState: string | null = null;
const A = { tag: 'schnorr', value: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' };
const B = { tag: 'schnorr', value: 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5' };
const C = { tag: 'schnorr', value: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9' };
const doors = { chain: {}, wallet: { key: async () => { st.walletAsked += 1; return A; } } };
vi.mock('./super-admin-doors.js', () => ({
  superAdminDoorsFor: async () => (st.noIndexer ? null : doors),
  superAdminService: () => ({ kept: async () => { if (st.keptThrows !== null) throw st.keptThrows; return st.kept; } }),
}));
vi.mock('vaults-web-shared/super-admin-ask.js', () => ({ superAdminSigned: async () => ({ key: A, headers: {} }) }));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  api: async (path: string) => { st.asked.push(path); return { rows: st.rows }; },
}));
vi.mock('vaults-web-shared/committee-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/committee-here.js')>()),
  authorityHere: async () => st.chainHeld,
  superAdminsSeenHere: async (...args: unknown[]) => { st.seenWith.push(args[1]); return st.superAdmins; },
}));
vi.mock('vaults-web-shared/super-admin-change.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/super-admin-change.js')>()),
  raiseSuperAdminChange: async (_d: unknown, input: unknown) => { st.raised.push(input); return { file: { chainId: 'f' } }; },
  approveSuperAdminChange: async (_d: unknown, file: unknown) => { st.approvals.push(file); return { file: { ...(file as object), signatures: [1] }, done: st.held === null, held: st.held, contracts: [{ state: approveState ?? (st.held === null ? 'sent' : 'moved') }] }; },
}));
vi.mock('vaults-web-shared/super-admins-on-the-service.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/super-admins-on-the-service.js')>()),
  keepRaisedChange: async (...args: unknown[]) => { if (st.raiseThrows !== null) throw st.raiseThrows; st.keptRaise.push(args[2]); },
  keepApproval: async (...args: unknown[]) => { st.keptApprovals.push([args[1], args[2]]); },
}));

const { approveChange, notYetAdopted, raiseChange, readSuperAdmins, SUPER_ADMIN_WHY } = await import('./super-admins.js');
const { RaiserLeaves } = await import('vaults-web-shared/super-admins-on-the-service.js');

const REACH = { company: { accountId: 'c-1', label: `co_${'c0'.repeat(32)}`, account: 'b2'.repeat(32) }, asSuperAdmin: true } as never;
const NOW = { committee: [A, B], threshold: 2 };
const keptAt = (counter: string, over: Record<string, unknown> = {}) => ({
  chainId: `${counter}`.padStart(64, '0'), company: 'co', salt: '5a'.repeat(32), raisedBy: { key: A, signature: 'ab'.repeat(64) }, joined: [],
  change: { kind: 'super-admins', from: NOW, committee: [A, B, C], threshold: 2, contracts: [{ contract: 'account', address: 'b2'.repeat(32), counter }] }, ...over,
});

beforeEach(() => {
  Object.assign(st, { chainHeld: { committee: [A, B], threshold: 2, counter: 3n }, noIndexer: false, keptThrows: null, held: null, seenWith: [], kept: [], raised: [], keptRaise: [], approvals: [], keptApprovals: [], walletAsked: 0, raiseThrows: null });
  st.superAdmins = {
    superAdmins: { committee: [A, B], threshold: 2, counter: 3n }, shown: [{ key: A, mine: true }, { key: B, mine: false }], iAmOne: true,
    contracts: [{ address: 'b2'.repeat(32), authority: { committee: [A, B], threshold: 2, counter: 3n } }],
  };
});

describe('READING WHO THE SUPER ADMINS ARE', () => {
  it('reads them from the chain alone, with no seat and no record, and shows only the change kept at the account\'s counter now', async () => {
    st.kept = [keptAt('2'), keptAt('3', { joined: [{ key: C, signature: 'cd'.repeat(64) }] })];
    const read = await readSuperAdmins(REACH);
    /* RED WHEN: a seat, the roster or the company's records are read to name a super admin, or a created vault is put in a change. */
    expect(st.seenWith.at(-1)).toMatchObject({ seats: [], createdByTheCompany: [], ownWalletKey: A });
    /* RED WHEN: a change kept at an older counter, which can never land, is shown as one in progress. */
    expect(read).toMatchObject({ of: 'read', iAmOne: true, mine: A, changes: [{ chainId: '3'.padStart(64, '0'), joining: [{ key: C, signed: true, mine: false }] }] });
  });

  it('LISTS EVERY CHANGE KEPT AT THE ACCOUNT\'S COUNTER, EACH WITH THE KEY THAT RAISED IT', async () => {
    st.kept = [keptAt('3', { chainId: 'c1'.repeat(32), raisedBy: { key: C, signature: 'ab'.repeat(64) } }), keptAt('3', { chainId: 'a1'.repeat(32) })];
    const read = await readSuperAdmins(REACH);
    /* RED WHEN: the first change raised at the counter hides every later one, so a key being removed blocks its own removal. */
    expect(read.of === 'read' && read.changes.map((c) => [c.chainId, c.raisedBy.value, c.raisedByMine])).toEqual([['c1'.repeat(32), C.value, false], ['a1'.repeat(32), A.value, true]]);
  });

  it('counts as joining a key the account holds but a vault still to move does not', async () => {
    st.superAdmins = {
      superAdmins: { committee: [A, B], threshold: 2, counter: 3n }, shown: [{ key: A, mine: true }, { key: B, mine: false }], iAmOne: true,
      contracts: [{ address: 'b2'.repeat(32), authority: { committee: [A, B], threshold: 2, counter: 3n } }, { address: 'd1'.repeat(32), authority: { committee: [A, C], threshold: 2, counter: 1n } }],
    };
    st.kept = [keptAt('3', { change: { kind: 'super-admins', from: NOW, committee: [A, B], threshold: 1, contracts: [{ contract: 'account', address: 'b2'.repeat(32), counter: '3' }] } })];
    const read = await readSuperAdmins(REACH);
    /* RED WHEN: Approve is offered while a key the change puts on a vault has not signed, which the device then refuses. */
    expect(read.of === 'read' && read.changes[0]!.joining.map((j) => j.key.value)).toEqual([B.value]);
  });
});

describe('WHERE THE CHAIN OR THE SERVICE CANNOT BE READ', () => {
  it('ANSWERS A WALLET THAT NAMES NO INDEXER AS THE COMMITTEE UNREAD, AND ASKS THE WALLET TO SIGN NOTHING', async () => {
    st.noIndexer = true;
    /* RED WHEN: a wallet with no indexer is answered as an action that did not finish, or the read or a press throws. */
    expect(await readSuperAdmins(REACH)).toEqual({ of: 'refused', act: 'committee-unread' });
    expect(await raiseChange(REACH, { committee: [A, C], threshold: 2 }, NOW)).toEqual({ of: 'refused', act: 'committee-unread' });
    expect(st.walletAsked).toBe(0);
  });

  it('answers a read of the kept changes that failed as a refusal, never as no change kept', async () => {
    st.keptThrows = new TypeError('the service did not answer');
    /* RED WHEN: a failed read of the kept changes is shown as none kept, so a change in progress looks absent. */
    expect(await readSuperAdmins(REACH)).toEqual({ of: 'refused', act: 'unreachable' });
  });
});

describe('RAISING A CHANGE', () => {
  it('REFUSES A CHANGE THAT CANNOT BE INSTALLED, OR CHANGES NOTHING, BEFORE THE WALLET IS ASKED', async () => {
    /* RED WHEN: the wallet is asked for a committee no contract may hold, or for the committee held now. */
    expect(await raiseChange(REACH, { committee: [A, B], threshold: 3 }, NOW)).toEqual({ of: 'refused', why: SUPER_ADMIN_WHY.notInstallable });
    expect(await raiseChange(REACH, NOW, NOW)).toEqual({ of: 'refused', why: SUPER_ADMIN_WHY.sameAsNow });
    expect([st.walletAsked, st.raised]).toEqual([0, []]);
  });

  it('refuses a key the chain does not list on the committee, and raises nothing', async () => {
    st.chainHeld = { committee: [B, C], threshold: 2, counter: 3n };
    /* RED WHEN: a key that is not a super admin raises a change. */
    expect(await raiseChange(REACH, { committee: [A, B, C], threshold: 2 }, NOW)).toEqual({ of: 'refused', why: SUPER_ADMIN_WHY.notASuperAdmin });
    expect(st.raised).toEqual([]);
  });

  it('a super admin with no seat raises a change from the page, and the service keeps it', async () => {
    expect(await raiseChange(REACH, { committee: [A, B, C], threshold: 2 }, NOW)).toEqual({ of: 'done', sent: false, held: null });
    expect(st.raised.at(-1)).toMatchObject({ change: { kind: 'super-admins', committee: [A, B, C], threshold: 2 } });
    /* RED WHEN: a raised change is not handed to the service, so no other super admin finds it. */
    expect(st.keptRaise).toEqual([{ chainId: 'f' }]);
  });

  it('says a change that takes the raiser\'s own key off is raised by another super admin', async () => {
    st.raiseThrows = new RaiserLeaves();
    expect(await raiseChange(REACH, { committee: [B], threshold: 1 }, NOW)).toEqual({ of: 'refused', why: SUPER_ADMIN_WHY.raiserLeaves });
  });
});

describe('APPROVING A CHANGE', () => {
  const shown = (signed: boolean) => ({
    chainId: '3'.padStart(64, '0'), raisedBy: B, raisedByMine: false, committee: [A, B, C], threshold: 2, warning: null, joining: [{ key: C, signed, mine: false }],
  });

  it('REFUSES TO APPROVE WHILE A JOINING KEY HAS NOT SIGNED, AND ASKS NOTHING', async () => {
    st.kept = [keptAt('3')];
    /* RED WHEN: a super admin's wallet is asked for an update that would put a key nobody holds on a contract. */
    expect(await approveChange(REACH, shown(false))).toEqual({ of: 'refused', why: SUPER_ADMIN_WHY.joinsMissing });
    expect(st.approvals).toEqual([]);
  });

  it('approves the kept change and hands its new signatures to the service for the next super admin', async () => {
    st.kept = [keptAt('3', { joined: [{ key: C, signature: 'cd'.repeat(64) }] })];
    expect(await approveChange(REACH, shown(true))).toEqual({ of: 'done', sent: true, held: null });
    /* RED WHEN: an approval's signatures stay on this device, so the next super admin's device never counts them. */
    expect(st.keptApprovals).toHaveLength(1);
    expect((st.keptApprovals[0] as [{ chainId: string }, { signatures: unknown[] }])[1].signatures).toEqual([1]);
  });
});

describe('WHAT AN APPROVAL LEFT UNFINISHED', () => {
  it('carries the reason a change did not finish to the screen, rather than saying it waits for signatures', async () => {
    st.kept = [keptAt('3', { joined: [{ key: C, signature: 'cd'.repeat(64) }] })];
    st.held = 'a contract was changed by another change first, so nothing after it was sent';
    const shown = { chainId: '3'.padStart(64, '0'), committee: [A, B, C], threshold: 2, warning: null, raisedBy: A, raisedByMine: true, joining: [{ key: C, signed: true, mine: false }] };
    /* RED WHEN: a change spent, unsent or left for another device is told as waiting for signatures. */
    expect(await approveChange(REACH, shown)).toEqual({ of: 'done', sent: false, held: st.held });
  });

  it('says nothing more than that it waits, when the change is only short of signatures', async () => {
    st.kept = [keptAt('3', { joined: [{ key: C, signature: 'cd'.repeat(64) }] })];
    st.held = 'not every contract still to move has enough of its super admins\' signatures, so nothing is sent yet';
    const shown = { chainId: '3'.padStart(64, '0'), committee: [A, B, C], threshold: 2, warning: null, raisedBy: A, raisedByMine: true, joining: [{ key: C, signed: true, mine: false }] };
    approveState = 'waiting';
    expect(await approveChange(REACH, shown)).toEqual({ of: 'done', sent: false, held: null });
    approveState = null;
  });
});

describe('A VAULT THE COMPANY CREATED THAT THE ACCOUNT DOES NOT LIST YET', () => {
  it('is named to a signer from the company\'s own list of vaults, and left out of every change', async () => {
    const [listed, created] = ['d1'.repeat(32), 'd2'.repeat(32)];
    st.rows = [{ vault: listed }, { vault: created.toUpperCase() }, { vault: 'not a vault' }];
    st.asked = [];
    /* RED WHEN: a created vault the account does not list is not shown, or one it lists is shown as not yet adopted. */
    expect(await notYetAdopted('c-1', ['b2'.repeat(32), listed])).toEqual([created]);
    expect(st.asked).toEqual(['/api/accounts/c-1/vaults']);
  });

  it('reads the contracts the account lists from the chain, to compare against', async () => {
    st.superAdmins = { ...(st.superAdmins as object), contracts: [{ address: 'b2'.repeat(32), authority: null }, { address: 'd1'.repeat(32), authority: null }] };
    const read = await readSuperAdmins(REACH);
    expect(read.of === 'read' && read.contracts).toEqual(['b2'.repeat(32), 'd1'.repeat(32)]);
  });
});
