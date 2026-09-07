// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/*
 * THE SIDEBAR. Five claims, and each one is a thing that would be a
 * DEFECT rather than an ugly screen if it stopped being true.
 *
 *   1. THE FOLD CONTROL IS NOT INSIDE THE THING IT FOLDS. This is the change.
 *      The old rail was wired, persisted, tooltipped and correct, and a person
 *      could not find the control — the first human usability result this project
 *      has had. It was the first of three buttons in a group at the BOTTOM of
 *      the column it collapses. A test cannot assert that a person will find a
 *      control, so it asserts the STRUCTURAL fact that the failure had: the
 *      trigger is in the place header, outside the sidebar, and it is still
 *      there when the sidebar is folded. **The acceptance test for this change
 *      is a person opening it and finding the control without being told
 *      where it is; this is the part a machine can hold.**
 *
 *   2. A FLOW GETS NO SIDEBAR, NO TRIGGER, AND NO SHORTCUT.
 *      The chrome half was already pinned by `shell.test.tsx` and
 *      `rail.test.tsx`. The SHORTCUT is new and would arrive silently:
 *      `sidebar-07` registers a `window` keydown listener for Cmd/Ctrl+B, and
 *      a global key that summons navigation inside a securing ceremony is a
 *      way out of a ceremony, which is exactly what those two rows are about.
 *
 *   3. THE SWITCHER IS IN THE SIDEBAR'S FOOTER, AND THE TWO SURFACES AGREE.
 *      The design moved it there. There are now two chips on a place —
 *      the footer's for a desktop, the header's for a phone — and two surfaces
 *      naming different wallets is a disagreement moved into the
 *      chrome.
 *
 *   4. ACCOUNT 1 NEVER APPEARS IN THE FOOTER SWITCHER. The header
 *      chip's list is pinned by `shell.test.tsx`; this is the other door to
 *      the same list, and a door nobody checked is how trouble happened.
 *
 *   5. THE NAVIGATION NEVER REACHES THE PRINTED PAGE. The blanket in
 *      `app.css` hides everything but the armed piece card, and the navigation
 *      carries `print:hidden` as well. Both the sidebar and the bottom bar.
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

/** An unlocked wallet, through the real unlock — no phase is faked. */
async function unlocked(): Promise<void> {
  savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
  await saveSecret(newSecret());
  vi.mocked(usePasskey).mockResolvedValue({ credentialId: 'cred-1' } as never);
  vi.mocked(verifyAssertion).mockResolvedValue({ passkey: passkeyFixture('cred-1') } as never);
  render(<SessionProvider><App /></SessionProvider>);
  fireEvent.click(screen.getByText('Unlock with your passkey'));
  await screen.findByText('Every wallet');
}

const sidebar = (): HTMLElement | null =>
  document.querySelector('[data-slot="sidebar"]');
const trigger = (): HTMLElement | null =>
  document.querySelector('[data-slot="sidebar-trigger"]');
const footer = (): HTMLElement | null =>
  document.querySelector('[data-slot="sidebar-footer"]');
const headerChip = (): HTMLElement | null =>
  document.querySelector('header [data-account]');
const footerChip = (): HTMLElement | null =>
  document.querySelector('[data-slot="sidebar-footer"] [data-account]');

const commandB = (): void => {
  fireEvent.keyDown(window, { key: 'b', metaKey: true });
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = '#/';
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

describe('the fold control is outside the thing it folds — the whole point', () => {
  it('lives in the place header, not in the sidebar', async () => {
    await unlocked();
    const control = trigger();
    expect(control).not.toBeNull();
    /* IN a header... */
    expect(control?.closest('header')).not.toBeNull();
    /* ...and NOT inside the sidebar, which is where it used to be. */
    expect(sidebar()?.contains(control as Node)).toBe(false);
  });

  it('is still in the header once the sidebar is folded — it does not fold away with it', async () => {
    await unlocked();
    fireEvent.click(trigger() as HTMLElement);
    await waitFor(() => {
      expect(sidebar()?.getAttribute('data-state')).toBe('collapsed');
    });
    const control = trigger();
    expect(control).not.toBeNull();
    expect(control?.closest('header')).not.toBeNull();
    expect(sidebar()?.contains(control as Node)).toBe(false);
  });

  it('says what it will do and what it controls, in both states', async () => {
    await unlocked();
    expect(trigger()?.getAttribute('aria-label')).toBe('Hide the sidebar');
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(trigger() as HTMLElement);
    await waitFor(() => expect(trigger()?.getAttribute('aria-expanded')).toBe('false'));
    /* Not "Sidebar hidden" — a control names the ACTION, not the state it is
     * looking at, or pressing it reads as confirming what is already true. */
    expect(trigger()?.getAttribute('aria-label')).toBe('Show the sidebar');
  });

  it('and the keyboard shortcut folds it too', async () => {
    await unlocked();
    expect(sidebar()?.getAttribute('data-state')).toBe('expanded');
    commandB();
    await waitFor(() => expect(sidebar()?.getAttribute('data-state')).toBe('collapsed'));
    commandB();
    await waitFor(() => expect(sidebar()?.getAttribute('data-state')).toBe('expanded'));
  });
});

describe('a ceremony has no way out of itself', () => {
  it('a flow gets no sidebar and no fold control', async () => {
    await unlocked();
    window.location.hash = '#/secure';
    await screen.findByText('Cut the account into pieces');
    expect(sidebar()).toBeNull();
    expect(trigger()).toBeNull();
  });

  /* FOUND BY MUTATION, AND THE FIRST VERSION OF THIS TEST MISSED IT. It
   * asserted that no sidebar APPEARS after Cmd/Ctrl+B in a ceremony — and
   * mounting `SidebarProvider` around flows as well passed it, because a
   * provider with no `<Rail>` under it renders no sidebar either way. The
   * listener would still have been live and would still have written the
   * person's preference from inside a ceremony. So the claim is now the
   * MECHANISM: the provider is not mounted at all, and the key changes
   * nothing. */
  it('and Cmd/Ctrl+B does nothing inside one — the shortcut is not a door', async () => {
    await unlocked();
    /* Fold it first, so there is a stored value to be disturbed. */
    fireEvent.click(trigger() as HTMLElement);
    await waitFor(() => expect(localStorage.getItem('identity-ui:rail')).toBe('collapsed'));

    window.location.hash = '#/secure';
    await screen.findByText('Cut the account into pieces');

    /* Nothing that listens for the key is on the page. */
    expect(document.querySelector('[data-slot="sidebar-wrapper"]')).toBeNull();
    commandB();
    commandB();
    commandB();
    /* An odd number of presses. If anything were listening, this would have
     * flipped — and a ceremony would have written a navigation preference. */
    expect(localStorage.getItem('identity-ui:rail')).toBe('collapsed');
    expect(sidebar()).toBeNull();
    expect(document.querySelectorAll('nav[aria-label="Places"]')).toHaveLength(0);
    expect(screen.getByText('Cut the account into pieces')).toBeTruthy();
  });
});

describe('the wallet switcher moved into the footer', () => {
  it('the footer carries a chip, and so does the header — one for each layout', async () => {
    await unlocked();
    expect(footer()).not.toBeNull();
    expect(footerChip()).not.toBeNull();
    expect(headerChip()).not.toBeNull();
  });

  it('and the two can never name different wallets, in the chrome', async () => {
    await unlocked();
    expect(footerChip()?.getAttribute('data-account')).toBe('0');
    expect(headerChip()?.getAttribute('data-account')).toBe('0');

    /* Switched from the home screen's own door into the switcher — the design makes it
     * the SAME switcher the footer chip opens (`shell/switcher.tsx`), so the row
     * is inside the dialog rather than inside a second picker on the screen.
     * The claim is unchanged. */
    fireEvent.click(screen.getByText('Switch wallet'));
    const row = document.querySelector('[role="dialog"] [data-wallet-row][data-account="4"]');
    fireEvent.click(row as HTMLElement);

    await waitFor(() => {
      expect(footerChip()?.getAttribute('data-account')).toBe('4');
    });
    expect(headerChip()?.getAttribute('data-account')).toBe('4');
    expect(footerChip()?.textContent).toContain('Subwallet 3');
    expect(headerChip()?.textContent).toContain('Subwallet 3');
  });

  it('opens the same switcher, and account 1 is not in it', async () => {
    await unlocked();
    fireEvent.click(footerChip() as HTMLElement);
    await screen.findByText('Which wallet');
    fireEvent.click(screen.getByText('Show every slot'));

    const offered = [...document.querySelectorAll('[role="dialog"] button[data-account]')]
      .map((row) => Number(row.getAttribute('data-account')))
      .sort((a, b) => a - b);
    /* Every slot this interface has, named or not — the §2.3 convention that
     * keeps a subwallet holding money visible to the person who owns it — and
     * never the authority compartment. */
    expect(offered).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(offered).not.toContain(1);
  });
});

describe('the navigation never reaches the printed page', () => {
  it('both navigations and the place header are print:hidden', async () => {
    await unlocked();
    /* The defence is a blanket in `app.css` that hides everything but the
     * armed piece card. This is the belt beside it: the chrome says so itself,
     * so a later change to the blanket's scope cannot silently put a sidebar
     * on somebody's recovery sheet. */
    expect(sidebar()?.className).toContain('print:hidden');
    const bar = document.querySelector('nav[aria-label="Places"]:not([data-collapsed])');
    expect(bar?.className).toContain('print:hidden');
    expect(document.querySelector('header')?.className).toContain('print:hidden');
  });
});
