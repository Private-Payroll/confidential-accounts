// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { ReactNode } from 'react';

/*
 * ════════════════════════════════════════════════════════════════════════════
 * THE LOCKED SCREEN'S LIST: ONE PRESS OPENS A WALLET, AND A CONTROL
 * LOOKS LIKE A CONTROL WITH NO POINTER ON IT.
 *
 * Both defects were found by using the product on a real machine, and both are
 * of a kind a green suite could not have caught, because nothing here executed
 * the list at all. `session.test.tsx` drives `switchTo` through a Probe's
 * `switch-0` button; that pins the SESSION's half and says nothing about what
 * the row does. This file renders the real `Unlock`, with the real
 * `WalletsHere` inside it, over real storage.
 *
 * §2 IS THE ONE THAT CAN LIE, so it is tested against the CEREMONY rather than
 * against a rendered word: `usePasskey` — the browser call, mocked because a
 * test runner has no authenticator — is what "an unlock was attempted" means.
 * A row that switched and stopped would leave every rendering assertion in this
 * file green.
 *
 * THE MUTATION THAT MUST KILL IT is named on the first test.
 *
 * §1 IS NOT HERE. It is a fact about the STYLESHEET and jsdom is the wrong
 * room to ask it in — `quiet-affordance.test.ts`, beside this file, says what
 * is asserted, what is not, and why.
 * ════════════════════════════════════════════════════════════════════════════
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

import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { SessionProvider, useSession } from '../session.js';
import { forgetOpenWallet, openWalletId } from '../accounts/wallets-held.js';
import { savePasskey, saveSecret, saveWalletName } from '../accounts/storage.js';
import { Unlock } from './unlock.js';

const mockUsePasskey = vi.mocked(usePasskey);
const mockVerifyAssertion = vi.mocked(verifyAssertion);

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

const assertionFixture = (credentialId: string) => ({
  credentialId,
  clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(),
  signature: new Uint8Array(),
  userHandle: 'cGVyc29uLTE',
});

/**
 * A wallet put into this browser THROUGH THE REAL WRITERS — `saveSecret`
 * allocates the compartment, seals, records the holding and opens it
 * (`storage.ts:258`), and the name and the credential are written after, which
 * is the order every landing uses. Building the localStorage records by hand
 * would be a fixture standing in for the thing under test.
 *
 * `withPasskey: false` leaves the compartment with a sealed keyring and NO
 * credential record, which is what derives `account-no-passkey` — the state
 * the guard in `wallets-here.tsx` exists for.
 */
const putWallet = async (
  name: string, credentialId: string, withPasskey = true,
): Promise<{ id: string; secret: Uint8Array }> => {
  const secret = newSecret();
  const id = await saveSecret(secret);
  saveWalletName(secret, name);
  if (withPasskey) savePasskey(passkeyFixture(credentialId), id);
  return { id, secret };
};

function PhaseProbe(): ReactNode {
  const session = useSession();
  return (
    <>
      <div data-testid="phase">{session.phase.name}</div>
      <div data-testid="secret-fp">
        {session.phase.name === 'unlocked'
          ? toBase64Url(fingerprintOf(session.phase.secret))
          : ''}
      </div>
    </>
  );
}

const mount = (): void => {
  render(<SessionProvider><Unlock /><PhaseProbe /></SessionProvider>);
};

/** The rows, and only the rows. The wallet this window points at is also
 * printed in the hero above (`unlock.tsx`'s `data-whole-wallet`), so a bare
 * `getByText` would find two of it and a scoped query is not a convenience. */
const list = (): HTMLElement => {
  const card = document.querySelector('[data-wallets-here]');
  expect(card, 'the list did not render').not.toBeNull();
  return card as HTMLElement;
};

const phase = (): string => screen.getByTestId('phase').textContent ?? '';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* Which compartment a window has open is module state and outlives a test. */
  forgetOpenWallet();
});

describe('§2 — pressing a wallet in the list OPENS it, in one press', () => {
  /**
   * **THE CLAIM THIS TEST EXISTS FOR, AND THE MUTATION THAT KILLS IT.**
   *
   * Mutation: in `screens/wallets-here.tsx`, change the row's handler from
   *
   *     onClick={() => open(wallet.id)}
   *
   * to
   *
   *     onClick={() => switchTo(wallet.id)}
   *
   * — the exact behaviour this was opened to fix. `openWalletId()` still moves,
   * the list still re-renders with the bold in its new place, and every
   * assertion about what is on screen stays green. The ceremony is never
   * reached, so `usePasskey` is never called and the `waitFor` below times out
   * red. That is the whole point: the visible effect of the press was never
   * the thing that was missing.
   */
  it('the press reaches the ONE ceremony — usePasskey is called, not merely switchTo',
    async () => {
      const founder = await putWallet('Founder', 'cred-founder');
      await putWallet('Employee', 'cred-employee');
      /* `saveSecret` opened the compartment it landed in, so this window is
       * pointing at Employee — Founder is the row a person would press. */
      expect(openWalletId()).not.toBe(founder.id);

      mockUsePasskey.mockResolvedValue(assertionFixture('cred-founder'));
      mockVerifyAssertion.mockImplementation((_a: unknown, passkey: unknown) =>
        Promise.resolve({ passkey }) as never);

      mount();
      expect(phase()).toBe('locked');
      fireEvent.click(within(list()).getByText('Founder'));

      /* HALF ONE — the switch. */
      expect(openWalletId()).toBe(founder.id);
      /* HALF TWO — and this is the half that was missing. The ceremony is
       * asynchronous (`session.tsx` issues a challenge before it prompts), so
       * it is awaited rather than asserted synchronously. */
      await waitFor(() => expect(mockUsePasskey).toHaveBeenCalledTimes(1));

      /* AND IT OPENS. Asserted on the UNLOCKED secret rather than on storage:
       * a mutation that swapped in a fresh secret would write the very
       * record a storage assertion reads, and pass it. */
      await waitFor(() => expect(phase()).toBe('unlocked'));
      expect(screen.getByTestId('secret-fp').textContent)
        .toBe(toBase64Url(fingerprintOf(founder.secret)));
    });

  it('the row of the wallet ALREADY selected is pressable, and opens it too', async () => {
    await putWallet('Founder', 'cred-founder');
    const employee = await putWallet('Employee', 'cred-employee');
    expect(openWalletId()).toBe(employee.id);

    mockUsePasskey.mockResolvedValue(assertionFixture('cred-employee'));
    mockVerifyAssertion.mockImplementation((_a: unknown, passkey: unknown) =>
      Promise.resolve({ passkey }) as never);

    mount();
    /* It used to be a bare `<strong>` — no button, nothing to press. */
    fireEvent.click(within(list()).getByText('Employee'));
    await waitFor(() => expect(mockUsePasskey).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(employee.secret)));
  });

  /**
   * THE GUARD, AND WHY IT IS NOT AN OPTIMISATION. A compartment with a sealed
   * keyring and no credential record derives `account-no-passkey`, which has
   * its own screen and its own doors. Prompting there is a biometric a person
   * cannot answer with anything, whose refusal then writes a red line onto a
   * screen that has already been replaced underneath it. `switchTo` hands back
   * the phase it landed in so the row can tell the difference.
   */
  it('a wallet with no credential on record is SWITCHED to and NOT prompted for',
    async () => {
      const stranded = await putWallet('Old laptop wallet', 'unused', false);
      await putWallet('Employee', 'cred-employee');

      mount();
      fireEvent.click(within(list()).getByText('Old laptop wallet'));

      expect(openWalletId()).toBe(stranded.id);
      expect(phase()).toBe('account-no-passkey');
      /* Awaited long enough for a ceremony to have started if one were going
       * to: the challenge issue is one microtask, and `waitFor` turns the loop
       * either way. Asserted as a count so a later prompt cannot hide. */
      await waitFor(() => expect(phase()).toBe('account-no-passkey'));
      expect(mockUsePasskey).not.toHaveBeenCalled();
    });

  /**
   * WHICH WALLET OPENS IS STILL THE CREDENTIAL'S ANSWER, NOT THE ROW'S. THIS
   * §2's standing instruction: *"Do not remove the browser's own chooser as a
   * route. `walletOfCredential` resolving whichever credential is picked stays
   * exactly as it is."* This is that sentence, pinned from the new entry point
   * — `session.test.tsx` pins it from the unlock button.
   */
  it('the credential the person picks still decides, even when a row started it',
    async () => {
      const founder = await putWallet('Founder', 'cred-founder');
      await putWallet('Employee', 'cred-employee');

      /* The row pressed is Founder; the chooser hands back EMPLOYEE's. */
      mockUsePasskey.mockResolvedValue(assertionFixture('cred-employee'));
      mockVerifyAssertion.mockImplementation((_a: unknown, passkey: unknown) =>
        Promise.resolve({ passkey }) as never);

      mount();
      fireEvent.click(within(list()).getByText('Founder'));
      await waitFor(() => expect(phase()).toBe('unlocked'));

      expect(screen.getByTestId('secret-fp').textContent)
        .not.toBe(toBase64Url(fingerprintOf(founder.secret)));
      expect(openWalletId()).not.toBe(founder.id);
    });
});
