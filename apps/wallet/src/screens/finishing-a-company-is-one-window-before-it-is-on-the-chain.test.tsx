// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * **FINISHING A COMPANY IS ONE WINDOW, BEFORE THE COMPANY IS ON THE CHAIN.** The page's own second press
 * (`finishCompanyInTheWallet`, as a fresh page after a reload calls it) builds the ask it sends; that very message is
 * handed to the whole wallet, mounted locked over real storage in a window the page opened, which routes it to the
 * window it shows before the passkey. Only the passkey call and its verification are stood in for.
 */

vi.hoisted(() => { process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example'; });

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return { ...actual, verifyRegistration: vi.fn(), verifyAssertion: vi.fn() };
});

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { PROGRESS_SCHEMA, READY_PING } from 'midnight-identity/profile/channel';
import { App } from '../app.js';
import { SessionProvider } from '../session.js';
import { forgetApprovalBeforeThePasskey } from '../framing.js';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { savePasskey, saveSecret, saveWalletName } from '../accounts/storage.js';
import * as keyring from '../../../../packages/web-shared/src/keyring.js';
import type { Openable } from '../../../../packages/web-shared/src/wallet-sign-in.js';

const PAGE = 'https://app.payroll.example';
const WALLET = 'https://identity.payroll.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const COMPANY = 'acc_0123456789ab';
const LABEL = drawCompanyLabel();

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId, personHandle: 'person-1', publicKeySpki: new Uint8Array([1, 2, 3]), algorithm: -7, signCount: 0,
  provenBySignIn: false, rpId: 'localhost', syncsToACloud: false, backedUpNow: false, transports: [],
});
const putWallet = async (): Promise<void> => {
  const secret = newSecret();
  const id = await saveSecret(secret);
  saveWalletName(secret, 'Everyday');
  savePasskey(passkeyFixture('cred-a'), id);
};

/** The page's side of the window: it keeps the first ask the page's own code sends, and answers nothing. */
function thePagesAsk(): { view: Openable; asked: Promise<Record<string, unknown>> } {
  let handler: ((e: MessageEvent) => void) | null = null;
  let got: (m: Record<string, unknown>) => void = () => {};
  const asked = new Promise<Record<string, unknown>>((r) => { got = r; });
  const tab = { postMessage: (m: unknown) => { got(m as Record<string, unknown>); }, closed: false, close: () => {} };
  const view = {
    open: () => tab,
    addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => {
      handler = h;
      queueMicrotask(() => handler?.({ origin: WALLET, source: tab, data: { schema: READY_PING } } as unknown as MessageEvent));
    },
    removeEventListener: () => { handler = null; },
    setTimeout: () => 0,
    clearTimeout: () => {},
  } as unknown as Openable;
  return { view, asked };
}

/** The service as a fresh page reads it at step 2: the company is recorded, its account not yet on the chain. */
const theServiceAtStepTwo = (): void => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case `POST /api/accounts/${COMPANY}/unlock`: return json(200, { company: LABEL, account: null });
      case 'GET /api/me/keys': return json(200, { keyBundle: null, version: 0 });
      case 'GET /api/accounts': return json(200, []);
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
};

/* The window the page opened, delivering the page's ask whenever the wallet says it is listening. */
let asking: Record<string, unknown> | null = null;
const opener = {
  postMessage: (message: unknown) => {
    if ((message as { schema?: unknown }).schema === READY_PING && asking !== null) {
      const sending = asking;
      setTimeout(() => {
        const event = new Event('message');
        Object.defineProperties(event, { data: { value: sending }, origin: { value: PAGE }, source: { value: opener } });
        window.dispatchEvent(event);
      }, 0);
    }
  },
};

const realFetch = globalThis.fetch;
beforeEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  keyring.forgetLocally();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  forgetApprovalBeforeThePasskey();
  asking = null;
  window.location.hash = '#/approve';
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
});

describe('finishing a company not yet on the chain', () => {
  it('opens the one Finish window, whose Approve can be pressed, and not a window that waits for the chain', async () => {
    await putWallet();
    theServiceAtStepTwo();
    keyring.signedInByAnotherScreen({ user: { id: 'usr_a', email: null, name: 'Priya' }, address: ADDRESS, created: true, session: {} });
    const page = thePagesAsk();
    void keyring.finishCompanyInTheWallet(COMPANY, WALLET, {}, page.view, PAGE).catch(() => {});
    asking = await page.asked;
    expect([asking['kind'], (asking['intent'] as Record<string, unknown>)['name']]).toEqual(['act', 'finish-company']);

    render(<SessionProvider><App /></SessionProvider>);
    await waitFor(() => expect(document.querySelector('[data-ask-window="act"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-what-it-does], [data-act-shown], [data-shown-from]')).not.toBeNull());
    /* RED WHEN: the window before the passkey holds the Finish action to a check of the company's account on the chain, which Finish itself deploys, so it can never be approved. */
    expect(document.querySelector('[data-no-account-yet]')).toBeNull();
    await waitFor(() => expect((document.querySelector('[data-approve-window]') as HTMLButtonElement).disabled).toBe(false));
  });

  it('still holds an action on a company named by its account to the chain\'s word, which this one cannot give', async () => {
    await putWallet();
    globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch;
    asking = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { name: 'Payroll', rdns: 'example.payroll' },
      purpose: 'To give your seat the keys to the company\'s vaults.', nonce: 'act-vault-keys', expiresAt: Date.now() + 20 * 60_000,
      progress: PROGRESS_SCHEMA,
      intent: { name: 'give-vault-keys', record: COMPANY, company: LABEL, account: 'c0'.repeat(32) },
    };
    render(<SessionProvider><App /></SessionProvider>);
    await waitFor(() => expect(document.querySelector('[data-ask-window="act"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-company-check="checking"]')).toBeNull());
    /* RED WHEN: the window lets an action on a company that names its account be approved without reading that account's label on the chain. */
    expect(document.querySelector('[data-company-section]')).not.toBeNull();
    expect((document.querySelector('[data-approve-window]') as HTMLButtonElement).disabled).toBe(true);
  });
});
