/**
 * **THE TWO SYSTEMS PI4a DELETED ARE GONE, AND STAY GONE.** `docs/NEXT.md`
 *
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * A deletion leaves no code to test, so it leaves nothing that fails when
 * somebody puts it back. **A disabled path is a path somebody re-enables** —
 * the round's own words — and the only way that sentence has teeth is if
 * re-enabling one turns something red.
 *
 * So these assert ABSENCE, over real HTTP, against the running app: the routes
 * answer 404, and the one field that carried the envelope is not in the
 * response. `scripts/mutate-deleted-systems.mjs` puts each one back and names
 * the test that dies.
 *
 * ── AND ONE OF THEM ASSERTS A PRESENCE, WHICH MATTERS MORE ────────────────
 *
 * `§3` covers the thing that now does the job the envelope used to: **removing
 * a device is revoking its session.** Deleting a system and not checking what
 * replaced it is how a round leaves a hole where a feature was.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { signInWithAWallet } from '../testing/wallet-session.js';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
/*
 * Empty, not deleted, and the reason is in `server.test.ts`: since `X2` the
 * server reads `.env`, `.env` holds a live connection string, and a deleted
 * name is one `loadEnvFile` puts straight back.
 */
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
/* `PI4b`: a session comes from a wallet sign-in, and a wallet signature names
 * the origin it was minted for — so this suite has to declare one. */
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-deleted-')), 'db.json');

const ORIGIN = 'https://payroll.example';
const { app } = await import('./index.js');
const { networkOfThePair } = await import('../midnight/network.js');
const NETWORK = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);

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

let n = 30;
/**
 * A signed-in person.
 *
 * **THE COMMENT HERE READ *"still a password account until `PI4b` deletes that
 * too"*, AND `PI4b` HAS.** It registered with an `authKey` because that was the
 * cheapest door to a session; the door is gone and this signs in with a wallet
 * instead. Nothing these tests assert depends on which — every one of them is
 * about a route that answers `404`.
 */
const signedIn = async () => {
  const { token } = await signInWithAWallet(call,
    { slot: ++n, origin: ORIGIN, network: NETWORK });
  return token;
};

/* ======================================================================== */

describe('§1 — THE ACCOUNT RECOVERY FLOW IS GONE', () => {
  it('THE THREE RECOVERY ROUTES ANSWER 404 — they are deleted, not disabled', async () => {
    /*
     * It could not serve a wallet account and had no client at all; the proof
     * is in `docs/reports/PI4a-proof-of-death.md` and it was written before the
     * deletion rather than after it.
     */
    for (const path of [
      '/api/auth/recover/challenge',
      '/api/auth/recover',
      '/api/auth/recover/password',
    ]) {
      const r = await call('POST', path, { body: { email: 'ada@acme.co' } });
      expect(r.status, path).toBe(404);
    }
  });
});

describe('§2 — THE DEVICE-ENVELOPE SYSTEM IS GONE', () => {
  it('EVERY DEVICE ROUTE ANSWERS 404, INCLUDING THE UPGRADE THAT BUILT THE ENVELOPE',
    async () => {
      const token = await signedIn();
      const gone: Array<[string, string]> = [
        ['GET', '/api/me/devices'],
        ['POST', '/api/me/devices'],
        ['POST', '/api/me/devices/dev_1/approve'],
        ['POST', '/api/me/devices/dev_1/rename'],
        ['POST', '/api/me/devices/dev_1/remove'],
        ['POST', '/api/me/keys/upgrade'],
      ];
      for (const [method, path] of gone) {
        /* No body on a GET — `fetch` refuses one, and a refusal thrown inside
         * the helper would look exactly like the route being gone. */
        const r = await call(method, path,
          method === 'GET' ? { token } : { token, body: {} });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    });

  it('AND THE KEY ROUTE HANDS BACK NO BUNDLE KEY — there is no second half now', async () => {
    /*
     * The response used to carry `bundleKey` beside `keyBundle`, because on an
     * upgraded account one without the other opened nothing. **Asserted as the
     * exact key set** rather than as `toBeUndefined`, so a field creeping back
     * in fails here rather than being ignored by a client that no longer reads
     * it.
     */
    const token = await signedIn();
    const r = await call('GET', '/api/me/keys', { token });

    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['keyBundle', 'version']);
  });
});

describe('§3 — AND WHAT NOW DOES THE JOB THE ENVELOPE DID', () => {
  it('REMOVING A DEVICE IS REVOKING ITS SESSION, AND THAT STILL WORKS', async () => {
    /*
     * **THE PRESENCE THIS ROUND OWES.** The envelope's one real power was that
     * removing a device took access away rather than merely closing a door,
     * because the device held a wrapped copy of the bundle key.
     *
     * **No device holds a copy of anything now** — `keyring.ts` keeps the
     * released key in memory for the life of the tab and nowhere else — so what
     * is left to take away is the session, and this is the route that does it.
     * If this ever stopped working, the deletion above would have left a hole
     * rather than removed a dead system.
     */
    const token = await signedIn();

    const mine = await call('GET', '/api/me/sessions', { token });
    expect(mine.status).toBe(200);
    const id = mine.body.sessions[0].id as string;

    const revoked = await call('POST', `/api/me/sessions/${id}/revoke`, { token });
    expect(revoked.status).toBe(200);

    /* And the token really is dead, which is the whole claim. */
    const after = await call('GET', '/api/me/sessions', { token });
    expect(after.status).toBe(401);
  });
});
