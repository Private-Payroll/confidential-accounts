import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { newWords } from 'midnight-identity';
import type { User } from '../core/types.js';

/**
 * **A PAYEE'S PAYSLIPS OVER THE WIRE: TO A SIGNED-IN HOLDER OF THE KEY, AS
 * CIPHERTEXT, AND NO ROUTE TAKES THE KEY.**
 *
 * The store is written first by the product's own services, the way a company
 * would have filled it, and then the server is started on it and asked only
 * through its routes.
 */

process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
const DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-payslips-')), 'db.json');
process.env.DATA_PATH = DATA_PATH;
const ORIGIN = 'https://payroll.example';

const { FileStore } = await import('../core/store-file.js');
const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService, RecordingInviteDelivery } = await import('../core/payroll.js');
const { payslipKeypairForWallet } = await import('../core/payslip-key.js');
const { sealHandover } = await import('../core/invite-handover.js');
const { openPayslip, answerPayslipProof, NOT_YOUR_PAYSLIP } = await import('../core/payslip-open.js');
const { unwrapKey } = await import('../core/crypto.js');
const { payeeFor } = await import('../testing/payees.js');
const { paymentWords } = await import('../web/YourPay.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { PAGE_OUT_OF_DATE, PAYSLIP_PAGE_HEADER, PAYSLIP_PAGE_VERSION } = await import('../core/payslip-page.js');

/* ── the company, written before the server starts ──────────────────── */
const seeded = await (async () => {
  const store = new FileStore(DATA_PATH);
  const accounts = new AccountService(
    store, new SimulatedLedger(SimulatedCommitments), SimulatedCommitments, undefined, aVaultHolding());
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(
    store, accounts, new SimulatedProofSystem(), undefined, 'undeployed', invites);
  const { account, viewingKey } = await accounts.create(
    'Acme', [{ name: 'Ada', role: 'admin' as const }], 1);
  const rec = accounts.require(account.id);
  store.putAccount({ ...rec, addressSource: 'chain' } as typeof rec);
  const address = (rec.contractAddress as string).toLowerCase();
  const hire = (who: string, byte: string) => {
    const email = `${who.toLowerCase()}@acme.example`;
    const { sentTo, employee } = payroll.invite(account.id, {
      name: who, email, title: 'Engineer', asset: 'TESTUSD', baseAmount: 5_000_000_000n,
    }, viewingKey, 'usr_ada');
    const keys = payslipKeypairForWallet(newWords(), address, ORIGIN);
    const userId = 'usr_' + who.toLowerCase();
    store.putUser({
      id: userId, email, name: who, keyBundle: null, keyBundleVersion: 0, walletKey: null,
      createdAt: '2026-09-24T00:00:00.000Z',
    } as User);
    payroll.acceptInvite(invites.tokenFor(sentTo!), sealHandover({
      wrappingPublicKey: keys.publicKey, address: payeeFor(byte.repeat(32), 'undeployed').bech32,
      confirmation: null, keyFrom: address,
    }, rec.inboxPublicKey), userId);
    payroll.admit(employee.id, viewingKey, 'usr_ada');
    return { ...keys, employeeId: employee.id };
  };
  const dana = hire('Dana', 'a1');
  const eli = hire('Eli', 'b2');
  const { run } = await payroll.createRunFromRoster(account.id, '2026-08', viewingKey);
  return { dana, eli, address, runId: run.id, accountId: account.id };
})();

const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});
const { app } = await import('./index.js');

let server: Server;
let base: string;
/* A signed-in person. The payslip routes answer nobody else; the key is the second lock. */
let token = '';
beforeAll(async () => {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
  token = (await signInWithAWallet(call, { slot: 7, origin: ORIGIN, network: theNetwork() })).token;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

/* How the current page asks: with its sign-in, naming itself. Either can be left off. */
const asked = (opts: { signedIn?: boolean; page?: string | null } = {}): Record<string, string> => ({
  'content-type': 'application/json',
  ...((opts.signedIn ?? true) ? { authorization: `Bearer ${token}` } : {}),
  ...(opts.page === null ? {} : { [PAYSLIP_PAGE_HEADER]: opts.page ?? PAYSLIP_PAGE_VERSION }),
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const post = async (path: string, body: unknown, how: Parameters<typeof asked>[0] = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: asked(how), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), text: '' };
};
const get = (path: string, how: Parameters<typeof asked>[0] = {}) => fetch(base + path, { headers: asked(how) });

const proveAndFetch = async (
  keys: { secret: string; publicKey: string }, from: string | null = seeded.address,
) => {
  const proof = await post('/api/payslips/proof', { publicKey: keys.publicKey });
  expect(proof.status).toBe(200);
  const answer = answerPayslipProof(proof.body.sealed, keys.secret);
  return post('/api/payslips', { publicKey: keys.publicKey, answer, from });
};

describe('a payee\'s own payslips, over the wire', () => {
  it('THE HOLDER OF THE KEY GETS THEIR OWN SLIPS, SEALED, AND OPENS THEM', async () => {
    const got = await proveAndFetch(seeded.dana);
    expect(got.status).toBe(200);
    /* RED WHEN the route hands over the company's slips rather than this key's. */
    expect(got.body).toHaveLength(1);
    const opened = openPayslip(got.body[0], seeded.dana.secret);
    expect(opened.payslip.name).toBe('Dana');
    expect(opened.payslip.amount).toBe(5_000_000_000n);
    expect(opened.payslip.asset).toBe('TESTUSD');
    expect(opened.runId).toBe(seeded.runId);
    expect(opened.issuedBy).toBe(seeded.address);
    /*
     * The run's own facts come back as the store holds them. RED WHEN the
     * route reports a run as settled, or as written by a chain, that is not.
     */
    const stored = JSON.parse(readFileSync(DATA_PATH, 'utf8')).runs[seeded.runId];
    expect(opened.status).toBe(stored.status);
    expect(opened.status).toBe('draft');
    expect(opened.settledAt).toBe(stored.settledAt ?? null);
    expect(opened.wiring).toBe(stored.wiring ?? null);
    expect(paymentWords(opened)).toEqual({ paid: 'Not sent for approval yet', onChain: 'No' });
    expect(() => openPayslip(got.body[0], seeded.eli.secret)).toThrow(NOT_YOUR_PAYSLIP);
    /* Sealed on the wire: no name, no amount. */
    const wire = JSON.stringify(got.body);
    expect(wire).not.toContain('Dana');
    expect(wire).not.toContain('5000000000');
  });

  it('SOMEBODY WHO ONLY KNOWS A PUBLIC KEY GETS NOTHING', async () => {
    const proof = await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey });
    /* Eli cannot read what was sealed to Dana's key. */
    expect(() => unwrapKey(proof.body.sealed, seeded.eli.secret)).toThrow();
    /* RED WHEN the list route skips the proof. */
    const guessed = await post('/api/payslips', {
      publicKey: seeded.dana.publicKey, answer: '00'.repeat(32), from: seeded.address,
    });
    expect(guessed.status).toBe(403);
    expect(guessed.body).not.toBeInstanceOf(Array);
    /* And a proof for one key does not answer for another. */
    const mine = await post('/api/payslips/proof', { publicKey: seeded.eli.publicKey });
    const answer = answerPayslipProof(mine.body.sealed, seeded.eli.secret);
    const crossed = await post('/api/payslips', { publicKey: seeded.dana.publicKey, answer, from: seeded.address });
    expect(crossed.status).toBe(403);
  });

  it('A PROOF IS SPENT ONCE', async () => {
    const proof = await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey });
    const answer = answerPayslipProof(proof.body.sealed, seeded.dana.secret);
    const from = seeded.address;
    expect((await post('/api/payslips', { publicKey: seeded.dana.publicKey, answer, from })).status).toBe(200);
    /* RED WHEN the value is not consumed. */
    expect((await post('/api/payslips', { publicKey: seeded.dana.publicKey, answer, from })).status).toBe(403);
  });

  it('ASKING ABOUT A KEY NOBODY HOLDS ANSWERS THE SAME WAY, AND LISTS NOTHING', async () => {
    const stranger = payslipKeypairForWallet(newWords(), seeded.address, ORIGIN);
    const proof = await post('/api/payslips/proof', { publicKey: stranger.publicKey });
    const known = await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey });
    expect(proof.status).toBe(200);
    expect(known.status).toBe(200);
    /* RED WHEN the answer for a key with slips differs in any field from one without. */
    expect(Object.keys(proof.body).sort()).toEqual(['expiresAt', 'sealed']);
    expect(Object.keys(known.body).sort()).toEqual(Object.keys(proof.body).sort());
    expect(Object.keys(known.body.sealed).sort()).toEqual(Object.keys(proof.body.sealed).sort());
    const got = await proveAndFetch(stranger);
    expect(got.status).toBe(200);
    expect(got.body).toEqual([]);
  });

  it('THE ROUTE THAT TOOK A SECRET IN ITS ADDRESS NOW REFUSES, AND OPENS NOTHING', async () => {
    const r = await fetch(
      `${base}/api/runs/${seeded.runId}/employee/${seeded.dana.employeeId}?secret=${seeded.dana.secret}`);
    /* RED WHEN it goes on opening slips with the secret it was handed. */
    expect(r.status).toBe(410);
    const text = await r.text();
    expect(text).not.toContain('Dana');
    expect(text).not.toContain(seeded.dana.secret);
    expect(JSON.parse(text).code).toBe('payslips-open-in-your-browser');
  });

  it('EVERY ADDRESS A COMPANY\'S SLIPS NAME, ASKED BY ITS ADDRESS', async () => {
    const r = await get(`/api/payslips/addresses?company=${seeded.address}`);
    expect(r.status).toBe(200);
    expect((await r.json()).addresses).toEqual([seeded.address]);
    expect((await get('/api/payslips/addresses?company=nope')).status).toBe(400);
  });

  it('ONLY SLIPS NAMING THE ADDRESS THE KEY CAME FROM ARE SENT, AND THE ADDRESS MUST BE SAID', async () => {
    /* RED WHEN the list is sent whatever company address the asker names. */
    expect((await proveAndFetch(seeded.dana, 'ef'.repeat(32))).body).toEqual([]);
    /* A key no address produced is sent only slips that name none; Dana's name one. */
    expect((await proveAndFetch(seeded.dana, null)).body).toEqual([]);
    /* RED WHEN the route answers a request that does not say which address the key came from. */
    const proof = await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey });
    const answer = answerPayslipProof(proof.body.sealed, seeded.dana.secret);
    expect((await post('/api/payslips', { publicKey: seeded.dana.publicKey, answer })).status).toBe(400);
  });

  it('NO PAYSLIP ROUTE ANSWERS WITHOUT A SIGN-IN', async () => {
    /* RED WHEN `authed` is taken off the proof route: it would answer 200 with a sealed value. */
    const proof = await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey }, { signedIn: false });
    expect(proof.status).toBe(401);
    expect(proof.body).not.toHaveProperty('sealed');
    /* RED WHEN `authed` is taken off the list route: a proof made signed in would be spent signed out. */
    const made = await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey });
    const answer = answerPayslipProof(made.body.sealed, seeded.dana.secret);
    const list = await post('/api/payslips',
      { publicKey: seeded.dana.publicKey, answer, from: seeded.address }, { signedIn: false });
    expect(list.status).toBe(401);
    expect(list.body).not.toBeInstanceOf(Array);
    /* RED WHEN `authed` is taken off the addresses route. */
    const addresses = await get(`/api/payslips/addresses?company=${seeded.address}`, { signedIn: false });
    expect(addresses.status).toBe(401);
    expect(await addresses.json()).not.toHaveProperty('addresses');
  });

  it('A PAGE OLDER THAN THESE ROUTES IS TOLD, WORD FOR WORD, TO RELOAD', async () => {
    /* The page from before sent no sign-in and no page header. */
    for (const how of [{ signedIn: false, page: null }, { signedIn: true, page: null }, { page: '0' }] as const) {
      const proof = await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey }, how);
      /* RED WHEN the check is dropped (401 or 200 instead) or the sentence changes. */
      expect(proof.status).toBe(409);
      expect(proof.body).toEqual({ code: 'payslip-page-out-of-date', error: PAGE_OUT_OF_DATE });
    }
    expect(PAGE_OUT_OF_DATE).toBe('This page is out of date. Reload it and open your payslips again.');
    const list = await post('/api/payslips',
      { publicKey: seeded.dana.publicKey, answer: '00'.repeat(32), from: seeded.address }, { signedIn: false, page: null });
    expect(list.body.error).toBe(PAGE_OUT_OF_DATE);
    const addresses = await get(`/api/payslips/addresses?company=${seeded.address}`, { page: null });
    expect((await addresses.json()).error).toBe(PAGE_OUT_OF_DATE);
  });

  it('THE ROUTE THAT RELAYED A COMPANY\'S COMPLETED PAYMENTS ANSWERS NOTHING', async () => {
    /* RED WHEN it is put back: it answered 200 with `{ known, movements }`. */
    const r = await get(`/api/payslips/paid?company=${seeded.address}`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('movements');
  });

  it('THE PAYSLIP DOORS ARE METERED BY WHERE THE REQUEST COMES FROM (LAST: IT SPENDS THE BUDGET)', async () => {
    let status = 200;
    let calls = 0;
    while (status !== 429 && calls < 200) {
      calls += 1;
      status = (await get(`/api/payslips/addresses?company=${seeded.address}`)).status;
    }
    /* RED WHEN the routes are not metered: two hundred answers and no refusal. */
    expect(status).toBe(429);
    expect(calls).toBeLessThanOrEqual(61);
    expect((await post('/api/payslips/proof', { publicKey: seeded.dana.publicKey })).status).toBe(429);
  });
});
