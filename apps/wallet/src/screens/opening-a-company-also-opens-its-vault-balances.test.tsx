// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * **OPENING A COMPANY OPENS ITS VAULT BALANCES IN THE SAME WINDOW.** The page's own open press
 * (`openKeysWithWallet`, naming the company on screen) talks to the whole wallet, mounted locked over real storage in
 * a window the page opened: every message the page sends reaches the wallet, and every message the wallet sends reaches
 * the page, which takes the answer in as it does in use. The chain's answer to which label an account carries is stood
 * in for, as the company's account stands; the passkey call and its verification are stood in for.
 */

vi.hoisted(() => { process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example'; });

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

/* What the chain says each account carries. */
/* How each read after the first `answered` reads comes back: as the account stands, never, or failing. */
const chain = vi.hoisted(() => ({ carries: new Map<string, string>(), answered: Infinity, then: 'never' as 'never' | 'fails', reads: 0 }));
vi.mock('../chain/company-label-on-chain.js', async (real) => ({
  ...(await real<typeof import('../chain/company-label-on-chain.js')>()),
  labelOnAccount: async (account: string) => {
    chain.reads += 1;
    if (chain.reads > chain.answered) {
      if (chain.then === 'fails') throw new Error('the indexer did not answer');
      return new Promise(() => {});
    }
    const label = chain.carries.get(account);
    return label === undefined ? { of: 'no-account' } : { of: 'carries', label };
  },
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return { ...actual, verifyRegistration: vi.fn(), verifyAssertion: vi.fn() };
});

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { READY_PING } from 'midnight-identity/profile/channel';
import en from '../locales/en.json';
import { App } from '../app.js';
import { SessionProvider } from '../session.js';
import { forgetApprovalBeforeThePasskey } from '../framing.js';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { savePasskey, saveSecret, saveWalletName } from '../accounts/storage.js';
import * as keyring from '../../../../packages/web-shared/src/keyring.js';
import { sealKeyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { Openable } from '../../../../packages/web-shared/src/wallet-sign-in.js';
import { savedKeysSealKey } from '../../../../src/testing/a-wallet-founds-a-company.js';

const PAGE = 'https://app.payroll.example';
const WALLET = 'https://identity.payroll.example';
const PERSON = 'usr_a';
const COMPANY = 'acc_0123456789ab';
const ACCOUNT = 'c0'.repeat(32);
const LABEL = drawCompanyLabel();
const OTHER = 'acc_ba9876543210';
const mockUsePasskey = vi.mocked(usePasskey);
const mockVerifyAssertion = vi.mocked(verifyAssertion);

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId, personHandle: 'person-1', publicKeySpki: new Uint8Array([1, 2, 3]), algorithm: -7, signCount: 0,
  provenBySignIn: false, rpId: 'localhost', syncsToACloud: false, backedUpNow: false, transports: [],
});
const passkeyAnswers = (credentialId: string): void => {
  mockUsePasskey.mockResolvedValueOnce({
    credentialId, clientDataJSON: new Uint8Array(), authenticatorData: new Uint8Array(), signature: new Uint8Array(),
    userHandle: 'cGVyc29uLTE',
  } as never);
  mockVerifyAssertion.mockResolvedValueOnce({ passkey: passkeyFixture(credentialId) } as never);
};

/** The service as the page reads it: the person, their saved keys sealed under their wallet's key, and the company. */
function theService(secret: Uint8Array, account: string | null): void {
  const key = savedKeysSealKey(identityFromSecret(secret as never) as never, { requester: { origin: PAGE, name: 'x', rdns: 'x' }, person: PERSON } as never);
  let saved = { bundle: sealKeyring({ accounts: {}, counter: 1 } as never, key as never).sealed as unknown, version: 1 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case 'GET /api/me': return json(200, { user: { id: PERSON, email: null, name: 'Priya' } });
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys': {
        const body = JSON.parse(String(init!.body));
        saved = { bundle: body.keyBundle, version: saved.version + 1 };
        return json(200, { version: saved.version });
      }
      case 'GET /api/accounts': return json(200, []);
      case `POST /api/accounts/${COMPANY}/unlock`: return json(200, { company: LABEL, account });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
}

/* The page and the wallet's window, joined: each message one posts reaches the other, as from its own origin. */
const pageHandlers = new Set<(e: MessageEvent) => void>();
let asks: Array<Record<string, unknown>> = [];
const tab = {
  postMessage: (m: unknown) => {
    asks.push(m as Record<string, unknown>);
    setTimeout(() => {
      const event = new Event('message');
      Object.defineProperties(event, { data: { value: m }, origin: { value: PAGE }, source: { value: opener } });
      window.dispatchEvent(event);
    }, 0);
  },
  closed: false,
  close: () => {},
};
/* Every message the wallet sent the page. */
let said: Array<Record<string, unknown>> = [];
const opener = {
  postMessage: (m: unknown) => {
    said.push(m as Record<string, unknown>);
    setTimeout(() => { for (const h of [...pageHandlers]) h({ origin: WALLET, source: tab, data: m } as unknown as MessageEvent); }, 0);
  },
};
const view = {
  open: () => tab,
  addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => {
    pageHandlers.add(h);
    /* The wallet's window is already listening: it says so to each listener the page adds. */
    setTimeout(() => h({ origin: WALLET, source: tab, data: { schema: READY_PING } } as unknown as MessageEvent), 0);
  },
  removeEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { pageHandlers.delete(h); },
  setTimeout: () => 0,
  clearTimeout: () => {},
} as unknown as Openable;

/** The keyring asks the page sent, each once however often it was sent again to a wallet saying it listens. */
const keyringAsks = (): Array<Record<string, unknown>> =>
  [...new Map(asks.filter((m) => m['kind'] === 'keyring').map((m) => [m['nonce'], m])).values()];

async function aWallet(): Promise<Uint8Array> {
  const secret = newSecret();
  const id = await saveSecret(secret);
  saveWalletName(secret, 'Everyday');
  savePasskey(passkeyFixture('cred-a'), id);
  return secret as unknown as Uint8Array;
}

/** The page's open press on the company's pages, answered through the locked wallet's one window. */
async function openTheCompany(): Promise<{ released: string[]; alsoSaid: string | null }> {
  const released: string[] = [];
  const stop = keyring.watchCompanyKeyReleased((id) => { released.push(id); });
  const pressed = await pressOpen();
  await waitFor(() => expect(pressed.settled()).toBe(true), { timeout: 8000 });
  await pressed.opening;
  stop();
  return { released, alsoSaid: pressed.alsoSaid };
}

/** The open press, up to the person pressing Approve in the window once it can be pressed. */
async function pressOpen(): Promise<{ opening: Promise<void>; settled: () => boolean; alsoSaid: string | null }> {
  render(<SessionProvider><App /></SessionProvider>);
  await keyring.resumeSession(null);
  let settled = false;
  const opening = keyring.openKeysWithWallet(WALLET, view, PAGE, undefined, COMPANY).finally(() => { settled = true; });
  opening.catch(() => {});
  await waitFor(() => expect(document.querySelector('[data-ask-window="keyring"]')).not.toBeNull());
  await waitFor(() => expect(document.querySelector('[data-company-check="checking"]')).toBeNull());
  const approve = document.querySelector('[data-approve-window]') as HTMLButtonElement;
  await waitFor(() => expect(approve.disabled).toBe(false));
  const alsoSaid = document.querySelector('[data-also-company]')?.textContent ?? null;
  passkeyAnswers('cred-a');
  fireEvent.click(approve);
  return { opening, settled: () => settled, alsoSaid };
}

/** The keyring answers the wallet sent the page. */
const releases = (): Array<Record<string, unknown>> => said.filter((m) => m['schema'] === 'midnight-identity/keyring-release/v1');

const realFetch = globalThis.fetch;
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockUsePasskey.mockReset();
  mockVerifyAssertion.mockReset();
  globalThis.fetch = realFetch;
  keyring.forgetLocally();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  forgetApprovalBeforeThePasskey();
  chain.carries.clear();
  chain.answered = Infinity;
  chain.then = 'never';
  chain.reads = 0;
  said = [];
  pageHandlers.clear();
  asks = [];
  window.location.hash = '#/approve';
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
});

describe('opening a company on its pages', () => {
  it('on the chain, opens the saved keys and the company\'s vault balances in one window and one passkey', async () => {
    theService(await aWallet(), ACCOUNT);
    chain.carries.set(ACCOUNT, LABEL);
    const { released, alsoSaid } = await openTheCompany();
    /* RED WHEN: the open press asks for the saved keys alone, so reading the vault's private balance needs another window. */
    expect(keyringAsks().map((m) => [m['company'], m['account']])).toEqual([[LABEL, ACCOUNT]]);
    /* RED WHEN: the window does not say, before the passkey, what the company's key lets the page do. */
    expect(alsoSaid).toBe(en['ask.keyring.also-company']);
    expect(mockUsePasskey).toHaveBeenCalledTimes(1);
    expect(keyring.canOpenCompanies()).toBe(true);
    /* RED WHEN: the company's read key is not taken in, or the vault page is not told it can read now. */
    expect(keyring.companyKeyReleasedFor(COMPANY)).not.toBeNull();
    expect(released).toEqual([COMPANY]);
    /* RED WHEN: a key for a company the press did not name is released with it. */
    expect(keyring.companyKeyReleasedFor(OTHER)).toBeNull();
  });

  it('not yet on the chain, opens the saved keys and releases no company key, with nothing in the way', async () => {
    theService(await aWallet(), null);
    const { released } = await openTheCompany();
    /* RED WHEN: a company with no account on the chain is named in the ask, or keeps the keys from opening. */
    expect(keyringAsks().map((m) => m['company'] ?? null)).toEqual([null]);
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.companyKeyReleasedFor(COMPANY)).toBeNull();
    expect(released).toEqual([]);
  });

  it('whose account the chain does not show carrying its label, opens the saved keys and releases nothing else', async () => {
    theService(await aWallet(), ACCOUNT);
    chain.carries.set(ACCOUNT, drawCompanyLabel());
    const { released } = await openTheCompany();
    /* RED WHEN: a company the wallet's chain check does not confirm has its key released, or blocks the keys from opening. */
    expect(keyringAsks().map((m) => m['company'])).toEqual([LABEL]);
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.companyKeyReleasedFor(COMPANY)).toBeNull();
    expect(released).toEqual([]);
  });

  it('while the chain is still being read, holds Approve in the window and answers nothing', async () => {
    theService(await aWallet(), ACCOUNT);
    chain.carries.set(ACCOUNT, LABEL);
    chain.answered = 0;
    render(<SessionProvider><App /></SessionProvider>);
    await keyring.resumeSession(null);
    let settled = false;
    void keyring.openKeysWithWallet(WALLET, view, PAGE, undefined, COMPANY).finally(() => { settled = true; }).catch(() => {});
    await waitFor(() => expect(document.querySelector('[data-company-check="checking"]')).not.toBeNull());
    const approve = document.querySelector('[data-approve-window]') as HTMLButtonElement;
    passkeyAnswers('cred-a');
    fireEvent.click(approve);
    await new Promise((r) => { setTimeout(r, 500); });
    /* RED WHEN: the window lets the keys be given before the wallet has read the company's account on the chain. */
    expect(approve.disabled).toBe(true);
    expect(mockUsePasskey).not.toHaveBeenCalled();
    expect([releases(), settled]).toEqual([[], false]);
  });

  it('after the passkey, answers nothing until the wallet\'s own read of the chain is done', async () => {
    theService(await aWallet(), ACCOUNT);
    chain.carries.set(ACCOUNT, LABEL);
    chain.answered = 1;
    const pressed = await pressOpen();
    await waitFor(() => expect(mockUsePasskey).toHaveBeenCalledTimes(1));
    await new Promise((r) => { setTimeout(r, 1500); });
    /* RED WHEN: the wallet answers while its own read is still running, giving the saved keys without the company the person opened. */
    expect([releases(), pressed.settled()]).toEqual([[], false]);
    expect(keyring.companyKeyReleasedFor(COMPANY)).toBeNull();
  });

  it('whose chain read fails, opens the saved keys and releases no company key', async () => {
    theService(await aWallet(), ACCOUNT);
    chain.carries.set(ACCOUNT, LABEL);
    chain.answered = 0;
    chain.then = 'fails';
    const { released } = await openTheCompany();
    /* RED WHEN: a chain read that fails releases the company's key, or keeps the saved keys from opening. */
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.companyKeyReleasedFor(COMPANY)).toBeNull();
    expect(released).toEqual([]);
    expect(releases().map((m) => [m['company'], m['companyKey']])).toEqual([[null, null]]);
  });
});
