import { afterEach, describe, expect, it } from 'vitest';
import {
  WALLET_FRAME_ALLOW, closeWalletFrame, mountWalletFrame, onWalletFrame, walletFrameShown,
  walletInThisPage,
} from './wallet-frame.js';
import type { FrameElement } from './wallet-frame.js';
import { READY_PING } from 'midnight-identity/profile/channel';
import { askWallet } from './wallet-sign-in.js';

/**
 * **THE FRAME HOST, WITHOUT A BROWSER.** What `open` must hand back so the ask
 * already written can speak through it: a handle whose messages come from the
 * frame's window, whose `close` empties and hides the frame, and which is
 * closed once a newer ask has taken the frame.
 */

const aFrame = () => {
  const posted: Array<{ message: unknown; target: string }> = [];
  const contentWindow = { postMessage: (message: unknown, target: string) => { posted.push({ message, target }); } };
  const element: FrameElement & { focused: number } = { src: '', contentWindow, focused: 0, focus() { this.focused += 1; } };
  return { element, contentWindow, posted };
};

const aPage = () => ({
  addEventListener: () => {}, removeEventListener: () => {}, setTimeout: () => 0, clearTimeout: () => {},
});

afterEach(() => { closeWalletFrame(); mountWalletFrame(null); });

describe('the wallet in this page', () => {
  it('delegates a passkey to the frame and nothing else', () => {
    expect(WALLET_FRAME_ALLOW).toBe('publickey-credentials-get; publickey-credentials-create');
  });

  it('REFUSES to open with no frame mounted, rather than handing back something to wait on', () => {
    expect(walletInThisPage(aPage()).open('https://wallet.example/?ask=1#/approve', 'n')).toBeNull();
    expect(walletFrameShown()).toBe(false);
  });

  it('OPENS by pointing the frame at the wallet and showing it; messages come FROM the frame window', () => {
    const { element, contentWindow, posted } = aFrame();
    mountWalletFrame(element);
    const seen: boolean[] = [];
    const stop = onWalletFrame((shown) => seen.push(shown));
    const handle = walletInThisPage(aPage()).open('https://wallet.example/?ask=1#/approve', 'n')!;
    expect(element.src).toBe('https://wallet.example/?ask=1#/approve');
    expect(walletFrameShown()).toBe(true);
    expect(seen).toEqual([true]);
    expect(handle.messageSource).toBe(contentWindow);
    expect(handle.closed).toBe(false);
    handle.postMessage({ hello: 1 }, 'https://wallet.example');
    expect(posted).toEqual([{ message: { hello: 1 }, target: 'https://wallet.example' }]);
    handle.focus?.();
    expect(element.focused).toBe(1);
    stop();
  });

  it('CLOSING empties the frame and hides it - a hidden frame holding a live wallet is not closed', () => {
    const { element } = aFrame();
    mountWalletFrame(element);
    const handle = walletInThisPage(aPage()).open('https://wallet.example/?ask=1#/approve', 'n')!;
    handle.close?.();
    expect(element.src).toBe('about:blank');
    expect(walletFrameShown()).toBe(false);
    expect(handle.closed).toBe(true);
  });

  it('an OLDER ask closing late does not put away the newer one a person is reading', () => {
    const { element } = aFrame();
    mountWalletFrame(element);
    const host = walletInThisPage(aPage());
    const first = host.open('https://wallet.example/?ask=1#/approve', 'n')!;
    const second = host.open('https://wallet.example/?ask=2#/approve', 'n')!;
    expect(first.closed, 'a handle a newer ask replaced is not still open').toBe(true);
    first.close?.();
    expect(walletFrameShown()).toBe(true);
    expect(element.src).toBe('https://wallet.example/?ask=2#/approve');
    expect(second.closed).toBe(false);
  });

  it('UNMOUNTING the frame takes the wallet with it', () => {
    const { element } = aFrame();
    mountWalletFrame(element);
    const handle = walletInThisPage(aPage()).open('https://wallet.example/?ask=1#/approve', 'n')!;
    mountWalletFrame(null);
    expect(walletFrameShown()).toBe(false);
    expect(handle.closed).toBe(true);
  });
});

describe('the application itself', () => {
  it('is FRAMED BY NOBODY: the page that holds a wallet must be the top of the tab', async () => {
    const config = (await import('../../vite.config.ts')).default as {
      server?: { headers?: Record<string, string> }; preview?: { headers?: Record<string, string> };
    };
    for (const headers of [config.server?.headers, config.preview?.headers]) {
      expect(headers?.['Content-Security-Policy']).toBe("frame-ancestors 'none'");
      expect(headers?.['X-Frame-Options']).toBe('DENY');
    }
  });
});

describe('an ask, spoken through the frame', () => {
  it('HEARS the frame\'s own window, posts the ask to it, and takes its answer - and nothing else', async () => {
    const WALLET = 'https://identity.payroll.example';
    const { element, contentWindow, posted } = aFrame();
    mountWalletFrame(element);
    const handlers: Array<(e: MessageEvent) => void> = [];
    const page = { ...aPage(), addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { handlers.push(h); } };
    const say = (source: unknown, data: unknown, origin = WALLET) =>
      handlers.forEach((h) => h({ source, origin, data } as unknown as MessageEvent));

    const asked = askWallet(walletInThisPage(page), WALLET, { schema: 'an-ask' });
    /* a window that is not the frame's, at the wallet's origin, is not the wallet */
    say({ postMessage: () => {} }, { schema: READY_PING });
    expect(posted).toEqual([]);
    say(contentWindow, { schema: READY_PING });
    expect(posted).toEqual([{ message: { schema: 'an-ask' }, target: WALLET }]);
    say(contentWindow, { schema: 'an-answer' });
    expect(await asked).toEqual({ schema: 'an-answer' });
    /* and the wallet is put away once it has answered */
    expect(walletFrameShown()).toBe(false);
    expect(element.src).toBe('about:blank');
  });
});

describe('the product\'s journeys default to the wallet in this page', () => {
  it('SIGNING IN with no window handed in points THIS PAGE\'S frame at the wallet, and opens no window', async () => {
    const { element } = aFrame();
    mountWalletFrame(element);
    const opened: string[] = [];
    const g = globalThis as { window?: unknown; fetch?: unknown };
    const realWindow = g.window; const realFetch = g.fetch;
    g.window = { ...aPage(), location: { origin: 'https://app.payroll.example' }, open: (u: string) => { opened.push(u); return null; } };
    g.fetch = () => new Promise(() => {});
    try {
      const keyring = await import('./keyring.js');
      void keyring.signInWithWallet('https://identity.payroll.example').catch(() => {});
      expect(element.src).toMatch(/^https:\/\/identity\.payroll\.example\/\?ask=\d+#\/approve$/);
      expect(opened, 'a window was opened instead').toEqual([]);
    } finally {
      g.window = realWindow; g.fetch = realFetch;
    }
  });
});
