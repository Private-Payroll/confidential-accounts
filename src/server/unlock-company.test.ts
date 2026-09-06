/**
 * **THE COMPANY COMES FROM THE SESSION. NEVER FROM THE REQUEST.**
 * `docs/NEXT.md` PI2a §2, `docs/scope-payroll-identity.md` §9.
 *
 * This is the most dangerous line in the round and it is a ROUTE, so it is
 * tested over real HTTP for `server.test.ts`'s reason: the two leaks that
 * actually shipped in this project were both in a route, and a mock request
 * object gets middleware order, body parsing and status codes right by
 * definition.
 *
 * **WHAT IS BEING PROVED IS AN ABSENCE**, which is why the body of the attempt
 * matters more than the assertion: a caller sends a complete, well-formed,
 * plausible company address of its own choosing, and the answer is somebody
 * else's — its own. `scripts/mutate-wallet-unlock.mjs` mutation 1 puts the door
 * in and this is the test that dies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { signInWithAWallet } from '../testing/wallet-session.js';

/*
 * **THIS SERVER RUNS ON `SimulatedLedger`, SO IT IS DEVELOPMENT AND SAYS SO.**
 *
 *
 * Every company below is opened by a simulation that mints its own address, and
 * from `PI2b` on that is refused unless the process was deliberately started
 * to allow it. **Nothing about what these tests assert has changed** — the
 * company still comes from the session and never from the request — but the
 * world they assert it in now has to declare what kind of world it is, in the
 * same place it already declares that sessions are in memory and no port is
 * served. Take this line out and all five go red, which is the point of it.
 */
process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
/*
 * Empty, not deleted, and the reason is in `server.test.ts`: since `X2` the
 * server reads `.env`, `.env` holds a live connection string, and a deleted
 * name is one `loadEnvFile` puts straight back.
 */
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
/* `PI4b`: a session comes from a wallet sign-in now, and a wallet signature
 * names the origin it was minted for — so this suite has to declare one. */
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-unlock-')), 'db.json');

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

let n = 10;
/**
 * A person with a company of their own.
 *
 * **THIS USED TO REGISTER WITH A PASSWORD.** It never wanted one — the
 * suite is about where a company comes from — it wanted a session, and
 * registering was the cheapest way to get one. A slot is a person, so each call
 * takes the next one.
 */
const withACompany = async () => {
  const { token } = await signInWithAWallet(call,
    { slot: ++n, origin: ORIGIN, network: NETWORK });
  const made = await call('POST', '/api/accounts', {
    token,
    body: { name: 'Acme', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { token, accountId: made.body.account.id as string };
};

/** A complete, well-formed address that belongs to somebody else. */
const NOT_THEIRS = 'f0'.repeat(32);

describe('POST /api/accounts/:id/unlock', () => {
  it('answers with the company\'s own address on the chain', async () => {
    const { token, accountId } = await withACompany();
    const r = await call('POST', `/api/accounts/${accountId}/unlock`, { token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.company).toMatch(/^[0-9a-f]{64}$/);
    /* Nothing else comes back. Not a key, not a member list, not an id. */
    expect(Object.keys(r.body)).toEqual(['company']);
  });

  it('A CALLER THAT NAMES ITS OWN COMPANY IS NOT SERVED — the session decides', async () => {
    const { token, accountId } = await withACompany();
    const honest = await call('POST', `/api/accounts/${accountId}/unlock`, { token });

    /*
     * The attack, in the shape it would actually arrive in: a body carrying a
     * perfectly valid company address. If any of these were believed, this page
     * would go to a wallet and come back with a key for a company the session
     * has nothing to do with — and the wallet cannot see that, because the
     * company is the one value it must take on trust.
     */
    for (const body of [
      { company: NOT_THEIRS },
      { contractAddress: NOT_THEIRS },
      { company: NOT_THEIRS, accountId: 'acc_somebody_else' },
    ]) {
      const r = await call('POST', `/api/accounts/${accountId}/unlock`, { token, body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.company).toBe(honest.body.company);
      expect(r.body.company).not.toBe(NOT_THEIRS);
    }
  });

  it('and it is not served from a query string either', async () => {
    const { token, accountId } = await withACompany();
    const honest = await call('POST', `/api/accounts/${accountId}/unlock`, { token });
    const r = await call(
      'POST', `/api/accounts/${accountId}/unlock?company=${NOT_THEIRS}`, { token });

    expect(r.status).toBe(200);
    expect(r.body.company).toBe(honest.body.company);
  });

  it('SOMEBODY ELSE\'S COMPANY IS 404, AND THE ANSWER SAYS NOTHING ABOUT IT', async () => {
    const mine = await withACompany();
    const theirs = await withACompany();

    const r = await call('POST', `/api/accounts/${theirs.accountId}/unlock`,
      { token: mine.token });
    expect(r.status).toBe(404);
    /* The same 404 a missing account gets. Anything else enumerates ids. */
    expect((await call('POST', '/api/accounts/acc_nope/unlock', { token: mine.token })).status)
      .toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('no session, no company', async () => {
    const { accountId } = await withACompany();
    expect((await call('POST', `/api/accounts/${accountId}/unlock`)).status).toBe(401);
  });
});
