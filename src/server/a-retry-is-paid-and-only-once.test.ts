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
import { runsFiledBy } from '../testing/runs-a-seat-filed.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { importTheServer, useOnlyTheseSettings } from '../testing/server-under-test.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

useOnlyTheseSettings({
  ALLOW_SIMULATED_COMPANY_ADDRESS: '1',
  ALLOW_MEMORY_SESSIONS: '1',
  DATABASE_URL: '',
  SERVE: '0',
  APP_ORIGIN: 'https://payroll.example',
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-retry-once-')), 'db.json'),
});

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService, approvalMessage } = await import('../core/account.js');
const { PayrollService, runLegOf } = await import('../core/payroll.js');
const { SEED_ASSETS, assets: productAssets } = await import('../core/assets.js');
const { runMaterialFor, retryMaterialFor } = await import('../midnight/run-material.js');
const { buildRun, buildRetryRun } = await import('../midnight/payout-tree.js');
const { pathToWire } = await import('../midnight/private-payment-wire.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { toHex, sign } = await import('../core/crypto.js');
const { unpaidToRetry } = await import('vaults-web-shared/governed-call-on-device.js');
const { paymentViewHere, privatePaymentsHere } = await import('vaults-web-shared/payments-made-here.js');
const { signedFoundingState } = await import('../core/founding-state.js');
const { newSigningKeypair } = await import('../core/crypto.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
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
const payroll = new PayrollService(store, accounts, productAssets);

/** A company with three people on one private leg, raised and held by the chain. */
const aCompany = async (name: string, legWindowOpen = false) => {
  const created = await accounts.create(name, [{ name: 'Ada', role: 'admin', userId: USER }], 1, undefined, drawCompanyLabel());
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
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts, pay: inputs.pay, asset: inputs.asset,
    opensAt: BigInt(window.opensAt), closesAt: BigInt(window.closesAt), vault: VAULT, detailsOf: vaultDetails,
  });
  const seat = created.secrets[0]!;
  atTheLegsRaise();
  const leg = await payroll.proposeRun(run.id, viewingKey, seat.signerId, material);
  if (!leg.raisedAt) throw new Error(`the ${name} leg did not reach the chain`);
  afterTheLegsWindow();
  const legLeaves = payroll.requireRun(run.id, viewingKey).payout![runLegOf(PRIVATE.code, 'shielded')]!.leaves as Hex[];
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
  stillPaying: await aCompany('Stillpaying', true),
  view: await aCompany('View'),
};
/* The retry the payout case pays: #2 and #3, raised, approved. */
const approvedRetry = await aRetry(seeded.paysARetry, [1, 2]);
await accounts.approve(approvedRetry.id, seeded.paysARetry.seat.signerId,
  sign(approvalMessage(accounts.requireProposal(approvedRetry.id, seeded.paysARetry.viewingKey)), seeded.paysARetry.seat.signingSecret),
  seeded.paysARetry.viewingKey);
/* The payment view's case: a sent retry over #2, so #2 is owed but not stranded. */
await aRetry(seeded.view, [1]);

handInWiring({
  name: 'simulated',
  commitments: MidnightCommitments,
  createLedger: () => ledger,
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await importTheServer();

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

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
  const signedIn = await signInWithAWallet(call, { slot: SLOT, origin: ORIGIN, network: NETWORK });
  expect(signedIn.userId).toBe(USER);
  token = signedIn.token;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); vi.useRealTimers(); });
beforeEach(() => { sent.length = 0; paidLeaves.clear(); });

/** The retries written down on the run, as the store now holds it, and every retry round written for it. */
const retriesOf = (c: Company) => {
  const fresh = new PayrollService(new FileStore(process.env.DATA_PATH!), accounts, productAssets);
  return fresh.requireRun(c.runId, c.viewingKey).payout![runLegOf(PRIVATE.code, 'shielded')]!.retries ?? [];
};
/**
 * Who the leg has paid, as a signer's device reads it: the company's runs and proposals from the server, made into the
 * view on the device, over this file's double of the account's record of who is paid. Nothing else of the company is read.
 */
/** The directory a device holds for a company the service made: one seat, the founding signer's, holding the account. */
const aDirectoryOf = (account: string, signingKey: string) => {
  const SEAT = '4e'.repeat(32);
  const COMMITTEE = { tag: 'schnorr', value: '7a'.repeat(32) };
  return {
    dir: { company: account, version: 1, seats: [{ seat: SEAT, person: 'ada', signingKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin' as const, retired: null }] },
    holders: { committee: [COMMITTEE], seats: [SEAT], approvals: 1, adoptedVaults: [], founding: SEAT, foundingCommittee: [COMMITTEE], account: 'ac'.repeat(32) } as never,
    another: new Set<string>(),
  };
};
const viewHere = (c: Company) => {
  const api = async (path: string) => (await call('GET', path, { token })).body;
  const unread = async (): Promise<never> => { throw new Error('a payment view reads only the company\'s runs, its proposals and who filed them'); };
  const founder = newSigningKeypair();
  return paymentViewHere({
    directory: async () => aDirectoryOf(c.account, founder.publicKey), people: unread, state: unread,
    runs: async () => runsFiledBy(await api(`/api/accounts/${c.account}/runs`), c.account, founder.secret),
    proposals: () => api(`/api/accounts/${c.account}/proposals`),
    registry: productAssets,
  }, c.account, c.runId, c.viewingKey, {
    detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf,
    paidAmong: (leaves) => ledger.paidAmong(c.account, [...leaves]),
  });
};
/**
 * What a vault is handed to pay a leg, or a retry on it, as a signer's device makes it: the company's runs and proposals
 * from the server; its first state re-signed here as its founding seat's record, and the directory and the wallet's read
 * given, because the service made the company.
 */
const paysHere = async (c: Company, retry?: string) => {
  const api = async (path: string) => (await call('GET', path, { token })).body;
  const founder = newSigningKeypair();
  const state = signedFoundingState(c.account, { keyEpoch: 0, sealed: (await ledger.fetch(c.account, 0))!.sealedState }, founder.secret);
  return privatePaymentsHere({
    directory: async () => aDirectoryOf(c.account, founder.publicKey),
    people: async () => ({ people: [], notBelieved: [], notPayable: [] }),
    state: async (id: string) => (id === '0' ? state : null),
    runs: async () => runsFiledBy(await api(`/api/accounts/${c.account}/runs`), c.account, founder.secret),
    proposals: () => api(`/api/accounts/${c.account}/proposals`),
    registry: productAssets,
  }, c.account, c.runId, c.viewingKey, {
    detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf,
    paidAmong: (leaves) => ledger.paidAmong(c.account, [...leaves]),
  }, undefined, retry);
};

describe('1. AN APPROVED PRIVATE RETRY IS PAID, AND ONLY ITS PEOPLE ARE PAID', () => {
  it('the device makes the payments of the retry named, against its own round, and only the people it names', async () => {
    const c = seeded.paysARetry;
    const retryRecord = accounts.requireProposal(approvedRetry.id, c.viewingKey);
    expect(retryRecord.status).toBe('approved');
    /* RED WHEN: only the leg's own round is read - an approved retry then has nothing a vault can pay. */
    const r = { body: await paysHere(c, approvedRetry.id) as any };
    /* RED WHEN: the order names the leg's round, so a vault pays against the wrong approval. The root, count and window are the retry's own. */
    expect(r.body.proposal).toBe(retryRecord.chainId);
    expect(r.body.proposal).not.toBe(c.leg.chainId);
    const written = retriesOf(c).find((x) => x.proposalId === approvedRetry.id)!;
    expect(r.body.root).toBe(written.root);
    /* RED WHEN: the retry is paid over the leg's whole tree - an approval of it would then let anybody on the leg be paid. Its own tree pays its two. */
    expect(r.body.payees).toBe('2');
    expect(r.body.root).not.toBe(payroll.requireRun(c.runId, c.viewingKey).payout![runLegOf(PRIVATE.code, 'shielded')]!.root);
    expect([r.body.opensAt, r.body.closesAt]).toEqual([WINDOW.opensAt, WINDOW.closesAt]);
    expect(r.body.salt).toBe(accounts.runSaltOf(approvedRetry.id, c.viewingKey));
    /* RED WHEN: anybody the retry does not name is offered to pay - #1 was paid by the leg, or is some other round's. */
    expect(r.body.payments.map((p: any) => p.index)).toEqual([1, 2]);
    /* RED WHEN: a person is paid at a leaf other than the one the leg already holds for them - a second payment nothing would refuse. */
    expect(r.body.payments.map((p: any) => p.leaf)).toEqual([c.legLeaves[1], c.legLeaves[2]]);
    /* RED WHEN: a payment's path is not its place in the retry's own tree - the vault then finds it is not in the approved round. */
    const rebuild = (await payroll.payoutRebuildOf(c.runId, c.viewingKey))!;
    const retryTree = buildRetryRun(buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails, rebuild.pay, rebuild.asset), [1, 2]);
    expect(r.body.payments.map((p: any) => p.path)).toEqual([0, 1].map((i) => pathToWire(retryTree.payeeArgs(i).path)));
    expect(retryTree.tree.root).toBe(written.root);

    /* The leg's own payments: all three, against the leg's round. */
    const leg = await paysHere(c);
    expect(leg.proposal).toBe(c.leg.chainId);
    expect(leg.payments.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('reports a retry person the account records paid as paid, and pays nothing for a proposal that is not a retry of this run', async () => {
    const c = seeded.paysARetry;
    paidLeaves.add(c.legLeaves[2]!);
    const r = await paysHere(c, approvedRetry.id);
    /* RED WHEN: the retry's payments are not asked about by their own leaves - a paid person is offered to pay again. */
    expect(r.payments.map((p) => [p.index, p.paid])).toEqual([[1, false], [2, true]]);
    /* RED WHEN: the leg's own round, named as if a retry, is answered as one. */
    await expect(paysHere(c, c.leg.id)).rejects.toThrow(/records no retry raised as that proposal/u);
    await expect(paysHere(c, 'prp_nowhere')).rejects.toThrow(/records no retry raised as that proposal/u);
  });
});

/*
 * Who a retry may name, and what refuses it, are asked where a retry is raised, on the signer's device:
 * `a-leg-is-raised-on-the-device.test.ts`.
 */

describe('6. RETRY IS NOT OFFERED WHILE THE RUN IS PAYING, NOR FOR PEOPLE A SENT RETRY COVERS', () => {
  it('while the leg\'s own window is open, the page is offered nobody', async () => {
    const c = seeded.stillPaying;
    const view = await viewHere(c);
    /* RED WHEN: the page's choice ignores the view's phase AND reads its outstanding rather than its stranded - all three are then offered while the leg can still pay them. */
    expect(view.answered && view.status.phase).toBe('open');
    expect(unpaidToRetry(view)).toEqual([]);
  });

  it('once the leg\'s window has closed, the page is offered only the people nothing can still pay', async () => {
    const c = seeded.view;
    const view = await viewHere(c);
    expect(view.answered && view.status.phase).toBe('closed');
    /* RED WHEN: #2, whom a sent retry can still pay, is offered again - the company would refuse it. */
    expect(unpaidToRetry(view)).toEqual([0, 2]);
  });
});
