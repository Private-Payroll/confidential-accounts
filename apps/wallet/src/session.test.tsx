// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { ReactNode } from 'react';

/*
 * THE SESSION, DRIVEN THROUGH ITS SCREENS' EYES. Until this file
 * existed, nothing executed session.tsx: eleven single-line changes to the
 * shell left the suite green, including one that showed a person a working,
 * payable wallet whose secret was never saved. The ceremonies are mocked —
 * there is no authenticator in a test runner, which is exactly why
 * `browser/passkey.ts` was built thin — and VERIFICATION and STORAGE are
 * real: real challenge store, real seal/unseal over fake-indexeddb, real
 * derivation after unlock.
 */

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return { ...actual, verifyRegistration: vi.fn(), verifyAssertion: vi.fn() };
});

import { createPasskey, usePasskey } from 'midnight-identity/browser';
import { verifyAssertion, verifyRegistration } from 'midnight-identity';
import type { ChallengeStore } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import { fingerprintOf, splitSecret } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { SessionProvider, useSession } from './session.js';
import { ORIGINAL_SLOT, forgetOpenWallet, heldWallets, openWalletId } from './accounts/wallets-held.js';
import {
  allPasskeys, loadSecret, savePasskey, saveSecret, saveSecuredSetup, saveWalletName,
} from './accounts/storage.js';

const mockCreatePasskey = vi.mocked(createPasskey);
const mockUsePasskey = vi.mocked(usePasskey);
const mockVerifyRegistration = vi.mocked(verifyRegistration);
const mockVerifyAssertion = vi.mocked(verifyAssertion);

const passkeyFixture = (credentialId: string, extra: Partial<Passkey> = {}): Passkey => ({
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
  ...extra,
});

/* The ceremony's raw output is opaque to the session — it hands it straight
 * to the (mocked) verifier — so a minimal object is enough. */
const registrationFixture = {
  credentialId: 'cred-1', personHandle: 'cGVyc29uLTE', clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(), publicKeySpki: new Uint8Array([1, 2, 3]),
  publicKeyAlgorithm: -7, transports: [],
};
const assertionFixture = (credentialId: string) => ({
  credentialId, clientDataJSON: new Uint8Array(), authenticatorData: new Uint8Array(),
  signature: new Uint8Array(), userHandle: 'cGVyc29uLTE',
});

function Probe(): ReactNode {
  const session = useSession();
  return (
    <div>
      <div data-testid="phase">{session.phase.name}</div>
      <div data-testid="error">{session.error ?? ''}</div>
      <div data-testid="broken-message">
        {session.phase.name === 'broken' ? session.phase.message : ''}
      </div>
      {/* "opens the SAME account" is asserted against the UNLOCKED
        * secret, not against what storage happens to hold — a mutation that
        * swaps in a fresh secret writes the very record a storage assertion
        * would read, and passes it. */}
      <div data-testid="secret-fp">
        {session.phase.name === 'unlocked'
          ? toBase64Url(fingerprintOf(session.phase.secret))
          : ''}
      </div>
      <button type="button" onClick={() => { void session.createAccount(); }}>create</button>
      <button type="button" onClick={() => { void session.unlock(); }}>unlock</button>
      <button type="button" onClick={() => { void session.adoptPasskey(); }}>adopt</button>
      <button type="button" onClick={() => { void session.startFresh(); }}>fresh</button>
      {/* The list, the switch and the removal, as data and buttons. The
        * list is rendered as one string so a test can assert the ORDER and the
        * open one in a single comparison. */}
      <div data-testid="wallets">
        {session.wallets.map((w) => `${w.name ?? '(unnamed)'}${w.current ? '*' : ''}`)
          .join(' | ')}
      </div>
      {session.wallets.map((w, i) => (
        <button key={w.id} type="button" onClick={() => session.switchTo(w.id)}>
          {`switch-${i}`}
        </button>
      ))}
      <button type="button" onClick={() => { session.lock(); }}>lock</button>
      <button type="button" onClick={() => { session.startOver(); }}>forget</button>
    </div>
  );
}

const mount = (challenges?: ChallengeStore): void => {
  render(
    <SessionProvider {...(challenges ? { challenges } : {})}>
      <Probe />
    </SessionProvider>,
  );
};

const phase = (): string => screen.getByTestId('phase').textContent ?? '';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* Which compartment a window has open is module state, because a
   * window keeps looking at one wallet while another window opens another.
   * Module state outlives a test, so every test here starts with none. */
  forgetOpenWallet();
});

describe('creating an account', () => {
  it('lands the secret and the passkey, and unlocks', async () => {
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-1'));
    mount();
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-1']);
    expect(localStorage.getItem('midnight-identity:keyring')).not.toBeNull();
  });

  it('NEVER shows a wallet whose secret was not saved — the rollback, pinned', async () => {
    /* The worst mutation found alive: empty the rollback catch
     * and a person is shown a working, payable address whose secret dies at
     * the next reload. Here IndexedDB refuses, so saveSecret cannot land. */
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-1'));
    mount();
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => expect(phase()).not.toBe('welcome'));
    /* Not unlocked — there is nothing saved to unlock. */
    expect(phase()).toBe('broken');
    expect(localStorage.getItem('midnight-identity:keyring')).toBeNull();
    /* And the passkey record was rolled back, or every retry dies on the exclude list. */
    expect(localStorage.getItem('midnight-identity:passkeys')).toBeNull();
    /* ADDED, nothing above loosened. The creation stamp is written
     * AFTER the seal, so a wallet that never landed leaves no claim that it
     * began here. A stamp written beside `newSecret()` instead would survive
     * this rollback and date an account that does not exist. */
    expect(localStorage.getItem('midnight-identity:created')).toBeNull();
  });

  /*
   * CREATION IS THE ONLY THING THAT STAMPS A CREATION.
   *
   * Home's device card says *"Created in this browser on <date>"*, and the
   * whole design problem here is that three paths put a
   * keyring in a browser and only one of them is a beginning. This is the
   * positive half; the negatives are pinned where those paths run —
   * `recover.test.tsx` (a recovery stamps nothing) and `add-device.test.tsx`,
   * whose own test already asserts the EXACT set of keys a completed
   * pairing leaves behind and would go red the day a creation stamp joined it.
   *
   * AND IT IS WRITTEN AFTER THE SEAL, which the rollback test below pins: a
   * keyring that could not be stored is a creation that did not happen, and a
   * stamp written first would outlive the wallet it claimed to be about.
   */
  it('stamps WHEN the account was created here', async () => {
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-1'));
    mount();
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    const stamp = JSON.parse(
      localStorage.getItem('midnight-identity:created') ?? 'null') as
      { fingerprint: string; at: number } | null;
    expect(stamp).not.toBeNull();
    /* Fingerprint-bound exactly as `ArrivalRecord` is, so it cannot be
     * read over a different account, and dated. */
    expect(typeof stamp?.fingerprint).toBe('string');
    expect(stamp?.at).toBeGreaterThan(0);
    /* NOTHING THAT COULD BE READ AS A ROSTER. By design: this
     * wallet cannot know how many devices hold this account and must not
     * appear to, so the record holds no list and no count to build one from. */
    expect(Object.keys(stamp ?? {}).sort()).toEqual(['at', 'fingerprint']);
  });

  it('passes every stored credential to the authenticator', async () => {
    savePasskey(passkeyFixture('cred-old'), ORIGINAL_SLOT);
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-1'));
    /*
     * THE FIXTURE NO LONGER SEEDS A KEYRING, AND THE STATE IT LEAVES
     * IS THE POINT RATHER THAN A CONVENIENCE.
     *
     * It used to `saveSecret` as well, with the note *"an account exists, so
     * the shell starts locked; drive create anyway"* — driving the create
     * ceremony over a stored wallet purely to reach the exclude list. That is
     * now refused at the press, and rightly: overwriting the wallet sealed
     * here is the one thing creating must never do.
     *
     * **A CREDENTIAL WITH NO WALLET BEHIND IT IS A REAL STATE AND IT MUST
     * STILL BE ABLE TO CREATE.** A password manager offering a passkey to a
     * browser whose storage was cleared leaves exactly this, and a person in
     * it has to be able to make a wallet — a refusal there is a locked door
     * with nothing on the other side of it. So the fixture is now that state,
     * asserted below, and this test pins BOTH claims at once: the ceremony
     * runs, and its exclude list names what this browser holds.
     *
     * THE EXCLUDE LIST IS UNCHANGED AND STILL PINNED. `existing` comes off `allPasskeys()`,
     * which has nothing to do with the keyring — asking an authenticator for
     * a second credential under a known handle silently destroys the first,
     * and this list is what turns that into a refusal.
     */
    mount();
    expect(phase()).toBe('passkey-no-account');
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => expect(mockCreatePasskey).toHaveBeenCalled());
    expect(mockCreatePasskey.mock.calls[0]?.[0]?.existing).toEqual(['cred-old']);
  });
});

describe('unlocking', () => {
  async function seedAccount(secret = newSecret()): Promise<void> {
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    savePasskey(passkeyFixture('cred-2'), ORIGINAL_SLOT);
    await saveSecret(secret);
  }

  it('verifies against the credential the assertion names, not the first stored', async () => {
    await seedAccount();
    mockUsePasskey.mockResolvedValue(assertionFixture('cred-2'));
    mockVerifyAssertion.mockResolvedValue({
      personHandle: 'person-1', signCount: 7, userVerified: true, backedUpNow: false,
      passkey: passkeyFixture('cred-2', { signCount: 7, provenBySignIn: true }),
    });
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(mockVerifyAssertion.mock.calls[0]?.[1]?.credentialId).toBe('cred-2');
  });

  it('saves the moved sign counter, or the clone detector goes blind', async () => {
    await seedAccount();
    mockUsePasskey.mockResolvedValue(assertionFixture('cred-2'));
    mockVerifyAssertion.mockResolvedValue({
      personHandle: 'person-1', signCount: 7, userVerified: true, backedUpNow: false,
      passkey: passkeyFixture('cred-2', { signCount: 7, provenBySignIn: true }),
    });
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    const stored = allPasskeys(ORIGINAL_SLOT).find((p) => p.credentialId === 'cred-2');
    expect(stored?.signCount).toBe(7);
    expect(stored?.provenBySignIn).toBe(true);
  });

  it('an ordinary failure is a red line on the unlock screen, never the broken screen', async () => {
    await seedAccount();
    mockUsePasskey.mockResolvedValue(assertionFixture('cred-1'));
    mockVerifyAssertion.mockRejectedValue(new Error('the signature did not verify.'));
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('the signature did not verify.'));
    /* `instanceof StorageError` weakened to `if (e)` sends this to the
     * tombstone screen; the person retries a cancelled Touch ID, they do not
     * recover an account. */
    expect(phase()).toBe('locked');
  });
});

describe('the StorageError seam — both codes, by state not sentence', () => {
  const passCeremony = (): void => {
    mockUsePasskey.mockResolvedValue(assertionFixture('cred-1'));
    mockVerifyAssertion.mockResolvedValue({
      personHandle: 'person-1', signCount: 1, userVerified: true, backedUpNow: false,
      passkey: passkeyFixture('cred-1', { signCount: 1 }),
    });
  };

  it('a damaged keyring record reaches the broken screen', async () => {
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    localStorage.setItem('midnight-identity:keyring', 'not json {{{');
    passCeremony();
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('broken'));
    expect(screen.getByTestId('broken-message').textContent).toContain('damaged');
  });

  it('a vanished sealing key reaches the broken screen with the right sentence', async () => {
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    /* Cleared site data: ciphertext survives, the key does not. */
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    passCeremony();
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('broken'));
    expect(screen.getByTestId('broken-message').textContent)
      .toContain('the key that opens it is gone');
  });

  it('a damaged PASSKEY record is a state with doors, not "your account is elsewhere"', async () => {
    await saveSecret(newSecret());
    localStorage.setItem('midnight-identity:passkeys', 'not json');
    passCeremony();
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('broken'));
    /* The old behaviour: [] from the parse guard, then "that passkey is not
     * one this browser knows about … the keys moved onto it first" — sending
     * the person away from the machine that holds their sealed keys. */
    expect(screen.getByTestId('broken-message').textContent).toContain('passkeys');
  });
});

describe('the one-use challenge, pinned through the injectable store', () => {
  /* A store that mints real-looking challenges and refuses every take: the
   * captured-request story, where a challenge presented has already been
   * spent. The session must refuse BEFORE verification ever runs. */
  const spentStore: ChallengeStore = {
    issue: () => Promise.resolve('Y2hhbGxlbmdl'),
    take: () => Promise.resolve(false),
  };

  it('a spent sign-in challenge is refused, before verification', async () => {
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    mockUsePasskey.mockResolvedValue(assertionFixture('cred-1'));
    mount(spentStore);
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toContain('challenge expired'));
    expect(phase()).toBe('locked');
    expect(mockVerifyAssertion).not.toHaveBeenCalled();
  });

  it('a spent registration challenge is refused, and nothing is saved', async () => {
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mount(spentStore);
    fireEvent.click(screen.getByText('create'));
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toContain('challenge expired'));
    expect(phase()).toBe('welcome');
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
    expect(localStorage.getItem('midnight-identity:keyring')).toBeNull();
    expect(localStorage.getItem('midnight-identity:passkeys')).toBeNull();
  });
});

describe('the half-states a partial clear leaves behind', () => {
  it('a sealed account with no passkey record is its own phase, up front', async () => {
    await saveSecret(newSecret());
    mount();
    expect(phase()).toBe('account-no-passkey');
  });

  it('passkey records with no sealed account are the reverse phase', () => {
    savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
    mount();
    expect(phase()).toBe('passkey-no-account');
  });

  it('a damaged passkey record is detected at LOAD, not at the first click', () => {
    localStorage.setItem('midnight-identity:passkeys', 'not json');
    mount();
    expect(phase()).toBe('broken');
  });

  it('adoptPasskey opens the SAME sealed account — the identity derives from the seeded secret', async () => {
    /* The assertion holds the secret that was seeded and compares the
     * UNLOCKED identity's secret against it. A mutation that swaps in a
     * fresh `newSecret()` — a new wallet at a new address behind a button
     * labelled "make a new passkey for this wallet" — fails here, as does
     * unlocking on thirty-two zero bytes when the null check is dropped. */
    const secret = newSecret();
    await saveSecret(secret);
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    mount();
    expect(phase()).toBe('account-no-passkey');
    fireEvent.click(screen.getByText('adopt'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(secret)));
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-new']);
  });

  it('unlock also hands back the seeded secret, not whatever storage now holds', async () => {
    const secret = newSecret();
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    await saveSecret(secret);
    mockUsePasskey.mockResolvedValue(assertionFixture('cred-1'));
    mockVerifyAssertion.mockResolvedValue({
      personHandle: 'person-1', signCount: 1, userVerified: true, backedUpNow: false,
      passkey: passkeyFixture('cred-1', { signCount: 1 }),
    });
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(secret)));
  });

  it('a refused ceremony during adoption is a red line, and the account stays put', async () => {
    await saveSecret(newSecret());
    mockCreatePasskey.mockRejectedValue(new Error('the passkey was not created — it was cancelled, or it timed out.'));
    mount();
    fireEvent.click(screen.getByText('adopt'));
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toContain('cancelled'));
    expect(phase()).toBe('account-no-passkey');
    expect(localStorage.getItem('midnight-identity:keyring')).not.toBeNull();
  });

  it('startFresh clears the stale records — including a stale piece map — and creates anew', async () => {
    savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
    /* A stale secured record from the vanished account: the map the copy gate
     * on the SCREEN makes the person copy before this can be clicked. */
    const gone = newSecret();
    await saveSecuredSetup(gone, await splitSecret(gone, [
      { label: 'My Google account', holder: 'google:me' },
      { label: 'Printed card', holder: 'paper' },
    ], 2), { 'google:me': 'never', paper: null });
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    mount();
    expect(phase()).toBe('passkey-no-account');
    fireEvent.click(screen.getByText('fresh'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-new']);
    expect(localStorage.getItem('midnight-identity:secured')).toBeNull();
    /* And the new create saw an EMPTY exclude list — the stale credential is
     * forgotten, not carried into the exclude list for ever. */
    expect(mockCreatePasskey.mock.calls[0]?.[0]?.existing).toEqual([]);
  });
});

describe('damaged public data over a live account is a doorway, never a gravestone', () => {
  it('a damaged passkey record with a READABLE keyring is account-no-passkey, not broken', async () => {
    await saveSecret(newSecret());
    localStorage.setItem('midnight-identity:passkeys', 'not json');
    mount();
    expect(phase()).toBe('account-no-passkey');
  });

  it('adopting over a damaged record discards it and opens the SAME account', async () => {
    const secret = newSecret();
    await saveSecret(secret);
    localStorage.setItem('midnight-identity:passkeys', 'not json');
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    mount();
    fireEvent.click(screen.getByText('adopt'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(secret)));
    /* The unreadable record was replaced by the door the person pressed. */
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-new']);
  });

  it('the same door works from locked — the credential deleted from a platform keychain', async () => {
    const secret = newSecret();
    savePasskey(passkeyFixture('cred-gone-from-keychain'), ORIGINAL_SLOT);
    await saveSecret(secret);
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    mount();
    expect(phase()).toBe('locked');
    fireEvent.click(screen.getByText('adopt'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(secret)));
    /* From a HEALTHY store the record is appended, never replaced — and the
     * ceremony was told about the stored credential. */
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId).sort())
      .toEqual(['cred-gone-from-keychain', 'cred-new']);
    expect(mockCreatePasskey.mock.calls[0]?.[0]?.existing)
      .toEqual(['cred-gone-from-keychain']);
  });
});

describe('the promise on the screen is kept before anything is minted', () => {
  it('a sealed copy that cannot be opened runs NO ceremony and writes nothing', async () => {
    await saveSecret(newSecret());
    /* The sealing key is gone; the keyring string still exists and parses. */
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    mount();
    /* The background probe flips the screen to the true state on its own… */
    await waitFor(() => expect(phase()).toBe('broken'));
    expect(screen.getByTestId('broken-message').textContent)
      .toContain('the key that opens it is gone');
    /* …and no credential was bought with a biometric along the way. */
    expect(mockCreatePasskey).not.toHaveBeenCalled();
    expect(localStorage.getItem('midnight-identity:passkeys')).toBeNull();
  });

  it('an unparseable keyring is broken at LOAD — never "your wallet is here"', () => {
    localStorage.setItem('midnight-identity:keyring', 'not a record {{{');
    mount();
    expect(phase()).toBe('broken');
    expect(screen.getByTestId('broken-message').textContent).toContain('damaged');
    expect(mockCreatePasskey).not.toHaveBeenCalled();
  });

  it('the click path opens-first too: adopt from a just-broken copy mints nothing', async () => {
    await saveSecret(newSecret());
    mount();
    expect(phase()).toBe('account-no-passkey');
    /* The key vanishes AFTER the screen rendered — the race the probe alone
     * cannot win. The click must still open first and mint nothing. */
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    fireEvent.click(screen.getByText('adopt'));
    await waitFor(() => expect(phase()).toBe('broken'));
    expect(mockCreatePasskey).not.toHaveBeenCalled();
  });
});

describe('THE ORDER — nothing is forgotten until the new secret has landed', () => {
  const PLACEMENTS = [
    { label: 'My Google account', holder: 'google:me' },
    { label: 'Printed card', holder: 'paper' },
  ];

  async function seedStaleWithMap(): Promise<void> {
    savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
    const gone = newSecret();
    await saveSecuredSetup(gone, await splitSecret(gone, PLACEMENTS, 2),
      { 'google:me': 'never', paper: null });
  }

  it('a cancelled ceremony costs nothing — the map is intact', async () => {
    await seedStaleWithMap();
    mockCreatePasskey.mockRejectedValue(
      new Error('the passkey was not created — it was cancelled, or it timed out.'));
    mount();
    expect(phase()).toBe('passkey-no-account');
    fireEvent.click(screen.getByText('fresh'));
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toContain('cancelled'));
    /* Still on the screen, map still on record, stale records untouched. */
    expect(phase()).toBe('passkey-no-account');
    expect(localStorage.getItem('midnight-identity:secured')).not.toBeNull();
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-stale']);
  });

  it('a failed save costs nothing either — and the ceremony used an empty exclude list', async () => {
    await seedStaleWithMap();
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    mount();
    fireEvent.click(screen.getByText('fresh'));
    await waitFor(() => expect(phase()).toBe('broken'));
    /* The stale credential was kept out of the way by the EMPTY exclude
     * list, not by deleting first — so the map survives the failure. */
    expect(mockCreatePasskey.mock.calls[0]?.[0]?.existing).toEqual([]);
    expect(localStorage.getItem('midnight-identity:secured')).not.toBeNull();
  });

  it('success replaces the stale records and removes the map — in that order, last', async () => {
    await seedStaleWithMap();
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    mount();
    fireEvent.click(screen.getByText('fresh'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-new']);
    expect(localStorage.getItem('midnight-identity:secured')).toBeNull();
  });
});

describe('the replacement credentials are tellable from the original', () => {
  it('adopt and start-fresh both mint a distinguishing person.name', async () => {
    await saveSecret(newSecret());
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    mount();
    fireEvent.click(screen.getByText('adopt'));
    await waitFor(() => expect(mockCreatePasskey).toHaveBeenCalled());
    const adoptName = mockCreatePasskey.mock.calls[0]?.[0]?.person.name ?? '';
    expect(adoptName).not.toBe('Midnight wallet');
    expect(adoptName).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('adoptPasskey refuses a spent challenge, like unlock does', async () => {
    await saveSecret(newSecret());
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mount({
      issue: () => Promise.resolve('Y2hhbGxlbmdl'),
      take: () => Promise.resolve(false),
    });
    fireEvent.click(screen.getByText('adopt'));
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toContain('challenge expired'));
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
    expect(localStorage.getItem('midnight-identity:passkeys')).toBeNull();
  });
});

/*
 * THE RACE ONCE REFUSED, ASKED AGAIN NOW THAT A BROWSER HOLDS SEVERAL.
 *
 * `welcome` and `passkey-no-account` both mean the compartment this window is
 * looking at had NO KEYRING **when the phase was derived**. The phase is React
 * state and this origin can have more than one window, so a wallet landing in
 * one of them — a recovery, a pairing, another create — leaves the other
 * sitting on a screen whose central claim has quietly stopped being true.
 *
 * **WHAT CHANGED THIS CHANGE, AND WHAT DID NOT.** The old guard refused because
 * `saveSecret` would have OVERWRITTEN the keyring. That is no longer possible:
 * `slotForLanding` picks a free compartment at write time, so the wallet that
 * arrived cannot be replaced by the press. What survives is the person's
 * decision — `welcome` says *this browser is empty* and `passkey-no-account`
 * says *these credentials have nothing behind them* — and both of those are
 * now false. So the press is still refused, still before the prompt, and the
 * refusal now names WHAT ARRIVED rather than what is in the way.
 *
 * WHY THIS IS A TEST AND NOT A SCREEN'S WARNING. There is nothing to warn
 * about at render time — at render time the sentence really is true. The
 * check can only live at the press, which is why the guard is in the session
 * and why removing it changes nothing a person can see.
 *
 * THE TWO TESTS BELOW ARE WATCHED FAILING WITH THE GUARD REMOVED, one call
 * site at a time. What fails without it is the FIRST assertion in each: the
 * ceremony runs, `createPasskey` is called, and the error line is empty —
 * so `not.toHaveBeenCalled()` is the assertion doing the work, and the
 * message match is what makes it the RIGHT refusal rather than any refusal.
 *
 * SEEDED AFTER `mount()`, DELIBERATELY. Seeding first would put the provider
 * in a different phase and the button under test would never render — the
 * test would then be about a screen nobody is looking at. This is the same
 * third test's shape, applied to the state arriving rather than departing.
 */
describe('a wallet that landed in another window stops a stale press', () => {
  it('CREATE is refused, before the prompt, and the refusal names what is here', async () => {
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
    /* The stale window: this browser held nothing when the screen was drawn. */
    mount();
    expect(phase()).toBe('welcome');

    /* The other window lands a wallet and names it. localStorage is shared
     * across one origin's windows; this provider hears nothing at all. */
    const landed = newSecret();
    await saveSecret(landed);
    saveWalletName(landed, 'Rent money');

    fireEvent.click(screen.getByText('create'));

    /* THE ASSERTION THE GUARD IS FOR: no ceremony ran. Without the re-read
     * this is where it fails — the prompt opens and a credential is minted
     * before anything looks at what is on disk. */
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).not.toBe(''));
    expect(mockCreatePasskey).not.toHaveBeenCalled();

    /* And it is the RIGHT refusal: it names the wallet that is already here,
     * because "a wallet" is not something a person can act on. */
    const said = screen.getByTestId('error').textContent ?? '';
    expect(said).toMatch(/arrived in this browser/);
    expect(said).toMatch(/since this screen was drawn/);
    expect(said).toContain('Rent money');

    /* Nothing was replaced: the keyring still opens to the wallet that landed. */
    const held = await loadSecret(ORIGINAL_SLOT);
    expect(toBase64Url(fingerprintOf(held as Uint8Array)))
      .toBe(toBase64Url(fingerprintOf(landed)));
    /* And the screen is no longer the one that offered to create. */
    expect(phase()).toBe('account-no-passkey');
  });

  it('START FRESH is refused the same way, and the map it would have removed stays',
    async () => {
      mockCreatePasskey.mockResolvedValue(registrationFixture);
      mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
      /* The stale window, in the other absent-keyring phase: a passkey record
       * with nothing behind it. */
      savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
      const gone = newSecret();
      await saveSecuredSetup(
        gone,
        await splitSecret(gone, [
          { label: 'My Google account', holder: 'google:me' },
          { label: 'Printed card', holder: 'paper' },
        ], 2),
        { 'google:me': 'never', paper: null });
      mount();
      expect(phase()).toBe('passkey-no-account');

      const landed = newSecret();
      await saveSecret(landed);
      saveWalletName(landed, 'Company');

      fireEvent.click(screen.getByText('fresh'));

      await waitFor(() =>
        expect(screen.getByTestId('error').textContent).not.toBe(''));
      expect(mockCreatePasskey).not.toHaveBeenCalled();

      const said = screen.getByTestId('error').textContent ?? '';
      expect(said).toMatch(/arrived in this browser/);
      expect(said).toMatch(/since this screen was drawn/);
      expect(said).toContain('Company');

      /* `startFresh` replaces the passkey record and removes the piece map.
       * A refusal must reach neither — that order is only safe while the
       * ceremony that triggers it actually happened. */
      expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-stale']);
      expect(localStorage.getItem('midnight-identity:secured')).not.toBeNull();
      const held = await loadSecret(ORIGINAL_SLOT);
      expect(toBase64Url(fingerprintOf(held as Uint8Array)))
        .toBe(toBase64Url(fingerprintOf(landed)));
    });
});

/*
 * ════════════════════════════════════════════════════════════════════════════
 * FOUR WALLETS IN ONE BROWSER, AND ONE OPEN AT A TIME.
 *
 * The change exists to unblock a walk that needs four distinct people, which
 * until now meant four browser profiles: a founder who creates the company and
 * proposes, two more signers who approve, and an employee who accepts an
 * invitation. These tests are that walk in one provider — land wallets one
 * after another, prove each is still openable, turn between them, and prove
 * that turning LOCKS.
 * ════════════════════════════════════════════════════════════════════════════
 */
describe('a browser that holds several wallets', () => {
  const wallets = (): string => screen.getByTestId('wallets').textContent ?? '';

  /**
   * One wallet, made the way a person makes one: press create, land, name it.
   * The name is written through the same writer the rename control uses,
   * against the secret the landing just opened — the Probe's button passes
   * none, and a second create button taking a string would be test apparatus
   * standing in for a screen.
   */
  const createOne = async (name: string, credentialId: string): Promise<Uint8Array> => {
    mockCreatePasskey.mockResolvedValue({ ...registrationFixture, credentialId });
    mockVerifyRegistration.mockResolvedValue(passkeyFixture(credentialId));
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    const secret = (await loadSecret(openWalletId())) as Uint8Array;
    saveWalletName(secret, name);
    return secret;
  };

  it('holds four, and every one of them still unseals to its own secret', async () => {
    mount();
    const made: Uint8Array[] = [];
    const names = ['Founder', 'Signer two', 'Signer three', 'Employee'];
    for (const [i, name] of names.entries()) {
      made.push(await createOne(name, `cred-${i}`));
      /* Back to a locked screen — which is where "add another wallet" is. */
      fireEvent.click(screen.getByText('lock'));
      await waitFor(() => expect(phase()).toBe('locked'));
    }

    expect(heldWallets()).toHaveLength(4);
    /* FOUR DISTINCT SECRETS, each still behind its own compartment's keyring.
     * Compared as bytes rather than by fingerprint: a fingerprint that
     * collapsed to a constant would make this test green and wrong. */
    const held = await Promise.all(heldWallets().map((w) => loadSecret(w.id)));
    for (const [i, secret] of made.entries()) {
      expect([...(held[i] as Uint8Array)]).toEqual([...secret]);
    }
    expect(new Set(held.map((h) => toBase64Url(h as Uint8Array))).size).toBe(4);
    /* And each carries its own name, in the order they were taken on. */
    expect(wallets())
      .toBe('Founder | Signer two | Signer three | Employee*');
  });

  it('TURNING TO ANOTHER WALLET LOCKS: the open secret leaves memory', async () => {
    mount();
    await createOne('Founder', 'cred-0');
    fireEvent.click(screen.getByText('lock'));
    await waitFor(() => expect(phase()).toBe('locked'));
    const second = await createOne('Employee', 'cred-1');

    /* Employee is unlocked and its secret is in the provider. */
    expect(phase()).toBe('unlocked');
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(second)));

    fireEvent.click(screen.getByText('switch-0'));

    /* THE ASSERTION §3 ASKS FOR: not merely that the other wallet is now
     * named, but that NOTHING is unlocked. The secret lived only in the
     * `unlocked` phase, and the phase is no longer that. */
    expect(phase()).toBe('locked');
    expect(screen.getByTestId('secret-fp').textContent).toBe('');
    expect(wallets()).toBe('Founder* | Employee');
  });

  it('THE CHOSEN PASSKEY DECIDES WHICH WALLET OPENS, whichever is named', async () => {
    mount();
    const founder = await createOne('Founder', 'cred-founder');
    fireEvent.click(screen.getByText('lock'));
    await waitFor(() => expect(phase()).toBe('locked'));
    const employee = await createOne('Employee', 'cred-employee');
    fireEvent.click(screen.getByText('lock'));
    await waitFor(() => expect(phase()).toBe('locked'));

    /* Employee is the wallet this window is pointing at. The person picks the
     * FOUNDER's credential out of the browser's chooser anyway. */
    expect(wallets()).toBe('Founder | Employee*');
    mockUsePasskey.mockResolvedValue(assertionFixture('cred-founder'));
    mockVerifyAssertion.mockImplementation((_a: unknown, passkey: unknown) =>
      Promise.resolve({ passkey }) as never);
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('unlocked'));

    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(founder)));
    expect(wallets()).toBe('Founder* | Employee');
    void employee;
  });

  it('A PASSKEY THAT OPENS NO WALLET IS REFUSED, and the refusal says what is here',
    async () => {
      mount();
      await createOne('Founder', 'cred-founder');
      fireEvent.click(screen.getByText('lock'));
      await waitFor(() => expect(phase()).toBe('locked'));

      /* The state a password manager leaves: a credential this origin still
       * offers, with nothing behind it in this browser. */
      mockUsePasskey.mockResolvedValue(assertionFixture('cred-from-a-cleared-browser'));
      fireEvent.click(screen.getByText('unlock'));
      await waitFor(() =>
        expect(screen.getByTestId('error').textContent).not.toBe(''));

      const said = screen.getByTestId('error').textContent ?? '';
      expect(said).toMatch(/does not open any wallet in this browser/);
      /* A REASON A PERSON CAN ACT ON: what this browser does hold, by name,
       * and the two ways to bring a wallet that is elsewhere onto it. */
      expect(said).toContain('Founder');
      expect(said).toMatch(/recovery pieces/);
      /* Nothing was verified and nothing opened. */
      expect(mockVerifyAssertion).not.toHaveBeenCalled();
      expect(phase()).toBe('locked');
    });

  it('A RELOAD OPENS INTO THE WALLET THAT WAS LAST OPEN, not a list to choose from',
    async () => {
      mount();
      await createOne('Founder', 'cred-founder');
      fireEvent.click(screen.getByText('lock'));
      await waitFor(() => expect(phase()).toBe('locked'));
      await createOne('Employee', 'cred-employee');
      const employeeSlot = openWalletId();
      fireEvent.click(screen.getByText('lock'));
      await waitFor(() => expect(phase()).toBe('locked'));

      /* THE RELOAD, both halves of it. Everything this window held in memory
       * goes — the unmount, and this module's note of which wallet is open —
       * and `localStorage` stays. */
      cleanup();
      forgetOpenWallet();
      mount();

      /* **NOT A CHOOSER.** The locked screen for the wallet they were using,
       * because the answer is read off the disk: `wallets-held.ts`'s directory
       * record carries `openId` and `openWalletId` falls back to it whenever
       * this window has no note of its own. A reload costs an unlock, which it
       * always did. It must never cost a person a DECISION about which of
       * their wallets they were in the middle of using. */
      expect(phase()).toBe('locked');
      expect(openWalletId()).toBe(employeeSlot);
      expect(wallets()).toBe('Founder | Employee*');
    });

  it('REMOVING one takes it off this browser and leaves the other exactly as it was',
    async () => {
      mount();
      const founder = await createOne('Founder', 'cred-founder');
      const founderSlot = openWalletId();
      fireEvent.click(screen.getByText('lock'));
      await waitFor(() => expect(phase()).toBe('locked'));
      await createOne('Employee', 'cred-employee');
      const employeeSlot = openWalletId();

      /* The control removes the wallet THIS WINDOW HAS OPEN — Employee. */
      fireEvent.click(screen.getByText('forget'));
      await waitFor(() => expect(heldWallets()).toHaveLength(1));

      expect(await loadSecret(employeeSlot)).toBeNull();
      expect(wallets()).toBe('Founder*');
      /* And the wallet that stayed is untouched: same secret, same name, and
       * its passkey still names it. */
      expect([...(await loadSecret(founderSlot))!]).toEqual([...founder]);
      expect(allPasskeys(founderSlot).map((k) => k.credentialId)).toEqual(['cred-founder']);
    });
});
