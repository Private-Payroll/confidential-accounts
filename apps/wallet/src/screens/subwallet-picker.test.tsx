// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { identityFromSecret, newSecret, splitSecret } from 'midnight-identity';
import type { Placement, Secret } from 'midnight-identity';
import {
  forgetEverything, loadSecuredSetup, loadSubwallets, saveLastUsedWallet, saveSecuredSetup,
  saveSubwalletName,
} from '../accounts/storage.js';
import { ORIGINAL_SLOT } from '../accounts/wallets-held.js';
import { mapAsText } from '../components/piece-map.js';
import { switchWallet } from '../shell/wallets.js';
import { Home } from './home.js';

/*
 * THE PICKER, HELD TO ITS RULES.
 *
 * Two promises are pinned here because each one is a defect waiting to
 * happen. §2.3: EVERY slot is always offered, named or not — a picker built
 * from stored names makes a subwallet holding money invisible to the person
 * who just recovered. §3: the wallet's NAME travels with its ADDRESS — on
 * the card, in the copy confirmation, in the reveal — because the address is
 * the one thing people copy without reading, and money paid into the wrong
 * one of your own wallets is the failure this feature invents.
 *
 * These render the real Home screen and drive the real storage underneath;
 * nothing is stubbed but the clipboard, which jsdom does not have.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOTICE = /If you lose this device, the money in this wallet is gone/;

/*
 * THE SAME THINGS, IN THE PLACES THE DESIGN PUT THEM. Every helper below reads
 * exactly what it read before; what moved is where it is, and each move is
 * named here so a reader can check the assertion rather than the selector.
 *
 *   `.wallet-bar h2` -> `[data-wallet-name]`. The open wallet's name is now the
 *     hero card's kit `Badge` instead of the old bar's heading. Same string.
 *
 *   `.wallet-owner strong` -> UNCHANGED. `screens/send.tsx` draws the owner
 *     line the same way, so the class stayed; it is now the hero's header row.
 *
 *   `.wallet-row` -> `[data-wallet-row]`. The picker is the shell's one
 *     switcher (`shell/switcher.tsx`), reached from Home and from the sidebar,
 *     and its rows carry an attribute rather than a styling class.
 *
 *   `Show all 10 subwallets` -> `Show every slot`. The same control, revealing
 *     the same eleven rows — it is the switcher's wording, and the switcher is
 *     now one implementation rather than two.
 *
 *   THE ADDRESSES ARE BEHIND `Receive`. The design makes it a popup, so
 *     the address helpers open it, read, and close it. It is portalled to
 *     `document.body`, which is why they query `document`.
 *
 *   `.wallet-bar` -> `[data-hero]` for `data-account` and `--wallet-hue`.
 */
const barName = (container: HTMLElement): string | null =>
  container.querySelector('[data-wallet-name]')?.textContent ?? null;
const ownerName = (container: HTMLElement): string | null =>
  container.querySelector('.wallet-owner strong')?.textContent ?? null;
const hero = (container: HTMLElement): HTMLElement =>
  container.querySelector('[data-hero]') as HTMLElement;

function openReceive(): void {
  fireEvent.click(screen.getByText('Receive'));
}
function closeReceive(): void {
  fireEvent.click(document.querySelector('[data-slot="dialog-close"]') as HTMLElement);
}
/** Open Receive, read, close — for the assertions that only need the value. */
function inReceive<T>(read: () => T): T {
  openReceive();
  const value = read();
  closeReceive();
  return value;
}

/* The SHIELDED short form — the popup shows two addresses, so the
 * helpers say which one they read rather than trusting document order. */
const shortAddress = (): string => inReceive(
  () => document.querySelector('[data-addr="shielded"] .address-short')?.textContent ?? '');
const shortNightAddress = (): string => inReceive(
  () => document.querySelector('[data-addr="unshielded"] .address-short')?.textContent ?? '');

const rows = (): readonly HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[data-wallet-row]')];

function openPicker(): void {
  fireEvent.click(screen.getByText('Switch wallet'));
  expect(rows().length).toBeGreaterThan(0);
}

function switchTo(label: string): void {
  openPicker();
  const row = rows().find((r) => r.textContent?.includes(label));
  expect(row).toBeTruthy();
  fireEvent.click(row!);
}

function renderHome(secret: Secret): ReturnType<typeof render> {
  return render(<Home identity={identityFromSecret(secret)} secret={secret} />);
}

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  cleanup();
  localStorage.clear();
  writeText.mockClear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText }, configurable: true,
  });
});

describe('the picker after unlock, and instant switching — §3', () => {
  it('opens into the main wallet and says so on the address card', () => {
    const secret = newSecret();
    const { container } = renderHome(secret);
    expect(barName(container)).toBe('Main wallet');
    expect(ownerName(container)).toBe('Main wallet');
    expect(hero(container).getAttribute('data-account')).toBe('0');
  });

  it('switches instantly, and the screen visibly becomes another wallet', () => {
    const secret = newSecret();
    const { container } = renderHome(secret);
    const before = shortAddress();
    const beforeNight = shortNightAddress();
    const hueBefore = hero(container).style.getPropertyValue('--wallet-hue');

    switchTo('Subwallet 1');

    /* Not the same screen with different numbers on it: the name, the slot
     * frame's colour, the data-account and the address ALL change. */
    expect(barName(container)).toBe('Subwallet 1');
    expect(ownerName(container)).toBe('Subwallet 1');
    expect(hero(container).getAttribute('data-account')).toBe('2');
    expect(hero(container).style.getPropertyValue('--wallet-hue')).not.toBe(hueBefore);
    expect(shortAddress()).not.toBe(before);
    /* BOTH addresses become the other wallet's — an unshielded string left
     * behind on a switch is the pay-into-the-wrong-wallet failure. */
    expect(shortNightAddress()).not.toBe(beforeNight);
    /* And the switch is announced for a screen reader. */
    expect(screen.getByText('Now showing Subwallet 1')).toBeTruthy();
  });

  it('every subwallet is a different address, and the main wallet comes back unchanged', () => {
    const secret = newSecret();
    renderHome(secret);
    const main = shortAddress();
    const seen = new Set<string>([main]);
    for (const label of ['Subwallet 1', 'Subwallet 2', 'Subwallet 3']) {
      switchTo(label);
      seen.add(shortAddress());
    }
    expect(seen.size).toBe(4);
    switchTo('Main wallet');
    expect(shortAddress()).toBe(main);
  });
});

describe('the slots always exist and are always offered — §2.3', () => {
  it('offers five up front and every one of the ten behind “Show more”, named or not', () => {
    /* The recovery story: a fresh browser, the secret just rebuilt, NO names
     * anywhere — and subwallet 7 with money in it must be reachable. */
    const secret = newSecret();
    renderHome(secret);
    openPicker();
    expect(rows()).toHaveLength(1 + 5);

    fireEvent.click(screen.getByText('Show every slot'));
    const all = rows();
    expect(all).toHaveLength(1 + 10);
    /* The exact accounts on offer: 0 and 2–11. Never 1 — the authority
     * compartment is not a wallet, and no rearrangement of this list may
     * put a button in front of it. */
    expect(all.map((r) => r.getAttribute('data-account')))
      .toEqual(['0', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  });

  it('the tenth slot works like the first', () => {
    const secret = newSecret();
    const { container } = renderHome(secret);
    openPicker();
    fireEvent.click(screen.getByText('Show every slot'));
    const last = rows().find((r) => r.getAttribute('data-account') === '11');
    fireEvent.click(last!);
    expect(barName(container)).toBe('Subwallet 10');
    expect(shortAddress()).toMatch(/^mn_shield-addr_stagenet1/);
  });
});

describe('names are decoration — §2.3, and they travel with the address — §3', () => {
  it('renaming shows on the bar, the picker, the address card — and empties back to the slot', () => {
    const secret = newSecret();
    const { container } = renderHome(secret);
    switchTo('Subwallet 1');

    fireEvent.click(screen.getByLabelText('Name this wallet'));
    fireEvent.change(screen.getByLabelText('A name for subwallet 1'), {
      target: { value: '  Client money  ' },
    });
    fireEvent.click(screen.getByText('Save the name'));

    expect(barName(container)).toBe('Client money');
    expect(ownerName(container)).toBe('Client money');
    /* The slot's own identity stays visible next to the person's name. */
    expect(screen.getAllByText('subwallet 1').length).toBeGreaterThan(0);

    openPicker();
    expect(rows().some((r) => r.textContent?.includes('Client money'))).toBe(true);
    fireEvent.click(rows().find((r) => r.textContent?.includes('Client money'))!);

    /* An empty name is not a deleted wallet: the slot falls back to its own
     * fixed name and stays exactly where it was. */
    fireEvent.click(screen.getByLabelText('Rename this wallet'));
    fireEvent.change(screen.getByLabelText('A name for subwallet 1'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByText('Save the name'));
    expect(barName(container)).toBe('Subwallet 1');
  });

  it('the name is in the copy confirmation and the reveal, not only on the card', async () => {
    const secret = newSecret();
    renderHome(secret);
    switchTo('Subwallet 2');
    fireEvent.click(screen.getByLabelText('Name this wallet'));
    fireEvent.change(screen.getByLabelText('A name for subwallet 2'), {
      target: { value: 'Rent' },
    });
    fireEvent.click(screen.getByText('Save the name'));

    /* The copy controls live in the Receive popup now, so the popup is
     * opened and STAYS open for the whole sequence. Every assertion below is
     * the one that was here before. */
    openReceive();
    fireEvent.click(screen.getByText('Copy the shielded address'));
    /* The confirmation carries the SLOT with the name — two subwallets
     * may share a name, and this is the surface where that matters. The second kind adds
     * the KIND, because one wallet now shows two copyable addresses. */
    expect(await screen.findByText('Copied — the shielded address of Rent (subwallet 2)')).toBeTruthy();

    fireEvent.click(document.querySelector('[data-addr="shielded"] details summary')!);
    expect(screen.getByText(/The full shielded address of Rent \(subwallet 2\):/)).toBeTruthy();
    /* And what went to the clipboard is the full address shown in the
     * reveal — the name decorates, the address is the value. */
    const full = document.querySelector('[data-addr="shielded"] .address-full')?.textContent;
    expect(writeText).toHaveBeenCalledWith(full);
    expect(full).toMatch(/^mn_shield-addr_stagenet1/);

    /* The unshielded block holds the same rule for ITS string. */
    fireEvent.click(screen.getByText('Copy the unshielded address'));
    expect(await screen.findByText('Copied — the unshielded address of Rent (subwallet 2)'))
      .toBeTruthy();
    const unshielded = document.querySelector('[data-addr="unshielded"] .address-full')?.textContent;
    expect(writeText).toHaveBeenCalledWith(unshielded);
    expect(unshielded).toMatch(/^mn_addr_stagenet1/);
  });

  it('opens into the last-used wallet next time', () => {
    const secret = newSecret();
    const first = renderHome(secret);
    switchTo('Subwallet 3');
    expect(barName(first.container)).toBe('Subwallet 3');
    first.unmount();

    const second = renderHome(secret);
    expect(barName(second.container)).toBe('Subwallet 3');
  });
});

describe('another account’s record is not this one’s', () => {
  it('neither names nor the last-used slot carry over to a different secret', () => {
    const stranger = newSecret();
    saveSubwalletName(stranger, 3, 'Savings');
    saveLastUsedWallet(stranger, 3);

    const mine = newSecret();
    const { container } = renderHome(mine);
    expect(barName(container)).toBe('Main wallet');
    openPicker();
    expect(rows().some((r) => r.textContent?.includes('Savings'))).toBe(false);
  });

  it('a damaged record is an absence, never a dead end — names are losable by design', () => {
    localStorage.setItem('midnight-identity:subwallets', '{not json');
    const secret = newSecret();
    const { container } = renderHome(secret);
    expect(barName(container)).toBe('Main wallet');
    /* And the wallet works on: renaming writes a fresh record. */
    switchTo('Subwallet 1');
    fireEvent.click(screen.getByLabelText('Name this wallet'));
    fireEvent.change(screen.getByLabelText('A name for subwallet 1'), {
      target: { value: 'Groceries' },
    });
    fireEvent.click(screen.getByText('Save the name'));
    expect(barName(container)).toBe('Groceries');
  });

  it('storage refuses account 1 in both writers, and ignores it on disk', () => {
    const secret = newSecret();
    expect(() => saveSubwalletName(secret, 1, 'nope')).toThrow(/authority/);
    expect(() => saveLastUsedWallet(secret, 1)).toThrow(/authority/);
    /* A hand-written record pointing at account 1 is not a record. */
    saveSubwalletName(secret, 2, 'kept?');
    const raw = JSON.parse(localStorage.getItem('midnight-identity:subwallets')!) as {
      lastUsed: number;
    };
    localStorage.setItem('midnight-identity:subwallets',
      JSON.stringify({ ...raw, lastUsed: 1 }));
    expect(loadSubwallets(secret)).toEqual({ names: {}, lastUsed: 0 });
  });

  it('forgetting everything forgets the names and the last-used slot', () => {
    const secret = newSecret();
    saveSubwalletName(secret, 2, 'Client money');
    saveLastUsedWallet(secret, 2);
    forgetEverything(ORIGINAL_SLOT);
    expect(loadSubwallets(secret)).toEqual({ names: {}, lastUsed: 0 });
    expect(localStorage.getItem('midnight-identity:subwallets')).toBeNull();
  });
});

describe('securing is about the secret, and the screen says so — §4', () => {
  const PLACEMENTS: readonly Placement[] = [
    { label: 'My Google account', holder: 'google:me' },
    { label: 'Printed card', holder: 'paper' },
    { label: 'Old laptop', holder: 'device:old' },
  ];

  it('the standing notice says one set of pieces covers every subwallet', () => {
    const secret = newSecret();
    renderHome(secret);
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.getByText(/One set of pieces covers every subwallet/)).toBeTruthy();
  });

  it('the tick stays one tick — per secret, never per subwallet — and says it covers them all', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), {
      'google:me': 'never', paper: null, 'device:old': 'never',
    });
    renderHome(secret);
    switchTo('Subwallet 1');
    /* On a subwallet, the SAME record shows: the tick is a fact about the
     * secret, and switching wallets must not flicker it. */
    expect(screen.getByText(/Account secured/)).toBeTruthy();
    expect(screen.getByText(/These pieces cover every subwallet too/)).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe('two wallets, one name, on the screen', () => {
  function nameCurrent(value: string): void {
    fireEvent.click(screen.getByLabelText('Name this wallet'));
    const input = screen.getByPlaceholderText(/Subwallet \d+/);
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByText('Save the name'));
  }

  it('the copy confirmation tells them apart by slot', async () => {
    const secret = newSecret();
    renderHome(secret);

    switchTo('Subwallet 1');
    nameCurrent('Savings');
    openReceive();
    fireEvent.click(screen.getByText('Copy the shielded address'));
    expect(await screen.findByText('Copied — the shielded address of Savings (subwallet 1)'))
      .toBeTruthy();
    const first = document.querySelector('[data-addr="shielded"] .address-full')?.textContent
      ?? '';
    closeReceive();

    switchTo('Subwallet 2');
    nameCurrent('Savings');
    openReceive();
    fireEvent.click(screen.getByText('Copy the shielded address'));
    expect(await screen.findByText('Copied — the shielded address of Savings (subwallet 2)'))
      .toBeTruthy();
    expect(document.querySelector('[data-addr="shielded"] .address-full')?.textContent)
      .not.toBe(first);
  });

  it('the owner line on the card carries the slot whenever the name is personal', () => {
    const secret = newSecret();
    const { container } = renderHome(secret);
    switchTo('Subwallet 1');
    nameCurrent('Savings');
    const ownerRow = container.querySelector('.wallet-owner');
    expect(ownerRow?.textContent).toContain('Savings');
    expect(ownerRow?.textContent).toContain('subwallet 1');
  });
});

describe('the sheet is a snapshot, and renaming says so — the honest half (a)', () => {
  const PLACEMENTS: readonly Placement[] = [
    { label: 'My Google account', holder: 'google:me' },
    { label: 'Printed card', holder: 'paper' },
    { label: 'Old laptop', holder: 'device:old' },
  ];
  const VERIFICATION = { 'google:me': 'never', paper: null, 'device:old': 'never' } as const;

  it('renaming on a SECURED account warns the printed sheet is out of date, with the way to reprint', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);
    renderHome(secret);
    switchTo('Subwallet 1');
    fireEvent.click(screen.getByLabelText('Name this wallet'));
    fireEvent.change(screen.getByLabelText('A name for subwallet 1'), {
      target: { value: 'Invoices' },
    });
    fireEvent.click(screen.getByText('Save the name'));

    expect(screen.getByText(/printed sheet of pieces is now out of date/)).toBeTruthy();
    const reprint = screen.getByText('Reprint it from the securing screen.');
    expect(reprint.getAttribute('href')).toBe('#/secure');
  });

  it('renaming on an UNSECURED account says nothing about a sheet that does not exist', () => {
    const secret = newSecret();
    renderHome(secret);
    switchTo('Subwallet 1');
    fireEvent.click(screen.getByLabelText('Name this wallet'));
    fireEvent.change(screen.getByLabelText('A name for subwallet 1'), {
      target: { value: 'Invoices' },
    });
    fireEvent.click(screen.getByText('Save the name'));
    expect(screen.queryByText(/out of date/)).toBeNull();
  });

  it('mapAsText carries the names, their fixed slots, and the snapshot caveat', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);
    saveSubwalletName(secret, 2, 'Client money');
    saveSubwalletName(secret, 0, 'Everything');
    const record = loadSecuredSetup(secret);
    expect(record).not.toBeNull();
    const sheet = mapAsText(record!, loadSubwallets(secret).names);
    expect(sheet).toContain('Wallet names on this account');
    expect(sheet).toContain('- Main wallet: “Everything”');
    expect(sheet).toContain('- Subwallet 1: “Client money”');
    expect(sheet).toContain('This sheet is a snapshot');
    expect(sheet).toContain('print it again');
    /* And piece bytes are still nowhere near it. */
    expect(sheet).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it('mapAsText without names says nothing about names — no empty ceremony', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);
    const record = loadSecuredSetup(secret);
    expect(mapAsText(record!)).not.toContain('Wallet names');
  });
});

describe('the confirmation is about the value that was copied', () => {
  it('switching wallets clears a live confirmation instead of relabelling it', async () => {
    /* Found writing the owner test: the "Copied" state lived 1.6 seconds, and a
     * switch inside that window re-rendered the confirmation with the NEW
     * wallet's owner while the clipboard still held the OLD wallet's
     * address — the wrong-wallet mistake on the surface built to catch it.
     *
     * THE SWITCH ARRIVES THROUGH THE STORE RATHER THAN THROUGH THE ROW,
     * AND THAT IS THE ONLY WAY TO KEEP THIS TEST HONEST. The copy control is
     * inside the Receive popup and the switcher is another modal behind it, so
     * a picker row cannot be clicked while the confirmation is live — and
     * closing Receive to reach it would UNMOUNT the button, which resets the
     * confirmation for free and would leave this test green with the defect put
     * back. `switchWallet` is exactly what the sidebar's chip calls; the
     * subscribers re-render, the popup's address becomes the other wallet's,
     * and the assertion is untouched: the confirmation must CLEAR rather than
     * be relabelled. Verified by mutation — deleting `ui.tsx`'s reset on a new
     * `text` turns this test red and no other. */
    const secret = newSecret();
    renderHome(secret);
    openReceive();
    fireEvent.click(screen.getByText('Copy the shielded address'));
    expect(await screen.findByText('Copied — the shielded address of Main wallet')).toBeTruthy();

    act(() => { switchWallet(secret, 2); });
    expect(screen.queryByText(/Copied — the/)).toBeNull();
    expect(screen.getByText('Copy the shielded address')).toBeTruthy();
  });
});
