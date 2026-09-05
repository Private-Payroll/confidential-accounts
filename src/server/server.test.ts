/**
 * M-98 — the HTTP layer, driven over real HTTP.
 *
 * WHY THIS FILE EXISTS, stated as the damage: every other test in this project
 * stops at the service layer, and both leaks that actually shipped were in a
 * route. `/api/public` published `approvals[].signerId` — the deanonymised
 * version of the nullifiers the chain blinds on purpose — and nobody noticed,
 * because no test had ever read a response body.
 *
 * The types now carry most of the weight: `/api/me` and friends return
 * `SealedAccount`, and a company name cannot be added without a compile error.
 * Two things the types cannot see:
 *
 *   - a hand-built projection, which compiles fine;
 *   - a STATUS CODE, which has no type at all. 401 vs 200, 429 vs 400 and
 *     404 vs 403 are the entire authorisation story of this server and not one
 *     of them was asserted anywhere before this file.
 *
 * It runs against a real listening server on an ephemeral port rather than a
 * mock request object, because middleware order, JSON parsing, header casing
 * and `req.ip` are exactly the things a mock gets right by definition and a
 * server gets wrong in practice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { signInWithAWallet } from '../testing/wallet-session.js';

/*
 * The server refuses to boot without DATABASE_URL, on purpose — in-memory
 * sessions on a real server are the hole S-2 and S-4 exist to close. Tests are
 * the one place the opt-out is correct: there is one process, it lives for a
 * few seconds, and the Postgres implementations of both stores are held to the
 * identical contract in sessions.test.ts and rate-limit.test.ts.
 *
 * Set BEFORE the import, because the module wires itself up at import time.
 */
process.env.ALLOW_MEMORY_SESSIONS = '1';
/*
 * **AND THE DEVELOPER'S OWN DATABASE IS REFUSED OUT LOUD.** `X2`.
 *
 * `X2` made the server read `.env`, which is what lets a person start it — and
 * `.env` on a working machine holds the LIVE connection string. Saying
 * `ALLOW_MEMORY_SESSIONS=1` is no longer enough on its own: the server prefers a
 * connection string when it has one, so this file would have opened the real
 * database and written sessions into it, silently.
 *
 * SET TO EMPTY RATHER THAN DELETED. `loadEnvFile` fills a name that is
 * `undefined`, so deleting it invites the file to put it straight back. Empty is
 * a name that exists and is not a connection string, which is exactly the claim
 * being made — and the server refuses to start if both arrive anyway.
 */
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
/* `PI4b`: a session comes from a wallet sign-in, and a wallet signature names
 * the origin it was minted for — so this suite has to declare one. */
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-http-')), 'db.json');

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

type Res = { status: number; headers: Headers; body: any };

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
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};

/**
 * **A DISTINCT SUBWALLET SLOT PER PERSON.** `PI4b`.
 *
 * This was `register`, and the comment above it said *a distinct email per
 * test, so the per-email limiter does not leak across them*. **Both the route
 * and that bucket are deleted.** What is left counts on the ADDRESS, which is
 * shared by everything in this file — so the ceiling matters here in a way it
 * did not, and the slot numbers below are simply distinct people.
 *
 * There are far fewer than sixty sign-ins in this file and the `ip` ceiling is
 * sixty in a quarter of an hour, so nothing here approaches it. **If that ever
 * stops being true the failure is loud** — the helper throws with the status
 * and body rather than returning an undefined token.
 */
let slot = 40;
const signedIn = async () => {
  const who = await signInWithAWallet(call, { slot: ++slot, origin: ORIGIN, network: NETWORK });
  return { token: who.token, user: { id: who.userId! }, address: who.address };
};

/** Another session for the SAME person — what two devices look like. */
const againAs = async (theirSlot: number) =>
  (await signInWithAWallet(call, { slot: theirSlot, origin: ORIGIN, network: NETWORK })).token;

describe('the HTTP layer', () => {
  it('a wallet sign-in returns a working session', async () => {
    const { token, user } = await signedIn();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const me = await call('GET', '/api/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
  });

  it('THE ONE THE 401 STORY DEPENDS ON: no token, a wrong one, and a dead one all get 401', async () => {
    const { token } = await signedIn();
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect((await call('GET', '/api/me', { token: 'garbage' })).status).toBe(401);
    expect((await call('GET', '/api/me', { token: 'ab'.repeat(32) })).status).toBe(401);

    await call('POST', '/api/auth/logout', { token });
    expect((await call('GET', '/api/me', { token })).status).toBe(401);
  });

  it('S-3 over HTTP: logging out ends the session for real', async () => {
    const { token } = await signedIn();
    expect((await call('GET', '/api/me', { token })).status).toBe(200);

    const out = await call('POST', '/api/auth/logout', { token });
    expect(out.status).toBe(200);

    // The client dropping the token is not what makes this true. Sending the
    // same token again is.
    expect((await call('GET', '/api/me', { token })).status).toBe(401);
  });

  /*
   * **`S-2 over HTTP: too many logins get 429 with Retry-After, not 400` IS
   * DELETED.** `PI4b`, `C129`.
   *
   * It sent a wrong `authKey` forty times at `POST /api/auth/login` and
   * required the refusal to arrive as a `429` with a `Retry-After` rather than
   * as a `400`, because *a refused login that came back as 400 would be
   * indistinguishable from a wrong password to every client, and nothing could
   * back off.* **There is no login and no wrong password**, so the refusal it
   * asserted cannot happen.
   *
   * **AND THE PROPERTY IT PROTECTED IS STILL WATCHED, OVER HTTP, TWICE.**
   * Deleting a system and not saying what covers the property afterwards is how
   * a round leaves a hole where a feature was:
   *
   *   · `invitations.test.ts` §6 — *REFUSES A CALLER WHO ASKS TOO MANY TIMES,
   *     WITH A `Retry-After`* — drives the same limiter class over real HTTP on
   *     the `invite-offer` bucket, and asserts the status and the header.
   *   · `wallet-sign-in.test.ts`'s `S-2` describe covers the door that counts
   *     now, at the level `core.test.ts` used to: **the challenge counts, the
   *     sign-in counts, and a correct signature is refused once the address is
   *     over.**
   */

  it('lists sessions without a token in the body, and ends one by id', async () => {
    /* Two sessions for ONE person: the same subwallet signing in twice, which
     * `wallet-sign-in.test.ts` pins as one person and not two. */
    const mine = ++slot;
    const here = await againAs(mine);
    const other = await againAs(mine);

    const list = await call('GET', '/api/me/sessions', { token: here });
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(2);
    // A session list that contained tokens would be a way to steal every
    // session by reading one response.
    expect(JSON.stringify(list.body)).not.toContain(here);
    expect(JSON.stringify(list.body)).not.toContain(other);

    const target = list.body.sessions.find((s: any) => !s.current);
    expect(target).toBeTruthy();
    expect((await call('POST', `/api/me/sessions/${target.id}/revoke`, { token: here })).status)
      .toBe(200);
    expect((await call('GET', '/api/me', { token: here })).status).toBe(200);
  });

  it('M-118 over HTTP: one user cannot end another user\'s session by id', async () => {
    const victim = await signedIn();
    const attacker = await signedIn();

    const theirs = (await call('GET', '/api/me/sessions', { token: victim.token }))
      .body.sessions[0];

    const attempt = await call('POST', `/api/me/sessions/${theirs.id}/revoke`,
      { token: attacker.token });
    // 404, not 403: telling an attacker the id was real but not theirs is a
    // membership oracle, and every other ownership gate here answers the same.
    expect(attempt.status).toBe(404);
    expect((await call('GET', '/api/me', { token: victim.token })).status).toBe(200);

    /*
     * And the same request with the victim's user id helpfully supplied. The
     * classic shape of this bug is a handler that takes the subject from the
     * request instead of from the session — it looks like a parameter and it
     * is an authorisation bypass. The only user id these routes may use is the
     * one `authed` resolved from the token.
     */
    for (const path of [
      `/api/me/sessions/${theirs.id}/revoke`,
      '/api/me/sessions/others/revoke',
    ]) {
      await call('POST', path, {
        token: attacker.token,
        body: { userId: victim.user.id, user_id: victim.user.id, id: victim.user.id },
      });
    }
    expect((await call('GET', '/api/me', { token: victim.token })).status).toBe(200);
  });

  it('signs out the other devices and keeps the one that asked', async () => {
    const mine = ++slot;
    const keep = await againAs(mine);
    const gone = await againAs(mine);

    const r = await call('POST', '/api/me/sessions/others/revoke', { token: keep });
    expect(r.status).toBe(200);
    expect(r.body.ended).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/api/me', { token: keep })).status).toBe(200);
    expect((await call('GET', '/api/me', { token: gone })).status).toBe(401);
  });

  it('NO AUTH RESPONSE CARRIES A KEY, AND NONE CARRIES WHAT A PASSWORD LEFT BEHIND',
    async () => {
      /*
       * **THE GENERIC SWEEP, REPOINTED.** `PI4b`.
       *
       * It used to register and log in with an `authKey` of `'cd'.repeat(32)`
       * and require that neither response echoed it — the generic version of a
       * leak that shipped. **There is no `authKey` to echo.** What arrives at
       * the sign-in door now is a signature over a nonce, which is public by
       * construction, so the claim worth making is the other one: **nothing
       * that opens anything, and nothing a password left behind, comes back
       * from any of these three.**
       */
      const { token } = await signedIn();

      const seen = [
        (await call('GET', '/api/me', { token })).body,
        (await call('GET', '/api/me/keys', { token })).body,
        (await call('GET', '/api/me/sessions', { token })).body,
      ];
      for (const body of seen) {
        expect(JSON.stringify(body)).not.toMatch(/authHash|authSalt|authKey|password|argon/i);
      }

      /*
       * The sealed bundle DOES come back — a client cannot open its own keyring
       * otherwise — and it is ciphertext this process cannot read. It arrives
       * null here because nothing has written one for this person yet, which is
       * itself the honest state after a first sign-in: **asserted as the exact
       * key set**, so a field creeping in fails here rather than being ignored
       * by a client that does not read it.
       */
      const keys = await call('GET', '/api/me/keys', { token });
      expect(keys.status).toBe(200);
      expect(Object.keys(keys.body).sort()).toEqual(['keyBundle', 'version']);

      /* And a session list that contained tokens would be a way to steal every
       * session by reading one response. */
      expect(JSON.stringify(seen[2])).not.toContain(token);
    });

  it('health is public and says nothing about anybody', async () => {
    const r = await call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/@|usr_/);
  });
});
