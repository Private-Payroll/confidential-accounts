// @vitest-environment jsdom
/**
 * **ONE PAYROLL SCREEN, RENDERED, AS PROOF THE ENVIRONMENT EXISTS.**
 * `X10` §3, `C154`, and `X9`'s closing note.
 *
 * ── WHY THIS FILE IS THE WHOLE OF §3 ─────────────────────────────────────
 *
 * `vitest.config.ts` set no environment, **so no screen in this repository had
 * ever been rendered by anything.** `wallet-waiting.tsx` was asserted as a
 * string. The audit's own words: *this is the answer to why the last three
 * defects on this surface were all found by a person walking the product.*
 *
 * **AND IT IS DELIBERATELY NOT A SUITE.** Which screens deserve tests is a
 * decision that comes after somebody has walked the product, and it is the
 * founder's. This proves the environment works on the screen `X9` left
 * unproved, and stops.
 *
 * ── NO `waitFor`, NO `findBy*`, AND THAT IS LOAD-BEARING ─────────────────
 *
 * The wallet carries fifty-six polls in two files it has not fixed yet,
 * every one able to lose a race. **Payroll starts without them rather than
 * acquiring them and unpicking them in six weeks.** Everything below awaits a
 * thing: the banner appears SYNCHRONOUSLY because `openTheWallet` runs before
 * the ask's first `await` — which is `C154`'s repair — and it goes when the
 * journey it belongs to has settled, which is a promise this file holds.
 *
 * ── THE ASK IS STARTED AND NOT AWAITED, WHICH IS `X9`'s METHOD ───────────
 *
 * `signInWithWallet` opens the wallet in the click and only then talks to the
 * server. A test that awaited the whole journey could not see the moment this
 * screen exists for. So the call is started, the screen is read, and the
 * promise is settled at the end by pressing the way out.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WalletWaiting } from './wallet-waiting.js';
import { walletFrameShown, walletInThisPage } from './wallet-frame.js';
import { openWalletDialog } from './wallet-sign-in.js';
import { readFileSync } from 'node:fs';
import * as keyring from './keyring.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';
import { askWallet } from './wallet-sign-in.js';
import type { WalletClosed } from './wallet-sign-in.js';

const WALLET = 'https://wallet.example';

afterEach(cleanup);

/**
 * A window that records instead of doing. It is deliberately NOT a wallet:
 * nothing answers, because every assertion here is about the moment before
 * anything has.
 */
const aView = () => {
  const opened: string[] = [];
  let closed = 0;
  const wallet: WalletWindow = {
    closed: false,
    close: () => { closed += 1; },
    focus: () => {},
    postMessage: () => {},
  } as unknown as WalletWindow;
  const view: Openable = {
    open: (url) => { opened.push(url); return wallet; },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  return { view, opened, closedCount: () => closed };
};

describe('the page behind the wallet, rendered', () => {
  it('THE ONE THAT PROVES THE ENVIRONMENT: it shows nothing when nothing is waiting', () => {
    const { container } = render(<WalletWaiting />);
    // A banner on a page nobody is waiting on is a banner people learn to
    // ignore. Nothing on screen is the correct screen, and it is a rendered fact.
    //
    // NOT AN EMPTY CONTAINER ANY MORE, AND THAT IS THE DESIGN RATHER THAN A
    // LOOSENED ASSERTION: the wallet's frame is rendered once and kept, because
    // moving or remounting a frame reloads the wallet inside it. So what is
    // asserted is what a person can see - the sheet is hidden, the frame is
    // empty, and nothing says it is waiting.
    const sheet = container.querySelector<HTMLElement>('[data-wallet-sheet]');
    expect(sheet?.hidden).toBe(true);
    expect(container.querySelector('iframe')?.getAttribute('src') ?? '').toBe('');
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('C154: a wallet ask puts the wait on the screen, with the way out', async () => {
    const { view, opened, closedCount } = aView();
    render(<WalletWaiting />);

    /*
     * **STARTED, NOT AWAITED.** The window is opened before the first `await`,
     * so the banner is on the screen by the time this block returns.
     *
     * `act` is here to FLUSH React's queue, not to wait for anything: the
     * subscription fires synchronously and the render it schedules has to be
     * committed before the DOM can be read. Without it this reads the screen
     * one tick early and sees nothing — which is a poll's disease, and the
     * reason nothing below polls.
     */
    let journey!: Promise<string>;
    act(() => {
      journey = keyring.signInWithWallet(WALLET, undefined, view)
        .then(() => 'signed in', () => 'refused');
    });
    expect(opened).toHaveLength(1);

    const banner = screen.getByRole('status');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Waiting for your wallet');
    /* The sentence that is the whole point of the screen: look at the address
     * bar, which is the one thing on it this page cannot write. */
    expect(banner.textContent).toContain('the only thing on your screen this page cannot write');
    expect(banner.textContent).toContain('Nothing is signed until you press the button there');

    /* AND THE THING A SPINNER NEVER OFFERS. Without it a person who
     * cannot find the window presses the button again, and a second press is a
     * second ask. */
    const giveUp = screen.getByText('Stop waiting');
    await act(async () => {
      fireEvent.click(giveUp);
      // Awaited, not polled: this is the journey the banner belongs to.
      expect(await journey).toBe('refused');
    });

    expect(closedCount()).toBe(1);
    // And the banner goes with it, so nothing is left saying we are still waiting.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */

describe('the wallet shown inside the page', () => {
  /** A page window: listeners and timers recorded, nothing fires. */
  const aPage = () => {
    const handlers: Array<(e: MessageEvent) => void> = [];
    return {
      addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { handlers.push(h); },
      removeEventListener: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
  };

  it('a wallet ask SHOWS the wallet in the page, in its frame, with the way out', async () => {
    const { container } = render(<WalletWaiting />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('allow'), 'without delegation a passkey is refused inside a frame')
      .toBe('publickey-credentials-get; publickey-credentials-create');

    let journey!: Promise<string>;
    act(() => {
      journey = keyring.signInWithWallet(WALLET, undefined, walletInThisPage(aPage()))
        .then(() => 'signed in', () => 'refused');
    });

    /* Opened in the press: the frame points at the wallet before anything is awaited. */
    expect(frame.getAttribute('src')).toMatch(new RegExp(`^${WALLET}/\\?ask=\\d+#/approve$`));
    expect(container.querySelector<HTMLElement>('[data-wallet-sheet]')!.hidden).toBe(false);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Waiting for your wallet');
    expect(status.textContent).toContain('Nothing is signed and nothing is released until you press a button inside it');

    await act(async () => {
      fireEvent.click(screen.getByText('Stop waiting'));
      expect(await journey).toBe('refused');
    });
    /* PUT AWAY, NOT MERELY HIDDEN: an emptied frame holds no wallet document at all. */
    expect(walletFrameShown()).toBe(false);
    expect(container.querySelector<HTMLElement>('[data-wallet-sheet]')!.hidden).toBe(true);
    expect(frame.getAttribute('src')).toBe('about:blank');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('HIDDEN MEANS NOT DRAWN: the stylesheet does not let the sheet\'s own `display` override `hidden`', () => {
    /* jsdom applies no stylesheet, so the case above cannot see this. The sheet is
     * a fixed full-screen layer with a `display` of its own, and an author rule
     * beats the browser's `[hidden]` rule - without this line a hidden sheet is an
     * invisible layer over the whole application, swallowing every click. */
    const css = readFileSync('src/web/styles.css', 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.walletsheet\[hidden\] \{ display: none; \}/);
  });

  it('a journey that opens its OWN dialog and announces it gets a Stop that refuses its ask', async () => {
    render(<WalletWaiting />);
    const host = walletInThisPage(aPage());
    const dialog = openWalletDialog(host, WALLET);
    let done!: () => void;
    let asked!: Promise<string>;
    act(() => {
      done = keyring.showWaitingFor(dialog);
      asked = askWallet(host, WALLET, { schema: 'an-ask' }, dialog).then(() => 'answered', (e: WalletClosed) => e.refusal.of);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Stop waiting'));
      expect(await asked).toBe('gave-up');
    });
    act(() => done());
    expect(walletFrameShown()).toBe(false);
  });

  it('with no frame on the page, an ask refuses by name instead of waiting for a wallet that is not there', async () => {
    const outcome = await askWallet(walletInThisPage(aPage()), WALLET, { schema: 'an-ask' })
      .then(() => 'answered', (e: WalletClosed) => e.refusal.of);
    expect(outcome).toBe('no-wallet-tab');
  });
});
