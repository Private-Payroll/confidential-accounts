import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { authedBy } from './authed.js';
import { IdentityService } from '../core/identity.js';
import { MemoryStore } from '../core/store.js';
import { MemorySessionStore, type SessionStore } from '../core/sessions.js';

/**
 * **A SIGN-IN THE SERVICE COULD NOT CHECK IS NEVER "NOT SIGNED IN".**
 *
 * A page that is told 401 signs the person out. The service answers 401 only when it looked and found
 * no live session or no such person. When it could not look (the sessions database unreachable, slow,
 * dropped, out of connections) it answers 503 with code `could-not-check`, and the person stays signed in.
 *
 * RED WHEN: a session store that throws or never answers is answered 401; a definite "no" is answered
 * anything but 401; a stale cookie whose person this service does not hold is kept; a session running
 * low is not renewed on the way through.
 */
const scope = { domain: null, secure: false };
const open: Server[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

async function serve(sessions: SessionStore, store = new MemoryStore(), boundMs?: number) {
  const identity = new IdentityService(store, sessions);
  if (boundMs !== undefined) identity.checkBoundMs = boundMs;
  const app = express();
  app.get('/api/me', authedBy({ identity, cookieScope: scope, appOrigin: () => undefined }), (req, res) => { res.json({ id: req.userId }); });
  const server = await new Promise<Server>((up) => { const s = app.listen(0, '127.0.0.1', () => { up(s); }); });
  open.push(server);
  const port = (server.address() as { port: number }).port;
  return {
    identity,
    ask: (headers: Record<string, string>, search = '') => fetch(`http://127.0.0.1:${port}/api/me${search}`, { headers }),
  };
}

const broken = (how: () => Promise<never>): SessionStore => {
  const real = new MemorySessionStore();
  return Object.assign(Object.create(real), { resolve: how, renew: how }) as SessionStore;
};

const person = (store: MemoryStore, id: string) => { store.putUser({ id, name: id, email: '', createdAt: new Date().toISOString() } as never); };

describe('a failure to check is 503, a definite no is 401', () => {
  it('a session store that throws is 503 could-not-check, not 401', async () => {
    const { ask } = await serve(broken(() => Promise.reject(new Error('write CONNECT_TIMEOUT db.example:5432'))));
    const r = await ask({ authorization: 'Bearer anything' });
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.code).toBe('could-not-check');
    expect(body.error).toContain('the service could not check your sign-in');
    expect(JSON.stringify(body)).not.toContain('CONNECT_TIMEOUT');
    expect(r.headers.get('retry-after')).toBe('2');
  });

  it('a session store that never answers is 503 within the bound, not a hang and not 401', async () => {
    const { ask } = await serve(broken(() => new Promise<never>(() => {})), new MemoryStore(), 50);
    const r = await ask({ authorization: 'Bearer anything' });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('could-not-check');
  });

  it('a person store that throws is 503 as well', async () => {
    const sessions = new MemorySessionStore();
    const store = new MemoryStore();
    person(store, 'usr_1');
    const { token } = await sessions.issue('usr_1');
    store.getUser = () => { throw new Error('file unreadable'); };
    const { ask } = await serve(sessions, store);
    expect((await ask({ authorization: `Bearer ${token}` })).status).toBe(503);
  });

  it('no such live session is 401', async () => {
    const { ask } = await serve(new MemorySessionStore());
    const r = await ask({ authorization: 'Bearer never-issued' });
    expect(r.status).toBe(401);
  });

  it('a live session of a person this service does not hold is 401, and its stale cookie is cleared', async () => {
    const sessions = new MemorySessionStore();
    const { token } = await sessions.issue('usr_elsewhere');
    const { ask } = await serve(sessions);
    const r = await ask({ cookie: `ca_session=${token}` });
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toMatch(/^ca_session=; .*Max-Age=0/);
  });

  it('a live session of a person it holds is let through', async () => {
    const sessions = new MemorySessionStore();
    const store = new MemoryStore();
    person(store, 'usr_1');
    const { token } = await sessions.issue('usr_1');
    const { ask } = await serve(sessions, store);
    const r = await ask({ authorization: `Bearer ${token}` });
    expect(r.status).toBe(200);
    expect((await r.json()).id).toBe('usr_1');
  });
});

/**
 * **A 401 TELLS THE CALLER ONLY WHAT THE CALLER ALREADY KNOWS, AND THE SERVICE KEEPS THE CAUSE.**
 *
 * A request with no credential, or with two ca_session cookies, is told so: the caller sent it. Every cause that
 * depends on the token's state (revoked, never issued or run out, a person this service does not hold) is the one
 * answer `session-not-valid`, so a token holder cannot learn which. The service writes the real cause to its refusal
 * log (the route, the time, the cause, and the start of the person's id where it is known), never the token.
 *
 * RED WHEN: the three token-state causes are answered with different codes or text; the text is anything but
 * "not signed in"; no credential or two cookies are not told apart; any of the five causes is missing from the refusal
 * log or named wrongly there; the token or the cookie value reaches the log; a cause that cannot be read turns the 401
 * into a 503 or a 200.
 */
describe('a 401 says one thing for every state of a token, and the log says which', () => {
  const PEOPLE = 'usr_1';
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'authed-refusals-'));
  let log = '';
  const kept = process.env.REFUSAL_LOG;
  beforeEach(() => { log = join(dir, `${Math.random().toString(36).slice(2)}.txt`); process.env.REFUSAL_LOG = log; });
  afterEach(() => { if (kept === undefined) delete process.env.REFUSAL_LOG; else process.env.REFUSAL_LOG = kept; });
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const said = async (r: Response) => ({ status: r.status, ...(await r.json()) });
  const NOT_VALID = { status: 401, error: 'not signed in', code: 'session-not-valid' };

  it('no credential at all, and a cleared cookie: no-credential', async () => {
    const { ask } = await serve(new MemorySessionStore());
    expect(await said(await ask({}))).toEqual({ status: 401, error: 'not signed in', code: 'no-credential' });
    expect((await said(await ask({ cookie: 'ca_session=' }))).code).toBe('no-credential');
    expect(logged()).toMatch(/401 GET\s+\/api\/me\n\s+no-credential: not signed in/);
  });

  it('two ca_session cookies, one of them live: two-session-cookies, signed in on neither', async () => {
    const sessions = new MemorySessionStore();
    const store = new MemoryStore();
    person(store, PEOPLE);
    const { token } = await sessions.issue(PEOPLE);
    const { ask } = await serve(sessions, store);
    expect(await said(await ask({ cookie: `ca_session=${token}; ca_session=extra` })))
      .toEqual({ status: 401, error: 'not signed in', code: 'two-session-cookies' });
    expect(logged()).toMatch(/two-session-cookies: not signed in/);
    expect(logged()).not.toContain(token);
  });

  it('a sign-in nobody issued, one that ran out, one revoked and a person this service does not hold are ONE answer', async () => {
    const sessions = new MemorySessionStore();
    const store = new MemoryStore();
    const ran = await sessions.issue(PEOPLE, { now: new Date(Date.now() - 48 * 3600_000) });
    const revoked = await sessions.issue(PEOPLE);
    await sessions.revoke(revoked.token);
    const elsewhere = await sessions.issue('usr_elsewhereXYZ');
    const { ask } = await serve(sessions, store);
    const answers = [
      await ask({ authorization: 'Bearer never-issued' }),
      await ask({ authorization: `Bearer ${ran.token}` }),
      await ask({ authorization: `Bearer ${revoked.token}` }),
      await ask({ authorization: `Bearer ${elsewhere.token}` }),
    ];
    const bodies = await Promise.all(answers.map(said));
    for (const b of bodies) expect(b).toEqual(NOT_VALID);
  });

  it('the log keeps each cause, the route, and the start of a known person\'s id, and never a token', async () => {
    const sessions = new MemorySessionStore();
    const ran = await sessions.issue(PEOPLE, { now: new Date(Date.now() - 48 * 3600_000) });
    const revoked = await sessions.issue(PEOPLE);
    await sessions.revoke(revoked.token);
    const elsewhere = await sessions.issue('usr_elsewhereXYZ');
    const { ask } = await serve(sessions);
    await ask({ authorization: 'Bearer never-issued' });
    await ask({ authorization: `Bearer ${ran.token}` });
    await ask({ authorization: `Bearer ${revoked.token}` });
    await ask({ authorization: `Bearer ${elsewhere.token}` });
    const causes = [...logged().matchAll(/^\s+(session-[a-z-]+|no-such-user): not signed in(.*)$/gm)].map((m) => [m[1], m[2]]);
    expect(causes).toEqual([
      ['session-unknown-or-expired', ''],
      ['session-unknown-or-expired', ''],
      ['session-revoked', ''],
      ['no-such-user', ' (person usr_else)'],
    ]);
    expect(logged().match(/401 GET\s+\/api\/me/g)).toHaveLength(4);
    for (const t of [ran.token, revoked.token, elsewhere.token, 'never-issued']) expect(logged()).not.toContain(t);
    expect(logged()).not.toContain('usr_elsewhereXYZ');
  });

  it('a cause that cannot be read leaves the 401 the same answer, logged as no live sign-in found', async () => {
    const real = new MemorySessionStore();
    const sessions = Object.assign(Object.create(real), { whyNot: () => Promise.reject(new Error('db gone')) }) as SessionStore;
    const { ask } = await serve(sessions);
    expect(await said(await ask({ authorization: 'Bearer x' }))).toEqual(NOT_VALID);
    expect(logged()).toMatch(/session-unknown-or-expired: not signed in/);
  });

  /* RED WHEN: the refusal log line carries the query string of the request (it can hold anything a client sent), or loses the route. */
  it('the log line carries the route without its query string', async () => {
    const { ask } = await serve(new MemorySessionStore());
    await ask({ authorization: 'Bearer never-issued' }, '?company=co_1&viewingKey=abc');
    expect(logged()).toMatch(/401 GET\s+\/api\/me\n/);
    expect(logged()).not.toContain('company=');
    expect(logged()).not.toContain('abc');
  });

  /* RED WHEN: the header the log opens with still says it holds only 400s, leaves out the cause of a 401, or carries a work id of this project. */
  it('the log opens with a header that says what it now holds', async () => {
    const { ask } = await serve(new MemorySessionStore());
    await ask({});
    const header = logged().split('\n\n\n')[0]!;
    expect(header).toContain('REPORT-REFUSALS');
    expect(header).toContain('401');
    expect(header).toMatch(/cause/);
    expect(header).not.toMatch(/answered with a 400/);
    expect(header).not.toMatch(/\b(?:[STCMNR]-?[0-9]{2,4}[a-z]?)\b/);
  });

  it('a log that cannot be written does not change the answer', async () => {
    process.env.REFUSAL_LOG = join(dir, 'a-file', 'x', 'no-log');
    writeFileSync(join(dir, 'a-file'), 'x');
    const { ask } = await serve(new MemorySessionStore());
    expect(await said(await ask({ authorization: 'Bearer x' }))).toEqual(NOT_VALID);
  });
});

describe('a person who is working is not signed out by the clock', () => {
  it('a cookie session running low is renewed on the way through, and the cookie is renewed with it', async () => {
    const sessions = new MemorySessionStore();
    const store = new MemoryStore();
    person(store, 'usr_1');
    const issuedAt = new Date(Date.now() - 8 * 3600_000);
    const { token, expiresAt } = await sessions.issue('usr_1', { now: issuedAt });
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThan(5 * 3600_000);
    const { ask } = await serve(sessions, store);
    const r = await ask({ cookie: `ca_session=${token}` });
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie') ?? '';
    const seconds = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    expect(seconds).toBeGreaterThan(11 * 3600);
  });
});
