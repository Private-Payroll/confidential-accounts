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
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-device-retry-')), 'db.json'),
});

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
const { directorySeats } = await import('../testing/directory-seats.js');
const { DEVICE_RAISE_VERSION, paymentsCheckedDigest, paymentsOnTheWire } = await import('../core/device-raise.js');
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
const payroll = new PayrollService(store, accounts, productAssets);

/* Ada's seat in each company's directory, as her wallet signed it, and the chain's read of it: a stand-in, as the relays check her seat against it. */
const seats = directorySeats();
const aStoppedRun = async (name: string, retryWrittenDown = false, legOnChain = true) => {
  const created = await accounts.create(name, [{ name: 'Ada', role: 'admin', userId: USER }], 1, undefined, drawCompanyLabel());
  const { viewingKey } = created;
  const account = created.account.id;
  for (const s of accounts.open(account, viewingKey).signers) leaves.set(`${account} ${s.id}`, s.leafCommitment as Hex);
  seats.claim(store, account, USER, created.secrets[0]!.signingSecret, 0x62);
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
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts, pay: inputs.pay, asset: inputs.asset,
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
  directoryChain: seats.directoryChain,
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
const post = (path: string, body: unknown) => call('POST', path, { token, body });

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
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
/** What the service's own reading of the leg says a retry of these people pays: what a device's digest is compared with. */
const retryPayments = async (c: Company, indices: number[]) => {
  const asked = payroll.retryPaymentsAsked(c.runId, c.viewingKey as Hex, indices);
  return { asset: asked.asset, payments: paymentsOnTheWire(asked.payments) as Array<{ kind: string; token: string; amount: string }> };
};
const digestOf = (payments: Array<{ kind: string; token: string; amount: string }>) =>
  paymentsCheckedDigest(payments);

/*
 * A retry is raised on the signer's device, over a tree of its own, and filed with the run as raised; every rule a
 * retry has is asked there: `a-leg-is-raised-on-the-device.test.ts`. What stays here is the send of a retry already
 * written down.
 */

describe('A RETRY WRITTEN DOWN ON A DEVICE IS SENT ONLY FROM THE CURRENT PAGE, AS THE CALL IT PROVED', () => {
  const send = (c: Company & { retryId?: string }, more: Record<string, unknown>) =>
    post(`/api/proposals/${c.retryId}/send`, { tx: Buffer.from('{}').toString('base64'), ...more });

  it('3c. A RETRY SEND FROM AN OUT-OF-DATE PAGE, OR CARRYING WHAT THE DEVICE CHECKED, IS REFUSED, AND NOTHING IS SENT', async () => {
    const c = seeded.written;
    const asked = (await retryPayments(c, UNPAID)).payments;
    for (const [why, more, status] of [
      ['no version', {}, 422],
      ['another version', { version: DEVICE_RAISE_VERSION + 1 }, 422],
      ['the digest of what was checked beside the call', { version: DEVICE_RAISE_VERSION, checked: digestOf(asked) }, 400],
    ] as const) {
      const r = await send(c, more);
      /* RED WHEN: a retry is sent from a page that may not have checked the vault, or the send route takes more than the call. */
      expect(r.status, why).toBe(status);
      expect(r.body?.nothingWasSent, why).toBe(true);
    }
    expect(sent).toEqual([]);
  });

  it('A SEND OF EXACTLY THE RETRY WRITTEN DOWN GOES OUT', async () => {
    const c = seeded.sendsOnce;
    const o = (await payroll.retryRaiseOrderOf(c.runId, c.viewingKey, c.retryId!))!;
    expect(o.indices).toEqual(UNPAID);
    /* RED WHEN: the digest of the retry written down is not the digest of what a device checks - every good send is then refused on the device. */
    expect(o.paymentsChecked).toBe(digestOf((await retryPayments(c, UNPAID)).payments));
    const order = {
      circuit: 'propose', proposal: o.chainId, half: o.half,
      run: { root: o.run.root, payees: o.run.payees.toString(), opensAt: o.run.opensAt.toString(), closesAt: o.run.closesAt.toString(), vault: o.run.vault },
    };
    const built = Buffer.from(JSON.stringify({ signer: c.signer, order })).toString('base64');
    const ok = await send({ ...c }, { tx: built, version: DEVICE_RAISE_VERSION });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(sent).toEqual(['propose']);
  });
});
