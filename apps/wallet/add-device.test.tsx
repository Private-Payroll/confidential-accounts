// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { ReactNode } from 'react';

/*
 * ADDING A DEVICE, END TO END — two component trees standing in for two
 * machines, exchanging exactly the five payloads the protocol sends, with
 * the REAL pairing library doing every step: keygen, commitment, nonce,
 * reveal, digits, seal, open. The only mocks are the passkey ceremony.
 *
 * What these tests hold (§2):
 *   - the two digits are computed independently on each side and are EQUAL;
 *   - they are never one of the transmitted payloads;
 *   - nothing is sealed until the person says the numbers match;
 *   - a wrong number typed on the new machine is refused in the library's
 *     words and nothing lands;
 *   - "they do NOT match" stops either side cold;
 *   - the landing over an existing wallet stands behind the landing gate;
 *   - a cancelled ceremony leaves the account landed behind the doorway.
 */

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return {
    ...actual,
    verifyRegistration: vi.fn(),
    verifyAssertion: vi.fn(),
    /* REAL sealKeys, watched: "nothing is sealed until the person confirms"
     * is a claim about when the CALL happens, not about what is displayed —
     * a version that sealed early and showed late would look identical on
     * screen. The spy runs the library's own function. */
    sealKeys: vi.fn(actual.sealKeys),
  };
});

import { createPasskey } from 'midnight-identity/browser';
import { sealKeys, verifyRegistration } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import { askToPair } from 'midnight-identity/devices/pairing';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { App } from './app.js';
import { SessionProvider, useSession } from './session.js';
import { OfferDevice, ReceiveDevice } from './screens/add-device.js';
import { allPasskeys, loadSecret, savePasskey, saveSecret } from './storage.js';
import { ORIGINAL_SLOT, forgetOpenWallet, heldWallets } from './wallets-held.js';

const mockCreatePasskey = vi.mocked(createPasskey);
const mockVerifyRegistration = vi.mocked(verifyRegistration);
const spySealKeys = vi.mocked(sealKeys);

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

const registrationFixture = {
  credentialId: 'cred-paired', personHandle: 'cGVyc29uLTE', clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(), publicKeySpki: new Uint8Array([1, 2, 3]),
  publicKeyAlgorithm: -7, transports: [],
};

function Probe(): ReactNode {
  const session = useSession();
  return (
    <div>
      <span data-testid="phase">{session.phase.name}</span>
      <span data-testid="secret-fp">
        {session.phase.name === 'unlocked'
          ? toBase64Url(fingerprintOf(session.phase.secret))
          : ''}
      </span>
    </div>
  );
}

type Scope = ReturnType<typeof within>;

/** Render both machines. Each gets its own DOM subtree; localStorage — the
 * "browser" — is the NEW machine's, which is the side that lands anything. */
function mountBoth(secretA: Uint8Array): { O: Scope; R: Scope } {
  const offer = render(<OfferDevice secret={secretA} />);
  const receive = render(<SessionProvider><ReceiveDevice /><Probe /></SessionProvider>);
  return { O: within(offer.container as HTMLElement), R: within(receive.container as HTMLElement) };
}

/** Read a payload off one machine's screen and enter it on the other — the
 * typed path, exactly what a person with no camera does. */
function carry(from: Scope, testId: string, to: Scope, label: string, action: string): string {
  const payload = from.getByTestId(testId).textContent ?? '';
  expect(payload).not.toBe('');
  fireEvent.change(to.getByLabelText(label), { target: { value: payload } });
  fireEvent.click(to.getByText(action));
  return payload;
}

/** Drive both sides through the exchange to both digit screens. `mangle`
 * turns the number the person carries by eye into what they actually type —
 * identity for an attentive person, a typo for the refusal tests. */
function runToDigits(O: Scope, R: Scope, mangle?: (digits: string) => string): {
  offerDigits: string; receiveDigits: string; crossed: string[];
} {
  const crossed: string[] = [];
  fireEvent.click(R.getByText('Show a code to scan'));
  crossed.push(carry(R, 'receive-code', O, 'The code the new machine shows', 'Use this code'));
  crossed.push(carry(O, 'offer-commitment', R, "The other machine's commitment", 'Use it'));
  crossed.push(carry(R, 'receive-nonce', O, "The new machine's answer", 'Use this answer'));
  crossed.push(carry(O, 'offer-reveal', R, 'What the other machine reveals', 'Check it'));
  const offerDigits = O.getByTestId('offer-digits').textContent ?? '';
  /* Pinned on every path: the receiving machine does NOT show its own
   * number until the other machine's has been typed — a confirmation whose
   * answer is printed above the box confirms nothing. */
  expect(R.queryByTestId('receive-digits')).toBeNull();
  fireEvent.change(R.getByLabelText('The number the other machine shows'), {
    target: { value: (mangle ?? ((d: string) => d))(offerDigits) },
  });
  fireEvent.click(R.getByText(/I typed it — show this machine/));
  return {
    offerDigits,
    receiveDigits: R.getByTestId('receive-digits').textContent ?? '',
    crossed,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* The open compartment is module state and outlives a test. */
  forgetOpenWallet();
});

describe('pairing, end to end across two machines', () => {
  it('both screens compute the SAME two digits, and the number crosses no wire', () => {
    const { O, R } = mountBoth(newSecret());
    const { offerDigits, receiveDigits, crossed } = runToDigits(O, R);

    expect(offerDigits).toMatch(/^\d{2}$/);
    expect(receiveDigits).toBe(offerDigits);
    /* The assertion is over what is actually RENDERED, not over a list
     * this harness built — a sixth QR panel carrying the digits would appear
     * right here. Every payload surface on either screen is a long base64url
     * string, and none of them is either machine's number. */
    const shownPayloads = Array.from(
      document.querySelectorAll('.qr-text'), (el) => (el.textContent ?? '').trim());
    expect(shownPayloads.length).toBeGreaterThan(0);
    for (const payload of shownPayloads) {
      expect(payload).not.toBe(offerDigits);
      expect(payload).not.toBe(receiveDigits);
      expect(payload.length).toBeGreaterThan(20);
    }
    for (const payload of crossed) {
      expect(payload).not.toBe(offerDigits);
      expect(payload.length).toBeGreaterThan(20);
    }
    /* And NOTHING has been sealed: the person has not said they match. The
     * assertion is on the library CALL, not the screen — sealing early and
     * showing late would render identically. */
    expect(spySealKeys).not.toHaveBeenCalled();
    expect(O.queryByTestId('offer-sealed')).toBeNull();
  });

  it('the wallet crosses only after the person confirms, and lands as THE account', async () => {
    const secretA = newSecret();
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-paired'));
    const { O, R } = mountBoth(secretA);
    runToDigits(O, R);

    /* The old machine seals ONLY from the match button. */
    expect(spySealKeys).not.toHaveBeenCalled();
    fireEvent.click(O.getByText('They match — send the wallet'));
    expect(spySealKeys).toHaveBeenCalledTimes(1);
    const sealed = O.getByTestId('offer-sealed').textContent ?? '';
    expect(sealed).not.toBe('');

    /* The number was already carried by eye (inside runToDigits — the rule makes
     * it the first act); now the sealed wallet crosses by scan. */
    fireEvent.change(R.getByLabelText('The sealed wallet from the other machine'), {
      target: { value: sealed },
    });
    fireEvent.click(R.getByText('Use it'));
    fireEvent.click(R.getByText('Open the wallet on this machine'));

    await waitFor(() => expect(R.getByTestId('phase').textContent).toBe('unlocked'));
    /* THE account: the identity on the new machine derives from the same
     * secret the old machine holds. */
    expect(R.getByTestId('secret-fp').textContent).toBe(toBase64Url(fingerprintOf(secretA)));
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-paired']);
    /* Two facts on the landing screen, both true. */
    expect(R.getByText(/The wallet is on this machine\./)).toBeTruthy();
    expect(R.getByText(/A new passkey opens it here\./)).toBeTruthy();

    /* A completed pairing leaves the browser holding EXACTLY the
     * keyring, the passkey record, the arrival fact — and now the
     * list of wallets this browser holds. No pairing state, no ephemeral key,
     * nothing else, anywhere a page can write.
     *
     * **`midnight-identity:wallets` IS THE ONLY ADDITION AND IT IS PUBLIC BY
     * CONSTRUCTION**: compartment ids, the fingerprint each already carries in
     * five of its own records, and which one is open. Nothing about money and
     * nothing that was not already readable beside it. This assertion is the
     * thing that would catch a future round writing anything else. */
    const keys = Array.from(
      { length: localStorage.length }, (...args) => localStorage.key(args[1]) ?? '').sort();
    expect(keys).toEqual([
      'midnight-identity:arrived',
      'midnight-identity:keyring',
      'midnight-identity:passkeys',
      'midnight-identity:wallets',
    ]);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(window.name).toBe('');
  });

  it('a WRONG number typed on the new machine is refused in the library’s words — nothing lands', async () => {
    const secretA = newSecret();
    const { O, R } = mountBoth(secretA);
    const wrong = (digits: string): string => String((Number(digits) + 1) % 100).padStart(2, '0');
    runToDigits(O, R, wrong);
    fireEvent.click(O.getByText('They match — send the wallet'));
    const sealed = O.getByTestId('offer-sealed').textContent ?? '';
    fireEvent.change(R.getByLabelText('The sealed wallet from the other machine'), {
      target: { value: sealed },
    });
    fireEvent.click(R.getByText('Use it'));
    fireEvent.click(R.getByText('Open the wallet on this machine'));

    expect((R.getByText(/Stop unless the other one shows the same/).textContent ?? ''))
      .toMatch(/this device is showing \d\d/);
    expect(R.getByTestId('phase').textContent).not.toBe('unlocked');
    expect(await loadSecret(ORIGINAL_SLOT)).toBeNull();
  });

  it('"they do NOT match" stops the OLD machine cold: nothing sealed, ever', () => {
    const { O, R } = mountBoth(newSecret());
    runToDigits(O, R);
    fireEvent.click(O.getByText('They do NOT match — stop'));
    expect(O.getByText('Stopped. Nothing was sent.')).toBeTruthy();
    expect(spySealKeys).not.toHaveBeenCalled();
    expect(O.queryByTestId('offer-sealed')).toBeNull();
    /* The way back is a fresh start, not a resume. */
    fireEvent.click(O.getByText('Start again'));
    expect(O.getByText('Add another device.')).toBeTruthy();
  });

  it('"they do NOT match" stops the NEW machine too', () => {
    const { O, R } = mountBoth(newSecret());
    runToDigits(O, R);
    fireEvent.click(R.getByText('They do NOT match — stop'));
    expect(R.getByText('Stopped. Nothing was opened.')).toBeTruthy();
  });

  it('a tampered reveal breaks the commitment and says stop, verbatim', () => {
    const { O, R } = mountBoth(newSecret());
    fireEvent.click(R.getByText('Show a code to scan'));
    carry(R, 'receive-code', O, 'The code the new machine shows', 'Use this code');
    carry(O, 'offer-commitment', R, "The other machine's commitment", 'Use it');
    carry(R, 'receive-nonce', O, "The new machine's answer", 'Use this answer');
    /* The man in the middle reveals his own key instead. */
    const forged = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    fireEvent.change(R.getByLabelText('What the other machine reveals'), {
      target: { value: forged },
    });
    fireEvent.click(R.getByText('Check it'));
    expect(R.getByText(/revealed a different key from the one it committed to/)).toBeTruthy();
    expect(R.queryByTestId('receive-digits')).toBeNull();
  });

  it('an expired code is refused when scanned, in the library’s words', () => {
    const { O } = mountBoth(newSecret());
    const stale = askToPair(Date.now() - 10 * 60 * 1000);
    fireEvent.change(O.getByLabelText('The code the new machine shows'), {
      target: { value: stale.code },
    });
    fireEvent.click(O.getByText('Use this code'));
    expect(O.getByText(/that code has expired/)).toBeTruthy();
  });
});

describe('the route through the REAL App: the completion screen survives the unlock', () => {
  it('landing flips the phase to unlocked, and the route still shows the outcome, not the offer role', async () => {
    /* Found by the screenshot harness: the successful landing unlocks the
     * browser, and the add-device route used to switch to the OFFER role in
     * the same render — replacing the screen that states the ceremony's
     * outcome (by rule) before anybody read it. */
    const secretA = newSecret();
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-paired'));
    window.location.hash = '#/add-device';
    const app = render(<SessionProvider><App /></SessionProvider>);
    const R = within(app.container as HTMLElement);
    const offer = render(<OfferDevice secret={secretA} />);
    const O = within(offer.container as HTMLElement);

    runToDigits(O, R);
    fireEvent.click(O.getByText('They match — send the wallet'));
    const sealed = O.getByTestId('offer-sealed').textContent ?? '';
    fireEvent.change(R.getByLabelText('The sealed wallet from the other machine'), {
      target: { value: sealed },
    });
    fireEvent.click(R.getByText('Use it'));
    fireEvent.click(R.getByText('Open the wallet on this machine'));

    expect(await R.findByText(/The wallet is on this machine\./)).toBeTruthy();
    /* NOT the offer role's intro. */
    expect(R.queryByText('Add another device.')).toBeNull();
  });
});

/*
 * THE PAIRING LANDING ADDS A WALLET. IT NO LONGER REPLACES ONE.
 *
 * This test used to pin the destructive branch: a stored wallet with no piece
 * map, named, warned about in `StartOver`'s own words, behind a two-step
 * confirm, because one browser held one wallet and the incoming one took its
 * place. **`storage.ts`'s `slotForLanding` gives the incoming wallet a
 * compartment of its own**, so the branch is gone and what replaces it is the
 * assertion the old test could not make: the wallet that was here still opens
 * afterwards.
 */
describe('the landing beside what is already here, on the pairing side', () => {
  it('adds the incoming wallet, and the one that was here still opens', async () => {
    const wasHere = newSecret();
    const wasHereSlot = await saveSecret(wasHere);
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-paired'));
    const secretA = newSecret();
    const { O, R } = mountBoth(secretA);
    runToDigits(O, R);
    fireEvent.click(O.getByText('They match — send the wallet'));
    const sealed = O.getByTestId('offer-sealed').textContent ?? '';
    fireEvent.change(R.getByLabelText('The sealed wallet from the other machine'), {
      target: { value: sealed },
    });
    fireEvent.click(R.getByText('Use it'));

    /* One press, and the copy names what is here and says it stays — before
     * the ceremony, which is what the change asks for. */
    expect(R.getByText(/This browser already holds one wallet/)).toBeTruthy();
    expect(R.getByText(/Nothing stored here is replaced/)).toBeTruthy();
    expect(R.queryByText('Replace the wallet stored here…')).toBeNull();
    expect(R.queryByText(/destroyed for\s+good/)).toBeNull();

    fireEvent.click(R.getByText('Open the wallet on this machine'));
    await waitFor(() => expect(R.getByTestId('phase').textContent).toBe('unlocked'));
    expect(R.getByTestId('secret-fp').textContent).toBe(toBase64Url(fingerprintOf(secretA)));

    /* TWO WALLETS, and the one that was here is untouched. */
    expect(heldWallets()).toHaveLength(2);
    expect([...(await loadSecret(wasHereSlot))!]).toEqual([...wasHere]);
  });
});

describe('the gate can tell your own wallet from a stranger’s', () => {
  it('re-pairing the SAME wallet is named as itself: re-sealed, nothing destroyed', async () => {
    const secretA = newSecret();
    /* The receiving browser already holds the very same wallet. */
    await saveSecret(secretA);
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-paired'));
    const { O, R } = mountBoth(secretA);
    runToDigits(O, R);
    fireEvent.click(O.getByText('They match — send the wallet'));
    const sealed = O.getByTestId('offer-sealed').textContent ?? '';
    fireEvent.change(R.getByLabelText('The sealed wallet from the other machine'), {
      target: { value: sealed },
    });
    fireEvent.click(R.getByText('Use it'));

    /* Both secrets are in hand; the gate compares fingerprints and says so. */
    expect(await R.findByText(/This is the wallet already stored here\./)).toBeTruthy();
    expect(R.getByText('Re-seal the wallet on this machine')).toBeTruthy();
    /* The gone-for-good copy is kept for when the fingerprints DIFFER. */
    expect(R.queryByText(/destroyed for\s+good/)).toBeNull();
    expect(R.queryByText('Replace the wallet stored here…')).toBeNull();

    fireEvent.click(R.getByText('Re-seal the wallet on this machine'));
    await waitFor(() => expect(R.getByTestId('phase').textContent).toBe('unlocked'));
    expect(R.getByTestId('secret-fp').textContent).toBe(toBase64Url(fingerprintOf(secretA)));
  });
});

describe('a landing that cannot store says so, and spends nothing at all', () => {
  it('the storage sentence lands on THIS screen, and the second press is not a lie', async () => {
    const secretA = newSecret();
    const { O, R } = mountBoth(secretA);
    runToDigits(O, R);
    fireEvent.click(O.getByText('They match — send the wallet'));
    const sealed = O.getByTestId('offer-sealed').textContent ?? '';
    fireEvent.change(R.getByLabelText('The sealed wallet from the other machine'), {
      target: { value: sealed },
    });
    fireEvent.click(R.getByText('Use it'));

    /* The browser refuses storage AT the landing — a private window, a
     * managed profile, an evicted store. */
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => { throw new Error('refused by this profile'); },
    };
    fireEvent.click(R.getByText('Open the wallet on this machine'));
    /* The failure is stated HERE, in storage's own words — never silence,
     * never a phase flip this route would not render. */
    expect(await R.findByText(/this browser is refusing/)).toBeTruthy();
    expect(R.getByTestId('phase').textContent).not.toBe('unlocked');

    /* The one-use request was NOT spent: the second press repeats the truth
     * instead of "this pairing has already handed over the keys once". */
    fireEvent.click(R.getByText('Open the wallet on this machine'));
    expect(await R.findByText(/this browser is refusing/)).toBeTruthy();
    expect(R.queryByText(/already handed over the keys once/)).toBeNull();

    /* And with storage back, the SAME pairing finishes. */
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-paired'));
    fireEvent.click(R.getByText('Open the wallet on this machine'));
    await waitFor(() => expect(R.getByTestId('phase').textContent).toBe('unlocked'));
    expect(R.getByTestId('secret-fp').textContent).toBe(toBase64Url(fingerprintOf(secretA)));
  });
});

describe('the ceremony after the landing — the rule, on the pairing side', () => {
  it('a cancelled ceremony leaves the wallet LANDED behind the doorway, old record retired', async () => {
    savePasskey(passkeyFixture('cred-old'), ORIGINAL_SLOT);
    mockCreatePasskey.mockRejectedValue(
      new Error('the passkey was not created — it was cancelled, or it timed out.'));
    const secretA = newSecret();
    const { O, R } = mountBoth(secretA);
    runToDigits(O, R);
    fireEvent.click(O.getByText('They match — send the wallet'));
    const sealed = O.getByTestId('offer-sealed').textContent ?? '';
    fireEvent.change(R.getByLabelText('The sealed wallet from the other machine'), {
      target: { value: sealed },
    });
    fireEvent.click(R.getByText('Use it'));
    fireEvent.click(R.getByText('Open the wallet on this machine'));

    await waitFor(() => expect(R.getByTestId('phase').textContent).toBe('account-no-passkey'));
    /* Landed, doorway named, failure verbatim, old credential gone. */
    const held = await loadSecret(ORIGINAL_SLOT);
    expect(held && toBase64Url(fingerprintOf(held))).toBe(toBase64Url(fingerprintOf(secretA)));
    expect(allPasskeys(ORIGINAL_SLOT)).toEqual([]);
    expect(R.getByText(/one step left/)).toBeTruthy();
    expect(R.getByText(/it was cancelled, or it timed out\./)).toBeTruthy();
    expect(R.getByText(/Make a new passkey for this wallet/)).toBeTruthy();
    expect(R.queryByText(/A new passkey opens it here/)).toBeNull();
  });
});
