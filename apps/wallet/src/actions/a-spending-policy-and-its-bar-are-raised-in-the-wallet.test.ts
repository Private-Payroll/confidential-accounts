import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { signingPublicKeyOf } from '../../../../src/core/crypto.js';
import { StepRefused, type StepContext, type Words } from './definition.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../../src/testing/assets.js';

/*
 * **A SPENDING POLICY, AND THE APPROVALS ANY POLICY CHANGE NEEDS, ARE RAISED FROM THE WALLET.** The page names the
 * change; the wallet checks it, raises it with the person's seat through the shared code, stopped before it is carried
 * out, and a step of its own carries it out once the chain counts its bar. The shared code that files, raises and
 * carries out is stood in for here (it is followed in spending-policy-here.test.ts); so is the check of who may file a
 * spending policy (`mayFileHere`, followed in its own tests), which is watched for being asked, with what, and when.
 */

const t = vi.hoisted(() => ({
  onDevice: [] as Array<{ kind: string; doors: any; input: any }>,
  chain: {} as Record<string, any>,
  read: null as unknown,
  called: [] as string[],
  events: [] as string[],
  mayFile: [] as Array<{ key: string; kind: string }>,
  refusal: null as null | { why: string; says: string },
  raised: 'waiting-for-approvals',
}));
const CHAIN_ID = 'dd'.repeat(32);
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  seatsUnderARaisedRemovalHere: async () => new Set<string>(),
}));
vi.mock('../../../../packages/web-shared/src/may-file-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/may-file-here.js')>()),
  mayFileHere: async (read: () => Promise<unknown>, key: string, kind: string) => {
    await read();
    t.mayFile.push({ key, kind });
    t.events.push('may-file');
    return t.refusal;
  },
}));
vi.mock('../../../../packages/web-shared/src/spending-policy-here.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/spending-policy-here.js')>();
  /* The shared code: a raise files the proposal with the raiser's approval; a carrying out closes it. */
  const governed = (kind: string, doors: unknown, input: any) => {
    t.onDevice.push({ kind, doors, input });
    t.events.push(kind);
    const round = { id: 'prp_1', chainId: CHAIN_ID, status: 'open' };
    if (input.carryOnly) return { state: 'done', round };
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1, ...t.chain[CHAIN_ID] };
    return { state: t.raised, round };
  };
  return {
    ...actual,
    policyReadHere: async (_doors: unknown, input: any) => {
      t.onDevice.push({ kind: 'read', doors: _doors, input });
      t.events.push('read');
      return t.read;
    },
    setSpendingPolicyOnDevice: async (doors: unknown, input: any) => governed('set-spending-policy', doors, input),
    approveSpendingPolicyOnDevice: async (doors: unknown, input: any) => governed('spending-policy', doors, input),
    setPolicyBarOnDevice: async (doors: unknown, input: any) => governed('policy-bar', doors, input),
  };
});
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.events.push('upkeep'); await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.events.push('anchor'); await company.reach(c); } },
    }),
  };
});

const { setPolicyAction } = await import('./set-policy.js');

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const PAYROLL = 'ab'.repeat(32);
const SEATS = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
const SIGNING = '01'.repeat(32);
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const POLICY = {
  vault: PAYROLL, token: TEST_TOKEN, bands: '100:1,500:2,900:2,1000:3', periodLimit: '1000', periodStart: '0', periodLength: '2592000',
};
const TERMS = {
  bands: [{ ceiling: '100', approvals: '1' }, { ceiling: '500', approvals: '2' }, { ceiling: '900', approvals: '2' }, { ceiling: '1000', approvals: '3' }],
  periodLimit: '1000', periodStart: '0', periodLength: '2592000',
};
const intent = (name: string, fields: Record<string, string>): ActIntent => ({ name, fields: { ...BASE, ...fields } }) as ActIntent;

let company: { approvals: number; policyBar: number | null; seatBar: number };
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: SIGNING, wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: 'cc'.repeat(32) },
  leaf: SEATS[0], companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => { t.called.push(`${init?.method ?? 'GET'} ${path}`); return []; },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({
    seats: SEATS, committee: [], approvals: company.approvals, seatBar: company.seatBar, policyBar: company.policyBar,
    vaultThresholds: [], adoptedVaults: [PAYROLL], account: ACCOUNT,
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
    companyWide: async () => 'cc'.repeat(32),
    runsOutrun: async () => ({}),
  },
  chain: { indexer: {}, callState: async () => null },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, account: 0 }, at: { step: 3, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a policy change is sent through its calls, never a bare relay'); },
    call: async (method: string, path: string) => { t.called.push(`${method} ${path}`); return { status: 404, body: {} }; },
    tell: (x: Record<string, unknown>) => { told.push(x); },
    show: () => {},
    confirm: async () => { throw new Error('raising a policy asks for no second Confirm'); },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told };
};
const reach = () => ({ chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, reachFor: async () => reachOf() as never, assets: registryWithTestPrivateForms() });
const run = async (act: 'set-spending-policy' | 'set-policy-bar', i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of setPolicyAction(reach(), act).steps(i)) await step.run(ctx);
};
const refusalOf = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};
const handed = (kind: string) => t.onDevice.filter((c) => c.kind === kind);

beforeEach(() => {
  t.onDevice.length = 0;
  t.called.length = 0;
  t.events.length = 0;
  t.mayFile.length = 0;
  t.refusal = null;
  t.raised = 'waiting-for-approvals';
  t.chain = {};
  t.read = { chainId: CHAIN_ID, commitment: 'c5'.repeat(32), opening: { terms: TERMS, blinding: 'b5'.repeat(32) }, asset: TEST_TOKEN };
  company = { approvals: 2, policyBar: null, seatBar: 2 };
});

describe('A SPENDING POLICY IS RAISED FROM THE WALLET', () => {
  it('a raise filed from an admin\'s seat stops before the carrying out, and its own step carries it out once the chain counts two', async () => {
    t.chain = { [CHAIN_ID]: { held: 'open', approvals: 2, needed: 2, raisedAt: 1 } };
    t.raised = 'ready-to-carry';
    const i = intent('set-spending-policy', POLICY);
    const { ctx, told } = ctxOf(i);
    await run('set-spending-policy', i, ctx);
    /* RED WHEN: the page's policy is raised with other terms, another vault or currency, or carried out in the same call that raises it. */
    expect(handed('set-spending-policy').map((c) => c.input)).toEqual([expect.objectContaining({
      vault: PAYROLL, asset: TEST_TOKEN, terms: TERMS, stopBeforeCarry: true, before: expect.any(Function),
    })]);
    /* RED WHEN: the raise is checked for who may set a policy with another seat's key or against another kind of record, or after it is filed. */
    expect(t.mayFile[0]).toEqual({ key: signingPublicKeyOf(SIGNING as never), kind: 'spending-policy' });
    expect(t.events.slice(0, 3)).toEqual(['upkeep', 'may-file', 'set-spending-policy']);
    /* RED WHEN: the raise is handed a door that files no policy, so the policy's record is never written and the raise cannot open. */
    await expect(handed('set-spending-policy')[0]!.doors.records.spendingPolicies.file({})).rejects.not.toThrow(/files no spending policy/u);
    /* RED WHEN: the policy is carried out with terms the wallet did not read back from the company's records, or before the chain counts its bar. */
    expect(handed('read').map((c) => c.input)).toEqual([expect.objectContaining({ proposal: 'prp_1', vault: PAYROLL, among: [TEST_TOKEN] })]);
    expect(handed('spending-policy').map((c) => [c.input.proposal, c.input.approveOnly, c.input.carryOnly, c.input.terms])).toEqual([['prp_1', CHAIN_ID, true, TERMS]]);
    /* RED WHEN: the page is told the policy was carried out without the approvals the chain showed, or never told the proposal's name. */
    expect(told[0]).toEqual({ state: 'ready-to-carry', proposal: 'prp_1', approvals: 2, needed: 2 });
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
    expect(t.events.at(-1)).toBe('anchor');
  });

  it('one approval of two waits: nothing is carried out and the page is told where it stands', async () => {
    const i = intent('set-spending-policy', POLICY);
    const { ctx, told } = ctxOf(i);
    await run('set-spending-policy', i, ctx);
    /* RED WHEN: a policy is carried out with fewer approvals than the seat bar the chain asks for. */
    expect(handed('spending-policy')).toEqual([]);
    expect(told).toContainEqual({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
  });

  it('an approver\'s seat is refused before anything is filed or raised, in words that say the wallet will not', async () => {
    t.refusal = { why: 'role', says: 'whatever the shared check says' };
    const i = intent('set-spending-policy', POLICY);
    /* RED WHEN: a seat whose role does not set spending policies files or raises one. */
    expect(await refusalOf(run('set-spending-policy', i, ctxOf(i).ctx))).toBe('act.set-spending-policy.why.may-not-set');
    expect(handed('set-spending-policy')).toEqual([]);
    /* RED WHEN: the refusal says only some role may set policies, rather than what this wallet will not do. */
    expect(WORDS['act.set-spending-policy.why.may-not-set']).toMatch(/^Your wallet will not set a spending policy/u);
    expect(WORDS['act.set-spending-policy.why.may-not-set']).not.toMatch(/admin/iu);
  });

  it('who may set a policy is asked again before each send, so a seat whose role changed meanwhile sends nothing', async () => {
    const i = intent('set-spending-policy', POLICY);
    await run('set-spending-policy', i, ctxOf(i).ctx);
    const before = handed('set-spending-policy')[0]!.input.before as () => Promise<void>;
    t.refusal = { why: 'not-believed', says: 'not believed' };
    /* RED WHEN: who may set a policy is read once at the start, so a change made meanwhile is sent. */
    await expect(before()).rejects.toThrow(StepRefused);
  });

  it('a vault the company\'s account has not adopted is refused before anything is filed, with words naming what adopts it', async () => {
    const OTHER = 'ef'.repeat(32);
    const i = intent('set-spending-policy', { ...POLICY, vault: OTHER });
    /* RED WHEN: a policy is filed and raised for a vault the chain would never carry it out on. */
    expect(await refusalOf(run('set-spending-policy', i, ctxOf(i).ctx))).toBe('act.set-spending-policy.why.not-adopted');
    expect(handed('set-spending-policy')).toEqual([]);
    expect(WORDS['act.set-spending-policy.why.not-adopted']).toMatch(/adoption proposal .* approved and carried out/u);
  });

  it('a refusal of the seat made again after the policy is filed, or after the proposal is handed over, says what stands', async () => {
    const i = intent('set-spending-policy', POLICY);
    await run('set-spending-policy', i, ctxOf(i).ctx);
    const raised = handed('set-spending-policy')[0]!;
    const before = raised.input.before as () => Promise<void>;
    t.refusal = { why: 'role', says: 'no longer' };
    const keyOf = async (): Promise<string> => ((await before().then(() => null, (e: unknown) => e)) as StepRefused).words.key;
    /* RED WHEN: a refusal made after the policy's record may be filed says nothing was filed. */
    expect(await keyOf()).toBe('act.set-spending-policy.why.may-not-set-after-filing');
    await raised.doors.service.send('prp_1', {}).catch(() => undefined);
    /* RED WHEN: a refusal made after the proposal was handed over to be sent says nothing was sent. */
    expect(await keyOf()).toBe('act.set-spending-policy.why.may-not-set-after-sending');
    expect(WORDS['act.set-spending-policy.why.may-not-set-after-sending']).toMatch(/may already stand on the network with your approval/u);
    expect(WORDS['act.set-spending-policy.why.may-not-set-after-filing']).not.toMatch(/Nothing was filed/u);
  });

  it('a policy the page names wrongly is refused before the passkey, with the act\'s own words', async () => {
    const check = (fields: Record<string, string>) => setPolicyAction(reach(), 'set-spending-policy').check(intent('set-spending-policy', fields), {} as never);
    expect(await check(POLICY)).toBeNull();
    /* RED WHEN: a policy of three bands, of no period, for no vault, or in a currency this wallet does not know is passed on to be raised. */
    for (const [fields, key] of [
      [{ ...POLICY, bands: '100:1,500:2,900:2' }, 'not-a-policy'], [{ ...POLICY, periodLength: '0' }, 'not-a-policy'],
      [{ ...POLICY, vault: 'zz' }, 'not-a-policy'], [{ ...POLICY, bands: '100:1,500:0,900:2,1000:3' }, 'not-a-policy'],
      [{ ...POLICY, token: '0f'.repeat(32) }, 'not-a-known-currency'],
    ] as const) expect((await check(fields))?.key, JSON.stringify(fields)).toBe(`act.set-spending-policy.why.${key}`);
  });

  it('before the passkey the window shows the policy in the currency\'s own units and that the period starts again', async () => {
    const shown = await setPolicyAction(reach(), 'set-spending-policy').shown(intent('set-spending-policy', POLICY));
    /* RED WHEN: the person is asked to raise a policy whose ceilings are shown in the currency's smallest unit, or with no word that its period's total starts again. */
    expect(shown).toContainEqual({ key: 'act.approve-policy.shown.band', values: { n: 4, ceiling: '10.00', symbol: 'tPAY', approvals: '3' }, from: 'page' });
    expect(shown.map((l) => l.key)).toContain('act.approve-policy.shown.period-starts-again');
    expect(shown).toContainEqual({ key: 'act.set-spending-policy.shown.policy', values: { vault: PAYROLL, token: 'tPAY' }, from: 'page' });
  });
});

describe('THE APPROVALS ANY POLICY CHANGE NEEDS ARE RAISED FROM THE WALLET', () => {
  it('any seat raises a new bar, stopped before the carrying out, with no check of its role', async () => {
    t.chain = { [CHAIN_ID]: { held: 'open', approvals: 2, needed: 2, raisedAt: 1 } };
    t.raised = 'ready-to-carry';
    const i = intent('set-policy-bar', { bar: '2' });
    const { ctx, told } = ctxOf(i);
    await run('set-policy-bar', i, ctx);
    /* RED WHEN: a bar is raised for another number, or carried out in the same call that raises it. */
    expect(handed('policy-bar').map((c) => [c.input.newBar, c.input.seated, c.input.stopBeforeCarry, c.input.carryOnly]))
      .toEqual([[2, 3, true, undefined], [2, 3, undefined, true]]);
    /* RED WHEN: a bar is refused by the seat's role, though any seat may file a proposal. */
    expect(t.mayFile).toEqual([]);
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('a bar above the seats the chain holds is refused before anything is sent', async () => {
    const i = intent('set-policy-bar', { bar: '4' });
    /* RED WHEN: a bar no number of signers could ever reach is raised. */
    expect(await refusalOf(run('set-policy-bar', i, ctxOf(i).ctx))).toBe('act.set-policy-bar.why.too-many');
    expect(handed('policy-bar')).toEqual([]);
    expect((await setPolicyAction(reach(), 'set-policy-bar').check(intent('set-policy-bar', { bar: '0' }), {} as never))?.key).toBe('act.set-policy-bar.why.not-a-bar');
  });
});

describe('THE WINDOW SAYS WHAT THE NETWORK WRITES AND SHOWS, AND ONLY WHAT IT DOES', () => {
  it('each raise says what anyone can see on the network and what stays hidden', async () => {
    for (const [act, fields] of [['set-spending-policy', POLICY], ['set-policy-bar', { bar: '2' }]] as const) {
      const shown = await setPolicyAction(reach(), act).shown(intent(act, fields));
      /* RED WHEN: a change of policy is raised with no word of what the network makes public about it. */
      expect(shown, act).toContainEqual({ key: `act.${act}.shown.public`, from: 'action' });
    }
    expect(WORDS['act.set-spending-policy.shown.public']).toMatch(/this vault has a spending policy, the commitment to it.*bands, its limit and its period stay hidden/u);
    expect(WORDS['act.set-policy-bar.shown.public']).toMatch(/number of approvals any change to a spending policy needs/u);
  });

  it('the lines about the bar say it rises only when the policy\'s highest band is above it, and a carried approval writes the change', () => {
    /* RED WHEN: the window says carrying a policy out always raises the approvals, though the network raises them only when its highest band is higher. */
    expect(WORDS['act.approve-policy.shown.raises-the-seat-bar']).toMatch(/^If its highest band, \{approvals\}, is above .*otherwise it changes neither/u);
    expect(WORDS['act.approve-policy.shown.bar-below-a-band']).toMatch(/raises it again only when that policy's highest band is above it/u);
    /* RED WHEN: an approval that carries the change out is said to write nothing. */
    expect(WORDS['act.approve-policy.shown.approve']).toMatch(/the network writes it: for a spending policy, a sealed fingerprint of it, the mark that the vault has a policy/u);
    expect(WORDS['act.approve-policy.shown.approve']).not.toMatch(/raises nothing and writes no record/u);
    /* RED WHEN: the raise is said always to file a new record, though a version with the same terms already filed is used as it is. */
    expect(WORDS['act.set-spending-policy.shown.raise']).toMatch(/unless a version with exactly these terms, sealed to the same signers and readers, is already filed/u);
  });
});

describe('THE TWO ACTS ARE REGISTERED, ASK ONLY FOR THEIR CALLS, AND SAY ONLY WORDS THE WALLET HOLDS', () => {
  it('both are acts of the wallet, every call is one their shape lists, and every word is written', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost', origin: 'http://localhost' } });
    const { ACTIONS } = await import('./registry.js').finally(() => vi.unstubAllGlobals());
    /* RED WHEN: a page asks for a raise the wallet has no act for. */
    expect(typeof ACTIONS['set-spending-policy'].steps).toBe('function');
    expect(typeof ACTIONS['set-policy-bar'].steps).toBe('function');
    const i = intent('set-spending-policy', POLICY);
    await run('set-spending-policy', i, ctxOf(i).ctx);
    /* RED WHEN: the act asks the page for a call its shape does not list. */
    for (const c of t.called) expect(routeOf(intentShapeOf('set-spending-policy')!, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    expect(routeOf(intentShapeOf('set-spending-policy')!, 'PUT', '/api/accounts/acc_1/records/spending-policy/ab/2')).not.toBeNull();
    const source = readFileSync(new URL('./set-policy.ts', import.meta.url), 'utf8');
    const whys = [...source.matchAll(/why\('([a-z-]+)'/gu)].map((m) => m[1]!);
    const seat = ['no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened', 'not-a-company', 'refused', 'not-raised', 'may-be-sent'];
    for (const act of ['set-spending-policy', 'set-policy-bar'] as const) {
      const def = setPolicyAction(reach(), act);
      const fields = act === 'set-policy-bar' ? { bar: '2' } : POLICY;
      const keys: string[] = [
        def.headline, ...def.checks.map((c: Words) => c.key), ...def.steps(intent(act, fields)).map((s) => s.title.key),
        ...(await def.shown(intent(act, fields))).map((l) => l.key), ...seat.map((w) => `act.${act}.why.${w}`),
      ];
      /* RED WHEN: the wallet says a word its language file does not hold. */
      for (const k of keys.filter((k) => !k.startsWith('act.upkeep.'))) expect(WORDS[k], k).toBeTypeOf('string');
    }
    for (const w of whys) expect(WORDS[`act.set-spending-policy.why.${w}`] ?? WORDS[`act.set-policy-bar.why.${w}`], w).toBeTypeOf('string');
  }, 60_000);
});
