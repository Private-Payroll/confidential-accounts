// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * THE FOLDING RAIL AND THE THEME LIST.
 *
 * Five claims, and each one is a thing that would be a DEFECT rather than an
 * ugly screen if it stopped being true.
 *
 *   1. THE FOLD IS REMEMBERED ACROSS RELOADS. The design asks for it in
 *      those words. A preference that resets on every reload is not a
 *      preference; it is a control that appears not to work.
 *
 *   2. A FOLDED LINK STILL HAS ITS NAME. This is the one that matters. When the
 *      rail folds, the visible label goes and the glyph stays — and a glyph is
 *      not a name to a screen reader, so without `aria-label` the wallet's
 *      whole navigation becomes four unnamed links. That is not a cosmetic
 *      regression, it is the navigation disappearing for anybody not looking at
 *      pixels, and it would arrive silently.
 *
 *   3. THE BOTTOM BAR NEVER FOLDS. There is no rail on a phone and no hover
 *      either (by design: *"no hover-only affordances
 *      anywhere"*). A fold that reached the bar would replace four labelled
 *      touch targets with four unlabelled ones on the layout that cannot show
 *      a tooltip at all.
 *
 *   4. A FLOW STILL GETS NO NAVIGATION, FOLDED OR NOT. The rail
 *      gained a state this change; it did not gain a way into a ceremony.
 *
 *   5. THE THEME PICKER RENDERS THE LIST. `shell/themes.ts` is data; the menu
 *      is that array plus the machine. A picker that hardcoded two entries
 *      would be the toggle again wearing a menu's clothes.
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
import { App } from '../app.js';
import { SessionProvider } from '../session.js';
import { THEMES } from './themes.js';
import { savePasskey, saveSecret } from '../accounts/storage.js';
import { ORIGINAL_SLOT, forgetOpenWallet } from '../accounts/wallets-held.js';

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

/**
 * PUTS ONE WALLET IN THIS BROWSER — a passkey and a sealed secret.
 *
 * **THIS WAS SPLIT OUT OF `unlocked()`, AND THE SPLIT IS THE FIX FOR A FIXTURE
 * THAT WAS QUIETLY DOING TWO DIFFERENT THINGS.** `saveSecret` used to overwrite
 * the keyring, so seeding twice was indistinguishable from seeding once and
 * `unlocked()` could stand for both "a browser with a wallet" and "a mount". A
 * wallet now lands BESIDE what is already here, so the second call minted a
 * SECOND wallet — and left its passkey in the FIRST one's compartment, because
 * `savePasskey` runs before the landing chooses where the new one goes. That
 * is `account-no-passkey`: a hero screen with one button and no "Unlock with
 * your passkey" on it, which is exactly what the reload test could not find.
 *
 * Measured rather than reasoned, PROBE 2,
 * which runs this same pair of calls twice and reports
 * `{held:2, keyring:"readable", passkeys:0}` either way.
 */
async function seedOneWallet(): Promise<void> {
  savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
  await saveSecret(newSecret());
}

/** Mounts the app and unlocks it through the real ceremony — no phase is
 * faked. Takes the browser as it finds it. */
async function mountAndUnlock(): Promise<void> {
  vi.mocked(usePasskey).mockResolvedValue({ credentialId: 'cred-1' } as never);
  vi.mocked(verifyAssertion).mockResolvedValue({ passkey: passkeyFixture('cred-1') } as never);
  render(<SessionProvider><App /></SessionProvider>);
  fireEvent.click(screen.getByText('Unlock with your passkey'));
  await screen.findByText('Every wallet');
}

/** The ordinary case: a browser holding one wallet, unlocked. */
async function unlocked(): Promise<void> {
  await seedOneWallet();
  await mountAndUnlock();
}

/** The rail, which is the wide navigation — the bar carries the same accessible
 * name, so they are told apart by the attribute only the rail has. */
const rail = (): HTMLElement | null =>
  document.querySelector('nav[aria-label="Places"][data-collapsed]');
const bar = (): HTMLElement | null =>
  document.querySelector('nav[aria-label="Places"]:not([data-collapsed])');
const foldButton = (): HTMLElement =>
  screen.getByLabelText(/the sidebar/i);
const railLink = (route: string): HTMLElement | null =>
  rail()?.querySelector(`a[data-place="${route}"]`) ?? null;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = '#/';
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* Which wallet a window has open is module state, and module state
   * outlives a test. Clearing storage without clearing this leaves a window
   * pointing at a compartment from the previous test. */
  forgetOpenWallet();
});

describe('the desktop rail folds, and remembers', () => {
  it('starts wide — nobody who has never pressed it gets icons', async () => {
    await unlocked();
    expect(rail()?.getAttribute('data-collapsed')).toBe('false');
    expect(railLink('home')?.textContent).toContain('Home');
  });

  it('folds when pressed, and the labels go', async () => {
    await unlocked();
    fireEvent.click(foldButton());
    await waitFor(() => {
      expect(rail()?.getAttribute('data-collapsed')).toBe('true');
    });
    expect(railLink('home')?.textContent).not.toContain('Home');
  });

  it('is still folded after a reload — the whole point of §3', async () => {
    await unlocked();
    fireEvent.click(foldButton());
    await waitFor(() => {
      expect(rail()?.getAttribute('data-collapsed')).toBe('true');
    });
    /* A reload is a fresh mount reading the same storage. `localStorage` is NOT
     * cleared here, which is exactly the difference from `beforeEach`.
     *
     * TWO THINGS ARE MORE FAITHFUL THAN THEY WERE. The wallet is NOT seeded
     * again — seeding again adds a second wallet, which is a different
     * browser rather than a reload of this one. And `forgetOpenWallet()` is
     * the other half of what a reload actually does: everything this window
     * held in memory goes, the disk stays. Which wallet is open survives it,
     * because it is read from the disk — `wallets-held.ts:341`. */
    cleanup();
    forgetOpenWallet();
    await mountAndUnlock();
    expect(rail()?.getAttribute('data-collapsed')).toBe('true');
  });

  it('unfolds again, and forgets — the stored value is removed, not set to false', async () => {
    await unlocked();
    fireEvent.click(foldButton());
    await waitFor(() => expect(rail()?.getAttribute('data-collapsed')).toBe('true'));
    fireEvent.click(foldButton());
    await waitFor(() => expect(rail()?.getAttribute('data-collapsed')).toBe('false'));
    expect(localStorage.getItem('identity-ui:rail')).toBeNull();
  });
});

describe('a folded link is still a named link', () => {
  it('every place keeps its word as an accessible name when the label is gone', async () => {
    await unlocked();
    fireEvent.click(foldButton());
    await waitFor(() => expect(rail()?.getAttribute('data-collapsed')).toBe('true'));
    for (const [route, name] of [
      ['home', 'Home'], ['activity', 'Activity'],
      ['explore', 'Explore'], ['settings', 'Settings'],
    ] as const) {
      const link = railLink(route);
      expect(link, route).not.toBeNull();
      /* The label is not on screen... */
      expect(link?.textContent).not.toContain(name);
      /* ...and the link is still called by it. */
      expect(link?.getAttribute('aria-label')).toBe(name);
    }
  });

  /* The accessible name covers a screen reader. A SIGHTED person looking at a
   * folded rail has only the glyph, and the tooltip is what turns that back
   * into a word — which is the entire reason this change fetched a component
   * rather than writing one. Radix marks its trigger, so "is there a tooltip on
   * this link" is a fact about the DOM rather than a hover to simulate. */
  /*
   * The kit's sidebar puts a tooltip on every place, and shows it only while
   * the sidebar is folded. RED WHEN: a folded place stops naming itself on
   * focus, or an unfolded one - whose word is already beside its icon - starts.
   */
  it('a folded place names itself on focus, and an unfolded one does not', async () => {
    /* jsdom measures nothing; the tooltip only asks to be told of a size change. */
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    await unlocked();
    const unfolded = railLink('home') as HTMLElement;
    fireEvent.focus(unfolded);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.blur(unfolded);

    fireEvent.click(foldButton());
    await waitFor(() => expect(rail()?.getAttribute('data-collapsed')).toBe('true'));

    for (const [route, name] of [
      ['home', 'Home'], ['activity', 'Activity'], ['explore', 'Explore'], ['settings', 'Settings'],
    ] as const) {
      const link = railLink(route) as HTMLElement;
      fireEvent.focus(link);
      expect((await screen.findByRole('tooltip')).textContent, route).toBe(name);
      fireEvent.blur(link);
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    }
  });

  it('and the action button never loses its name either', async () => {
    await unlocked();
    fireEvent.click(foldButton());
    await waitFor(() => expect(rail()?.getAttribute('data-collapsed')).toBe('true'));
    expect(screen.getAllByLabelText('New action — send').length).toBeGreaterThan(0);
  });
});

describe('the fold is a desktop fact and reaches nothing else', () => {
  it('the bottom bar is never collapsed', async () => {
    await unlocked();
    fireEvent.click(foldButton());
    await waitFor(() => expect(rail()?.getAttribute('data-collapsed')).toBe('true'));
    expect(bar()).not.toBeNull();
    expect(bar()?.querySelector('a[data-place="home"]')?.textContent).toContain('Home');
  });

  it('a flow still gets no navigation at all, folded or not', async () => {
    await unlocked();
    fireEvent.click(foldButton());
    await waitFor(() => expect(rail()?.getAttribute('data-collapsed')).toBe('true'));
    window.location.hash = '#/secure';
    await screen.findByText('Cut the account into pieces');
    expect(document.querySelectorAll('nav[aria-label="Places"]')).toHaveLength(0);
  });
});

describe('the theme picker is the list, not a toggle', () => {
  it('offers every theme in shell/themes.ts, plus the machine', async () => {
    await unlocked();
    const trigger = document.querySelector('[data-theme-choice]');
    expect(trigger).not.toBeNull();
    fireEvent.pointerDown(trigger as HTMLElement, { button: 0, ctrlKey: false });
    fireEvent.click(trigger as HTMLElement);
    await screen.findByText('Follow this machine');
    const offered = [...document.querySelectorAll('[data-theme-option]')]
      .map((item) => item.getAttribute('data-theme-option'));
    expect(offered).toEqual([...THEMES.map((theme) => theme.id), 'system']);
  });

  it('choosing one writes it to the root element and keeps it', async () => {
    await unlocked();
    const trigger = document.querySelector('[data-theme-choice]');
    fireEvent.pointerDown(trigger as HTMLElement, { button: 0, ctrlKey: false });
    fireEvent.click(trigger as HTMLElement);
    await screen.findByText('Follow this machine');
    fireEvent.click(screen.getByText('Light'));
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    expect(localStorage.getItem('identity-ui:theme')).toBe('light');
  });

  /* The root always carries the theme that is on, because the kit's theme is
   * chosen by that attribute alone. RED WHEN: following the machine stores a
   * choice, or leaves the root without the machine's theme. This test's
   * machine has no colour-scheme query, so the machine's theme is dark. */
  it('following the machine stores nothing and writes the machine\'s theme', async () => {
    await unlocked();
    const open = async (): Promise<void> => {
      const trigger = document.querySelector('[data-theme-choice]');
      fireEvent.pointerDown(trigger as HTMLElement, { button: 0, ctrlKey: false });
      fireEvent.click(trigger as HTMLElement);
      await screen.findByText('Follow this machine');
    };
    await open();
    fireEvent.click(screen.getByText('Light'));
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    await open();
    fireEvent.click(screen.getByText('Follow this machine'));
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
    /* Removed, not stored as the string "system": the machine answers each
     * time the wallet opens, and a stored word would outlive the machine's
     * own setting. */
    expect(localStorage.getItem('identity-ui:theme')).toBeNull();
  });

  /*
   * THE MACHINE'S OWN SETTING, READ AND FOLLOWED. With nothing chosen the
   * wallet asks the machine and writes what it says, and changes when the
   * machine changes. RED WHEN: the machine's light setting is not read, or
   * its change is not followed.
   */
  it('following a light machine writes light, and follows the machine when it changes', async () => {
    let light = true;
    const listeners = new Set<() => void>();
    const was = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() { return query.includes('light') ? light : !light; },
      media: query,
      addEventListener: (_: string, f: () => void) => { listeners.add(f); },
      removeEventListener: (_: string, f: () => void) => { listeners.delete(f); },
    })) as unknown as typeof window.matchMedia;
    try {
      await unlocked();
      await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
      light = false;
      for (const f of [...listeners]) f();
      await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
      expect(localStorage.getItem('identity-ui:theme')).toBeNull();
    } finally {
      window.matchMedia = was;
    }
  });
});
