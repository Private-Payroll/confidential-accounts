import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent, type ActRequest } from 'midnight-identity/profile/request';
import type { ActingChannel } from 'midnight-identity/profile/channel';
import { newWrappingKeypair, signingPublicKeyOf } from '../../../../src/core/crypto.js';
import { formatAmount } from '../../../../src/core/assets.js';
import { PUBLIC_PAYMENT_SAYS } from '../../../../src/core/movement.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../../src/testing/assets.js';
import { payeeFor } from '../../../../src/testing/payees.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A PAYROLL RUN IS RAISED IN THE WALLET, IN ONE WINDOW, FROM ITS OWN READS; AND APPROVED THROUGH THE ONE APPROVAL.**
 * The shared raise and approval are stood in for here; what is pinned is what the wallet hands them: the run it opened
 * and checked against what the page showed, a window that opens after now, the one records door with this wallet's
 * own reads, the account's circuits and a fresh salt for every raise. The draw is run for real, and what it sends the
 * service is read for anything in the clear.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  doors: [] as any[],
  inputs: [] as any[],
  run: null as unknown,
  rounds: [] as unknown[],
  people: null as unknown,
  draw: null as null | ((doors: any, asked: any) => Promise<unknown>),
  file: null as null | ((doors: any, run: any) => Promise<unknown>),
  confirmed: [] as unknown[][],
  answer: true,
  standing: { held: 'open', approvals: 1, needed: 2, raisedAt: 1, approvedHere: false } as Record<string, unknown>,
  opened: null as unknown,
  sealed: null as unknown,
  filed: null as unknown,
  dropAfterHanding: false,
}));
const stand = (name: string) => async (doors: any, input: any) => {
  t.calls.push(name); t.doors.push(doors); t.inputs.push(input);
  if (t.dropAfterHanding) {
    const id = doors.filing.newId();
    await doors.service.send(id, { tx: 'T', version: 1, filer: 'f' });
    throw new Error('the node dropped the connection');
  }
  return { id: input.proposalId ?? 'prp_raised', chainId: 'ab'.repeat(32), status: 'open', raisedAt: 'now' };
};
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  raiseRunOnDevice: stand('raise'),
  raiseRetryOnDevice: stand('raise-retry'),
  sendRaiseFromDevice: stand('send-raise'),
  sendRetryFromDevice: stand('send-retry'),
  approveOnDevice: async (doors: any, input: any) => { t.calls.push('approve'); t.doors.push(doors); t.inputs.push(input); return input.round; },
}));
vi.mock('../../../../packages/web-shared/src/run-rebuilt-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/run-rebuilt-here.js')>()),
  keptRunHere: async (_records: unknown, _account: string, runId: string) => {
    t.calls.push(`open ${runId}`);
    if (t.run === null) throw new Error('This company\'s records hold no payroll run by that name');
    /* As this seat filed it, unless a test serves another filer; `'filed'` reads back the run the raise just filed. */
    return { sealed: t.sealed ?? { filedBy: { publicKey: OWN_KEY } }, run: t.run === 'filed' ? t.filed : t.run };
  },
  payrollRoundsHere: () => t.rounds,
}));
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  openTheRoundHere: async () => { t.calls.push('opened'); return t.opened; },
}));
vi.mock('../../../../packages/web-shared/src/run-drawn-here.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/run-drawn-here.js')>();
  return {
    ...actual,
    runDrawnHere: (doors: any, asked: any) => { t.calls.push(`draw ${asked.period}`); return (t.draw ?? actual.runDrawnHere)(doors, asked); },
    /* A run stood in for by `t.draw` is filed as it is; a run drawn for real is filed for real. */
    fileRunDrawnHere: (doors: any, run: any) => {
      t.calls.push(`file ${run.id}`); t.filed = run;
      return (t.file ?? (t.draw === null ? actual.fileRunDrawnHere : async (_d: unknown, r: unknown) => r))(doors, run);
    },
  };
});
vi.mock('../../../../packages/web-shared/src/people-read-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/people-read-here.js')>()),
  readPeopleHere: async () => t.people,
}));
vi.mock('../../../../packages/web-shared/src/record-entered-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/record-entered-here.js')>()),
  recordsEnteredFor: () => ({ enter: async () => { t.calls.push('entered'); } }),
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.calls.push('upkeep-first'); await company.reach(c); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.calls.push('upkeep-last'); await company.reach(c); } },
    }),
  };
});

const { raiseRunAction } = await import('./raise-run.js');
const { ActionStopped, runAction } = await import('./run.js');
const { apiOver } = await import('./company-reach.js');
/* A draw as the page asks it: no run named, so no people or total. */
const DRAW_OF_THE_PAGE = { run: undefined, payees: undefined, total: undefined };
const { readOutcome } = await import('midnight-identity/profile/channel');
const { pureCircuits: P } = await import('../../../../contracts/managed/contract/index.js');
const { approveProposalAction } = await import('./approve-proposal.js');
/* No removal is carried out in these tests: the hook that changes the vault secrets after one is never reached. */
const AFTER_A_REMOVAL = { afterCarried: async (): Promise<never> => { throw new Error('no removal is carried out here'); } };

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const VAULT = 'de'.repeat(32);
const NET = 'undeployed' as const;
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const SEAT = { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) };
/* This seat's filing key, as a run it filed names it. */
const OWN_KEY = signingPublicKeyOf(SEAT.signingSecret as never);
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const LEG = `${TEST_TOKEN}:shielded`;
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const DIGEST = '5d'.repeat(32);
const SALT = '5a'.repeat(32);
/** The proposal as its own sealed record names it: its vault, payload and salt make its identity on the chain. */
const OPENED = (vault: string) => ({ digest: DIGEST, vault, salt: SALT, chainId: hexOf((P as any).proposalIdOf(Buffer.from(DIGEST, 'hex'), Buffer.from(vault, 'hex'), Buffer.from(SALT, 'hex'))) });

const intent = (fields: Record<string, string | undefined> = {}): ActIntent => ({
  name: 'raise-run',
  fields: Object.fromEntries(Object.entries({
    record: 'acc_1', company: LABEL, account: ACCOUNT, run: 'run_1', period: '2027-01', vault: VAULT, token: TEST_TOKEN, form: 'private',
    payees: '2', total: '300', opensAt: String(NOW + 3600), closesAt: String(NOW + 86_400), ...fields,
  }).filter(([, v]) => v !== undefined)) as Record<string, string>,
}) as ActIntent;

const employee = (id: string, amount: bigint) => ({ id, name: `Person ${id}`, wrappingPublicKey: null, asset: TEST_TOKEN, amount });
const RUN = (over: Record<string, unknown> = {}) => ({
  id: 'run_1', accountId: 'acc_1', period: '2027-01', status: 'draft', totals: {}, proposalIds: {},
  employees: [employee('e1', 100n), employee('e2', 200n)], payslips: [], ...over,
});
const RAISED = RUN({
  status: 'proposed', proposalIds: { [LEG]: 'prp_leg' },
  payout: { [LEG]: { vault: VAULT, opensAt: BigInt(NOW + 3600), closesAt: BigInt(NOW + 86_400), retries: [
    { originalIndices: [1], vault: VAULT, opensAt: BigInt(NOW + 3600), closesAt: BigInt(NOW + 86_400), proposalId: 'prp_retry' },
  ] } },
});

const ctxWith = (i: ActIntent) => {
  const told: Record<string, unknown> = {};
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 3, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a run is raised through its calls, never a bare relay'); },
    call: async () => ({ status: 200, body: {} }),
    tell: (o: Record<string, unknown>) => { Object.assign(told, o); }, keyring: null,
    /* As the runner answers: Confirm goes on, Stop ends the action with nothing after it run. */
    confirm: async (lines: readonly unknown[]) => {
      t.calls.push('confirm'); t.confirmed.push([...lines]);
      if (!t.answer) throw new ActionStopped('stopped');
    },
  } as unknown as StepContext;
  return { ctx, told };
};
const sent: Array<{ path: string; body: string }> = [];
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32),
  stepTo: () => {},
  api: async (path: string, init?: RequestInit) => {
    if (path.endsWith('/standing')) return { id: 'prp_leg', chainId: (t.opened as { chainId?: string } | null)?.chainId ?? 'ab'.repeat(32), status: 'open' };
    if (init?.method === 'POST') sent.push({ path, body: String(init.body) });
    return [];
  },
  send: async () => ({ status: 200, body: {} }),
  holders: async () => ({ seats: ['aa'.repeat(32)], committee: [], threshold: 1, approvals: 1, vaultThresholds: [{ vault: VAULT, threshold: 2 }], adoptedVaults: [VAULT], account: ACCOUNT }),
  judges: {
    /* A directory that names no record: the company has no runs or proposals yet, and every kind was asked whole. */
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { asked: { kinds: { has: () => true } }, history: new Map(), notYetAnchored: [] } }),
    filingJudgeFor: () => async () => null, leavesFor: () => async () => [],
    keysFoundFor: async () => ({}),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', signers: [], policy: { threshold: 1, limitsByRole: {} } }),
  builder: { roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => Object.fromEntries(chainIds.map((id) => [id, t.standing])) },
  chain: {
    indexer: { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' },
    callState: async () => ({ blockHash: 'b'.repeat(64), accountState: 'AS', parameters: 'PP' }),
    payments: async (_a: string, _l: string, entries: string[]) => ({ payKeyCommitment: null, held: [], openRounds: [], entries: entries.length }),
    roles: async () => [],
  },
});
const reach = {
  chain: () => ({}) as never, builder: () => ({}) as never, now: () => NOW_MS, pause: async () => {}, secrets: () => ({}) as never,
  reachFor: async () => reachOf() as never, assets: registryWithTestPrivateForms(), network: NET, waitMs: 3, everyMs: 1,
  kept: () => ({ payments: {} as never, charges: {} as never }),
};
const action = () => raiseRunAction(reach);
const run = async (i: ActIntent) => {
  const steps = action().steps(i);
  const { ctx, told } = ctxWith(i);
  for (const s of steps) await s.run(ctx);
  return told;
};
const refusedWith = async (i: ActIntent): Promise<string> => {
  const e = await run(i).then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};
const raised = () => t.calls.filter((c) => /^(raise|send)/u.test(c));

beforeEach(() => {
  t.calls = []; t.doors = []; t.inputs = []; t.run = RUN(); t.opened = null; t.dropAfterHanding = false; t.rounds = []; t.draw = null; t.file = null; t.people = null; sent.length = 0; t.sealed = null; t.filed = null;
  t.confirmed = []; t.answer = true;
  t.standing = { held: 'open', approvals: 1, needed: 2, raisedAt: 1, approvedHere: false };
});

describe('THE WINDOW SHOWS THE RUN AS THE PAGE GAVE IT, AND WHAT ITS FORM MAKES PUBLIC, BEFORE THE PASSKEY', () => {
  it('names the page\'s words as the page\'s, and says what the wallet does after the passkey', async () => {
    const keys = (await action().shown(intent())).map((l) => [l.key, l.from]);
    /* RED WHEN: the month, people, total, vault or window is shown as something the wallet read itself. */
    for (const k of ['run', 'list-employees', 'period', 'payees', 'total', 'vault', 'window']) expect(keys, k).toContainEqual([`act.raise-run.shown.${k}`, 'page']);
    /* RED WHEN: a vendors' run is shown as paying the employees, or a raise sent again hides its window. */
    expect((await action().shown(intent({ list: 'vendors' }))).map((l) => l.key)).toContain('act.raise-run.shown.list-vendors');
    expect((await action().shown(intent({ proposal: 'prp_leg' }))).map((l) => l.key)).toContain('act.raise-run.shown.window');
    /* RED WHEN: the window does not say the run is opened after the passkey and must be what it shows. */
    for (const k of ['private', 'matched', 'raise', 'nothing-else']) expect(keys, k).toContainEqual([`act.raise-run.shown.${k}`, 'action']);
    /* RED WHEN: a public run is shown without the sentence the product says wherever a person is paid publicly. */
    expect((await action().shown(intent({ form: 'public' }))).map((l) => l.key)).toContain('act.raise-run.shown.public');
    expect(WORDS['act.raise-run.shown.public']).toContain(PUBLIC_PAYMENT_SAYS);
    /* RED WHEN: the private line promises the network shows nothing of the run's payments: they are countable against the run, change can link a payee, and a policy's band shows. */
    expect(WORDS['act.raise-run.shown.private']).toMatch(/count how many payments the vault has made[\s\S]*change[\s\S]*band/u);
    expect(WORDS['act.raise-run.shown.private']).not.toMatch(/against this run/u);
    expect(WORDS['act.raise-run.shown.public']).toMatch(/the amount and the currency/u);
    expect(WORDS['act.raise-run.shown.public-again']).toMatch(/the amount and the currency/u);
    /* RED WHEN: the window says only the raiser can withdraw a run, though any signer can until its time to be paid begins. */
    expect(WORDS['act.raise-run.shown.window']).toMatch(/a signer can withdraw it/u);
    /* RED WHEN: a retry of public payments does not say it puts them on the public record again. */
    expect((await action().shown(intent({ form: 'public', indices: '1', payees: '1' }))).map((l) => l.key)).toContain('act.raise-run.shown.public-again');
    /* RED WHEN: a run drawn in this window is not said to be drawn and filed sealed. */
    expect((await action().shown(intent({ run: undefined, payees: undefined, total: undefined }))).map((l) => l.key)).toContain('act.raise-run.shown.draw');
    for (const [k] of [...keys, ['act.raise-run.shown.public'], ['act.raise-run.shown.public-again'], ['act.raise-run.shown.draw']]) expect(WORDS[k!], k).toBeTruthy();
    /* RED WHEN: a retry is said to put addresses and amounts on the record again: it pays only people whose payment never landed. */
    expect(WORDS['act.raise-run.shown.public-again']).not.toMatch(/second time|again/u);
    expect(WORDS['act.raise-run.shown.public-again']).toMatch(/address, the amount and the currency on a record anyone can read/u);
    expect(action().steps(intent()).map((s) => s.title.key)).toEqual(['act.raise-run.step.seat', 'act.upkeep.step.first', 'act.raise-run.step.raise', 'act.upkeep.step.last']);
  });
});

describe('A RUN WITH NO WINDOW, OR ONE OPENING AT OR BEFORE NOW, IS REFUSED BEFORE ANYTHING IS BUILT', () => {
  it('refuses at the check and again at the step, and builds, draws and sends nothing', async () => {
    /* RED WHEN: a run is raised with no window, or with a window the wallet invents. */
    expect((await action().check(intent({ opensAt: undefined }), {} as never))?.key).toBe('act.raise-run.why.no-window');
    expect((await action().check(intent({ closesAt: String(NOW) }), {} as never))?.key).toBe('act.raise-run.why.no-window');
    /* RED WHEN: a window that opens now or earlier is raised, so the run can never be withdrawn. */
    expect((await action().check(intent({ opensAt: String(NOW) }), {} as never))?.key).toBe('act.raise-run.why.window-open');
    expect(await refusedWith(intent({ opensAt: String(NOW - 1) }))).toBe('act.raise-run.why.window-open');
    expect(await refusedWith(intent({ run: undefined, payees: undefined, total: undefined, opensAt: String(NOW) }))).toBe('act.raise-run.why.window-open');
    expect(t.calls.filter((c) => !c.startsWith('upkeep'))).toEqual([]);
    /* RED WHEN: a raise written down whose window has since opened is sent again. */
    t.run = { ...RAISED, payout: { [LEG]: { ...((RAISED as any).payout)[LEG], opensAt: BigInt(NOW - 10) } } };
    expect(await refusedWith(intent({ proposal: 'prp_leg', opensAt: String(NOW - 10) }))).toBe('act.raise-run.why.window-open');
    /* RED WHEN: a raise written down is sent again with no window shown, so what it pays from and until is never seen. */
    expect((await action().check(intent({ proposal: 'prp_leg', opensAt: undefined, closesAt: undefined }), {} as never))?.key).toBe('act.raise-run.why.no-window');
    expect(raised()).toEqual([]);
  });
});

describe('THE RUN IS RAISED THROUGH THE ONE RECORDS DOOR, WITH THE ACCOUNT\'S CIRCUITS AND A FRESH SALT', () => {
  it('raises the leg the page shows, and tells where it stands on the chain', async () => {
    const told = await run(intent());
    /* RED WHEN: the run is raised without being opened, or through another raise. */
    expect(t.calls.filter((c) => !c.startsWith('upkeep'))).toEqual(['open run_1', 'raise']);
    expect(t.inputs[0]).toMatchObject({ runId: 'run_1', asset: TEST_TOKEN, form: 'shielded', vault: VAULT, opensAt: String(NOW + 3600), closesAt: String(NOW + 86_400) });
    const doors = t.doors[0];
    /* RED WHEN: the raise cannot build the payout tree, because no product caller supplies the account's circuits. */
    for (const k of ['buildRun', 'buildRetryRun', 'rootOfPayments', 'runPayload', 'proposalIdOf', 'retrySaltOf', 'noVault', 'detailsOf']) expect(typeof doors.runs[k], k).not.toBe('undefined');
    /* RED WHEN: the vault's spending policy, the payments the account records or the heads this wallet checked are not read here. */
    expect(typeof doors.records.spendingPolicies.onChain).toBe('function');
    expect((await doors.records.payments.read(['e1'])).entries).toBe(1);
    expect(typeof doors.records.checked).toBe('function');
    expect(typeof doors.holdings.held).toBe('function');
    /* RED WHEN: two raises share a salt, so a run raised again under the same identity cannot be approved again by those who approved it. */
    const salts = new Set([doors.filing.salt(), doors.filing.salt()]);
    expect(salts.size).toBe(2);
    for (const s of salts) expect(s).toMatch(/^[0-9a-f]{64}$/u);
    /* RED WHEN: the outcome is not where the chain holds it: the vault's bar, not the service's count. */
    expect(told).toMatchObject({ state: 'raised', approvals: 1, needed: 2 });
  });

  it('refuses a run that is not the one shown, and raises nothing', async () => {
    for (const [field, value, says] of [['total', '301', 'another total'], ['payees', '3', 'it pays 2 people, not 3'], ['period', '2027-02', 'it pays for 2027-01']] as const) {
      t.calls = [];
      const e = await run(intent({ [field]: value })).catch((x: unknown) => x) as StepRefused;
      /* RED WHEN: the wallet raises a run other than the one its window showed. */
      expect(e.words.key, field).toBe('act.raise-run.why.not-as-shown');
      expect(String(e.words.values?.['says']), field).toContain(says);
      expect(raised(), field).toEqual([]);
    }
    /* RED WHEN: a run that pays the vendors is raised from a window that showed the employees. */
    t.run = RUN({ list: 'vendors' });
    t.calls = [];
    const e = await run(intent()).catch((x: unknown) => x) as StepRefused;
    expect(e.words.key).toBe('act.raise-run.why.not-as-shown');
    expect(String(e.words.values?.['says'])).toContain('vendors');
    expect(raised()).toEqual([]);
  });

  it('tells the page the run and the proposal by name, also when the raise may have been sent', async () => {
    t.draw = async () => RUN({ id: 'run_drawn' });
    t.run = RUN({ id: 'run_drawn' });
    const told = await run(intent({ run: undefined, payees: undefined, total: undefined }));
    /* RED WHEN: the page is not told the run drawn here and the proposal raised, so it must ask the service's list to send again. */
    expect(told).toMatchObject({ run: 'run_drawn', proposal: 'prp_raised' });
    expect(readOutcome({ ...told } as never, 'raise-run')).toMatchObject({ run: 'run_drawn', proposal: 'prp_raised' });
    t.dropAfterHanding = true;
    const steps = action().steps(intent({ run: undefined, payees: undefined, total: undefined }));
    const { ctx, told: after } = ctxWith(intent({ run: undefined, payees: undefined, total: undefined }));
    const stopped = await (async () => { for (const st of steps) await st.run(ctx); })().catch((x: unknown) => x) as StepRefused;
    expect(stopped.words.key).toBe('act.raise-run.why.raise-may-be-sent');
    /* RED WHEN: after a raise that may have been sent, the page is not told which proposal to send again. */
    expect(after['run']).toBe('run_drawn');
    expect(String(after['proposal'])).toMatch(/^prp_/u);
    expect(readOutcome({ ...after } as never, 'raise-run')).not.toBeNull();
    t.dropAfterHanding = false;
  });

  it('raises a retry of the people named, and sends again a raise or a retry written down', async () => {
    t.run = RAISED;
    await run(intent({ indices: '1', payees: '1', total: '200' }));
    /* RED WHEN: a retry is raised as a leg, or for other people. */
    expect(raised()).toEqual(['raise-retry']);
    expect(t.inputs[0]).toMatchObject({ indices: [1], vault: VAULT });
    t.calls = []; t.inputs = [];
    await run(intent({ proposal: 'prp_leg' }));
    await run(intent({ proposal: 'prp_retry', payees: '1', total: '200' }));
    /* RED WHEN: a raise written down is sent as a retry, or a retry as the leg. */
    expect(raised()).toEqual(['send-raise', 'send-retry']);
    expect(t.inputs[1]).toMatchObject({ proposalId: 'prp_retry' });
    /* RED WHEN: a raise written down is sent again over another window than the one it was written down with. */
    t.calls = [];
    const e = await run(intent({ proposal: 'prp_leg', closesAt: String(NOW + 90_000) })).catch((x: unknown) => x) as StepRefused;
    expect(e.words.key).toBe('act.raise-run.why.not-as-shown');
    expect(String(e.words.values?.['says'])).toContain('another payment window');
    expect(raised()).toEqual([]);
    /* RED WHEN: a proposal the run does not hold is sent. */
    t.calls = [];
    expect(await refusedWith(intent({ proposal: 'prp_other' }))).toBe('act.raise-run.why.not-as-shown');
    expect(raised()).toEqual([]);
  });

  it('draws the run when none is named, then raises the run it drew', async () => {
    t.draw = async () => { t.calls.push('drawn'); return RUN({ id: 'run_drawn' }); };
    t.run = RUN({ id: 'run_drawn' });
    await run(intent({ run: undefined, payees: undefined, total: undefined }));
    /* RED WHEN: a run with no name is raised without being drawn, or another run than the one drawn is raised. */
    expect(t.calls.filter((c) => !c.startsWith('upkeep'))).toEqual(['draw 2027-01', 'drawn', 'confirm', 'file run_drawn', 'open run_drawn', 'raise']);
  });
});

describe('A RUN THE PAGE DOES NOT NAME IS DRAWN, SHOWN WITH ITS NUMBERS, AND FILED AND RAISED ONLY ON CONFIRM', () => {
  const DRAW = { run: undefined, payees: undefined, total: undefined };
  const OTHER_TOKEN = 'f1'.repeat(32);
  const drawnRun = () => RUN({
    id: 'run_drawn', employees: [employee('e1', 100n), employee('e2', 200n), { ...employee('e3', 7n), asset: OTHER_TOKEN }],
    skips: { people: [{ employeeId: 'e4', name: 'Person e4', waiting: 'outside their dates' }], decisions: {} },
  });

  it('shows the month, list, vault, currency and form, the people and the total the draw gave, once, then files and raises that run', async () => {
    t.draw = async () => drawnRun();
    t.run = drawnRun();
    const told = await run(intent(DRAW));
    /* RED WHEN: the drawn run is filed or raised before the person confirmed it, or confirmed after anything was sent. */
    expect(t.calls).toEqual(['draw 2027-01', 'confirm', 'upkeep-first', 'file run_drawn', 'open run_drawn', 'raise', 'upkeep-last']);
    /* RED WHEN: Confirm is asked more than once in the window. */
    expect(t.confirmed).toHaveLength(1);
    const lines = t.confirmed[0]!;
    const asset = registryWithTestPrivateForms().find(TEST_TOKEN)!;
    /* RED WHEN: the person confirms a drawn run without its people and total, the leg's own, or without the month, list, vault, currency or form. */
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.payees', values: { payees: 2 } });
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.total', values: { shown: formatAmount(300n, asset), symbol: asset.symbol } });
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.period', values: { period: '2027-01' } });
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.vault', values: { vault: VAULT } });
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.list-employees' });
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.token-private', values: { symbol: asset.symbol } });
    /* RED WHEN: a run that also pays people in another leg is confirmed as if this leg were all of it. */
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.others', values: { others: 1 } });
    /* RED WHEN: a person the draw leaves unpaid for the month, or the window the run may be paid in, is not shown at Confirm. */
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.set-aside', values: { name: 'Person e4', why: 'outside their dates' } });
    expect(lines).toContainEqual({ key: 'act.raise-run.confirm.window', values: { opensAt: new Date((NOW + 3600) * 1000).toISOString(), closesAt: new Date((NOW + 86_400) * 1000).toISOString() } });
    expect(lines.at(-1)).toEqual({ key: 'act.raise-run.confirm.ask' });
    for (const l of lines as Array<{ key: string }>) expect(WORDS[l.key], l.key).toBeTruthy();
    /* RED WHEN: the raise is not of the leg confirmed, or the page is not told the run and the proposal to name for later legs. */
    expect(t.inputs[0]).toMatchObject({ runId: 'run_drawn', asset: TEST_TOKEN, form: 'shielded', vault: VAULT });
    expect(told).toMatchObject({ run: 'run_drawn', proposal: 'prp_raised', state: 'raised' });
    expect(action().steps(intent(DRAW))[0]!.title.key).toBe('act.raise-run.step.seat-and-confirm');
  });

  it('raises the run filed only when it is this seat\'s own filing of the people confirmed, each at the same pay', async () => {
    t.draw = async () => drawnRun();
    /* Same count and total, one person swapped for another at the same pay. */
    t.run = RUN({ ...drawnRun(), employees: [employee('e1', 100n), employee('e9', 200n), { ...employee('e3', 7n), asset: OTHER_TOKEN }] });
    const swapped = await run(intent(DRAW)).catch((x: unknown) => x) as StepRefused;
    /* RED WHEN: a run read back under the confirmed run's name that pays other people is raised. */
    expect(swapped.words.key).toBe('act.raise-run.why.not-as-shown');
    expect(String(swapped.words.values?.['says'])).toContain('other people than the run you confirmed');
    t.run = drawnRun();
    t.sealed = { filedBy: { publicKey: signingPublicKeyOf('09'.repeat(32) as never) } };
    const theirs = await run(intent(DRAW)).catch((x: unknown) => x) as StepRefused;
    /* RED WHEN: a run another seat filed under the confirmed run's name is raised. */
    expect(theirs.words.key).toBe('act.raise-run.why.not-as-shown');
    expect(String(theirs.words.values?.['says'])).toContain('filed by another seat');
    expect(raised()).toEqual([]);
  });

  it('on Stop raises nothing, files nothing and sends nothing', async () => {
    const slip = newWrappingKeypair();
    const person = {
      id: 'emp_00000000000000000032', accountId: 'acc_1', name: 'Payee 32', email: null, title: 'Engineer', asset: TEST_TOKEN,
      baseAmount: 400000n, startDate: '2026-10-03', status: 'active', wrappingPublicKey: slip.publicKey, handedOverBy: null,
      admittedBy: 'ada', admittedAt: '2026-10-20T09:00:00Z', selfRaised: false, address: payeeFor('32'.repeat(32), NET),
    };
    t.people = { people: [{ person, version: 1, handedOver: false }], notBelieved: [], notPayable: [] };
    t.answer = false;
    const { ctx, told } = ctxWith(intent(DRAW));
    const e = await (async () => { for (const st of action().steps(intent(DRAW))) await st.run(ctx); })().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ActionStopped);
    /* RED WHEN: a run the person stopped is filed, entered, raised or sent anywhere, or the upkeep runs after Stop. */
    expect(t.calls).toEqual(['draw 2027-01', 'confirm']);
    expect(sent).toEqual([]);
    expect(told['run']).toBeUndefined();
    /* The draw was real: what was shown is that one person and their pay. */
    expect(t.confirmed[0]).toContainEqual({ key: 'act.raise-run.confirm.payees', values: { payees: 1 } });
  });

  it('refuses a draw the page gives people or a total for, or whose run pays nobody in the leg asked, with nothing shown or filed', async () => {
    /* RED WHEN: a page's own count or total is taken for a run only the wallet draws. */
    expect((await action().check(intent({ run: undefined, total: undefined }), {} as never))?.key).toBe('act.raise-run.why.not-a-run');
    expect((await action().check(intent({ run: undefined, payees: undefined }), {} as never))?.key).toBe('act.raise-run.why.not-a-run');
    expect(await refusedWith(intent({ run: undefined }))).toBe('act.raise-run.why.not-a-run');
    expect(t.calls).toEqual([]);
    /* RED WHEN: a refusal says only what the page sent, not what to send instead and what resolves it, or a retry or resend with no run loses its own words. */
    const says = async (fields: Record<string, string | undefined>) => String((await action().check(intent(fields), {} as never))?.values?.['says']);
    expect(await says({ run: undefined })).toMatch(/leave them out, or name the run they belong to$/u);
    expect(await says({ run: undefined, indices: '1', payees: '1' })).toBe('a retry pays people of a run already raised. Name that run');
    expect(await says({ run: undefined, proposal: 'prp_leg' })).toBe('a proposal is sent again only beside the run it raises. Name that run');
    /* RED WHEN: a drawn run with nobody in the currency and form asked is offered to confirm. */
    t.draw = async () => RUN({ id: 'run_drawn', employees: [{ ...employee('e3', 7n), asset: OTHER_TOKEN }] });
    expect(await refusedWith(intent(DRAW))).toBe('act.raise-run.why.not-raised');
    expect(t.confirmed).toEqual([]);
    expect(t.calls).toEqual(['draw 2027-01']);
  });

  it('asks no Confirm for a run, a retry or a resend the page names, which are raised as before', async () => {
    t.run = RAISED;
    await run(intent({ indices: '1', payees: '1', total: '200' }));
    await run(intent({ proposal: 'prp_leg' }));
    t.run = RUN();
    await run(intent());
    /* RED WHEN: a named run is drawn or filed again, or asks a Confirm the page's numbers already carried before the passkey. */
    expect(t.confirmed).toEqual([]);
    expect(t.calls.filter((c) => /^(draw|file|confirm)/u.test(c))).toEqual([]);
    expect(raised()).toEqual(['raise-retry', 'send-raise', 'raise']);
    expect(action().steps(intent())[0]!.title.key).toBe('act.raise-run.step.seat');
  });
});

describe('OVER THE REAL RUNNER, A DRAW ASKS ITS CONFIRM BEFORE ANYTHING IS HANDED OVER', () => {
  it('reads only, asks Confirm once, then files and raises; on Stop nothing is handed over at all', async () => {
    const slip = newWrappingKeypair();
    const person = {
      id: 'emp_00000000000000000033', accountId: 'acc_1', name: 'Payee 33', email: null, title: 'Engineer', asset: TEST_TOKEN,
      baseAmount: 300000n, startDate: '2026-10-03', status: 'active', wrappingPublicKey: slip.publicKey, handedOverBy: null,
      admittedBy: 'ada', admittedAt: '2026-10-20T09:00:00Z', selfRaised: false, address: payeeFor('33'.repeat(32), NET),
    };
    const fields = Object.fromEntries(Object.entries(intent(DRAW_OF_THE_PAGE).fields)) as Record<string, string>;
    const request = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
      purpose: 'A test.', nonce: 'n1', expiresAt: NOW_MS + 20 * 60_000, hearsProgress: true, person: 'usr_a', intent: { name: 'raise-run', fields },
    } as unknown as ActRequest;
    const drive = async (answer: boolean) => {
      t.people = { people: [{ person, version: 1, handedOver: false }], notBelieved: [], notPayable: [] };
      t.run = 'filed';
      const posted: string[] = [];
      const atConfirm: string[][] = [];
      const ended: unknown[] = [];
      const channel = {
        step: () => true,
        relay: async () => { posted.push('relay'); return 'relayed'; },
        call: async (_at: unknown, method: string, path: string) => { posted.push(`${method} ${path}`); return { of: 'answered', status: 200, body: method === 'GET' ? [] : {} }; },
        answer: (a: unknown) => { ended.push(a); return true; },
      } as unknown as ActingChannel;
      /* The company is reached over the runner's own calls, as the product reaches it. */
      const overTheRunner = { ...reach, reachFor: async (c: StepContext) => ({ ...reachOf(), api: apiOver(c) }) as never };
      await runAction({
        definition: raiseRunAction(overTheRunner), request, channel, held: { identity, secret, account: 0 } as never, stop: new AbortController().signal,
        now: () => NOW_MS, confirm: async () => { atConfirm.push([...posted]); return answer; },
      });
      return { posted, atConfirm, ended };
    };
    const confirmed = await drive(true);
    /* RED WHEN: the draw hands anything over before its Confirm, so the runner refuses the Confirm and every draw stops there. */
    expect(confirmed.atConfirm).toHaveLength(1);
    expect(confirmed.atConfirm[0]!.length).toBeGreaterThan(0);
    for (const c of confirmed.atConfirm[0]!) expect(c, c).toMatch(/^GET /u);
    expect(confirmed.posted).toContain('POST /api/accounts/acc_1/runs');
    expect(confirmed.ended[0]).toMatchObject({ ended: 'done' });
    expect(raised()).toEqual(['raise']);
    t.calls = [];
    const stopped = await drive(false);
    /* RED WHEN: a Stop at the Confirm still files, raises or hands anything over. */
    expect(stopped.posted.filter((c) => !c.startsWith('GET '))).toEqual([]);
    expect(stopped.ended[0]).toMatchObject({ ended: 'stopped' });
    expect(raised()).toEqual([]);
  });
});

describe('WHAT THE DRAW SENDS THE SERVICE IS SEALED: NO PERSON, AMOUNT, PAYEE OR NAME IN THE CLEAR', () => {
  it('files the run drawn here under the company key, and the filing names nobody', async () => {
    const slip = newWrappingKeypair();
    const address = payeeFor('31'.repeat(32), NET);
    const person = {
      id: 'emp_00000000000000000031', accountId: 'acc_1', name: 'Wilhelmina Quarterhouse', email: null, title: 'Engineer', asset: TEST_TOKEN,
      baseAmount: 500051n, startDate: '2026-10-03', status: 'active', wrappingPublicKey: slip.publicKey, handedOverBy: null,
      admittedBy: 'ada', admittedAt: '2026-10-20T09:00:00Z', selfRaised: false, address,
    };
    t.people = { people: [{ person, version: 1, handedOver: false }], notBelieved: [], notPayable: [] };
    t.run = null;
    const e = await run(intent({ run: undefined, payees: undefined, total: undefined })).catch((x: unknown) => x);
    /* The draw ran and filed; opening it again is stood in for, so the raise stops there. */
    expect(e).toBeInstanceOf(StepRefused);
    const filed = sent.filter((s) => s.path === '/api/accounts/acc_1/runs');
    expect(filed).toHaveLength(1);
    const body = filed[0]!.body;
    /* RED WHEN: what the service keeps of a run drawn in the wallet names a person, their pay, their address or their payslip key in the clear. */
    for (const clear of [person.id, person.name, '500051', address.bech32, slip.publicKey, 'Engineer', LABEL]) expect(body, clear).not.toContain(clear);
    expect(JSON.parse(body).run).toBeTruthy();
    expect(raised()).toEqual([]);
  });
});

describe('A PAYROLL RUN IS APPROVED THROUGH THE ONE APPROVAL, AND ONLY WHEN IT IS THE RUN SHOWN', () => {
  const approve = (fields: Record<string, string | undefined> = {}): ActIntent => ({
    name: 'approve-proposal',
    fields: Object.fromEntries(Object.entries({
      record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_leg', kind: 'payroll', run: 'run_1', period: '2027-01', vault: VAULT,
      token: TEST_TOKEN, form: 'private', payees: '2', total: '300', ...fields,
    }).filter(([, v]) => v !== undefined)) as Record<string, string>,
  }) as ActIntent;
  const approver = () => approveProposalAction({
    ...reach, ...AFTER_A_REMOVAL, commitments: async () => ({}) as never,
  } as never);
  const steps = async (i: ActIntent) => {
    const all = approver().steps(i);
    const { ctx, told } = ctxWith(i);
    for (const s of all) await s.run(ctx);
    return told;
  };

  it('opens the proposal and its run, approves it, and tells where it stands', async () => {
    t.run = RAISED;
    t.opened = OPENED(VAULT);
    t.rounds = [{ id: 'prp_leg', runId: 'run_1', asset: TEST_TOKEN, form: 'shielded', status: 'open', chainId: OPENED(VAULT).chainId }];
    const shown = (await approver().shown(approve())).map((l) => [l.key, l.from]);
    for (const k of ['period', 'payees', 'total', 'vault']) expect(shown, k).toContainEqual([`act.raise-run.shown.${k}`, 'page']);
    expect(shown).toContainEqual(['act.approve-proposal.shown.run-matched', 'action']);
    expect(await approver().check(approve(), {} as never)).toBeNull();
    const told = await steps(approve());
    /* RED WHEN: a payroll proposal cannot be approved in the wallet. */
    expect(t.calls.filter((c) => c === 'approve')).toEqual(['approve']);
    /* RED WHEN: the approval reads the run through anything but the one records door. */
    expect(typeof t.doors[0].records.payments.read).toBe('function');
    expect(told).toMatchObject({ approvals: 1, needed: 2 });
  });

  it('refuses a proposal whose run is not the one shown, or that is no payroll proposal, and approves nothing', async () => {
    t.run = RAISED;
    t.opened = OPENED(VAULT);
    t.rounds = [{ id: 'prp_leg', runId: 'run_1', asset: TEST_TOKEN, form: 'shielded', status: 'open', chainId: OPENED(VAULT).chainId }];
    /* RED WHEN: a run other than the one shown is approved. */
    expect(await steps(approve({ total: '299' })).catch((e: StepRefused) => e.words.key)).toBe('act.approve-proposal.why.not-as-shown');
    expect(await steps(approve({ form: 'public' })).catch((e: StepRefused) => e.words.key)).toBe('act.approve-proposal.why.not-as-shown');
    /* RED WHEN: a proposal sealed to pay from another vault than its run names is approved, its bar read for the page's vault. */
    const OTHER = 'ef'.repeat(32);
    t.opened = OPENED(OTHER);
    t.rounds = [{ id: 'prp_leg', runId: 'run_1', asset: TEST_TOKEN, form: 'shielded', status: 'open', chainId: OPENED(OTHER).chainId }];
    t.calls = [];
    expect(await steps(approve()).catch((e: StepRefused) => e.words.key)).toBe('act.approve-proposal.why.not-as-shown');
    expect(t.calls).toContain('opened');
    /* RED WHEN: a proposal whose identity on the chain is not the one its vault, payload and salt make is approved. */
    t.opened = { ...OPENED(VAULT), salt: '00'.repeat(32) };
    t.rounds = [{ id: 'prp_leg', runId: 'run_1', asset: TEST_TOKEN, form: 'shielded', status: 'open', chainId: OPENED(VAULT).chainId }];
    expect(await steps(approve()).catch((e: StepRefused) => e.words.key)).toBe('act.approve-proposal.why.not-as-shown');
    t.rounds = [];
    expect(await steps(approve()).catch((e: StepRefused) => e.words.key)).toBe('act.approve-proposal.why.not-a-run');
    expect(t.calls.filter((c) => c === 'approve')).toEqual([]);
    for (const k of ['not-as-shown', 'not-a-run', 'run-closed', 'run-not-raised', 'run-already-counted']) expect(WORDS[`act.approve-proposal.why.${k}`], k).toBeTruthy();
  });
});

describe('EVERY CALL THE RAISE MAKES IS ONE ITS ENTRY LISTS', () => {
  it('lists the run filing, the proposal filing and the send again, and marks as sending only what reaches the chain', () => {
    const shape = intentShapeOf('raise-run')!;
    for (const [m, p] of [['POST', '/api/accounts/acc_1/runs'], ['GET', '/api/accounts/acc_1/people'], ['POST', '/api/accounts/acc_1/proposals'],
      ['POST', '/api/proposals/prp_1/send'], ['GET', '/api/accounts/acc_1/vendors/ven_1/handover'], ['GET', `/api/vaults/${VAULT}/records/pool`]] as const) {
      expect(routeOf(shape, m, p), `${m} ${p}`).not.toBeNull();
    }
    /* RED WHEN: filing a draft run is counted as a send, or the proposal's filing with its transaction is not. */
    expect(routeOf(shape, 'POST', '/api/accounts/acc_1/runs')!.sends).toBeUndefined();
    expect(routeOf(shape, 'POST', '/api/accounts/acc_1/proposals')!.sends).toBe(true);
  });
});
