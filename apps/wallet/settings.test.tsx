// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/*
 * ============================================================================
 * SETTINGS. What each section is for, and what a test here is protecting.
 * ============================================================================
 *
 * Almost nothing on this screen is new capability, so almost every test below
 * is about a SENTENCE rather than about a mechanism: the record already knows
 * these things and the change is whether the screen says them truthfully.
 *
 * The four that are not about words:
 *   - the theme is ONE control behind TWO doors (`useTheme`'s change event);
 *   - a damaged passkey record is a STATE, not an empty list;
 *   - the destructive button is not a tab stop until the name is typed;
 *   - and it really does forget, through the real session, not a stub.
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
import { identityFromSecret, newSecret, splitSecret, verifyAssertion } from 'midnight-identity';
import type { Placement, Secret } from 'midnight-identity';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import type { Passkey } from 'midnight-identity/passkey/verify';
import { App } from './app.js';
import { SessionProvider } from './session.js';
import { Settings } from './screens/settings.js';
import {
  hasAccount, savePasskey, saveArrival, saveCreation, saveSecret, saveSecuredSetup,
} from './storage.js';
import { ORIGINAL_SLOT } from './wallets-held.js';
import { recordTermsSeen } from './terms.js';
import { renameWallet, switchWallet } from './shell/wallets.js';

const PLACEMENTS: readonly Placement[] = [
  { label: 'My Google account', holder: 'google:me' },
  { label: 'Printed card', holder: 'paper' },
  { label: 'Old laptop', holder: 'device:old' },
];

/* THREE HOMES, THREE DIFFERENT ANSWERS. Paper can never be asked; the
 * Google account has been asked and answered; the old laptop could be asked
 * and has not been. One value carrying two of those was the row. */
const VERIFICATION = {
  'google:me': Date.UTC(2026, 7, 20),
  paper: null,
  'device:old': 'never',
} as const;

const passkeyFixture = (over: Partial<Passkey> = {}): Passkey => ({
  credentialId: 'cred-abcdefghijklmnop',
  personHandle: 'person-1',
  publicKeySpki: new Uint8Array([1, 2, 3]),
  algorithm: -7,
  signCount: 0,
  provenBySignIn: false,
  rpId: 'localhost',
  syncsToACloud: false,
  backedUpNow: false,
  transports: [],
  ...over,
});

const settings = (secret: Secret): void => {
  render(<SessionProvider><Settings secret={secret} /></SessionProvider>);
};

/** The real app, unlocked with a real passkey ceremony, standing on Settings. */
async function unlockedOnSettings(secret: Secret): Promise<void> {
  savePasskey(passkeyFixture({ credentialId: 'cred-1' }), ORIGINAL_SLOT);
  await saveSecret(secret);
  vi.mocked(usePasskey).mockResolvedValue({ credentialId: 'cred-1' } as never);
  vi.mocked(verifyAssertion).mockResolvedValue(
    { passkey: passkeyFixture({ credentialId: 'cred-1' }) } as never);
  window.location.hash = '#/';
  render(<SessionProvider><App /></SessionProvider>);
  fireEvent.click(screen.getByText('Unlock with your passkey'));
  await screen.findByText('Every wallet');
  act(() => {
    window.location.hash = '#/settings';
    /* jsdom does not fire `hashchange` on assignment — the measurement is in
     * `reachability.test.tsx`. */
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await screen.findByRole('heading', { name: 'Settings', level: 1 });
}

const sectionNamed = (name: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name, level: 2 });
  const section = heading.closest('section');
  if (!section) throw new Error(`the "${name}" heading is not inside a <section>`);
  return section;
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = '#/';
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

/* ============================================================ §1 this device */

describe('§1 — this wallet, this device', () => {
  it('says which wallet is open, by the name the person gave it', () => {
    const secret = newSecret();
    renameWallet(secret, 0, 'Rent money');
    settings(secret);
    expect(within(sectionNamed('This wallet, this device'))
      .getByText('Rent money')).toBeTruthy();
  });

  it('says CREATED HERE when this browser made the account', () => {
    const secret = newSecret();
    saveCreation(secret);
    settings(secret);
    expect(screen.getByText(/Created here on/)).toBeTruthy();
    expect(screen.queryByText(/^Linked on/)).toBeNull();
  });

  it('says LINKED when the account arrived by pairing', () => {
    const secret = newSecret();
    saveArrival(secret);
    settings(secret);
    expect(screen.getByText(/^Linked on/)).toBeTruthy();
    expect(screen.queryByText(/Created here on/)).toBeNull();
  });

  /**
   * A RECOVERY STAMPS NEITHER, AND THE SCREEN SAYS SO RATHER THAN GUESSING.
   * The whole point: an account put back from pieces is older than this
   * browser, often by a lot, and calling that a creation would be a wrong date
   * rather than a missing one.
   */
  it('says NEITHER when there is no record — a recovery stamps nothing', () => {
    const secret = newSecret();
    settings(secret);
    expect(screen.getByText(/No record of when it arrived/)).toBeTruthy();
    expect(screen.queryByText(/Created here on/)).toBeNull();
  });

  it('shows nothing borrowed from ANOTHER account’s record', () => {
    const mine = newSecret();
    saveCreation(newSecret());
    settings(mine);
    expect(screen.getByText(/No record of when it arrived/)).toBeTruthy();
  });

  /**
   * THE SENTENCE THIS SCREEN OWES. There is no registry, no channel
   * between paired machines and no revocation anywhere in `src/`, and a device
   * list is exactly the component that makes a person assume otherwise. So the
   * screen says it, and points at the thing that DOES work.
   */
  it('says plainly that a device cannot be thrown off, and points at moving the money', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('This wallet, this device');
    expect(within(section).getByText(/There is no way to throw a device off/)).toBeTruthy();
    expect(within(section).getByText(/no register of them, no channel between them/)).toBeTruthy();
    const answer = within(section).getByText('move the money');
    expect(answer.closest('a')?.getAttribute('href')).toBe('#/send');
  });

  it('never counts devices — there is no roster and no number to build one from', () => {
    const secret = newSecret();
    saveArrival(secret);
    settings(secret);
    const words = document.body.textContent ?? '';
    expect(words).not.toMatch(/\b\d+ devices?\b/);
    expect(screen.queryByText(/Devices \(/)).toBeNull();
  });
});

/* ================================================ §1 the theme, two doors */

describe('§1 — the theme is one control behind two doors', () => {
  /**
   * THE RULE: *"`ThemePicker` already exists and this is a SECOND DOOR
   * onto the same control, not a second implementation."* Two `useState`s
   * would have been a second implementation wearing the same component's name:
   * changing it here would repaint the page and leave the rail's trigger
   * showing the old answer. `shell/theme.tsx` carries the change event.
   */
  it('choosing a theme in Settings moves the sidebar’s picker with it', async () => {
    await unlockedOnSettings(newSecret());
    const pickers = () => [...document.querySelectorAll('[data-theme-choice]')];
    expect(pickers().length).toBeGreaterThanOrEqual(2);
    for (const picker of pickers()) expect(picker.getAttribute('data-theme-choice')).toBe('system');

    /* Through Settings' own picker — the one inside the section. */
    const inSettings = within(sectionNamed('This wallet, this device'))
      .getByRole('button', { name: /^Theme:/ });
    /* Radix opens on `pointerdown`, which is what `rail.test.tsx` does too. */
    fireEvent.pointerDown(inSettings, { button: 0, ctrlKey: false });
    fireEvent.click(inSettings);
    await screen.findByText('Follow this machine');
    /* A CLOSED menu renders no content, so the only options in the document
     * are the open one's — Settings' own. */
    const light = document.querySelector('[data-theme-option="light"]');
    expect(light).not.toBeNull();
    fireEvent.click(light as HTMLElement);

    await waitFor(() => {
      const found = pickers();
      expect(found.length).toBeGreaterThanOrEqual(2);
      for (const picker of found) expect(picker.getAttribute('data-theme-choice')).toBe('light');
    });
  });
});

/* ================================================================ §2 backup */

describe('§2 — the backup, in full', () => {
  const secure = async (secret: Secret, partial = false): Promise<void> => {
    await saveSecuredSetup(
      secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION, { partial });
  };

  it('states the quorum off the pieces themselves', async () => {
    const secret = newSecret();
    await secure(secret);
    settings(secret);
    expect(within(sectionNamed('Security')).getByText('Any 2 of 3')).toBeTruthy();
  });

  /**
   * §7.12 — `rebuiltAt` IS A DATED PAST FACT AND MAY NEVER BE PHRASED AS "YOU
   * ARE SAFE". The date is shown under a label that says what it is, and the
   * sentence beneath it refuses the present tense out loud.
   */
  it('shows when it was last PROVED, and refuses to make that a claim about today', async () => {
    const secret = newSecret();
    await secure(secret);
    settings(secret);
    const section = sectionNamed('Security');
    expect(within(section).getByText('Last proved')).toBeTruthy();
    expect(within(section).getByText(
      /actually rebuilt from real pieces/)).toBeTruthy();
    expect(within(section).getByText(/dated past fact and nothing more/)).toBeTruthy();
    expect(within(section).getByText(/not a statement about today/)).toBeTruthy();
    expect(section.textContent).not.toMatch(/you are safe/i);
  });

  /** Three homes, three different sentences, none of them "fine". */
  it('says a different thing for each of the three verification states', async () => {
    const secret = newSecret();
    await secure(secret);
    settings(secret);
    const section = sectionNamed('Security');
    expect(within(section).getAllByText(/unknown — can’t be checked/)).toHaveLength(1);
    expect(within(section).getAllByText(/not yet checked/)).toHaveLength(1);
    expect(within(section).getAllByText(/^checked /)).toHaveLength(1);
  });

  /** A partial map says so rather than implying completeness. */
  it('says out loud when the map names only the pieces this browser saw', async () => {
    const secret = newSecret();
    await secure(secret, true);
    settings(secret);
    expect(screen.getByText(/names only the pieces this browser has seen/)).toBeTruthy();
  });

  it('does NOT say that when the map is complete', async () => {
    const secret = newSecret();
    await secure(secret, false);
    settings(secret);
    expect(screen.queryByText(/names only the pieces this browser has seen/)).toBeNull();
  });

  /** The sentence people get wrong. */
  it('says a replaced set still works, and that re-cutting removes nothing at all', async () => {
    const secret = newSecret();
    await secure(secret);
    await saveSecuredSetup(secret, await splitSecret(secret, [
      { label: 'A new card', holder: 'paper' },
      { label: 'My laptop', holder: 'device:new' },
      { label: 'My Google account', holder: 'google:me' },
    ], 2), { paper: null, 'device:new': 'never', 'google:me': 'never' });
    settings(secret);
    expect(screen.getByText(/its pieces still work/)).toBeTruthy();
    /* The sentence is broken across elements by its own emphasis, so it is
     * read off the section rather than matched as one text node. */
    expect(sectionNamed('Security').textContent)
      .toMatch(/adds a way in and never removes one/);
    expect(screen.getByText(/A new card/)).toBeTruthy();
  });

  it('with nothing on record it says so and offers the ceremony, not a tick', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Security');
    expect(within(section).getByText(/holds no record of any pieces/)).toBeTruthy();
    expect(within(section).queryByText(/Last proved/)).toBeNull();
    expect(within(section).getByText('Cut this account into pieces')
      .getAttribute('href')).toBe('#/secure');
  });

  it('refuses a record cut from a DIFFERENT secret', async () => {
    const mine = newSecret();
    const other = newSecret();
    await saveSecuredSetup(other, await splitSecret(other, PLACEMENTS, 2), VERIFICATION);
    settings(mine);
    expect(within(sectionNamed('Security')).getByText(/holds no record of any pieces/)).toBeTruthy();
  });
});

/* ============================================================== §3 passkeys */

describe('§3 — the passkeys', () => {
  it('says THIS DEVICE ONLY for a credential that cannot sync, and why it matters', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture({ syncsToACloud: false, backedUpNow: false }), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    /* Twice on purpose: the row's own state, and the sentence beneath that
     * explains what that state means. */
    expect(within(section).getAllByText('this device only')).toHaveLength(2);
    expect(within(section).getByText(
      /If this device disappears, nothing above comes back with it/)).toBeTruthy();
    /* In those terms, not WebAuthn's. */
    expect(section.textContent).not.toMatch(/backup eligib|\bBE\b flag|\bBS\b flag/i);
  });

  it('says a cloud-backed credential is copied, and drops the warning', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture({ syncsToACloud: true, backedUpNow: true }), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText('copied to your cloud account')).toBeTruthy();
    expect(within(section).queryByText(/If this device disappears/)).toBeNull();
  });

  /** The middle state is its own sentence: it COULD sync and has not yet. */
  it('distinguishes “can sync” from “is synced”', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture({ syncsToACloud: true, backedUpNow: false }), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText('no cloud copy yet')).toBeTruthy();
    expect(within(section).queryByText('this device only')).toBeNull();
    expect(within(section).queryByText('copied to your cloud account')).toBeNull();
  });

  /**
   * `provenBySignIn` IS NOT DECORATION. A registration carries no
   * signature, so a credential that has never signed anything has never
   * demonstrated that anybody holds its private half.
   */
  it('shows the difference between a credential that has signed in and one that has not yet', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture({ credentialId: 'cred-never-signed-in' }), ORIGINAL_SLOT);
    savePasskey(passkeyFixture({
      credentialId: 'cred-has-signed-in', provenBySignIn: true, signCount: 7,
    }), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText('never signed in')).toBeTruthy();
    expect(within(section).getByText(/has signed in · counter at 7/)).toBeTruthy();
    expect(within(section).getByText(/Making a passkey proves nothing about it/)).toBeTruthy();
  });

  /** Zero means the authenticator does not count — so it is not printed. */
  it('never prints a sign-in counter of zero over a credential that HAS signed in', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture({ provenBySignIn: true, signCount: 0 }), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText('has signed in')).toBeTruthy();
    expect(section.textContent).not.toMatch(/counter at 0/);
  });

  /**
   * The one structural requirement: every row keyed on
   * `credentialId`, so adding removal later is a control in the trailing slot
   * and not a rewrite of the list.
   */
  it('gives every credential its own row, and each row its own identity', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture({ credentialId: 'cred-aaaaaaaaaaaaaaaa' }), ORIGINAL_SLOT);
    savePasskey(passkeyFixture({ credentialId: 'cred-bbbbbbbbbbbbbbbb' }), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText('cred-aa…aaaaaa')).toBeTruthy();
    expect(within(section).getByText('cred-bb…bbbbbb')).toBeTruthy();
  });

  it('says there is no way to remove one yet, rather than leaving a tester hunting', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture(), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText(/no way to remove a passkey here yet/)).toBeTruthy();
    /* SHOW, DO NOT REMOVE — there is no control, in any row. */
    expect(within(section).queryByRole('button', { name: /remove|forget|delete/i })).toBeNull();
  });

  /**
   * DAMAGE IS A STATE, NOT AN EMPTY LIST. `allPasskeys()` throws on a
   * record it cannot read; catching that into `[]` would tell somebody with a
   * healthy keyring that they have no passkeys at all.
   */
  it('shows the storage’s own sentence over a damaged record, never an empty list', () => {
    const secret = newSecret();
    localStorage.setItem('midnight-identity:passkeys', '{not json');
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText(/cannot read its passkey record/)).toBeTruthy();
    expect(within(section).getByText(/is damaged and cannot be read/)).toBeTruthy();
    expect(within(section).queryByText(/No passkeys are recorded/)).toBeNull();
  });

  it('says plainly when there are none, which is a different sentence again', () => {
    const secret = newSecret();
    settings(secret);
    expect(within(sectionNamed('Passkeys'))
      .getByText(/No passkeys are recorded in this browser/)).toBeTruthy();
  });

  /*
   * A CREDENTIAL MADE BEFORE 27 Aug CAN NEVER BE NAMED, AND THE
   * SCREEN SAYS SO WHERE THE CREDENTIAL IS.
   *
   * A passkey's label is fixed by the browser at creation; no web application
   * can rename a saved credential. Naming covered new ones and could not reach
   * old ones. The loss is a person tidying a password manager and deleting the
   * only credential for a wallet whose pieces were never cut.
   *
   * THE SECOND SENTENCE IS THE ONE THAT MATTERS and it is asserted separately
   * from the first: a build that explained the constraint and left out the
   * remedy would pass a test that only looked for the explanation, and would
   * have told a person nothing they could act on.
   */
  it('says the label is fixed by the browser, and names pieces as the remedy', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture(), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section).getByText(/was fixed when the\s+credential was made/)).toBeTruthy();
    expect(within(section)
      .getByText(/nothing in this wallet\s+can change it afterwards/)).toBeTruthy();
    /* The remedy, as its own assertion. */
    expect(within(section).getByText(/Cutting recovery pieces is what does that/)).toBeTruthy();
  });

  /**
   * NO OFFER THE PRODUCT CANNOT HONOUR — the same rule applied to
   * renaming a wallet. There is no control, and the words do not imply one.
   */
  it('makes no offer to rename a credential', () => {
    const secret = newSecret();
    savePasskey(passkeyFixture(), ORIGINAL_SLOT);
    settings(secret);
    const section = sectionNamed('Passkeys');
    expect(within(section)
      .queryByRole('button', { name: /rename|name|edit|change/i })).toBeNull();
    expect(within(section)
      .queryByRole('textbox')).toBeNull();
  });

  /**
   * IT APPEARS WHERE THE CREDENTIAL IS, WHICH MEANS NOT WHERE THERE IS NONE.
   * An empty browser and a damaged record are each their own sentence
   * and a statement about labels over neither is noise in front of a
   * person who has a different problem.
   */
  it('is not said over an empty list or a damaged record', () => {
    const secret = newSecret();
    settings(secret);
    expect(sectionNamed('Passkeys').textContent)
      .not.toMatch(/Cutting recovery pieces is what does that/);
    cleanup();

    localStorage.setItem('midnight-identity:passkeys', '{not json');
    settings(secret);
    expect(sectionNamed('Passkeys').textContent)
      .not.toMatch(/Cutting recovery pieces is what does that/);
  });
});

/* ===================================================== §4 network and hosts */

describe('§4 — network and hosts, read-only', () => {
  it('names the network and every host, off the constants themselves', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Network and hosts');
    expect(within(section).getByText('stagenet')).toBeTruthy();
    expect(within(section).getByText('indexer.stagenet.shielded.tools')).toBeTruthy();
    expect(within(section).getByText('rpc.stagenet.shielded.tools')).toBeTruthy();
    expect(within(section).getByText(window.location.origin)).toBeTruthy();
    expect(within(section).getByText(window.location.hostname)).toBeTruthy();
  });

  /**
   * THE TRADE IS SAID IN FULL, NOT IN A TRUNCATED ROW. `ListRow` clips a
   * subtitle on purpose, and the first screenshot of this screen showed these
   * sentences ending in an ellipsis — *"Only when you ask — asking tells it
   * this w…"*. A row that leads nowhere cannot put the rest of the sentence on
   * the screen it leads to, so the sentences moved under the card, and this is
   * what stops them drifting back into a row.
   */
  it('says the whole privacy trade somewhere nothing clips it', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Network and hosts');
    expect(within(section).getByText(
      /Reading a balance tells the indexer this wallet’s address/)).toBeTruthy();
    expect(within(section).getByText(/no third party is asked to prove anything/)).toBeTruthy();
    /* And nothing on the screen ends in the clip character. */
    expect(section.textContent).not.toMatch(/\u2026(\s|$)/);
  });

  /**
   * NO SWITCHER AND NO EDITABLE INDEXER, AND THE REASONS ARE DIFFERENT — both
   * of them money. This asserts the absence structurally rather than by words:
   * nothing in the section can be typed into or chosen from.
   */
  it('offers nothing that could change any of it', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Network and hosts');
    expect(section.querySelectorAll('input')).toHaveLength(0);
    expect(section.querySelectorAll('select')).toHaveLength(0);
    expect(section.querySelectorAll('button')).toHaveLength(0);
    expect(within(section).getByText(/no network switcher and no indexer field/)).toBeTruthy();
  });

  it('says the terms have not been fetched, rather than showing an empty hash', () => {
    const secret = newSecret();
    settings(secret);
    expect(within(sectionNamed('Network and hosts'))
      .getByText(/Not fetched yet/)).toBeTruthy();
  });

  it('shows the terms hash once this browser has seen them', () => {
    const secret = newSecret();
    recordTermsSeen({ hash: 'abc123def456', url: 'https://terms.example/doc' });
    settings(secret);
    const section = sectionNamed('Network and hosts');
    expect(within(section).getByText('abc123def456')).toBeTruthy();
    expect(within(section).getByText('The terms document')
      .getAttribute('href')).toBe('https://terms.example/doc');
  });
});

/* ============================================ §5, §6, §8 the honest not-yets */

describe('§5, §6, §8 — the rooms that are not built', () => {
  /**
   * What no round may build is an input that accepts a
   * contact and drops it. The book is a DOOR here and nothing else.
   */
  it('the address book is a door and never an input that would drop a contact', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Contacts');
    expect(within(section).getByText('Manage your contacts')
      .closest('a')?.getAttribute('href')).toBe('#/address-book');
    expect(section.querySelectorAll('input')).toHaveLength(0);
    expect(section.querySelectorAll('textarea')).toHaveLength(0);
    expect(within(section).getByText(/never stand in place of one/)).toBeTruthy();
  });

  it('advanced is a door, and says what is behind it', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Advanced');
    expect(within(section).getByText(/recovery phrase/)
      .closest('a')?.getAttribute('href')).toBe('#/advanced');
    expect(within(section).getByText(/Anyone who reads the phrase owns the account/)).toBeTruthy();
  });

  /** There is no route behind the agent, so there is no link — a dead one
   * would be worse than a row that says what is coming. */
  it('the agent is a row with no door, and names the property that is expensive to retrofit', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('The agent');
    expect(section.querySelectorAll('a[href]')).toHaveLength(0);
    expect(within(section).getByText(/bearer credential/)).toBeTruthy();
    expect(within(section).getByText(/sealed storage/)).toBeTruthy();
    expect(within(section).getByText(/never approves/)).toBeTruthy();
  });
});

/* =============================================================== §7 the danger */

describe('§7 — the danger section', () => {
  const forgetButton = (): HTMLButtonElement =>
    screen.getByRole('button', { name: 'Forget this wallet' }) as HTMLButtonElement;

  it('is the last thing on the page', () => {
    const secret = newSecret();
    settings(secret);
    const sections = [...document.querySelectorAll('main section, section')];
    const last = sections[sections.length - 1];
    expect(last?.getAttribute('data-tone')).toBe('danger');
  });

  /**
   * THE RULE: *"never the target of a stray keyboard path — it is the
   * last thing tabbed to, not the first."* A disabled button is not a tab stop
   * at all, so until the name is composed there is nothing there to land on.
   */
  it('is not pressable, and not even a tab stop, until the wallet’s name is typed', () => {
    const secret = newSecret();
    renameWallet(secret, 0, 'Rent money');
    settings(secret);
    expect(forgetButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'rent money' } });
    expect(forgetButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Rent money' } });
    expect(forgetButton().disabled).toBe(false);
  });

  /**
   * THE ONE CASE WHERE THIS BUTTON IS THE LAST EVENT IN THE MONEY'S LIFE. A
   * secured wallet's warning may say what a secured wallet can do; an
   * unsecured one's must not imply a way back that does not exist.
   */
  it('warns an UNSECURED wallet that there is nothing to put it back with', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Forget this wallet');
    expect(within(section).getByText(/nothing to put it back with/)).toBeTruthy();
    expect(within(section).getByText(/gone with it, permanently/)).toBeTruthy();
    /* And it must NOT offer the secured wallet's reassurance. */
    expect(section.textContent).not.toMatch(/Your pieces are what puts this account back/);
  });

  it('tells a SECURED wallet the truth instead — the pieces are not in this browser', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);
    settings(secret);
    const section = sectionNamed('Forget this wallet');
    expect(within(section).getByText(/Your pieces are what puts this account back/)).toBeTruthy();
    expect(section.textContent).not.toMatch(/nothing to put it back with/);
  });

  /**
   * `shell/prefs.ts`: *"a person pressing that button is asking about their
   * money, and a wallet that answered by also resetting the theme would be
   * telling them it had done something it had not."* So the screen says what
   * it does not touch, and the theme control is NOT grouped down here.
   */
  it('says what it clears AND what it does not, including the theme', () => {
    const secret = newSecret();
    settings(secret);
    const section = sectionNamed('Forget this wallet');
    expect(within(section).getByText(/the sealed account keys in this browser/)).toBeTruthy();
    expect(within(section).getByText(/the record of where your pieces are/)).toBeTruthy();
    expect(within(section).getByText(/the pieces themselves, wherever you placed them/)).toBeTruthy();
    expect(within(section).getByText(/anything on the chain/)).toBeTruthy();
    expect(within(section).getByText(/your theme and sidebar/)).toBeTruthy();
    /* And the theme control itself lives in §1, not in here. */
    expect(section.querySelectorAll('[data-theme-choice]')).toHaveLength(0);
  });

  /**
   * A screen with a destructive button on it is RENDERED by a
   * test, and the button is pressed here through the real session rather than
   * through a stub, because what is being asserted is that it really forgets.
   */
  it('really forgets, through the real session', async () => {
    const secret = newSecret();
    await unlockedOnSettings(secret);
    expect(hasAccount(ORIGINAL_SLOT)).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Main wallet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forget this wallet' }));

    await waitFor(() => { expect(hasAccount(ORIGINAL_SLOT)).toBe(false); });
    /* And the browser lands where a browser with nothing in it lands. */
    expect(await screen.findAllByText(/Move it onto this machine/)).not.toHaveLength(0);
  });

  /**
   * DECIDED 21 AUG. **The sentence a person performs must be
   * the same size as the act.** The design asked for the OPEN wallet's name; what this
   * button clears is every slot, the passkeys, the piece map and the stamps.
   * On the main wallet the two coincide and it read correctly. **On a
   * subwallet it read *Type Savings to confirm* over a control that erases all
   * eleven**, which is the whole of the finding.
   */
  it('on a SUBWALLET it asks for the ACCOUNT’s name, never the open wallet’s', () => {
    const secret = newSecret();
    renameWallet(secret, 0, 'Everything');
    renameWallet(secret, 3, 'Savings');
    switchWallet(secret, 3);
    settings(secret);

    /* The open wallet is named on the page, because it is — §1 says which
     * wallet is open and that has not changed. */
    const open = sectionNamed('This wallet, this device');
    expect(within(open).getByText('Savings')).toBeTruthy();

    /* And the guard asks for the other one, labelled as the ACCOUNT. */
    const danger = sectionNamed('Forget this wallet');
    const label = screen.getByLabelText(/Type/);
    expect(within(danger).getByText(/the account’s name/u)).toBeTruthy();
    expect(within(danger).getByText('Everything')).toBeTruthy();
    expect(danger.textContent).not.toMatch(/Type the account’s name — Savings/u);

    /* Typing the OPEN wallet's name does nothing at all… */
    fireEvent.change(label, { target: { value: 'Savings' } });
    expect(forgetButton().disabled).toBe(true);
    /* …and typing the account's name is what arms it. */
    fireEvent.change(label, { target: { value: 'Everything' } });
    expect(forgetButton().disabled).toBe(false);
  });

  /** And when nobody has renamed anything, the string still exists:
   * `displayNameOf` falls back to the slot's own fixed name. */
  it('an unrenamed account is still askable — the fallback name is a real string', () => {
    const secret = newSecret();
    switchWallet(secret, 4);
    settings(secret);
    const danger = sectionNamed('Forget this wallet');
    expect(within(danger).getByText('Main wallet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Subwallet 3' } });
    expect(forgetButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Main wallet' } });
    expect(forgetButton().disabled).toBe(false);
  });

  it('does nothing at all while the name is wrong', () => {
    const secret = newSecret();
    saveCreation(secret);
    settings(secret);
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Main wallett' } });
    fireEvent.click(forgetButton());
    /* The stamp this browser wrote is still there. */
    expect(localStorage.getItem('midnight-identity:created')).not.toBeNull();
  });
});

/* ================================================= the screen as a whole */

describe('what Settings must never do', () => {
  /**
   * The money card is frozen for later, and the deferral is
   * only free while **no second reader of money exists**. Settings reads none:
   * no balance, no indexer, no atomic units.
   */
  it('shows no money and asks nobody for any', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);
    savePasskey(passkeyFixture(), ORIGINAL_SLOT);
    settings(secret);
    const words = document.body.textContent ?? '';
    expect(words).not.toMatch(/STAR|SPECK|tNIGHT|DUST/);
    expect(words).not.toMatch(/Check the balance/);
  });

  /**
   * The same neighbourhood: `ownedAddressFor` is the ONE door from a slot to a
   * renderable address and it carries the owner with it. A settings page has
   * no reason to open that door, so it does not — one fewer surface where a
   * name could arrive without its slot.
   */
  it('renders no address at all', async () => {
    const secret = newSecret();
    settings(secret);
    const words = document.body.textContent ?? '';
    expect(words).not.toMatch(/mn_shield-addr|mn_addr/);
    void identityFromSecret(secret);
  });
});
