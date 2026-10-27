import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { importTheServer, useOnlyTheseSettings } from '../testing/server-under-test.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { newWords } from 'midnight-identity';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { User } from '../core/types.js';

import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
/**
 * **A COMPANY'S PAYSLIPS FOR A MONTH OVER THE WIRE: EVERY SLIP, AS CIPHERTEXT,
 * TO ANYBODY SIGNED IN, AND NO ROUTE TAKES OR NAMES A PAYSLIP KEY.** The payee's
 * device tries each slip with its own key; the service never learns which one
 * opened, or whose key any slip is sealed to.
 *
 * The store is written first by the product's own services, the way a company
 * would have filled it, and then the server is started on it and asked only
 * through its routes.
 */

const DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-payslips-')), 'db.json');
useOnlyTheseSettings({
  ALLOW_MEMORY_SESSIONS: '1',
  DATABASE_URL: '',
  SERVE: '0',
  APP_ORIGIN: 'https://payroll.example',
  DATA_PATH: DATA_PATH,
});
const ORIGIN = 'https://payroll.example';

const { FileStore } = await import('../core/store-file.js');
const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService, RecordingInviteDelivery } = await import('../core/payroll.js');
const { payslipKeypairForWallet } = await import('../core/payslip-key.js');
const { sealHandover } = await import('../core/invite-handover.js');
const { openPayslip, NOT_YOUR_PAYSLIP } = await import('../core/payslip-open.js');
const { payeeFor } = await import('../testing/payees.js');
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
    store, accounts, undefined, 'undeployed', invites);
  const { account, viewingKey } = await accounts.create(
    'Acme', [{ name: 'Ada', role: 'admin' as const }], 1, undefined, drawCompanyLabel());
  const rec = accounts.require(account.id);
  store.putAccount({ ...rec, addressSource: 'chain' } as typeof rec);
  const address = (rec.contractAddress as string).toLowerCase();
  const label = rec.companyLabel!;
  const hire = (who: string, byte: string) => {
    const email = `${who.toLowerCase()}@acme.example`;
    const { sentTo, employee } = payroll.invite(account.id, {
      name: who, email, title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 5_000_000_000n,
    }, viewingKey, 'usr_ada');
    const keys = payslipKeypairForWallet(newWords(), label, ORIGIN);
    const userId = 'usr_' + who.toLowerCase();
    store.putUser({
      id: userId, email, name: who, keyBundle: null, keyBundleVersion: 0, walletKey: null,
      createdAt: '2026-09-24T00:00:00.000Z',
    } as User);
    payroll.acceptInvite(invites.tokenFor(sentTo!), sealHandover({
      wrappingPublicKey: keys.publicKey, address: payeeFor(byte.repeat(32), 'undeployed').bech32,
      confirmation: null, keyFrom: label,
    }, rec.inboxPublicKey), userId);
    payroll.admit(employee.id, viewingKey, 'usr_ada');
    return { ...keys, employeeId: employee.id };
  };
  const dana = hire('Dana', 'a1');
  const eli = hire('Eli', 'b2');
  const { run } = await payroll.createRunFromRoster(account.id, '2026-08', viewingKey);
  return { dana, eli, address, label, runId: run.id, accountId: account.id };
})();

const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});
const { app } = await importTheServer();

let server: Server;
let base: string;
/* A signed-in person. The payslip routes answer nobody else. */
let token = '';
beforeAll(async () => {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
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

const MONTH = '2026-08';
const listed = (company: string, period: string, how: Parameters<typeof asked>[0] = {}) =>
  get(`/api/payslips?company=${encodeURIComponent(company)}&period=${encodeURIComponent(period)}`, how);

describe('a company\'s payslips for a month, over the wire', () => {
  it('EVERY SLIP OF THE MONTH IS SENT SEALED, AND EACH PAYEE OPENS ONLY THEIR OWN', async () => {
    const r = await listed(seeded.label, MONTH);
    expect(r.status).toBe(200);
    const got = await r.json();
    /* RED WHEN the route hands over anything but every slip of the company's runs for the month. */
    expect(got).toHaveLength(2);
    /* RED WHEN a slip comes back naming a person, the key it is sealed to or the label it names, beside the seal. */
    for (const slip of got) {
      expect(Object.keys(slip).sort()).toEqual(['period', 'receipt', 'runId', 'settledAt', 'slip', 'status', 'wiring', 'wrapped']);
    }
    const wire = JSON.stringify(got).toLowerCase();
    for (const value of ['Dana', 'Eli', '5000000000', seeded.dana.employeeId, seeded.eli.employeeId, seeded.dana.publicKey, seeded.eli.publicKey, seeded.label]) {
      expect(wire).not.toContain(value.toLowerCase());
    }
    const tried = (secret: string) => got.flatMap((g: Parameters<typeof openPayslip>[0]) => {
      try { return [openPayslip(g, secret)]; } catch (e) { if ((e as Error).message !== NOT_YOUR_PAYSLIP) throw e; return []; }
    });
    const [dana] = tried(seeded.dana.secret);
    expect(tried(seeded.dana.secret)).toHaveLength(1);
    expect(tried(seeded.eli.secret).map((s: { payslip: { name: string } }) => s.payslip.name)).toEqual(['Eli']);
    expect(tried(payslipKeypairForWallet(newWords(), seeded.label, ORIGIN).secret)).toEqual([]);
    expect(dana.payslip.name).toBe('Dana');
    expect(dana.payslip.amount).toBe(5_000_000_000n);
    expect(dana.payslip.asset).toBe(TEST_SETTLEMENT_ASSET);
    expect(dana.runId).toBe(seeded.runId);
    /* RED WHEN the label a slip names is taken from anywhere but inside its seal. */
    expect(dana.issuedBy).toBe(seeded.label);
    /*
     * The run's own facts come back as the store holds them. RED WHEN the
     * route reports a run as settled, or as written by a chain, that is not.
     */
    const stored = JSON.parse(readFileSync(DATA_PATH, 'utf8')).runs[seeded.runId];
    expect(dana.status).toBe(stored.status);
    expect(dana.status).toBe('draft');
    expect(dana.settledAt).toBe(stored.settledAt ?? null);
    expect(dana.wiring).toBe(stored.wiring ?? null);
  });

  it('A MONTH WITH NO RUN OR A LABEL NO COMPANY CARRIES LISTS NOTHING, AND A LABEL OR MONTH NOT WRITTEN AS ONE IS REFUSED', async () => {
    /* RED WHEN slips of another month are sent. */
    expect(await (await listed(seeded.label, '2026-09')).json()).toEqual([]);
    /* RED WHEN slips are sent for a label this company does not carry. */
    expect(await (await listed('co_' + 'ef'.repeat(32), MONTH)).json()).toEqual([]);
    /* RED WHEN an account's address is taken where the label belongs, or a month is taken that is not written as one. */
    expect((await listed(seeded.address, MONTH)).status).toBe(400);
    expect((await listed(seeded.label, 'August')).status).toBe(400);
    expect((await listed(seeded.label, '2026-8')).status).toBe(400);
    expect((await get(`/api/payslips?company=${seeded.label}`)).status).toBe(400);
  });

  it('THE ROUTES THAT TOOK A PAYSLIP KEY ARE GONE, FOR ANY KEY', async () => {
    for (const path of ['/api/payslips/proof', '/api/payslips']) {
      const r = await post(path, { publicKey: seeded.dana.publicKey, answer: '00'.repeat(32), from: seeded.label });
      /* RED WHEN a route that takes a payslip key in the clear is back. */
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body ?? '')).not.toContain('sealed');
    }
  });

  it('THE ROUTE THAT TOOK A SECRET IN ITS ADDRESS IS GONE: IT SAYS NOTHING ABOUT A RUN OR A PERSON, TO ANYBODY', async () => {
    for (const [runId, employeeId] of [[seeded.runId, seeded.dana.employeeId], ['run_nobody', 'emp_nobody']]) {
      const r = await fetch(`${base}/api/runs/${runId}/employee/${employeeId}?secret=${seeded.dana.secret}`);
      /* RED WHEN the route is back, answering for a run and person that exist differently from ones that do not. */
      expect(r.status).toBe(404);
      const text = await r.text();
      expect(text).not.toContain('Dana');
      expect(text).not.toContain(seeded.dana.secret);
      expect(text).not.toContain('payslips-open-in-your-browser');
    }
  });

  it('A COMPANY\'S LABEL, ASKED BY ITS LABEL, WITH THE ACCOUNT THAT CARRIES IT', async () => {
    const r = await get(`/api/payslips/addresses?company=${seeded.label}`);
    expect(r.status).toBe(200);
    expect((await r.json()).companies).toEqual([{ label: seeded.label, account: seeded.address }]);
    expect((await (await get(`/api/payslips/addresses?company=co_${'ef'.repeat(32)}`)).json()).companies).toEqual([]);
    expect((await get('/api/payslips/addresses?company=nope')).status).toBe(400);
    /* RED WHEN an account's address is taken for a company's label. */
    expect((await get(`/api/payslips/addresses?company=${seeded.address}`)).status).toBe(400);
  });

  it('NO PAYSLIP ROUTE ANSWERS WITHOUT A SIGN-IN', async () => {
    /* RED WHEN `authed` is taken off the list route. */
    const list = await listed(seeded.label, MONTH, { signedIn: false });
    expect(list.status).toBe(401);
    expect(await list.json()).not.toBeInstanceOf(Array);
    /* RED WHEN `authed` is taken off the addresses route. */
    const addresses = await get(`/api/payslips/addresses?company=${seeded.label}`, { signedIn: false });
    expect(addresses.status).toBe(401);
    expect(await addresses.json()).not.toHaveProperty('companies');
  });

  it('A PAGE OLDER THAN THESE ROUTES IS TOLD, WORD FOR WORD, TO RELOAD', async () => {
    /* The pages from before sent no sign-in, no page header, or the version that asked by a payslip key. */
    for (const how of [{ signedIn: false, page: null }, { signedIn: true, page: null }, { page: '0' }, { page: '1' }] as const) {
      const list = await listed(seeded.label, MONTH, how);
      /* RED WHEN the check is dropped (401 or 200 instead) or the sentence changes. */
      expect(list.status).toBe(409);
      expect(await list.json()).toEqual({ code: 'payslip-page-out-of-date', error: PAGE_OUT_OF_DATE });
    }
    expect(PAGE_OUT_OF_DATE).toBe('This page is out of date. Reload it and open your payslips again.');
    const addresses = await get(`/api/payslips/addresses?company=${seeded.label}`, { page: null });
    expect((await addresses.json()).error).toBe(PAGE_OUT_OF_DATE);
  });

  it('THE ROUTE THAT RELAYED A COMPANY\'S COMPLETED PAYMENTS ANSWERS NOTHING', async () => {
    /* RED WHEN it is put back: it answered 200 with `{ known, movements }`. */
    const r = await get(`/api/payslips/paid?company=${seeded.label}`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('movements');
  });

  it('THE PAYSLIP DOORS ARE METERED BY WHERE THE REQUEST COMES FROM (LAST: IT SPENDS THE BUDGET)', async () => {
    /* The clock is held in the middle of one fifteen-minute window, so the count cannot start
     * again half way through because a window happened to end while this ran. */
    const WINDOW = 15 * 60 * 1000;
    let middle = Math.floor(Date.now() / WINDOW) * WINDOW + WINDOW / 2;
    if (middle < Date.now()) middle += WINDOW;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(middle);
    try {
      let status = 200;
      let calls = 0;
      while (status !== 429 && calls < 200) {
        calls += 1;
        status = (await get(`/api/payslips/addresses?company=${seeded.label}`)).status;
      }
      /* RED WHEN the routes are not metered: two hundred answers and no refusal. */
      expect(status).toBe(429);
      expect(calls).toBeLessThanOrEqual(61);
      expect((await listed(seeded.label, MONTH)).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});
