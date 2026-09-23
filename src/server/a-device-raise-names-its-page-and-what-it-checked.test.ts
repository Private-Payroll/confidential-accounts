/**
 * **A RAISE OR A SEND FROM A SIGNER'S DEVICE NAMES THE VERSION OF THE PAGE THAT
 * CHECKED THE VAULT, AND THE PAYMENTS IT CHECKED, AND THE SERVED ROUTES REFUSE
 * ONE THAT DOES NOT.**
 *
 * The service cannot check a vault's private money: only the device can open
 * the vault's notes. So it refuses a device raise or send from a page that does
 * not say it is the current version, and one whose digest of the payments
 * checked is not the digest of what the service is about to write down or send.
 *
 * What runs is this server's own routes over real HTTP, with a signed-in
 * person, and for the ordinary path the page's own device module. **Two pieces
 * are doubles, and they are named here**: the ledger under the server is the
 * simulated one, with a door for a device's transaction that records what it
 * was handed and then does what the transaction would have done; and the
 * device's worker, its read of the account's on-chain state and its read of the
 * vault are stand-ins, because no contract and no vault exist here.
 *
 * The companies and the one proposal written down are made before the server
 * starts, over the same store file and the same ledger it is handed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-device-raise-')), 'db.json');

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { SEED_ASSETS, assets: productAssets } = await import('../core/assets.js');
const { runMaterialFor } = await import('../midnight/run-material.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { toHex } = await import('../core/crypto.js');
const { DEVICE_RAISE_VERSION, paymentsCheckedDigest } = await import('../core/device-raise.js');
const device = await import('../web/governed-call-on-device.js');
type Hex = import('../core/crypto.js').Hex;

const NETWORK = theNetwork();
const SLOT = 81;
const USER = 'usr_device_raise_ada';
const VAULT = toHex(new Uint8Array(32).fill(0xb2));
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

/* ── the companies, written before the server starts ────────────────────── */

const now = Math.floor(Date.now() / 1000);
const WINDOW = { opensAt: String(now - 60), closesAt: String(now + 3_600) };

const seeded = await (async () => {
  const store = new FileStore(process.env.DATA_PATH!);
  store.putUser({
    id: USER, email: 'ada@northwind.example', name: 'ada', keyBundle: null, keyBundleVersion: 0,
    walletKey: walletKeyOf(addressOfSlot(SLOT, NETWORK)), createdAt: '2026-09-23T00:00:00.000Z',
  } as never);
  const accounts = new AccountService(store, ledger, MidnightCommitments, productAssets, aVaultHolding(HELD));
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), productAssets);
  const aCompany = async (name: string, writtenDown: boolean, withdrawn = false) => {
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
    /* Every string that says who is paid: each payee's address, in every field it has but its kind. */
    const addresses = (await payroll.runMaterialInputs(run.id, viewingKey)).facts.flatMap((f) =>
      Object.entries(f.payee).filter(([k, v]) => k !== 'kind' && typeof v === 'string').map(([, v]) => String(v)));
    if (writtenDown) {
      const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
      const material = await runMaterialFor({
        accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
        opensAt: BigInt(WINDOW.opensAt), closesAt: BigInt(WINDOW.closesAt), vault: VAULT, detailsOf: vaultDetails,
      });
      const proposal = await payroll.proposeRun(run.id, viewingKey, created.secrets[0]!.signerId, material, undefined, { onDevice: true });
      if (withdrawn) await accounts.cancel(proposal.id, viewingKey);
    }
    return { account, viewingKey, runId: run.id, signer: created.secrets[0]!.signerId, addresses };
  };
  return {
    /* One company per refusal, so a refusal that failed to refuse cannot turn the next case red for it. */
    noVersion: await aCompany('Noversion', false),
    otherVersion: await aCompany('Otherversion', false),
    mismatch: await aCompany('Mismatch', false),
    notDevice: await aCompany('Notdevice', false),
    raised: await aCompany('Raised', false),
    written: await aCompany('Written', true),
    sendsOnce: await aCompany('Sendsonce', true),
    withdrawn: await aCompany('Withdrawn', true, true),
  };
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
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { sent.length = 0; });

/* ── what the device would have been handed, and what it would send ─────── */

const legPayments = async (c: { runId: string; viewingKey: string }) => {
  const r = await post(`/api/runs/${c.runId}/leg-payments`, { viewingKey: c.viewingKey });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { asset: string; payments: Array<{ kind: string; token: string; amount: string }> };
};
const digestOf = (payments: Array<{ kind: string; token: string; amount: string }>) =>
  paymentsCheckedDigest(payments);
const raiseBody = (c: { viewingKey: string }, more: Record<string, unknown>) =>
  ({ viewingKey: c.viewingKey, vault: VAULT, ...WINDOW, onDevice: true, ...more });
/** Nothing written down: the leg has no proposal waiting to be sent, and the run is still a draft. */
const nothingWrittenDown = async (c: { account: string; runId: string; viewingKey: string }) => {
  const order = await post(`/api/runs/${c.runId}/raise-order`, { viewingKey: c.viewingKey });
  expect(order.status, JSON.stringify(order.body)).toBe(409);
  const runs = await call('GET', `/api/accounts/${c.account}/runs?viewingKey=${c.viewingKey}`, { token });
  expect(runs.status, JSON.stringify(runs.body)).toBe(200);
  expect((runs.body as Array<{ id: string; status: string }>).find((r) => r.id === c.runId)?.status).toBe('draft');
};

describe('A RAISE FROM A DEVICE NAMES ITS PAGE AND WHAT IT CHECKED', () => {
  it('1. A DEVICE RAISE THAT NAMES NO VERSION IS REFUSED, AND NOTHING IS WRITTEN DOWN', async () => {
    const c = seeded.noVersion;
    const checked = digestOf((await legPayments(c)).payments);
    const r = await post(`/api/runs/${c.runId}/propose`, raiseBody(c, { checked }));
    /* RED WHEN: a device raise with no version is trusted - a page from before the device check raises unchecked. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(/names no version.*Reload the page.*Nothing was written down\./su);
    await nothingWrittenDown(c);
  });

  it('2. A DEVICE RAISE THAT NAMES ANOTHER VERSION IS REFUSED, AND THE REFUSAL SAYS TO RELOAD', async () => {
    const c = seeded.otherVersion;
    const checked = digestOf((await legPayments(c)).payments);
    for (const version of [DEVICE_RAISE_VERSION - 1, DEVICE_RAISE_VERSION + 1, String(DEVICE_RAISE_VERSION)]) {
      const r = await post(`/api/runs/${c.runId}/propose`, raiseBody(c, { checked, version }));
      /* RED WHEN: any version but the current one is accepted - including the right number spelled as a string. */
      expect(r.status, String(version)).toBe(400);
      expect(String(r.body?.error), String(version)).toMatch(/names version .*Reload the page and try again\. Nothing was written down\./su);
    }
    /* RED WHEN: a device raise that names the version but not what it checked is trusted. */
    const unchecked = await post(`/api/runs/${c.runId}/propose`, raiseBody(c, { version: DEVICE_RAISE_VERSION }));
    expect(unchecked.status).toBe(400);
    expect(String(unchecked.body?.error)).toMatch(/does not say which payments the device checked/u);
    await nothingWrittenDown(c);
  });

  it('5. A RAISE WHOSE CHECKED PAYMENTS ARE NOT WHAT THE SERVICE WOULD RAISE IS REFUSED, AND NOTHING IS WRITTEN DOWN', async () => {
    const c = seeded.mismatch;
    const asked = (await legPayments(c)).payments;
    for (const [why, other] of [
      ['one amount different', asked.map((p, i) => (i === 1 ? { ...p, amount: String(BigInt(p.amount) + 1n) } : p))],
      ['one payment fewer', asked.slice(1)],
      ['the same payments in another order', [...asked].reverse()],
      ['one payment of another kind', asked.map((p, i) => (i === 0 ? { ...p, kind: 'unshielded' } : p))],
    ] as const) {
      const r = await post(`/api/runs/${c.runId}/propose`,
        raiseBody(c, { version: DEVICE_RAISE_VERSION, checked: digestOf([...other]) }));
      /* RED WHEN: the service raises its own rebuilt payments without comparing them with what the device checked. */
      expect(r.status, why).toBe(400);
      expect(String(r.body?.error), why).toMatch(/the run changed after this device checked it against the vault.*Nothing was written down\./su);
    }
    await nothingWrittenDown(c);
    expect(sent).toEqual([]);
  });

  it('A RAISE NOT MARKED AS THE DEVICE\'S IS REFUSED FOR ITS PRIVATE MONEY EXACTLY AS BEFORE', async () => {
    const c = seeded.notDevice;
    const checked = digestOf((await legPayments(c)).payments);
    for (const [why, more] of [
      ['a raise that names nothing', {}],
      ['one that names the version and what was checked, but not the device', { version: DEVICE_RAISE_VERSION, checked }],
    ] as const) {
      const r = await post(`/api/runs/${c.runId}/propose`, { viewingKey: c.viewingKey, vault: VAULT, ...WINDOW, ...more });
      /* RED WHEN: the service stops asking about private money a raise not marked as the device's would pay, or the new fields switch that off. */
      expect(r.status, why).toBe(400);
      expect(String(r.body?.error), why).toMatch(
        /(cannot read what a vault holds|what the vault holds of \S+ privately could not be established).*Nothing was raised and no fee was spent\.$/su);
      /* RED WHEN: a raise not marked as the device's is refused by a device-raise check instead. */
      expect(String(r.body?.error), why).not.toMatch(/out of date|does not say which payments|the run changed after this device checked it/u);
    }
    await nothingWrittenDown(c);
  });

  it('7. THE ORDINARY PATH, THROUGH THE PAGE\'S OWN MODULE, STILL RAISES AND SENDS, AND NOTHING SENT CARRIES AN ADDRESS, A NOTE OR A BALANCE', async () => {
    const c = seeded.raised;
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const api = async (path: string, init?: RequestInit) => {
      if (init?.body) bodies.push({ path: path.replace(c.runId, ':run').replace(/prp_[A-Za-z0-9_-]+/u, ':proposal'), body: JSON.parse(String(init.body)) });
      const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body?.error ?? `request failed: ${r.status}`), body);
      return body;
    };
    const holdings = aVaultHolding(HELD);
    const done = await device.raiseRunOnDevice({
      service: { ...device.governedCallServiceFor(api), callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }) },
      builder: { governedCall: async ({ order }) => ({ tx: Buffer.from(JSON.stringify({ signer: c.signer, order })).toString('base64') }) },
      material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
      accountId: c.account, holdings, sleep: async () => {}, waitMs: 40, everyMs: 1,
    }, { runId: c.runId, viewingKey: c.viewingKey, vault: VAULT, ...WINDOW });
    /* RED WHEN: the version or the digest the page sends is not the one the service accepts - the ordinary raise is then refused. */
    expect(done.raisedAt).toBeDefined();
    expect(sent).toEqual(['propose']);
    /* RED WHEN: a route gains a field - above all one carrying who is paid, a note or what the vault holds. */
    const KEYS: Record<string, string[]> = {
      '/api/runs/:run/leg-payments': ['viewingKey'],
      '/api/runs/:run/propose': ['checked', 'closesAt', 'onDevice', 'opensAt', 'vault', 'version', 'viewingKey'],
      '/api/runs/:run/raise-send': ['checked', 'tx', 'version', 'viewingKey'],
      '/api/proposals/:proposal/standing': ['viewingKey'],
    };
    for (const b of bodies) expect(Object.keys(b.body).sort(), b.path).toEqual(KEYS[b.path]);
    const paths = bodies.map((b) => b.path);
    /* RED WHEN: the device stops checking again right before the send. */
    expect(paths.slice(0, 4)).toEqual([
      '/api/runs/:run/leg-payments', '/api/runs/:run/propose', '/api/runs/:run/leg-payments', '/api/runs/:run/raise-send',
    ]);
    /* The proven transaction is the stand-in builder's base64, so it is read apart from the words searched for below. */
    const everything = JSON.stringify(bodies.map((b) => ({ ...b, body: { ...b.body, tx: undefined } })));
    const txs = bodies.flatMap((b) => (typeof b.body.tx === 'string' ? [Buffer.from(b.body.tx, 'base64').toString('utf8')] : []));
    expect(txs).toHaveLength(1);
    for (const a of c.addresses) expect(txs[0]).not.toContain(a);
    expect(txs[0]).not.toContain(HELD.toString());
    expect(c.addresses.length).toBeGreaterThanOrEqual(3);
    for (const a of c.addresses) expect(everything).not.toContain(a);
    expect(everything).not.toContain(HELD.toString());
    expect(everything).not.toMatch(/notes|nonce|pool|balance|held|address/u);
    expect(holdings.reads.length).toBeGreaterThan(0);
  });
});

describe('A SEND FROM A DEVICE NAMES ITS PAGE AND WHAT IT CHECKED', () => {
  const send = (c: { runId: string; viewingKey: string }, more: Record<string, unknown>) =>
    post(`/api/runs/${c.runId}/raise-send`, { viewingKey: c.viewingKey, tx: Buffer.from('{}').toString('base64'), ...more });

  it('3. A SEND THAT NAMES NO VERSION, OR ANOTHER, IS REFUSED, AND NOTHING IS SENT', async () => {
    const c = seeded.written;
    const checked = digestOf((await legPayments(c)).payments);
    for (const [why, more] of [
      ['no version', { checked }],
      ['the version before', { checked, version: DEVICE_RAISE_VERSION - 1 }],
      ['a version after', { checked, version: DEVICE_RAISE_VERSION + 1 }],
      ['the right number spelled as a string', { checked, version: String(DEVICE_RAISE_VERSION) }],
    ] as const) {
      const r = await send(c, more);
      /* RED WHEN: a send from a page that may not have checked the vault is sent. */
      expect(r.status, why).toBe(422);
      expect(r.body?.nothingWasSent, why).toBe(true);
      expect(String(r.body?.error), why).toMatch(/Reload the page and try again\. Nothing was sent\./u);
    }
    expect(sent).toEqual([]);
  });

  it('6. A SEND WHOSE CHECKED PAYMENTS ARE NOT THE WRITTEN-DOWN PROPOSAL\'S IS REFUSED, AND NOTHING IS SENT', async () => {
    const c = seeded.written;
    const asked = (await legPayments(c)).payments;
    for (const [why, checked] of [
      ['one amount different', digestOf(asked.map((p, i) => (i === 2 ? { ...p, amount: '1' } : p)))],
      ['no digest at all', undefined],
    ] as const) {
      const r = await send(c, { version: DEVICE_RAISE_VERSION, ...(checked === undefined ? {} : { checked }) });
      /* RED WHEN: the service sends the proposal it wrote down without comparing it with what the device just checked. */
      expect(r.status, why).toBe(422);
      expect(r.body?.nothingWasSent, why).toBe(true);
      expect(String(r.body?.error), why).toMatch(/is not what this device checked against the vault just now.*Nothing was sent\./su);
    }
    expect(sent).toEqual([]);
  });

  it('A LEG WITH A PROPOSAL WRITTEN DOWN IS HANDED OVER AS WRITTEN, AND A SEND OF EXACTLY THAT GOES OUT', async () => {
    const c = seeded.sendsOnce;
    const asked = await legPayments(c);
    const r = await post(`/api/runs/${c.runId}/raise-order`, { viewingKey: c.viewingKey });
    expect(r.status).toBe(200);
    /* RED WHEN: the route that hands the order over starts carrying the payments, or anything about who is paid. */
    expect(Object.keys(r.body).sort()).toEqual(['chainId', 'order', 'paymentsChecked', 'proposalId']);
    /* RED WHEN: the digest the order carries is not the digest of what the device is handed to check - the device then refuses a good send. */
    expect(r.body.paymentsChecked).toBe(digestOf(asked.payments));
    const built = Buffer.from(JSON.stringify({ signer: c.signer, order: r.body.order })).toString('base64');
    const ok = await post(`/api/runs/${c.runId}/raise-send`, {
      viewingKey: c.viewingKey, tx: built, version: DEVICE_RAISE_VERSION, checked: digestOf(asked.payments),
    });
    /* RED WHEN: the digest of what the device is handed for a written-down leg is not the written-down proposal's. */
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(sent).toEqual(['propose']);
  });

  it('A SEND OF A WITHDRAWN PROPOSAL IS REFUSED AS WITHDRAWN, NOT AS A MISMATCH THAT SENDING AGAIN WOULD MEND', async () => {
    const c = seeded.withdrawn;
    const r = await send(c, { version: DEVICE_RAISE_VERSION, checked: 'ab'.repeat(32) });
    /* RED WHEN: the digest is compared before the proposal's own standing is asked - the person is told to send again, and every send again is refused the same way. */
    expect(r.status).toBe(422);
    expect(r.body?.nothingWasSent).toBe(true);
    expect(String(r.body?.error)).toMatch(/this proposal is cancelled, so it is not sent to the chain\. Nothing was sent\./u);
    expect(sent).toEqual([]);
  });

  it('A DEVICE RAISE OF A LEG ALREADY WRITTEN DOWN IS REFUSED AS ALREADY PROPOSED, NOT AS A MISMATCH THAT RAISING AGAIN WOULD MEND', async () => {
    const c = seeded.written;
    const r = await post(`/api/runs/${c.runId}/propose`, raiseBody(c, { version: DEVICE_RAISE_VERSION, checked: 'ab'.repeat(32) }));
    /* RED WHEN: the digest is compared before the leg is asked whether it is already proposed. */
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(/is already proposed, as prp_/u);
    expect(String(r.body?.error)).not.toMatch(/the run changed after this device checked it/u);
  });
});

describe('WHAT A LEG PAYS IS HANDED ONLY TO A MEMBER, FOR A RUN OF THEIR OWN, IN THE ONE SHAPE A DEVICE CHECKS', () => {
  it('answers a member with each payment\'s kind, token and amount, and nothing else', async () => {
    const c = seeded.raised;
    const r = await post(`/api/runs/${c.runId}/leg-payments`, { viewingKey: c.viewingKey });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    /* RED WHEN: the answer gains a field - above all who is paid - or loses one a device checks. */
    expect(Object.keys(r.body).sort()).toEqual(['asset', 'payments']);
    expect(r.body.payments).toHaveLength(3);
    for (const p of r.body.payments) {
      expect(Object.keys(p).sort()).toEqual(['amount', 'kind', 'token']);
      expect(p.amount).toMatch(/^[0-9]+$/u);
    }
    for (const a of c.addresses) expect(JSON.stringify(r.body)).not.toContain(a);
  });

  it('refuses nobody signed in, a body it does not know, a run that is not theirs, and a key that does not open the run', async () => {
    const c = seeded.raised;
    const path = `/api/runs/${c.runId}/leg-payments`;
    /* RED WHEN: the route answers without a sign-in. */
    expect((await call('POST', path, { body: { viewingKey: c.viewingKey } })).status).toBe(401);
    /* RED WHEN: a body carrying a field this route does not read is accepted rather than refused. */
    expect((await post(path, { viewingKey: c.viewingKey, notes: [] })).status).toBe(400);
    expect((await post(path, {})).status).toBe(400);
    expect((await post(path, { viewingKey: c.viewingKey, asset: '' })).status).toBe(400);
    /* RED WHEN: a signed-in person who is not a member of the run's company is answered. */
    const stranger = await signInWithAWallet(call, { slot: SLOT + 1, origin: ORIGIN, network: NETWORK });
    const theirs = await call('POST', path, { token: stranger.token, body: { viewingKey: c.viewingKey } });
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body)).not.toMatch(/amount|token|kind/u);
    expect((await post('/api/runs/run_nowhere/leg-payments', { viewingKey: c.viewingKey })).status).toBe(404);
    /* RED WHEN: a key that does not open the run is answered with anything but a refusal. */
    const wrongKey = await post(path, { viewingKey: 'ff'.repeat(32) });
    expect(wrongKey.status).toBeGreaterThanOrEqual(400);
    expect(wrongKey.body?.payments).toBeUndefined();
  });
});
