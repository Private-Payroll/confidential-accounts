// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * SIGNING IN, WHO IS SIGNED IN, AND SIGNING OUT, THROUGH THE ADAPTER, WITH
 * THE SHARED CODE THAT TALKS TO THE PERSON'S ACCOUNT RUNNING AS IT IS. The
 * account's frame and the service are stood in for; the conversation between
 * them is the shared code's own.
 */
const ACCOUNT = 'http://wallet.localhost:5180';
const READY = 'midnight-identity/wallet-ready/v1';

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let answers: Record<string, () => Response | Promise<Response>> = {};
const reply = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The account's frame: what the page posts into it, and a way to answer from it. */
const posted: unknown[] = [];
const frameWindow = { postMessage: (m: unknown) => { posted.push(m); } };
const fromTheAccount = (data: unknown, origin = ACCOUNT) => {
  const e = new MessageEvent('message', { data, origin });
  Object.defineProperty(e, 'source', { value: frameWindow });
  window.dispatchEvent(e);
};
const settle = () => new Promise((r) => setTimeout(r, 0));

async function load(origin = ACCOUNT) {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', origin);
  const m = await import('./session.js');
  m.accountFrame.mount({ src: '', contentWindow: frameWindow });
  return m;
}

/** Every string anywhere in a value. */
const stringsIn = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsIn)
  : v !== null && typeof v === 'object' ? Object.values(v).flatMap(stringsIn) : []);

beforeEach(() => {
  calls = []; answers = {}; posted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const a = answers[path];
    if (a === undefined) throw new TypeError('network');
    return a();
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const CHALLENGE = { handle: 'h-1', nonce: 'n-1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
const SIGNED = { payload: { schema: 'x' }, signature: 's' };

describe('signing in', () => {
  /*
   * RED WHEN: the service is not handed back exactly the challenge's handle and
   * nonce and the account's answer, the person is not read from its answer, or
   * a later request is not sent as the person this tab was prepared for.
   */
  it('signs in with the account and prepares the tab for that person', async () => {
    const m = await load();
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(200, { user: { id: 'u1', email: null, name: 'Priya' }, session: { expiresAt: 'x' }, address: 'a', created: true });
    const signing = m.signIn({ name: 'Private Vaults', purpose: 'Why' });
    await settle();
    fromTheAccount({ schema: READY });
    expect(posted.length).toBe(1);
    fromTheAccount(SIGNED);
    const r = await signing;
    expect(r).toEqual({ of: m.OF.signedIn, person: { id: 'u1', name: 'Priya' }, firstTime: true });
    expect(calls.map((c) => [c.method, c.path])).toEqual([['POST', '/api/auth/wallet/challenge'], ['POST', '/api/auth/wallet']]);
    expect(calls[1]!.body).toEqual({ handle: 'h-1', nonce: 'n-1', response: SIGNED });
    answers['/api/me'] = reply(200, { user: { id: 'u1', name: 'Priya' }, accounts: [] });
    await m.whoIsSignedIn();
    expect(calls[2]!.headers['x-signed-in-as']).toBe('u1');
    expect(calls[0]!.headers['x-signed-in-as']).toBeUndefined();
  });

  /*
   * RED WHEN: an answer from another origin, or from a window that is not the
   * account's frame at the account's origin, is taken as the account's; the
   * page must go on waiting.
   */
  it('takes an answer only from the account\'s frame, at the account\'s address', async () => {
    const m = await load();
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(200, { user: { id: 'u1', name: 'Priya' }, created: false });
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    fromTheAccount({ schema: READY }, 'http://elsewhere.localhost:1');
    expect(posted.length).toBe(0);
    fromTheAccount({ schema: READY });
    fromTheAccount(SIGNED, 'http://elsewhere.localhost:1');
    const stranger = new MessageEvent('message', { data: SIGNED, origin: ACCOUNT });
    Object.defineProperty(stranger, 'source', { value: { postMessage: () => {} } });
    window.dispatchEvent(stranger);
    await settle();
    expect(calls.length).toBe(1);
    fromTheAccount(SIGNED);
    expect((await signing).of).toBe(m.OF.signedIn);
  });

  /*
   * RED WHEN: a refusal hands on the shared code's own words, or the service's,
   * instead of one of the reasons a screen says in its own; or the account is
   * left on screen after the sign-in ended.
   */
  it('hands on a reason, never the shared code\'s or the service\'s words, and puts the account away', async () => {
    const m = await load();
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    expect(m.accountFrame.shown()).toBe(true);
    fromTheAccount({ schema: READY });
    fromTheAccount({ schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined' });
    const r = await signing;
    expect(r).toEqual({ of: m.OF.refused, why: m.REFUSAL.declined, retryAfterSeconds: null });
    const codes = new Set<string>([...Object.values(m.REFUSAL), ...Object.values(m.OF)]);
    expect(stringsIn(r).filter((s) => !codes.has(s))).toEqual([]);
    expect(m.accountFrame.shown()).toBe(false);

    answers['/api/auth/wallet'] = reply(401, { error: 'that is not something this wallet could have signed.', code: 'not-a-response' });
    const again = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    fromTheAccount({ schema: READY });
    fromTheAccount(SIGNED);
    const refused = await again;
    expect(refused).toEqual({ of: m.OF.refused, why: m.REFUSAL.refused, retryAfterSeconds: null });
    expect(stringsIn(refused).filter((s) => !codes.has(s))).toEqual([]);
  });

  /* RED WHEN: a signature refused only because it is late is said as refused, when trying again is the answer. */
  it('says a late signature is late', async () => {
    const m = await load();
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(401, { error: 'x', code: 'stale-challenge' });
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    fromTheAccount({ schema: READY });
    fromTheAccount(SIGNED);
    expect(await signing).toMatchObject({ of: m.OF.refused, why: m.REFUSAL.expired });
  });

  /* RED WHEN: too many tries loses the wait the service asked for, the service out of reach is said as a refusal, or signing in without the account's address asks the service anything. */
  it('says too many tries with the wait, a service out of reach, and a page built without the account\'s address', async () => {
    let m = await load();
    answers['/api/auth/wallet/challenge'] = reply(429, { error: 'x', retryAfterSeconds: 120 });
    expect(await m.signIn({ name: 'n', purpose: 'p' })).toEqual({ of: m.OF.refused, why: m.REFUSAL.tooMany, retryAfterSeconds: 120 });
    expect(m.accountFrame.shown()).toBe(false);
    delete answers['/api/auth/wallet/challenge'];
    expect((await m.signIn({ name: 'n', purpose: 'p' })) as { why?: string }).toMatchObject({ why: m.REFUSAL.unreachable });
    calls = [];
    m = await load('');
    expect(await m.signIn({ name: 'n', purpose: 'p' })).toEqual({ of: m.OF.refused, why: m.REFUSAL.notSetUp, retryAfterSeconds: null });
    expect(calls).toEqual([]);
  });

  /*
   * RED WHEN: the account is shown before the challenge has come back, so an
   * account that says it is listening as soon as it loads says so before
   * anything listens, and the sign-in waits out its deadline. The account here
   * says so the moment its frame is pointed at it.
   */
  it('listens before the account can say it is listening', async () => {
    const m = await load();
    m.accountFrame.mount({ get src() { return ''; }, set src(_v: string) { queueMicrotask(() => fromTheAccount({ schema: READY })); }, contentWindow: frameWindow });
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(200, { user: { id: 'u1', name: 'Priya' }, created: false });
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    expect(posted.length).toBe(1);
    fromTheAccount(SIGNED);
    expect((await signing).of).toBe(m.OF.signedIn);
  });

  /* RED WHEN: stopping the wait does not end the sign-in in flight as the person stopping, or leaves the account on screen. */
  it('ends the sign-in when the person stops waiting', async () => {
    const m = await load();
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    const seen: boolean[] = [];
    const stop = m.onWaiting((w) => seen.push(w));
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    m.stopWaiting();
    expect(await signing).toMatchObject({ of: m.OF.refused, why: m.REFUSAL.gaveUp });
    expect(m.accountFrame.shown()).toBe(false);
    expect(seen).toEqual([true, false]);
    stop();
  });
});

describe('who is signed in', () => {
  /*
   * RED WHEN: nobody signed in, the service out of reach, and companies that
   * cannot be listed together are not told apart; or a company is read for
   * more than the chain publishes of it, or a row that is not one is kept.
   */
  it('tells nobody, out of reach and records kept apart from a person, and reads each company for what may be shown', async () => {
    const m = await load();
    answers['/api/me'] = reply(401, { error: 'not signed in' });
    expect(await m.whoIsSignedIn()).toEqual({ of: m.OF.nobody });
    answers['/api/me'] = reply(409, { error: 'x', code: 'records-from-more-than-one-ledger' });
    expect(await m.whoIsSignedIn()).toEqual({ of: m.OF.recordsApart });
    delete answers['/api/me'];
    expect(await m.whoIsSignedIn()).toEqual({ of: m.OF.unreachable });
    answers['/api/me'] = reply(200, {
      user: { id: 'u1', email: null, name: 'Priya' },
      accounts: [
        { id: 'c1', createdAt: '2026-09-01T00:00:00.000Z', signerCount: 3, threshold: 2, sealedRoster: { ct: 'x' }, memberUserIds: ['u1'] },
        { id: 'c2', createdAt: 5, signerCount: 1, threshold: 1 },
      ],
    });
    expect(await m.whoIsSignedIn()).toEqual({
      of: m.OF.signedIn, person: { id: 'u1', name: 'Priya' },
      companies: [{ id: 'c1', createdAt: '2026-09-01T00:00:00.000Z', signers: 3, approvalsNeeded: 2 }],
    });
  });
});

describe('another person signed in, in another tab', () => {
  /* RED WHEN: a refusal because somebody else signed in, in another tab, is said as records kept apart, or the tab goes on being sent as the person it was prepared for. */
  it('asks again for whoever is signed in now, and is prepared for them', async () => {
    const m = await load();
    answers['/api/me'] = reply(200, { user: { id: 'u1', name: 'Priya' }, accounts: [] });
    await m.whoIsSignedIn();
    let first = true;
    answers['/api/me'] = () => {
      if (first) { first = false; return reply(409, { error: 'x', code: 'another-person' })(); }
      return reply(200, { user: { id: 'u2', name: 'Sam' }, accounts: [] })();
    };
    expect(await m.whoIsSignedIn()).toEqual({ of: m.OF.signedIn, person: { id: 'u2', name: 'Sam' }, companies: [] });
    expect(calls.slice(-2).map((c) => c.headers['x-signed-in-as'])).toEqual(['u1', undefined]);
    await m.whoIsSignedIn();
    expect(calls.at(-1)!.headers['x-signed-in-as']).toBe('u2');
  });
});

describe('signing out', () => {
  /* RED WHEN: a sign-out the service did not confirm is said as done, or a later request is still sent as the person. */
  it('says whether the service ended the sign-in, and stops sending the person', async () => {
    const m = await load();
    answers['/api/me'] = reply(200, { user: { id: 'u1', name: 'Priya' }, accounts: [] });
    await m.whoIsSignedIn();
    expect(await m.signOut()).toEqual({ of: m.OF.notConfirmed });
    answers['/api/auth/logout'] = reply(200, { ok: true });
    expect(await m.signOut()).toEqual({ of: m.OF.signedOut });
    answers['/api/me'] = reply(401, {});
    await m.whoIsSignedIn();
    expect(calls.at(-1)!.headers['x-signed-in-as']).toBeUndefined();
  });
});
