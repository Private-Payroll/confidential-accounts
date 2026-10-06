/**
 * **THE INVITATION DOORS OF THE WHOLE SERVER, OVER REAL HTTP.**
 * `docs/NEXT.md` `X11` §6, `docs/scope-invitations.md` §8.
 *
 * An invitation is made, opened and accepted on people's own devices; the
 * routes that keep it are `invitations-route.ts`, and what they check is
 * tested beside it (`an-invitation-is-made-on-the-device.test.ts`), with the
 * directory and the record store mounted on their own. What is tested here is
 * what only the whole server has: the offer door, which answers somebody with
 * no sign-in, is metered by the limiter sign-in uses, keyed on who is asking.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { importTheServer, useOnlyTheseSettings } from '../testing/server-under-test.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { randomBytes, toHex } from '../core/crypto.js';

useOnlyTheseSettings({
  ALLOW_SIMULATED_COMPANY_ADDRESS: '1',
  ALLOW_MEMORY_SESSIONS: '1',
  DATABASE_URL: '',
  SERVE: '0',
  APP_ORIGIN: 'https://payroll.example',
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-invitations-')), 'db.json'),
});

const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
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

describe('§6 — the offer endpoint is metered', () => {
  it('REFUSES A CALLER WHO ASKS TOO MANY TIMES, WITH A `Retry-After`', async () => {
    /*
     * **KEYED ON THE CALLER AND NOT ON THE INVITATION**, which is what this
     * test is really about: every request below asks for a DIFFERENT lookup
     * id, so a limit keyed on the invitation would give each one a fresh
     * allowance and none of them would ever be refused. The refusal only
     * happens because the bucket is the thing that does not change between
     * guesses.
     */
    let refused: { status: number; body: any; headers: Headers } | null = null;
    let notFound = 0;
    for (let i = 0; i < 60 && !refused; i += 1) {
      const r = await fetch(`${base}/api/invites/${toHex(randomBytes(32))}/offer`);
      const answer = { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
      if (r.status === 429) refused = answer;
      else if (r.status === 404 && answer.body?.refused === 'not-found') notFound += 1;
    }
    /* RED WHEN: a guess is answered by anything but not found before the meter refuses. */
    expect(notFound).toBeGreaterThan(0);
    /* RED WHEN: a guesser walking the lookup ids is never refused. */
    expect(refused, 'a guesser walking the lookup ids was never refused').not.toBeNull();
    expect(refused!.headers.get('retry-after')).toMatch(/^\d+$/u);
    expect(refused!.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused!.body.error).toMatch(/metered/u);
  });
});
