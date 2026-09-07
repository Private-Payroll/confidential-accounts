// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { ReactNode } from 'react';

/*
 * ════════════════════════════════════════════════════════════════════════════
 * THE FOUR LANDINGS, AND THE RECORD EACH ONE OWES.
 *
 * `walletNameOnRecord` (`storage.ts:768`) reads the wallet-name record WITHOUT
 * checking that it belongs to the secret in hand, because the screen that
 * needs it — the locked screen — has no secret; that is what locked means. It
 * is therefore honest for exactly one reason: **every path that seals a
 * keyring settles that record in the same turn**, so the record beside a
 * keyring belongs to that keyring or does not exist. The file states the
 * consequence itself at `storage.ts:765`: *"If a path ever seals a keyring
 * without settling this record, this function becomes a way to print one
 * wallet's name over another's money."*
 *
 * `wallet-name.test.ts` holds the WRITER's contract — `saveWalletName` and
 * `walletNameOf` against a foreign record. **Nothing held the LANDINGS.** A
 * landing that stopped settling the record was a green suite and a name over
 * the wrong wallet, which is trouble with the whole wallet in place of one
 * account.
 *
 * THE LANDINGS ARE THE CALLERS OF `saveSecret`, AND THERE ARE FOUR:
 *
 *   `session.tsx:520`  createAccount   settles at `:527`
 *   `session.tsx:736`  startFresh      settles at `:738`
 *   `session.tsx:834`  finishRecovery  settles at `:840`
 *   `session.tsx:935`  finishPairing   settles at `:946`
 *
 * `saveSecret` (`storage.ts:258`) is the only writer of a keyring record
 * (`storage.ts:269` is the only `setItem` of a `'keyring'` key), so that list
 * is the whole of it. `adoptPasskey` (`session.tsx:621`) is NOT a landing: it
 * registers a credential over a keyring that is already sealed and never
 * calls `saveSecret`.
 *
 * ONE TEST PER LANDING, AND EACH HAS TWO ACTS, because "settled" has two
 * shapes and only one of them is visible in an empty browser:
 *
 *   ACT 1 — a name was given. The record is PRESENT, and it is bound to the
 *           secret that just landed: `walletNameOf` accepts it.
 *   ACT 2 — no name was given, and the compartment the landing will use
 *           already holds a STRANGER's record. The record must be gone —
 *           deliberately absent — and never inherited. This is the act that
 *           dies when a landing stops settling: the stranger's name survives
 *           in the compartment and the locked screen prints it over the new
 *           wallet's money.
 *
 * WHAT IS DRIVEN IS THE SESSION CALLBACK, not the screen above it. The screens
 * collect the name (`welcome.tsx`, `wallets-here.tsx`, `passkey-no-account
 * .tsx`, `recover.tsx`, `add-device.tsx`) and are pinned where they live; the
 * contract `walletNameOnRecord` rests on belongs to the landing, so the
 * landing is what is executed here. VERIFICATION and STORAGE are real —
 * real seal over fake-indexeddb, real split and rebuild for the recovery —
 * and only the authenticator ceremony is mocked, as everywhere else.
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

import { createPasskey } from 'midnight-identity/browser';
import { verifyRegistration } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import type { Secret } from 'midnight-identity';
import { newSecret } from 'midnight-identity/keys/derivation';
import { fingerprintOf, splitSecret } from 'midnight-identity/recovery/pieces';
import type { PieceSet } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { SessionProvider, useSession } from './session.js';
import { loadSecret, savePasskey, saveWalletName, walletNameOf, walletNameOnRecord } from './accounts/storage.js';
import { ORIGINAL_SLOT, forgetOpenWallet, openWallet, openWalletId } from './accounts/wallets-held.js';

const mockCreatePasskey = vi.mocked(createPasskey);
const mockVerifyRegistration = vi.mocked(verifyRegistration);

const WALLET_NAME_KEY = 'midnight-identity:wallet-name';
const GIVEN = 'Rent money';
const STRANGERS = 'Company';

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
  credentialId: 'cred-new', personHandle: 'cGVyc29uLTE', clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(), publicKeySpki: new Uint8Array([1, 2, 3]),
  publicKeyAlgorithm: -7, transports: [],
};

/**
 * THE FOUR LANDINGS AS FOUR BUTTONS, each passing the name it was given —
 * `undefined` when the test gives none, which is the shape a screen with an
 * empty field passes.
 *
 * The recovery pieces are ONE BUTTON EACH rather than a loop inside one
 * handler, and that is not a style choice: `offerRecoveryPiece` closes over
 * the `recovery` state it read at render, so two calls in one handler both
 * see `null` and the first piece is lost. A click per piece is what a person
 * does and it is the only thing that works.
 */
function Probe({ name, pieces, incoming }: {
  readonly name?: string;
  readonly pieces?: PieceSet;
  readonly incoming?: Secret;
}): ReactNode {
  const session = useSession();
  return (
    <div>
      <div data-testid="phase">{session.phase.name}</div>
      <div data-testid="error">{session.error ?? ''}</div>
      <div data-testid="gathered">
        {session.recovery === null ? '-' : String(session.recovery.gathered.length)}
      </div>
      <button type="button" onClick={() => { void session.createAccount(name); }}>create</button>
      <button type="button" onClick={() => { void session.startFresh(name); }}>fresh</button>
      {(pieces?.pieces ?? []).map((piece, i) => (
        <button
          key={piece.placement.holder}
          type="button"
          onClick={() => {
            session.offerRecoveryPiece(toBase64Url(piece.bytes), piece.placement.holder);
          }}
        >
          {`offer-${i}`}
        </button>
      ))}
      <button type="button" onClick={() => { void session.finishRecovery(name); }}>recover</button>
      <button
        type="button"
        onClick={() => { void session.finishPairing(incoming as Secret, name); }}
      >
        pair
      </button>
    </div>
  );
}

const mount = (props: {
  readonly name?: string;
  readonly pieces?: PieceSet;
  readonly incoming?: Secret;
} = {}): void => {
  render(<SessionProvider><Probe {...props} /></SessionProvider>);
};

const phase = (): string => screen.getByTestId('phase').textContent ?? '';

/**
 * A BROWSER THAT ALREADY HOLDS SOMEBODY ELSE'S NAME IN THE COMPARTMENT THE
 * NEXT LANDING WILL USE — the fixture act 2 turns on.
 *
 * A credential with no keyring behind it is a real state (`passkey-no-account`)
 * and it is the one `slotForLanding` (`storage.ts:305`) calls a SHELF: a
 * compartment with no keyring is where the next wallet lands, rather than
 * beside it. So the stranger's leftover name record is in the compartment that
 * is about to receive a different wallet, which is that situation exactly.
 *
 * It is written through the real writer against the stranger's own secret, so
 * the record carries the stranger's fingerprint and nothing here is hand-built.
 *
 * **THE SECRET IS RETURNED RATHER THAN DISCARDED**, because act 2's claim is
 * about TWO wallets and the caller has to be able to name the other one. See
 * `expectStrangersNameGone`.
 */
const strandedStrangersName = (): Secret => {
  savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
  openWallet(ORIGINAL_SLOT);
  const stranger = newSecret();
  saveWalletName(stranger, STRANGERS);
  expect(walletNameOnRecord(ORIGINAL_SLOT)).toBe(STRANGERS);
  return stranger;
};

/** What every act starts from. `beforeEach` cannot do it: each test runs two. */
const emptyBrowser = (): void => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* The open compartment is module state and outlives a test. */
  forgetOpenWallet();
  mockCreatePasskey.mockResolvedValue(registrationFixture);
  mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-new'));
};

beforeEach(emptyBrowser);

/** The secret behind the keyring the landing just sealed, read back out. */
const landedSecret = async (): Promise<Uint8Array> =>
  (await loadSecret(openWalletId())) as Uint8Array;

/**
 * BOTH HALVES OF "SETTLED", ASSERTED THE SAME WAY FOR ALL FOUR LANDINGS.
 *
 * The present case is checked through `walletNameOf` as well as
 * `walletNameOnRecord`: the unchecked reader alone would accept a record left
 * by anybody, so a landing that wrote the right STRING against the wrong
 * fingerprint would pass a `walletNameOnRecord` assertion and fail a person.
 */
const expectNameLanded = async (): Promise<void> => {
  const secret = await landedSecret();
  expect(walletNameOnRecord(openWalletId())).toBe(GIVEN);
  expect(walletNameOf(secret)).toBe(GIVEN);
};

/**
 * ACT 2'S PREMISE, ASSERTED FIRST — because every act 2 claims a record was
 * not inherited from **a different wallet**, and nothing else in this file
 * establishes that there are two wallets to be different.
 *
 * `fingerprintOf` is what decides it, and it is the one function the writer
 * and every reader share. Collapse it to a constant and the fixture stops
 * being a fixture: `settleWalletName`'s second case reads the stranger's
 * record as THE LANDED WALLET'S OWN NAME (`session.tsx:334`) and keeps it, on
 * purpose and correctly, because as far as the code can tell it is the same
 * wallet coming home.
 *
 * **WHAT THIS BUYS IS THE REASON, NOT THE DETECTION, AND THAT IS WORTH BEING
 * EXACT ABOUT.** The three assertions below go red under that collapse
 * anyway. What they say when they do is *the landing failed to settle the
 * record* — which would be false: the landing behaved perfectly and the
 * fixture was the thing that broke. This line fails first and says so. It is
 * `wallet-name.test.ts`'s *"reader and writer do not share a blind spot"*
 * over the landings rather than over the writer, and it is the difference
 * between a red suite that points at `session.tsx` and one that points at
 * `recovery/pieces.ts`.
 */
const expectStrangersNameGone = async (stranger: Secret): Promise<void> => {
  const secret = await landedSecret();
  expect(toBase64Url(fingerprintOf(secret)))
    .not.toBe(toBase64Url(fingerprintOf(stranger)));

  /* Not "is not the stranger's" — ABSENT. An unnamed wallet is a supported
   * state everywhere in this build, so the empty settlement REMOVES the
   * record rather than leaving an empty one behind. */
  expect(walletNameOnRecord(openWalletId())).toBeNull();
  expect(localStorage.getItem(WALLET_NAME_KEY)).toBeNull();
  expect(walletNameOf(secret)).toBeNull();
};

/* ------------------------------------------------------------ landing 1 of 4 */

describe('createAccount settles the name record it lands beside', () => {
  it('lands the given name against its own secret, and never inherits a stranger’s',
    async () => {
      /* ACT 1 — a name was given. */
      mount({ name: GIVEN });
      fireEvent.click(screen.getByText('create'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      await expectNameLanded();

      /* ACT 2 — no name, over a compartment holding a stranger's record. */
      emptyBrowser();
      const stranger = strandedStrangersName();
      mount();
      expect(phase()).toBe('passkey-no-account');
      fireEvent.click(screen.getByText('create'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      /* The wallet landed in the shelf compartment — the stranger's record is
       * the one that was there, so this is the inheritance case and not a
       * different compartment quietly passing. */
      expect(openWalletId()).toBe(ORIGINAL_SLOT);
      await expectStrangersNameGone(stranger);
    });
});

/* ------------------------------------------------------------ landing 2 of 4 */

describe('startFresh settles the name record it lands beside', () => {
  it('lands the given name against its own secret, and never inherits a stranger’s',
    async () => {
      /* ACT 1. `startFresh` is reached from `passkey-no-account`, so the
       * fixture is a stale credential either way; here it has no name record
       * beside it. */
      savePasskey(passkeyFixture('cred-stale'), ORIGINAL_SLOT);
      mount({ name: GIVEN });
      expect(phase()).toBe('passkey-no-account');
      fireEvent.click(screen.getByText('fresh'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      await expectNameLanded();

      /* ACT 2 — and this landing is the one that is DEFINED as replacing what
       * is here, so an inherited name is at its most plausible. */
      emptyBrowser();
      const stranger = strandedStrangersName();
      mount();
      expect(phase()).toBe('passkey-no-account');
      fireEvent.click(screen.getByText('fresh'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      expect(openWalletId()).toBe(ORIGINAL_SLOT);
      await expectStrangersNameGone(stranger);
    });
});

/* ------------------------------------------------------------ landing 3 of 4 */

const PLACEMENTS = [
  { label: 'Cloud', holder: 'my cloud' },
  { label: 'Paper', holder: 'the safe' },
  { label: 'Person', holder: 'my sister' },
];

/** Two of three real pieces of a real split, offered one click at a time. */
const gatherEnough = async (): Promise<void> => {
  fireEvent.click(screen.getByText('offer-0'));
  await waitFor(() => expect(screen.getByTestId('gathered').textContent).toBe('1'));
  fireEvent.click(screen.getByText('offer-2'));
  await waitFor(() => expect(screen.getByTestId('gathered').textContent).toBe('2'));
};

describe('finishRecovery settles the name record it lands beside', () => {
  it('lands the given name against the REBUILT secret, and never inherits a stranger’s',
    async () => {
      /* ACT 1 — real pieces, real rebuild, real seal. */
      const secret = newSecret();
      const set = await splitSecret(secret, PLACEMENTS, 2);
      mount({ name: GIVEN, pieces: set });
      await gatherEnough();
      fireEvent.click(screen.getByText('recover'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      /* The record is bound to the secret the PIECES were cut from — the whole
       * point of a recovery is that this is the old wallet, not a new one. */
      expect(walletNameOf(secret)).toBe(GIVEN);
      await expectNameLanded();

      /* ACT 2 — the same recovery onto a browser holding a stranger's name. */
      emptyBrowser();
      const stranger = strandedStrangersName();
      const second = newSecret();
      const secondSet = await splitSecret(second, PLACEMENTS, 2);
      mount({ pieces: secondSet });
      expect(phase()).toBe('passkey-no-account');
      await gatherEnough();
      fireEvent.click(screen.getByText('recover'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      expect(openWalletId()).toBe(ORIGINAL_SLOT);
      await expectStrangersNameGone(stranger);
      expect(walletNameOf(second)).toBeNull();
    });
});

/* ------------------------------------------------------------ landing 4 of 4 */

describe('finishPairing settles the name record it lands beside', () => {
  it('lands the given name against the ARRIVED secret, and never inherits a stranger’s',
    async () => {
      /* ACT 1 — the secret another machine sent. The pairing protocol itself
       * is pinned in `add-device.test.tsx`; what is under test here is the
       * landing it ends in. */
      const arrived = newSecret();
      mount({ name: GIVEN, incoming: arrived });
      fireEvent.click(screen.getByText('pair'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      expect(walletNameOf(arrived)).toBe(GIVEN);
      await expectNameLanded();

      /* ACT 2 — a second machine's wallet arriving where a stranger's name is
       * still on the shelf. */
      emptyBrowser();
      const stranger = strandedStrangersName();
      const second = newSecret();
      mount({ incoming: second });
      expect(phase()).toBe('passkey-no-account');
      fireEvent.click(screen.getByText('pair'));
      await waitFor(() => expect(phase()).toBe('unlocked'));
      expect(openWalletId()).toBe(ORIGINAL_SLOT);
      await expectStrangersNameGone(stranger);
      expect(walletNameOf(second)).toBeNull();
    });
});

/*
 * THE LIST ITSELF, PINNED — so a FIFTH landing cannot be added in silence.
 *
 * Every test above is about a landing somebody thought of. This one is about
 * the one nobody did: a new caller of `saveSecret` that forgets the record is
 * exactly the caller that will not turn up in a search for the record. The
 * source is read as text, which is the only way to ask "how many are there"
 * from inside the runner.
 */
describe('the enumeration is the claim, so the enumeration is pinned', () => {
  it('has exactly four callers of saveSecret, and every one of them settles the name',
    async () => {
      /* Read off the runner's own working directory — `vitest.config.ts`
       * pins `root: '.'` at the repository root. `import.meta.url` is not a
       * file URL under jsdom, which is where the first version of this line
       * died. */
      const fs = await import('node:fs/promises');
      const source = await fs.readFile('apps/wallet/src/session.tsx', 'utf8');
      /* The calls, not the import line: `await saveSecret(` is the landing. */
      const calls = source.match(/await saveSecret\(/gu) ?? [];
      expect(calls).toHaveLength(4);
      /* And the settling helper is called once per landing. A fifth landing
       * that settles has to move this number too, which is a line of the diff
       * somebody reads; a fifth that does not is a red test. */
      const settles = source.match(/settleWalletName\(/gu) ?? [];
      /* One definition plus one call per landing. */
      expect(settles).toHaveLength(5);
    });
});
