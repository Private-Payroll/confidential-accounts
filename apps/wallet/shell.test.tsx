// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/*
 * THE SHELL. Four claims, and each one is a thing that would be a defect
 * rather than an ugly screen if it stopped being true.
 *
 *   1. A PLACE gets navigation; a FLOW gets none. A ceremony you can navigate
 *      away from mid-way is an ordering family, and the guard against it
 *      is that the rail and the bar are not rendered at all.
 *      **ONE HALF OF THIS TEST IS CORRECTED**. It once asserted
 *      a flow shows NO ACCOUNT CHIP, because the design said flows get no
 *      navigation and that was read as no chip. The design
 *      always said otherwise and the wording was the error: **the chip is
 *      identity, not navigation.** Trouble is what happens when a ceremony does not name the
 *      account it is about — *"the secured record names no account, so it
 *      outlives the account it describes"* — so the chip is SHOWN, and NOT
 *      TAPPABLE, because switching mid-ceremony is an ordering fault.
 *      The navigation half of the claim is unchanged and still asserted.
 *   2. THE CHIP AND THE SCREEN CANNOT NAME DIFFERENT WALLETS. Two surfaces now
 *      say which wallet is open. Trouble is two wallets wearing one name; two
 *      surfaces disagreeing about which wallet is open is the same failure
 *      with the disagreement moved into the chrome.
 *   3. ACCOUNT 1 NEVER APPEARS. The switcher is built from
 *      `WALLET_ACCOUNTS`, and this is the interface-level check that it stays
 *      that way.
 *   4. ONE `main`, ALWAYS. The App focuses `document.querySelector('main')` on
 *      every navigation; a second one silently steals that focus.
 */

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return { ...actual, verifyAssertion: vi.fn() };
});

import { Buffer as PolyfillBuffer } from 'buffer/';
import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import { newSecret } from 'midnight-identity/keys/derivation';

/* jsdom is its own realm: Node's `Buffer` fails the crypto libraries'
 * `instanceof Uint8Array` checks under it. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import type { Passkey } from 'midnight-identity/passkey/verify';
import { App } from './app.js';
import { SessionProvider } from './session.js';
import { savePasskey, saveSecret } from './storage.js';
import { ORIGINAL_SLOT } from './wallets-held.js';

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId,
  personHandle: 'person-1',
  publicKeySpki: new Uint8Array([1, 2, 3]),
  algorithm: -7,
  signCount: 0,
  provenBySignIn: false,
  rpId: 'localhost',
  syncsToACloud: false,
  backedUpNow: false,
  transports: [],
});

const mount = (): void => {
  render(<SessionProvider><App /></SessionProvider>);
};

/** An unlocked wallet, through the real unlock — no phase is faked. */
async function unlocked(): Promise<void> {
  savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
  await saveSecret(newSecret());
  vi.mocked(usePasskey).mockResolvedValue({ credentialId: 'cred-1' } as never);
  vi.mocked(verifyAssertion).mockResolvedValue({ passkey: passkeyFixture('cred-1') } as never);
  mount();
  fireEvent.click(screen.getByText('Unlock with your passkey'));
  /* THE "HOME HAS RENDERED" SENTINEL MOVED. It was `Your addresses`, the
   * address card's heading; the design puts the addresses in the Receive
   * popup, so that heading is behind a control now. `Every wallet` is the
   * all-wallets card's title, present on Home in every state — secured or not,
   * checked or not. Same wait, different words; `rail.test.tsx`,
   * `sidebar.test.tsx` and `app.test.tsx` moved with it. */
  await screen.findByText('Every wallet');
}

const navs = (): Element[] => [...document.querySelectorAll('nav[aria-label="Places"]')];
const chip = (): HTMLElement | null => document.querySelector('header [data-account]');

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = '#/';
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

describe('a place is framed; a flow and a condition are not', () => {
  it('home gets the rail, the bar and the account chip', async () => {
    await unlocked();
    /* Both navigations are in the DOM; which one a person sees is the CSS
     * media query's answer, never JavaScript's. */
    expect(navs()).toHaveLength(2);
    expect(chip()).not.toBeNull();
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  it('the securing flow gets no navigation — a ceremony has no way out of itself', async () => {
    await unlocked();
    window.location.hash = '#/secure';
    await screen.findByText('Cut the account into pieces');
    expect(navs()).toHaveLength(0);
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  /* The correction. Two assertions, and the second is
   * the one that matters: a ceremony that names its account is safe; a
   * ceremony you can change account inside is not. */
  it('the securing flow SHOWS the account chip — the ceremony names what it is about', async () => {
    await unlocked();
    window.location.hash = '#/secure';
    await screen.findByText('Cut the account into pieces');
    const shown = chip();
    expect(shown).not.toBeNull();
    expect(shown?.getAttribute('data-account')).toBe('0');
    expect(shown?.textContent).toContain('Main wallet');
  });

  it('and it cannot be pressed — switching wallet mid-ceremony is an ordering fault', async () => {
    await unlocked();
    window.location.hash = '#/secure';
    await screen.findByText('Cut the account into pieces');
    const shown = chip() as HTMLElement;
    /* Not a control at all: not a button, not focusable, and pressing it opens
     * nothing. A DISABLED button would fail this — it would still be a
     * control, and it would invite the press it exists to refuse. */
    expect(shown.tagName).toBe('DIV');
    expect(shown.getAttribute('data-tappable')).toBe('false');
    expect(shown.getAttribute('tabindex')).toBeNull();
    fireEvent.click(shown);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(navs()).toHaveLength(0);
  });

  it('a condition — no account at all — gets neither', () => {
    mount();
    expect(screen.getByText('Your wallet on Midnight.')).toBeTruthy();
    expect(navs()).toHaveLength(0);
    expect(chip()).toBeNull();
  });

  /*
   * THE ADDRESS BOOK IS A DESTINATION, NOT A DRAWER. The rule: build
   * it inline now and converting it to a route later is a rewrite. So the
   * shortcut on Home points at a real route today, and that route says what
   * will be there rather than rendering nothing. It is framed like `advanced`
   * and NOT as a place — the design keeps the navigation at four
   * on purpose — which is why it gets its own test rather than a line in the
   * loop below.
   */
  it('the address book route is a real screen that says what will be there', async () => {
    await unlocked();
    window.location.hash = '#/address-book';
    await waitFor(() => {
      expect(document.querySelector('main h1')?.textContent).toBe('Contacts');
    });
    expect(document.querySelector('main')?.textContent).toContain('Not built yet');
    /* A destination, not a place: no navigation grew to hold it. */
    expect(navs()).toHaveLength(0);
  });

  /*
   * THIS TEST WAS 'the three new places render the not-built screen
   * inside the frame' AND IT NAMED SETTINGS AMONG THE THREE.
   *
   * **Settings is built this change, so the words *Not built yet* are no longer
   * true of it, and that is the only assertion that moved.** Nothing was
   * loosened: the two places still to come keep every assertion they had, the
   * frame assertions (`h1` and two navigations) are unchanged for all three,
   * and Settings' lost line is replaced by a STRONGER one — that its own
   * content is there. The rule is that a test may never be
   * updated to assert something different; the exception it names is the one
   * in play here, which is that the change's own design orders the thing the
   * assertion described to stop being the case, and that is said out loud in
   * this change's entry rather than absorbed quietly.
   */
  /*
   * THIS TEST NAMED TWO PLACES AND NOW NAMES ONE, FOR THE REASON GIVEN
   * ABOVE AND UNDER THE SAME EXCEPTION.
   *
   * A test may never be updated to assert something
   * different — except where the change's own design orders the thing the
   * assertion described to stop being the case, and then it is said out loud.
   * The design orders `#/explore` to stop
   * rendering `NotBuilt`. **Activity keeps every assertion it had, word for
   * word, including *Not built yet*.** Explore's are not weakened, they move
   * to the test below and get stronger: the frame is asserted exactly as it
   * was here, and *Not built yet* becomes a `not.toContain` rather than
   * disappearing.
   */
  it('the place still to come renders the not-built screen inside the frame', async () => {
    await unlocked();
    for (const [route, heading] of [
      ['#/activity', 'Activity'],
    ] as const) {
      window.location.hash = route;
      await waitFor(() => {
        expect(document.querySelector('main h1')?.textContent).toBe(heading);
      });
      expect(document.querySelector('main')?.textContent).toContain('Not built yet');
      expect(navs()).toHaveLength(2);
    }
  });

  it('explore is a place with the same frame, and is a screen now', async () => {
    await unlocked();
    window.location.hash = '#/explore';
    await waitFor(() => {
      expect(document.querySelector('main h1')?.textContent).toBe('Explore');
    });
    /* The frame, asserted exactly as it was for both places before. */
    expect(navs()).toHaveLength(2);
    /* And what replaced the not-built screen: six named things, each carrying
     * the badge, and no fifth or seventh. */
    expect(document.querySelector('main')?.textContent).not.toContain('Not built yet');
    for (const name of [
      'ZK KYC', 'Proof of Personhood', 'Private Lottery', 'Whistleblow', 'Earn', 'Vote',
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getAllByText('Coming soon')).toHaveLength(6);
    /* A tile that leads nowhere leads nowhere: no link and no button among
     * them. The rail and the bottom bar are OUTSIDE `main`, so this counts
     * only what the screen itself put on the page. */
    const main = document.querySelector('main') as HTMLElement;
    expect(main.querySelectorAll('a')).toHaveLength(0);
    expect(main.querySelectorAll('button')).toHaveLength(0);
  });

  it('settings is a place with the same frame, and is a screen now', async () => {
    await unlocked();
    window.location.hash = '#/settings';
    await waitFor(() => {
      expect(document.querySelector('main h1')?.textContent).toBe('Settings');
    });
    /* The frame, asserted exactly as it was for all three before. */
    expect(navs()).toHaveLength(2);
    /* And what replaced the not-built screen: its own sections. */
    expect(document.querySelector('main')?.textContent).not.toContain('Not built yet');
    expect(screen.getByRole('heading', { name: 'Passkeys', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Network and hosts', level: 2 })).toBeTruthy();
  });
});

describe('the chip and the screen can never name different wallets', () => {
  it('a switch made on the home screen’s own bar moves the chip with it', async () => {
    await unlocked();
    expect(chip()?.getAttribute('data-account')).toBe('0');
    expect(chip()?.textContent).toContain('Main wallet');

    /* The home screen's OWN door into the switcher — not the chip's. The design makes
     * them ONE switcher with two doors (`shell/switcher.tsx`), which is what
     * the design asks for, so the row is found inside the open dialog
     * rather than inside a second picker built into the screen. The claim is
     * unchanged and is now stronger: a switch made from the screen's door moves
     * the chip, and there is no second list that could disagree. */
    fireEvent.click(screen.getByText('Switch wallet'));
    const row = document.querySelector('[role="dialog"] [data-wallet-row][data-account="4"]');
    expect(row?.textContent).toContain('Subwallet 3');
    fireEvent.click(row as HTMLElement);

    /* The screen moved... */
    await waitFor(() => {
      /* `.wallet-bar` -> `[data-hero]`: the open wallet's card. Same attribute,
       * same value, new element. */
      expect(document.querySelector('[data-hero]')?.getAttribute('data-account')).toBe('4');
    });
    /* ...and so did the chrome, off the same stored record. */
    await waitFor(() => {
      expect(chip()?.getAttribute('data-account')).toBe('4');
    });
    expect(chip()?.textContent).toContain('Subwallet 3');
  });
});

describe('the switcher offers every wallet this interface has, and only those', () => {
  it('account 1 — the authority compartment — is not among them', async () => {
    await unlocked();
    const trigger = chip();
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as HTMLElement);
    await screen.findByText('Which wallet');
    fireEvent.click(screen.getByText('Show every slot'));

    const offered = [...document.querySelectorAll('[role="dialog"] button[data-account]')]
      .map((row) => Number(row.getAttribute('data-account')))
      .sort((a, b) => a - b);
    expect(offered).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(offered).not.toContain(1);
  });
});
