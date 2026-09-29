// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk, type KeyringRequest } from 'midnight-identity/profile/request';
import { keyringReleaseFor } from 'midnight-identity/profile/unlock';

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
    return (a as (init: RequestInit) => Response | Promise<Response>)(init);
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

describe('the shared keyring is told who signed in', () => {
  /*
   * RED WHEN: the service's answer to the sign-in is not handed to the keyring,
   * or is handed without its address, so the keyring cannot ask the account
   * for the key a person's first keys are saved under; or an answer it will not
   * take leaves it holding an earlier person.
   */
  it('hands the keyring the answer to the sign-in, address and all', async () => {
    const m = await load();
    const keyring = await import('vaults-web-shared/keyring.js');
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(200, { user: { id: 'u1', email: null, name: 'Priya' }, address: 'mn_addr_a', created: true });
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    fromTheAccount({ schema: READY });
    fromTheAccount(SIGNED);
    await signing;
    expect(keyring.currentUser()?.id).toBe('u1');
    expect(keyring.signedInWallet()).toBe('mn_addr_a');
    /* An answer with no address: signed in, and the keyring knows nobody rather than the person before. */
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(200, { user: { id: 'u2', name: 'Sam' }, created: false });
    const again = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    fromTheAccount({ schema: READY });
    fromTheAccount(SIGNED);
    expect((await again).of).toBe(m.OF.signedIn);
    expect(keyring.currentUser()).toBeNull();
    expect(keyring.signedInWallet()).toBeNull();
  });

  /* RED WHEN: the keyring keeps a person's keys after they sign out, after the service says nobody is signed in, or once somebody else has signed in in another tab. */
  it('has the keyring forget when the person goes, and when somebody else is signed in now', async () => {
    const m = await load();
    const keyring = await import('vaults-web-shared/keyring.js');
    const signInAs = (id: string) => keyring.signedInByAnotherScreen({ user: { id, email: null, name: 'x' }, address: 'mn_addr_a' });
    signInAs('u1');
    answers['/api/me'] = reply(200, { user: { id: 'u1', name: 'Priya' }, accounts: [] });
    await m.whoIsSignedIn();
    expect(keyring.currentUser()?.id).toBe('u1');
    answers['/api/me'] = reply(200, { user: { id: 'u2', name: 'Sam' }, accounts: [] });
    await m.whoIsSignedIn();
    expect(keyring.currentUser()).toBeNull();
    signInAs('u2');
    answers['/api/me'] = reply(401, {});
    await m.whoIsSignedIn();
    expect(keyring.currentUser()).toBeNull();
    signInAs('u2');
    answers['/api/auth/logout'] = reply(200, { ok: true });
    await m.signOut();
    expect(keyring.currentUser()).toBeNull();
  });
});

describe('the address a sign-in was for, across a reload of the tab', () => {
  const KEPT = 'private-vaults.signed-in-as';
  beforeEach(() => { window.sessionStorage.clear(); });

  async function signInAs(m: Awaited<ReturnType<typeof load>>, body: Record<string, unknown>) {
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(200, body);
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    fromTheAccount({ schema: READY });
    fromTheAccount(SIGNED);
    expect((await signing).of).toBe(m.OF.signedIn);
  }

  /*
   * RED WHEN: the address the sign-in was for is not kept in the tab, is kept
   * for a person other than the one signed in, or is not handed back to the
   * keyring when a reloaded tab picks the sign-in up; so a person creating
   * their first company after a reload must sign in again.
   */
  it('is kept at the sign-in and handed back to the keyring after a reload', async () => {
    await signInAs(await load(), { user: { id: 'u1', email: null, name: 'Priya' }, address: 'mn_addr_a', created: true });
    expect(JSON.parse(window.sessionStorage.getItem(KEPT)!)).toEqual({ personId: 'u1', address: 'mn_addr_a' });
    /* The reload: every module, the keyring among them, starts again knowing nobody. */
    await load();
    const keyring = await import('vaults-web-shared/keyring.js');
    const { keyringFor } = await import('./keyring-person.js');
    expect(keyring.signedInWallet()).toBeNull();
    answers['/api/me'] = reply(200, { user: { id: 'u1', email: null, name: 'Priya' }, accounts: [] });
    expect(await keyringFor('u1')).toBe(true);
    expect(keyring.signedInWallet()).toBe('mn_addr_a');
  });

  /* RED WHEN: what was kept outlives the sign-in: it stays after the person signs out, after the service says nobody is signed in, or after a sign-in whose answer carried no address. */
  it('goes when the sign-in goes', async () => {
    const m = await load();
    const person = { user: { id: 'u1', email: null, name: 'Priya' }, address: 'mn_addr_a', created: false };
    await signInAs(m, person);
    answers['/api/auth/logout'] = reply(500, { error: 'x' });
    await m.signOut();
    expect(window.sessionStorage.getItem(KEPT)).toBeNull();
    await signInAs(m, person);
    answers['/api/me'] = reply(401, {});
    await m.whoIsSignedIn();
    expect(window.sessionStorage.getItem(KEPT)).toBeNull();
    await signInAs(m, person);
    await signInAs(m, { user: { id: 'u2', email: null, name: 'Sam' }, created: false });
    expect(window.sessionStorage.getItem(KEPT)).toBeNull();
  });

  /* RED WHEN: an address kept for one person is handed to the keyring as the address of another signed in since. */
  it('is not taken for anybody else', async () => {
    await signInAs(await load(), { user: { id: 'u1', email: null, name: 'Priya' }, address: 'mn_addr_a', created: true });
    await load();
    const keyring = await import('vaults-web-shared/keyring.js');
    const { keyringFor } = await import('./keyring-person.js');
    answers['/api/me'] = reply(200, { user: { id: 'u2', email: null, name: 'Sam' }, accounts: [] });
    expect(await keyringFor('u2')).toBe(true);
    expect(keyring.signedInWallet()).toBeNull();
  });
});

describe('a company one person left unfinished is never handed to the next', () => {
  const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
  /** Where this page is served, as the account is told. */
  const US = 'https://payroll.example';
  const identity = identityFromWords(TEST_MNEMONIC);
  /** The person's account, answering the keyring's ask for the key their keys are saved under, as the account's own code does. */
  class AccountStandIn {
    private handler: ((event: MessageEvent) => void) | null = null;
    private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
    open(): Window | null { return this.tab as unknown as Window; }
    addEventListener(_t: 'message', h: (e: MessageEvent) => void): void { this.handler = h; queueMicrotask(() => this.deliver({ schema: READY_PING })); }
    removeEventListener(): void { this.handler = null; }
    setTimeout(): number { return 0; }
    clearTimeout(): void { /* nothing to clear */ }
    private deliver(data: unknown): void { this.handler?.({ origin: ACCOUNT, source: this.tab, data } as unknown as MessageEvent); }
    private onAsk(message: unknown): void {
      let answer: unknown;
      try { answer = keyringReleaseFor(identity, parseAsk(message, US, Date.now()) as KeyringRequest, Date.now(), (a) => a === ADDRESS); } catch { answer = { schema: 'nothing-given' }; }
      queueMicrotask(() => this.deliver(answer));
    }
  }

  /** Person u1 has created a company whose keys the service refused to save, so it waits in this tab. */
  async function aCompanyLeftUnfinished() {
    const m = await load();
    const keyring = await import('vaults-web-shared/keyring.js');
    keyring.signedInByAnotherScreen({ user: { id: 'u1', email: null, name: 'Priya' }, address: ADDRESS, created: true });
    answers['/api/me/keys'] = (init?: RequestInit) => (init?.method === 'PUT' ? reply(500, { error: 'x' }) : reply(200, { keyBundle: null, version: 0 }))();
    answers['/api/accounts'] = reply(200, { account: { id: 'acc_1' }, secrets: [{ signerId: 's1', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32), scope: 'ab'.repeat(32) }] });
    await expect(keyring.createCompanyWithWallet({ name: 'Acme', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1 }, ACCOUNT, new AccountStandIn(), US)).rejects.toThrow();
    expect(keyring.companyAwaitingSetup()).toBe('acc_1');
    return { m, keyring };
  }

  /* RED WHEN: a sign-out the service did not confirm leaves the person's keys, or a company they left unfinished, open in the tab. */
  it('forgets them when the person signs out, whether or not the service confirms it', async () => {
    const { m, keyring } = await aCompanyLeftUnfinished();
    answers['/api/auth/logout'] = reply(500, { error: 'x' });
    expect(await m.signOut()).toEqual({ of: m.OF.notConfirmed });
    expect(keyring.companyAwaitingSetup()).toBeNull();
    expect(keyring.currentUser()).toBeNull();
  });

  /* RED WHEN: somebody else signing in in the same tab is handed a company another person left unfinished, and could save its keys as their own. */
  it('forgets them when somebody else signs in in the same tab', async () => {
    const { m, keyring } = await aCompanyLeftUnfinished();
    answers['/api/auth/wallet/challenge'] = reply(200, CHALLENGE);
    answers['/api/auth/wallet'] = reply(200, { user: { id: 'u2', email: null, name: 'Sam' }, address: 'mn_addr_other', created: true });
    const signing = m.signIn({ name: 'n', purpose: 'p' });
    await settle();
    fromTheAccount({ schema: READY });
    fromTheAccount(SIGNED);
    expect((await signing).of).toBe(m.OF.signedIn);
    expect(keyring.currentUser()?.id).toBe('u2');
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });
});
