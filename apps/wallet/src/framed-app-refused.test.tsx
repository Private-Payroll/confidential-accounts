// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/*
 * FRAMED, BEFORE ANYTHING LOADS, AND BUILT FOR NO EMBEDDER. `window.parent` is
 * another window, which is what a frame is; this wallet names nobody who may
 * hold it.
 */
vi.hoisted(() => {
  process.env['VITE_APP_ORIGIN'] = '';
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

/**
 * **A WALLET FRAMED BY A PAGE IT WAS NOT BUILT FOR SHOWS NOTHING AND OFFERS ONE LINK.**
 * Every route, the reset and recovery screens among them, would otherwise be a
 * control that page could put under somebody's pointer.
 */
describe('a wallet inside a page it was not built for', () => {
  for (const hash of ['#/approve', '#/settings', '#/recover', '#/kit']) {
    it(`${hash} renders the refusal and no control but the way out`, () => {
      window.location.hash = hash;
      const { unmount } = render(<SessionProvider><App /></SessionProvider>);
      expect(document.querySelector('[data-framed-refusal]'), hash).not.toBeNull();
      expect(screen.getByText(/was not built to be/)).toBeTruthy();
      expect(document.querySelectorAll('button')).toHaveLength(0);
      expect([...document.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Open your wallet in a new tab']);
      unmount();
    });
  }
});
