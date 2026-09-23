/**
 * **A RETRY NAMES ONLY PEOPLE NOBODY HAS PAID AND NOTHING ELSE CAN STILL PAY,
 * AND ONCE APPROVED IT IS PAID PRIVATELY THROUGH THE SAME DOOR AS THE LEG.**
 *
 * What runs is this server's own routes over real HTTP, with a signed-in
 * person. **Three pieces are doubles, and they are named here**: the ledger
 * under the server is the simulated one, with a door for a device's
 * transaction that does what the transaction would have done; its answer to
 * *who has been paid* is a set this file controls, because the simulated
 * ledger records no payments; and this machine's clock is the test's, so a
 * leg's window can close without the test waiting for it.
 *
 * Each company's leg is raised and held by the chain before the server starts,
 * with a window that has closed by the time any retry is asked for - the state
 * a run is in when its vault stopped paying part way.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-retry-once-')), 'db.json');

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService, approvalMessage } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { SEED_ASSETS, assets: productAssets } = await import('../core/assets.js');
const { runMaterialFor, retryMaterialFor } = await import('../midnight/run-material.js');
const { buildRun, buildRetryRun } = await import('../midnight/payout-tree.js');
const { pathToWire } = await import('../midnight/private-payment-wire.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { toHex, sign } = await import('../core/crypto.js');
const { DEVICE_RAISE_VERSION, paymentsCheckedDigest } = await import('../core/device-raise.js');
const { unpaidToRetry } = await import('../web/governed-call-on-device.js');
type Hex = import('../core/crypto.js').Hex;

const NETWORK = theNetwork();
const SLOT = 83;
const USER = 'usr_retry_once_ada';
const VAULT = toHex(new Uint8Array(32).fill(0xc4));
const PRIVATE = SEED_ASSETS.find((a) => a.ledger.shielded !== null)!;
const HELD = 1n << 100n;

/* ── the chain, its door for a device's transaction, and its answer to who was paid ── */

const ledger = new SimulatedLedger(MidnightCommitments);
const signerLeaves = new Map<string, Hex>();
const sent: string[] = [];
/** The leaves the account records as paid. The simulated ledger records none, so this file says. */
const paidLeaves = new Set<string>();
/** When set, the next question about who was paid waits until the test lets it go. */
let heldQuestion: { asked: boolean; opened: Promise<void> } | null = null;
Object.assign(ledger, {
  paidAmong: async (_account: string, leaves: Hex[]) => {
    const hold = heldQuestion;
    if (hold) { heldQuestion = null; hold.asked = true; await hold.opened; }
    return { known: true, paid: leaves.filter((l) => paidLeaves.has(l)) };
  },
  submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
    const built = JSON.parse(Buffer.from(bytes).toString('utf8'));
    sent.push(circuit);
    const o = built.order;
    const r = await ledger.proposeRun(accountId, {
      root: o.run.root, payees: BigInt(o.run.payees), opensAt: BigInt(o.run.opensAt),
      closesAt: BigInt(o.run.closesAt), vault: o.run.vault,
    }, {
      asset: PRIVATE.code, amount: BigInt(o.half.changeAmount), batchDigest: o.half.changeBatchDigest,
      salt: o.half.proposalSalt,
    }, { signerId: built.signer, leaf: signerLeaves.get(`${accountId} ${built.signer}`)! });
    return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
  },
});

/* ── the clock, and the companies ─────────────────────────────────────────── */

vi.useFakeTimers({ toFake: ['Date'] });
const now = Math.floor(Date.now() / 1000);
const LEG_WINDOW = { opensAt: String(now - 60), closesAt: String(now + 30) };
/* A retry's window, open from when the leg's closes. */
const WINDOW = { opensAt: String(now + 30), closesAt: String(now + 3_600) };
const atTheLegsRaise = () => vi.setSystemTime(now * 1000);
const afterTheLegsWindow = () => vi.setSystemTime((now + 60) * 1000);

const store = new FileStore(process.env.DATA_PATH!);
store.putUser({
  id: USER, email: 'ada@retry-once.example', name: 'ada', keyBundle: null, keyBundleVersion: 0,
  walletKey: walletKeyOf(addressOfSlot(SLOT, NETWORK)), createdAt: '2026-09-23T00:00:00.000Z',
} as never);
const accounts = new AccountService(store, ledger, MidnightCommitments, productAssets, aVaultHolding(HELD));
const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), productAssets);

/** A company with three people on one private leg, raised and held by the chain. */
const aCompany = async (name: string, legWindowOpen = false) => {
  const created = await accounts.create(name, [{ name: 'Ada', role: 'admin', userId: USER }], 1);
  const { viewingKey } = created;
  const account = created.account.id;
  for (const s of accounts.open(account, viewingKey).signers) signerLeaves.set(`${account} ${s.id}`, s.leafCommitment as Hex);
  for (let i = 0; i < 3; i++) {
    payroll.hireDirect(account, {
      name: `${name} payee ${i}`, email: `p${i}@${name.toLowerCase()}.example`, title: 'Eng', asset: PRIVATE.code,
      baseAmount: BigInt(100 + i) * 1_000_000n,
    }, viewingKey);
  }
  const { run } = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
  const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
  const window = legWindowOpen ? WINDOW : LEG_WINDOW;
  const material = await runMaterialFor({
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
    opensAt: BigInt(window.opensAt), closesAt: BigInt(window.closesAt), vault: VAULT, detailsOf: vaultDetails,
  });
  const seat = created.secrets[0]!;
  atTheLegsRaise();
  const leg = await payroll.proposeRun(run.id, viewingKey, seat.signerId, material);
  if (!leg.raisedAt) throw new Error(`the ${name} leg did not reach the chain`);
  afterTheLegsWindow();
  const legLeaves = payroll.requireRun(run.id, viewingKey).payout![PRIVATE.code]!.leaves as Hex[];
  return { account, viewingKey, runId: run.id, seat, leg, legLeaves };
};
type Company = Awaited<ReturnType<typeof aCompany>>;

/** A retry raised by this service's own reader, which can read private money, as the legs were. */
const aRetry = async (c: Company, indices: number[], how?: { onDevice: true }) => {
  const m = await retryMaterialFor({
    rebuild: (await payroll.payoutRebuildOf(c.runId, c.viewingKey))!, indices,
    opensAt: BigInt(WINDOW.opensAt), closesAt: BigInt(WINDOW.closesAt), vault: VAULT, detailsOf: vaultDetails,
  });
  return payroll.proposeRetry(c.runId, c.viewingKey, c.seat.signerId, m, undefined, how);
};

const seeded = {
  paysARetry: await aCompany('Paysaretry'),
  alreadyPaid: await aCompany('Alreadypaid'),
  overUnsent: await aCompany('Overunsent'),
  overSent: await aCompany('Oversent'),
  overUnsentSame: await aCompany('Overunsentsame'),
  atOnce: await aCompany('Atonce'),
  stillPaying: await aCompany('Stillpaying', true),
  view: await aCompany('View'),
  threw: await aCompany('Threw'),
};
/* The retry the payout case pays: #2 and #3, raised, approved. */
const approvedRetry = await aRetry(seeded.paysARetry, [1, 2]);
await accounts.approve(approvedRetry.id, seeded.paysARetry.seat.signerId,
  sign(approvalMessage(accounts.requireProposal(approvedRetry.id, seeded.paysARetry.viewingKey)), seeded.paysARetry.seat.signingSecret),
  seeded.paysARetry.viewingKey);
/* Written down on a device and never sent: #2 and #3. */
const unsentRetry = await aRetry(seeded.overUnsent, [1, 2], { onDevice: true });
/* Another written down and never sent, over #2 and #3, retried later as exactly those people. */
const unsentSameRetry = await aRetry(seeded.overUnsentSame, [1, 2], { onDevice: true });
/* Sent, and its window open: #2. */
const sentRetry = await aRetry(seeded.overSent, [1]);
/* A retry over #2 and #3 whose raise threw after its round was written down: the run was never told which round it is. */
const threwRetry = await (async () => {
  const propose = ledger.proposeRun.bind(ledger);
  Object.assign(ledger, { proposeRun: async () => { throw new Error('the node refused before it landed'); } });
  try {
    await aRetry(seeded.threw, [1, 2]);
    throw new Error('the retry was meant to throw');
  } catch (e: any) {
    if (!/refused before it landed/u.test(String(e?.message))) throw e;
  } finally {
    Object.assign(ledger, { proposeRun: propose });
  }
  return accounts.payrollRoundsOf(seeded.threw.account, seeded.threw.viewingKey).find((r) => r.retry !== undefined)!;
})();
/* The payment view's case: a sent retry over #2, so #2 is owed but not stranded. */
await aRetry(seeded.view, [1]);
/*
 * Another run for the same month over the same people, raised after this run's leg was withdrawn: the
 * withdrawal is exactly what lets it be raised, and it gives each of them a different leaf.
 */
const overAnotherRun = await (async () => {
  const c = await aCompany('Overanother');
  await accounts.cancel(c.leg.id, c.viewingKey);
  /* Drawn over the roster's own people - the same people - at different amounts, so it is not a repeat of this run. */
  const roster = payroll.listPeople(c.account, c.viewingKey);
  const { run } = await payroll.createRun(c.account, '2026-08',
    roster.map((e) => ({ name: e.name, asset: e.asset, amount: e.baseAmount + 1n })), c.viewingKey, roster);
  const inputs = await payroll.runMaterialInputs(run.id, c.viewingKey);
  const other = await payroll.proposeRun(run.id, c.viewingKey, c.seat.signerId, await runMaterialFor({
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
    opensAt: BigInt(WINDOW.opensAt), closesAt: BigInt(WINDOW.closesAt), vault: VAULT, detailsOf: vaultDetails,
  }));
  if (!other.raisedAt) throw new Error('the second run did not reach the chain');
  return { ...c, otherRun: run.id };
})();

handInWiring({
  name: 'simulated',
  commitments: MidnightCommitments,
  createLedger: () => ledger,
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');

let server: Server;
let base: string;
let token = '';
type Res = { status: number; body: any };
const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (path: string, body: unknown) => call('POST', path, { token, body });

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
  const signedIn = await signInWithAWallet(call, { slot: SLOT, origin: ORIGIN, network: NETWORK });
  expect(signedIn.userId).toBe(USER);
  token = signedIn.token;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); vi.useRealTimers(); });
beforeEach(() => { sent.length = 0; paidLeaves.clear(); });

/** What a device would send to ask for a retry of these people, having checked the vault for exactly their payments. */
const deviceRetry = async (c: Company, indices: number[], window: { opensAt: string; closesAt: string } = WINDOW) => {
  const asked = await post(`/api/runs/${c.runId}/retry-payments`, { viewingKey: c.viewingKey, indices });
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  const checked = paymentsCheckedDigest(asked.body.payments.map((p: any) => [p.kind, p.token, p.amount] as const));
  return post(`/api/runs/${c.runId}/retry`, {
    viewingKey: c.viewingKey, indices, vault: VAULT, ...window, onDevice: true, version: DEVICE_RAISE_VERSION, checked,
  });
};
/** The retries written down on the run, as the store now holds it, and every retry round written for it. */
const retriesOf = (c: Company) => {
  const fresh = new PayrollService(new FileStore(process.env.DATA_PATH!), accounts, new SimulatedProofSystem(), productAssets);
  return fresh.requireRun(c.runId, c.viewingKey).payout![PRIVATE.code]!.retries ?? [];
};
const retryRoundsOf = (c: Company) =>
  new AccountService(new FileStore(process.env.DATA_PATH!), ledger, MidnightCommitments, productAssets)
    .payrollRoundsOf(c.account, c.viewingKey).filter((r) => r.retry !== undefined);

describe('1. AN APPROVED PRIVATE RETRY IS PAID, AND ONLY ITS PEOPLE ARE PAID', () => {
  it('the private payment door answers the retry named, with its own round, and only the people it names', async () => {
    const c = seeded.paysARetry;
    const retryRecord = accounts.requireProposal(approvedRetry.id, c.viewingKey);
    expect(retryRecord.status).toBe('approved');
    const r = await post(`/api/runs/${c.runId}/private-payments`, { viewingKey: c.viewingKey, proposalId: approvedRetry.id });
    /* RED WHEN: the door reads only the leg's own round - an approved retry then has nothing a vault can pay. */
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    /* RED WHEN: the order is the leg's - its round, its root, its count or its window - so a vault pays against the wrong approval. */
    expect(r.body.proposal).toBe(retryRecord.chainId);
    expect(r.body.proposal).not.toBe(c.leg.chainId);
    const written = retriesOf(c).find((x) => x.proposalId === approvedRetry.id)!;
    expect(r.body.root).toBe(written.root);
    expect(r.body.payees).toBe('2');
    expect([r.body.opensAt, r.body.closesAt]).toEqual([WINDOW.opensAt, WINDOW.closesAt]);
    expect(r.body.salt).toBe(accounts.runSaltOf(approvedRetry.id, c.viewingKey));
    /* RED WHEN: anybody the retry does not name is offered to pay - #1 was paid by the leg, or is some other round's. */
    expect(r.body.payments.map((p: any) => p.index)).toEqual([1, 2]);
    /* RED WHEN: a person is paid at a leaf other than the one the leg already holds for them - a second payment nothing would refuse. */
    expect(r.body.payments.map((p: any) => p.leaf)).toEqual([c.legLeaves[1], c.legLeaves[2]]);
    /* RED WHEN: a payment's path is the leg's tree's, not the retry's - the vault then finds it is not in the approved round. */
    const rebuild = (await payroll.payoutRebuildOf(c.runId, c.viewingKey))!;
    const retryTree = buildRetryRun(buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails), [1, 2]);
    expect(r.body.payments.map((p: any) => p.path)).toEqual([0, 1].map((i) => pathToWire(retryTree.payeeArgs(i).path)));
    expect(retryTree.tree.root).toBe(written.root);

    /* The leg's own door is unchanged: all three, against the leg's round. */
    const leg = await post(`/api/runs/${c.runId}/private-payments`, { viewingKey: c.viewingKey });
    expect(leg.status, JSON.stringify(leg.body)).toBe(200);
    expect(leg.body.proposal).toBe(c.leg.chainId);
    expect(leg.body.payments.map((p: any) => p.index)).toEqual([0, 1, 2]);
  });

  it('reports a retry person the account records paid as paid, and pays nothing for a proposal that is not a retry of this run', async () => {
    const c = seeded.paysARetry;
    paidLeaves.add(c.legLeaves[2]!);
    const r = await post(`/api/runs/${c.runId}/private-payments`, { viewingKey: c.viewingKey, proposalId: approvedRetry.id });
    /* RED WHEN: the retry's payments are not asked about by their own leaves - a paid person is offered to pay again. */
    expect(r.body.payments.map((p: any) => [p.index, p.paid])).toEqual([[1, false], [2, true]]);
    /* RED WHEN: the leg's own round, named as if a retry, is answered as one. */
    const theLeg = await post(`/api/runs/${c.runId}/private-payments`, { viewingKey: c.viewingKey, proposalId: c.leg.id });
    expect(theLeg.status).toBe(409);
    expect(String(theLeg.body?.error)).toMatch(/no retry on the chain raised as that proposal/u);
    const nobody = await post(`/api/runs/${c.runId}/private-payments`, { viewingKey: c.viewingKey, proposalId: 'prp_nowhere' });
    expect(nobody.status).toBe(409);
  });
});

describe('2. A RETRY NAMING SOMEBODY ALREADY PAID IS REFUSED, NOT NARROWED', () => {
  it('names who was paid, writes nothing down, and raises nothing', async () => {
    const c = seeded.alreadyPaid;
    paidLeaves.add(c.legLeaves[1]!);
    const r = await deviceRetry(c, [1, 2]);
    /* RED WHEN: a retry does not ask who was paid - or drops #2 and raises #3 alone. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(/#2 has already been paid, as the account records.*Nothing was written down\./su);
    expect(retriesOf(c)).toEqual([]);
    expect(retryRoundsOf(c)).toEqual([]);
    /* The one nobody paid can still be retried alone. */
    const alone = await deviceRetry(c, [2]);
    expect(alone.status, JSON.stringify(alone.body)).toBe(200);
    expect(alone.body.order.indices).toEqual([2]);
  });

  it('refuses when the ledger cannot say who was paid', async () => {
    const c = seeded.alreadyPaid;
    const answer = ledger.paidAmong;
    Object.assign(ledger, { paidAmong: async () => ({ known: false, paid: [] }) });
    try {
      const r = await deviceRetry(c, [0]);
      /* RED WHEN: *cannot say* is read as *nobody* - a retry is raised over people who may have been paid. */
      expect(r.status).toBe(400);
      expect(String(r.body?.error)).toMatch(/who has been paid on this run cannot be told.*Nothing was written down\./su);
    } finally {
      Object.assign(ledger, { paidAmong: answer });
    }
  });
});

describe('3. A RETRY OVERLAPPING AN UNSENT OR A LIVE RETRY IS REFUSED, AND NOTHING IS WRITTEN DOWN', () => {
  it('over a retry written down and not sent', async () => {
    const c = seeded.overUnsent;
    const r = await deviceRetry(c, [2]);
    /* RED WHEN: overlapping but different people are not caught - a second round is raised over #3's leaf. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(new RegExp(`#3 is already on retry ${unsentRetry.id}.*written down and has not been sent`, 'su'));
    expect(retriesOf(c).map((x) => x.proposalId)).toEqual([unsentRetry.id]);
    expect(retryRoundsOf(c).map((x) => x.id)).toEqual([unsentRetry.id]);
  });

  it('over a retry sent and still inside its window, and not once that window has closed', async () => {
    const c = seeded.overSent;
    const r = await deviceRetry(c, [1, 2]);
    /* RED WHEN: a retry the chain holds and can still pay is not counted - two live rounds over #2's leaf. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(new RegExp(`#2 is already on retry ${sentRetry.id}.*can still pay them until \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC`, 'su'));
    expect(retriesOf(c).map((x) => x.proposalId)).toEqual([sentRetry.id]);
    /* Nobody else is refused on its account. */
    const other = await deviceRetry(c, [2]);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    /* Once the sent retry's window has closed it can pay nobody, and #2 can be retried with a window of their own. */
    vi.setSystemTime((Number(WINDOW.closesAt) + 60) * 1000);
    try {
      const later = { opensAt: String(Number(WINDOW.closesAt) + 60), closesAt: String(Number(WINDOW.closesAt) + 3_600) };
      const after = await deviceRetry(c, [1], later);
      /* RED WHEN: a sent retry blocks its people for ever - it can no longer pay them, and cannot be withdrawn once its window has opened. */
      expect(after.status, JSON.stringify(after.body)).toBe(200);
    } finally {
      afterTheLegsWindow();
    }
  });

  it('over a retry written down and not sent, until its window closes', async () => {
    const c = seeded.overUnsent;
    vi.setSystemTime((Number(WINDOW.closesAt) + 60) * 1000);
    try {
      const later = { opensAt: String(Number(WINDOW.closesAt) + 60), closesAt: String(Number(WINDOW.closesAt) + 3_600) };
      const after = await deviceRetry(c, [2], later);
      /* RED WHEN: an unsent retry whose window has closed still blocks its people - it can never be sent or paid now. */
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      /* And exactly its own people, with a window of their own, rather than being handed the closed one to send. */
      const same = await deviceRetry(seeded.overUnsentSame, [1, 2], later);
      /* RED WHEN: a written-down retry whose window has closed is handed back to be sent - a fee for a round that can pay nobody. */
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(same.body.proposal.id).not.toBe(unsentSameRetry.id);
    } finally {
      afterTheLegsWindow();
    }
  });
});

describe('3b. A RETRY OVERLAPPING ONE WHOSE RAISE DID NOT ANSWER IS REFUSED', () => {
  it('and the same people, window and vault send that round as itself', async () => {
    const c = seeded.threw;
    expect(threwRetry.raisedAt).toBeUndefined();
    expect(retriesOf(c).map((x) => x.proposalId)).toEqual([undefined]);
    const r = await deviceRetry(c, [2]);
    /* RED WHEN: a retry round the run was never told about is not counted - it may be on chain over #3's leaf. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(new RegExp(
      `#3 is on retry ${threwRetry.id}.*whose raise did not answer.*Retry exactly #2, #3 again with its window and vault to send it as itself, or retry them once its window closes at`, 'su'));
    expect(retryRoundsOf(c).map((x) => x.id)).toEqual([threwRetry.id]);
    /* What the refusal says to do works: the same people, window and vault send that round as itself. */
    const itself = await deviceRetry(c, [1, 2]);
    expect(itself.status, JSON.stringify(itself.body)).toBe(200);
    /* RED WHEN: the round being sent again as itself is counted against itself - it can then never be sent. */
    expect(itself.body.proposal.id).toBe(threwRetry.id);
    expect(retryRoundsOf(c).map((x) => x.id)).toEqual([threwRetry.id]);
  });
});

/** Resolves once `test` holds, polling the event loop rather than a clock. */
const until = async (test: () => boolean) => {
  for (let i = 0; i < 5_000 && !test(); i++) await new Promise((r) => setImmediate(r));
  if (!test()) throw new Error('what the test was waiting for never happened');
};

describe('4. TWO RETRY REQUESTS AT ONCE RAISE ONE PROPOSAL', () => {
  it('the second is refused while the first is choosing its people, and only the first is written down', async () => {
    const c = seeded.atOnce;
    /* The first request is held at the moment it asks who was paid - after it has looked at the other retries, before it writes. */
    let open!: () => void;
    const hold = { asked: false, opened: new Promise<void>((r) => { open = r; }) };
    heldQuestion = hold;
    const first = deviceRetry(c, [1, 2]);
    await until(() => hold.asked);
    const second = await deviceRetry(c, [2]);
    open();
    const done = await first;
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    /* RED WHEN: the people are chosen outside the leg's hold - the second finds #3 free too, and both are written down. */
    expect(second.status).toBe(400);
    expect(String(second.body?.error)).toMatch(/is being raised right now by another request.*Nothing was raised/su);
    expect(retriesOf(c).filter((x) => x.proposalId !== undefined).map((x) => x.originalIndices)).toEqual([[1, 2]]);
    expect(retryRoundsOf(c)).toHaveLength(1);
  });
});

describe('5. A RETRY IS NOT RAISED OVER PEOPLE ANOTHER RUN FOR THE MONTH HAS BEEN RAISED TO PAY', () => {
  it('on the device path, with nobody paid and nothing else covering them', async () => {
    const c = overAnotherRun;
    const r = await deviceRetry(c, [1]);
    /* RED WHEN: raiseARetry skips refuseRaisingOverAnotherRun - #2 is then raised on two runs, under two leaves, and both settle. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(new RegExp(`run ${c.otherRun} has already been raised for 2026-08`, 'u'));
    expect(retriesOf(c)).toEqual([]);
    expect(retryRoundsOf(c)).toEqual([]);
  });
});

describe('6. RETRY IS NOT RAISED OR OFFERED WHILE THE RUN IS PAYING, NOR FOR PEOPLE A SENT RETRY COVERS', () => {
  it('the company refuses a retry while the leg\'s own window is open, and the page is offered nobody', async () => {
    const c = seeded.stillPaying;
    const r = await deviceRetry(c, [1]);
    /* RED WHEN: a retry is raised while the leg's round can still pay the same people. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(/can still pay everybody on it until .* UTC, when its window closes.*Nothing was written down\./su);
    expect(retriesOf(c)).toEqual([]);
    const view = await post(`/api/runs/${c.runId}/payments`, { viewingKey: c.viewingKey });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    /* RED WHEN: the page's choice ignores the served view's phase AND reads its outstanding rather than its stranded - all three are then offered while the leg can still pay them. */
    expect(view.body.status.phase).toBe('open');
    expect(unpaidToRetry(view.body)).toEqual([]);
  });

  it('once the leg\'s window has closed, the page is offered only the people nothing can still pay', async () => {
    const c = seeded.view;
    const view = await post(`/api/runs/${c.runId}/payments`, { viewingKey: c.viewingKey });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.status.phase).toBe('closed');
    /* RED WHEN: #2, whom a sent retry can still pay, is offered again - the company would refuse it. */
    expect(unpaidToRetry(view.body)).toEqual([0, 2]);
  });
});
