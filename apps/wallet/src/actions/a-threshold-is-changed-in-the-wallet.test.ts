import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **THE APPROVALS NEEDED ARE CHANGED FROM THE WALLET, ONE WINDOW EACH.** The company's threshold, or one vault's, is
 * raised by one signer and approved and carried out by another, through the shared code that proves and sends each call
 * (stood in for here, and followed against the chain in governed-call-on-device.test.ts). What is pinned: every check
 * is made from the chain and the company's records before anything is handed to the shared code, and handed to it again
 * for every send; the carrying out is a step of its own that reads the chain first; and the bar is the chain's.
 */

const t = vi.hoisted(() => ({
  onDevice: [] as Array<{ kind: string; input: any; doors: any }>,
  outcome: null as null | ((kind: string, input: any) => unknown),
  opened: null as unknown,
  chain: {} as Record<string, unknown>,
  called: [] as string[],
  outrun: {} as Record<string, number>,
  anchored: [] as string[],
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  changeThresholdOnDevice: async (doors: any, input: any) => { t.onDevice.push({ kind: 'threshold', input, doors }); return t.outcome!('threshold', input); },
  changeVaultThresholdOnDevice: async (doors: any, input: any) => { t.onDevice.push({ kind: 'vault-threshold', input, doors }); return t.outcome!('vault-threshold', input); },
}));
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  openTheRoundHere: async () => { if (t.opened instanceof Error) throw t.opened; return t.opened; },
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { await company.reach(c); } },
    }),
    anchorDirectoryDoorIn: (r: { accountId: string }, handed: { over: boolean }) => async () => { handed.over = true; t.anchored.push(r.accountId); },
  };
});

const { changeThresholdAction, ThresholdRefused } = await import('./change-threshold.js');
const { approveProposalAction } = await import('./approve-proposal.js');

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WIDE = 'cc'.repeat(32);
const PAYROLL = 'ab'.repeat(32);
const CHAIN_ID = 'dd'.repeat(32);
const RUN = 'de'.repeat(32);
const SEATS = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const raiserOnly = { mayApprove: false, everyVault: true, onVaults: [] };
const intent = (name: string, fields: Record<string, string>): ActIntent => ({ name, fields }) as ActIntent;

/* The company as this wallet reads it: three seats on the chain, the rights its directory holds for each, and the bars. */
let company: { approvals: number; policyBar: number | null; seatBar: number; vaultThresholds: { vault: string; threshold: number }[]; rights: (unknown | undefined)[]; proposals: unknown[] };
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: WIDE },
  leaf: SEATS[0], companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => {
    t.called.push(`${init?.method ?? 'GET'} ${path}`);
    return path === '/api/accounts/acc_1/proposals' ? company.proposals : [];
  },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({
    seats: SEATS, committee: [], approvals: company.approvals, seatBar: company.seatBar, policyBar: company.policyBar,
    vaultThresholds: company.vaultThresholds, adoptedVaults: [PAYROLL], account: ACCOUNT,
  }),
  judges: {
    /* Each seat believed with the rights the company gave it: every right unless a case gives it fewer. */
    directoryHereFor: () => async () => ({
      dir: { seats: SEATS.map((seat, i) => ({ seat, retired: null, rights: company.rights[i] ?? { every: true } })) }, records: { history: new Map() },
    }),
    leavesFor: () => async () => [],
    rosterReadsFor: () => ({}),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', notBelieved: [], signers: SEATS.map((leaf, i) => ({
    id: `s${i + 1}`, status: 'active', leafCommitment: leaf, ...(company.rights[i] === undefined ? {} : { rights: company.rights[i] }),
  })) }),
  builder: {
    roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => Object.fromEntries(chainIds.map((id) => [id, t.chain[id] ?? { held: 'never', approvals: 0 }])),
    companyWide: async () => WIDE,
    runsOutrun: async () => t.outrun,
  },
  chain: { indexer: {}, callState: async () => null },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, account: 0 }, at: { step: 3, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a threshold change is sent through its calls, never a bare relay'); },
    call: async (method: string, path: string) => { t.called.push(`${method} ${path}`); return { status: 404, body: {} }; },
    tell: (x: Record<string, unknown>) => { told.push(x); },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told };
};
const reach = () => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, secrets: () => ({}) as never,
  commitments: async () => ({}) as never, reachFor: async () => reachOf() as never,
});
const run = async (def: { steps(i: ActIntent): readonly { run(c: StepContext): Promise<void> }[] }, i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of def.steps(i)) await step.run(ctx);
};
const refusalOf = async (p: Promise<unknown>): Promise<{ key: string; says: string }> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return { key: (e as StepRefused).words.key, says: String((e as StepRefused).words.values?.['says'] ?? '') };
};
/* The shared code: a raise lands with this seat's approval; an approval adds one; a carrying out closes the proposal. */
const sharedCode = (_kind: string, input: any) => {
  const round = { id: 'prp_1', chainId: CHAIN_ID, status: 'open' };
  if (input.carryOnly) return { state: 'done', round };
  const standing = t.chain[CHAIN_ID] as { approvals: number; needed?: number };
  t.chain[CHAIN_ID] = input.approveOnly === undefined ? { held: 'open', approvals: 1, needed: company.approvals, raisedAt: 1 } : { ...standing, approvals: standing.approvals + 1 };
  return { state: (t.chain[CHAIN_ID] as { approvals: number }).approvals >= company.approvals ? 'ready-to-carry' : 'waiting-for-approvals', round };
};

beforeEach(() => {
  t.onDevice.length = 0;
  t.called.length = 0;
  t.outcome = sharedCode;
  t.opened = null;
  t.chain = {};
  t.outrun = {};
  t.anchored.length = 0;
  company = { approvals: 1, policyBar: null, seatBar: 1, vaultThresholds: [], rights: [undefined, undefined, undefined], proposals: [] };
});

describe('THE COMPANY\'S THRESHOLD IS RAISED IN THE WALLET, AND CARRIED OUT AT ITS BAR', () => {
  it('at a bar of one the raise is carried out in the same window, by the one carry step, after the chain is read again', async () => {
    company.seatBar = 2;
    const i = intent('change-threshold', { ...BASE, threshold: '2' });
    const { ctx, told } = ctxOf(i);
    await run(changeThresholdAction(reach()), i, ctx);
    /* RED WHEN: the raise carries the change out itself, or the carrying out is not asked for at all, at a bar of one. */
    expect(t.onDevice.map((c) => [c.kind, c.input.newThreshold, c.input.stopBeforeCarry, c.input.carryOnly, c.input.approveOnly]))
      .toEqual([['threshold', 2, true, undefined, undefined], ['threshold', 2, undefined, true, CHAIN_ID]]);
    /* RED WHEN: the seats the change is bounded by are the page's, not the three the chain holds. */
    expect(t.onDevice[0]!.input.seated).toBe(3);
    /* RED WHEN: the bar the page is told is the seat bar the company would need for a vault, not the approvals in force for the company's own threshold. */
    expect(told).toContainEqual({ state: 'carried-out', approvals: 1, needed: 1 });
  });

  it('at a bar of two the raise waits, and a second signer approves it and carries it out through the one approval', async () => {
    company.approvals = 2;
    company.seatBar = 3;
    const raise = intent('change-threshold', { ...BASE, threshold: '3' });
    const first = ctxOf(raise);
    await run(changeThresholdAction(reach()), raise, first.ctx);
    /* RED WHEN: a change short of its bar is carried out, or the page is not told it waits for the others. */
    expect(t.onDevice.map((c) => c.input.carryOnly)).toEqual([undefined]);
    expect(first.told).toContainEqual({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
    t.onDevice.length = 0;
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'threshold', threshold: '3' } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'threshold', threshold: '3' });
    const second = ctxOf(approve);
    await run(approveProposalAction(reach() as never), approve, second.ctx);
    /* RED WHEN: the approval carries the change out in the same call, or no step carries it out once the chain counts two. */
    expect(t.onDevice.map((c) => [c.input.approveOnly, c.input.stopBeforeCarry, c.input.carryOnly]))
      .toEqual([[CHAIN_ID, true, undefined], [CHAIN_ID, undefined, true]]);
    expect(second.told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('a proposal under the name the page gave that changes anything else is not approved', async () => {
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1 };
    company.approvals = 2;
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'threshold', threshold: '1' } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'threshold', threshold: '3' });
    /* RED WHEN: a proposal is approved on the page's word of what it changes, not on the record this wallet opened. */
    expect((await refusalOf(run(approveProposalAction(reach() as never), approve, ctxOf(approve).ctx))).key).toBe('act.change-threshold.why.not-as-shown');
    expect(t.onDevice).toEqual([]);
  });
});

describe('A THRESHOLD CHANGE THAT BREAKS A RULE IS REFUSED BEFORE ANYTHING IS BUILT', () => {
  it('a raise that would leave a vault unable to pay, or ask for more approvals than the seats, is refused and nothing is handed on', async () => {
    company.rights = [undefined, raiserOnly, raiserOnly];
    for (const [threshold, says] of [['2', /unable to pay/u], ['4', /more approvals than the 3 signers/u]] as const) {
      const i = intent('change-threshold', { ...BASE, threshold });
      const refused = await refusalOf(run(changeThresholdAction(reach()), i, ctxOf(i).ctx));
      /* RED WHEN: a change the chain would refuse when carried out, or one that leaves a vault unable to pay, is handed on to be built. */
      expect(refused.key).toBe('act.change-threshold.why.refused');
      expect(refused.says).toMatch(says);
    }
    expect(t.onDevice).toEqual([]);
    expect(t.called.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('signers removed since an open run was raised are counted against every vault, read from the chain whatever any list says, and the refusal names the run', async () => {
    const i = intent('change-threshold', { ...BASE, threshold: '3', vault: PAYROLL });
    /* The service lists no proposal at all; the chain holds the run open, one removal after its raise. */
    t.outrun = { [RUN]: 1 };
    const refused = await refusalOf(run(changeThresholdAction(reach()), i, ctxOf(i).ctx));
    /* RED WHEN: a run the service leaves out is not counted, and a raise leaves it unable ever to be paid. */
    expect(refused.says).toMatch(/its runs need 4 approvals and 3 signers/u);
    /* RED WHEN: the refusal does not name the run whose withdrawal or raise again resolves it. */
    expect(refused.says).toContain(`removed since run ${RUN} was raised`);
    company.proposals = [{ id: 'prp_run', chainId: RUN, accountId: 'acc_1', status: 'open' }];
    expect((await refusalOf(run(changeThresholdAction(reach()), i, ctxOf(i).ctx))).says).toContain(`run prp_run (${RUN}) was raised`);
    expect(t.onDevice).toEqual([]);
    t.outrun = {};
    await run(changeThresholdAction(reach()), i, ctxOf(i).ctx);
    expect(t.onDevice.map((c) => [c.kind, c.input.vault])).toEqual([['vault-threshold', PAYROLL], ['vault-threshold', PAYROLL]]);
  });

  it('the window says what carrying the change out does beyond the number, and its checks claim only what is checked', async () => {
    const shownOf = async (fields: Record<string, string>) => (await changeThresholdAction(reach()).shown(intent('change-threshold', { ...BASE, ...fields }))).map((l) => l.key);
    /* RED WHEN: a vault raised past the bar for seat changes is shown only as the vault's own number, or every signer is asked with no word of a lost key. */
    expect(await shownOf({ threshold: '3', vault: PAYROLL })).toEqual(expect.arrayContaining(['act.change-threshold.shown.raises-the-seat-bar', 'act.change-threshold.shown.every-signer-vault']));
    expect(await shownOf({ threshold: '3' })).toContain('act.change-threshold.shown.every-signer');
    const approving = await approveProposalAction(reach() as never).shown(intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'vault-threshold', vault: PAYROLL, threshold: '3' }));
    expect(approving.map((l) => l.key)).toEqual(expect.arrayContaining(['act.change-threshold.shown.raises-the-seat-bar', 'act.change-threshold.shown.every-signer-vault']));
    /* RED WHEN: the window says one lost key stops nothing, or claims a vault not added is refused, or that the policy bands are counted. */
    expect(WORDS['act.change-threshold.shown.every-signer-vault']).toMatch(/one lost key leaves this vault unable to pay, and no signer can be added or removed/u);
    expect(WORDS['act.change-threshold.check.chain']).toMatch(/has not added can be given no more approvals than adding or removing a signer needs/u);
    expect(WORDS['act.change-threshold.check.vaults']).toMatch(/bands ask for are not counted/u);
  });

  it('every send of a threshold change can anchor the company\'s directory first, so a rise never waits for another device to anchor it', async () => {
    company.approvals = 2;
    const raise = intent('change-threshold', { ...BASE, threshold: '2' });
    await run(changeThresholdAction(reach()), raise, ctxOf(raise).ctx);
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'threshold', threshold: '2' } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'threshold', threshold: '2' });
    await run(approveProposalAction(reach() as never), approve, ctxOf(approve).ctx);
    expect(t.onDevice.length).toBeGreaterThanOrEqual(2);
    /* RED WHEN: the raise, the approval or the carrying out is handed doors that cannot anchor the directory, so a rise refuses instead. */
    for (const c of t.onDevice) {
      expect(typeof c.doors.anchorDirectory, c.kind).toBe('function');
      t.anchored.length = 0;
      await c.doors.anchorDirectory();
      expect(t.anchored).toEqual(['acc_1']);
    }
  });

  it('the same check is handed to the shared code, which runs it before every send', async () => {
    const i = intent('change-threshold', { ...BASE, threshold: '2' });
    await run(changeThresholdAction(reach()), i, ctxOf(i).ctx);
    company.rights = [undefined, raiserOnly, raiserOnly];
    /* RED WHEN: the check before a send is not the one the raise made, and a company changed since passes it. */
    for (const c of t.onDevice) await expect(c.input.before()).rejects.toBeInstanceOf(ThresholdRefused);
  });
});

describe('A VAULT\'S THRESHOLD IS JUDGED AT THE BAR THE CHAIN CARRIES IT OUT AT', () => {
  it('a vault lowered needs the seat bar: two approvals wait while the account stores a policy bar of three', async () => {
    Object.assign(company, { approvals: 2, policyBar: 3, seatBar: 3, vaultThresholds: [{ vault: PAYROLL, threshold: 2 }] });
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1 };
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'vault-threshold', vault: PAYROLL, threshold: '1' } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'vault-threshold', vault: PAYROLL, threshold: '1' });
    const { ctx, told } = ctxOf(approve);
    await run(approveProposalAction(reach() as never), approve, ctx);
    /* RED WHEN: a vault lowered is carried out at the account's threshold, below the seat bar the chain asks for. */
    expect(t.onDevice.map((c) => c.input.carryOnly)).toEqual([undefined]);
    expect(told).toContainEqual({ state: 'waiting-for-approvals', approvals: 2, needed: 3 });
  });
});

describe('THE WALLET ASKS THE PAGE ONLY FOR THE CALLS EACH ACT LISTS, IN WORDS IT HOLDS', () => {
  it('every call a raise, an approval and a carrying out make is one its act lists, and every word it says is written', async () => {
    const i = intent('change-threshold', { ...BASE, threshold: '2' });
    await run(changeThresholdAction(reach()), i, ctxOf(i).ctx);
    const carry = '/api/proposals/:proposal/carry';
    for (const name of ['change-threshold', 'approve-proposal']) {
      /* RED WHEN: the act cannot carry a change out because its route is not one the page lets it call. */
      expect(routeOf(intentShapeOf(name as never)!, 'POST', carry.replace(':proposal', 'prp_1')), name).not.toBeNull();
    }
    for (const c of t.called) expect(routeOf(intentShapeOf('change-threshold')!, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    const source = readFileSync(new URL('./change-threshold.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/'(act\.change-threshold\.[a-z.-]+)'/gu)].map((m) => m[1]!);
    const whys = [...source.matchAll(/[wW]hy\('([a-z-]+)'/gu)].map((m) => m[1]!);
    expect(whys).toContain('not-as-shown');
    const stops = ['not-approved', 'may-be-sent', 'withdrawn', 'carried-out', 'already-counted', 'not-raised', 'outrun', 'not-carried', 'refused'];
    /* RED WHEN: the wallet says a word its language file does not hold. */
    for (const k of [...keys, ...[...whys, ...stops].map((w) => `act.change-threshold.why.${w}`)]) expect(WORDS[k], k).toBeTypeOf('string');
  });
});
