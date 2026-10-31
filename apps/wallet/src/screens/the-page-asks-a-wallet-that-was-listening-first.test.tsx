// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * **OPENING A COMPANY ASKS THE WALLET EVEN WHEN THE WALLET WAS READY FIRST.** The page's own open press
 * (`openKeysWithWallet`, naming the company) talks to the wallet's own window screen (`ApproveEntry`, over the wallet's
 * channel), framed by the page. The wallet says it is listening once, as soon as it has loaded, and here it loads
 * before the page has finished reading what it hands the wallet: the page must still send its ask. When the page's
 * preparing stops, the window shows the page's reason and the page writes which step it stopped at. The service is
 * stood in for by its answers; the passkey calls are stood in for and never reached.
 */

vi.hoisted(() => { process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example'; });

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { ApproveEntry } from './approve-entry.js';
import { SessionProvider } from '../session.js';
import * as keyring from '../../../../packages/web-shared/src/keyring.js';
import type { Openable, WalletDialog } from '../../../../packages/web-shared/src/wallet-sign-in.js';

const PAGE = 'https://app.payroll.example';
const WALLET = 'https://identity.payroll.example';
const PERSON = 'usr_a';
const COMPANY = 'acc_0123456789ab';
const ACCOUNT = 'c0'.repeat(32);
const LABEL = drawCompanyLabel();

/** What the page posted into the wallet's window, in order. */
let reachedTheWallet: Array<Record<string, unknown>> = [];
/** Resolved once the wallet has said it is listening and the page has been handed that message. */
let walletListening: Promise<void> = Promise.resolve();
let heardTheWallet: () => void = () => {};
const dialogs: WalletDialog[] = [];
let stopWatching: () => void = () => {};

/** The service's answers; the saved keys are answered only once the wallet has said it is listening. */
function theService(keys: 'answer' | 'refuse'): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case 'GET /api/me': return json(200, { user: { id: PERSON, email: null, name: 'Priya' } });
      case 'GET /api/me/keys':
        await walletListening;
        return keys === 'answer' ? json(200, { keyBundle: null, version: 0 }) : json(500, { error: 'the store did not answer' });
      case 'GET /api/accounts': return json(200, []);
      case `POST /api/accounts/${COMPANY}/unlock`: return json(200, { company: LABEL, account: ACCOUNT });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
}

/**
 * The page's window, whose frame loads the wallet's own window screen as soon as the page points it at the wallet.
 * Messages cross in both directions on the next turn, as a browser delivers them.
 */
function aPageWithItsWalletFrame(): Openable {
  const pageHandlers = new Set<(e: MessageEvent) => void>();
  const walletHandlers = new Set<(e: MessageEvent) => void>();
  const frameWindow = {};
  const parent = {
    postMessage: (m: unknown, target: string) => {
      if (target !== PAGE) return;
      setTimeout(() => {
        for (const h of [...pageHandlers]) h({ origin: WALLET, source: frameWindow, data: m } as unknown as MessageEvent);
        heardTheWallet();
      }, 0);
    },
  };
  const walletView = {
    opener: null,
    parent,
    self: undefined as unknown,
    location: { ancestorOrigins: [PAGE] },
    addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { walletHandlers.add(h); },
    removeEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { walletHandlers.delete(h); },
  };
  walletView.self = walletView;
  let shut = false;
  return {
    open: () => {
      setTimeout(() => {
        render(
          <SessionProvider>
            <ApproveEntry phase={{ name: 'welcome' }} entry={null} view={walletView as unknown as ChannelWindow} embedder={PAGE} />
          </SessionProvider>,
        );
      }, 0);
      return {
        postMessage: (m: unknown, target: string) => {
          if (target !== WALLET) return;
          reachedTheWallet.push(m as Record<string, unknown>);
          setTimeout(() => {
            act(() => { for (const h of [...walletHandlers]) h({ origin: PAGE, source: parent, data: m } as unknown as MessageEvent); });
          }, 0);
        },
        messageSource: frameWindow,
        close: () => { shut = true; },
        get closed(): boolean { return shut; },
      };
    },
    addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { pageHandlers.add(h); },
    removeEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { pageHandlers.delete(h); },
    setTimeout: (h: () => void, ms: number) => setTimeout(h, ms) as unknown as number,
    clearTimeout: (id: number) => { clearTimeout(id); },
  };
}

const realFetch = globalThis.fetch;
const consoleWas = console.warn;
let written: string[] = [];
beforeEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  keyring.forgetLocally();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  reachedTheWallet = [];
  walletListening = new Promise<void>((heard) => { heardTheWallet = heard; });
  dialogs.length = 0;
  stopWatching = keyring.onWalletWaiting((d) => { if (d !== null) dialogs.push(d); });
  written = [];
  vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
  console.warn = (line: unknown) => { written.push(String(line)); };
});
afterEach(() => {
  for (const d of dialogs) d.giveUp();
  stopWatching();
  console.warn = consoleWas;
  vi.unstubAllEnvs();
  cleanup();
});

describe('opening a company from its pages, with the wallet listening before the page asks', () => {
  it('sends the wallet the ask to open the company, and the window shows it', async () => {
    theService('answer');
    await keyring.resumeSession(null);
    const opening = keyring.openKeysWithWallet(WALLET, aPageWithItsWalletFrame(), PAGE, undefined, COMPANY);
    opening.catch(() => {});
    await walletListening;
    /* RED WHEN: the page misses the wallet saying it is listening while it is still reading what to hand over, so it never sends the ask and the window waits for a request that never comes. */
    await waitFor(() => expect(reachedTheWallet.map((m) => [m['kind'], m['company']])).toEqual([['keyring', LABEL]]), { timeout: 3000 });
    /* RED WHEN: the window keeps saying the page is still preparing after the ask has reached it. */
    await waitFor(() => expect(document.querySelector('[data-no-wallet-for-a-request]')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('[data-waiting-for-ask]')).toBeNull();
  });

  it('that stops before asking shows the page\'s reason in the window and writes the step it stopped at', async () => {
    theService('refuse');
    await keyring.resumeSession(null);
    const opening = keyring.openKeysWithWallet(WALLET, aPageWithItsWalletFrame(), PAGE, undefined, COMPANY);
    const ended = opening.then(() => null, (e: unknown) => e);
    expect(await ended).toBeInstanceOf(Error);
    /* RED WHEN: the window is left saying the page is still preparing, instead of why the page did not ask. */
    await waitFor(() => expect(document.querySelector('[data-page-did-not-ask]')?.textContent).toMatch(/could not read your saved keys/u), { timeout: 3000 });
    expect(document.querySelector('[data-waiting-for-ask]')).toBeNull();
    expect(reachedTheWallet.map((m) => m['kind'] ?? null)).toEqual([null]);
    /* RED WHEN: the page gives up without writing which preparing step it was on and why it stopped. */
    expect(written.filter((l) => l.startsWith('read opening a company: stopped'))).toEqual([
      'read opening a company: stopped while reading your saved keys from the service (ServiceRefused), before anything was asked of the wallet',
    ]);
    /* RED WHEN: a line the page writes while preparing carries the company's account address or its label. */
    expect(written.filter((l) => l.includes(ACCOUNT) || l.includes(LABEL))).toEqual([]);
  });
});
