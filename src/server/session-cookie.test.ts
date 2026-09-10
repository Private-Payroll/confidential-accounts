import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';
import {
  ANOTHER_PERSON, CROSS_SITE_WRITE, SESSION_COOKIE, anotherPersonRefusal, answerCarriesToken,
  clearedSessionCookie, cookieScopeFor, credentialOf, crossSiteWriteRefusal, sessionCookie,
  sessionFromCookieHeader,
} from './session-cookie.js';

/**
 * **A SIGN-IN SURVIVES A RELOAD, COVERS BOTH SURFACES, AND CANNOT BE SPENT BY ANOTHER SITE.**
 *
 * The session was a token in one variable in the page's memory, so every
 * reload was another sign-in. It is now a cookie scoped to the site the
 * application and the wallet share. §1 pins the rules one at a time; §2 drives
 * the real server and walks what a browser does: sign in, come back without
 * the token, be refused a write that did not come from the application, sign out.
 */

const APP = 'https://app.payroll.example';
const WALLET = 'https://identity.payroll.example';

describe('§1 - THE RULES', () => {
  it('the cookie belongs to the SITE both surfaces share, never to one host', () => {
    expect(cookieScopeFor(APP, WALLET)).toEqual({ domain: 'payroll.example', secure: true });
    expect(cookieScopeFor('http://app.pp.localhost:5173', 'http://identity.pp.localhost:5180'))
      .toEqual({ domain: 'pp.localhost', secure: false });
  });

  it('one host is left host-only: a browser stores no cookie for a bare `localhost`', () => {
    expect(cookieScopeFor('http://localhost:5173', 'http://localhost:5180'))
      .toEqual({ domain: null, secure: false });
    expect(cookieScopeFor(APP, undefined)).toEqual({ domain: null, secure: true });
  });

  it('two origins with no site in common stop the server rather than scope a session wrongly', () => {
    expect(() => cookieScopeFor('https://app.payroll.example', 'https://identity.other.example'))
      .toThrow(/share only "example"/);
  });

  it('the cookie is HttpOnly, SameSite=Strict, Secure on https, and lives as long as the session', () => {
    const now = Date.parse('2026-09-10T00:00:00Z');
    const set = sessionCookie('t0k', '2026-09-10T01:00:00Z', { domain: 'payroll.example', secure: true }, now);
    expect(set).toBe(`${SESSION_COOKIE}=t0k; Path=/; HttpOnly; SameSite=Strict; Secure; Domain=payroll.example; Max-Age=3600`);
    expect(clearedSessionCookie({ domain: null, secure: false }))
      .toBe(`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  });

  it('the token is read from its own cookie and no other', () => {
    expect(sessionFromCookieHeader(`a=1; ${SESSION_COOKIE}=abc; b=2`)).toBe('abc');
    expect(sessionFromCookieHeader(`x${SESSION_COOKIE}=abc`)).toBe('');
    expect(sessionFromCookieHeader(undefined)).toBe('');
  });

  it('TWO session cookies is no session: a sibling host cannot plant its own beside the real one', () => {
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=planted; ${SESSION_COOKIE}=real`)).toBe('');
    expect(credentialOf({ cookie: `${SESSION_COOKIE}=planted; ${SESSION_COOKIE}=real` }).via).toBe('none');
  });

  it('a trailing slash in the configured origin does not refuse the application\'s own writes', () => {
    expect(crossSiteWriteRefusal({ method: 'POST', via: 'cookie', origin: APP, fetchSite: undefined }, `${APP}/`))
      .toBeNull();
  });

  it('a request prepared for one person is refused on another person\'s session; naming nobody is not judged', () => {
    expect(anotherPersonRefusal('usr_a', 'usr_a')).toBeNull();
    expect(anotherPersonRefusal('usr_a', 'usr_b')).toBe(ANOTHER_PERSON);
    expect(anotherPersonRefusal(undefined, 'usr_b')).toBeNull();
    expect(anotherPersonRefusal('', 'usr_b')).toBeNull();
  });

  it('a bearer header wins over a cookie that rides along', () => {
    expect(credentialOf({ authorization: 'Bearer b', cookie: `${SESSION_COOKIE}=c` }))
      .toEqual({ token: 'b', via: 'bearer' });
    expect(credentialOf({ cookie: `${SESSION_COOKIE}=c` })).toEqual({ token: 'c', via: 'cookie' });
    expect(credentialOf({})).toEqual({ token: '', via: 'none' });
  });

  it('a WRITE on the cookie must come from the application; a read, and a bearer write, are not judged', () => {
    const at = (over: Partial<Parameters<typeof crossSiteWriteRefusal>[0]>) =>
      crossSiteWriteRefusal({ method: 'POST', via: 'cookie', origin: APP, fetchSite: undefined, ...over }, APP);
    expect(at({})).toBeNull();
    expect(at({ origin: 'https://evil.example' })).toBe(CROSS_SITE_WRITE);
    expect(at({ origin: WALLET }), 'a sibling surface is not the application').toBe(CROSS_SITE_WRITE);
    expect(at({ origin: undefined, fetchSite: 'same-origin' })).toBeNull();
    expect(at({ origin: undefined, fetchSite: 'same-site' })).toBe(CROSS_SITE_WRITE);
    expect(at({ origin: undefined, fetchSite: undefined })).toBe(CROSS_SITE_WRITE);
    expect(at({ method: 'GET', origin: 'https://evil.example' })).toBeNull();
    expect(at({ via: 'bearer', origin: 'https://evil.example' })).toBeNull();
    expect(crossSiteWriteRefusal({ method: 'POST', via: 'cookie', origin: APP, fetchSite: undefined }, undefined))
      .toBe(CROSS_SITE_WRITE);
  });

  it('a browser\'s sign-in answer carries no token; a script\'s does', () => {
    expect(answerCarriesToken({ 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(answerCarriesToken({})).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = APP;
process.env.WALLET_ORIGIN = WALLET;
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-session-cookie-')), 'db.json');

const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});
const { app } = await import('./index.js');
const { networkOfThePair } = await import('../midnight/network.js');
const NETWORK = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);
const identity = identityFromWords(TEST_MNEMONIC);

let server: Server;
let base: string;
beforeAll(async () => {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

/** A request the way a browser on the application's page sends one. */
const asTheBrowser = async (
  method: string, path: string, opts: { cookie?: string; origin?: string; body?: unknown } = {},
) => {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': opts.origin === undefined || opts.origin === APP ? 'same-origin' : 'cross-site',
      ...(method === 'GET' ? {} : { origin: opts.origin ?? APP }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') };
};

describe('§2 - WHAT A BROWSER DOES, AGAINST THE REAL SERVER', () => {
  it('signs in, comes back after a reload on the cookie alone, is refused a stranger\'s write, and signs out', async () => {
    const asked = await asTheBrowser('POST', '/api/auth/wallet/challenge');
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const address = addressOfVerifyingKey(signatureVerifyingKey({
      tag: 'schnorr', value: Buffer.from(identity.moneyAt(4).night).toString('hex'),
    }).value, NETWORK);
    const response = mint(identity, 4, {
      origin: APP, nonce: asked.body.nonce, address, at: Date.now(), disclosed: [], declined: [],
      requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
    }).response;
    const signedIn = await asTheBrowser('POST', '/api/auth/wallet', {
      body: { handle: asked.body.handle, nonce: asked.body.nonce, response },
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);

    /* THE BROWSER GETS A COOKIE, SCOPED TO THE SITE, THAT ITS PAGE CANNOT READ - AND NO TOKEN. */
    const set = signedIn.setCookie ?? '';
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=[0-9a-f]{16,}; `));
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Domain=payroll.example');
    expect(signedIn.body.session.token, 'the page was handed the token the cookie hides').toBeUndefined();
    const cookie = set.split(';')[0]!;

    /* THE RELOAD: no token in memory, only what the browser kept. */
    const me = await asTheBrowser('GET', '/api/me', { cookie });
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.user.id).toBe(signedIn.body.user.id);

    /* ANOTHER SITE CANNOT SPEND IT, and neither can the wallet's own surface. */
    for (const origin of ['https://evil.example', WALLET]) {
      const forged = await asTheBrowser('POST', '/api/auth/logout', { cookie, origin });
      expect(forged.status, origin).toBe(403);
      expect(forged.body.error).toBe(CROSS_SITE_WRITE);
    }
    expect((await asTheBrowser('GET', '/api/me', { cookie })).status, 'a refused write ended the session').toBe(200);

    /* SIGNING OUT ENDS THE SESSION AND CLEARS THE COOKIE. */
    const out = await asTheBrowser('POST', '/api/auth/logout', { cookie });
    expect(out.status).toBe(200);
    expect(out.setCookie).toBe(clearedSessionCookie({ domain: 'payroll.example', secure: true }));
    expect((await asTheBrowser('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('a client that is not a browser still signs in with a token and uses it as a bearer', async () => {
    const asked = await fetch(`${base}/api/auth/wallet/challenge`, { method: 'POST' }).then(r => r.json());
    const address = addressOfVerifyingKey(signatureVerifyingKey({
      tag: 'schnorr', value: Buffer.from(identity.moneyAt(5).night).toString('hex'),
    }).value, NETWORK);
    const response = mint(identity, 5, {
      origin: APP, nonce: asked.nonce, address, at: Date.now(), disclosed: [], declined: [],
      requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
    }).response;
    const r = await fetch(`${base}/api/auth/wallet`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: asked.handle, nonce: asked.nonce, response }),
    });
    const body = await r.json();
    expect(typeof body.session.token).toBe('string');
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${body.session.token}` } });
    expect(me.status).toBe(200);
    /* and a bearer write is not judged by where it came from */
    const out = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { authorization: `Bearer ${body.session.token}`, origin: 'https://evil.example' },
    });
    expect(out.status).toBe(200);
  });
});

describe('§3 - ONE BROWSER, TWO PEOPLE, TWO TABS', () => {
  const signIn = async (slot: number) => {
    const asked = await asTheBrowser('POST', '/api/auth/wallet/challenge');
    const address = addressOfVerifyingKey(signatureVerifyingKey({
      tag: 'schnorr', value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
    }).value, NETWORK);
    const response = mint(identity, slot, {
      origin: APP, nonce: asked.body.nonce, address, at: Date.now(), disclosed: [], declined: [],
      requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
    }).response;
    const r = await asTheBrowser('POST', '/api/auth/wallet', { body: { handle: asked.body.handle, nonce: asked.body.nonce, response } });
    return { cookie: (r.setCookie ?? '').split(';')[0]!, id: String(r.body.user.id) };
  };

  it('a tab prepared for A, sending the cookie B\'s sign-in left, is refused - it cannot write A\'s keys under B', async () => {
    const a = await signIn(7);
    const b = await signIn(8);
    expect(a.id).not.toBe(b.id);
    const asB = async (as: string) => {
      const r = await fetch(`${base}/api/me/keys`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: APP,
          cookie: b.cookie, 'x-signed-in-as': as,
        },
        body: JSON.stringify({ keyBundle: { iv: '00', tag: '00', body: '00' }, ifVersion: 0 }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const refused = await asB(a.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('another-person');
    const me = await fetch(`${base}/api/me/keys`, { headers: { cookie: b.cookie, 'x-signed-in-as': b.id } });
    expect(me.status).toBe(200);
  });
});
