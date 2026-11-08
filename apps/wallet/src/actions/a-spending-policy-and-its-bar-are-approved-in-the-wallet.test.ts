import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext, type Words } from './definition.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../../src/testing/assets.js';

/*
 * **A SPENDING POLICY, AND THE APPROVALS ANY POLICY CHANGE NEEDS, ARE APPROVED AND CARRIED OUT FROM THE WALLET.** One
 * signer raised the change; a second approves it through the one approval and carries it out once the chain counts its
 * bar. The shared code that reads the policy, counts its bands and proves each call is stood in for here (it is followed
 * in spending-policy-here.test.ts, spending-policies-survive-a-removal.test.ts and governed-call-on-device.test.ts). What
 * is pinned: the page names the vault alone; the wallet reads the policy's currency and terms itself with the seat's
 * keys, in the first step, and shows them in its window for the person to confirm before anything is sent; it hands the
 * shared code exactly those, with the company's policies and the signers on their way out to read; the carrying out is
 * its own step that reads the chain first; and the bar is the chain's. The window's Confirm is stood in for by `ctxOf`,
 * which writes down what it was shown and what had happened by then.
 */

const t = vi.hoisted(() => ({
  onDevice: [] as Array<{ kind: string; doors: any; input: any }>,
  chain: {} as Record<string, any>,
  opened: null as unknown,
  read: null as unknown,
  called: [] as string[],
  /* What happened, in order: the policy read, the window's Confirm, the upkeep, each hand-over to the shared code. */
  events: [] as string[],
  /* Whether the person presses Stop at the window's Confirm instead of Confirm. */
  stops: false,
  /* Each read of who is leaving: whether it was asked strictly. */
  leavingAsked: [] as unknown[],
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  seatsUnderARaisedRemovalHere: async (_doors: unknown, _key: unknown, strict?: unknown) => { t.leavingAsked.push(strict); return new Set<string>(); },
}));
const CHAIN_ID = 'dd'.repeat(32);
vi.mock('../../../../packages/web-shared/src/spending-policy-here.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/spending-policy-here.js')>();
  /* The shared code: an approval adds one on the chain; a carrying out closes the proposal. */
  const governed = (kind: string, doors: unknown, input: any) => {
    t.onDevice.push({ kind, doors, input });
    t.events.push(kind);
    const round = { id: 'prp_1', chainId: CHAIN_ID, status: 'open' };
    if (input.carryOnly) return { state: 'done', round };
    t.chain[CHAIN_ID] = { ...t.chain[CHAIN_ID], approvals: t.chain[CHAIN_ID].approvals + 1 };
    return { state: 'ready-to-carry', round };
  };
  return {
    ...actual,
    policyReadHere: async (_doors: unknown, input: any) => {
      t.onDevice.push({ kind: 'read', doors: _doors, input });
      t.events.push('read');
      if (t.read instanceof Error) throw t.read;
      return t.read;
    },
    approveSpendingPolicyOnDevice: async (doors: unknown, input: any) => governed('spending-policy', doors, input),
    setPolicyBarOnDevice: async (doors: unknown, input: any) => governed('policy-bar', doors, input),
  };
});
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  openTheRoundHere: async () => { if (t.opened instanceof Error) throw t.opened; return t.opened; },
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.events.push('upkeep'); await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { await company.reach(c); } },
    }),
  };
});

const { approveProposalAction } = await import('./approve-proposal.js');
const { PolicyNotOpenedHere } = await import('../../../../packages/web-shared/src/spending-policy-here.js');
const { ActionStopped } = await import('./run.js');

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WIDE = 'cc'.repeat(32);
const PAYROLL = 'ab'.repeat(32);
const TOKEN = TEST_TOKEN;
const SEATS = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_1' };
/* What the page names of a spending policy: the vault its sealed proposal names, and nothing it cannot read. */
const POLICY = { kind: 'spending-policy', vault: PAYROLL };
const TERMS = {
  bands: [{ ceiling: '100', approvals: '1' }, { ceiling: '500', approvals: '2' }, { ceiling: '900', approvals: '2' }, { ceiling: '1000', approvals: '3' }],
  periodLimit: '1000', periodStart: '0', periodLength: '2592000',
};
const intent = (fields: Record<string, string>): ActIntent => ({ name: 'approve-proposal', fields: { ...BASE, ...fields } }) as ActIntent;

/* The company as this wallet reads it: three seats on the chain and the bars the account stores. */
let company: { approvals: number; policyBar: number | null; seatBar: number };
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: WIDE },
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
    companyWide: async () => WIDE,
    runsOutrun: async () => ({}),
  },
  chain: { indexer: {}, callState: async () => null },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const confirmed: Array<readonly Words[]> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, account: 0 }, at: { step: 3, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a policy change is sent through its calls, never a bare relay'); },
    call: async (method: string, path: string) => { t.called.push(`${method} ${path}`); return { status: 404, body: {} }; },
    tell: (x: Record<string, unknown>) => { told.push(x); },
    show: () => {},
    confirm: async (lines: readonly Words[]) => {
      confirmed.push(lines);
      t.events.push('confirm');
      if (t.stops) throw new ActionStopped('stopped');
    },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told, confirmed };
};
const reach = () => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, secrets: () => ({}) as never,
  commitments: async () => ({}) as never, reachFor: async () => reachOf() as never, assets: registryWithTestPrivateForms(),
});
const run = async (i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of approveProposalAction(reach() as never).steps(i)) await step.run(ctx);
};
const refusalOf = async (p: Promise<unknown>): Promise<{ key: string; says: string }> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return { key: (e as StepRefused).words.key, says: String((e as StepRefused).words.values?.['says'] ?? '') };
};
const handed = (kind: string) => t.onDevice.filter((c) => c.kind === kind);

beforeEach(() => {
  t.onDevice.length = 0;
  t.called.length = 0;
  t.events.length = 0;
  t.stops = false;
  t.chain = { [CHAIN_ID]: { held: 'open', approvals: 1, needed: 2, raisedAt: 1 } };
  t.opened = { chainId: CHAIN_ID, governance: { kind: 'policy-bar', bar: '2' } };
  t.read = { chainId: CHAIN_ID, commitment: 'c5'.repeat(32), opening: { terms: TERMS, blinding: 'b5'.repeat(32) }, asset: TOKEN };
  company = { approvals: 2, policyBar: null, seatBar: 2 };
});

describe('A SPENDING POLICY ANOTHER SIGNER RAISED IS APPROVED AND CARRIED OUT IN THE WALLET', () => {
  it('a second signer approves it through the one approval, and a step of its own carries it out once the chain counts two', async () => {
    const i = intent(POLICY);
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: the approval carries the policy out in the same call, or no step carries it out once the chain counts its bar. */
    expect(handed('spending-policy').map((c) => [c.input.approveOnly, c.input.stopBeforeCarry, c.input.carryOnly]))
      .toEqual([[CHAIN_ID, true, undefined], [CHAIN_ID, undefined, true]]);
    /* RED WHEN: the policy is read for another proposal or vault, or its currency is looked for anywhere but among those this wallet knows. */
    expect(handed('read').map((c) => c.input)).toEqual([expect.objectContaining({
      proposal: 'prp_1', vault: PAYROLL, among: registryWithTestPrivateForms().all().map((a) => a.code),
    })]);
    /* RED WHEN: the page is told the policy was carried out without the approvals and the bar the chain showed. */
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  /*
   * RED WHEN: the window shows the policy only after something is handed over, or after the upkeep; the terms signed are
   * not the very terms shown, read once; or the policy is read again between the Confirm and the signing.
   */
  it('the terms read with the seat\'s keys are shown for the person to confirm before anything is sent, and exactly those are signed', async () => {
    const READ = { ...TERMS, periodLimit: '700', bands: [...TERMS.bands.slice(0, 3), { ceiling: '700', approvals: '2' }] };
    t.read = { chainId: CHAIN_ID, commitment: 'c6'.repeat(32), opening: { terms: READ, blinding: 'b6'.repeat(32) }, asset: TOKEN };
    const i = intent(POLICY);
    const { ctx, confirmed } = ctxOf(i);
    await run(i, ctx);
    expect(t.events).toEqual(['read', 'confirm', 'upkeep', 'spending-policy', 'spending-policy']);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContainEqual({ key: 'act.approve-policy.shown.band', values: { n: 4, ceiling: '7.00', symbol: 'tPAY', approvals: '2' } });
    expect(confirmed[0]).toContainEqual(expect.objectContaining({ key: 'act.approve-policy.shown.limit', values: expect.objectContaining({ limit: '7.00', symbol: 'tPAY' }) }));
    for (const c of handed('spending-policy')) {
      expect(c.input).toMatchObject({ proposal: 'prp_1', vault: PAYROLL, asset: TOKEN });
      expect(c.input.terms).toBe(READ);
    }
  });

  it('Stop at the Confirm approves nothing and hands nothing on', async () => {
    t.stops = true;
    const i = intent(POLICY);
    const { ctx, confirmed } = ctxOf(i);
    /* RED WHEN: a policy is approved, or the upkeep run, after the person pressed Stop at the window's Confirm of its terms. */
    expect(await run(i, ctx).then(() => null, (e: unknown) => e)).toBeInstanceOf(ActionStopped);
    expect(confirmed).toHaveLength(1);
    expect(t.events).toEqual(['read', 'confirm']);
    expect(handed('spending-policy')).toEqual([]);
  });

  it('the shared code is handed the company\'s policies to open and the signers on their way out to refuse', async () => {
    const i = intent(POLICY);
    await run(i, ctxOf(i).ctx);
    for (const c of [...handed('read'), ...handed('spending-policy')]) {
      /* RED WHEN: the policy is read or approved without the company's records of its policies, so the bands in force are never counted. */
      expect(typeof c.doors.records.spendingPolicies.versions).toBe('function');
      /* RED WHEN: reading or approving opens a door that files a version of a policy. */
      await expect(c.doors.records.spendingPolicies.file({})).rejects.toThrow();
      /* RED WHEN: a policy filed by a signer whose removal is raised is approved, because the leaving seats are never read. */
      expect(typeof c.doors.leaving).toBe('function');
      t.leavingAsked.length = 0;
      await c.doors.leaving();
      /* RED WHEN: who is leaving is read loosely, so a removal this wallet cannot open is read as nobody leaving and a policy they filed is approved. */
      expect(t.leavingAsked).toEqual([true]);
    }
  });

  it('a proposal whose policy does not open from the company\'s records is refused, nothing shown to confirm and nothing approved', async () => {
    t.read = new PolicyNotOpenedHere('None of the company\'s records of this vault\'s spending policy opens the policy this proposal sets.');
    const i = intent(POLICY);
    const { ctx, confirmed } = ctxOf(i);
    const refused = await refusalOf(run(i, ctx));
    /* RED WHEN: a policy is approved, or any of its terms shown to confirm, when this wallet could not open it itself. */
    expect(refused.key).toBe('act.approve-policy.why.not-approved');
    expect(refused.says).toMatch(/None of the company's records/u);
    expect(confirmed).toEqual([]);
    expect(handed('spending-policy')).toEqual([]);
  });

  it('terms that cannot be shown, or a currency this wallet does not know, are refused before the Confirm', async () => {
    for (const [read, key] of [
      [{ ...t.read as object, opening: { terms: { ...TERMS, bands: TERMS.bands.slice(0, 3) }, blinding: 'b5'.repeat(32) } }, 'act.approve-policy.why.cannot-show'],
      [{ ...t.read as object, opening: { terms: { ...TERMS, periodStart: '9'.repeat(30) }, blinding: 'b5'.repeat(32) } }, 'act.approve-policy.why.cannot-show'],
      [{ ...t.read as object, asset: '0f'.repeat(32) }, 'act.approve-policy.why.not-a-known-currency'],
    ] as const) {
      t.read = read;
      const i = intent(POLICY);
      const { ctx, confirmed } = ctxOf(i);
      /* RED WHEN: a policy of other than four bands, a first period no date can name, or amounts in a currency this wallet cannot show as money, is offered to confirm. */
      expect((await refusalOf(run(i, ctx))).key).toBe(key);
      expect(confirmed).toEqual([]);
    }
    expect(handed('spending-policy')).toEqual([]);
    /* RED WHEN: a refusal's words are written in the code rather than kept with the wallet's other words. */
    expect(WORDS['act.approve-policy.why.cannot-show']).toMatch(/cannot be shown in this window, so nothing was approved and nothing was sent/u);
    expect(WORDS['act.approve-policy.why.not-read']).toMatch(/has not read the policy this proposal sets/u);
    expect(readFileSync(new URL('./policy-kinds.ts', import.meta.url), 'utf8')).not.toMatch(/says: '/u);
  });

  /* RED WHEN: the first step of a policy's approval is titled as if it only read the company, though it reads the policy and waits for the Confirm. */
  it('the first step says it reads what you approve and shows it to confirm, only where it does', () => {
    const titleOf = (fields: Record<string, string>) => approveProposalAction(reach() as never).steps(intent(fields))[0]!.title.key;
    expect(titleOf(POLICY)).toBe('act.approve-proposal.step.seat-and-confirm');
    expect(WORDS['act.approve-proposal.step.seat-and-confirm']).toMatch(/what you approve, and show it to you to confirm/u);
    expect(titleOf({ kind: 'policy-bar', bar: '2' })).toBe('act.approve-proposal.step.seat');
  });

  it('the page names the vault, and a currency only to narrow where the wallet looks', async () => {
    const check = (fields: Record<string, string>) => approveProposalAction(reach() as never).check(intent(fields), {} as never);
    expect(await check(POLICY)).toBeNull();
    /* RED WHEN: a page naming no vault, or a currency this wallet does not know, is passed on to be approved. */
    expect(await check({ kind: 'spending-policy', vault: 'zz' })).toMatchObject({ key: expect.stringMatching(/^act\.approve-(policy|proposal)\.why\.not-a-/u) });
    expect(await check({ ...POLICY, token: '0f'.repeat(32) })).toMatchObject({ key: 'act.approve-policy.why.not-a-known-currency' });
    const i = intent({ ...POLICY, token: TOKEN });
    await run(i, ctxOf(i).ctx);
    /* RED WHEN: a currency the page names is not the only one the wallet tries, so the page's word could widen what is read. */
    expect(handed('read')[0]!.input.among).toEqual([TOKEN]);
  });
});

describe('THE APPROVALS ANY POLICY CHANGE NEEDS ARE APPROVED AND CARRIED OUT IN THE WALLET AT THE CHAIN\'S BAR', () => {
  it('a second signer approves a new bar and carries it out once the chain counts the seat bar', async () => {
    const i = intent({ kind: 'policy-bar', bar: '2' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: the bar is approved or carried out other than as a step each, or for another number than the one shown. */
    expect(handed('policy-bar').map((c) => [c.input.newBar, c.input.seated, c.input.approveOnly, c.input.stopBeforeCarry, c.input.carryOnly]))
      .toEqual([[2, 3, CHAIN_ID, true, undefined], [2, 3, CHAIN_ID, undefined, true]]);
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('two approvals wait while the account stores a policy bar of three: the bar is the seat bar the chain carries it out at', async () => {
    Object.assign(company, { approvals: 1, policyBar: 3, seatBar: 3 });
    const i = intent({ kind: 'policy-bar', bar: '2' });
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: a bar is carried out at the account's threshold, below the approvals the chain asks of a policy change. */
    expect(handed('policy-bar').map((c) => c.input.carryOnly)).toEqual([undefined]);
    expect(told).toContainEqual({ state: 'waiting-for-approvals', approvals: 2, needed: 3 });
  });

  it('a proposal that sets another bar, or a bar above the seats the chain holds, is not approved', async () => {
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'policy-bar', bar: '3' } };
    const other = intent({ kind: 'policy-bar', bar: '2' });
    /* RED WHEN: a bar is approved on the page's word of the number, not on the record this wallet opened. */
    expect((await refusalOf(run(other, ctxOf(other).ctx))).key).toBe('act.approve-policy.why.not-as-shown');
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'policy-bar', bar: '4' } };
    const above = intent({ kind: 'policy-bar', bar: '4' });
    const refused = await refusalOf(run(above, ctxOf(above).ctx));
    /* RED WHEN: a bar the chain would refuse when carried out, above its three seats, is approved. */
    expect(refused.key).toBe('act.approve-policy.why.refused');
    expect(refused.says).toMatch(/more approvals than the 3 signers/u);
    expect(handed('policy-bar')).toEqual([]);
  });

  it('the check of the seats is handed on and made again before every send', async () => {
    const i = intent({ kind: 'policy-bar', bar: '3' });
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'policy-bar', bar: '3' } };
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 3, raisedAt: 1 };
    await run(i, ctxOf(i).ctx).catch(() => undefined);
    const before = handed('policy-bar')[0]!.input.before as () => Promise<void>;
    await expect(before()).resolves.toBeUndefined();
    /* A seat taken off the chain since: the chain now holds two. */
    const gone = SEATS.pop()!;
    try {
      /* RED WHEN: the seats are read once at the start, and a bar above the seats the chain holds at a later send is sent. */
      await expect(before()).rejects.toThrow(/more approvals than the 2 signers/u);
    } finally {
      SEATS.push(gone);
    }
  });
});

describe('THE WINDOW SAYS WHAT CARRYING A POLICY OR A BAR OUT DOES, IN MONEY THE PERSON CAN READ', () => {
  const shownOf = async (fields: Record<string, string>) => approveProposalAction(reach() as never).shown(intent(fields));
  /* What the window asks the person to confirm once this wallet has read the policy. */
  const confirmedOf = async (terms: object = TERMS): Promise<readonly Words[]> => {
    t.read = { chainId: CHAIN_ID, commitment: 'c5'.repeat(32), opening: { terms, blinding: 'b5'.repeat(32) }, asset: TOKEN };
    const i = intent(POLICY);
    const { ctx, confirmed } = ctxOf(i);
    await run(i, ctx);
    return confirmed[0]!;
  };

  it('a policy\'s window says before the passkey that the wallet reads the terms itself; after it, that the period\'s total starts again, to confirm', async () => {
    const shown = await shownOf(POLICY);
    /* RED WHEN: the window before the passkey does not say the terms are read by this wallet and confirmed before anything is sent. */
    expect(shown).toContainEqual({ key: 'act.approve-policy.shown.read-here', from: 'action' });
    expect(WORDS['act.approve-policy.shown.read-here']).toMatch(/reads the policy's terms itself.*sends nothing until you confirm them/u);
    const confirmed = await confirmedOf();
    const keys = confirmed.map((l) => l.key);
    /* RED WHEN: a policy is confirmed with no word that carrying it out lets the vault pay its whole limit again in the period running. */
    expect(keys.indexOf('act.approve-policy.shown.period-starts-again')).toBe(keys.indexOf('act.approve-policy.shown.limit') + 1);
    expect(confirmed).toContainEqual({ key: 'act.approve-policy.shown.period-starts-again', values: { limit: '10.00', symbol: 'tPAY' } });
    expect(WORDS['act.approve-policy.shown.period-starts-again']).toMatch(/starts this period's total again: the vault may pay up to \{limit\} \{symbol\} more in the period now running, whatever it has already paid in it/u);
    /* RED WHEN: the Confirm carries no line by which the person confirms the limit starts again. */
    expect(confirmed).toContainEqual({ key: 'act.approve-policy.shown.confirm-period-starts-again' });
    expect(WORDS['act.approve-policy.shown.confirm-period-starts-again']).toMatch(/^You confirm /u);
  });

  it('the ceilings and the limit are shown in the currency\'s own units and name, and the first period as a date', async () => {
    const confirmed = await confirmedOf({ ...TERMS, periodStart: '1767225600' });
    /* RED WHEN: a ceiling is shown in the currency's smallest unit, so a signer reads it a hundred times larger or smaller than it is. */
    expect(confirmed).toContainEqual({ key: 'act.approve-policy.shown.band', values: { n: 4, ceiling: '10.00', symbol: 'tPAY', approvals: '3' } });
    /* RED WHEN: the limit or the first period's start is shown as a bare number. */
    expect(confirmed).toContainEqual({
      key: 'act.approve-policy.shown.limit', values: { limit: '10.00', symbol: 'tPAY', name: 'Test Pay', start: expect.stringMatching(/2026.*UTC/u), days: '30' },
    });
    /* RED WHEN: the first period's start is shown as machine text, or in a zone the sentence does not name. */
    const start = String(confirmed.find((l) => l.key === 'act.approve-policy.shown.limit')!.values!['start']);
    expect(start).not.toMatch(/T\d\d:\d\d|Z$/u);
    expect(start).toMatch(/Jan/u);
    /* RED WHEN: the vault and currency are shown other than as this wallet read them. */
    expect(confirmed).toContainEqual({ key: 'act.approve-policy.shown.policy', values: { vault: PAYROLL, token: 'tPAY' } });
    /* RED WHEN: the window does not say the policy raises the approvals a change of who is seated needs to its highest band. */
    expect(confirmed).toContainEqual({ key: 'act.approve-policy.shown.raises-the-seat-bar', values: { approvals: '3' } });
  });

  it('a bar\'s window says it also governs who is seated, and warns when it is every signer', async () => {
    const shown = await shownOf({ kind: 'policy-bar', bar: '3' });
    /* RED WHEN: the window says the bar governs only policy changes, though the chain asks it of adding, removing or re-seating a signer and of raising a vault past it. */
    expect(WORDS['act.approve-policy.shown.bar']).toMatch(/Any change to a spending policy, adding, removing or re-seating a signer, and raising a vault's approvals past \{bar\}, need \{bar\} approvals from now on/u);
    /* RED WHEN: a bar that may be every signer is approved with no word that one lost key then freezes who is seated. */
    expect(shown).toContainEqual({ key: 'act.approve-policy.shown.bar-every-signer', values: { bar: '3' }, from: 'action' });
    expect(WORDS['act.approve-policy.shown.bar-every-signer']).toMatch(/If \{bar\} is every signer the company seats, one lost key leaves no signer able to be added or removed and no spending policy able to change/u);
  });
});

describe('THE WALLET ASKS THE PAGE ONLY FOR THE CALLS ITS ACT LISTS, IN WORDS IT HOLDS', () => {
  it('every word the policy approvals say is written, and every call they make is one the act lists', async () => {
    const i = intent(POLICY);
    const { ctx, confirmed } = ctxOf(i);
    await run(i, ctx);
    for (const c of t.called) expect(routeOf(intentShapeOf('approve-proposal')!, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    const shown = [
      ...await approveProposalAction(reach() as never).shown(intent(POLICY)),
      ...await approveProposalAction(reach() as never).shown(intent({ kind: 'policy-bar', bar: '2' })),
      ...confirmed.flat(),
    ];
    const source = readFileSync(new URL('./policy-kinds.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/'(act\.approve-policy\.[a-z.-]+)'/gu)].map((m) => m[1]!);
    const whys = [...source.matchAll(/[wW]hy\('([a-z-]+)'/gu)].map((m) => m[1]!);
    const stops = ['not-approved', 'may-be-sent', 'withdrawn', 'carried-out', 'already-counted', 'not-raised', 'outrun', 'not-carried', 'refused', 'not-as-shown'];
    /* RED WHEN: the wallet says a word its language file does not hold. */
    for (const k of [...keys, ...[...whys, ...stops].map((w) => `act.approve-policy.why.${w}`), ...shown.map((l) => l.key)]) expect(WORDS[k], k).toBeTypeOf('string');
  });
});
