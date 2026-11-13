/**
 * **A VAULT'S RETIRE IN THE WALLET**: raised from the wallet's own act, and approved and carried out through the one
 * approval, each step through the shared retire round, which is stood in here so what the wallet hands it and makes of
 * its answers is read exactly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

const t = vi.hoisted(() => ({
  shared: [] as Array<{ act: string; doors: any; named: any }>,
  chain: {} as Record<string, any>,
  raised: null as null | Error,
  carried: { state: 'carried-out', said: null } as { state: string; said: string | null },
  called: [] as string[],
  handOver: undefined as unknown,
  raisedHanded: false,
}));
const CHAIN_ID = 'dd'.repeat(32);
vi.mock('../../../../packages/web-shared/src/vault-retire-round.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/vault-retire-round.js')>();
  const found = (named: { proposal: string }) => ({ rec: { id: named.proposal }, round: { chainId: CHAIN_ID }, onChain: t.chain[CHAIN_ID] });
  return {
    ...actual,
    retireFoundHere: async (doors: unknown, named: { proposal: string }) => { t.shared.push({ act: 'opened', doors, named }); return found(named); },
    retireRaisedHere: async (doors: unknown, vault: string) => {
      t.shared.push({ act: 'raise', doors, named: vault });
      if (t.raisedHanded) await (doors as { handOver: { toChain: (tx: string, call: unknown) => Promise<void> } }).handOver.toChain('RETIRE', { kind: 'vault-retire', contract: vault, circuit: 'retire' });
      if (t.raised !== null) throw t.raised;
      t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: company.approvals, raisedAt: 1 };
      return { found: found({ proposal: 'prp_9' }), said: null };
    },
    approveRetireHere: async (doors: unknown, named: unknown) => {
      t.shared.push({ act: 'approve', doors, named });
      t.chain[CHAIN_ID] = { ...t.chain[CHAIN_ID], approvals: t.chain[CHAIN_ID].approvals + 1 };
      return 'approved';
    },
    carryRetireHere: async (doors: unknown, named: unknown) => { t.shared.push({ act: 'carry', doors, named }); return t.carried; },
  };
});
vi.mock('./vault-doors-here.js', async (real) => ({
  ...(await real<typeof import('./vault-doors-here.js')>()),
  vaultDoorsFor: () => ({ service: {}, approvers: async () => ({}), ...(t.handOver === undefined ? {} : { handOver: t.handOver }) }),
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
const { retireDoorsFor, retireVaultAction } = await import('./retire-vault.js');
const { RetireRefused } = await import('../../../../packages/web-shared/src/vault-retire-round.js');
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WIDE = 'cc'.repeat(32);
const PAYROLL = 'ab'.repeat(32);
const SEATS = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
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
    /* The directory as this wallet believes it: every seat the chain holds, with every right. */
    directoryHereFor: () => async () => ({ dir: { seats: SEATS.map((seat) => ({ seat, retired: null, rights: { every: true } })) }, records: { history: new Map() } }),
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
  indexerHttp: 'https://indexer.example/api/v3/graphql',
  inFlight: () => ({ deposits: { get: async () => null }, payments: { get: async () => null } }), ...over,
});
const run = async (i: ActIntent, ctx: StepContext, r = reach()): Promise<void> => {
  for (const step of approveProposalAction(r as never).steps(i)) await step.run(ctx);
};
const acts = () => t.shared.map((c) => c.act);
const runAct = async (i: ActIntent, ctx: StepContext, r = reach()): Promise<void> => {
  for (const step of retireVaultAction(r as never).steps(i)) await step.run(ctx);
};

beforeEach(() => {
  t.shared.length = 0;
  t.called.length = 0;
  t.raised = null;
  t.carried = { state: 'carried-out', said: null };
  t.chain = { [CHAIN_ID]: { held: 'open', approvals: 1, needed: 2, raisedAt: 1 } };
  company = { approvals: 2, vaultThresholds: [] };
  t.handOver = undefined;
  t.raisedHanded = false;
});

describe('A VAULT\'S RETIRE IN THE WALLET', () => {
  it('another signer\'s retire is approved through the one approval and carried out by a step of its own at the company\'s threshold', async () => {
    const i = intent({ kind: 'retire-vault' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: a retire cannot be approved from the wallet, or nothing carries it out once the chain counts the company's threshold. */
    expect(acts()).toEqual(['opened', 'approve', 'carry']);
    /* RED WHEN: the retire approved or carried out is not the one the window showed. */
    for (const c of t.shared) expect(c.named).toEqual({ vault: PAYROLL, proposal: 'prp_1' });
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('raised from the wallet, its raiser\'s approval counted, it waits for the rest and sends nothing more', async () => {
    const i = intent({});
    const { ctx, told } = ctxOf(i);
    await runAct(i, ctx);
    /* RED WHEN: a retire short of the company's threshold is carried, or the raise is not the vault the window showed. */
    expect(acts()).toEqual(['raise']);
    expect(t.shared[0]!.named).toBe(PAYROLL);
    expect(told).toContainEqual({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
  });

  it('raised where the raiser\'s approval meets the threshold, it is carried out in the same act under the record the raise found', async () => {
    company = { approvals: 1, vaultThresholds: [] };
    const i = intent({});
    const { ctx } = ctxOf(i);
    await runAct(i, ctx);
    /* RED WHEN: a retire already at its bar is left for another press, or carried under the name the page gave instead of the record raised. */
    expect(acts()).toEqual(['raise', 'carry']);
    expect(t.shared[1]!.named).toEqual({ vault: PAYROLL, proposal: 'prp_9' });
  });

  it('a raise the retire round refuses is told in its own words, and as nothing sent', async () => {
    t.raised = new RetireRefused('this vault still holds 1 note(s) of private money. Nothing was sent. Pay them out of the vault, then retire it.');
    const i = intent({});
    const { ctx } = ctxOf(i);
    const e = await runAct(i, ctx).then(() => null, (x: unknown) => x);
    /* RED WHEN: a refusal before anything was sent is told as one that may have been sent, or loses what clears it. */
    expect(e).toBeInstanceOf(StepRefused);
    expect((e as StepRefused).words).toMatchObject({ key: 'act.retire-vault.why.not-raised', values: { says: expect.stringMatching(/Pay them out of the vault/u) } });
  });

  it('a refusal starts its sentence in capitals, and one that stopped after the retire was handed over says Press again once', async () => {
    const i = intent({});
    t.raised = new Error('the network did not answer. Press again in a minute.');
    t.raisedHanded = true;
    t.handOver = { path: 'chain', toChain: async () => {} };
    const { ctx } = ctxOf(i);
    const e = await runAct(i, ctx).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(StepRefused);
    const said = (e as StepRefused).words;
    /* RED WHEN: the words a person reads start in lower case, or tell them to press again twice. */
    expect(said.key).toBe('act.retire-vault.why.may-be-sent');
    expect(String(said.values?.['says'])).toBe('The network did not answer.');
    const shown = WORDS[said.key]!.replace('{says}', String(said.values?.['says']));
    expect(shown.match(/Press again/gu)).toHaveLength(1);
    expect(shown).toMatch(/^The retire stopped after it was handed over to be sent\. The network did not answer\. Press again/u);
  });
});

describe('THE DOORS A RETIRE ACTS THROUGH IN THE WALLET', () => {
  it('a call taking a token off the vault\'s list goes the retire\'s one way and is counted apart, never marking the retire handed over, and only the circuits this wallet proves are said proved', async () => {
    const sentBy: string[] = [];
    t.handOver = { path: 'chain', toChain: async (_tx: string, call: { kind: string }) => { sentBy.push(call.kind); } };
    const handed: { over: boolean; before?: number } = { over: false };
    const doors = retireDoorsFor(ctxOf(intent({})).ctx, reachOf() as never, reach() as never, handed);
    await doors.handOver!.toChain!('FORGET', { kind: 'vault-forget', contract: PAYROLL, circuit: 'forgetUnshielded' });
    /* RED WHEN: sending a call that takes a token off the list marks the retire handed over, so a later stop is told as the retire maybe sent. */
    expect([sentBy, handed]).toEqual([['vault-forget'], { over: false, before: 1 }]);
    await doors.handOver!.toChain!('RETIRE', { kind: 'vault-retire', contract: PAYROLL, circuit: 'retire' });
    expect(handed).toEqual({ over: true, before: 1 });
    /*
     * RED WHEN: the retire is told this wallet can send a call it holds no proving key for, so it starts what it then
     * cannot finish; or is told it cannot send one it can. Edit this line on purpose once the keys for the vault's
     * retire and for taking a token off its list are carried by the wallet.
     */
    expect(['retire', 'forgetUnshielded', 'deposit'].map((c) => doors.proves!(c))).toEqual([false, false, true]);
  });

  it('the real retire, given the wallet\'s own doors, stops before anything is read, raised or sent, in words that say what clears it', async () => {
    const real = await vi.importActual<typeof import('../../../../packages/web-shared/src/vault-retire-round.js')>('../../../../packages/web-shared/src/vault-retire-round.js');
    const sentBy: string[] = [];
    t.handOver = { path: 'chain', toChain: async (_tx: string, call: { kind: string }) => { sentBy.push(call.kind); } };
    const handed = { over: false };
    const doors = retireDoorsFor(ctxOf(intent({})).ctx, reachOf() as never, reach() as never, handed);
    /* RED WHEN: a wallet that holds no key for the vault's retire raises one, spending approvals on a retire it could never carry out. */
    await expect(real.retireRaisedHere(doors, PAYROLL as never)).rejects.toThrow(/^This wallet cannot retire this vault yet\. It needs an update first\. Nothing was sent\.$/u);
    expect([sentBy, handed.over, t.called]).toEqual([[], false, []]);
  });

  it('a retire approved through the one approval reads the deposits on their way from its own store, never from a payment\'s store in the same reach', async () => {
    const depositOnItsWay = { get: async () => ({ vault: PAYROLL }) };
    const shared = reach({
      kept: () => ({ payments: { get: async () => null }, charges: { get: async () => null } }),
      inFlight: () => ({ deposits: depositOnItsWay, payments: { get: async () => null } }),
    });
    const doors = retireDoorsFor(ctxOf(intent({})).ctx, reachOf() as never, shared as never, { over: false });
    /* RED WHEN: a retire takes the one-off payment's store for its own, finds no deposits there, and retires a vault with a deposit still on its way into it. */
    expect(doors.inFlight?.deposits).toBe(depositOnItsWay);
  });
});
