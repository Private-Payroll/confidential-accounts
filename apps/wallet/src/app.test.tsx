// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/*
 * EACH STORED STATE, WIRED TO ITS SCREEN — the second half. The two
 * half-state screens were rendered by no test, so their take-a-copy gates
 * survived being switched off and wiring the wrong screen to a phase
 * survived. This renders the real `App` over real storage states and asserts
 * what a person would actually see.
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

/* jsdom is its own realm: Node's `Buffer` global fails the crypto libraries'
 * `instanceof Uint8Array` checks under it (see home.test.tsx's note).
 * The route-guard test renders the real Home — address derivation and
 * all — so the same polyfill applies here. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;
import { splitSecret } from 'midnight-identity/recovery/pieces';
import type { Placement } from 'midnight-identity/recovery/pieces';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { App } from './app.js';
import { SessionProvider } from './session.js';
import { savePasskey, saveSecret, saveSecuredSetup } from './accounts/storage.js';
import { ORIGINAL_SLOT } from './accounts/wallets-held.js';

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

const PLACEMENTS: readonly Placement[] = [
  { label: 'My Google account', holder: 'google:me' },
  { label: 'Printed card', holder: 'paper' },
];

const mount = (): void => {
  render(<SessionProvider><App /></SessionProvider>);
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = '#/';
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

describe('each stored state renders its own screen', () => {
  it('nothing stored → welcome', () => {
    mount();
    expect(screen.getByText('Your wallet on Midnight.')).toBeTruthy();
  });

  it('account + passkeys → locked, with the replacement door as a secondary act', async () => {
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    mount();
    expect(screen.getByText('Welcome back.')).toBeTruthy();
    /* Where someone lands when the credential is deleted from a
     * platform keychain — the door must exist HERE too. */
    expect(screen.getByText('Make a new passkey for this wallet')).toBeTruthy();
  });

  it('account, no passkey record → the missing-passkey screen', async () => {
    await saveSecret(newSecret());
    mount();
    expect(screen.getByText(/Its passkey went missing/)).toBeTruthy();
    expect(screen.getByText('Make a new passkey for this wallet')).toBeTruthy();
  });

  it('account, DAMAGED passkey record → the same screen, damaged variant', async () => {
    await saveSecret(newSecret());
    localStorage.setItem('midnight-identity:passkeys', 'not json');
    mount();
    expect(screen.getByText(/Its passkey record is damaged/)).toBeTruthy();
    expect(screen.getByText('Discard the damaged record and make a new passkey')).toBeTruthy();
    /* NOT the gravestone: the account behind this screen is alive. */
    expect(screen.queryByText(/can’t be opened here any/)).toBeNull();
  });

  it('passkeys, no account → the reverse screen', () => {
    savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
    mount();
    expect(screen.getByText('A passkey, but no wallet behind it.')).toBeTruthy();
  });

  it('unparseable keyring → broken, with the storage message', () => {
    localStorage.setItem('midnight-identity:keyring', 'not a record {{{');
    mount();
    expect(screen.getByText(/can’t be opened here any/)).toBeTruthy();
    expect(screen.getByText(/damaged/)).toBeTruthy();
  });

  it('broken does NOT own the two doors out of it: recover and add-device render', () => {
    localStorage.setItem('midnight-identity:keyring', 'not a record {{{');
    window.location.hash = '#/add-device';
    mount();
    /* The receive flow, not the gravestone — its landing gate names what is
     * stored here before anything is replaced. */
    expect(screen.getByText('Move a wallet onto this machine.')).toBeTruthy();
    expect(screen.queryByText(/can’t be opened here any/)).toBeNull();
  });
});

describe('the take-a-copy gate on passkey-no-account, pinned at the screen', () => {
  it('with a map on file: no Start fresh until the copy is attested', async () => {
    savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
    const gone = newSecret();
    await saveSecuredSetup(gone, await splitSecret(gone, PLACEMENTS, 2), { 'google:me': 'never', paper: null });
    mount();
    /* The map is there, with its copy and download. */
    expect(await screen.findByText('Where your pieces are')).toBeTruthy();
    expect(screen.getByText('Copy this list')).toBeTruthy();
    expect(screen.getByText('Download it')).toBeTruthy();
    /* The destructive step is not offered until the copy is attested. */
    expect(screen.queryByText('Start fresh…')).toBeNull();
    fireEvent.click(screen.getByText('I have taken a copy of the list'));
    expect(screen.getByText('Start fresh…')).toBeTruthy();
    /* And it is still a second, explicit confirmation after that. */
    fireEvent.click(screen.getByText('Start fresh…'));
    expect(screen.getByText('Create a new wallet')).toBeTruthy();
    fireEvent.click(screen.getByText('Keep things as they are'));
    expect(screen.queryByText('Create a new wallet')).toBeNull();
  });

  it('with no map: no gate to attest, straight to the two-step confirm', () => {
    savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
    mount();
    expect(screen.queryByText(/taken a copy of the list/)).toBeNull();
    expect(screen.getByText('Start fresh…')).toBeTruthy();
  });
});

describe('the recover route refuses to open over a live wallet', () => {
  it('unlocked with no session in flight: #/recover shows the wallet, not a gathering screen', async () => {
    /* A stale link or the Back button must not stand a person in front of a
     * primary button whose landing replaces the wallet that is open. */
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    vi.mocked(usePasskey).mockResolvedValue({ credentialId: 'cred-1' } as never);
    vi.mocked(verifyAssertion).mockResolvedValue(
      { passkey: passkeyFixture('cred-1') } as never);
    mount();
    fireEvent.click(screen.getByText('Unlock with your passkey'));
    expect(await screen.findByText('Every wallet')).toBeTruthy();

    window.location.hash = '#/recover';
    /* Still the wallet — the gathering screen did not render. */
    expect(await screen.findByText('Every wallet')).toBeTruthy();
    expect(screen.queryByText('Recover an account.')).toBeNull();
  });
});

describe('navigation moves focus to the new screen — keyboard and screen reader', () => {
  it('a route change focuses the main region; the first render does not steal focus', async () => {
    mount();
    expect(await screen.findByText('Your wallet on Midnight.')).toBeTruthy();
    expect(document.activeElement === document.querySelector('main')).toBe(false);
    window.location.hash = '#/recover';
    await screen.findByText('Recover an account.');
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('main')));
  });
});

describe('recovery is resumable across navigation — §7.11', () => {
  it('gathered pieces survive leaving the screen and coming back (and not a reload)', async () => {
    const { splitSecret: split } = await import('midnight-identity/recovery/pieces');
    const { toBase64Url: b64 } = await import('midnight-identity/passkey/bytes');
    const secret = newSecret();
    const set = await split(secret, [
      { label: 'A', holder: 'holder-a' },
      { label: 'B', holder: 'holder-b' },
    ], 2);
    window.location.hash = '#/recover';
    mount();
    expect(await screen.findByText('Recover an account.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("The piece's letters, from its card"), {
      target: { value: b64(set.pieces[0]?.bytes ?? new Uint8Array()) },
    });
    fireEvent.change(screen.getByLabelText('Where this piece came from'), {
      target: { value: 'holder-a' },
    });
    fireEvent.click(screen.getByText('Add this piece'));
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();

    /* Leave for home, come back: the session lives in the provider. */
    window.location.hash = '#/';
    expect(await screen.findByText('Your wallet on Midnight.')).toBeTruthy();
    window.location.hash = '#/recover';
    expect(await screen.findByText('1 of 2 pieces.')).toBeTruthy();
  });
});

describe('the footer stopped lying — §7.16, with balances the wallet talks to an indexer', () => {
  it('names the indexer and no longer claims there is no chain connection', () => {
    mount();
    const foot = document.querySelector('.foot');
    expect(foot?.textContent).toContain('indexer.stagenet.shielded.tools');
    expect(foot?.textContent).toContain('only when you ask');
    expect(foot?.textContent).not.toContain('No server, no chain connection');
  });
});
