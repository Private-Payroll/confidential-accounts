import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';
import type { VaultsChangedTold } from './vault-secrets-changed-here.js';

/*
 * **A SIGNER IS REMOVED FROM THE WALLET, ONE WINDOW EACH, WITH OR WITHOUT A NEW THRESHOLD.** The removal is raised by one
 * signer and approved and carried out by another, through the shared code that proves and sends each call and files the
 * leaving seat's retirement (stood in for here, and followed against the chain in
 * packages/web-shared/src/a-signer-is-removed-from-the-devices.test.ts). What is pinned: every check is made from the
 * chain and the company's records before anything is handed to the shared code, and handed to it again for every send;
 * the carrying out is a step of its own that reads the chain first; the bar is the chain's; the change of the vault
 * secrets runs in one place, only once the removal is carried out, on the company read again, and whatever stops it
 * the removal is still told as carried out; and no page asks for the action. Whose seat it is, read from the company's list of signers,
 * is shown for the person to confirm in the first step, before anything is handed to the shared code, and is the name
 * sealed: the window's Confirm is stood in for by `ctxOf`, which writes down what it was shown and when.
 */

const t = vi.hoisted(() => ({
  onDevice: [] as Array<{ input: any }>,
  outcome: null as null | ((input: any) => unknown),
  opened: null as unknown,
  chain: {} as Record<string, unknown>,
  called: [] as string[],
  outrun: {} as Record<string, number>,
  /* How many times the wallet read which runs a removal would outrun, which is how often it counted the removal's approvers. */
  outrunReads: 0,
  /* Whether the person presses Stop at the window's Confirm instead of Confirm. */
  stops: false,
  /* The bands of the spending policies in force, as the company's records and the chain name them. */
  bands: [] as { vault: string; band: number }[],
  /* What the company's roster read throws, where it stops; null when it is read. */
  rosterStop: null as unknown,
  /* The doors the shared code was last handed. */
  doors: null as any,
  /* The removals of the seat asked that the chain closed without carrying out, as the company's records read. */
  withdrawn: [] as string[],
}));
vi.mock('../../../../packages/web-shared/src/spending-policy-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/spending-policy-here.js')>()),
  bandsInForceHere: async () => t.bands,
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  /* The company's removals as its records list them: those withdrawn of the seat asked, one still open of it, and one withdrawn of another seat. */
  removalsOpenHere: async () => [
    ...t.withdrawn.map((id) => ({ id, leaf: LEAVER, status: 'cancelled' })),
    { id: 'prp_open', leaf: LEAVER, status: 'open' }, { id: 'prp_other', leaf: SEATS[2]!, status: 'cancelled' },
  ],
  removeSignerOnDevice: async (doors: unknown, input: any) => { t.onDevice.push({ input }); t.doors = doors; return t.outcome!(input); },
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
  };
});

const { removeSignerAction } = await import('./remove-signer.js');
const { approveProposalAction } = await import('./approve-proposal.js');
const { ActionStopped } = await import('./run.js');
const { RosterNotBelieved } = await import('../../../../packages/web-shared/src/roster-here.js');
const { seatingRefusedHolding } = await import('../../../../packages/web-shared/src/roster-seating-refused.js');
const { UNREAD_SEAT_NAME } = await import('./roster-for-a-removal.js');

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WIDE = 'cc'.repeat(32);
const PAYROLL = 'ab'.repeat(32);
const CHAIN_ID = 'dd'.repeat(32);
const SEATS = ['a1', 'a2', 'a3', 'a4'].map((x) => x.repeat(32));
const LEAVER = SEATS[3]!;
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const raiserOnly = { mayApprove: false, everyVault: true, onVaults: [] };
const intent = (name: string, fields: Record<string, string>): ActIntent => ({ name, fields }) as ActIntent;

/* The company as this wallet reads it: four seats on the chain, the roster's rights and names for each, and the bars. */
let company: { approvals: number; policyBar: number | null; seatBar: number; rights: (unknown | undefined)[]; seats: string[] };
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: WIDE },
  leaf: SEATS[0], companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => { t.called.push(`${init?.method ?? 'GET'} ${path}`); return []; },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({
    seats: company.seats, committee: [], approvals: company.approvals, seatBar: company.seatBar, policyBar: company.policyBar,
    vaultThresholds: [], adoptedVaults: [PAYROLL], account: ACCOUNT,
  }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, records: { history: new Map() } }),
    leavesFor: () => async () => [],
    rosterReadsFor: () => ({}),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => { if (t.rosterStop !== null) throw t.rosterStop; return { id: 'acc_1', name: 'Acme', notBelieved: [], signers: SEATS.map((leaf, i) => ({
    id: `s${i + 1}`, name: ['Ada', 'Bo', 'Cy', 'Dee'][i], status: 'active', leafCommitment: leaf, ...(company.rights[i] === undefined ? {} : { rights: company.rights[i] }),
  })) }; },
  builder: {
    roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => Object.fromEntries(chainIds.map((id) => [id, t.chain[id] ?? { held: 'never', approvals: 0 }])),
    companyWide: async () => WIDE,
    runsOutrun: async () => { t.outrunReads += 1; return t.outrun; },
  },
  chain: { indexer: {}, callState: async () => null },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const showed: Array<{ key: string; values?: Record<string, unknown> }> = [];
  /* What the window asked the person to confirm, with how much had reached the shared code by then. */
  const confirmed: Array<{ lines: readonly { key: string; values?: Record<string, unknown> }[]; handedBefore: number }> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, account: 0 }, at: { step: 3, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a removal is sent through its calls, never a bare relay'); },
    call: async (method: string, path: string) => { t.called.push(`${method} ${path}`); return { status: 404, body: {} }; },
    tell: (x: Record<string, unknown>) => { told.push(x); },
    show: (w: { key: string; values?: Record<string, unknown> }) => { showed.push(w); },
    confirm: async (lines: readonly { key: string; values?: Record<string, unknown> }[]) => {
      confirmed.push({ lines, handedBefore: t.onDevice.length });
      if (t.stops) throw new ActionStopped('stopped');
    },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told, showed, confirmed };
};
const after: Array<{ leaf: string; round: unknown }> = [];
const NONE_CHANGED: VaultsChangedTold = { vaultsRotated: 0, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 };
const reach = () => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, secrets: () => ({}) as never,
  commitments: async () => ({}) as never, reachFor: async () => reachOf() as never,
  afterCarried: async (_c: unknown, _r: unknown, removed: { leaf: string; round: unknown }): Promise<VaultsChangedTold> => { after.push(removed); return NONE_CHANGED; },
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
let carriedAs: string = 'done';
const sharedCode = (input: any) => {
  const round = { id: 'prp_1', chainId: CHAIN_ID, status: 'open' };
  if (input.carryOnly) return carriedAs === 'done' ? { state: 'done', round } : { state: carriedAs, round, signed: 1, needed: 2 };
  const standing = t.chain[CHAIN_ID] as { approvals: number; needed?: number };
  t.chain[CHAIN_ID] = input.approveOnly === undefined ? { held: 'open', approvals: 1, needed: company.approvals, raisedAt: 1 } : { ...standing, approvals: standing.approvals + 1 };
  return { state: (t.chain[CHAIN_ID] as { approvals: number }).approvals >= company.seatBar ? 'ready-to-carry' : 'waiting-for-approvals', round };
};

beforeEach(() => {
  t.onDevice.length = 0;
  t.called.length = 0;
  t.outcome = sharedCode;
  t.opened = null;
  t.chain = {};
  t.outrun = {};
  t.outrunReads = 0;
  after.length = 0;
  carriedAs = 'done';
  t.stops = false;
  t.bands = [];
  t.rosterStop = null;
  t.doors = null;
  t.withdrawn = [];
  company = { approvals: 1, policyBar: null, seatBar: 1, rights: [undefined, undefined, undefined, undefined], seats: [...SEATS] };
});

describe('A SIGNER IS REMOVED IN THE WALLET, AND THE REMOVAL CARRIED OUT AT ITS BAR', () => {
  it('at a bar of one the raise is carried out in the same window, by the one carry step, with the threshold asked and the name the roster holds', async () => {
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER, threshold: '2' });
    const { ctx, told, confirmed } = ctxOf(i);
    await run(removeSignerAction(reach()), i, ctx);
    /* RED WHEN: the person raising is not shown whose seat it is, from the company's list of signers, before anything is handed over. */
    expect(confirmed).toEqual([{
      lines: [{ key: 'act.remove-signer.confirm.removing', values: { name: 'Dee', leaf: LEAVER } }, { key: 'act.remove-signer.shown.threshold', values: { threshold: 2 } }],
      handedBefore: 0,
    }]);
    /* RED WHEN: the raise carries the removal out itself, or the carrying out is not asked for at all, at a bar of one. */
    expect(t.onDevice.map((c) => [c.input.leaf, c.input.newThreshold, c.input.stopBeforeCarry, c.input.carryOnly, c.input.approveOnly]))
      .toEqual([[LEAVER, 2, true, undefined, undefined], [LEAVER, 2, undefined, true, CHAIN_ID]]);
    /* RED WHEN: the name sealed in the proposal is the page's, not the one the company's roster this wallet opened holds. */
    expect(t.onDevice[0]!.input.name).toBe('Dee');
    /* RED WHEN: the page is told the removal was carried out without the approvals and the bar the chain showed. */
    expect(told).toContainEqual({ state: 'carried-out', approvals: 1, needed: 1 });
  });

  it('a removal keeping the threshold names none, and at a bar of two a second signer approves it through the one approval and carries it out', async () => {
    company.seatBar = 2;
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const first = ctxOf(raise);
    await run(removeSignerAction(reach()), raise, first.ctx);
    /* RED WHEN: a removal short of its bar is carried out, or the page is not told it waits for the others. */
    expect(t.onDevice.map((c) => [c.input.newThreshold, c.input.carryOnly])).toEqual([[0, undefined]]);
    expect(first.told).toContainEqual({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
    t.onDevice.length = 0;
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: LEAVER } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    const second = ctxOf(approve);
    await run(approveProposalAction(reach() as never), approve, second.ctx);
    /* RED WHEN: the approval carries the removal out in the same call, or no step carries it out once the chain counts two. */
    expect(t.onDevice.map((c) => [c.input.approveOnly, c.input.stopBeforeCarry, c.input.carryOnly]))
      .toEqual([[CHAIN_ID, true, undefined], [CHAIN_ID, undefined, true]]);
    expect(second.told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('a proposal under the name the page gave that removes another seat, or at another threshold, is not approved', async () => {
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1 };
    company.seatBar = 2;
    for (const governance of [{ kind: 'remove-signer', leaf: SEATS[2] }, { kind: 'remove-signer', leaf: LEAVER, threshold: '3' }, { kind: 'threshold', threshold: '2' }]) {
      t.opened = { chainId: CHAIN_ID, governance };
      const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER, threshold: '2' });
      /* RED WHEN: a removal is approved on the page's word of what it removes, not on the record this wallet opened. */
      expect((await refusalOf(run(approveProposalAction(reach() as never), approve, ctxOf(approve).ctx))).key).toBe('act.remove-signer.why.not-as-shown');
    }
    expect(t.onDevice).toEqual([]);
  });

  /*
   * RED WHEN: an approved removal is named to the approver only by the page's leaf, never by the seat the company's
   * list of signers, as this wallet opened it, holds at that leaf; or a removal of a leaf that list does not hold is
   * approved, named, or anything of it handed to the shared code.
   */
  it('an approval names the seat removed from the wallet\'s own list of signers, and refuses a seat that list does not hold', async () => {
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1 };
    company.seatBar = 2;
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: LEAVER } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    expect(await approveProposalAction(reach() as never).shown(approve)).toContainEqual({ key: 'act.remove-signer.shown.named-here', from: 'action' });
    const named = ctxOf(approve);
    await run(approveProposalAction(reach() as never), approve, named.ctx);
    /* RED WHEN: the approver is told whose seat it is only after their approval is on its way, or not asked to confirm it. */
    expect(named.confirmed).toEqual([{
      lines: [{ key: 'act.remove-signer.confirm.removing', values: { name: 'Dee', leaf: LEAVER } }, { key: 'act.remove-signer.shown.keeps-the-threshold' }],
      handedBefore: 0,
    }]);
    /* RED WHEN: the name sealed in the approval is read again after it was shown, or is not the one confirmed. */
    expect(t.onDevice.map((c) => c.input.name)).toEqual(['Dee', 'Dee']);
    expect(named.showed).toEqual([{ key: 'act.remove-signer.over.removing', values: { name: 'Dee', leaf: LEAVER } }]);
    t.onDevice.length = 0;
    const NOBODY = 'f9'.repeat(32);
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: NOBODY } };
    const other = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: NOBODY });
    const refused = ctxOf(other);
    expect((await refusalOf(run(approveProposalAction(reach() as never), other, refused.ctx))).key).toBe('act.remove-signer.why.no-such-seat');
    expect(t.onDevice).toEqual([]);
    expect(refused.showed).toEqual([]);
    expect(refused.confirmed).toEqual([]);
    expect(WORDS['act.remove-signer.why.no-such-seat']).toMatch(/Nothing was approved and nothing was sent\. Do not approve it/u);
  });

  /* RED WHEN: Stop at the window's Confirm of whose seat it is still hands the raise or the approval to the shared code. */
  it('Stop at the Confirm of whose seat it is approves nothing and raises nothing', async () => {
    t.stops = true;
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const raising = ctxOf(raise);
    expect(await run(removeSignerAction(reach()), raise, raising.ctx).then(() => null, (e: unknown) => e)).toBeInstanceOf(ActionStopped);
    expect(raising.confirmed).toHaveLength(1);
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 2, raisedAt: 1 };
    company.seatBar = 2;
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: LEAVER } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    const approver = ctxOf(approve);
    expect(await run(approveProposalAction(reach() as never), approve, approver.ctx).then(() => null, (e: unknown) => e)).toBeInstanceOf(ActionStopped);
    expect(approver.confirmed).toHaveLength(1);
    expect(t.onDevice).toEqual([]);
    expect(after).toEqual([]);
  });

  /*
   * RED WHEN: the removal's first step is titled as if it only read the company; the words of its Confirm say only
   * "approved" where the person may be raising it; or a refusal's words are written in the code.
   */
  it('the first step and the Confirm say what they do on both the raise and the approval, in the wallet\'s own words', () => {
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    expect(removeSignerAction(reach()).steps(raise)[0]!.title.key).toBe('act.remove-signer.step.seat');
    expect(WORDS['act.remove-signer.step.seat']).toMatch(/whose seat this removal takes, and show it to you to confirm/u);
    expect(WORDS['act.remove-signer.confirm.removing']).toMatch(/nothing is approved, raised or sent/u);
    expect(WORDS['act.remove-signer.why.not-read-to-raise']).toMatch(/nothing was raised/u);
    expect(WORDS['act.remove-signer.why.not-read']).toMatch(/nothing was approved/u);
    const source = readFileSync(new URL('./remove-signer.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/has not read whose seat/u);
  });

  /* RED WHEN: a raise the chain would refuse, of a seat the account does not hold, is asked to be confirmed, or anything of it handed over. */
  it('a raise the chain would refuse is refused before the Confirm', async () => {
    const i = intent('remove-signer', { ...BASE, leaf: 'f9'.repeat(32) });
    const refused = ctxOf(i);
    expect((await refusalOf(run(removeSignerAction(reach()), i, refused.ctx))).key).toBe('act.remove-signer.why.refused');
    expect(refused.confirmed).toEqual([]);
    expect(t.onDevice).toEqual([]);
  });
});

describe('A REMOVAL THAT BREAKS A RULE IS REFUSED BEFORE ANYTHING IS BUILT', () => {
  it('a removal leaving a vault unable to pay, fewer signers than the threshold, or a seat the account does not hold, is refused and nothing is handed on', async () => {
    Object.assign(company, { approvals: 2, seatBar: 2, rights: [undefined, raiserOnly, raiserOnly, undefined] });
    for (const [fields, says] of [
      [{ leaf: LEAVER }, /unable to pay/u],
      [{ leaf: SEATS[2]!, threshold: '4' }, /3 signers left, and the account needs 4 approvals/u],
      [{ leaf: 'ef'.repeat(32) }, /does not hold a seat on the company's account/u],
    ] as const) {
      const i = intent('remove-signer', { ...BASE, ...fields });
      const refused = await refusalOf(run(removeSignerAction(reach()), i, ctxOf(i).ctx));
      /* RED WHEN: a removal the chain would refuse when carried out, or one that leaves a vault unable to pay, is handed on to be built. */
      expect(refused.key).toBe('act.remove-signer.why.refused');
      expect(refused.says).toMatch(says);
    }
    expect(t.onDevice).toEqual([]);
    expect(t.called.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('a removal leaving a vault short of the approvals a spending policy in force asks for is refused at the raise, as the send refuses it', async () => {
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    /* The control: with no policy in force, three signers who may approve stay for the vault's one. */
    await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
    expect(t.onDevice).toHaveLength(2);
    t.onDevice.length = 0;
    t.bands = [{ vault: PAYROLL, band: 4 }];
    const refused = ctxOf(i);
    const no = await refusalOf(run(removeSignerAction(reach()), i, refused.ctx));
    /* RED WHEN: the wallet's early check counts the vault's approvers without the bands in force, and passes a removal the send refuses. */
    expect(no.key).toBe('act.remove-signer.why.refused');
    expect(refused.confirmed).toEqual([]);
    expect(t.onDevice).toEqual([]);
  });

  it('a run open on the chain needs one approval more once a signer is removed, so a removal leaving its vault one short is refused, at the raise and before every send', async () => {
    Object.assign(company, { approvals: 2, seatBar: 2, rights: [undefined, undefined, undefined, raiserOnly] });
    const i = intent('remove-signer', { ...BASE, leaf: SEATS[2]! });
    /* The control: with no run open, three signers who may approve less one still meet the vaults' two. */
    await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
    expect(t.onDevice).toHaveLength(1);
    /* One run open on the chain, raised with no signer removed since, as the wallet's indexer reads it. */
    t.outrun = { ['de'.repeat(32)]: 0 };
    t.onDevice.length = 0;
    const refused = await refusalOf(run(removeSignerAction(reach()), i, ctxOf(i).ctx));
    expect(refused.says).toMatch(/its runs need 3 approvals and 2 signers could give them/u);
    /* RED WHEN: the refusal does not name the open run and what lets the removal through. */
    expect(refused.says).toContain(`run ${'de'.repeat(32)} is open`);
    expect(t.onDevice).toEqual([]);
  });

  it('a seat or a threshold the page did not write as one is refused before the window opens', async () => {
    for (const fields of [{ leaf: 'AB'.repeat(32) }, { leaf: LEAVER, threshold: '1.5' }, { leaf: LEAVER, threshold: '-1' }] as Record<string, string>[]) {
      /* RED WHEN: a seat in another case, or a threshold that is not a whole number, reaches the shared code. */
      expect((await removeSignerAction(reach()).check(intent('remove-signer', { ...BASE, ...fields }), {} as never))?.key).toBe('act.remove-signer.why.not-a-removal');
    }
  });

  /* RED WHEN: the wallet hands the shared code a check of its own, so the removal's approvers are counted twice before every send and the two counts can differ. */
  it('the wallet hands the shared code no check of its own, and counts the removal\'s approvers once per press, at the first step of a raise and not at all for an approval', async () => {
    /* The shared code, as it runs its check before each send: the caller's own check is run when it is given one. */
    t.outcome = async (input: any) => { await input.before?.(); return sharedCode(input); };
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
    expect(t.onDevice).toHaveLength(2);
    for (const c of t.onDevice) expect(c.input.before).toBeUndefined();
    expect(t.outrunReads).toBe(1);
    t.outrunReads = 0;
    t.onDevice.length = 0;
    company = { ...company, seatBar: 3 };
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 3, raisedAt: 1 };
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: LEAVER } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    await run(approveProposalAction(reach() as never), approve, ctxOf(approve).ctx);
    expect(t.onDevice.length).toBeGreaterThan(0);
    for (const c of t.onDevice) expect(c.input.before).toBeUndefined();
    expect(t.outrunReads).toBe(0);
  });
});

describe('THE VAULT SECRET\'S ROTATION HAS ONE PLACE, RUN ONLY ONCE THE REMOVAL IS CARRIED OUT', () => {
  it('the hook is given the leaf and the proposal once the chain carried the removal out, from the removal and from the one approval alike', async () => {
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
    /* RED WHEN: the rotation's hook is not run once the removal is carried out, or is run with another seat or proposal. */
    expect(after).toEqual([{ leaf: LEAVER, round: { id: 'prp_1', chainId: CHAIN_ID } }]);
    after.length = 0;
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 1, raisedAt: 1 };
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: LEAVER } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    await run(approveProposalAction(reach() as never), approve, ctxOf(approve).ctx);
    expect(after).toHaveLength(1);
  });

  it('a removal whose retirement is not yet signed by enough seats says so, and the hook does not run', async () => {
    carriedAs = 'waiting-for-the-retirement';
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const { ctx, told } = ctxOf(i);
    await run(removeSignerAction(reach()), i, ctx);
    /* RED WHEN: a removal still waiting on its retirement is told to the page as carried out, or the rotation runs before it is. */
    expect(told).toContainEqual({ state: 'waiting-for-the-retirement', approvals: 1, needed: 1 });
    expect(told.map((x) => x['state'])).not.toContain('carried-out');
    expect(after).toEqual([]);
  });
});

describe('A REMOVAL CARRIED OUT CHANGES THE VAULT SECRETS ON THE COMPANY READ AGAIN, AND TELLS THE PAGE WHAT CHANGED', () => {
  it('the removal and the one approval of a removal pass their checks, and the raise is handed to the shared code', async () => {
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    /* RED WHEN: a removal is still refused at its check now that the wallet changes the vault secrets after it. */
    expect(await removeSignerAction(reach()).check(raise, {} as never)).toBeNull();
    expect(await approveProposalAction(reach() as never).check(approve, {} as never)).toBeNull();
    await run(removeSignerAction(reach()), raise, ctxOf(raise).ctx);
    expect(t.onDevice.length).toBeGreaterThan(0);
  });

  it('the hook runs on the company read again after the key change, and the page is told the key change and how many vaults changed', async () => {
    let reads = 0;
    let readsAtTheCarry = -1;
    t.outcome = (input: any) => {
      if (!input.carryOnly) return sharedCode(input);
      readsAtTheCarry = reads;
      return { ...sharedCode(input), rotation: { state: 'rotated', epoch: 1, version: 2 } };
    };
    const handedTo: unknown[] = [];
    const counted = { ...reach(),
      reachFor: async () => { reads += 1; return { ...reachOf(), read: reads } as never; },
      afterCarried: async (_c: unknown, r: unknown) => { handedTo.push(r); return { vaultsRotated: 1, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 }; },
    };
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const { ctx, told } = ctxOf(i);
    await run(removeSignerAction(counted), i, ctx);
    /* RED WHEN: the hook changes the vault secrets on the company as read before the company key changed. */
    expect((handedTo[0] as { read: number }).read).toBeGreaterThan(readsAtTheCarry);
    /* RED WHEN: the page is not told the company key's change or how many vaults ended in each state. */
    expect(told).toContainEqual({ rotation: 'rotated' });
    expect(told).toContainEqual({ vaultsRotated: 1, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 });
  });

  it('a hook that cannot start leaves the removal carried out and says the vault secrets were not started', async () => {
    const failing = { ...reach(), afterCarried: async () => { throw new Error('the company could not be read'); } };
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const { ctx, told } = ctxOf(i);
    await run(removeSignerAction(failing), i, ctx);
    /* RED WHEN: a removal the chain carried out is told as not carried, or the vault secrets left unchanged are not said. */
    expect(told).toContainEqual({ vaultSecrets: 'not-started', vaultSecretsWhy: 'error' });
    expect(told.map((x) => x['state'])).toContain('carried-out');
  });

  /* RED WHEN: a removal carried out whose vault secrets could not be changed drops what stopped the change, so the signer is never told why. */
  it('a hook that stops tells the page what kind of stop it was, as a code and never its message', async () => {
    const failing = { ...reach(), afterCarried: async () => { throw Object.assign(new Error('the records at https://x.example could not be read'), { name: 'VaultRecordsNotRead' }); } };
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const { ctx, told } = ctxOf(i);
    await run(removeSignerAction(failing), i, ctx);
    expect(told).toContainEqual({ vaultSecrets: 'not-started', vaultSecretsWhy: 'vault-records-not-read' });
    expect(JSON.stringify(told)).not.toContain('example');
  });

  it('a Stop inside the change after the chain carried the removal still tells the removal carried out and the change not started', async () => {
    let hooks = 0;
    const stopping = { ...reach(), afterCarried: async () => { hooks += 1; throw new ActionStopped('stopped'); } };
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const { ctx, told } = ctxOf(i);
    await run(removeSignerAction(stopping), i, ctx);
    /* RED WHEN: a Stop during the change hides that the chain carried the removal out, and no press is ever told the change is owed. */
    expect(hooks).toBe(1);
    expect(told).toContainEqual({ vaultSecrets: 'not-started' });
    expect(told.map((x) => x['state'])).toContain('carried-out');
  });

  it('an approval of a removal that does not carry it out runs no hook and raises nothing', async () => {
    company = { ...company, seatBar: 3 };
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 3, raisedAt: 1 };
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: LEAVER } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    await run(approveProposalAction(reach() as never), approve, ctxOf(approve).ctx);
    /* RED WHEN: an approval that leaves the removal short of its bar changes a vault secret or raises a proposal. */
    expect(after).toEqual([]);
    expect(t.called.filter((c) => /^POST \/api\/accounts\/[^\/]+\/proposals$|\/send$/u.test(c))).toEqual([]);
  });
});

describe('THE ACTIONS THE WALLET REGISTERS RUN A REMOVAL AND CHANGE THE VAULT SECRETS AFTER IT', () => {
  it('the registered removal and approval of a removal pass their checks, and the change of the vault secrets is registered', async () => {
    /* The wallet's settings read the page's address when loaded; the registry's actions read nothing else from it here. */
    vi.stubGlobal('window', { location: { hostname: 'localhost', origin: 'http://localhost' } });
    const { ACTIONS, actionFor } = await import('./registry.js').finally(() => vi.unstubAllGlobals());
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    /* RED WHEN: the wallet's own registry still refuses a removal, or registers no press for an owed change of the vault secrets. */
    expect(await ACTIONS['remove-signer'].check(raise, {} as never)).toBeNull();
    expect(await ACTIONS['approve-proposal'].check(approve, {} as never)).toBeNull();
    expect(actionFor('rotate-vault-secrets')).toBe(ACTIONS['rotate-vault-secrets']);
  });
});

describe('THE WALLET ASKS THE PAGE ONLY FOR THE CALLS THE ACT LISTS, IN WORDS IT HOLDS, AND ONLY THE SIGNERS PAGE\'S WALLET FILES ASK FOR THE REMOVAL', () => {
  it('every call is one its act lists; the retirement route is listed for both acts and does not send; every word is written', async () => {
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
    for (const c of t.called) expect(routeOf(intentShapeOf('remove-signer')!, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    for (const name of ['remove-signer', 'approve-proposal'] as const) {
      const route = routeOf(intentShapeOf(name)!, 'POST', '/api/proposals/prp_1/retirement');
      /* RED WHEN: a seat's retirement signature cannot be handed on its own, or the route is counted as a send though it relays nothing. */
      expect(route, name).not.toBeNull();
      expect(route!.sends === true, name).toBe(false);
      expect(routeOf(intentShapeOf(name)!, 'POST', '/api/proposals/prp_1/carry')?.sends, name).toBe(true);
    }
    const source = readFileSync(new URL('./remove-signer.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/'(act\.remove-signer\.[a-z.-]+)'/gu)].map((m) => m[1]!);
    const whys = [...source.matchAll(/[wW]hy\('([a-z-]+)'/gu)].map((m) => m[1]!);
    const stops = ['not-approved', 'may-be-sent', 'withdrawn', 'carried-out', 'already-counted', 'not-raised', 'outrun', 'not-carried', 'refused',
      'not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened'];
    /* RED WHEN: the wallet says a word its language file does not hold. */
    for (const k of [...keys, ...[...whys, ...stops].map((w) => `act.remove-signer.why.${w}`)]) expect(WORDS[k], k).toBeTypeOf('string');
  });

  it('the window promises of the vault secrets only what the change does: started at once, in force once approved and set', async () => {
    const shown = await removeSignerAction(reach()).shown(intent('remove-signer', { ...BASE, leaf: LEAVER }));
    expect(shown).toContainEqual({ key: 'act.remove-signer.shown.vault-secrets', from: 'action' });
    const line = WORDS['act.remove-signer.shown.vault-secrets']!;
    /* RED WHEN: the window promises the signer who left cannot open what comes next, though the change may wait for approvals or the company's key. */
    expect(line).not.toMatch(/cannot open/u);
    expect(line).toMatch(/set only once its change has the approvals it needs/u);
    expect(line).toMatch(/until the new secret is set, payments out of a vault, and the remainder each one returns to it, are made as before, and the signer who left can still read them/u);
    /* RED WHEN: the window leaves out that deposits into a vault wait for its new secret, the thing the signer meets next. */
    expect(line).toMatch(/Deposits made from this product into a vault wait until its new secret is set and filed/u);
    /* RED WHEN: the proofs listed leave out the approval a seat makes when its raise does not count as one. */
    expect(line).toMatch(/one that approves it where your seat's raise does not already count as an approval/u);
  });

  it('the approve window does not say the press raises nothing, since a press that brings the removal to its approvals carries it out and may start each vault\'s secret change', () => {
    const line = WORDS['act.remove-signer.shown.approve']!;
    /* RED WHEN: the approve window tells the person their press raises nothing, though it may carry the removal out and start the vaults' secret change. */
    expect(line).not.toMatch(/raises nothing/u);
    expect(line).toMatch(/this wallet may also start each vault's secret change/u);
    expect(line).toMatch(/adds your seat's approval to the removal the network already holds/u);
  });

  it('only the two files that ask the wallet for acts of the signers page name the removal or the vault secret change: no screen does', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const shipping = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : shipping(p);
      return /\.(ts|tsx)$/u.test(n) && !/\.test(-support)?\.tsx?$/u.test(n) ? [p] : [];
    });
    const acts = '(remove-signer|rotate-vault-secrets)';
    const onAPage = new RegExp(`(name|act|intent)\\s*:\\s*['"]${acts}['"]|kind\\s*:\\s*['"]removal['"]|:\\s*['"]${acts}['"]\\s*[,}]`, 'u');
    const inShared = new RegExp(`name\\s*:\\s*['"]${acts}['"]|kind\\s*:\\s*['"]removal['"]`, 'u');
    const allowed = [join(root, 'apps/web/src/adapters/signer-acts.ts'), join(root, 'packages/web-shared/src/proposal-in-the-wallet.ts')];
    const asks = [
      ...shipping(join(root, 'apps/web/src')).filter((p) => !allowed.includes(p) && onAPage.test(readFileSync(p, 'utf8'))),
      ...shipping(join(root, 'packages/web-shared/src')).filter((p) => !allowed.includes(p) && inShared.test(readFileSync(p, 'utf8'))),
    ];
    /* RED WHEN: a screen or another shared file names the removal action, the vault secret change, or the removal kind of the one approval as something to ask the wallet for. */
    expect(asks).toEqual([]);
    /* RED WHEN: the page's own wallet files stop naming the two acts, so this test no longer looks at the files that ask. */
    const named = allowed.map((p) => readFileSync(p, 'utf8'));
    expect(named.some((t) => /remove-signer/u.test(t)) && named.some((t) => /rotate-vault-secrets/u.test(t))).toBe(true);
  });
});

/*
 * The roster read stopped where the network shows a seat taken on an invitation the wallet cannot tie to that one
 * invitation: Ada, Bo and Cy are believed on their own directory entries, `unread` are the seats it could not tell, and
 * `waited` the seats someone invited waits for, each on the chain beside the company's four.
 */
const seatingStop = (unread: readonly string[], waited: readonly string[] = []) => seatingRefusedHolding(new RosterNotBelieved('The network shows a seat taken on an invitation this device cannot tie to it.', null, null, { check: 'seating-refused' }), {
  opened: { id: 'acc_1', name: 'Acme', signers: SEATS.slice(0, 3).map((leaf, i) => ({
    id: `s${i + 1}`, name: ['Ada', 'Bo', 'Cy'][i], status: 'active', leafCommitment: leaf, signingPublicKey: `0${i}`.repeat(32), userId: `usr_${i}`,
  })) } as never,
  witnesses: {
    accountId: 'acc_1', label: LABEL, account: ACCOUNT as never, seatsOnTheChain: [...new Set([...SEATS, ...unread, ...waited].map((x) => x.toLowerCase()))], own: null,
    directory: SEATS.slice(0, 3).map((seat, i) => ({ seat, signingKey: `0${i}`.repeat(32), committeeKey: { tag: 't', value: 'v' }, retired: false, role: null, person: `usr_${i}` })),
  },
  waited: new Set<string>(waited),
}, unread);

describe('WHILE THE ROSTER READ STOPS ON A SEAT IT CANNOT TELL, ONLY THAT SEAT\'S REMOVAL GOES AHEAD', () => {
  it('the removal of that seat is raised, named by fixed words and its leaf, with its approvers counted from the signers believed', async () => {
    t.rosterStop = seatingStop([LEAVER.toUpperCase()]);
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const { ctx, confirmed } = ctxOf(i);
    await run(removeSignerAction(reach()), i, ctx);
    /* RED WHEN: the removal that clears the stop cannot be raised, because it reads the roster every other read stops on. */
    expect(t.onDevice.map((c) => [c.input.leaf, c.input.stopBeforeCarry])[0]).toEqual([LEAVER, true]);
    /* RED WHEN: the person is shown a name the network does not give, or the seat's leaf is not shown, before anything is handed over. */
    expect(confirmed.map((c) => [c.lines[0], c.handedBefore])).toEqual([[{ key: 'act.remove-signer.confirm.removing-unread', values: { leaf: LEAVER } }, 0]]);
    /* RED WHEN: the name sealed for the seat is taken from the page, or from anything but the fixed words. */
    expect(t.onDevice.every((c) => c.input.name === UNREAD_SEAT_NAME)).toBe(true);
    /* RED WHEN: the device's own check before each send counts approvers from a roster that stops, or counts the unread seat as one. */
    expect([...(await t.doors.approvers()).seats.keys()]).toEqual(SEATS.slice(0, 3));
  });

  it('with two seats it cannot tell and one waiting for Finish adding, either unread seat\'s removal is raised, its approvers the signers believed', async () => {
    const [second, waiting] = ['e5', 'f6'].map((x) => x.repeat(32)) as [string, string];
    company.seats = [...SEATS, second, waiting];
    for (const leaf of [LEAVER, second]) {
      t.onDevice.length = 0;
      t.chain = {};
      t.rosterStop = seatingStop([LEAVER, second], [waiting]);
      const i = intent('remove-signer', { ...BASE, leaf });
      await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
      /* RED WHEN: a second seat the read cannot tell, or one waiting for Finish adding, stops the removal that clears the stop, sending the person to Finish adding, which stops on the same seat. */
      expect(t.onDevice.map((c) => [c.input.leaf, c.input.name])[0]).toEqual([leaf, UNREAD_SEAT_NAME]);
      /* RED WHEN: a seat the believed signers do not name is counted as an approver. */
      expect([...(await t.doors.approvers()).seats.keys()]).toEqual(SEATS.slice(0, 3));
    }
  });

  it('the removal of any other seat is refused, with words saying the unread seat is removed first, and nothing is handed on', async () => {
    t.rosterStop = seatingStop([LEAVER]);
    const i = intent('remove-signer', { ...BASE, leaf: SEATS[2]! });
    const refused = ctxOf(i);
    const e = await run(removeSignerAction(reach()), i, refused.ctx).then(() => null, (x: unknown) => x);
    /* RED WHEN: another seat's removal goes ahead while the roster read stops, or is refused in words that do not say what clears it. */
    expect(e).toBeInstanceOf(StepRefused);
    expect((e as StepRefused).words).toEqual({ key: 'act.remove-signer.why.unread-seat-first', values: { seats: LEAVER } });
    expect(WORDS['act.remove-signer.why.unread-seat-first']).toMatch(/\{seats\}.*Remove that seat first, then this one/u);
    expect([refused.confirmed, t.onDevice]).toEqual([[], []]);
  });

  it('another signer approves the removal of that seat through the one approval, named the same way', async () => {
    t.rosterStop = seatingStop([LEAVER]);
    company.seatBar = 2;
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    await run(removeSignerAction(reach()), raise, ctxOf(raise).ctx);
    t.onDevice.length = 0;
    t.opened = { chainId: CHAIN_ID, governance: { kind: 'remove-signer', leaf: LEAVER } };
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    const second = ctxOf(approve);
    await run(approveProposalAction(reach() as never), approve, second.ctx);
    /* RED WHEN: the approval that would clear the stop is refused because it reads the roster every other read stops on. */
    expect(t.onDevice.map((c) => [c.input.approveOnly, c.input.stopBeforeCarry, c.input.carryOnly, c.input.name]))
      .toEqual([[CHAIN_ID, true, undefined, UNREAD_SEAT_NAME], [CHAIN_ID, undefined, true, UNREAD_SEAT_NAME]]);
    /* RED WHEN: the approver is told a name for the seat, or not told its leaf. */
    expect(second.showed).toContainEqual({ key: 'act.remove-signer.over.removing-unread', values: { leaf: LEAVER } });
    expect(second.told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
    /* RED WHEN: the device's check before the carrying out counts approvers from a roster that stops. */
    expect([...(await t.doors.approvers()).seats.keys()]).toEqual(SEATS.slice(0, 3));
  });

  it('a roster read that stops for any other reason still stops the removal, with nothing handed on', async () => {
    t.rosterStop = new RosterNotBelieved('This page could not check the network for a signer.', null, null, { check: 'chain-unread' });
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const refused = ctxOf(i);
    const said = await refusalOf(run(removeSignerAction(reach()), i, refused.ctx));
    /* RED WHEN: a roster that stops for a reason a removal does not clear is read past for a removal. */
    expect([said.key, said.says]).toEqual(['act.remove-signer.why.not-raised', 'This page could not check the network for a signer.']);
    expect([refused.confirmed, t.onDevice]).toEqual([[], []]);
  });

  it('the words for a seat the roster names no one for are written, and promise nothing of who holds it', () => {
    /* RED WHEN: the window names the seat's holder, or says the seat is the company's own, where the network shows only a seat. */
    for (const key of ['act.remove-signer.confirm.removing-unread', 'act.remove-signer.over.removing-unread']) {
      expect(WORDS[key]).toMatch(/\{leaf\}/u);
      expect(WORDS[key]).not.toMatch(/\{name\}/u);
      expect(WORDS[key]).toMatch(/names no one for it/u);
    }
  });
});

describe('A REMOVAL OF A SEAT WITHDRAWN BEFORE IS RAISED AGAIN ONLY AFTER THE PERSON IS TOLD', () => {
  it('the raise\'s Confirm says a removal of this seat was withdrawn before and that this raises a new one; nothing is refused', async () => {
    t.withdrawn = ['prp_0', 'prp_1'];
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const { ctx, confirmed } = ctxOf(i);
    await run(removeSignerAction(reach()), i, ctx);
    /* RED WHEN: a removal of a seat withdrawn before is raised again with nothing said at the Confirm. */
    expect(confirmed[0]!.lines.at(-1)).toEqual({ key: 'act.remove-signer.confirm.withdrawn-before', values: { proposals: 'prp_0, prp_1' } });
    expect(confirmed[0]!.handedBefore).toBe(0);
    expect(t.onDevice.length).toBeGreaterThan(0);
    expect(WORDS['act.remove-signer.confirm.withdrawn-before']).toMatch(/\{proposals\}.*Confirming raises a new one/u);
  });
});
