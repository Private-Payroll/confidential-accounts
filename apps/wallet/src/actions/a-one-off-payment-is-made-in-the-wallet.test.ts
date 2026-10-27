import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { PUBLIC_PAYMENT_SAYS } from '../../../../src/core/movement.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../../src/testing/assets.js';
import { payeeFor, unshieldedPayeeFor } from '../../../../src/testing/payees.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A ONE-OFF PAYMENT IS MADE IN THE WALLET, IN ONE WINDOW, FROM ITS OWN READS.** The steps it takes and the shared
 * code each one calls are pinned here with that code stood in for: the window the wallet sets, the chain read that
 * decides whether it carries on past the proposal, the charge only under a policy, the payment in the form the address
 * decides, the approval of a proposal raised elsewhere, and the words of every stop.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  raise: null as null | ((doors: any, input: any) => Promise<unknown>),
  toPay: null as null | ((...a: any[]) => Promise<unknown>),
  charge: null as null | ((doors: any, run: any) => Promise<unknown>),
  payPrivately: null as null | ((doors: any, input: any) => Promise<unknown>),
  payPublicly: null as null | ((doors: any, input: any) => Promise<unknown>),
  approve: null as null | ((doors: any, input: any) => Promise<unknown>),
  found: null as null | ((...a: any[]) => Promise<unknown>),
  vendorChecked: null as null | ((...a: any[]) => Promise<void>),
  policy: null as null | ((...a: any[]) => Promise<unknown>),
}));
vi.mock('../../../../packages/web-shared/src/one-off-raised-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/one-off-raised-here.js')>()),
  raiseOneOffHere: (doors: any, input: any) => { t.calls.push('raise'); return t.raise!(doors, input); },
  oneOffToPayHere: (...a: any[]) => { t.calls.push('to-pay'); return t.toPay!(...a); },
}));
vi.mock('../../../../packages/web-shared/src/run-charged-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/run-charged-here.js')>()),
  chargeTheRunHere: (doors: any, run: any) => { t.calls.push('charge'); return t.charge!(doors, run); },
}));
vi.mock('../../../../packages/web-shared/src/vault-operation.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-operation.js')>()),
  payPrivatelyFromCompanyVault: (doors: any, input: any) => { t.calls.push('pay-privately'); return t.payPrivately!(doors, input); },
  payPubliclyFromCompanyVault: (doors: any, input: any) => { t.calls.push('pay-publicly'); return t.payPublicly!(doors, input); },
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  approveOnDevice: (doors: any, input: any) => { t.calls.push('approve'); return t.approve!(doors, input); },
}));
vi.mock('../../../../packages/web-shared/src/one-off-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/one-off-here.js')>()),
  oneOffsHere: async () => { t.calls.push('every-one-off'); return { believed: [], unread: [] }; },
  oneOffRaisedByHere: (...a: any[]) => t.found!(...a),
  refuseAOneOffToAnotherVendorHere: (...a: any[]) => { t.calls.push('vendor-checked'); return t.vendorChecked!(...a); },
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.calls.push('upkeep-first'); await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.calls.push('upkeep-last'); await company.reach(c); } },
    }),
  };
});
vi.mock('../../../../packages/web-shared/src/spending-policy-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/spending-policy-here.js')>()),
  spendingPolicyHere: (...a: any[]) => t.policy!(...a),
}));

const { oneOffPaymentAction, oneOffAskedOf, payDoorsFor, oneOffRecordsFor } = await import('./one-off-payment.js');
const { OneOffRefused } = await import('../../../../src/midnight/one-off-kind.js');
const op = await import('../../../../packages/web-shared/src/vault-operation.js');
const { LegNotRaisedHere } = await import('../../../../packages/web-shared/src/run-raised-here.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const VAULT = 'de'.repeat(32);
const CHAIN_ID = 'ab'.repeat(32);
const NET = 'undeployed' as const;
const PRIVATE_TO = payeeFor('0a'.repeat(32), NET).bech32;
const PUBLIC_TO = unshieldedPayeeFor('0b'.repeat(32), NET).bech32;
const NOW_MS = 1_800_000_000_000;
const NOW = BigInt(NOW_MS / 1000);
const SEAT = { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) };
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const intent = (fields: Record<string, string | undefined> = {}): ActIntent => ({
  name: 'one-off-payment',
  fields: Object.fromEntries(Object.entries({
    record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULT, token: TEST_TOKEN, amount: '250', payee: PRIVATE_TO,
    payeeName: 'Acme Printing', reason: 'Business cards', ...fields,
  }).filter(([, v]) => v !== undefined)) as Record<string, string>,
}) as ActIntent;
const PROPOSAL_WITH_ITS_PAYMENT = intent({ proposal: 'prp_abcdefghijkl' });
const BARE_PROPOSAL = intent({ vault: undefined, token: undefined, amount: undefined, payee: undefined, payeeName: undefined, reason: undefined, proposal: 'prp_abcdefghijkl' });

const ctxWith = (i: ActIntent = intent()) => {
  const calls: string[] = [];
  const told: Record<string, unknown> = {};
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 3, steps: 6 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a one-off payment is sent through its calls, never a bare relay'); },
    call: async (method: string, path: string) => { calls.push(`${method} ${path}`); return { status: 200, body: {} }; },
    tell: (o: Record<string, unknown>) => { Object.assign(told, o); }, keyring: null,
  } as unknown as StepContext;
  return { ctx, calls, told };
};

const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const chainSays = { now: [] as Array<Record<string, unknown>> };
const reachOf = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32),
  stepTo: () => {},
  api: async (path: string, init?: RequestInit) => { t.calls.push(`api ${init?.method ?? 'GET'} ${path}`); return []; },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: ['aa'.repeat(32)], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [VAULT], account: ACCOUNT }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { history: new Map() } }),
    filingJudgeFor: () => async () => null, leavesFor: () => async () => [],
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', signers: [] }),
  builder: {
    roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => {
      const next = chainSays.now.length > 1 ? chainSays.now.shift()! : chainSays.now[0]!;
      return Object.fromEntries(chainIds.map((id) => [id, next]));
    },
    spendingPolicyKeys: async () => ({}),
  },
  chain: {
    indexer: { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' },
    callState: async () => ({ blockHash: 'b'.repeat(64), accountState: 'AS', parameters: 'PP' }),
    payments: async (_a: string, _l: string, entries: string[]) => ({ payKeyCommitment: null, held: [], openRounds: [], entries: entries.length }),
    roles: async () => [],
  },
  ...over,
});

const action = (over: Record<string, unknown> = {}) => oneOffPaymentAction({
  chain: () => ({}) as never, builder: () => ({}) as never, now: () => NOW_MS, pause: async () => {}, secrets: () => ({}) as never,
  reachFor: async () => reachOf(over) as never, assets: registryWithTestPrivateForms(), network: NET, waitMs: 3, everyMs: 1,
  kept: () => ({ payments: {} as never, charges: {} as never }),
});
const ORDER = (form: 'shielded' | 'unshielded', paid = false) => ({
  order: { form, vault: VAULT, payments: [{ index: 0, kind: form, leaf: 'f0'.repeat(32), paid }] }, proposalId: 'prp_abcdefghijkl',
});
const OPEN = (approvals: number, needed: number) => ({ held: 'open', approvals, needed, raisedAt: 1 });
const RECORD = (over: Record<string, unknown> = {}) => ({
  proposal: { id: 'prp_abcdefghijkl', chainId: CHAIN_ID }, vault: VAULT, asset: TEST_TOKEN, amount: 250n,
  payee: { ref: null, name: 'Acme Printing', address: PRIVATE_TO, network: NET }, reason: 'Business cards', ...over,
});

/** Runs the action's steps after the upkeep: the seat, then the raise or approval, the charge and the payment. */
const run = async (a: ReturnType<typeof action>, i: ActIntent = intent()) => {
  const steps = a.steps(i);
  const { ctx, told, calls } = ctxWith(i);
  for (const s of [steps[0]!, steps[2]!, steps[3]!, steps[4]!]) await s.run(ctx);
  return { told, calls };
};

beforeEach(() => {
  t.calls = [];
  chainSays.now = [OPEN(1, 1)];
  t.raise = async () => ({ id: 'prp_abcdefghijkl', chainId: CHAIN_ID, status: 'open' });
  t.toPay = async () => ORDER('shielded');
  t.charge = async () => ({ state: 'no-policy' });
  t.payPrivately = async () => ({ txRef: 'r1' });
  t.payPublicly = async () => ({ txRef: 'r2' });
  t.approve = async () => ({});
  t.found = async () => ({ oneOff: RECORD() });
  t.vendorChecked = async () => undefined;
  t.policy = async () => ({ state: 'none' });
});

describe('the window lists what the one-off pays, to whom, and what the wallet does, before the passkey', () => {
  it('names the page\'s words as the page\'s, the form the address decides and every step as the action\'s own', async () => {
    const shown = await action().shown(intent());
    const keys = shown.map((l) => [l.key, l.from]);
    /* RED WHEN: the amount, the payee, the name, the reason or the vault is shown as something the wallet read itself. */
    for (const k of ['amount', 'payee', 'name', 'reason', 'vault']) expect(keys, k).toContainEqual([`act.one-off-payment.shown.${k}`, 'page']);
    /* RED WHEN: a private address is not shown as paid privately, or the wallet's own window and record are not shown. */
    for (const k of ['private', 'window', 'record', 'carry-out', 'nothing-else']) expect(keys, k).toContainEqual([`act.one-off-payment.shown.${k}`, 'action']);
    /* RED WHEN: the upkeep every seat action does is not shown before the passkey. */
    for (const k of ['may', 'rotation', 'roster', 'vaults', 'anchor']) expect(keys, k).toContainEqual([`act.upkeep.shown.${k}`, 'action']);
    /* RED WHEN: a public address is shown without the sentence the product says wherever a person is paid publicly. */
    expect((await action().shown(intent({ payee: PUBLIC_TO }))).map((l) => l.key)).toContain('act.one-off-payment.shown.public');
    expect(WORDS['act.one-off-payment.shown.public']).toContain(PUBLIC_PAYMENT_SAYS);
    /* RED WHEN: the steps are not the seat, the upkeep first, the raise, the charge, the payment and the upkeep last, in that order. */
    expect(action().steps(intent()).map((s) => s.title.key)).toEqual([
      'act.one-off-payment.step.seat', 'act.upkeep.step.first', 'act.one-off-payment.step.raise', 'act.one-off-payment.step.charge',
      'act.one-off-payment.step.pay', 'act.upkeep.step.last',
    ]);
    /* RED WHEN: a proposal raised elsewhere is carried on under the raise's title. */
    expect(action().steps(PROPOSAL_WITH_ITS_PAYMENT)[2]!.title.key).toBe('act.one-off-payment.step.approve');
  });

  it('refuses before anything is read a payment of nothing, an address it cannot pay, no reason, and a proposal named without the payment it should be', async () => {
    const a = action();
    expect(await a.check(intent(), {} as never)).toBeNull();
    expect(await a.check(PROPOSAL_WITH_ITS_PAYMENT, {} as never)).toBeNull();
    /* RED WHEN: a payment of nothing is raised. */
    expect((await a.check(intent({ amount: '0' }), {} as never))?.key).toBe('act.one-off-payment.why.nothing');
    /* RED WHEN: an address this wallet cannot pay on its network is taken. */
    expect((await a.check(intent({ payee: 'not-an-address' }), {} as never))?.key).toBe('act.one-off-payment.why.payee');
    /* RED WHEN: the record's own rules are not the ones that decide, so a payment with no reason is raised. */
    expect((await a.check(intent({ reason: '  ' }), {} as never))?.key).toBe('act.one-off-payment.why.not-a-payment');
    /* RED WHEN: a proposal is approved and paid on one passkey with nothing of the payment named in the window. */
    expect((await a.check(BARE_PROPOSAL, {} as never))?.key).toBe('act.one-off-payment.why.not-a-vault');
    expect((await a.check(intent({ proposal: 'prp_abcdefghijkl', amount: '0' }), {} as never))?.key).toBe('act.one-off-payment.why.nothing');
    /* RED WHEN: the form is taken from anything but the address. */
    expect((oneOffAskedOf(intent({ payee: PUBLIC_TO }), NET, registryWithTestPrivateForms()) as { form: string }).form).toBe('public');
  });
});

describe('at one approval it is raised, charged and paid in the same window', () => {
  it('raises in a window it sets itself, reads the chain, and carries the payment out privately', async () => {
    const { told } = await run(action());
    /* RED WHEN: the one-off is not raised, charged and paid in order at one approval, or paid publicly to a private address. */
    expect(t.calls.filter((c) => !c.startsWith('api'))).toEqual(['raise', 'to-pay', 'charge', 'to-pay', 'pay-privately']);
    /* RED WHEN: the page is told anything but where it got to, the approvals and how many it needs. */
    expect(told).toEqual({ state: 'paid', approvals: 1, needed: 1, charge: 'none' });
  });

  it('opens the window five minutes before now and closes it a week later, or at the end of the policy period holding now', async () => {
    let asked: any = null;
    t.raise = async (_d, input) => { asked = input; return { id: 'prp_abcdefghijkl', chainId: CHAIN_ID }; };
    await run(action());
    /* RED WHEN: the window is the page's, or not from five minutes before now to a week later. */
    expect([asked.opensAt, asked.closesAt]).toEqual([NOW - 300n, NOW + 7n * 86_400n]);
    /* RED WHEN: the one-off is sealed under anything but the company's keys this wallet holds. */
    expect(Object.values(asked)).toContain(KEYS);
    const terms = { periodStart: NOW - 86_400n, periodLength: 3n * 86_400n, periodLimit: 1000n, bands: [1, 2, 3, 4].map(() => ({ ceiling: 1000n, approvals: 1n })) };
    t.policy = async () => ({ state: 'set', policy: { terms, blinding: new Uint8Array(32) } });
    await run(action());
    /* RED WHEN: a window crossing out of the policy's period is raised, which the chain would never charge. */
    expect(asked.closesAt).toBe(NOW + 2n * 86_400n);
    t.policy = async () => ({ state: 'set', policy: { terms: { ...terms, bands: [] }, blinding: new Uint8Array(32) } });
    const steps = action().steps(intent());
    const { ctx } = ctxWith();
    await steps[0]!.run(ctx);
    /* RED WHEN: a policy this device cannot use stops the raise with words saying something may have been sent. */
    expect(((await steps[2]!.run(ctx).catch((x: unknown) => x)) as StepRefused).words.key).toBe('act.one-off-payment.why.not-raised');
  });

  it('builds the raise on the account state this wallet read, never the service\'s', async () => {
    let doors: any = null;
    t.raise = async (d) => { doors = d; return { id: 'prp_abcdefghijkl', chainId: CHAIN_ID }; };
    await run(action());
    const state = await doors.service.callState('acc_1');
    /* RED WHEN: the raise is built on the call state the service hands the page. */
    expect(state).toEqual({ blockHash: 'b'.repeat(64), accountState: 'AS', parameters: 'PP', account: ACCOUNT });
    expect(t.calls).not.toContain('api GET /api/accounts/acc_1/call-state');
  });

  it('pays publicly when the address is public, and only once the account shows the payment', async () => {
    t.toPay = async () => ORDER('unshielded');
    let doors: any = null;
    t.payPublicly = async (d) => { doors = d; return { txRef: 'r2' }; };
    await run(action(), intent({ payee: PUBLIC_TO }));
    /* RED WHEN: a public one-off is paid privately, or never paid. */
    expect(t.calls).toContain('pay-publicly');
    expect(t.calls).not.toContain('pay-privately');
    /* RED WHEN: a public payment is taken as seen without the account's record of payments showing it. */
    expect(await doors.paidYet()).toBe(false);
  });

  it('pays nothing again when the account already records it paid', async () => {
    t.toPay = async () => ORDER('shielded', true);
    const { told } = await run(action());
    /* RED WHEN: a payment the account already records is charged or paid again. */
    expect(t.calls.filter((c) => c === 'charge' || c.startsWith('pay-'))).toEqual([]);
    expect(told['state']).toBe('already-paid');
  });
});

describe('above one approval it stops after the proposal', () => {
  it('tells the approvals and how many it needs, and neither charges nor pays', async () => {
    chainSays.now = [OPEN(1, 2)];
    const { told } = await run(action());
    /* RED WHEN: a proposal short of its approvals is charged or paid, or the page is not told it waits. */
    expect(t.calls.filter((c) => !c.startsWith('api'))).toEqual(['raise']);
    expect(told).toEqual({ state: 'awaiting-approvals', approvals: 1, needed: 2 });
  });

  it('a raise the chain has not shown in time is refused as sent, never as nothing done', async () => {
    chainSays.now = [{ held: 'never', approvals: 0 }];
    const steps = action().steps(intent());
    const { ctx } = ctxWith();
    await steps[0]!.run(ctx);
    const e = await steps[2]!.run(ctx).catch((x: unknown) => x);
    /* RED WHEN: a raise that was sent and not yet seen reads as a refusal before anything was sent. */
    expect((e as StepRefused).words.key).toBe('act.one-off-payment.why.raise-not-seen');
  });

  it('a proposal the chain no longer holds open is refused', async () => {
    chainSays.now = [{ held: 'closed', approvals: 0 } as never];
    const steps = action().steps(intent());
    const { ctx } = ctxWith();
    await steps[0]!.run(ctx);
    /* RED WHEN: a proposal the account no longer holds open is charged or paid. */
    expect(((await steps[2]!.run(ctx).catch((x: unknown) => x)) as StepRefused).words.key).toBe('act.one-off-payment.why.closed');
  });

  it('is carried out as far as the account itself allows: its refusal of the charge for want of approvals stops it, never a guess', async () => {
    t.charge = async () => { throw new Error('the chain refused the charge: not enough approvals yet. Nothing was sent.'); };
    const { told } = await run(action());
    /* RED WHEN: a charge the account refuses for want of approvals is told as a failure, or is followed by a payment. */
    expect(told['state']).toBe('awaiting-approvals');
    expect(t.calls).not.toContain('pay-privately');
    chainSays.now = [{ ...OPEN(1, 1), outrun: true }];
    t.calls = [];
    const steps = action().steps(intent());
    const { ctx } = ctxWith();
    for (const i of [0, 2]) await steps[i]!.run(ctx);
    /* RED WHEN: a proposal whose hold was outrun by a removal is not tried at all, though the account may still carry it out with more approvals. */
    const e = await steps[3]!.run(ctx).catch((x: unknown) => x);
    expect(t.calls).toContain('charge');
    /* RED WHEN: a removal's extra approval is not named when it is what stops the charge. */
    expect((e as StepRefused).words.key).toBe('act.one-off-payment.why.outrun');
  });
});

describe('a proposal raised on another device is approved here, then charged and paid', () => {
  it('approves it when the chain shows it short, then carries it out once the chain shows it at its bar', async () => {
    chainSays.now = [OPEN(1, 2), OPEN(1, 2), OPEN(2, 2)];
    const { told } = await run(action(), PROPOSAL_WITH_ITS_PAYMENT);
    /* RED WHEN: a proposal raised elsewhere is not approved from this seat, or is paid without the chain showing its approvals. */
    expect(t.calls.filter((c) => !c.startsWith('api'))).toEqual(['vendor-checked', 'approve', 'to-pay', 'charge', 'to-pay', 'pay-privately']);
    expect(told).toEqual({ state: 'paid', approvals: 2, needed: 2, charge: 'none' });
  });

  it('always offers this seat\'s approval, taking the account\'s "already approved" as done, and refuses what is no one-off', async () => {
    chainSays.now = [OPEN(2, 2)];
    t.approve = async () => { throw Object.assign(new Error('you have already approved this proposal'), { name: 'CallNotBuilt' }); };
    const { told } = await run(action(), PROPOSAL_WITH_ITS_PAYMENT);
    /* RED WHEN: the approval is skipped on the hold's count alone, though the vault's bar may since have risen. */
    expect(t.calls).toContain('approve');
    /* RED WHEN: a seat that approved already stops the action instead of carrying it out. */
    expect(told['state']).toBe('paid');
    t.found = async () => null;
    const steps = action().steps(PROPOSAL_WITH_ITS_PAYMENT);
    const { ctx } = ctxWith(PROPOSAL_WITH_ITS_PAYMENT);
    await steps[0]!.run(ctx);
    /* RED WHEN: a proposal the company's records do not hold as a one-off is approved or paid as one. */
    expect(((await steps[2]!.run(ctx).catch((x: unknown) => x)) as StepRefused).words.key).toBe('act.one-off-payment.why.not-a-one-off');
  });
});

describe('every stop has its words, and one after a send never reads as nothing handed over', () => {
  it('a raise that may have gone, a payment not yet seen and one refused before it was sent each say so', async () => {
    const stop = async (i: number) => {
      const steps = action().steps(intent());
      const { ctx } = ctxWith();
      for (const s of steps.slice(0, i).filter((_s, n) => n !== 1)) await s.run(ctx);
      return ((await steps[i]!.run(ctx).catch((x: unknown) => x)) as StepRefused).words.key;
    };
    const handedOver = async (doors: any) => { await doors.service.file('acc_1', { proposal: {}, salt: 'ab', tx: 'AAAA' }).catch(() => undefined); };
    t.raise = async (doors) => { await handedOver(doors); throw new Error('the page lost the answer'); };
    /* RED WHEN: a raise the page may have sent is refused with words saying nothing was sent. */
    expect(await stop(2)).toBe('act.one-off-payment.why.raise-may-be-sent');
    t.raise = async (doors) => { await handedOver(doors); throw Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true }); };
    /* RED WHEN: a raise the service refused before sending reads as one that may be out. */
    expect(await stop(2)).toBe('act.one-off-payment.why.not-raised');
    t.raise = async () => { throw new Error('this device could not build it. Nothing was built or sent.'); };
    /* RED WHEN: a raise refused while it was built, before anything was handed over, reads as one that may be out. */
    expect(await stop(2)).toBe('act.one-off-payment.why.not-raised');
    t.raise = async () => ({ id: 'prp_abcdefghijkl', chainId: CHAIN_ID });
    t.payPrivately = async () => { throw new op.PaymentNotYetSeen(VAULT as never, 'r1'); };
    /* RED WHEN: a payment handed over and not yet seen reads as one to make again. */
    expect(await stop(4)).toBe('act.one-off-payment.why.payment-not-seen');
  });

  it('has words for every stop it can make', () => {
    const source = readFileSync(new URL('./one-off-payment.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/why\('([a-z-]+)'/gu), ...source.matchAll(/refusedAfter\(e, handed, '([a-z-]+)', '([a-z-]+)'\)/gu)]
      .flatMap((m) => m.slice(1)).filter(Boolean);
    expect(keys.length).toBeGreaterThan(20);
    /* RED WHEN: a stop of this action has no words in the wallet, so the window shows a bare key. */
    for (const k of new Set(keys)) expect(WORDS[`act.one-off-payment.why.${k}`], k).toBeTypeOf('string');
    /* RED WHEN: a stop of the company read this action reaches has no words of its own. */
    for (const k of ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened']) {
      expect(WORDS[`act.one-off-payment.why.${k}`], k).toBeTypeOf('string');
    }
  });
});

describe('the doors are the wallet\'s own reads and the action\'s listed calls', () => {
  it('pays through the listed payout and charge calls, and reads the payments, the policy and the proposals from the chain and its records', async () => {
    const { ctx } = ctxWith();
    const r = reachOf();
    const asked: string[] = [];
    (r as any).api = async (path: string, init?: RequestInit) => { asked.push(`${init?.method ?? 'GET'} ${path}`); return []; };
    const doors = payDoorsFor(ctx, r as never, { now: () => NOW_MS, pause: async () => {}, secrets: () => ({ isTheWallets: true }) as never, kept: () => ({ payments: {} as never, charges: {} as never }) } as never);
    await doors.service.payout(VAULT as never, 'AAAA').catch(() => undefined);
    await doors.service.payoutPublicly(VAULT as never, 'AAAA').catch(() => undefined);
    await doors.charge!('prp_abcdefghijkl', { tx: 'AAAA', filer: 'ff' }).catch(() => undefined);
    const records = oneOffRecordsFor(r as never, { assets: registryWithTestPrivateForms() }, { account: { paidMovementOf: (b: Uint8Array) => b, paidOnceOf: (b: Uint8Array) => b }, details: {} } as never);
    await records.runs();
    await records.proposals!();
    const shape = intentShapeOf('one-off-payment')!;
    /* RED WHEN: a payment, a charge or a read goes through a call the action's entry does not list, which the page would refuse. */
    for (const c of asked) expect(routeOf(shape, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    expect(asked).toEqual([
      `POST /api/accounts/acc_1/vaults/${VAULT}/payout`, `POST /api/accounts/acc_1/vaults/${VAULT}/public-payout`, 'POST /api/proposals/prp_abcdefghijkl/charge',
      'GET /api/accounts/acc_1/runs', 'GET /api/accounts/acc_1/proposals',
    ]);
    /* RED WHEN: the vault's secret is not the one this wallet keeps, or the chain is read through anything but this wallet's indexer. */
    expect((doors.secretKeptHere as unknown as { isTheWallets?: boolean }).isTheWallets).toBe(true);
    expect(await doors.indexer()).toEqual(r.chain.indexer);
    /* RED WHEN: the account's record of payments is read from anything but this wallet's chain read. */
    expect((await records.payments.read(['e1'])).entries).toBe(1);
  });
});

describe('a payment to a vendor entry is asked by the entry, and approved only for the entry\'s own address', () => {
  const VENDOR = 'ven_0123456789abcdef0123';
  const TO_THE_VENDOR = intent({ proposal: 'prp_abcdefghijkl', vendor: VENDOR });
  const VENDORS_RECORD = RECORD({ payee: { ref: VENDOR, name: 'Acme Printing', address: PRIVATE_TO, network: NET } });

  it('takes the vendor entry beside the address, shown as the page\'s words, and refuses one that is not a vendor entry\'s id', async () => {
    /* RED WHEN: the vendor entry the page names is dropped, so the payment is raised to the address alone. */
    expect((oneOffAskedOf(intent({ vendor: VENDOR }), NET, registryWithTestPrivateForms()) as { payee: { ref: string } }).payee.ref).toBe(VENDOR);
    expect((oneOffAskedOf(intent(), NET, registryWithTestPrivateForms()) as { payee: { ref: null } }).payee.ref).toBeNull();
    /* RED WHEN: a vendor entry is named by anything but its id. */
    expect((await action().check(intent({ vendor: 'ven_nothex' }), {} as never))?.key).toBe('act.one-off-payment.why.not-a-payment');
    const keys = (await action().shown(TO_THE_VENDOR)).map((l) => [l.key, l.from]);
    /* RED WHEN: the window does not show the vendor entry, or shows the page's words as the wallet's own reading. */
    expect(keys).toContainEqual(['act.one-off-payment.shown.vendor', 'page']);
    expect((await action().shown(PROPOSAL_WITH_ITS_PAYMENT)).map((l) => l.key)).not.toContain('act.one-off-payment.shown.vendor');
  });

  it('reads the one-off by the name its proposal gives, checks it against the vendor entry, and approves nothing it refuses', async () => {
    t.found = async () => ({ oneOff: VENDORS_RECORD });
    await run(action(), TO_THE_VENDOR);
    /* RED WHEN: approving one one-off opens every one-off the company ever made. */
    expect(t.calls).not.toContain('every-one-off');
    /* RED WHEN: a one-off to a vendor entry is approved without checking it pays that entry. */
    expect(t.calls.indexOf('vendor-checked')).toBeGreaterThan(-1);
    expect(t.calls.indexOf('vendor-checked')).toBeLessThan(t.calls.indexOf('approve'));
    t.calls = [];
    t.vendorChecked = async () => { throw new OneOffRefused('This one-off payment is not made: it pays another address than the vendor entry it names.'); };
    const steps = action().steps(TO_THE_VENDOR);
    const { ctx } = ctxWith(TO_THE_VENDOR);
    await steps[0]!.run(ctx);
    /* RED WHEN: a one-off whose address is not the vendor entry's is approved. */
    const refused = (await steps[2]!.run(ctx).catch((x: unknown) => x)) as StepRefused;
    expect(refused.words.key).toBe('act.one-off-payment.why.not-as-shown');
    expect(t.calls).not.toContain('approve');
    /* RED WHEN: a record naming another vendor entry, or none, than the window showed is approved. */
    for (const ref of [null, 'ven_ffffffffffffffffffff']) {
      t.found = async () => ({ oneOff: RECORD({ payee: { ref, name: 'Acme Printing', address: PRIVATE_TO, network: NET } }) });
      const again = action().steps(TO_THE_VENDOR);
      const c = ctxWith(TO_THE_VENDOR).ctx;
      await again[0]!.run(c);
      expect(((await again[2]!.run(c).catch((x: unknown) => x)) as StepRefused).words.key).toBe('act.one-off-payment.why.not-as-shown');
    }
  });

  it('tells a proposal that can never match as not as shown, and one the records do not hold yet as not found', async () => {
    const refusedWith = async (read: 'found' | 'vendor', message: string) => {
      t.found = async () => (read === 'found' ? Promise.reject(new OneOffRefused(message)) : { oneOff: VENDORS_RECORD });
      t.vendorChecked = async () => { if (read === 'vendor') throw new OneOffRefused(message); };
      t.calls = [];
      const steps = action().steps(TO_THE_VENDOR);
      const { ctx } = ctxWith(TO_THE_VENDOR);
      await steps[0]!.run(ctx);
      const refused = (await steps[2]!.run(ctx).catch((x: unknown) => x)) as StepRefused;
      expect(t.calls).not.toContain('approve');
      return refused.words.key;
    };
    /* RED WHEN: a proposal whose record is paid from another vault, in another currency, or filed by another seat is told as a wait. */
    for (const m of ['The one-off payment this proposal names is paid from another vault.', 'The one-off payment this proposal names is paid in another currency.',
      'The one-off payment this proposal names was filed by another seat than the one that raised it.']) {
      expect(await refusedWith('found', m), m).toBe('act.one-off-payment.why.not-as-shown');
    }
    /* RED WHEN: a vendor entry that holds other keys than the payment pays is told as a wait. */
    expect(await refusedWith('vendor', 'This one-off payment is not made: it pays other keys than the vendor entry it names.')).toBe('act.one-off-payment.why.not-as-shown');
    /* RED WHEN: a record the company has not filed yet is told as a mismatch, so a signer is told not to approve what only needs time. */
    expect(await refusedWith('found', 'The company\'s records hold no one-off payment by the name this proposal gives.')).toBe('act.one-off-payment.why.not-found');
  });

  it('reads the company\'s vendors through its own records, with the calls the action lists', async () => {
    const records = oneOffRecordsFor(reachOf() as never, { assets: registryWithTestPrivateForms(), network: NET }, {} as never);
    /* RED WHEN: the wallet has no way to read the vendor entry a payment names. */
    expect(typeof records.vendors).toBe('function');
  });
});

describe('approving names the payment, and the wallet approves nothing but what it named', () => {
  it('shows the page\'s payment as the page\'s beside the proposal, and refuses a record that is not that payment', async () => {
    const keys = (await action().shown(PROPOSAL_WITH_ITS_PAYMENT)).map((l) => [l.key, l.from]);
    /* RED WHEN: the approval's window names a proposal and not the amount, payee, name, reason and vault it pays. */
    for (const k of ['proposal', 'amount', 'payee', 'name', 'reason', 'vault']) expect(keys, k).toContainEqual([`act.one-off-payment.shown.${k}`, 'page']);
    /* RED WHEN: the window does not say the record is opened after the passkey and must match what it shows. */
    expect(keys).toContainEqual(['act.one-off-payment.shown.matched', 'action']);
    for (const [field, other] of [['amount', 251n], ['reason', 'Something else'], ['vault', 'ef'.repeat(32)], ['asset', 'aa'.repeat(32)]] as const) {
      t.calls = [];
      t.found = async () => ({ oneOff: RECORD({ [field]: other }) });
      const steps = action().steps(PROPOSAL_WITH_ITS_PAYMENT);
      const { ctx } = ctxWith(PROPOSAL_WITH_ITS_PAYMENT);
      await steps[0]!.run(ctx);
      /* RED WHEN: a record whose payment differs from the one the window showed is approved or paid. */
      expect(((await steps[2]!.run(ctx).catch((x: unknown) => x)) as StepRefused).words.key, field).toBe('act.one-off-payment.why.not-as-shown');
      expect(t.calls, field).not.toContain('approve');
    }
    for (const payee of [{ ref: null, name: 'Someone else', address: PRIVATE_TO, network: NET }, { ref: null, name: 'Acme Printing', address: PUBLIC_TO, network: NET }]) {
      t.found = async () => ({ oneOff: RECORD({ payee }) });
      const steps = action().steps(PROPOSAL_WITH_ITS_PAYMENT);
      const { ctx } = ctxWith(PROPOSAL_WITH_ITS_PAYMENT);
      await steps[0]!.run(ctx);
      /* RED WHEN: a record paying another address, or under another name, than the window showed is approved. */
      expect(((await steps[2]!.run(ctx).catch((x: unknown) => x)) as StepRefused).words.key, payee.name).toBe('act.one-off-payment.why.not-as-shown');
    }
  });

  it('waits for the chain to show its own approval before it says others must approve', async () => {
    chainSays.now = [OPEN(1, 2), OPEN(1, 2), OPEN(1, 2), OPEN(2, 2)];
    const { told } = await run(action(), PROPOSAL_WITH_ITS_PAYMENT);
    /* RED WHEN: an approval the indexer has not shown yet leaves a payment at its bar told as awaiting the others. */
    expect(told).toEqual({ state: 'paid', approvals: 2, needed: 2, charge: 'none' });
  });
});

describe('the window says only what the settlement gives', () => {
  it('never says the service is sent nothing, and shows a public payment\'s facts as public', async () => {
    const keys = (await action().shown(intent({ payee: PUBLIC_TO }))).map((l) => l.key);
    /* RED WHEN: a public payment's window says it is private, or leaves out the record and what it sends. */
    expect(keys).toEqual(expect.arrayContaining(['act.one-off-payment.shown.public', 'act.one-off-payment.shown.record']));
    expect(keys).not.toContain('act.one-off-payment.shown.private');
    /* RED WHEN: the window promises the service never sees the amount, payee or name, which a public payment's transaction carries. */
    expect(WORDS['act.one-off-payment.shown.record']).not.toMatch(/never sent/u);
    expect(WORDS['act.one-off-payment.shown.record']).toMatch(/carry no amount, payee or name/u);
    /* RED WHEN: a private payment is said to hide its amount entirely, though a policy band's approvals can show its range. */
    expect(WORDS['act.one-off-payment.shown.private']).toMatch(/band/u);
    /* RED WHEN: the window says a payment is made once others approve, though a signer must carry it out. */
    expect(WORDS['act.one-off-payment.shown.carry-out']).toMatch(/running this action again/u);
    /* RED WHEN: an outrun proposal is said never to be carried out, though more approvals carry out a payment. */
    expect(WORDS['act.one-off-payment.why.outrun']).not.toMatch(/never/u);
  });

  it('shows the amount in the currency\'s own units and name, beside the smallest-unit figure', async () => {
    const line = (await action().shown(intent())).find((l) => l.key === 'act.one-off-payment.shown.amount')!;
    /* RED WHEN: the amount is shown only as a raw integer and a hexadecimal id, or the raw figure is lost. */
    expect(line.values).toEqual({ shown: '2.50', symbol: 'tPAY', name: 'Test Pay', amount: '250', token: TEST_TOKEN });
    expect(WORDS['act.one-off-payment.shown.amount']).toMatch(/\{shown\} \{symbol\}/u);
    /* RED WHEN: a currency the wallet does not know is shown as if it did. */
    expect((await action().shown(intent({ token: 'ab'.repeat(32) }))).map((l) => l.key)).toContain('act.one-off-payment.shown.amount-raw');
  });

  it('opens the window inside the policy period holding now, at its start when now is its first minutes, and closes it at that period\'s end', async () => {
    let asked: any = null;
    t.raise = async (_d, input) => { asked = input; return { id: 'prp_abcdefghijkl', chainId: CHAIN_ID }; };
    const policy = (periodStart: bigint) => async () => ({ state: 'set', policy: {
      terms: { periodStart, periodLength: 86_400n, periodLimit: 1000n, bands: [1, 2, 3, 4].map(() => ({ ceiling: 1000n, approvals: 1n })) }, blinding: new Uint8Array(32),
    } });
    t.policy = policy(NOW - 60n);
    await run(action());
    /* RED WHEN: in a period's first minutes the window opens in the period before, so it cannot be charged. */
    expect([asked.opensAt, asked.closesAt]).toEqual([NOW - 60n, NOW - 60n + 86_400n]);
    t.policy = policy(NOW + 60n - 86_400n);
    await run(action());
    /* RED WHEN: a minute before a period ends the window runs past it, or opens later than five minutes ago. */
    expect([asked.opensAt, asked.closesAt]).toEqual([NOW - 300n, NOW + 60n]);
    /* RED WHEN: the window's shortness near a period's end goes unsaid. */
    expect(WORDS['act.one-off-payment.shown.window']).toMatch(/shorter/u);
  });
});

describe('every step of the action runs in its order, and the company is read again after an upkeep that changed it', () => {
  it('runs the upkeep first, reads the company again for the raise, and runs the upkeep last', async () => {
    let reads = 0;
    const a = oneOffPaymentAction({
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => NOW_MS, pause: async () => {}, secrets: () => ({}) as never,
      reachFor: async () => { reads += 1; return reachOf() as never; }, assets: registryWithTestPrivateForms(), network: NET, waitMs: 3, everyMs: 1,
      kept: () => ({ payments: {} as never, charges: {} as never }),
    });
    const { ctx } = ctxWith();
    for (const s of a.steps(intent())) await s.run(ctx);
    /* RED WHEN: the upkeep is not run first and last around the raise, charge and payment. */
    expect(t.calls.filter((c) => !c.startsWith('api'))).toEqual(['upkeep-first', 'raise', 'to-pay', 'charge', 'to-pay', 'pay-privately', 'upkeep-last']);
    /* RED WHEN: a raise is sealed on the company as read before an upkeep that changed its key. */
    expect(reads).toBe(2);
  });
});

describe('a step that is not reached says so, and no stop after a send reads as nothing handed over', () => {
  it('marks the charge and the payment not needed when the payment awaits approvals, and the charge when the vault has no policy', async () => {
    const steps = action().steps(intent());
    /* RED WHEN: a payment still awaiting approvals is listed as charged and paid. */
    expect(steps[3]!.notNeeded?.({ state: 'awaiting-approvals' })).toBe(true);
    expect(steps[4]!.notNeeded?.({ state: 'awaiting-approvals' })).toBe(true);
    /* RED WHEN: a charge that was not needed, the vault having no policy, is listed as done. */
    expect(steps[3]!.notNeeded?.({ state: 'paid', charge: 'none' })).toBe(true);
    /* RED WHEN: a charge and a payment that were made are listed as not needed. */
    expect(steps[3]!.notNeeded?.({ state: 'paid', charge: 'charged' })).toBe(false);
    expect(steps[4]!.notNeeded?.({ state: 'paid', charge: 'charged' })).toBe(false);
    /* RED WHEN: the charge step does not say whether there was a charge. */
    expect((await run(action())).told['charge']).toBe('none');
    t.charge = async () => ({ state: 'charged', spentBefore: 0n });
    expect((await run(action())).told['charge']).toBe('charged');
  });

  it('a charge that may have gone, an approval that may have gone, and a payment the account refuses for want of approvals each say what happened', async () => {
    const stopAt = async (i: number, over: ActIntent = intent()) => {
      const steps = action().steps(over);
      const { ctx, told } = ctxWith(over);
      for (const s of [0, 2, 3, 4].filter((n) => n < i)) await steps[s]!.run(ctx);
      const e = await steps[i]!.run(ctx).catch((x: unknown) => x);
      return { key: (e as StepRefused | undefined)?.words?.key, told };
    };
    t.charge = async (doors) => { await doors.charge('prp_abcdefghijkl', { tx: 'AAAA', filer: 'ff' }).catch(() => undefined); throw new Error('the chain refused it: not enough approvals yet'); };
    /* RED WHEN: a charge handed to the page is told as awaiting approvals, as if nothing was sent. */
    expect((await stopAt(3)).key).toBe('act.one-off-payment.why.charge-may-be-sent');
    t.charge = async () => ({ state: 'no-policy' });
    t.approve = async (doors) => { await doors.service.approve('prp_abcdefghijkl', { tx: 'AAAA', filer: 'ff' }).catch(() => undefined); throw new Error('the page lost the answer'); };
    /* RED WHEN: an approval handed to the page is told as not made. */
    expect((await stopAt(2, PROPOSAL_WITH_ITS_PAYMENT)).key).toBe('act.one-off-payment.why.approval-may-be-sent');
    t.approve = async () => ({});
    t.payPrivately = async () => { throw new Error('the chain refused it: not enough approvals yet'); };
    const short = await stopAt(4);
    /* RED WHEN: a payment the account refuses for want of approvals, with nothing handed over, is told as failed. */
    expect(short.key).toBeUndefined();
    expect(short.told['state']).toBe('awaiting-approvals');
    t.payPrivately = async () => { throw new op.PaymentNotAsBuilt(VAULT as never, 'r1', 'other'); };
    /* RED WHEN: a payment the network shows other than as built is told as a plain failure. */
    expect((await stopAt(4)).key).toBe('act.one-off-payment.why.payment-not-as-built');
  });

  it('a one-off the records do not hold, and a proposal closed after its charge was sent, are told in the one-off\'s own words', async () => {
    const steps = action().steps(intent());
    const { ctx } = ctxWith();
    for (const s of [0, 2]) await steps[s]!.run(ctx);
    t.toPay = async () => { throw new LegNotRaisedHere('no such one-off'); };
    /* RED WHEN: a one-off this wallet cannot find after its proposal was sent is told with payroll's "nothing was written down or sent". */
    expect(((await steps[3]!.run(ctx).catch((x: unknown) => x)) as StepRefused).words.key).toBe('act.one-off-payment.why.not-found');
    t.toPay = async () => ORDER('shielded');
    chainSays.now = [OPEN(1, 1), { held: 'closed', approvals: 0 }];
    t.charge = async (doors) => {
      await doors.charge('prp_abcdefghijkl', { tx: 'AAAA', filer: 'ff' }).catch(() => undefined);
      throw new Error('the charge was sent, and the chain your wallet reads no longer holds this run\'s proposal open');
    };
    const again = action().steps(intent());
    const fresh = ctxWith();
    for (const s of [0, 2]) await again[s]!.run(fresh.ctx);
    /* RED WHEN: a charge sent onto a proposal the network then shows closed is told as "did not confirm it went". */
    expect(((await again[3]!.run(fresh.ctx).catch((x: unknown) => x)) as StepRefused).words.key).toBe('act.one-off-payment.why.closed');
  });

  it('tells the claim and seat stops what to do next, and the window as the code sets it', () => {
    /* RED WHEN: the window is worded as opening now, though the code opens it five minutes before now. */
    expect(WORDS['act.one-off-payment.shown.window']).toMatch(/five minutes before now/u);
    /* RED WHEN: the sentence read before the passkey does not say what each of the two signatures covers. */
    expect(WORDS['act.claim-by-address.shown.proof']).toMatch(/signs one claim with the key of the address you were added with.*also signs a code/u);
    /* RED WHEN: a stop of the claim or the seat action ends at what did not happen, with nothing for the reader to do. */
    for (const [k, way] of [['act.claim-by-address.why.not-a-company', /Open the invitation link again/u], ['act.claim-by-address.why.not-a-payee', /Ask the person who added you/u],
      ['act.claim-by-address.why.no-payslip-key', /Reload the page/u], ['act.claim-by-address.why.another-company', /Open the link you were sent/u],
      ['act.seat-invited.why.not-a-company', /Open the invitation link again/u], ['act.seat-invited.why.another-company', /Open the link you were sent/u],
      ['act.seat-invited.why.no-free-seat', /Ask the signer who invited you/u], ['act.seat-invited.why.taken-by-another', /Ask the signer who invited you/u],
      ['act.one-off-payment.why.payee', /Check the address/u], ['act.one-off-payment.why.not-a-payment', /enter the payment again/u]] as const) {
      expect(WORDS[k], k).toMatch(way);
    }
  });

  it('says only true things, each with what to do next', () => {
    const w = (k: string) => WORDS[`act.one-off-payment.${k}`]!;
    /* RED WHEN: a closed proposal that may have been paid is told as never paid, with no way forward. */
    expect(w('why.closed')).toMatch(/may already have been paid/u);
    expect(w('why.closed')).toMatch(/check the vault's payments/u);
    /* RED WHEN: a stop after the proposal was sent says nothing was written down or sent. */
    expect(w('why.not-found')).not.toMatch(/Nothing was written down/u);
    /* RED WHEN: a stop shows a bare placeholder, or speaks of "this page" inside the wallet. */
    for (const k of ['why.not-a-one-off', 'why.charge-not-seen']) expect(w(k), k).not.toMatch(/\{says\}|this page/u);
    /* RED WHEN: a refusal names no way to resolve it. */
    for (const [k, way] of [['why.not-a-company', /Reload the page/u], ['why.seat-not-held', /Ask a signer/u], ['why.not-on-chain', /Finish creating/u],
      ['why.not-a-vault', /enter the payment again/u], ['why.not-a-currency', /enter the payment again/u], ['why.nothing', /enter the payment again/u],
      ['why.not-as-shown', /Do not approve it/u], ['why.not-a-one-off', /Do not approve it/u]] as const) {
      expect(w(k), k).toMatch(way);
    }
    /* RED WHEN: the window leaves out the record and its entry the page is handed to file. */
    expect(w('shown.nothing-else')).toMatch(/sealed record and its entry/u);
    /* RED WHEN: after two removals the wallet says one more approval is enough. */
    expect(w('why.outrun')).toMatch(/Each change needs one more approval/u);
    expect(w('why.outrun')).toMatch(/enough other signers/u);
    /* RED WHEN: the window says it pays a payment, or claims the amount is hidden from whoever has seen the vault's earlier payments. */
    expect(w('headline')).toMatch(/^Make a one-off payment/u);
    expect(w('shown.private')).toMatch(/earlier payments/u);
    /* RED WHEN: the window ends a payment still awaiting approvals as done, or says pressing again carries this one on in raise mode. */
    expect(w('over.awaiting')).toMatch(/Not paid yet/u);
    expect(w('over.continue')).toMatch(/second payment/u);
    expect(WORDS['act.step.not-needed']).toBeTypeOf('string');
  });
});

