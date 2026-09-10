// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { ReactNode } from 'react';

/* THE EMBEDDER IS CONFIGURED BEFORE ANYTHING LOADS, the way a build carries it. */
vi.hoisted(() => {
  process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example';
});

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
import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import { SessionProvider, useSession } from './session.js';
import { ORIGINAL_SLOT, forgetOpenWallet } from './accounts/wallets-held.js';
import { savePasskey, saveSecret } from './accounts/storage.js';

/**
 * **WHICH PASSKEY CEREMONIES MAY RUN INSIDE THE APPLICATION'S FRAME, AND WHICH MAY NOT.**
 *
 * The verifier refuses a ceremony whose surrounding page it was not told to
 * accept - found by walking the frame in a real browser, where making a wallet
 * inside it created a passkey and then refused it. Making a wallet and unlocking
 * one are the two an approval inside the application needs, and they accept the
 * embedder; starting again replaces what this browser holds and stays refused.
 */

const EMBEDDER = 'https://app.payroll.example';
const passkey = (credentialId: string): Passkey => ({
  credentialId, personHandle: 'person-1', publicKeySpki: new Uint8Array([1, 2, 3]), algorithm: -7,
  signCount: 0, provenBySignIn: false, rpId: 'localhost', syncsToACloud: false, backedUpNow: false,
  transports: [],
});
const registration = {
  credentialId: 'cred-1', personHandle: 'cGVyc29uLTE', clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(), publicKeySpki: new Uint8Array([1, 2, 3]), publicKeyAlgorithm: -7, transports: [],
};

function Probe(): ReactNode {
  const session = useSession();
  return (
    <div>
      <div data-testid="phase">{session.phase.name}</div>
      <button type="button" onClick={() => { void session.createAccount(); }}>create</button>
      <button type="button" onClick={() => { void session.unlock(); }}>unlock</button>
      <button type="button" onClick={() => { void session.startFresh(); }}>fresh</button>
    </div>
  );
}
const phase = (): string => screen.getByTestId('phase').textContent ?? '';
const expected = (calls: unknown[][]): { allowFramedBy?: readonly string[] } =>
  calls[0]!.find((a) => typeof a === 'object' && a !== null && 'challenge' in a) as { allowFramedBy?: readonly string[] };

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
});

describe('passkey ceremonies inside the application\'s frame', () => {
  it('MAKING A WALLET accepts the embedder as the page around it', async () => {
    vi.mocked(createPasskey).mockResolvedValue(registration);
    vi.mocked(verifyRegistration).mockResolvedValue(passkey('cred-1'));
    render(<SessionProvider><Probe /></SessionProvider>);
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(expected(vi.mocked(verifyRegistration).mock.calls).allowFramedBy).toEqual([EMBEDDER]);
  });

  it('UNLOCKING accepts the embedder as the page around it', async () => {
    savePasskey(passkey('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    vi.mocked(usePasskey).mockResolvedValue({
      credentialId: 'cred-1', clientDataJSON: new Uint8Array(), authenticatorData: new Uint8Array(),
      signature: new Uint8Array(), userHandle: 'cGVyc29uLTE',
    });
    vi.mocked(verifyAssertion).mockResolvedValue({
      personHandle: 'person-1', signCount: 1, userVerified: true, backedUpNow: false, passkey: passkey('cred-1'),
    });
    render(<SessionProvider><Probe /></SessionProvider>);
    fireEvent.click(screen.getByText('unlock'));
    await waitFor(() => expect(phase()).toBe('unlocked'));
    expect(expected(vi.mocked(verifyAssertion).mock.calls).allowFramedBy).toEqual([EMBEDDER]);
  });

  it('STARTING AGAIN accepts no page around it - it replaces what this browser holds', async () => {
    savePasskey(passkey('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    vi.mocked(createPasskey).mockResolvedValue(registration);
    vi.mocked(verifyRegistration).mockResolvedValue(passkey('cred-2'));
    render(<SessionProvider><Probe /></SessionProvider>);
    fireEvent.click(screen.getByText('fresh'));
    await waitFor(() => expect(vi.mocked(verifyRegistration)).toHaveBeenCalled());
    expect(expected(vi.mocked(verifyRegistration).mock.calls).allowFramedBy ?? []).toEqual([]);
  });
});
