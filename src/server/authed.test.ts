import { afterEach, describe, expect, it } from 'vitest';
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
    ask: (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/api/me`, { headers }),
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
    expect((await r.json()).code).toBeUndefined();
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
