/**
 * **THE PASSWORD IS GONE, AND STAYS GONE.** `PI4b`, `C129`,
 * `docs/how-money-can-be-lost.md`.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * A deletion leaves no code to test, so it leaves nothing that fails when
 * somebody puts it back. `deleted-systems.test.ts` made that argument for
 * `PI4a` and this is the same one, for the round that removed a way of proving
 * who you are: **a disabled door is a door with a comment on it**, and the only
 * way that sentence has teeth is if re-enabling one turns something red.
 *
 * So these assert ABSENCE, over real HTTP, against the running app: the two
 * routes that took a password answer `404`, by name, and the row a sign-in
 * leaves carries none of what a password left behind.
 * `scripts/mutate-password-gone.mjs` puts each one back and names the test that
 * dies.
 *
 * ── AND WHAT REPLACED IT IS ASSERTED IN THE SAME FILE ─────────────────────
 *
 * `§3` covers the thing that now does the job: **a wallet signs in, and the
 * session it leaves works.** Deleting a system and not checking what replaced
 * it is how a round leaves a hole where a feature was.
 *
 * ── THE OTHER TWO HALVES OF THE CLAIM ARE ELSEWHERE, DELIBERATELY ─────────
 *
 * A route answering `404` says nothing about what SHIPPED to a browser, and
 * reading the source says less. `src/web/no-password-in-the-bundle.test.ts`
 * builds the app and looks in the output; `src/web/auth-screen.test.tsx`
 * RENDERS the sign-in screen and counts the ways in.
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
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-no-password-')), 'db.json');

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

let slot = 90;

/* ======================================================================== */

describe('§1 — NO ROUTE ACCEPTS A PASSWORD, NAMED ONE BY ONE', () => {
  it('THE TWO ROUTES THAT TOOK ONE ANSWER 404 — they are deleted, not disabled',
    async () => {
      /*
       * **NAMED, NOT SWEPT.** Both are written out with the body a real client
       * sent, so this fails if either comes back under its own address — which
       * is the only way a password path returns without somebody meaning it.
       *
       * `register` was the only writer of `authHash` and `authSalt`; `login`
       * was the only reader, the only caller of the limiter's `email` bucket,
       * and the only caller of `clear`.
       */
      const gone: Array<[string, string, unknown]> = [
        ['POST', '/api/auth/register', {
          email: 'ada@acme.co', name: 'Ada', authKey: 'aa'.repeat(32),
          keyBundle: { iv: '00', tag: '11', body: '22' },
        }],
        ['POST', '/api/auth/login', { email: 'ada@acme.co', authKey: 'aa'.repeat(32) }],
      ];
      for (const [method, path, body] of gone) {
        const r = await call(method, path, { body });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    });

  it('AND THE THREE RECOVERY ROUTES THE PASSWORD LEFT BEHIND ARE STILL 404 — PI4a',
    async () => {
      /*
       * `deleted-systems.test.ts` §1 owns this claim and it is repeated here
       * for one reason: **the last of them is `/api/auth/recover/password`**,
       * and a round that deletes the password is exactly when somebody
       * reintroduces a route with that word in it while meaning something else.
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

describe('§2 — AND NOTHING A PASSWORD LEFT BEHIND IS ON A PERSON', () => {
  it('THE ROW A SIGN-IN LEAVES CARRIES NO HASH, NO SALT AND NO KEY MATERIAL',
    async () => {
      /*
       * **ASKED OF WHAT THE SERVER WILL HAND OUT**, rather than of the store,
       * because that is what a stolen response contains. `wallet-sign-in.test.ts`
       * asserts the exact key set on the row itself; this is the same claim at
       * the door.
       */
      const { token } = await signInWithAWallet(call,
        { slot: ++slot, origin: ORIGIN, network: NETWORK });

      for (const path of ['/api/me', '/api/me/keys', '/api/me/sessions']) {
        const r = await call('GET', path, { token });
        expect(r.status, path).toBe(200);
        expect(JSON.stringify(r.body), path)
          .not.toMatch(/authHash|authSalt|authKey|password|argon/i);
      }
    });

  it('AND THE KEY ROUTE HANDS BACK EXACTLY TWO THINGS', async () => {
    /*
     * **THE EXACT KEY SET**, for `deleted-systems.test.ts`'s reason: a field
     * creeping back in should fail here rather than be ignored by a client that
     * no longer reads it. `PI4a` removed `bundleKey` — the half a password
     * unwrapped — and there is no third thing for a password to put back.
     */
    const { token } = await signInWithAWallet(call,
      { slot: ++slot, origin: ORIGIN, network: NETWORK });
    const r = await call('GET', '/api/me/keys', { token });

    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['keyBundle', 'version']);
  });
});

describe('§3 — AND WHAT NOW DOES THE JOB THE PASSWORD DID', () => {
  it('A WALLET SIGNS IN AND THE SESSION IT LEAVES WORKS — the presence this round owes',
    async () => {
      /*
       * **THE PRESENCE.** The password's one real job that is still needed was
       * letting somebody in; its other job — producing the key that unsealed a
       * keyring — is `PI2a`'s `unlock` and belongs to `unlock-company.test.ts`.
       *
       * If this ever stopped working, the deletions above would have left a
       * product nobody can sign in to rather than a dead system removed.
       */
      const who = await signInWithAWallet(call,
        { slot: ++slot, origin: ORIGIN, network: NETWORK });
      expect(who.token).toMatch(/^[0-9a-f]{64}$/);

      const me = await call('GET', '/api/me', { token: who.token });
      expect(me.status).toBe(200);
      expect(me.body.user.id).toBe(who.userId);
      /* And they arrive with no email at all, which is `§10 step 1` working
       * rather than a gap: nothing asked them for one. */
      expect(me.body.user.email).toBeNull();
    });
});
