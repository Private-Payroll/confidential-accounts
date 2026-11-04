import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A SIGNER IS REMOVED FROM THE WALLET, ONE WINDOW EACH, WITH OR WITHOUT A NEW THRESHOLD.** The removal is raised by one
 * signer and approved and carried out by another, through the shared code that proves and sends each call and files the
 * leaving seat's retirement (stood in for here, and followed against the chain in
 * packages/web-shared/src/a-signer-is-removed-from-the-devices.test.ts). What is pinned: every check is made from the
 * chain and the company's records before anything is handed to the shared code, and handed to it again for every send;
 * the carrying out is a step of its own that reads the chain first; the bar is the chain's; the vault secret's rotation
 * has one place to plug in, run only once the removal is carried out; until it is given, the wallet refuses every removal
 * before anything is sent; and no page asks for the action. Whose seat it is, read from the company's list of signers,
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
  /* Whether the person presses Stop at the window's Confirm instead of Confirm. */
  stops: false,
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  removeSignerOnDevice: async (_doors: unknown, input: any) => { t.onDevice.push({ input }); return t.outcome!(input); },
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

const { removeSignerAction, removalKind, RemovalRefused } = await import('./remove-signer.js');
const { approving } = await import('./proposal-kinds.js');
const { approveProposalAction } = await import('./approve-proposal.js');
const { ActionStopped } = await import('./run.js');

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
  roster: async () => ({ id: 'acc_1', name: 'Acme', notBelieved: [], signers: SEATS.map((leaf, i) => ({
    id: `s${i + 1}`, name: ['Ada', 'Bo', 'Cy', 'Dee'][i], status: 'active', leafCommitment: leaf, ...(company.rights[i] === undefined ? {} : { rights: company.rights[i] }),
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
const reach = () => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, secrets: () => ({}) as never,
  commitments: async () => ({}) as never, reachFor: async () => reachOf() as never,
  afterCarried: async (_c: unknown, _r: unknown, removed: { leaf: string; round: unknown }) => { after.push(removed); },
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
  after.length = 0;
  carriedAs = 'done';
  t.stops = false;
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

  it('a run open on the chain needs one approval more once a signer is removed, so a removal leaving its vault one short is refused, at the raise and before every send', async () => {
    Object.assign(company, { approvals: 2, seatBar: 2, rights: [undefined, undefined, undefined, raiserOnly] });
    const i = intent('remove-signer', { ...BASE, leaf: SEATS[2]! });
    /* The control: with no run open, three signers who may approve less one still meet the vaults' two. */
    await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
    expect(t.onDevice).toHaveLength(1);
    /* One run open on the chain, raised with no signer removed since, as the wallet's indexer reads it. */
    t.outrun = { ['de'.repeat(32)]: 0 };
    /* RED WHEN: a run open and not yet outrun is not counted, and the removal leaves it needing three approvals of two signers. */
    await expect(t.onDevice[0]!.input.before()).rejects.toBeInstanceOf(RemovalRefused);
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

  it('the same check is handed to the shared code, which runs it before every send', async () => {
    const i = intent('remove-signer', { ...BASE, leaf: LEAVER });
    await run(removeSignerAction(reach()), i, ctxOf(i).ctx);
    Object.assign(company, { approvals: 2, rights: [undefined, raiserOnly, raiserOnly, undefined] });
    /* RED WHEN: the check before a send is not the one the raise made, and a company changed since passes it. */
    expect(t.onDevice).toHaveLength(2);
    for (const c of t.onDevice) await expect(c.input.before()).rejects.toBeInstanceOf(RemovalRefused);
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

describe('UNTIL THE WALLET ROTATES THE VAULT SECRETS, IT REFUSES EVERY REMOVAL BEFORE ANYTHING IS SENT', () => {
  it('the removal and the one approval of a removal, as the wallet runs them, are both refused in plain words, and nothing reaches the shared code', async () => {
    const { AFTER_A_REMOVAL } = await import('./after-a-removal.js');
    const wired = { ...reach(), ...AFTER_A_REMOVAL };
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    /* RED WHEN: the wallet raises a removal while the leaving signer would keep the vault secrets. */
    expect((await removeSignerAction(wired).check(raise, {} as never))?.key).toBe('act.remove-signer.why.waits-for-the-rotation');
    /* RED WHEN: the wallet approves or carries out a removal raised elsewhere while the leaving signer would keep the vault secrets. */
    expect((await approveProposalAction(wired as never).check(approve, {} as never))?.key).toBe('act.remove-signer.why.waits-for-the-rotation');
    expect(WORDS['act.remove-signer.why.waits-for-the-rotation']).toMatch(/[Nn]othing was sent/u);
    expect(t.onDevice).toEqual([]);
    expect(after).toEqual([]);
  });

  it('the raise, an approval and the carrying out each refuse on their own too, before anything is handed to the shared code', async () => {
    const { AFTER_A_REMOVAL } = await import('./after-a-removal.js');
    const wired = { ...reach(), ...AFTER_A_REMOVAL };
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    const waits = 'act.remove-signer.why.waits-for-the-rotation';
    /* RED WHEN: the raise sends a removal while the leaving signer would keep the vault secrets, though its check was skipped. */
    expect((await refusalOf(removeSignerAction(wired).steps(raise)[2]!.run(ctxOf(raise).ctx))).key).toBe(waits);
    const kind = removalKind(wired);
    const round = { id: 'prp_1', chainId: CHAIN_ID };
    const handed = { over: false };
    /* RED WHEN: an approval of a removal is sent while the leaving signer would keep the vault secrets. */
    expect((await refusalOf(kind.approve(ctxOf(approve).ctx, reachOf() as never, approve, round, handed))).key).toBe(waits);
    t.chain[CHAIN_ID] = { held: 'open', approvals: 1, needed: 1, raisedAt: 1 };
    const here = approving();
    here.round = round;
    const carry = kind.carry!(here, { at: async () => reachOf() as never, renew: () => {} }, approve)[0]!;
    /* RED WHEN: a removal at its bar is carried out while the leaving signer would keep the vault secrets. */
    expect((await refusalOf(carry.run(ctxOf(approve).ctx))).key).toBe(waits);
    expect(t.onDevice).toEqual([]);
    expect(handed.over).toBe(false);
    expect(after).toEqual([]);
  });
});

describe('THE ACTIONS THE WALLET REGISTERS REFUSE EVERY REMOVAL UNTIL IT ROTATES THE VAULT SECRETS', () => {
  it('the registered removal and the registered approval of a removal both refuse, with the words that say why', async () => {
    /* The wallet's settings read the page's address when loaded; the registry's actions read nothing else from it here. */
    vi.stubGlobal('window', { location: { hostname: 'localhost', origin: 'http://localhost' } });
    const { ACTIONS } = await import('./registry.js').finally(() => vi.unstubAllGlobals());
    const raise = intent('remove-signer', { ...BASE, leaf: LEAVER });
    const approve = intent('approve-proposal', { ...BASE, proposal: 'prp_1', kind: 'removal', leaf: LEAVER });
    /* RED WHEN: the wallet's own registry wires removal so that a signer can be removed before the vault secrets are rotated. */
    expect((await ACTIONS['remove-signer'].check(raise, {} as never))?.key).toBe('act.remove-signer.why.waits-for-the-rotation');
    expect((await ACTIONS['approve-proposal'].check(approve, {} as never))?.key).toBe('act.remove-signer.why.waits-for-the-rotation');
  });
});

describe('THE WALLET ASKS THE PAGE ONLY FOR THE CALLS THE ACT LISTS, IN WORDS IT HOLDS, AND NO PAGE ASKS FOR IT', () => {
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

  it('no page file asks the wallet to remove a signer: the action stays off every screen until the vault secret is rotated', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const shipping = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : shipping(p);
      return /\.(ts|tsx)$/u.test(n) && !/\.test(-support)?\.tsx?$/u.test(n) ? [p] : [];
    });
    const asks: string[] = [];
    for (const p of shipping(join(root, 'apps/web/src'))) {
      const text = readFileSync(p, 'utf8');
      /* RED WHEN: a page file names the removal action, or the removal kind of the one approval, as something to ask the wallet for. */
      if (/(name|act|intent)\s*:\s*['"]remove-signer['"]|kind\s*:\s*['"]removal['"]|:\s*['"]remove-signer['"]\s*[,}]/u.test(text)) asks.push(p);
    }
    for (const p of shipping(join(root, 'packages/web-shared/src'))) {
      if (/name\s*:\s*['"]remove-signer['"]|kind\s*:\s*['"]removal['"]/u.test(readFileSync(p, 'utf8'))) asks.push(p);
    }
    expect(asks).toEqual([]);
  });
});
