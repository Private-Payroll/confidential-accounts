/**
 * **A PRIVATE RUN THE VAULT STOPPED PART WAY IS RETRIED FROM A SIGNER'S DEVICE,
 * AND THE SERVED ROUTES REFUSE A PRIVATE RETRY THAT DID NOT COME FROM ONE.**
 *
 * A retry pays some of one leg's people from a second approval. Its private
 * payments can only be checked where the vault's notes are opened, which is the
 * device, so the retry route takes a device's raise exactly as the propose route
 * does: the version of the page that checked, and the digest of the payments it
 * checked. A retry not marked as the device's is asked about its private money
 * here, and refused, as it always was.
 *
 * What runs is this server's own routes over real HTTP, with a signed-in
 * person, and for the ordinary path the page's own device module. **Two pieces
 * are doubles, and they are named here**: the ledger under the server is the
 * simulated one, with a door for a device's transaction that records what it
 * was handed and then does what the transaction would have done; and the
 * device's worker, its read of the account's on-chain state and its read of the
 * vault are stand-ins, because no contract and no vault exist here.
 *
 * Each company's leg is raised and held by the chain before the server starts,
 * over the same store file and the same ledger it is handed: that is the state a
 * run is in when its vault stops paying part way.
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
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-device-retry-')), 'db.json');

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { SEED_ASSETS, assets: productAssets } = await import('../core/assets.js');
const { runMaterialFor, retryMaterialFor } = await import('../midnight/run-material.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { toHex } = await import('../core/crypto.js');
const { DEVICE_RAISE_VERSION, paymentsCheckedDigest } = await import('../core/device-raise.js');
const device = await import('../web/governed-call-on-device.js');
type Hex = import('../core/crypto.js').Hex;

const NETWORK = theNetwork();
const SLOT = 82;
const USER = 'usr_device_retry_ada';
const VAULT = toHex(new Uint8Array(32).fill(0xb3));
/* Whichever asset this build can pay privately; the test names none. */
const PRIVATE = SEED_ASSETS.find((a) => a.ledger.shielded !== null)!;
const HELD = 1n << 100n;

/* ── the chain, and its door for a device's transaction ─────────────────── */

const ledger = new SimulatedLedger(MidnightCommitments);
const leaves = new Map<string, Hex>();
const sent: string[] = [];
type Built = {
  signer: string;
  order: {
    circuit: 'propose'; proposal: Hex;
    run: { root: Hex; payees: string; opensAt: string; closesAt: string; vault: Hex };
    half: { changeAmount: string; changeBatchDigest: Hex; proposalSalt: Hex };
  };
};
/*
 * A DOUBLE, NAMED: the simulated ledger records no payments and answers that it cannot say who was paid,
 * and a retry is refused until that can be said. Here the account records nobody on these runs paid.
 */
Object.assign(ledger, { paidAmong: async () => ({ known: true, paid: [] }) });
Object.assign(ledger, {
  submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
    const built = JSON.parse(Buffer.from(bytes).toString('utf8')) as Built;
    sent.push(circuit);
    const o = built.order;
    const r = await ledger.proposeRun(accountId, {
      root: o.run.root, payees: BigInt(o.run.payees), opensAt: BigInt(o.run.opensAt),
      closesAt: BigInt(o.run.closesAt), vault: o.run.vault,
    }, {
      asset: PRIVATE.code, amount: BigInt(o.half.changeAmount), batchDigest: o.half.changeBatchDigest,
      salt: o.half.proposalSalt,
    }, { signerId: built.signer, leaf: leaves.get(`${accountId} ${built.signer}`)! });
    return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
  },
});

/* ── the companies, each with a leg the chain holds, written before the server starts ── */

/*
 * THIS MACHINE'S CLOCK IS THE TEST'S. Each leg is raised with a window that closes half a minute on, and
 * the clock is then moved a minute past it: a retry is raised only once the leg's own round can no
 * longer pay anybody, and each retry's own window is open from then for an hour.
 */
vi.useFakeTimers({ toFake: ['Date'] });
const now = Math.floor(Date.now() / 1000);
const LEG_WINDOW = { opensAt: String(now - 60), closesAt: String(now + 30) };
const WINDOW = { opensAt: String(now + 30), closesAt: String(now + 3_600) };
const atTheLegsRaise = () => vi.setSystemTime(now * 1000);
const afterTheLegsWindow = () => vi.setSystemTime((now + 60) * 1000);
/* The people the vault did not reach: the second and the third of three. */
const UNPAID = [1, 2];

const store = new FileStore(process.env.DATA_PATH!);
store.putUser({
  id: USER, email: 'ada@northwind.example', name: 'ada', keyBundle: null, keyBundleVersion: 0,
  walletKey: walletKeyOf(addressOfSlot(SLOT, NETWORK)), createdAt: '2026-09-23T00:00:00.000Z',
} as never);
/* This service's own reader, before the server starts, CAN read private money: that is how each leg reached the chain here. */
const accounts = new AccountService(store, ledger, MidnightCommitments, productAssets, aVaultHolding(HELD));
const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), productAssets);

const aStoppedRun = async (name: string, retryWrittenDown = false, legOnChain = true) => {
  const created = await accounts.create(name, [{ name: 'Ada', role: 'admin', userId: USER }], 1);
  const { viewingKey } = created;
  const account = created.account.id;
  for (const s of accounts.open(account, viewingKey).signers) leaves.set(`${account} ${s.id}`, s.leafCommitment as Hex);
  for (let i = 0; i < 3; i++) {
    payroll.hireDirect(account, {
      name: `${name} payee ${i}`, email: `p${i}@${name.toLowerCase()}.example`, title: 'Eng', asset: PRIVATE.code,
      baseAmount: BigInt(100 + i) * 1_000_000n,
    }, viewingKey);
  }
  const { run } = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
  const addresses = (await payroll.runMaterialInputs(run.id, viewingKey)).facts.flatMap((f) =>
    Object.entries(f.payee).filter(([k, v]) => k !== 'kind' && typeof v === 'string').map(([, v]) => String(v)));
  const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
  const material = await runMaterialFor({
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
    opensAt: BigInt(LEG_WINDOW.opensAt), closesAt: BigInt(LEG_WINDOW.closesAt), vault: VAULT, detailsOf: vaultDetails,
  });
  const signer = created.secrets[0]!.signerId;
  atTheLegsRaise();
  const leg = await payroll.proposeRun(run.id, viewingKey, signer, material, undefined, legOnChain ? undefined : { onDevice: true });
  if (legOnChain && !leg.raisedAt) throw new Error(`the ${name} leg did not reach the chain, so it has nothing to retry`);
  afterTheLegsWindow();
  let retryId: string | undefined;
  if (retryWrittenDown) {
    const rebuild = (await payroll.payoutRebuildOf(run.id, viewingKey))!;
    const m = await retryMaterialFor({
      rebuild, indices: UNPAID, opensAt: BigInt(WINDOW.opensAt), closesAt: BigInt(WINDOW.closesAt), vault: VAULT,
      detailsOf: vaultDetails,
    });
    retryId = (await payroll.proposeRetry(run.id, viewingKey, signer, m, undefined, { onDevice: true })).id;
  }
  return { account, viewingKey, runId: run.id, signer, addresses, leg: leg.id, retryId };
};

const seeded = {
  /* One company per case, so a refusal that failed to refuse cannot turn the next case red for it. */
  retried: await aStoppedRun('Retried'),
  notDevice: await aStoppedRun('Notdevice'),
  noVersion: await aStoppedRun('Noversion'),
  mismatch: await aStoppedRun('Mismatch'),
  rules: await aStoppedRun('Rules'),
  /* A leg written down on a device and never sent: the chain holds no round of it to retry. */
  neverSent: await aStoppedRun('Neversent', false, false),
  resumed: await aStoppedRun('Resumed', true),
  written: await aStoppedRun('Written', true),
  sendsOnce: await aStoppedRun('Sendsonce', true),
};

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
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { sent.length = 0; });

/* ── what the device would have been handed, and what it would send ─────── */

type Company = { runId: string; viewingKey: string };
const retryPayments = async (c: Company, indices: number[]) => {
  const r = await post(`/api/runs/${c.runId}/retry-payments`, { viewingKey: c.viewingKey, indices });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { asset: string; payments: Array<{ kind: string; token: string; amount: string }> };
};
const digestOf = (payments: Array<{ kind: string; token: string; amount: string }>) =>
  paymentsCheckedDigest(payments);
const retryBody = (c: Company, more: Record<string, unknown>) =>
  ({ viewingKey: c.viewingKey, indices: UNPAID, vault: VAULT, ...WINDOW, ...more });
/** The retries written down on the company's own record of the run, as the store now holds it. */
const retriesOf = (c: Company) => {
  const fresh = new PayrollService(new FileStore(process.env.DATA_PATH!), accounts, new SimulatedProofSystem(), productAssets);
  return fresh.requireRun(c.runId, c.viewingKey as Hex).payout![PRIVATE.code]!.retries ?? [];
};

describe('A PRIVATE RETRY FROM A DEVICE IS WRITTEN DOWN AND SENT; ONE FROM ANYWHERE ELSE IS REFUSED', () => {
  it('1. A PRIVATE RETRY MARKED AS THE DEVICE\'S, THROUGH THE PAGE\'S OWN MODULE, IS WRITTEN DOWN AND SENT, AND NOTHING SENT CARRIES AN ADDRESS, A NOTE OR A BALANCE', async () => {
    const c = seeded.retried;
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const api = async (path: string, init?: RequestInit) => {
      if (init?.body) bodies.push({ path: path.replace(c.runId, ':run').replace(/prp_[A-Za-z0-9_-]+/u, ':proposal'), body: JSON.parse(String(init.body)) });
      const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body?.error ?? `request failed: ${r.status}`), body);
      return body;
    };
    const holdings = aVaultHolding(HELD);
    const done = await device.raiseRetryOnDevice({
      service: { ...device.governedCallServiceFor(api), callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }) },
      builder: { governedCall: async ({ order }) => ({ tx: Buffer.from(JSON.stringify({ signer: c.signer, order })).toString('base64') }) },
      material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
      accountId: c.account, holdings, sleep: async () => {}, waitMs: 40, everyMs: 1,
    }, { runId: c.runId, viewingKey: c.viewingKey, indices: UNPAID, vault: VAULT, ...WINDOW });
    /* RED WHEN: the retry route does not take a device's raise - every private retry is then refused, as before this round. */
    expect(done.raisedAt).toBeDefined();
    expect(done.id).not.toBe(c.leg);
    expect(sent).toEqual(['propose']);
    /* RED WHEN: the retry is not written down on the run as the proposal the device sent. */
    expect(retriesOf(c).map((r) => [r.originalIndices, r.proposalId])).toEqual([[UNPAID, done.id]]);
    /* RED WHEN: a route gains a field - above all one carrying who is paid, a note or what the vault holds. */
    const KEYS: Record<string, string[]> = {
      '/api/runs/:run/retry-payments': ['indices', 'viewingKey'],
      '/api/runs/:run/retry': ['checked', 'closesAt', 'indices', 'onDevice', 'opensAt', 'vault', 'version', 'viewingKey'],
      '/api/runs/:run/retry-send': ['checked', 'proposalId', 'tx', 'version', 'viewingKey'],
      '/api/proposals/:proposal/standing': ['viewingKey'],
    };
    for (const b of bodies) expect(Object.keys(b.body).sort(), b.path).toEqual(KEYS[b.path]);
    /* RED WHEN: the device stops checking the vault again right before the send. */
    expect(bodies.map((b) => b.path).slice(0, 4)).toEqual([
      '/api/runs/:run/retry-payments', '/api/runs/:run/retry', '/api/runs/:run/retry-payments', '/api/runs/:run/retry-send',
    ]);
    const everything = JSON.stringify(bodies.map((b) => ({ ...b, body: { ...b.body, tx: undefined } })));
    expect(c.addresses.length).toBeGreaterThanOrEqual(3);
    for (const a of c.addresses) expect(everything).not.toContain(a);
    expect(everything).not.toContain(HELD.toString());
    expect(everything).not.toMatch(/notes|nonce|pool|balance|held|address/u);
    expect(holdings.reads.length).toBeGreaterThan(0);
  });

  it('2. A PRIVATE RETRY NOT MARKED AS THE DEVICE\'S IS REFUSED FOR ITS PRIVATE MONEY, AS IT ALWAYS WAS, AND NOTHING IS WRITTEN DOWN', async () => {
    const c = seeded.notDevice;
    const checked = digestOf((await retryPayments(c, UNPAID)).payments);
    for (const [why, more] of [
      ['a retry that names nothing', {}],
      ['one that names the version and what was checked, but not the device', { version: DEVICE_RAISE_VERSION, checked }],
    ] as const) {
      const r = await post(`/api/runs/${c.runId}/retry`, retryBody(c, more));
      /* RED WHEN: the service stops asking about private money a retry not marked as the device's would pay, or the new fields switch that off. */
      expect(r.status, why).toBe(400);
      expect(String(r.body?.error), why).toMatch(
        /(cannot read what a vault holds|what the vault holds of \S+ privately could not be established).*Nothing was raised and no fee was spent\.$/su);
      expect(String(r.body?.error), why).not.toMatch(/out of date|does not say which payments|the run changed after this device checked it/u);
    }
    /* RED WHEN: a refused retry is written onto the run anyway. */
    expect(retriesOf(c).filter((r) => r.proposalId !== undefined)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('3. A RETRY FROM AN OUT-OF-DATE PAGE, OR THAT DOES NOT SAY WHAT IT CHECKED, IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN', async () => {
    const c = seeded.noVersion;
    const checked = digestOf((await retryPayments(c, UNPAID)).payments);
    for (const [why, more] of [
      ['no version', { checked }],
      ['the version before', { checked, version: DEVICE_RAISE_VERSION - 1 }],
      ['a version after', { checked, version: DEVICE_RAISE_VERSION + 1 }],
      ['the right number spelled as a string', { checked, version: String(DEVICE_RAISE_VERSION) }],
    ] as const) {
      const r = await post(`/api/runs/${c.runId}/retry`, retryBody(c, { onDevice: true, ...more }));
      /* RED WHEN: a retry from a page that may not have checked the vault is trusted. */
      expect(r.status, why).toBe(400);
      expect(String(r.body?.error), why).toMatch(/Reload the page and try again\. Nothing was written down\./u);
    }
    const unchecked = await post(`/api/runs/${c.runId}/retry`, retryBody(c, { onDevice: true, version: DEVICE_RAISE_VERSION }));
    /* RED WHEN: a device retry that names the version but not what it checked is trusted. */
    expect(unchecked.status).toBe(400);
    expect(String(unchecked.body?.error)).toMatch(/does not say which payments the device checked/u);
    expect(retriesOf(c)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('3b. A RETRY WHOSE DIGEST IS NOT OF ITS OWN PAYMENTS IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN', async () => {
    const c = seeded.mismatch;
    const asked = (await retryPayments(c, UNPAID)).payments;
    const everyone = (await retryPayments(c, [0, 1, 2])).payments;
    for (const [why, other] of [
      ['one amount different', asked.map((p, i) => (i === 1 ? { ...p, amount: String(BigInt(p.amount) + 1n) } : p))],
      ['the payments of the whole leg, not the retry', everyone],
      ['the payments of other people on the leg', [everyone[0]!, everyone[1]!]],
      ['the same payments in another order', [...asked].reverse()],
    ] as const) {
      const r = await post(`/api/runs/${c.runId}/retry`,
        retryBody(c, { onDevice: true, version: DEVICE_RAISE_VERSION, checked: digestOf([...other]) }));
      /* RED WHEN: the service writes the retry down without comparing its payments with what the device checked. */
      expect(r.status, why).toBe(400);
      expect(String(r.body?.error), why).toMatch(/the run changed after this device checked it against the vault.*Nothing was written down\./su);
    }
    expect(retriesOf(c)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('5. A DEVICE RETRY IS HELD TO EVERY RULE A RETRY HAS: ONLY THE LEG\'S OWN PEOPLE, EACH ONCE, AT THE LEAF THEY ALREADY HAVE', async () => {
    const c = seeded.rules;
    for (const [why, indices, refusal] of [
      ['a person who is not on the leg', [1, 3], /there is no person 3 on it to retry|payee 3 is not in the original run/u],
      ['one person named twice', [1, 1], /named twice|listed twice/u],
    ] as const) {
      /* The digest the device would compute over whatever it was handed; the rule refuses before or after it. */
      const r = await post(`/api/runs/${c.runId}/retry`, retryBody(c, {
        indices, onDevice: true, version: DEVICE_RAISE_VERSION, checked: 'ab'.repeat(32),
      }));
      /* RED WHEN: a device retry skips a rule of the retry's own. */
      expect(r.status, why).toBe(400);
      expect(String(r.body?.error), why).toMatch(refusal);
    }
    expect(retriesOf(c)).toEqual([]);
    /* And a retry that is allowed pays each person at the leaf the leg already holds for them - the leaf is the payment. */
    const checked = digestOf((await retryPayments(c, UNPAID)).payments);
    const ok = await post(`/api/runs/${c.runId}/retry`, retryBody(c, { onDevice: true, version: DEVICE_RAISE_VERSION, checked }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    /* RED WHEN: a device retry is sent by this service - it is the device that sends it. */
    expect(ok.body.proposal.raisedAt).toBeUndefined();
    expect(sent).toEqual([]);
    expect(ok.body.order.indices).toEqual(UNPAID);
    const leg = new PayrollService(new FileStore(process.env.DATA_PATH!), accounts, new SimulatedProofSystem(), productAssets)
      .requireRun(c.runId, c.viewingKey as Hex).payout![PRIVATE.code]!;
    /* RED WHEN: the retry's material is built under another identity or generation - its people then have new leaves, and both rounds pay them. */
    const rebuilt = await retryMaterialFor({
      rebuild: (await payroll.payoutRebuildOf(c.runId, c.viewingKey as Hex))!, indices: UNPAID,
      opensAt: BigInt(WINDOW.opensAt), closesAt: BigInt(WINDOW.closesAt), vault: VAULT, detailsOf: vaultDetails,
    });
    expect(rebuilt.leaves).toEqual(UNPAID.map((i) => leg.leaves[i]));
    expect(ok.body.order.order.run.root).toBe(rebuilt.run.root);
  });

  it('5b. A DEVICE RETRY THAT PASSES EVERY CHECK OF ITS OWN IS STILL REFUSED BY THE RETRY\'S RULES: A LEG THE CHAIN NEVER HELD HAS NO ROUND TO RETRY', async () => {
    const c = seeded.neverSent;
    const checked = digestOf((await retryPayments(c, UNPAID)).payments);
    const r = await post(`/api/runs/${c.runId}/retry`, retryBody(c, { onDevice: true, version: DEVICE_RAISE_VERSION, checked }));
    /* RED WHEN: the device path reaches the write-down without the retry's own rules - a round never on chain is split into retries. */
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(String(r.body?.error)).toMatch(/has no round the chain has been seen to hold, so there is no round on it to retry/u);
    expect(retriesOf(c)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('5c. A RETRY A DEVICE WROTE DOWN AND DID NOT SEND IS SENT AS ITSELF WHEN THE SAME PEOPLE ARE RETRIED AGAIN, NEVER RAISED A SECOND TIME', async () => {
    const c = seeded.resumed;
    const checked = digestOf((await retryPayments(c, UNPAID)).payments);
    const again = await post(`/api/runs/${c.runId}/retry`, retryBody(c, { onDevice: true, version: DEVICE_RAISE_VERSION, checked }));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    /* RED WHEN: retrying the same people writes down a second round over the same leaves - a second fee, and a round that can never complete. */
    expect(again.body.proposal.id).toBe(c.retryId);
    expect(again.body.order.proposalId).toBe(c.retryId);
    expect(retriesOf(c).map((r) => r.proposalId)).toEqual([c.retryId]);
    /* A different window is a different round: refused, and the sentence says what the written-down one is. */
    const other = await post(`/api/runs/${c.runId}/retry`, retryBody(c, {
      onDevice: true, version: DEVICE_RAISE_VERSION, checked, closesAt: String(now + 7_200),
    }));
    /* RED WHEN: a retry with another window is handed the written-down one, or raised as a second round. */
    expect(other.status).toBe(400);
    expect(String(other.body?.error)).toMatch(/a retry of these people is already written down.*Retry them with that window and that vault/su);
    expect(retriesOf(c).map((r) => r.proposalId)).toEqual([c.retryId]);
    expect(sent).toEqual([]);
  });
});

describe('A RETRY WRITTEN DOWN ON A DEVICE IS SENT ONLY FROM THE CURRENT PAGE, AND ONLY AS WHAT IT CHECKED', () => {
  const send = (c: Company & { retryId?: string }, more: Record<string, unknown>) =>
    post(`/api/runs/${c.runId}/retry-send`, { viewingKey: c.viewingKey, proposalId: c.retryId, tx: Buffer.from('{}').toString('base64'), ...more });

  it('3c. A RETRY SEND FROM AN OUT-OF-DATE PAGE, OR WHOSE DIGEST IS NOT THE RETRY\'S, IS REFUSED, AND NOTHING IS SENT', async () => {
    const c = seeded.written;
    const asked = (await retryPayments(c, UNPAID)).payments;
    const everyone = (await retryPayments(c, [0, 1, 2])).payments;
    for (const [why, more, refusal] of [
      ['no version', { checked: digestOf(asked) }, /Reload the page and try again\. Nothing was sent\./u],
      ['another version', { checked: digestOf(asked), version: DEVICE_RAISE_VERSION + 1 }, /Reload the page and try again\. Nothing was sent\./u],
      ['the whole leg checked, not the retry', { checked: digestOf(everyone), version: DEVICE_RAISE_VERSION }, /is not what this device checked against the vault just now.*Nothing was sent\./su],
      ['nothing said about what was checked', { version: DEVICE_RAISE_VERSION }, /is not what this device checked against the vault just now.*Nothing was sent\./su],
    ] as const) {
      const r = await send(c, more);
      /* RED WHEN: a retry is sent from a page that may not have checked the vault, or without comparing what it checked. */
      expect(r.status, why).toBe(422);
      expect(r.body?.nothingWasSent, why).toBe(true);
      expect(String(r.body?.error), why).toMatch(refusal);
    }
    /* RED WHEN: the retry-send door sends the LEG's proposal, or any proposal not written down as a retry of this run. */
    const theLeg = await send({ ...c, retryId: seeded.written.leg }, { checked: digestOf(asked), version: DEVICE_RAISE_VERSION });
    expect(theLeg.status).toBe(422);
    expect(String(theLeg.body?.error)).toMatch(/no retry written down as that proposal/u);
    /* RED WHEN: the retry is looked up by anything but the proposal named - a name nobody wrote down finds some other retry. */
    const nobody = await send({ ...c, retryId: 'prp_written_down_nowhere' }, { checked: digestOf(asked), version: DEVICE_RAISE_VERSION });
    expect(nobody.status).toBe(422);
    expect(String(nobody.body?.error)).toMatch(/no retry written down as that proposal waiting to be sent/u);
    expect(sent).toEqual([]);
  });

  it('A RETRY WRITTEN DOWN IS HANDED OVER AS WRITTEN, AND A SEND OF EXACTLY THAT GOES OUT', async () => {
    const c = seeded.sendsOnce;
    const r = await post(`/api/runs/${c.runId}/retry-order`, { viewingKey: c.viewingKey, proposalId: c.retryId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    /* RED WHEN: the order starts carrying the payments, or anything about who is paid. */
    expect(Object.keys(r.body).sort()).toEqual(['chainId', 'indices', 'order', 'paymentsChecked', 'proposalId']);
    expect(r.body.indices).toEqual(UNPAID);
    const checked = digestOf((await retryPayments(c, UNPAID)).payments);
    /* RED WHEN: the digest the order carries is not the digest of what the device is handed to check - the device then refuses a good send. */
    expect(r.body.paymentsChecked).toBe(checked);
    const built = Buffer.from(JSON.stringify({ signer: c.signer, order: r.body.order })).toString('base64');
    const ok = await send({ ...c }, { tx: built, version: DEVICE_RAISE_VERSION, checked });
    /* RED WHEN: the digest of what the device is handed for a retry is not the retry's own. */
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(sent).toEqual(['propose']);
  });
});
