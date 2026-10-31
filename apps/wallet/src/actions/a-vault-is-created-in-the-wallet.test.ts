import { describe, expect, it, vi, beforeEach } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf } from 'midnight-identity/profile/request';
import type { ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **CREATING A VAULT IN THE WALLET BELIEVES NOTHING THE PAGE SAYS UNTIL ITS OWN READS AGREE.** Every service answer
 * reaches the wallet through the page; here the page's answers are forged one at a time, and each is caught by the
 * wallet's own check: the company's record against the chain's label and seats, the readers of the vault's secret
 * against the seats the chain holds, the call state from the wallet's own read and never the page, the vault's secret
 * kept before its filing leaves, and the seat's records key signed only for the seat the wallet's own keys make.
 */

const t = vi.hoisted(() => ({
  refusalSeats: [] as unknown[],
  refusal: null as null | { code: string; says: string },
  order: [] as string[],
  filed: 'filed' as unknown,
}));
vi.mock('../../../../src/midnight/secret-readers.js', async (real) => ({
  ...(await real<typeof import('../../../../src/midnight/secret-readers.js')>()),
  rosterRefusalOf: (input: { seats: unknown }) => { t.refusalSeats.push(input.seats); return t.refusal; },
}));
vi.mock('../../../../src/core/vault-keys.js', async (real) => ({
  ...(await real<typeof import('../../../../src/core/vault-keys.js')>()),
  rosterVaultKeys: (account: { signers: Array<{ id: string; vaultKeys?: { recordsKey: string } }> }) =>
    account.signers.map((x) => ({ signerId: x.id, userId: null, name: x.id, filingKey: '00', keys: x.vaultKeys === undefined ? null : { recordsKey: x.vaultKeys.recordsKey } })),
}));
vi.mock('../../../../packages/web-shared/src/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-page-doors.js')>()),
  fileTheOwedDirectoryEntry: async (_api: unknown, _id: string, owed: { read(): unknown }) => {
    t.order.push(owed.read() === null ? 'filed with nothing owed' : 'filed what was kept');
    return t.filed;
  },
}));
vi.mock('../../../../packages/web-shared/src/roster-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/roster-here.js')>()),
  offerVaultKeysHere: async () => { t.order.push('offered'); },
  foldOffersHere: async () => { t.order.push('folded'); return { folded: [], refused: [] }; },
}));

const { companyReachFor } = await import('./company-reach.js');
const { createVaultAction, namedCode, readersFrom, startRefusalOf, recordsKeepingTheSecret, vaultDoorsFor } = await import('./create-vault.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const LEAF = 'aa'.repeat(32);
const SEAT = {
  signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32),
};
const why = (key: string, values?: Readonly<Record<string, string | number>>) => ({ key, ...(values === undefined ? {} : { values }) });
const intent = (fields: Record<string, string> = {}): ActIntent =>
  ({ name: 'create-vault', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, ...fields } }) as ActIntent;

const ctxWith = (over: Partial<StepContext> & { answers?: Record<string, unknown> } = {}) => {
  const calls: string[] = [];
  let keys = { accounts: { acc_1: SEAT }, counter: 1 } as Record<string, unknown>;
  const ctx = {
    intent: intent(), asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, wallet: { drewTheLabel: () => true, pinnedFor: () => ({ account: ACCOUNT, created: true }), pin: async () => {} } },
    at: { step: 1, steps: 3 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a vault is created through calls, never a bare relay'); },
    call: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const a = over.answers?.[`${method} ${path}`];
      return a === undefined ? { status: 404, body: { error: 'none' } } : { status: 200, body: a };
    },
    tell: () => {},
    keyring: {
      open: () => ({ read: () => structuredClone(keys), metadata: () => ({}), seal: () => { throw new Error('not here'); }, letGo: () => {} }),
      keep: async (change: (k: never) => never) => { keys = change(structuredClone(keys) as never); t.order.push('kept'); },
    },
    ...over,
  } as unknown as StepContext;
  return { ctx, calls, keysNow: () => keys };
};
const chainWith = (seats: string[] | { key: string }) => ({
  indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' },
  holders: async () => (Array.isArray(seats)
    ? { seats, committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT, founding: LEAF }
    : seats) as never,
  callState: async () => ({ blockHash: 'b1', accountState: 'AAAA', parameters: 'BBBB' }),
});
const builder = { ownSeat: async () => LEAF } as never;

beforeEach(() => { t.refusalSeats = []; t.refusal = null; t.order = []; t.filed = 'filed'; });

describe('the company the page names is believed only as the wallet\'s own chain read shows it', () => {
  it('refuses an account the chain does not show carrying the label, before anything is asked of the page', async () => {
    // RED WHEN: a forged record naming another company's account is acted on because the page said it was this one
    const { ctx, calls } = ctxWith();
    await expect(companyReachFor(ctx, chainWith({ key: 'act.company.why.other-label' }) as never, builder, why)).rejects.toThrow(StepRefused);
    expect(calls).toEqual([]);
  });

  it('refuses a seat the chain does not hold, whatever the service\'s records say', async () => {
    // RED WHEN: the seat the saved keys hold is acted for though the chain no longer seats it
    const { ctx } = ctxWith();
    const e = await companyReachFor(ctx, chainWith(['bb'.repeat(32)]) as never, builder, why).catch((x) => x);
    expect((e as StepRefused).words.key).toBe('seat-not-held');
  });

  it('refuses the company\'s record when the service serves one for another label or account', async () => {
    // RED WHEN: a forged company record (another label, another account) is taken as the one the chain names
    const forged = { id: 'acc_1', companyLabel: drawCompanyLabel(), contractAddress: ACCOUNT, wrappedKeys: [] };
    const { ctx } = ctxWith({ answers: { 'GET /api/accounts/acc_1': forged } });
    const e = await companyReachFor(ctx, chainWith([LEAF]) as never, builder, why).catch((x) => x);
    expect((e as StepRefused).words.key).toBe('not-a-company');
  });
});

const reach = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: LEAF, companyKey: '11'.repeat(32),
  api: async () => { throw new Error('no call expected'); }, send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: [LEAF, 'bb'.repeat(32)], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null }), filingJudgeFor: () => async () => null },
  sealed: {}, companyKeys: {} as never,
  roster: async () => ({ id: 'acc_1', signers: [{ id: 's1', status: 'active', leafCommitment: LEAF, vaultKeys: { recordsKey: '5a'.repeat(32) } }] }),
  builder: { companyWide: async () => '00'.repeat(32), bornHeldVault: async () => ({ vault: 'DE'.repeat(32), tx: 'AAAA' }) },
  chain: chainWith([LEAF]),
  ...over,
}) as never;

describe('the vault\'s secret is sealed only to the seats the wallet reads on the chain', () => {
  it('checks the readers against the chain\'s seats as the wallet read them, and refuses when the check does', async () => {
    // RED WHEN: the readers are checked against seats the page or the service named, so a signer they leave out gets no copy
    await readersFrom(reach()).catch(() => undefined);
    expect(t.refusalSeats).toEqual([{ seats: [LEAF, 'bb'.repeat(32)] }]);
    t.refusal = { code: 'roster-not-the-chains', says: 'the list is out of date' };
    // RED WHEN: a roster the check refuses still yields readers, so the secret is sealed to a forged list
    await expect(readersFrom(reach())).rejects.toThrow(StepRefused);
  });

  it('never asks the service for the readers, and builds every call on the wallet\'s own read of the account', async () => {
    const asked: string[] = [];
    const r = reach({ api: async (path: string) => { asked.push(path); return []; } });
    const { ctx } = ctxWith();
    const doors = vaultDoorsFor(ctx, r, { secrets: () => ({ keep: async () => {}, held: async () => null, drop: async () => {} }), pause: async () => {}, indexerHttp: 'https://indexer.example' } as never);
    // RED WHEN: the readers of the vault's secret are the service's list
    expect((await doors.service.keys()).readers).toEqual(['5a'.repeat(32)]);
    expect(asked.filter((p) => p.endsWith('/vault-keys'))).toEqual([]);
    // RED WHEN: a proposal is proved on an account state the page or the service handed over
    expect(await doors.proposals.service.callState('acc_1')).toEqual({ blockHash: 'b1', accountState: 'AAAA', parameters: 'BBBB', account: ACCOUNT });
    const shape = intentShapeOf('create-vault')!;
    expect(routeOf(shape, 'GET', '/api/accounts/acc_1/call-state')).toBeNull();
    expect(routeOf(shape, 'GET', '/api/accounts/acc_1/vault-keys')).toBeNull();
    expect(routeOf(shape, 'GET', '/api/me/keys')).toBeNull();
  });

  it('counts who approves each vault only from a roster that names a signer for every seat the chain holds', async () => {
    const { ctx } = ctxWith();
    const doorsOver = (notBelieved: string[]) => vaultDoorsFor(ctx, reach({
      roster: async () => ({ id: 'acc_1', signers: [{ id: 's1', status: 'active', leafCommitment: LEAF }], notBelieved }),
    }), { secrets: () => ({ keep: async () => {}, held: async () => null, drop: async () => {} }), pause: async () => {}, indexerHttp: 'x' } as never);
    /* RED WHEN: a vault's approvers are counted from a roster that names no signer for a seat the chain holds, such as one waiting for Finish adding. */
    await expect(doorsOver(['bb'.repeat(32)]).approvers()).rejects.toThrow(/names no signer for 1 seat/u);
    expect([...(await doorsOver([]).approvers()).seats.keys()]).toEqual([LEAF.toLowerCase()]);
  });

  it('names the vault to the page as soon as it is built, before it is sent', async () => {
    // RED WHEN: a vault built and then stopped before its answer is named to nobody, so a second one is created
    const told: unknown[] = [];
    const { ctx } = ctxWith({ tell: (o: unknown) => { told.push(o); } } as never);
    const doors = vaultDoorsFor(ctx, reach(), { secrets: () => ({ keep: async () => {}, held: async () => null, drop: async () => {} }), pause: async () => {}, indexerHttp: 'x' } as never);
    await doors.builder.bornHeldVault!({ account: ACCOUNT, holders: { committee: [], threshold: 1 } });
    expect(told).toEqual([{ vault: 'de'.repeat(32) }]);
  });
});

describe('the vault\'s secret is kept in the wallet before its filing leaves', () => {
  it('keeps the secret first, and files nothing when it could not be kept', async () => {
    const order: string[] = [];
    const inner = () => ({ get: async () => null, put: async () => { order.push('filed'); }, versionsAsFiled: async () => [] });
    let refuse = false;
    const kept = { keep: async () => { if (refuse) throw new Error('the store is full'); order.push('kept'); }, held: async () => null, drop: async () => {} };
    const records = recordsKeepingTheSecret(inner as never, kept as never);
    await records('nonce-secret').put('d1'.repeat(32), {} as never);
    // RED WHEN: the secret's filing leaves before the wallet kept it, so a page that withholds the filing loses it
    expect(order).toEqual(['kept', 'filed']);
    refuse = true;
    await expect(records('nonce-secret').put('d1'.repeat(32), {} as never)).rejects.toThrow(/full/);
    expect(order).toEqual(['kept', 'filed']);
    await records('pool').put('d1'.repeat(32), {} as never);
    // RED WHEN: every record is kept in the wallet, not the secret alone
    expect(order).toEqual(['kept', 'filed', 'filed']);
  });
});


describe('the window lists, before the passkey, how many seats the vault\'s secret is sealed to, as the wallet reads the chain', () => {
  it('counts the seats from the wallet\'s own read, and marks the names the page gives as the page\'s', async () => {
    const action = createVaultAction({ chain: () => chainWith([LEAF, 'bb'.repeat(32), 'cc'.repeat(32)]) as never, builder: () => builder, now: () => 1 } as never);
    const shown = await action.shown(intent({ readers: 'Ada, Bo' }));
    // RED WHEN: the number of readers before the passkey is the page's word, or the page's names are shown as the wallet's
    expect(shown.find((l) => l.key === 'act.create-vault.shown.sealed-to')).toEqual({ key: 'act.create-vault.shown.sealed-to', values: { seats: 3 }, from: 'wallet' });
    expect(shown.find((l) => l.key === 'act.create-vault.shown.readers')).toEqual({ key: 'act.create-vault.shown.readers', values: { names: 'Ada, Bo' }, from: 'page' });
    const named = await action.shown(intent({ title: 'Payroll', about: 'For the monthly run' }));
    // RED WHEN: the description the wallet signs into the vault's name filing is not shown before the passkey, as the page's
    expect(named.find((l) => l.key === 'act.create-vault.shown.about')).toEqual({ key: 'act.create-vault.shown.about', values: { about: 'For the monthly run' }, from: 'page' });
    // RED WHEN: the account a joiner's wallet may keep for good is not shown before the passkey
    expect(named.some((l) => l.key === 'act.create-vault.shown.pin' && l.from === 'page')).toBe(true);
    const unread = await createVaultAction({ chain: () => chainWith({ key: 'x' }) as never, builder: () => builder, now: () => 1 } as never).shown(intent());
    // RED WHEN: the line saying the wallet could not read the account is marked as something the wallet read
    expect(unread.some((l) => l.key === 'act.create-vault.shown.sealed-to-unread' && l.from === 'action')).toBe(true);
  });

  it('marks the company and the vault as the page names them, and what the wallet checks of them as neither the page\'s nor a read', async () => {
    const action = createVaultAction({ chain: () => chainWith([LEAF]) as never, builder: () => builder, now: () => 1 } as never);
    const carrying = await action.shown(intent({ vault: 'dd'.repeat(32) }));
    const marks = carrying.map((l) => [l.key, l.from]);
    // RED WHEN: a check the wallet makes after the passkey is shown inside a line marked as only the page's words
    expect(marks).toContainEqual(['act.create-vault.shown.company', 'page']);
    expect(marks).toContainEqual(['act.create-vault.shown.company-check', 'action']);
    expect(marks).toContainEqual(['act.create-vault.shown.carry-on', 'page']);
    expect(marks).toContainEqual(['act.create-vault.shown.carry-on-check', 'action']);
    // RED WHEN: a description of what the action does is marked as something this wallet read
    for (const key of ['act.create-vault.shown.keys', 'act.create-vault.shown.nothing-else', 'act.upkeep.shown.may']) {
      expect(marks, key).toContainEqual([key, 'action']);
    }
  });
});

describe('the window promises no more privacy for the vault than the page is given', () => {
  it('says the page holds the vault\'s secret from the moment this wallet files it, read only', async () => {
    const { readFileSync } = await import('node:fs');
    const words = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
    const said = words['act.create-vault.shown.nothing-else'];
    // RED WHEN: the window names a later moment than when the page can first read the vault
    expect(said).not.toMatch(/once the copies are written/);
    expect(said).toMatch(/The page holds the vault's secret from the moment this wallet files it/);
    // RED WHEN: the window says less than the page can read with the secret, or that it can spend
    expect(said).toMatch(/every amount paid into and out of the vault and where each payment out goes, and it can never spend from the vault/);
  });
});

describe('a refused start names its kind of stop to the page only from the start\'s own codes', () => {
  it('names a start\'s stop, a read that failed and a vault not built, and nothing else', async () => {
    const { NOT_BUILT, START_READ_STOP, START_STOP } = await import('../../../../packages/web-shared/src/vault-operation.js');
    /* RED WHEN: a kind of stop the start names is not carried, so the page cannot say which read or check stopped it. */
    for (const code of [START_STOP.readersCannotOpen, START_READ_STOP.chainUnread, START_READ_STOP.standingUnread, NOT_BUILT.committeeUnread]) {
      expect(namedCode(code)).toBe(code);
    }
    /* RED WHEN: a code the start does not name, or none, is carried as a kind of stop. */
    for (const code of ['seat 7', 'signer-left-out', undefined]) expect(namedCode(code)).toBeUndefined();
  });

  it('the start step passes the kind of stop to its refusal, for a start not finished and for a vault not built', async () => {
    const { NOT_BUILT, START_READ_STOP, VaultNotBuilt, VaultStartOwed } = await import('../../../../packages/web-shared/src/vault-operation.js');
    const told: Record<string, unknown>[] = [];
    const ctx = { tell: (o: Record<string, string | number>) => { told.push(o); } };
    const owed = startRefusalOf(new VaultStartOwed('ab'.repeat(32) as never, 'the read ran out.', START_READ_STOP.chainUnread), ctx);
    /* RED WHEN: a start not finished stops with no kind of stop, so the stop line cannot say which read failed. */
    expect(owed).toMatchObject({ words: { key: 'act.create-vault.why.start-owed' }, code: START_READ_STOP.chainUnread });
    expect(told).toEqual([{ vault: 'ab'.repeat(32), stopped: START_READ_STOP.chainUnread }]);
    const notBuilt = startRefusalOf(new VaultNotBuilt(NOT_BUILT.committeeUnread, 'no vault was built.'), ctx);
    /* RED WHEN: a vault not built stops with no kind of stop. */
    expect(notBuilt).toMatchObject({ words: { key: 'act.create-vault.why.not-built' }, code: NOT_BUILT.committeeUnread });
    /* RED WHEN: any other error is taken for a refusal of the start. */
    expect(startRefusalOf(new Error('no'), ctx)).toBeNull();
  });
});
