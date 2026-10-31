import { describe, expect, it, vi, beforeEach } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';
import { ActionStopped } from './run.js';
import { signingPublicKeyOf } from '../../../../src/core/crypto.js';

/*
 * **A SEAT ACTION DOES WHAT THE COMPANY IS OWED OF ITS SEAT, IN ITS OWN WINDOW, AND ANCHORS WHAT IT FILED AT ITS END.**
 * Opening a company's pages signs nothing, so every seat action in the wallet starts by changing the company's key when
 * a removal left it owed and following a roster no device believes, and ends by filing each vault's records again for
 * the signers seated since, giving each vault's secret to every other seat that lacks it, and anchoring on the chain. Each is worked out from the wallet's own reads, built on the
 * wallet's own chain state, and never stops the action for what it could not do. The shared steps it calls are stood in
 * here, so the order, the doors the wallet hands them and what the page is told can each be tried.
 */

const t = vi.hoisted(() => ({
  order: [] as string[],
  rotated: [] as unknown[],
  rotationDoors: null as null | Record<string, any>,
  anchorDoors: [] as Record<string, any>[],
  rebuilt: [] as { doors: Record<string, any>; vault: string }[],
  onTheWayIn: { anchored: 2, head: '00' } as unknown,
  anchorNow: { anchored: 3, head: '00' } as unknown,
  roster: async (_d: Record<string, any>): Promise<unknown> => null,
  notes: { of: 'as-filed', notes: [], unexplained: 0, said: [] } as unknown,
  owedFiled: [] as unknown[],
  gives: [] as Record<string, any>[],
  give: null as null | ((input: Record<string, any>) => Promise<unknown>),
}));
vi.mock('../../../../packages/web-shared/src/company-key-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/company-key-here.js')>()),
  rotateTheCompanyKeyHere: async (doors: Record<string, any>) => {
    t.order.push('rotate');
    t.rotationDoors = doors;
    const next = t.rotated.shift();
    if (next instanceof Error) throw next;
    return next ?? { state: 'not-needed' };
  },
}));
vi.mock('../../../../packages/web-shared/src/vault-operation.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-operation.js')>()),
  depositIntoCompanyVault: async () => { t.order.push('deposit'); return { note: { nonce: '01'.repeat(32), token: '9b'.repeat(32), value: 1n } }; },
  vaultNotesHere: async (doors: Record<string, any>, vault: string) => { t.order.push(`refile ${vault.slice(0, 4)}`); t.rebuilt.push({ doors, vault }); return t.notes; },
}));
vi.mock('../../../../packages/web-shared/src/records-anchored-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/records-anchored-here.js')>()),
  anchoredOnTheWayIn: async (doors: Record<string, any>) => { t.order.push('anchor'); t.anchorDoors.push(doors); return typeof t.onTheWayIn === 'function' ? (t.onTheWayIn as (d: unknown) => unknown)(doors) : t.onTheWayIn; },
  anchorTheRecordsHere: async () => { t.order.push('anchor now'); return t.anchorNow; },
  directoryChangeFiledHere: async (_doors: unknown, _change: unknown, signedFor: number) => { t.order.push(`filed the change ${signedFor}`); return { version: signedFor, anchor: {} }; },
}));
vi.mock('../../../../packages/web-shared/src/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-page-doors.js')>()),
  giveEachVaultSecretHere: async (input: Record<string, any>) => {
    t.order.push(`give ${String(input['seat']).slice(0, 4)} ${String(input['vaultIds'][0]).slice(0, 4)}`);
    t.gives.push(input);
    if (t.give !== null) return t.give(input);
    return { given: input['vaultIds'], had: [] };
  },
}));
vi.mock('../../../../packages/web-shared/src/vault-keys-given.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-keys-given.js')>()),
  ownEntryFiled: async (_api: unknown, _id: string, owed: { read(): unknown; settle(): Promise<void> }) => {
    t.owedFiled.push(owed.read());
    await owed.settle();
    return 'filed';
  },
  rosterFollowed: async (d: Record<string, any>) => { t.order.push('roster'); return t.roster(d); },
}));

const { anchorDoorsIn, rebuildDoorsIn, rotationDoorsIn, upkeepSteps, UPKEEP } = await import('./upkeep.js');
const { apiOver, sendOver } = await import('./company-reach.js');
const { createVaultAction } = await import('./create-vault.js');
const { giveVaultKeysAction } = await import('./give-vault-keys.js');
const { privateDepositAction } = await import('./private-deposit.js');
const { oneOffPaymentAction } = await import('./one-off-payment.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const LEAF = 'aa'.repeat(32);
const VAULTS = ['d1'.repeat(32), 'd2'.repeat(32)];
const JOINER = 'bb'.repeat(32);
const SEAT = { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) };
const CHAIN_STATE = { blockHash: 'b1', accountState: 'AAAA', parameters: 'BBBB' };

const ctxWith = (name: 'create-vault' | 'give-vault-keys' | 'private-deposit' | 'admit-signer' | 'approve-signer', over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const told: Record<string, unknown> = {};
  let keys = { accounts: { acc_1: SEAT }, counter: 1, ...(over['owed'] === undefined ? {} : { directoryEntriesOwed: { acc_1: over['owed'] } }) } as Record<string, any>;
  const ctx = {
    intent: { name, fields: { record: 'acc_1', company: LABEL, account: ACCOUNT } } as ActIntent,
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret }, at: { step: 1, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('upkeep sends through its calls, never a bare relay'); },
    call: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const answer = (over['answer'] as ((m: string, p: string) => { status: number; body: unknown } | undefined) | undefined)?.(method, path);
      return answer ?? { status: 200, body: {} };
    },
    tell: (o: Record<string, unknown>) => { Object.assign(told, o); },
    keyring: {
      open: () => ({ read: () => structuredClone(keys) }),
      keep: async (change: (k: never) => never) => { keys = change(structuredClone(keys) as never); t.order.push('kept'); },
    },
  } as unknown as StepContext;
  return { ctx, calls, told, keysNow: () => keys };
};

const reachWith = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: LEAF, companyKey: '11'.repeat(32),
  /* A read kept for a later step is handed to it; this one reaches no page, so there is nothing to hand over. */
  stepTo: () => {},
  api: async () => { throw new Error('upkeep calls through its own step, never an earlier one'); },
  send: async () => { throw new Error('upkeep sends through its own step, never an earlier one'); },
  holders: async () => ({ seats: [LEAF], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: VAULTS, account: ACCOUNT, founding: LEAF }),
  judges: {
    keysFoundFor: async () => ({ epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) }),
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null }),
    directoryWithItsRecordsFor: () => async () => ({ dir: { seats: [] } }),
    filingJudgeFor: () => async () => null,
    anchorsOnChainFor: () => async () => ({ landed: [], isTheWallets: true }),
    vouchingFor: () => ({ runs: async () => [], identity: async () => null }),
    tagSeatsFor: () => async () => new Map(),
    leavesFor: () => async () => [],
    seatsAdmittedOn: async () => new Set(),
    companyKeysFor: async () => ({ isAfterTheChange: true }),
    rosterReadsFor: () => ({ isTheWalletsRead: true }),
  },
  sealed: { id: 'acc_1' }, served: () => '22'.repeat(32), companyKeys: { isBeforeTheChange: true },
  roster: async () => ({ id: 'acc_1', signers: [] }),
  builder: { isTheWalletsBuilder: true, roundsOnChain: async () => [] },
  chain: { indexer: { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' }, callState: async () => CHAIN_STATE },
  ...over,
}) as never;

/** A company whose chain seats this seat and a joiner, with both vaults, and whose directory believes this seat in `role`. */
const givingReach = (role: string | null = 'admin', over: Record<string, unknown> = {}) => {
  const believed = () => ({
    dir: { seats: role === null ? [] : [{ seat: LEAF, signingKey: signingPublicKeyOf(SEAT.signingSecret).toLowerCase(), wrappingKey: '00'.repeat(32), role, retired: null }] },
    another: new Set(), holders: { seats: [LEAF, JOINER] }, leafOf: () => null,
  });
  return reachWith({
    holders: async () => ({ seats: [LEAF, JOINER], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: VAULTS, account: ACCOUNT, founding: LEAF }),
    judges: { ...(reachWith() as any).judges, directoryHereFor: () => async () => believed() },
    ...over,
  });
};

const company = (reaches = [reachWith()]) => {
  let read = 0;
  const renewed: number[] = [];
  return { renewed, doors: { reach: async () => reaches[Math.min(read++, reaches.length - 1)]!, renew: () => { renewed.push(read); } } };
};

beforeEach(() => {
  t.order = []; t.rotated = []; t.rotationDoors = null; t.anchorDoors = []; t.rebuilt = []; t.owedFiled = []; t.gives = []; t.give = null;
  t.onTheWayIn = { anchored: 2, head: '00' }; t.anchorNow = { anchored: 3, head: '00' };
  t.roster = async () => null; t.notes = { of: 'as-filed', notes: [], unexplained: 0, said: [] };
});

describe('every seat action starts with what the company is owed of its seat and ends by anchoring', () => {
  it('runs the owed upkeep before the action seals anything, and the anchor last', () => {
    const vaults = { chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, secrets: () => ({}) as never, pause: async () => {}, indexerHttp: 'x' };
    const titles = (steps: readonly { title: { key: string } }[]) => steps.map((s) => s.title.key);
    const intent = (name: string) => ({ name, fields: {} }) as ActIntent;
    /* RED WHEN: a company whose key is owed a change refuses the action at its first seal, before the change is made, so it is never made. */
    expect(titles(giveVaultKeysAction(vaults).steps(intent('give-vault-keys'))))
      .toEqual(['act.upkeep.step.first', 'act.give-vault-keys.step.entry', 'act.give-vault-keys.step.offer', 'act.upkeep.step.last']);
    /* RED WHEN: the vault is created without what it filed being anchored at its end. */
    expect(titles(createVaultAction(vaults).steps(intent('create-vault'))))
      .toEqual(['act.upkeep.step.first', 'act.create-vault.step.entry', 'act.create-vault.step.offer', 'act.create-vault.step.start', 'act.upkeep.step.last']);
    expect(titles(privateDepositAction({ ...vaults, balance: () => ({}) as never }).steps(intent('private-deposit'))))
      .toEqual(['act.private-deposit.step.seat', 'act.upkeep.step.first', 'act.private-deposit.step.deposit', 'act.upkeep.step.last']);
    /* RED WHEN: a one-off payment is raised before the owed upkeep, or ends without what it filed being anchored. */
    expect(titles(oneOffPaymentAction(vaults).steps(intent('one-off-payment'))))
      .toEqual(['act.one-off-payment.step.seat', 'act.upkeep.step.first', 'act.one-off-payment.step.raise', 'act.one-off-payment.step.charge',
        'act.one-off-payment.step.pay', 'act.upkeep.step.last']);
  });

  it('lists, before the passkey, everything the upkeep may do, as the action\'s own account of it', async () => {
    const vaults = { chain: () => ({ holders: async () => ({ key: 'x' }) }) as never, builder: () => ({}) as never, now: () => 1, secrets: () => ({}) as never, pause: async () => {}, indexerHttp: 'x' };
    const fields = { record: 'acc_1', company: LABEL, account: ACCOUNT };
    for (const action of [giveVaultKeysAction(vaults), createVaultAction(vaults)]) {
      const shown = await action.shown({ name: 'create-vault', fields } as ActIntent);
      /* RED WHEN: a rotation, a roster filing, a vault's records filed again or an anchor is done in the window without being listed before the passkey, or is marked as something this wallet read or only the page says. */
      for (const line of ['may', 'rotation', 'roster', 'vaults', 'secrets', 'anchor']) expect(shown, line).toContainEqual({ key: `act.upkeep.shown.${line}`, from: 'action' });
      /* RED WHEN: the window says the action is done before the upkeep it also runs is listed. */
      expect(shown.findIndex((l) => l.key === 'act.upkeep.shown.anchor')).toBeLessThan(shown.findIndex((l) => l.key.endsWith('.shown.nothing-else')));
      expect(action.checks).toContainEqual({ key: 'act.upkeep.check.worked-out' });
    }
  });
});

describe('the head changes the company\'s key first, then follows the roster, all on the wallet\'s own reads', () => {
  it('changes the key before it follows the roster, and reads the company again once the key changed', async () => {
    t.rotated = [{ state: 'rotated', epoch: 1, version: 4 }];
    let followed: Record<string, any> | null = null;
    t.roster = async (d) => { followed = d; return 3; };
    const after = reachWith({ companyKeys: { isTheNewKey: true } });
    const c = company([reachWith(), after]);
    const { ctx, told } = ctxWith('give-vault-keys');
    await upkeepSteps(c.doors, {}).first.run(ctx);
    /* RED WHEN: the roster is sealed under the key a removed signer held, because it is followed before the key is changed. */
    expect(t.order).toEqual(['rotate', 'roster']);
    /* RED WHEN: the action goes on with the company read before its key changed, so every later seal refuses: it is read again once the key changed, and again for the action's own steps since the roster was filed. */
    expect(c.renewed).toEqual([1, 2]);
    /* RED WHEN: the roster is sealed with the keys read before the change rather than read again after it. */
    expect(followed!['companyKeys']).toEqual({ isAfterTheChange: true });
    expect(followed!['reads']).toEqual({ isTheWalletsRead: true });
    expect(told).toEqual({ upkeep: UPKEEP.done });
  });

  it('anchors first a change of the key that waits on its own anchor, then changes it', async () => {
    t.rotated = [{ state: 'waits', why: 'a change of the company\'s key is filed and not yet anchored' }, { state: 'not-needed' }];
    const { ctx } = ctxWith('create-vault');
    await upkeepSteps(company().doors, {}).first.run(ctx);
    /* RED WHEN: a company whose last change of its key is filed and never anchored stays paused, since no action anchors it before sealing. */
    expect(t.order).toEqual(['rotate', 'anchor', 'rotate', 'roster']);
  });

  it('reads the company again before the action seals, whenever it anchored or filed, even when the key could not then be changed', async () => {
    t.rotated = [{ state: 'waits', why: 'the retirement of the leaving seat is filed and not yet anchored' }, new Error('the service refused the change')];
    const c = company();
    const { ctx, told } = ctxWith('create-vault');
    await upkeepSteps(c.doors, {}).first.run(ctx);
    expect(t.order).toEqual(['rotate', 'anchor', 'rotate', 'roster']);
    /* RED WHEN: a retirement anchored here, with no change of the key after it, leaves the action sealing with the company read before, which is not paused, so a removed signer reads what it seals. */
    expect(c.renewed).toHaveLength(1);
    expect(told).toEqual({ upkeep: UPKEEP.partial });
    t.order = [];
    t.rotated = [{ state: 'waits', why: 'the retirement of the leaving seat is filed and not yet anchored' }, { state: 'not-rotated', why: 'this seat could not open its own copy of the new key' }];
    const refused = company();
    await upkeepSteps(refused.doors, {}).first.run(ctxWith('create-vault').ctx);
    /* RED WHEN: the anchor alone, with the change of the key refused for its own reason, does not have the company read again before the action seals. */
    expect(refused.renewed).toHaveLength(1);
    const quiet = company();
    await upkeepSteps(quiet.doors, {}).first.run(ctxWith('create-vault').ctx);
    /* RED WHEN: a step that anchored and filed nothing reads the whole company again for no reason. */
    expect(quiet.renewed).toEqual([]);
  });

  it('makes the change from the seat in the saved keys and the company key this wallet derives, never the page\'s', async () => {
    const { ctx, calls } = ctxWith('give-vault-keys', {
      answer: (_m: string, p: string) => (p === '/api/accounts/acc_1/people' ? { status: 200, body: { people: [] } } : p === '/api/accounts/acc_1' ? { status: 200, body: { id: 'acc_1', pendingSigners: [{ sealed: { box: 1 } }] } } : undefined),
    });
    const doors = await rotationDoorsIn(reachWith(), apiOver(ctx));
    /* RED WHEN: the change is signed with material the page handed over rather than the seat the saved keys hold. */
    expect(doors.material).toEqual({ signingSecret: SEAT.signingSecret });
    /* RED WHEN: the company key the change is made under is one the page released rather than the one this wallet derives. */
    expect(doors.released()).toBe('11'.repeat(32));
    expect(await doors.askTheWallet()).toBe('11'.repeat(32));
    expect(await doors.served()).toBe('22'.repeat(32));
    expect(await doors.waiting!()).toEqual([{ box: 1 }]);
    const before = calls.filter((c) => c === 'GET /api/accounts/acc_1').length;
    await doors.admitted!();
    await doors.admitted!();
    /* RED WHEN: who the roster admitted is read once when the doors are made rather than afresh for each change of the key. */
    expect(calls.filter((c) => c === 'GET /api/accounts/acc_1').length - before).toBe(2);
    await doors.file({ kind: 'rotate' } as never, 4);
    expect(t.order).toContain('filed the change 4');
    /* RED WHEN: the waiting answers are read on a route the action does not list, so the page could answer anything. */
    for (const c of calls) expect(routeOf(intentShapeOf('give-vault-keys')!, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
  });

  it('files the owed directory entry the saved keys hold before a deposit, and nothing when none is held', async () => {
    const owed = { person: 'usr_a', company: LABEL, signed: { committeeKey: 'k', entry: 'e' } };
    const held = ctxWith('private-deposit', { owed });
    await upkeepSteps(company().doors, {}, { ownEntry: true }).first.run(held.ctx);
    /* RED WHEN: a seat whose entry the directory never took is left unentered, so no device believes it. */
    expect(t.owedFiled).toEqual([owed]);
    expect(held.keysNow()['directoryEntriesOwed']).toEqual({});
    t.owedFiled = [];
    await upkeepSteps(company().doors, {}, { ownEntry: true }).first.run(ctxWith('private-deposit').ctx);
    expect(t.owedFiled).toEqual([]);
  });
});

describe('a private deposit made after the head filed something', () => {
  it('is made on the company read again after the head, never refused for the read the head let go', async () => {
    t.roster = async () => 3;
    let reads = 0;
    const action = privateDepositAction({
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never,
      kept: () => ({ inFlight: {}, coins: undefined }) as never,
      reachFor: async () => { reads += 1; return reachWith(); },
    });
    const { ctx } = ctxWith('private-deposit');
    const fields = { record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULTS[0]!, token: '9b'.repeat(32), amount: '5' };
    (ctx as { intent: unknown }).intent = { name: 'private-deposit', fields };
    const steps = action.steps(ctx.intent);
    for (const s of steps.slice(0, 3)) await s.run(ctx);
    /* RED WHEN: the deposit step finds the company the head let go of and refuses, so a deposit after any upkeep is never made. */
    expect(t.order).toEqual(['rotate', 'roster', 'deposit']);
    /* RED WHEN: the deposit is made on the company as read before the head filed, not read again after it. */
    expect(reads).toBe(2);
  });
});

describe('the tail files each vault again with this seat, then anchors what the action filed', () => {
  it('files again every vault the chain names, with this seat and the coins this wallet kept', async () => {
    const coins = { isTheWalletsCoins: true };
    const opened: unknown[] = [];
    const { ctx, told } = ctxWith('private-deposit');
    await upkeepSteps(company().doors, { coins: (o) => { opened.push(o); return coins as never; } }).last.run(ctx);
    /* RED WHEN: a signer seated after a vault's last write reaches none of its notes, because only the vault the action is on is filed again. */
    expect(t.rebuilt.map((x) => x.vault)).toEqual(VAULTS);
    for (const { doors } of t.rebuilt) {
      /* RED WHEN: the vault is read without this seat, so what it owes (a new signer's copy, a leaver's pool, a deposit not yet named) is never filed. */
      expect(typeof doors['seatHere']).toBe('function');
      /* RED WHEN: a deposit whose records the service withheld is known only in this wallet and never named in the vault's record. */
      expect(doors['kept']).toBe(coins);
      expect(doors['builder']).toEqual({ isTheWalletsBuilder: true, roundsOnChain: expect.any(Function) });
    }
    expect(t.order.at(-1)).toBe('anchor');
    expect(told).toEqual({ upkeep: UPKEEP.done, anchored: 2 });
  });

  it('anchors the action\'s own filings even when the company was anchored within the day', async () => {
    t.onTheWayIn = { waits: 'anchored-within-a-day' };
    const { ctx, told } = ctxWith('create-vault');
    await upkeepSteps(company().doors, {}).last.run(ctx);
    /* RED WHEN: what the action just filed waits a day for its anchor, believed by no other device. */
    expect(t.order.slice(-2)).toEqual(['anchor', 'anchor now']);
    expect(told).toMatchObject({ anchored: 3 });
  });

  it('builds the anchor on the account state this wallet read, and sends it through a listed call', async () => {
    const { ctx } = ctxWith('private-deposit');
    const doors = await anchorDoorsIn(reachWith(), apiOver(ctx));
    /* RED WHEN: the anchor is proved on an account state the page or the service handed over. */
    expect(await doors.service.callState('acc_1')).toEqual({ ...CHAIN_STATE, account: ACCOUNT });
    /* RED WHEN: the anchor is made with material other than the seat the saved keys hold. */
    expect(doors.material).toEqual({ signingSecret: SEAT.signingSecret, blinding: SEAT.blinding, scope: SEAT.scope });
    /* RED WHEN: the anchors on the chain are read through anything but this wallet's own indexer. */
    expect(await doors.onChain()).toEqual({ landed: [], isTheWallets: true });
    expect(doors.builder).toEqual({ isTheWalletsBuilder: true, roundsOnChain: expect.any(Function) });
    for (const name of ['create-vault', 'give-vault-keys', 'private-deposit']) {
      const shape = intentShapeOf(name)!;
      /* RED WHEN: the anchor is sent on a route that is not counted as sending, so a refused send is never said. */
      expect(routeOf(shape, 'POST', '/api/accounts/acc_1/proven')?.sends, name).toBe(true);
      for (const [m, p] of [['POST', '/api/accounts/acc_1/manifest/tree/headers'], ['GET', '/api/accounts/acc_1/people'], ['GET', '/api/employees/emp_1/handover'],
        ['PUT', '/api/accounts/acc_1/directory/4'], ['POST', '/api/accounts/acc_1/roster'], ['GET', `/api/vaults/${VAULTS[0]}/records/pool/versions`],
        ['PUT', `/api/vaults/${VAULTS[0]}/records/pool/3`]] as const) {
        /* RED WHEN: the upkeep asks the page for a call its action does not list, and the wallet stops the action there. */
        expect(routeOf(shape, m, p), `${name} ${m} ${p}`).not.toBeNull();
      }
      /* RED WHEN: the upkeep can read the account's state through the page. */
      expect(routeOf(shape, 'GET', '/api/accounts/acc_1/call-state'), name).toBeNull();
    }
  });

  it('gives each vault\'s secret to each other seat the chain holds, one seat and one vault at a time, before the anchor', async () => {
    let reads = 0;
    const base = givingReach() as any;
    const r = reachWith({
      holders: async () => ({ seats: [LEAF, JOINER.toUpperCase()], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: VAULTS, account: ACCOUNT, founding: LEAF }),
      judges: { ...base.judges, directoryHereFor: () => async () => { reads += 1; return base.judges.directoryHereFor()(); } },
    });
    t.give = async (input) => { await input['directory'](); return { given: input['vaultIds'], had: [] }; };
    const { ctx, told } = ctxWith('give-vault-keys');
    await upkeepSteps(company([r]).doors, {}).last.run(ctx);
    /* RED WHEN: the vaults' secrets are not given in the action's last step, are given after the anchor so a copy is filed and never anchored, or this seat gives one to itself. */
    expect(t.order).toEqual([`refile d1d1`, `refile d2d2`, `give bbbb d1d1`, `give bbbb d2d2`, 'anchor']);
    for (const g of t.gives) {
      expect(g['me'].signerId).toBe(LEAF);
      expect(typeof g['records']).toBe('function');
    }
    /* RED WHEN: the directory is read again for every seat and vault instead of once for the step. */
    expect(reads).toBe(1);
    expect(told).toEqual({ upkeep: UPKEEP.done, anchored: 2 });
  });

  it('leaves for the next action, never refuses, a seat with no directory entry this wallet believes yet', async () => {
    const r = givingReach();
    t.give = async () => { throw new Error('the new signer has no entry in the company\'s directory that this device believes yet'); };
    const { ctx, told } = ctxWith('admit-signer');
    /* RED WHEN: a joiner who has not filed their entry yet makes the action fail after what it sent, or is reported as given. */
    await expect(upkeepSteps(company([r]).doors, {}).last.run(ctx)).resolves.toBeUndefined();
    expect(t.order.at(-1)).toBe('anchor');
    expect(told).toEqual({ upkeep: UPKEEP.partial, anchored: 2 });
  });

  it('tries each vault alone, so one this seat cannot give does not keep the next from being given', async () => {
    const r = givingReach();
    t.give = async (input) => {
      if (input['vaultIds'][0] === VAULTS[0]) throw new Error('no copy is wrapped to this signer\'s records key');
      return { given: input['vaultIds'], had: [] };
    };
    const { ctx, told } = ctxWith('approve-signer');
    await upkeepSteps(company([r]).doors, {}).last.run(ctx);
    /* RED WHEN: the vaults are given as one batch that stops at the first it cannot give. */
    expect(t.gives.map((g) => g['vaultIds'])).toEqual([[VAULTS[0]], [VAULTS[1]]]);
    expect(told).toMatchObject({ upkeep: UPKEEP.partial });
  });

  it('asks for a vault\'s secret by the vault\'s lower-case name when the chain names the vault in upper case', async () => {
    const r = givingReach('admin', {
      holders: async () => ({ seats: [LEAF, JOINER], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: VAULTS.map((v) => v.toUpperCase()), account: ACCOUNT, founding: LEAF }),
    });
    const { ctx } = ctxWith('give-vault-keys');
    await upkeepSteps(company([r]).doors, {}).last.run(ctx);
    /* RED WHEN: a vault the chain names in upper case is asked for under that name, which the pool does not hold, and the act ends partial with no word of why. */
    expect(t.gives.map((g) => g['vaultIds'])).toEqual([[VAULTS[0]], [VAULTS[1]]]);
  });

  it('gives nothing from a seat whose role may not file a vault\'s secret, or that this wallet does not believe, and says so', async () => {
    for (const role of ['viewer', null]) {
      t.order = []; t.gives = [];
      const { ctx, told } = ctxWith('give-vault-keys');
      await upkeepSteps(company([givingReach(role)]).doors, {}).last.run(ctx);
      /* RED WHEN: a viewer, or a seat this wallet does not believe, files a version of a vault's secret that every device then refuses. */
      expect(t.gives, String(role)).toEqual([]);
      expect(t.order.at(-1), String(role)).toBe('anchor');
      expect(told, String(role)).toEqual({ upkeep: UPKEEP.partial, anchored: 2 });
    }
  });

  it('reads a vault\'s records again with this seat\'s own signer and the coins of this wallet', () => {
    const { ctx } = ctxWith('private-deposit');
    const doors = rebuildDoorsIn(ctx, reachWith(), apiOver(ctx), sendOver(ctx), { coins: () => undefined });
    /* RED WHEN: a vault is filed again without this seat, so it files nothing. */
    expect(typeof doors.seatHere).toBe('function');
    expect('kept' in doors).toBe(false);
    expect(doors.me.wrappingSecret).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the upkeep says what it could not do, and stops only for what the page must be told', () => {
  it('says what is still owed when this seat may not anchor, or a vault was not filed again for a signer seated since', async () => {
    const outcomes: unknown[] = [];
    for (const [onTheWayIn, notes] of [
      [{ waits: 'this-seat-does-not-anchor' }, { of: 'as-filed', notes: [], unexplained: 0, said: [] }],
      [{ anchored: 1, head: '00' }, { of: 'as-filed', notes: [], unexplained: 0, said: ['this vault\'s pool was not filed again for a signer who cannot open it yet: refused'] }],
      [{ anchored: 1, head: '00' }, { of: 'not-filed', notes: [], unexplained: 2, said: [] }],
    ] as const) {
      t.onTheWayIn = onTheWayIn; t.notes = notes;
      const { ctx, told } = ctxWith('give-vault-keys');
      await upkeepSteps(company().doors, {}).last.run(ctx);
      outcomes.push(told['upkeep']);
    }
    /* RED WHEN: the outcome says the upkeep is done while the action's filings wait unanchored, or a signer seated since still reaches none of a vault's notes. */
    expect(outcomes).toEqual([UPKEEP.partial, UPKEEP.partial, UPKEEP.partial]);
  });

  it('never stops the action for what it could not do, and says so in the outcome', async () => {
    t.rotated = [new Error('the directory could not be read')];
    t.roster = async () => { throw new Error('the roster could not be read'); };
    t.notes = { of: 'not-read', said: ['no'] };
    t.onTheWayIn = { notAnchored: 'the service did not give the entry' };
    const { ctx, told } = ctxWith('private-deposit');
    const u = upkeepSteps(company().doors, {});
    /* RED WHEN: a deposit recorded is reported as failed because what the upkeep owes could not be done, inviting a second deposit. */
    await expect(u.first.run(ctx)).resolves.toBeUndefined();
    await expect(u.last.run(ctx)).resolves.toBeUndefined();
    expect(told).toEqual({ upkeep: UPKEEP.partial, anchored: 0 });
  });

  it('stops at the step when the service did not confirm sending the anchor', async () => {
    t.onTheWayIn = async (doors: { service: { sendProven(id: string, tx: string): Promise<unknown> } }) => {
      try { await doors.service.sendProven('acc_1', 'AAAA'); } catch { return { notAnchored: 'not sent' }; }
      return { anchored: 1, head: '00' };
    };
    const { ctx, calls } = ctxWith('create-vault', { answer: (m: string, p: string) => (m === 'POST' && p.endsWith('/proven') ? { status: 502, body: { error: 'down' } } : undefined) });
    const e = await upkeepSteps(company().doors, {}).last.run(ctx).catch((x: unknown) => x);
    expect(calls).toContain('POST /api/accounts/acc_1/proven');
    /* RED WHEN: an anchor that may have been sent is swallowed by the upkeep, so the page is told the action is done with nothing unconfirmed. */
    expect(e).toBeInstanceOf(StepRefused);
    expect((e as StepRefused).words.key).toBe('act.upkeep.why.not-confirmed');
  });

  it('counts a proposal call as unconfirmed only when it carried a transaction', async () => {
    const tried = (body: string) => async (d: Record<string, any>) => {
      try { await d['api']('/api/accounts/acc_1/proposals', { method: 'POST', body }); } catch { /* the shared step swallows it */ }
      return null;
    };
    const refusing = { answer: (m: string, p: string) => (m === 'POST' && p.endsWith('/proposals') ? { status: 500, body: { error: 'down' } } : undefined) };
    t.roster = tried('{"proposal":{},"salt":"ab"}');
    const bare = ctxWith('create-vault', refusing);
    /* RED WHEN: a proposal written down with nothing for the chain, refused by the service, stops the step as something that may have been sent. */
    await expect(upkeepSteps(company().doors, {}).first.run(bare.ctx)).resolves.toBeUndefined();
    expect(bare.calls).toContain('POST /api/accounts/acc_1/proposals');
    t.roster = tried('{"proposal":{},"salt":"ab","tx":"AAAA"}');
    const sent = ctxWith('create-vault', refusing);
    const e = await upkeepSteps(company().doors, {}).first.run(sent.ctx).catch((x: unknown) => x);
    /* RED WHEN: a raise that may have been sent with its transaction is swallowed by the upkeep. */
    expect((e as StepRefused).words?.key).toBe('act.upkeep.why.not-confirmed');
  });

  it('never swallows a stop, even where the shared step it calls catches every error', async () => {
    t.roster = async (d) => {
      try { await d['api']('/api/accounts/acc_1'); } catch { /* the shared step swallows it */ }
      return null;
    };
    const { ctx } = ctxWith('give-vault-keys');
    (ctx as { call: unknown }).call = async () => { throw new ActionStopped('stopped'); };
    /* RED WHEN: Stop or the deadline reaching a call inside the upkeep is swallowed, and the action runs on after it. */
    await expect(upkeepSteps(company().doors, {}).first.run(ctx)).rejects.toBeInstanceOf(ActionStopped);
  });

  it('never swallows a stop reaching a vault secret being given', async () => {
    const r = givingReach();
    t.give = async (input) => {
      try { await input['records']('nonce-secret').get(VAULTS[0]); } catch { /* the store wraps what reached its call */ }
      throw new Error('the vault\'s secret was not given');
    };
    const { ctx } = ctxWith('give-vault-keys');
    const calls = { n: 0 };
    (ctx as { call: unknown }).call = async () => { calls.n += 1; throw new ActionStopped('stopped'); };
    /* RED WHEN: Stop reaching the giving of a vault's secret is swallowed, and the action goes on to anchor. */
    await expect(upkeepSteps(company([r]).doors, {}).last.run(ctx)).rejects.toBeInstanceOf(ActionStopped);
    expect(t.order).not.toContain('anchor');
    expect(calls.n).toBe(1);
  });

  it('never swallows a stop raised by a read outside the step\'s watched calls while a secret is given', async () => {
    t.give = async () => { throw new ActionStopped('stopped'); };
    const { ctx } = ctxWith('give-vault-keys');
    /* RED WHEN: a stop from the company's own reads (the directory or a record's judge), which the watched calls never see, is taken as a give left for later and the action goes on to anchor. */
    await expect(upkeepSteps(company([givingReach()]).doors, {}).last.run(ctx)).rejects.toBeInstanceOf(ActionStopped);
    expect(t.order).not.toContain('anchor');
  });
});
