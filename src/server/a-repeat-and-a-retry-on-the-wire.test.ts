/**
 * **THE TWO PAYROLL DOORS THIS CHANGE ADDS OR WIDENS, DRIVEN OVER HTTP.**
 *
 * The service holds the rules; what only a route can get wrong is the wire:
 *
 *   - a repeated ad hoc run is refused with the sentence the service writes,
 *     and a confirmed one is recorded under the SIGNED-IN caller's name, never
 *     under whatever name the request carries
 *   - the retry door exists, refuses a leg that has not been raised, and will
 *     not take a request that names nobody to pay
 *
 * **DRIVEN OVER A TEST DOUBLE, AND SAID HERE SO NOBODY READS THESE CASES AS
 * EVIDENCE ABOUT A CHAIN.** Nothing here raises a round.
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
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-repeat-wire-')), 'db.json');

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');
const { openRecord } = await import('../core/sealed-records.js');
const { networkOfThePair } = await import('../midnight/network.js');
const NETWORK = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);

const identity = identityFromWords(TEST_MNEMONIC);
const addressOf = (slot: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({
    tag: 'schnorr',
    value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
  }).value, NETWORK);

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

type Res = { status: number; body: any };

const call = async (
  method: string, path: string, opts: { token?: string; body?: unknown } = {},
): Promise<Res> => {
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

const signedIn = async (slot: number): Promise<{ token: string; name: string; id: string }> => {
  const asked = await call('POST', '/api/auth/wallet/challenge');
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  const response = mint(identity, slot, {
    origin: ORIGIN,
    nonce: asked.body.nonce,
    address: addressOf(slot),
    at: Date.now(),
    disclosed: [],
    declined: [],
    requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
  }).response;
  const inHere = await call('POST', '/api/auth/wallet', {
    body: { handle: asked.body.handle, nonce: asked.body.nonce, response },
  });
  expect(inHere.status, JSON.stringify(inHere.body)).toBe(200);
  const user = inHere.body.session.user ?? inHere.body.user ?? {};
  return { token: inHere.body.session.token as string, name: String(user.name ?? ''), id: String(user.id ?? '') };
};

const aCompany = async (token: string) => {
  const made = await call('POST', '/api/accounts', {
    token,
    body: { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { accountId: made.body.account.id as string, viewingKey: made.body.viewingKey as string };
};

const PEOPLE = [{ name: 'Nina', asset: 'GBP', amount: '1000' }];

describe('a repeated ad hoc run, over the wire', () => {
  it('is refused, then recorded under the signed-in caller when confirmed, whatever name the body carries',
    async () => {
      const me = await signedIn(21);
      const { accountId, viewingKey } = await aCompany(me.token);
      const first = await call('POST', `/api/accounts/${accountId}/payroll`, {
        token: me.token, body: { period: '2026-07', viewingKey, employees: PEOPLE },
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const firstId = first.body.run.id as string;

      const again = await call('POST', `/api/accounts/${accountId}/payroll`, {
        token: me.token, body: { period: '2026-07', viewingKey, employees: PEOPLE },
      });
      /* RED WHEN the route stops handing the service a way to refuse a repeat. */
      expect(again.status).toBe(400);
      expect(again.body.error).toContain(`as run ${firstId}`);

      const confirmed = await call('POST', `/api/accounts/${accountId}/payroll`, {
        token: me.token,
        body: {
          period: '2026-07', viewingKey, employees: PEOPLE,
          repeats: { runIds: [firstId], reason: 'bonus', by: 'Somebody Else' },
        },
      });
      /* RED WHEN the route does not carry the confirmation to the service. */
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      const listed = await call('GET', `/api/accounts/${accountId}/runs`, { token: me.token });
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const sealed = (listed.body as any[]).find(r => r.id === confirmed.body.run.id);
      const record = openRecord<any>('payroll', accountId, sealed.sealed, viewingKey as never).repeats;
      expect(record.of).toEqual([firstId]);
      /* RED WHEN the name on the record is taken from the request body. */
      expect(record.by).not.toBe('Somebody Else');
      expect(record.by.length).toBeGreaterThan(0);
    });
});

describe('the retry door, over the wire', () => {
  it('refuses a leg that has not been raised, and a request that names nobody', async () => {
    const me = await signedIn(22);
    const { accountId, viewingKey } = await aCompany(me.token);
    const made = await call('POST', `/api/accounts/${accountId}/payroll`, {
      token: me.token, body: { period: '2026-08', viewingKey, employees: PEOPLE },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const runId = made.body.run.id as string;
    const window = { vault: 'b'.repeat(64), opensAt: '1000', closesAt: '2000' };

    const unraised = await call('POST', `/api/runs/${runId}/retry`, {
      token: me.token, body: { viewingKey, indices: [0], ...window },
    });
    /* RED WHEN the route is missing, or builds material for a leg with no approved round. */
    expect(unraised.status, JSON.stringify(unraised.body)).toBe(400);
    expect(unraised.body.error).toMatch(/has not been raised, so there is nobody on it to retry/);

    const nobody = await call('POST', `/api/runs/${runId}/retry`, {
      token: me.token, body: { viewingKey, indices: [], ...window },
    });
    /* RED WHEN a retry naming nobody reaches the service. */
    expect(nobody.status).toBe(400);
    expect(JSON.stringify(nobody.body)).toMatch(/indices/);
  });
});
