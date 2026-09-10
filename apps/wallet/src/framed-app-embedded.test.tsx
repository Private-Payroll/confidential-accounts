// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/* FRAMED BY THE PAGE IT WAS BUILT FOR. */
vi.hoisted(() => {
  process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example';
  Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: () => {} } });
});

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {}, passkeysAvailable: (): boolean => true, createPasskey: vi.fn(), usePasskey: vi.fn(),
}));

import { Buffer as PolyfillBuffer } from 'buffer/';
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;
(globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();

import { App } from './app.js';
import { SessionProvider } from './session.js';
import { savePasskey } from './accounts/storage.js';
import { ORIGINAL_SLOT } from './accounts/wallets-held.js';

/**
 * **INSIDE THE APPLICATION, THE WALLET IS AN APPROVAL AND NOTHING ELSE**, and it
 * draws no bar and no footer of its own - one line naming its own address, which
 * is the only place a framed page can show where it came from.
 */
describe('a wallet inside the page it was built for', () => {
  it('the approval route renders, bare, with the wallet\'s own address on it', () => {
    window.location.hash = '#/approve';
    const { unmount } = render(<SessionProvider><App /></SessionProvider>);
    expect(document.querySelector('[data-framed-refusal]')).toBeNull();
    expect(document.querySelector('[data-framed]')).not.toBeNull();
    expect(document.querySelector('header.topbar')).toBeNull();
    expect(document.querySelector('[data-framed-origin]')?.textContent).toContain('https://identity.payroll.example');
    unmount();
  });

  for (const hash of ['#/settings', '#/recover', '#/home', '#/kit']) {
    it(`${hash} is refused inside the frame`, () => {
      window.location.hash = hash;
      const { unmount } = render(<SessionProvider><App /></SessionProvider>);
      expect(document.querySelector('[data-framed-refusal]'), hash).not.toBeNull();
      expect(document.querySelectorAll('button')).toHaveLength(0);
      unmount();
    });
  }
});

describe('and only in the phases an approval passes through', () => {
  it('a browser holding a passkey and no wallet - whose screen starts again - is refused inside the frame', async () => {
    localStorage.clear();
    savePasskey({
      credentialId: 'cred-1', personHandle: 'person-1', publicKeySpki: new Uint8Array([1, 2, 3]), algorithm: -7,
      signCount: 0, provenBySignIn: false, rpId: 'payroll.example', syncsToACloud: false, backedUpNow: false, transports: [],
    }, ORIGINAL_SLOT);
    window.location.hash = '#/approve';
    const { unmount, findByText } = render(<SessionProvider><App /></SessionProvider>);
    await findByText(/Everything else in your wallet opens in a tab of its own/);
    expect(document.querySelector('[data-framed-refusal]')).not.toBeNull();
    expect(document.querySelectorAll('button')).toHaveLength(0);
    unmount();
    localStorage.clear();
  });
});
