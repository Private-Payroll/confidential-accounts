import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A NEW VAULT'S ADOPTION AND ITS FIRST SECRET RUN ARE APPROVED AND CARRIED OUT FROM THE WALLET BY ANOTHER SIGNER.**
 * One signer set the vault up and raised both; a second approves each through the one approval and carries it out once
 * the chain counts its bar. The shared code that finds each proposal, checks it as the vault's start does and proves each
 * call is stood in for here (it is followed in vault-operation.test.ts, "EACH PROPOSAL OF A NEW VAULT'S START IS APPROVED AND
 * CARRIED OUT BY ANOTHER SIGNER"). What is pinned: the wallet hands it exactly the vault and the proposal the window
 * showed, with the company counted for the vault check; the carrying out is its own step that reads the chain first; the
 * bar is the chain's; a round a leaving signer raised, or an adoption a removal has outrun, goes no further.
 */

const t = vi.hoisted(() => ({
  shared: [] as Array<{ act: string; doors: any; named: any }>,
  chain: {} as Record<string, any>,
  opened: { said: null as string | null },
  approve: null as null | ((doors: any) => Promise<string>),
  carried: { state: 'carried-out', said: null } as { state: string; said: string | null },
  finished: null as null | { state: string; said: string | null },
  leaver: null as Error | null,
  leaverAsked: [] as string[],
  called: [] as string[],
}));
const CHAIN_ID = 'dd'.repeat(32);
vi.mock('../../../../packages/web-shared/src/vault-operation.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/vault-operation.js')>();
  return {
    ...actual,
    /* The shared code: an approval adds one on the chain; a carrying out closes the proposal. */
    startRoundOpenedHere: async (doors: unknown, named: unknown) => {
      t.shared.push({ act: 'opened', doors, named });
      return { chainId: CHAIN_ID, said: t.opened.said };
    },
    approveStartRoundHere: async (doors: any, named: unknown) => {
      t.shared.push({ act: 'approve', doors, named });
      if (t.approve !== null) return t.approve(doors);
      t.chain[CHAIN_ID] = { ...t.chain[CHAIN_ID], approvals: t.chain[CHAIN_ID].approvals + 1 };
      return 'approved';
    },
    carryStartRoundHere: async (doors: unknown, named: unknown) => {
      t.shared.push({ act: 'carry', doors, named });
      return t.carried;
    },
    finishedFirstSecretHere: async (doors: unknown, named: unknown) => {
      t.shared.push({ act: 'finish', doors, named });
      return t.finished;
    },
  };
});
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  refuseARunALeaverRaisedHere: async (_records: unknown, _account: string, _keys: unknown, id: string) => {
    t.leaverAsked.push(id);
    if (t.leaver !== null) throw t.leaver;
  },
}));
vi.mock('./create-vault.js', async (real) => ({
  ...(await real<typeof import('./create-vault.js')>()),
  /* The vault's own start's doors, stood in: each send is a call to the page, as the real ones make it. */
  vaultDoorsFor: (ctx: StepContext) => ({
    service: {
      startAccountCall: async () => ctx.call('POST', `/api/accounts/acc_1/vaults/${PAYROLL}/start/account`, '{}'),
      startSecret: async () => ctx.call('POST', `/api/accounts/acc_1/vaults/${PAYROLL}/start/secret`, '{}'),
      startCopy: async () => ctx.call('POST', `/api/accounts/acc_1/vaults/${PAYROLL}/start/copy`, '{}'),
    },
    approvers: async () => { throw new Error('the start\'s own count of the company, without its open runs'); },
  }),
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { await company.reach(c); } },
    }),
  };
});

const { approveProposalAction } = await import('./approve-proposal.js');
const { StartRoundRefused, START_STOP } = await import('../../../../packages/web-shared/src/vault-operation.js');

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WIDE = 'cc'.repeat(32);
const PAYROLL = 'ab'.repeat(32);
const SEATS = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_1', vault: PAYROLL };
const intent = (fields: Record<string, string>): ActIntent => ({ name: 'approve-proposal', fields: { ...BASE, ...fields } }) as ActIntent;

/* The company as this wallet reads it: three seats on the chain, the account's threshold and each vault's own. */
let company: { approvals: number; vaultThresholds: Array<{ vault: string; threshold: number }> };
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: WIDE },
  leaf: SEATS[0], companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => { t.called.push(`${init?.method ?? 'GET'} ${path}`); return []; },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({
    seats: SEATS, committee: [], approvals: company.approvals, seatBar: company.approvals, policyBar: null,
    vaultThresholds: company.vaultThresholds, adoptedVaults: [PAYROLL], account: ACCOUNT,
  }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, records: { history: new Map() } }),
    leavesFor: () => async () => [],
    rosterReadsFor: () => ({}),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', notBelieved: [], signers: SEATS.map((leaf, i) => ({ id: `s${i + 1}`, status: 'active', leafCommitment: leaf })) }),
  builder: {
    roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => Object.fromEntries(chainIds.map((id) => [id, t.chain[id] ?? { held: 'never', approvals: 0 }])),
    companyWide: async () => WIDE,
    runsOutrun: async () => ({}),
  },
  chain: { indexer: {}, callState: async () => null },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, account: 0 }, at: { step: 3, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a round of a vault\'s start is sent through its calls, never a bare relay'); },
    call: async (method: string, path: string) => { t.called.push(`${method} ${path}`); return { status: 200, body: {} }; },
    tell: (x: Record<string, unknown>) => { told.push(x); },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told };
};
const reach = (over: Record<string, unknown> = {}) => ({
  chain: () => ({ holders: async () => ({ seats: SEATS }) }) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0,
  secrets: () => ({}) as never, commitments: async () => ({}) as never, reachFor: async () => reachOf() as never,
  indexerHttp: 'https://indexer.example/api/v3/graphql', ...over,
});
const run = async (i: ActIntent, ctx: StepContext, r = reach()): Promise<void> => {
  for (const step of approveProposalAction(r as never).steps(i)) await step.run(ctx);
};
const refusalOf = async (p: Promise<unknown>): Promise<{ key: string; says: string; code: string | undefined }> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return { key: (e as StepRefused).words.key, says: String((e as StepRefused).words.values?.['says'] ?? ''), code: (e as StepRefused).code };
};
const acts = () => t.shared.map((c) => c.act);

beforeEach(() => {
  t.shared.length = 0;
  t.called.length = 0;
  t.leaverAsked.length = 0;
  t.leaver = null;
  t.approve = null;
  t.opened.said = null;
  t.carried = { state: 'carried-out', said: null };
  t.finished = null;
  t.chain = { [CHAIN_ID]: { held: 'open', approvals: 1, needed: 2, raisedAt: 1 } };
  company = { approvals: 2, vaultThresholds: [] };
});

describe('A NEW VAULT\'S ADOPTION ANOTHER SIGNER RAISED IS APPROVED AND CARRIED OUT IN THE WALLET', () => {
  it('a second signer approves it through the one approval, and a step of its own carries it out once the chain counts two', async () => {
    const i = intent({ kind: 'adopt-vault' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: a second signer cannot approve a vault's adoption from the wallet, or no step carries it out at its bar. */
    expect(acts()).toEqual(['opened', 'approve', 'carry']);
    /* RED WHEN: the proposal approved or carried out is not the adoption of the vault the window showed. */
    for (const c of t.shared) expect(c.named).toEqual({ vault: PAYROLL, round: 'adoption', proposal: 'prp_1' });
    /* RED WHEN: the vault check counts the company without its open runs, as the vault's own start does from the page. */
    for (const c of t.shared) await expect(c.doors.approvers()).resolves.toBeDefined();
    /* RED WHEN: the proposal is approved or carried out without the check that no signer on their way out raised it. */
    expect(t.leaverAsked).toEqual(['prp_1', 'prp_1']);
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('an adoption a removal has outrun is refused in words that say the chain never carries it out, never that it can be raised again', async () => {
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1, outrun: true };
    const i = intent({ kind: 'adopt-vault' });
    const refused = await refusalOf(run(i, ctxOf(i).ctx));
    /* RED WHEN: an adoption the account will never carry out is approved. */
    expect(refused.key).toBe('act.approve-start.why.outrun');
    expect(acts()).toEqual(['opened']);
    /* RED WHEN: the words lead the person to withdraw it and raise it again, under an identity its approvers can no longer count. */
    expect(WORDS['act.approve-start.why.outrun']).not.toMatch(/raise it again\.|withdraw it and/iu);
    expect(WORDS['act.approve-start.why.outrun']).toMatch(/will never carry it out/u);
    /* RED WHEN: the shared code's own refusal of a stale adoption is said as anything else. */
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1 };
    t.approve = async () => { throw new StartRoundRefused('a signer was removed or replaced after its adoption was raised.', START_STOP.adoptionStale); };
    expect((await refusalOf(run(i, ctxOf(i).ctx))).key).toBe('act.approve-start.why.outrun');
  });

  it('a round raised by a signer whose removal is raised is neither approved nor carried out', async () => {
    t.leaver = new Error('This was raised by a signer whose removal is raised, after it was raised. Nothing was sent.');
    const i = intent({ kind: 'adopt-vault' });
    const refused = await refusalOf(run(i, ctxOf(i).ctx));
    /* RED WHEN: a leaving signer's round reaches the shared code to be approved. */
    expect(refused.key).toBe('act.approve-start.why.not-approved');
    expect(refused.says).toMatch(/whose removal is raised/u);
    expect(acts()).toEqual(['opened']);
  });

  it('a refusal before anything is sent says so, and one after a send says it may have been sent', async () => {
    t.approve = async () => { throw new StartRoundRefused('it would leave a vault short. Nothing was sent.', START_STOP.tooFewApprovers); };
    const i = intent({ kind: 'adopt-vault' });
    const before = await refusalOf(run(i, ctxOf(i).ctx));
    /* RED WHEN: a refusal of the shared code is not said in its own words, with the kind a page says it by. */
    expect(before).toMatchObject({ key: 'act.approve-start.why.not-approved', says: 'it would leave a vault short. Nothing was sent.', code: 'too-few-approvers' });
    t.approve = async (doors) => { await doors.service.startAccountCall(PAYROLL, {}); throw new Error('the answer was lost'); };
    /* RED WHEN: a stop after the approval was handed over to be sent says nothing was sent. */
    expect((await refusalOf(run(i, ctxOf(i).ctx))).key).toBe('act.approve-start.why.may-be-sent');
  });

  it('an approval the chain already counts is no refusal, and a round the chain shows done is refused as carried out', async () => {
    t.approve = async () => 'counted';
    const i = intent({ kind: 'adopt-vault' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: an approval the chain already counts stops the action, so the carrying out is never reached once the bar is met. */
    expect(acts()).toEqual(['opened', 'approve']);
    expect(told).toContainEqual({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
    t.approve = async () => 'carried-out';
    /* RED WHEN: a round another device carried out reads as approved here. */
    expect((await refusalOf(run(i, ctxOf(i).ctx))).key).toBe('act.approve-start.why.carried-out');
  });

  it('a round its record could not be written down for says so to the page, in a code the page words', async () => {
    t.opened.said = 'The vault\'s adoption is carried out on the chain, and the company\'s proposals still show it open.';
    t.carried = { state: 'carried-out', said: 'not written down' };
    const i = intent({ kind: 'adopt-vault' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: a record left open after the chain carried the proposal out is not told to the page. */
    expect(told.filter((x) => 'said' in x)).toEqual([{ said: 'proposal-not-written-down' }, { said: 'proposal-not-written-down' }]);
  });
});

describe('A NEW VAULT\'S FIRST SECRET RUN ANOTHER SIGNER RAISED IS APPROVED AND CARRIED OUT IN THE WALLET', () => {
  it('a second signer approves it and it is carried out once the chain counts the vault\'s bar', async () => {
    const i = intent({ kind: 'vault-secret' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    for (const c of t.shared) expect(c.named).toEqual({ vault: PAYROLL, round: 'first-secret', proposal: 'prp_1' });
    expect(acts()).toEqual(['opened', 'approve', 'carry']);
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('it is judged at the higher of its hold and the vault\'s own bar, plus each signer removed since its raise', async () => {
    company.vaultThresholds = [{ vault: PAYROLL, threshold: 2 }];
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 1, raisedAt: 1, removals: 1 };
    const i = intent({ kind: 'vault-secret' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: the run is carried out at the account's threshold or its hold, short of the vault's bar and the removals since. */
    expect(acts()).toEqual(['opened', 'approve']);
    expect(told).toContainEqual({ state: 'waiting-for-approvals', approvals: 2, needed: 3 });
  });

  it('a run the chain closed by setting its secret, with sealed copies still owed, is finished by the next press instead of refused', async () => {
    t.chain[CHAIN_ID] = { held: 'closed', approvals: 2, needed: 2, raisedAt: 1, closedBy: ['approveVaultChange'] };
    t.finished = { state: 'carried-out', said: null };
    const i = intent({ kind: 'vault-secret' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: a run cut off between the set and the last sealed copy is refused as carried out, and its copies are never written from the approval. */
    expect(acts()).toEqual(['opened', 'finish']);
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
    t.finished = null;
    /* RED WHEN: a run that closed without its secret set is told as carried out. */
    expect((await refusalOf(run(i, ctxOf(i).ctx))).key).toBe('act.approve-start.why.carried-out');
    /* RED WHEN: a closed adoption is taken through the first secret's finishing. */
    t.shared.length = 0;
    const a = intent({ kind: 'adopt-vault' });
    expect((await refusalOf(run(a, ctxOf(a).ctx))).key).toBe('act.approve-start.why.carried-out');
    expect(acts()).toEqual(['opened']);
  });

  it('the window shows the vault, the seats its secret is sealed to as the wallet read them, and the signers as the page names them', async () => {
    const shown = await approveProposalAction(reach() as never).shown(intent({ kind: 'vault-secret', readers: 'Ada, Bo' }));
    /* RED WHEN: the first secret is approved without the window showing the vault and who will hold its secret. */
    expect(shown).toContainEqual({ key: 'act.approve-start.shown.secret', values: { vault: PAYROLL }, from: 'page' });
    expect(shown).toContainEqual({ key: 'act.approve-start.shown.sealed-to', values: { seats: 3 }, from: 'wallet' });
    expect(shown).toContainEqual({ key: 'act.approve-start.shown.readers', values: { names: 'Ada, Bo' }, from: 'page' });
    /* RED WHEN: the window claims the wallet showed or checked the names the page sent, or that it showed every reader before approving. */
    expect(WORDS['act.approve-start.shown.readers']).toMatch(/names are the page's word; this wallet checks the keys, not the names/u);
    expect(WORDS['act.approve-start.shown.checks-secret']).not.toMatch(/shows the vault and each signer/u);
    expect(WORDS['act.approve-start.shown.sealed-to']).toMatch(/exactly those seats', each signed by that signer's own wallet and matched to the company's list of signers/u);
    const unread = await approveProposalAction(reach({ chain: () => ({ holders: async () => { throw new Error('no read'); } }) }) as never)
      .shown(intent({ kind: 'vault-secret' }));
    /* RED WHEN: a count of seats the wallet did not read is shown as read. */
    expect(unread.map((l) => l.key)).toContain('act.approve-start.shown.sealed-to-unread');
  });

  it('a vault the wallet cannot read as one, or a wallet that knows no indexer, approves nothing', async () => {
    /* RED WHEN: a round is passed on for a vault the page did not name as one. */
    expect(await approveProposalAction(reach() as never).check(intent({ kind: 'vault-secret', vault: 'zz' }), {} as never)).toMatchObject({ key: 'act.approve-start.why.not-a-vault' });
    expect(await approveProposalAction(reach() as never).check(intent({ kind: 'adopt-vault', vault: '' }), {} as never)).toMatchObject({ key: 'act.approve-proposal.why.not-a-proposal' });
    const i = intent({ kind: 'vault-secret' });
    /* RED WHEN: the readers are checked against a vault read at no indexer the wallet names. */
    expect((await refusalOf(run(i, ctxOf(i).ctx, reach({ indexerHttp: undefined })))).key).toBe('act.approve-start.why.not-approved');
    expect(acts()).toEqual([]);
  });
});

describe('THE WALLET ASKS THE PAGE ONLY FOR THE CALLS ITS ACT LISTS, IN WORDS IT HOLDS', () => {
  it('every word the start\'s approvals say is written, and every call they make is one the act lists', async () => {
    t.approve = async (doors) => {
      await doors.service.startAccountCall(PAYROLL, {});
      await doors.service.startSecret(PAYROLL, 'S');
      await doors.service.startCopy(PAYROLL, 'C', 0);
      return 'approved';
    };
    const i = intent({ kind: 'vault-secret' });
    await run(i, ctxOf(i).ctx);
    for (const path of ['/api/proposals/prp_1/carried']) t.called.push(`POST ${path}`);
    /* RED WHEN: a step of the vault's start, or writing it down, is a call the approval's act does not list. */
    for (const c of t.called) expect(routeOf(intentShapeOf('approve-proposal')!, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    const shown = [
      ...await approveProposalAction(reach() as never).shown(intent({ kind: 'adopt-vault' })),
      ...await approveProposalAction(reach() as never).shown(intent({ kind: 'vault-secret', readers: 'Ada' })),
    ];
    const source = readFileSync(new URL('./start-kinds.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/'(act\.approve-start\.[a-z.-]+)'/gu)].map((m) => m[1]!);
    const whys = [...source.matchAll(/[wW]hy\('([a-z-]+)'/gu)].map((m) => m[1]!);
    const stops = ['not-approved', 'may-be-sent', 'withdrawn', 'carried-out', 'already-counted', 'not-raised', 'outrun', 'not-carried'];
    /* RED WHEN: the wallet says a word its language file does not hold. */
    for (const k of [...keys, ...[...whys, ...stops].map((w) => `act.approve-start.why.${w}`), ...shown.map((l) => l.key)]) expect(WORDS[k], k).toBeTypeOf('string');
  });
});
