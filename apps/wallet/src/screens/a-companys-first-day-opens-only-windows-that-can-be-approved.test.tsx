// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * **EVERY WINDOW A COMPANY'S FIRST DAY OPENS CAN BE APPROVED WHEN IT OPENS.** Each step, from a fresh page as after a
 * reload: the page's own calls build the asks they send, in the order the page sends them, and each very message is
 * handed to the whole wallet, mounted locked over real storage in a window the page opened, which routes it to the
 * window it shows before the passkey. The chain's answer to which label an account carries is stood in for, as the
 * company's account stands at that step; the passkey call and its verification are stood in for. What each action does
 * after the passkey is not run here.
 */

vi.hoisted(() => { process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example'; });

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

/* What the chain says the account carries: set by each step to the company's account as it stands then. */
const chain = vi.hoisted(() => ({ carries: new Map<string, string>() }));
vi.mock('../chain/company-label-on-chain.js', async (real) => ({
  ...(await real<typeof import('../chain/company-label-on-chain.js')>()),
  labelOnAccount: async (account: string) => {
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

import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { READY_PING } from 'midnight-identity/profile/channel';
import { App } from '../app.js';
import { SessionProvider } from '../session.js';
import { askWalletForAddressesAndBalances } from '../../../../packages/web-shared/src/wallet-records-key.js';
import { forgetApprovalBeforeThePasskey } from '../framing.js';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { savePasskey, saveSecret, saveWalletName } from '../accounts/storage.js';
import * as keyring from '../../../../packages/web-shared/src/keyring.js';
import type { Openable } from '../../../../packages/web-shared/src/wallet-sign-in.js';

const PAGE = 'https://app.payroll.example';
const WALLET = 'https://identity.payroll.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const COMPANY = 'acc_0123456789ab';
const ACCOUNT = 'c0'.repeat(32);
const VAULT = 'd0'.repeat(32);
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

/** The service as a fresh page reads it: the company recorded, with its account once Finish has deployed it. */
const theService = (account: string | null): void => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case `POST /api/accounts/${COMPANY}/unlock`: return json(200, { company: LABEL, account });
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

/** One window: the ask the page's call sends, shown by the locked wallet; what it is and whether Approve can be pressed. */
async function theWindowFor(call: (view: Openable) => Promise<unknown>): Promise<{ kind: string; intent: string | null; approvable: boolean }> {
  cleanup();
  forgetOpenWallet();
  forgetApprovalBeforeThePasskey();
  const page = thePagesAsk();
  void call(page.view).catch(() => {});
  asking = await page.asked;
  render(<SessionProvider><App /></SessionProvider>);
  const kind = String(asking['kind']);
  await waitFor(() => expect(document.querySelector(`[data-ask-window="${kind}"]`)).not.toBeNull());
  await waitFor(() => expect(document.querySelector('[data-company-check="checking"]')).toBeNull());
  let approvable = false;
  try {
    await waitFor(() => expect((document.querySelector('[data-approve-window]') as HTMLButtonElement).disabled).toBe(false));
    approvable = true;
  } catch { approvable = false; }
  const intent = kind === 'act' ? String((asking['intent'] as Record<string, unknown>)['name']) : null;
  return { kind, intent, approvable };
}

const realFetch = globalThis.fetch;
beforeEach(async () => {
  cleanup();
  globalThis.fetch = realFetch;
  keyring.forgetLocally();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  forgetApprovalBeforeThePasskey();
  chain.carries.clear();
  asking = null;
  window.location.hash = '#/approve';
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
  await putWallet();
  keyring.signedInByAnotherScreen({ user: { id: 'usr_a', email: null, name: 'Priya' }, address: ADDRESS, created: true, session: {} });
});

describe('a company\'s first day, each step from a fresh page', () => {
  it('Finish creating the company opens one window, the action, which can be approved before the account exists', async () => {
    theService(null);
    /* RED WHEN: a window step 2 opens cannot be approved while the company's account is not yet on the chain. */
    expect(await theWindowFor((view) => keyring.finishCompanyInTheWallet(COMPANY, WALLET, {}, view, PAGE))).toEqual(
      { kind: 'act', intent: 'finish-company', approvable: true });
  });

  it('Create vault opens the saved keys, then the action on the company its account carries, each approvable', async () => {
    theService(ACCOUNT);
    chain.carries.set(ACCOUNT, LABEL);
    const named = { record: COMPANY, company: LABEL, account: ACCOUNT };
    /* RED WHEN: a window Create vault opens, after Finish has put the account on the chain, cannot be approved. */
    expect([
      await theWindowFor((view) => keyring.openKeysWithWallet(WALLET, view, PAGE)),
      await theWindowFor((view) => keyring.actOnACompanyInTheWallet({ name: 'give-vault-keys', ...named }, WALLET, {}, view)),
      await theWindowFor((view) => keyring.actOnACompanyInTheWallet({ name: 'create-vault', ...named }, WALLET, {}, view)),
    ]).toEqual([
      { kind: 'keyring', intent: null, approvable: true },
      { kind: 'act', intent: 'give-vault-keys', approvable: true },
      { kind: 'act', intent: 'create-vault', approvable: true },
    ]);
  });

  it('the private deposit opens the account\'s addresses and balances, the company\'s keys, then the action, each approvable', async () => {
    theService(ACCOUNT);
    chain.carries.set(ACCOUNT, LABEL);
    /* RED WHEN: a window the private deposit opens, on a company and vault on the chain, cannot be approved. */
    expect([
      await theWindowFor((view) => askWalletForAddressesAndBalances(view, WALLET, { atOrigin: PAGE, name: 'Payroll', rdns: 'example.payroll' })),
      await theWindowFor((view) => keyring.companyKeysForVaults(COMPANY, WALLET, view, PAGE)),
      await theWindowFor((view) => keyring.privateDepositInTheWallet({
        record: COMPANY, company: LABEL as never, account: ACCOUNT as never, vault: VAULT, token: '00'.repeat(32), units: 5n,
      }, WALLET, {}, view)),
    ]).toEqual([
      { kind: 'addresses-and-balances', intent: null, approvable: true },
      { kind: 'keyring', intent: null, approvable: true },
      { kind: 'act', intent: 'private-deposit', approvable: true },
    ]);
  });
});
