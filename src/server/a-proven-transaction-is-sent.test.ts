/**
 * **THE ROUTE A SIGNER'S DEVICE SENDS A PROVEN TRANSACTION TO.**
 *
 * Driven over a test double, and said here so nobody reads these cases as
 * evidence about a chain: the ledger under the route is the simulated one with
 * a recording `submitProven` added. What is under test is who reaches the
 * ledger, what it is handed, and whether the answer says anything was sent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-proven-')), 'db.json');

const ORIGIN = 'https://payroll.example';

type Mode = 'absent' | 'sends' | 'refuses' | 'fails';
let mode: Mode = 'sends';
const sent: Array<{ accountId: string; bytes: number[] }> = [];

const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { NothingWasSent } = await import('../core/jobs.js');
const { handInWiring } = await import('../wiring/handed-in.js');

const submitProven = async (accountId: string, bytes: Uint8Array) => {
  sent.push({ accountId, bytes: [...bytes] });
  if (mode === 'refuses') throw new NothingWasSent('the fee payer refused: over the ceiling');
  if (mode === 'fails') throw new Error('the node closed the socket');
  return { ref: 'ref-proven', at: '' };
};

handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => {
    const inner = new SimulatedLedger(SimulatedCommitments);
    return new Proxy(inner, {
      get: (t, prop, recv) => {
        if (prop === 'submitProven') return mode === 'absent' ? undefined : submitProven;
        const v = Reflect.get(t, prop, recv);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  },
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');
const { theNetwork } = await import('../midnight/network.js');
const NETWORK = theNetwork();

const identity = identityFromWords(TEST_MNEMONIC);
const addressOf = (slot: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({
    tag: 'schnorr',
    value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
  }).value, NETWORK);

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

type Res = { status: number; body: any };

const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> => {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const signedIn = async (slot: number): Promise<string> => {
  const asked = await call('POST', '/api/auth/wallet/challenge');
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  const response = mint(identity, slot, {
    origin: ORIGIN, nonce: asked.body.nonce, address: addressOf(slot), at: Date.now(),
    disclosed: [], declined: [], requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
  }).response;
  const inHere = await call('POST', '/api/auth/wallet', {
    body: { handle: asked.body.handle, nonce: asked.body.nonce, response },
  });
  expect(inHere.status, JSON.stringify(inHere.body)).toBe(200);
  return inHere.body.session.token as string;
};

const aCompany = async (token: string): Promise<string> => {
  const made = await call('POST', '/api/accounts', {
    token,
    body: { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body.account.id as string;
};

const TX = Buffer.from([7, 8, 9]).toString('base64');

describe('POST /api/accounts/:id/proven', () => {
  /* RED WHEN: the route stops handing the ledger the account and the exact bytes, or answers without the reference. */
  it('hands a member\'s proven transaction to the ledger and answers its reference', async () => {
    mode = 'sends';
    sent.length = 0;
    const token = await signedIn(21);
    const id = await aCompany(token);
    const res = await call('POST', `/api/accounts/${id}/proven`, { token, body: { tx: TX } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ txRef: 'ref-proven' });
    expect(sent).toEqual([{ accountId: id, bytes: [7, 8, 9] }]);
  });

  /* RED WHEN: `authed` or `member` is dropped from the route, so anybody can make us pay for a transaction. */
  it('nobody else reaches the ledger', async () => {
    mode = 'sends';
    const owner = await signedIn(22);
    const id = await aCompany(owner);
    const stranger = await signedIn(23);
    sent.length = 0;
    const theirs = await call('POST', `/api/accounts/${id}/proven`, { token: stranger, body: { tx: TX } });
    expect(theirs.status).toBe(404);
    const nobody = await call('POST', `/api/accounts/${id}/proven`, { body: { tx: TX } });
    expect(nobody.status).toBe(401);
    expect(sent, 'a caller who is not a member reached the ledger').toEqual([]);
  });

  /* RED WHEN: a refusal loses its mark, or a failed submission is reported as nothing sent. */
  it('says whether anything was sent', async () => {
    const token = await signedIn(24);
    const id = await aCompany(token);

    mode = 'refuses';
    const refused = await call('POST', `/api/accounts/${id}/proven`, { token, body: { tx: TX } });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ nothingWasSent: true, error: 'the fee payer refused: over the ceiling' });

    mode = 'fails';
    const failed = await call('POST', `/api/accounts/${id}/proven`, { token, body: { tx: TX } });
    expect(failed.status).toBe(502);
    expect(failed.body.nothingWasSent, 'a submission that may have landed was called nothing sent').toBe(false);
  });

  /* RED WHEN: a missing transaction, or a ledger that cannot send, is answered as anything but nothing sent. */
  it('refuses, as nothing sent, what it cannot send', async () => {
    const token = await signedIn(25);
    const id = await aCompany(token);
    mode = 'sends';
    sent.length = 0;
    const empty = await call('POST', `/api/accounts/${id}/proven`, { token, body: {} });
    expect(empty.status).toBe(400);
    expect(empty.body.nothingWasSent).toBe(true);
    /* Just over what the route takes, and still under what the body parser takes. */
    const large = await call('POST', `/api/accounts/${id}/proven`, { token, body: { tx: 'A'.repeat(1_000_001) } });
    expect(large.status).toBe(400);
    expect(large.body.nothingWasSent).toBe(true);
    mode = 'absent';
    const unable = await call('POST', `/api/accounts/${id}/proven`, { token, body: { tx: TX } });
    expect(unable.status).toBe(503);
    expect(unable.body.nothingWasSent).toBe(true);
    expect(sent).toEqual([]);
    mode = 'sends';
  });
});
