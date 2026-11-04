import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { PUBLIC_PAYMENT_SAYS } from '../../../../src/core/movement.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../../src/testing/assets.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **AN APPROVED PAYROLL RUN IS PAID IN THE WALLET, IN ONE WINDOW, FROM ITS OWN READS, THROUGH THE ONE PAYMENT PATH.**
 * The payment path itself (`payAnApprovedLeg`, whose own work is leg-paid-here.test.ts's), what the device makes for
 * the leg (`legToPayHere`), the run and rounds it opens and the proposal's own record are stood in for here; what is
 * pinned is what the wallet decides before anything is sent: the run is the one shown, from the vault its proposal
 * names; the chain holds the proposal open at its bar; the window is open now; and what it tells the page, also when
 * the leg stops part way.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  paid: [] as Array<{ doors: any; leg: any }>,
  payAnswer: null as null | (() => Promise<unknown>),
  order: null as any,
  run: null as unknown,
  rounds: [] as unknown[],
  opened: null as unknown,
  standing: { held: 'open', approvals: 2, needed: 2, raisedAt: 1, approvedHere: true } as Record<string, unknown>,
  held: [] as string[],
}));
vi.mock('../../../../packages/web-shared/src/leg-paid-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/leg-paid-here.js')>()),
  payAnApprovedLeg: async (doors: any, leg: any) => {
    t.calls.push('pay'); t.paid.push({ doors, leg });
    if (t.payAnswer !== null) return t.payAnswer();
    return { paid: [0, 1], sentNotNamed: [], alreadyPaid: [], steps: [{ kind: 'charge', spentBefore: 0n }, { kind: 'payment' }, { kind: 'payment' }] };
  },
}));
vi.mock('../../../../packages/web-shared/src/payments-made-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/payments-made-here.js')>()),
  legToPayHere: async (_records: unknown, _account: string, runId: string, _k: unknown, _d: unknown, which: unknown, retry?: string) => {
    t.calls.push(`made ${runId} ${JSON.stringify(which)} ${retry ?? 'leg'}`);
    return { order: t.order, proposalId: retry ?? 'prp_leg' };
  },
}));
vi.mock('../../../../packages/web-shared/src/run-rebuilt-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/run-rebuilt-here.js')>()),
  keptRunHere: async (_records: unknown, _account: string, runId: string) => {
    t.calls.push(`open ${runId}`);
    if (t.run === null) throw new Error('This company\'s records hold no payroll run by that name');
    return { sealed: {}, run: t.run };
  },
  payrollRoundsHere: () => t.rounds,
}));
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  openTheRoundHere: async () => { t.calls.push('opened'); return t.opened; },
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown> }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.calls.push('upkeep-first'); await company.reach(c); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.calls.push('upkeep-last'); await company.reach(c); } },
    }),
  };
});

const { payRunAction, walletHoldsTheMergeKey } = await import('./pay-run.js');
const { LegStopped } = await import('../../../../packages/web-shared/src/leg-paid-here.js');
const { PaymentLandedUnrecorded, PaymentNotYetSeen, PaymentStillInFlight, PublicPaymentNotYetSeen } = await import('../../../../packages/web-shared/src/vault-operation.js');
const { pureCircuits: P } = await import('../../../../contracts/managed/contract/index.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const VAULT = 'de'.repeat(32);
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const SEAT = { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) };
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const LEG = `${TEST_TOKEN}:shielded`;
const PUBLIC_LEG = `${TEST_TOKEN}:unshielded`;
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const DIGEST = '5d'.repeat(32);
const SALT = '5a'.repeat(32);
const OPENED = (vault: string) => ({ digest: DIGEST, vault, salt: SALT, chainId: hexOf((P as any).proposalIdOf(Buffer.from(DIGEST, 'hex'), Buffer.from(vault, 'hex'), Buffer.from(SALT, 'hex'))) });

const intent = (fields: Record<string, string | undefined> = {}): ActIntent => ({
  name: 'pay-run',
  fields: Object.fromEntries(Object.entries({
    record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_leg', run: 'run_1', period: '2027-01', vault: VAULT, token: TEST_TOKEN,
    form: 'private', payees: '2', total: '300', ...fields,
  }).filter(([, v]) => v !== undefined)) as Record<string, string>,
}) as ActIntent;

const employee = (id: string, amount: bigint, form?: string) => ({ id, name: `Person ${id}`, wrappingPublicKey: null, asset: TEST_TOKEN, amount, ...(form === undefined ? {} : { form }) });
const RAISED = (leg = LEG, form?: string) => ({
  id: 'run_1', accountId: 'acc_1', period: '2027-01', status: 'proposed', totals: {}, payslips: [],
  employees: [employee('e1', 100n, form), employee('e2', 200n, form)],
  proposalIds: { [leg]: 'prp_leg' },
  payout: { [leg]: { vault: VAULT, opensAt: BigInt(NOW - 60), closesAt: BigInt(NOW + 86_400), retries: [
    { originalIndices: [1], vault: VAULT, opensAt: BigInt(NOW - 60), closesAt: BigInt(NOW + 86_400), proposalId: 'prp_retry' },
  ] } },
});
const ORDER = (over: Record<string, unknown> = {}, paid: boolean[] = [false, false]) => ({
  asset: TEST_TOKEN, form: 'shielded', symbol: 'T', vault: VAULT, proposal: OPENED(VAULT).chainId, salt: SALT, root: '9a'.repeat(32),
  payees: String(paid.length), opensAt: String(NOW - 60), closesAt: String(NOW + 86_400),
  payments: paid.map((p, i) => ({ index: i, kind: 'shielded', leaf: `${i}d`.padEnd(64, '0'), amount: '100', paid: p })), ...over,
});
const roundOf = (id = 'prp_leg', form = 'shielded') => ({ id, runId: 'run_1', asset: TEST_TOKEN, form, status: 'open', chainId: OPENED(VAULT).chainId });

const ctxWith = (i: ActIntent) => {
  const told: Record<string, unknown> = {};
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 3, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a run is paid through its calls, never a bare relay'); },
    call: async () => ({ status: 200, body: {} }),
    tell: (o: Record<string, unknown>) => { Object.assign(told, o); }, keyring: null,
  } as unknown as StepContext;
  return { ctx, told };
};
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32),
  stepTo: () => {},
  api: async (path: string) => (path.endsWith('/standing') ? { id: 'prp_leg', chainId: OPENED(VAULT).chainId, status: 'open' } : []),
  send: async () => ({ status: 200, body: {} }),
  holders: async () => ({ seats: ['aa'.repeat(32)], committee: [], threshold: 1, approvals: 1, vaultThresholds: [{ vault: VAULT, threshold: 2 }], adoptedVaults: [VAULT], account: ACCOUNT }),
  judges: {
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
    /* The account's record of payments, as the wallet's own indexer reads it: the entries it holds. */
    payments: async (_a: string, _l: string, entries: string[]) => ({ payKeyCommitment: null, held: entries.filter((e) => t.held.includes(e)), openRounds: [], entries: entries.length }),
    roles: async () => [],
  },
});
const reach = {
  chain: () => ({}) as never, builder: () => ({}) as never, now: () => NOW_MS, pause: async () => {}, secrets: () => ({}) as never,
  reachFor: async () => reachOf() as never, assets: registryWithTestPrivateForms(), network: 'undeployed' as const, waitMs: 3, everyMs: 1,
  kept: () => ({ payments: {} as never, charges: {} as never }), mergesProvedHere: async () => true,
};
const action = (over: Record<string, unknown> = {}) => payRunAction({ ...reach, ...over } as never);
const run = async (i: ActIntent, over: Record<string, unknown> = {}) => {
  const { ctx, told } = ctxWith(i);
  for (const s of action(over).steps(i)) {
    if (s.notNeeded?.(told as never)) continue;
    await s.run(ctx);
  }
  return told;
};
const stopped = async (i: ActIntent): Promise<{ key: string; values: Record<string, unknown> | undefined; told: Record<string, unknown> }> => {
  const { ctx, told } = ctxWith(i);
  try {
    for (const s of action().steps(i)) await s.run(ctx);
  } catch (e) {
    expect(e).toBeInstanceOf(StepRefused);
    return { key: (e as StepRefused).words.key, values: (e as StepRefused).words.values as never, told };
  }
  throw new Error('the action did not stop');
};

beforeEach(() => {
  t.calls = []; t.paid = []; t.payAnswer = null; t.run = RAISED(); t.rounds = [roundOf()]; t.opened = OPENED(VAULT); t.order = ORDER(); t.held = [];
  t.standing = { held: 'open', approvals: 2, needed: 2, raisedAt: 1, approvedHere: true };
});

describe('THE WINDOW SHOWS THE RUN AS THE PAGE GAVE IT, AND WHAT ITS FORM MAKES PUBLIC, BEFORE THE PASSKEY', () => {
  it('names the page\'s words as the page\'s, says a public run puts every address and amount on the record, and holds every word it uses', async () => {
    const keys = (await action().shown(intent())).map((l) => [l.key, l.from]);
    /* RED WHEN: the proposal, month, people, total or vault is shown as something the wallet read itself. */
    for (const k of ['proposal', 'run', 'list-employees', 'period', 'payees', 'total', 'vault']) expect(keys, k).toContainEqual([`act.pay-run.shown.${k}`, 'page']);
    for (const k of ['private', 'matched', 'pay', 'merge', 'again', 'nothing-else']) expect(keys, k).toContainEqual([`act.pay-run.shown.${k}`, 'action']);
    /* RED WHEN: a wallet that cannot prove a merge promises one before the passkey. */
    const unmerged = (await action({ mergesProvedHere: async () => false }).shown(intent())).map((l) => l.key);
    expect(unmerged).toContain('act.pay-run.shown.no-merge');
    expect(unmerged).not.toContain('act.pay-run.shown.merge');
    expect(WORDS['act.pay-run.shown.pay']).not.toMatch(/merg/u);
    const publicly = (await action().shown(intent({ form: 'public' }))).map((l) => l.key);
    /* RED WHEN: a run paid publicly is shown without saying the addresses and amounts go on a record anyone can read. */
    expect(publicly).toContain('act.pay-run.shown.public');
    expect(publicly).not.toContain('act.pay-run.shown.private');
    expect(WORDS['act.pay-run.shown.public']).toContain(PUBLIC_PAYMENT_SAYS);
    /* RED WHEN: the private line says the network shows nothing: it shows how many were paid from the vault for the run. */
    expect(WORDS['act.pay-run.shown.private']).toMatch(/count how many payments the vault has made/u);
    expect(WORDS['act.pay-run.shown.private']).not.toMatch(/against this run/u);
    expect(WORDS['act.pay-run.shown.public']).toMatch(/the amount and the currency/u);
    const why = ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened', 'not-a-run', 'not-as-shown',
      'not-raised', 'withdrawn', 'closed', 'not-open-yet', 'window-closed', 'not-payable', 'charge-not-seen', 'not-charged', 'payment-not-seen',
      'payment-not-recorded', 'payment-on-its-way', 'payment-not-as-built', 'not-paid', 'may-be-sent', 'stopped', 'stopped-unseen'];
    for (const k of [...keys.map(([k]) => k!), 'act.pay-run.shown.list-vendors', 'act.pay-run.shown.total-raw', 'act.pay-run.shown.no-merge', 'act.pay-run.headline',
      ...action().checks.map((c) => c.key), ...['seat', 'check', 'pay'].map((s) => `act.pay-run.step.${s}`), ...why.map((w) => `act.pay-run.why.${w}`)]) {
      if (k.startsWith('act.upkeep.')) continue;
      expect(WORDS[k], k).toBeTruthy();
    }
  });

  it('refuses at the check a request that names no company, no proposal, or no run it can read', async () => {
    expect(await action().check(intent({ record: undefined }), {} as never)).toMatchObject({ key: 'act.pay-run.why.not-a-company' });
    expect(await action().check(intent({ proposal: undefined }), {} as never)).toMatchObject({ key: 'act.pay-run.why.not-a-run' });
    expect(await action().check(intent({ form: 'neither' }), {} as never)).toMatchObject({ key: 'act.pay-run.why.not-a-run' });
    expect(await action().check(intent(), {} as never)).toBeNull();
  });
});

describe('AN APPROVED RUN IS PAID THROUGH THE ONE PAYMENT PATH', () => {
  it('pays the private leg the page shows, from the one records door and this wallet\'s own payment doors, and tells what it paid', async () => {
    const told = await run(intent());
    /* RED WHEN: an approved run cannot be paid in the wallet, or is paid without its proposal opened and checked first. */
    expect(t.calls.filter((c) => c !== 'upkeep-first' && c !== 'upkeep-last')).toEqual(['open run_1', 'opened', 'open run_1', `made run_1 {"asset":"${TEST_TOKEN}","form":"shielded"} leg`, 'pay']);
    const { doors, leg } = t.paid[0]!;
    expect(leg).toMatchObject({ runId: 'run_1', accountId: 'acc_1', which: { asset: TEST_TOKEN, form: 'shielded' } });
    expect(leg.retry).toBeUndefined();
    /* RED WHEN: the leg is paid from records read anywhere but the one door, or without the merge check and the paid read. */
    expect(typeof leg.records.payments.read).toBe('function');
    expect(typeof doors.paidYet).toBe('function');
    expect(await doors.mergesProvedHere()).toBe(true);
    expect(typeof doors.service.merge).toBe('function');
    expect(told).toMatchObject({ state: 'paid', paid: 2, owed: 0, charge: 'charged', approvals: 2, needed: 2 });
  });

  it('pays a public leg, asking the chain the wallet reads whether each payment is recorded', async () => {
    t.run = RAISED(PUBLIC_LEG, 'unshielded');
    t.rounds = [roundOf('prp_leg', 'unshielded')];
    t.order = ORDER({ form: 'unshielded' });
    const told = await run(intent({ form: 'public' }));
    const { doors, leg } = t.paid[0]!;
    expect(leg.which).toEqual({ asset: TEST_TOKEN, form: 'unshielded' });
    /* RED WHEN: a public payment is asked about by anything but the account's own record of payments, read here. */
    expect(await doors.paidYet(t.order.payments[0])).toBe(false);
    t.held = [hexOf((P as any).paidMovementOf(Buffer.from(t.order.payments[0].leaf, 'hex')))];
    expect(await doors.paidYet(t.order.payments[0])).toBe(true);
    expect(told).toMatchObject({ state: 'paid' });
  });

  it('pays a retry raised on the leg as the retry, not the leg', async () => {
    t.rounds = [roundOf('prp_retry')];
    t.order = ORDER({}, [false]);
    await run(intent({ proposal: 'prp_retry', payees: '1', total: '200' }));
    /* RED WHEN: a retry is paid as its leg, so the people already paid on the leg are planned again. */
    expect(t.paid[0]!.leg.retry).toBe('prp_retry');
  });
});

describe('NOTHING IS SENT UNTIL THE RUN IS THE ONE SHOWN, AT ITS BAR AND INSIDE ITS WINDOW', () => {
  it('a run short of its approvals is told as waiting for them, and nothing is made or paid', async () => {
    t.standing = { ...t.standing, approvals: 1 };
    const told = await run(intent());
    /* RED WHEN: a run under its bar is charged or paid - the payout build meets "not enough approvals yet" after a journal line. */
    expect(t.calls.filter((c) => c === 'pay' || c.startsWith('made'))).toEqual([]);
    expect(told).toMatchObject({ state: 'awaiting-approvals', approvals: 1, needed: 2 });
  });

  it('a run that is not the one shown, or whose proposal pays from another vault, is refused, and nothing is paid', async () => {
    expect((await stopped(intent({ total: '299' }))).key).toBe('act.pay-run.why.not-as-shown');
    t.opened = OPENED('ef'.repeat(32));
    t.rounds = [{ ...roundOf(), chainId: OPENED('ef'.repeat(32)).chainId }];
    expect((await stopped(intent())).key).toBe('act.pay-run.why.not-as-shown');
    t.rounds = [];
    expect((await stopped(intent())).key).toBe('act.pay-run.why.not-a-run');
    expect(t.calls).not.toContain('pay');
  });

  it('a proposal never raised, withdrawn or closed is refused by name, and nothing is paid', async () => {
    t.standing = { held: 'never', approvals: 0 };
    expect((await stopped(intent())).key).toBe('act.pay-run.why.not-raised');
    t.standing = { held: 'closed', approvals: 0, closedBy: ['cancel'] };
    expect((await stopped(intent())).key).toBe('act.pay-run.why.withdrawn');
    t.standing = { held: 'closed', approvals: 0, closedBy: ['closeExpiredRun'] };
    expect((await stopped(intent())).key).toBe('act.pay-run.why.closed');
    expect(t.calls).not.toContain('pay');
  });

  it('a window not yet open, or closed, is refused before anything is charged or paid', async () => {
    t.order = ORDER({ opensAt: String(NOW + 60) });
    /* RED WHEN: a run is charged before its window opens - the charge refused on the chain after a fee. */
    expect((await stopped(intent())).key).toBe('act.pay-run.why.not-open-yet');
    t.order = ORDER({ closesAt: String(NOW) });
    /* RED WHEN: a run whose window closed is charged to its period, which then counts money that can never be paid. */
    expect((await stopped(intent())).key).toBe('act.pay-run.why.window-closed');
    expect(t.calls).not.toContain('pay');
  });

  it('a run the chain records as paid to everyone is told as already paid, and nothing is sent', async () => {
    t.order = ORDER({}, [true, true]);
    const told = await run(intent());
    expect(t.calls).not.toContain('pay');
    expect(told).toMatchObject({ state: 'already-paid', paid: 0, owed: 0 });
  });
});

describe('A RUN THAT STOPS PART WAY SAYS WHO WAS PAID, AND PAYING AGAIN PAYS ONLY WHO IS STILL OWED', () => {
  it('tells the page how many were paid and how many are owed, and refuses in words that say to pay again', async () => {
    t.payAnswer = async () => {
      throw new LegStopped({ paid: [0], sentNotNamed: [], alreadyPaid: [], steps: [{ kind: 'payment' } as never], payees: 2 },
        new Error('the vault holds too little for the next person. Nothing was sent.'));
    };
    const s = await stopped(intent());
    /* RED WHEN: a stop part way is told as nothing paid, or as everything paid, so the page offers the wrong next press. */
    expect(s.key).toBe('act.pay-run.why.stopped');
    expect(s.values).toMatchObject({ paid: 1, payees: 2 });
    expect(String(s.values!['says'])).toMatch(/holds too little/u);
    expect(s.told).toMatchObject({ state: 'partly-paid', paid: 1, unseen: 0, owed: 1, charge: 'none' });
    expect(WORDS['act.pay-run.why.stopped']).toMatch(/only the people still owed/u);
  });

  it('a stop while a payment may still be landing says to wait and look again before paying, and counts that payment as not yet seen, not owed', async () => {
    const causes = [
      () => new PaymentNotYetSeen('de'.repeat(32) as never, 'o', 'the wallet stopped waiting'),
      () => new PublicPaymentNotYetSeen('de'.repeat(32) as never, 'u1'),
      () => new PaymentStillInFlight('de'.repeat(32) as never, 'o', NOW_MS + 60_000),
      () => new PaymentLandedUnrecorded('de'.repeat(32) as never, 'cc'.repeat(32), 'the record was not filed'),
    ];
    for (const cause of causes) {
      t.payAnswer = async () => {
        throw new LegStopped({ paid: [], sentNotNamed: [], alreadyPaid: [], steps: [{ kind: 'charge', spentBefore: 0n } as never], payees: 2 }, cause());
      };
      const s = await stopped(intent());
      /* RED WHEN: a payment that may still land is told "pay the run again" and counted owed, so the page offers to pay it now. */
      expect(s.key, cause().name).toBe('act.pay-run.why.stopped-unseen');
      expect(s.told, cause().name).toMatchObject({ state: 'partly-paid', paid: 0, unseen: 1, owed: 1, charge: 'charged' });
    }
    expect(WORDS['act.pay-run.why.stopped-unseen']).toMatch(/Do not pay the run again yet/u);
  });

  it('a stop before anything was sent is told in its step\'s own words', async () => {
    t.payAnswer = async () => { throw new PaymentNotYetSeen('de'.repeat(32) as never, 'o', 'gone'); };
    expect((await stopped(intent())).key).toBe('act.pay-run.why.payment-not-seen');
    t.payAnswer = async () => { throw new Error('the vault holds too little. Nothing was sent.'); };
    expect((await stopped(intent())).key).toBe('act.pay-run.why.not-paid');
  });
});

describe('A MERGE IS PROVED HERE ONLY WITH THE KEY THIS WALLET PINS', () => {
  it('answers yes only when the wallet\'s own manifest pins the merge\'s prover and circuit', async () => {
    const serving = (artefacts: Record<string, unknown>) => (async () => new Response(JSON.stringify({ artefacts }))) as unknown as typeof fetch;
    expect(await walletHoldsTheMergeKey(serving({ 'vault/mergeNotes.prover': {}, 'vault/mergeNotes.bzkir': {} }))).toBe(true);
    /* RED WHEN: a wallet that holds only the merge's verifier is believed able to prove one, so a run is charged and then stops. */
    expect(await walletHoldsTheMergeKey(serving({ 'vault/mergeNotes.verifier': {} }))).toBe(false);
    expect(await walletHoldsTheMergeKey((async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBe(false);
  });

  it('is the default the payment doors are given when the wallet is not told', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => { fetched.push(u); return new Response(JSON.stringify({ artefacts: {} })); });
    try {
      await run(intent(), { mergesProvedHere: undefined });
      expect(await t.paid[0]!.doors.mergesProvedHere()).toBe(false);
      expect(fetched).toEqual(['/keys/manifest.json']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('EVERY CALL THE PAYMENT MAKES IS ONE ITS ENTRY LISTS', () => {
  it('lists the charge, the payments and the merge as sends, and the reads as not', () => {
    const shape = intentShapeOf('pay-run')!;
    /* RED WHEN: a payment, a merge or the charge is not counted as a send, or a read is. */
    for (const p of ['/api/proposals/prp_1/charge', `/api/accounts/acc_1/vaults/${VAULT}/payout`, `/api/accounts/acc_1/vaults/${VAULT}/merge`,
      `/api/accounts/acc_1/vaults/${VAULT}/public-payout`]) {
      expect(routeOf(shape, 'POST', p)?.sends, p).toBe(true);
    }
    for (const [m, p] of [['GET', '/api/accounts/acc_1/runs'], ['GET', `/api/vaults/${VAULT}/records/pool`], ['POST', '/api/proposals/prp_1/standing']] as const) {
      expect(routeOf(shape, m, p), `${m} ${p}`).not.toBeNull();
      expect(routeOf(shape, m, p)!.sends, `${m} ${p}`).toBeUndefined();
    }
  });
});
