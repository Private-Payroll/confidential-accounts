/**
 * **THE HEALTH CHECK SAYS WHEN THE PRODUCT IS WAITING ON A WRITE THAT HAS NOT
 * SETTLED, AND STOPS SAYING `ok` ONCE THAT WRITE IS OVERDUE.**
 *
 * Writes through one fee payer run one at a time. A write that never settles
 * holds every later one, and before this the health check went on answering
 * `ok` over a product that could not open a company. Driven over real HTTP
 * against the server's own route, with a chain ledger whose write is held open
 * by the test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

/* Set BEFORE the import, as every server test does: the module wires itself up at import time. */
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-health-')), 'db.json');

const { SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { ChainLedger } = await import('../wiring/chain.js');
const { handInWiring } = await import('../wiring/handed-in.js');

const OVERDUE_MS = 150;
let letItSettle!: () => void;
const held = new Promise<void>(r => { letItSettle = r; });

const inner: any = {
  wiring: 'chain',
  open: async () => { await held; return { ref: 'tx' }; },
};
const capability: any = {
  maintenanceAuthority: { kind: 'unmaintainable' },
  compiled: { it: 'is here' },
  customer: { coinPublicKey: () => 'x', encryptionPublicKey: () => 'x', balanceOwnLegs: async (t: unknown) => t, release: async () => {} },
  sponsor: {
    addFeeAndFinalise: async (t: unknown) => t, submit: async () => ({ ref: 'tx', at: '' }),
    release: async () => {}, payingFor: () => {}, capacity: async () => ({ dust: 0n, night: 0n }),
  },
  storagePassword: async () => 'not-a-secret: a test literal',
};
const ledger = new ChainLedger(inner, {
  network: 'stagenet', contractAddress: 'bcb61fef',
  indexerUrl: 'https://indexer.example/api/v4/graphql', indexerWsUrl: 'wss://indexer.example/ws',
  nodeUrl: 'https://rpc.example', proverUrl: 'http://prover.invalid:1',
  sealedStateRoot: '/nowhere/.midnight/sealed', privateStateId: 'confidential-accounts-stagenet',
  zkConfigPath: '/nowhere/contracts/managed',
  vaultZkConfigPath: '/nowhere/contracts/managed-vault',
}, capability, { now: () => Date.now(), overdueAfterMs: OVERDUE_MS });

handInWiring({
  name: 'chain',
  commitments: SimulatedCommitments,
  createLedger: () => ledger as never,
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');

let server: Server;
let base: string;
beforeAll(async () => {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => {
  letItSettle();
  await new Promise<void>(r => server.close(() => r()));
});

const health = async () => {
  const r = await fetch(`${base}/api/health`);
  return { status: r.status, body: await r.json() as any };
};

describe('health while a write is running', () => {
  /*
   * RED WHEN: the route answers `writing` as something other than `null` while
   * nothing is running, or stops answering `ok` for an idle product.
   */
  it('an idle product is ok and names no write', async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('writing', null);
  });

  /*
   * RED WHEN: the route stops asking the ledger what it is waiting on, names
   * the company, or calls a running write that is not yet overdue unhealthy.
   */
  it('names the running write and how long, and stays ok until it is overdue', async () => {
    const started = ledger.open('acc_the_company_nobody_may_learn', {} as never);
    started.catch(() => {});
    await new Promise(r => setTimeout(r, 10));
    const { body } = await health();
    expect(body.writing?.what).toBe('opening an account');
    expect(typeof body.writing?.since).toBe('string');
    expect(body.writing?.overdue).toBe(false);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body), 'health named the company').not.toMatch(/acc_/);
  });

  /* RED WHEN: an overdue write leaves the route answering `ok`. */
  it('is not ok once the write is overdue, and says so', async () => {
    await new Promise(r => setTimeout(r, OVERDUE_MS + 30));
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.writing?.overdue).toBe(true);
    expect(body.writing?.seconds).toBeGreaterThanOrEqual(0);
    expect(body.ok).toBe(false);
  });
});
