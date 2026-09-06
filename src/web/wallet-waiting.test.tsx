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
import * as keyring from './keyring.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

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
  it('THE ONE THAT PROVES THE ENVIRONMENT: it draws nothing when nothing is waiting', () => {
    const { container } = render(<WalletWaiting />);
    // A banner on a page nobody is waiting on is a banner people learn to
    // ignore. Empty is the correct screen, and it is now a rendered fact.
    expect(container.innerHTML).toBe('');
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
