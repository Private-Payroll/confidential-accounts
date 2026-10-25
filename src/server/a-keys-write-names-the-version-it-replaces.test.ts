/*
 * **A WRITE OF A PERSON'S SAVED KEYS NAMES THE VERSION IT REPLACES, ONCE THERE IS ONE.** The service holds one sealed
 * copy per person and cannot read it, so the version is the only thing that stops a writer that never saw the last
 * write from replacing it. The very first write has nothing to replace and needs none.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { importTheServer, useOnlyTheseSettings } from '../testing/server-under-test.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { signInWithAWallet } from '../testing/wallet-session.js';

useOnlyTheseSettings({
  ALLOW_SIMULATED_COMPANY_ADDRESS: '1',
  ALLOW_MEMORY_SESSIONS: '1',
  /*
   * Empty: this file says in its own words that there is no database. The
   * working tree's `.env`, which on a developer's machine names a live one, is
   * never read here - `importTheServer` imports from a directory without one.
   */
  DATABASE_URL: '',
  SERVE: '0',
  APP_ORIGIN: 'https://payroll.example',
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-keys-version-')), 'db.json'),
});

const ORIGIN = 'https://payroll.example';
/**
 * **THIS FILE DRIVES THE ROUTES OVER A TEST DOUBLE, NOT OVER A DEPLOYMENT, AND
 * THAT IS SAID HERE SO NOBODY READS THESE CASES AS EVIDENCE ABOUT A CHAIN.**
 *
 * This file is about no password existing on any door. It reaches no ledger write - but which ledger the entry point held decided itself from whatever was on the machine.
 *
 * **THAT IS THE DEFECT THIS BLOCK CLOSES, AND IT IS NOT ABOUT THIS FILE'S OWN
 * CASES.** The entry point resolves a deployment from the working directory and
 * the environment. On a machine with a deployment record and a proof server it
 * therefore built a ledger pointed at a REAL contract, with a sealed-state
 * store rooted in the working tree; in a clone with neither it built one that
 * refuses everything. **Two different subjects, one green result, and nothing
 * saying which ran.** The next case added here would have reached whichever one
 * the machine happened to have.
 *
 * So this file says which one it drives, and hands it over before the entry
 * point is imported. The services, the routes, the sign-in state handling and the
 * checks are the real ones - the LEDGER is a double, named here out loud.
 * Nothing outside a test may do this: the walk beside the selector refuses
 * `handInWiring` in every non-test module.
 *
 * **WHAT THESE CASES PROVE AND WHAT THEY DO NOT.** They prove what they proved
 * before the product selected a chain, and nothing more. **They are not
 * evidence that this server works against a chain.** `server-starts.test.ts` is
 * the file that exercises the real chain wiring, and it is deliberately the one
 * file here that takes no double.
 *
 * The three come from one object because they may never be chosen apart: a leaf
 * computed under one commitment scheme is meaningless to a ledger running under
 * another.
 */
const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await importTheServer();
const { theNetwork } = await import('../midnight/network.js');
const NETWORK = theNetwork();

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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

let slot = 140;
const SEALED = (b: string) => ({ iv: '00'.repeat(12), tag: '', body: b.repeat(32) });

describe('a write of saved keys names the version it replaces', () => {
  it('the first write needs no version; every write after it must name the one it replaces', async () => {
    const { token } = await signInWithAWallet(call, { slot: ++slot, origin: ORIGIN, network: NETWORK });
    const first = await call('PUT', '/api/me/keys', { token, body: { keyBundle: SEALED('aa') } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.version).toBe(1);
    const blind = await call('PUT', '/api/me/keys', { token, body: { keyBundle: SEALED('bb') } });
    /* RED WHEN: a write that names no version replaces saved keys it never read, so an older copy is written over a newer one. */
    expect(blind.status).toBe(409);
    expect(blind.body.code).toBe('version-required');
    expect(blind.body.currentVersion).toBe(1);
    /* RED WHEN: the refusal does not say what resolves it. */
    expect(String(blind.body.error)).toMatch(/read your saved keys again/iu);
    expect((await call('GET', '/api/me/keys', { token })).body.keyBundle).toEqual(SEALED('aa'));
    const named = await call('PUT', '/api/me/keys', { token, body: { keyBundle: SEALED('cc'), ifVersion: 1 } });
    expect(named.status).toBe(200);
    expect(named.body.version).toBe(2);
    const stale = await call('PUT', '/api/me/keys', { token, body: { keyBundle: SEALED('dd'), ifVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.currentVersion).toBe(2);
  });
});
