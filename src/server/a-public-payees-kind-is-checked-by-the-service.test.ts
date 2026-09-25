/**
 * **A PUBLIC PAYEE'S KIND IS PART OF WHAT A DEVICE CHECKED, AT BOTH OF THE
 * SERVICE'S DOORS THAT COMPARE IT.**
 *
 * A run pays each person in the form their address is, so a run can now carry
 * a public payment. The service compares the payments a device checked against
 * the vault with the payments it is about to raise, at the raise and at a
 * retry, and each payment's kind is one of the three things compared. Here the
 * kind a device names for a public payee is changed to private, and each door
 * refuses; the same payments named as they are pass the comparison and reach
 * the next question, what the vault holds publicly.
 *
 * What runs is this server's own routes over real HTTP, with a signed-in
 * person. **The ledger under the server is the simulated one**, with a door for
 * a device's transaction that raises the round it was handed, and with its
 * record of who was paid answering that nobody on these runs was; no contract
 * and no vault exist here. The companies and each leg on the chain are made
 * before the server starts, over the same store file and the same ledger.
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
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-public-kind-')), 'db.json');

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { assets: productAssets } = await import('../core/assets.js');
const { runMaterialFor } = await import('../midnight/run-material.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { unshieldedPayeeFor } = await import('../testing/payees.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { newWrappingKeypair, toHex } = await import('../core/crypto.js');
const { DEVICE_RAISE_VERSION, paymentsCheckedDigest } = await import('../core/device-raise.js');
type Hex = import('../core/crypto.js').Hex;

const NETWORK = theNetwork();
const SLOT = 83;
const USER = 'usr_public_kind_ada';
const VAULT = toHex(new Uint8Array(32).fill(0xb4));
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
/* A DOUBLE, NAMED: nobody on these runs is recorded paid, so a retry of them can be asked about. */
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
      asset: 'NIGHT', amount: BigInt(o.half.changeAmount), batchDigest: o.half.changeBatchDigest,
      salt: o.half.proposalSalt,
    }, { signerId: built.signer, leaf: leaves.get(`${accountId} ${built.signer}`)! });
    return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
  },
});

/* ── the companies, written before the server starts ────────────────────── */

vi.useFakeTimers({ toFake: ['Date'] });
const now = Math.floor(Date.now() / 1000);
const LEG_WINDOW = { opensAt: String(now - 60), closesAt: String(now + 30) };
const WINDOW = { opensAt: String(now + 30), closesAt: String(now + 3_600) };
const atTheLegsRaise = () => vi.setSystemTime(now * 1000);
const afterTheLegsWindow = () => vi.setSystemTime((now + 60) * 1000);

const store = new FileStore(process.env.DATA_PATH!);
store.putUser({
  id: USER, email: 'ada@northwind.example', name: 'ada', keyBundle: null, keyBundleVersion: 0,
  walletKey: walletKeyOf(addressOfSlot(SLOT, NETWORK)), createdAt: '2026-09-25T00:00:00.000Z',
} as never);
const accounts = new AccountService(store, ledger, MidnightCommitments, productAssets, aVaultHolding(HELD));
const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), productAssets, NETWORK);

/** A company whose one payee is paid publicly, in NIGHT, with a run drawn over them; its leg raised on chain when asked. */
const aCompanyPayingPublicly = async (name: string, raised: boolean) => {
  const created = await accounts.create(name, [{ name: 'Ada', role: 'admin', userId: USER }], 1);
  const { viewingKey } = created;
  const account = created.account.id;
  for (const s of accounts.open(account, viewingKey).signers) leaves.set(`${account} ${s.id}`, s.leafCommitment as Hex);
  payroll.addSelfAsPayee(account, USER, {
    name: `${name} contractor`, email: null, title: 'Contractor', asset: 'NIGHT', baseAmount: 500_000n,
  }, viewingKey, { wrappingPublicKey: newWrappingKeypair().publicKey, address: unshieldedPayeeFor('e5'.repeat(32), NETWORK) });
  const { run } = await payroll.createRunFromRoster(account, '2026-09', viewingKey);
  const signer = created.secrets[0]!.signerId;
  if (raised) {
    const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
      opensAt: BigInt(LEG_WINDOW.opensAt), closesAt: BigInt(LEG_WINDOW.closesAt), vault: VAULT, detailsOf: vaultDetails,
    });
    atTheLegsRaise();
    const leg = await payroll.proposeRun(run.id, viewingKey, signer, material);
    if (!leg.raisedAt) throw new Error(`the ${name} leg did not reach the chain, so it has nothing to retry`);
    afterTheLegsWindow();
  }
  return { account, viewingKey, runId: run.id, signer };
};

const seeded = {
  raise: await aCompanyPayingPublicly('Raisespublic', false),
  retry: await aCompanyPayingPublicly('Retriespublic', true),
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

type Payment = { kind: string; token: string; amount: string };
const privateAgain = (payments: Payment[]) => payments.map((p) => (p.kind === 'unshielded' ? { ...p, kind: 'shielded' } : p));
/*
 * The next question after the comparison: what the vault holds publicly. Whether this deployment can read a chain
 * decides which of the two answers comes back, and both refuse before any fee.
 */
const PUBLIC_MONEY_ASKED =
  /^(this service cannot read what a vault holds|what the vault holds of NIGHT publicly could not be read from the chain).*Nothing was raised and no fee was spent\.$/su;
const CHANGED = /the run changed after this device checked it against the vault.*Nothing was written down\./su;

describe('A PUBLIC PAYEE\'S KIND IS CHECKED WHERE THE SERVICE COMPARES WHAT A DEVICE CHECKED', () => {
  it('AT THE RAISE: A DEVICE THAT NAMES A PUBLIC PAYMENT AS PRIVATE IS REFUSED, AND THE SAME PAYMENTS AS THEY ARE PASS', async () => {
    const c = seeded.raise;
    const asked = await post(`/api/runs/${c.runId}/leg-payments`, { viewingKey: c.viewingKey });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const payments = asked.body.payments as Payment[];
    /* The service hands over the public payee's payment as public. */
    expect(payments.map((p) => p.kind)).toEqual(['unshielded']);
    const body = (checked: string) => ({ viewingKey: c.viewingKey, vault: VAULT, ...WINDOW, onDevice: true, version: DEVICE_RAISE_VERSION, checked });
    /* RED WHEN: the kind drops out of what is compared at the raise - a device that checked a private payment raises a public one. */
    const refused = await post(`/api/runs/${c.runId}/propose`, body(paymentsCheckedDigest(privateAgain(payments))));
    expect(refused.status).toBe(400);
    expect(String(refused.body?.error)).toMatch(CHANGED);
    expect(sent).toEqual([]);
    /*
     * The control: the payments as the service hands them over pass the comparison and reach the next question,
     * which is the vault's public money. No vault exists here to answer it, so it refuses there, before any fee.
     */
    const raised = await post(`/api/runs/${c.runId}/propose`, body(paymentsCheckedDigest(payments)));
    expect(String(raised.body?.error ?? '')).not.toMatch(CHANGED);
    expect(String(raised.body?.error)).toMatch(PUBLIC_MONEY_ASKED);
    expect(sent).toEqual([]);
  });

  it('AT A RETRY: A DEVICE THAT NAMES A PUBLIC PAYMENT AS PRIVATE IS REFUSED, AND THE SAME PAYMENTS AS THEY ARE PASS', async () => {
    const c = seeded.retry;
    const asked = await post(`/api/runs/${c.runId}/retry-payments`, { viewingKey: c.viewingKey, indices: [0] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const payments = asked.body.payments as Payment[];
    expect(payments.map((p) => p.kind)).toEqual(['unshielded']);
    const body = (checked: string) => ({
      viewingKey: c.viewingKey, indices: [0], vault: VAULT, ...WINDOW, onDevice: true, version: DEVICE_RAISE_VERSION, checked,
    });
    /* RED WHEN: the kind drops out of what is compared at a retry. */
    const refused = await post(`/api/runs/${c.runId}/retry`, body(paymentsCheckedDigest(privateAgain(payments))));
    expect(refused.status).toBe(400);
    expect(String(refused.body?.error)).toMatch(CHANGED);
    expect(sent).toEqual([]);
    /* The control: the retry's own payments, as they are, pass the comparison and reach the vault's public money. */
    const written = await post(`/api/runs/${c.runId}/retry`, body(paymentsCheckedDigest(payments)));
    expect(String(written.body?.error ?? '')).not.toMatch(CHANGED);
    expect(String(written.body?.error)).toMatch(PUBLIC_MONEY_ASKED);
    expect(sent).toEqual([]);
  });
});
