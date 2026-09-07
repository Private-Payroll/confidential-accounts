// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { ReactNode } from 'react';

/*
 * RECOVERY, END TO END — a machine that never had the account gets it back
 * from REAL pieces of a REAL split, through the real screen. The only mocks
 * are the passkey ceremony (no authenticator in a runner); the split, the
 * session, the rebuild, the seal and the derivation are all the library's.
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
import { newSecret } from 'midnight-identity/keys/derivation';
import { fingerprintOf, splitSecret } from 'midnight-identity/recovery/pieces';
import type { PieceSet } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { SessionProvider, useSession } from '../session.js';
import { Recover } from './recover.js';
import {
  allPasskeys, arrivalOf, creationOf, loadSecret, loadSecuredSetup, savePasskey, saveSecret,
  saveSecuredSetup, securedSetupOnRecord,
} from '../accounts/storage.js';
import { ORIGINAL_SLOT, forgetOpenWallet, heldWallets } from '../accounts/wallets-held.js';

const mockCreatePasskey = vi.mocked(createPasskey);
const mockVerifyRegistration = vi.mocked(verifyRegistration);

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
  credentialId: 'cred-recovered', personHandle: 'cGVyc29uLTE', clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(), publicKeySpki: new Uint8Array([1, 2, 3]),
  publicKeyAlgorithm: -7, transports: [],
};

function Probe(): ReactNode {
  const session = useSession();
  return (
    <div data-testid="phase-probe">
      <span data-testid="phase">{session.phase.name}</span>
      <span data-testid="secret-fp">
        {session.phase.name === 'unlocked'
          ? toBase64Url(fingerprintOf(session.phase.secret))
          : ''}
      </span>
      {/* What the PROVIDER holds, not what a sentence says — the
        * pieces-dropped claim is pinned against this, at the call site. */}
      <span data-testid="gathered-count">
        {session.recovery === null ? '-' : String(session.recovery.gathered.length)}
      </span>
    </div>
  );
}

const mount = (): void => {
  render(
    <SessionProvider>
      <Recover />
      <Probe />
    </SessionProvider>,
  );
};

const addPiece = (set: PieceSet, index: number, holder?: string): void => {
  fireEvent.change(screen.getByLabelText("The piece's letters, from its card"), {
    target: { value: (toBase64Url(set.pieces[index]?.bytes ?? new Uint8Array()).match(/.{1,4}/g) ?? []).join(' ') },
  });
  fireEvent.change(screen.getByLabelText('Where this piece came from'), {
    target: { value: holder ?? set.pieces[index]?.placement.holder ?? `piece-${index}` },
  });
  fireEvent.click(screen.getByText('Add this piece'));
};

const PLACEMENTS = [
  { label: 'Cloud', holder: 'my cloud' },
  { label: 'Paper', holder: 'the safe' },
  { label: 'Person', holder: 'my sister' },
];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* The open compartment is module state and outlives a test. */
  forgetOpenWallet();
});

describe('recovery on a machine that never had the account', () => {
  it('gathers real pieces, reads the threshold OFF them, finishes, and unlocks the SAME account', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-recovered'));
    mount();

    addPiece(set, 0);
    /* One piece in — and the need came off the piece itself. */
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();

    addPiece(set, 2);
    expect(screen.getByText(/Enough pieces — 2 of the 2 needed are in\./)).toBeTruthy();

    fireEvent.click(screen.getByText('Put the account back on this machine'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('unlocked'));
    /* THE account, not an account: the unlocked identity derives from the
     * secret the pieces were cut from. */
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(secret)));
    /* The gate was re-established with a fresh credential for this machine. */
    expect(allPasskeys(ORIGINAL_SLOT).map((p) => p.credentialId)).toEqual(['cred-recovered']);
    /* And the completed screen claims what happened, pieces dropped — by design —
     * including the ceremony's own outcome as its own fact. */
    expect(screen.getByText(/The account is back\./)).toBeTruthy();
    expect(screen.getByText(/A new passkey opens it here\./)).toBeTruthy();

    /* §7.15: the landing WROTE the secured record — fingerprint from the
     * rebuilt secret, threshold off the pieces, holders as the person named
     * them, marked partial. The standing notice would be untrue here. */
    const record = loadSecuredSetup(secret);
    expect(record).not.toBeNull();
    expect(record?.partial).toBe(true);
    expect(record?.threshold).toBe(2);
    expect(record?.pieces.map((p) => p.holder).sort())
      .toEqual(['my cloud', 'my sister'].sort());
    /* Used a moment ago is the strongest freshness there is — a date, not a
     * guess about whether the home can be asked. */
    for (const piece of record?.pieces ?? []) {
      expect(typeof piece.lastVerified).toBe('number');
    }
  });

  /*
   * A RECOVERY IS NOT A BEGINNING, AND THE STAMP KNOWS IT.
   *
   * THE RULE: *"if a 'created' stamp is written by whatever code path
   * writes a keyring, then a recovery stamps itself as a creation, and the
   * card lies about the age of an account on the machine somebody just
   * recovered onto."* The account rebuilt below is older than this browser by
   * however long the pieces have existed. So this landing writes NEITHER
   * record, and Home's device card says nothing at all rather than something
   * false about when the account began.
   *
   * IT IS THE REAL LANDING, not a call to the writer: the whole risk is that
   * some other path reaches the stamp, so the test has to go through the path.
   */
  it('a recovery stamps NOTHING — the account is older than this browser', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-recovered'));
    mount();

    addPiece(set, 0);
    addPiece(set, 2);
    fireEvent.click(screen.getByText('Put the account back on this machine'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('unlocked'));

    /* Not created here — it was created wherever it was created, and this
     * browser has no idea when that was. */
    expect(creationOf(secret)).toBeNull();
    /* And not linked here either: nothing arrived from another device. */
    expect(arrivalOf(secret)).toBeNull();
  });

  it('tells the person whose last piece is elsewhere to carry the CARDS — §7.15(a)', () => {
    /* The session is never serialised, so the only way to finish on
     * another machine is to gather there. Before this sentence, the only
     * thing saying so was a reload that ate the work. */
    mount();
    expect(screen.getByText(/take your cards/)).toBeTruthy();
    expect(screen.getByText(/this half-finished recovery cannot travel/)).toBeTruthy();
  });

  it('two pieces from the same holder count once', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mount();
    addPiece(set, 0, 'same-holder');
    addPiece(set, 1, 'same-holder');
    /* Replaced, not added: still one. */
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();
  });

  it('a piece from a DIFFERENT ACCOUNT is refused at the door, in the library’s words', async () => {
    const secretA = newSecret();
    const setA = await splitSecret(secretA, PLACEMENTS, 2);
    const setB = await splitSecret(newSecret(), PLACEMENTS, 2);
    mount();
    addPiece(setA, 0);
    fireEvent.change(screen.getByLabelText("The piece's letters, from its card"), {
      target: { value: toBase64Url(setB.pieces[1]?.bytes ?? new Uint8Array()) },
    });
    fireEvent.change(screen.getByLabelText('Where this piece came from'), {
      target: { value: 'the safe' },
    });
    fireEvent.click(screen.getByText('Add this piece'));
    /* Refused when OFFERED — never counted toward "enough", never a finish
     * button that fails at the last press. The screen repeats the library's
     * sentence, which names the case. */
    expect(document.querySelector('.error')?.textContent ?? '')
      .toMatch(/from a DIFFERENT ACCOUNT/);
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();
    expect(screen.queryByText('Put the account back on this machine')).toBeNull();
    expect(screen.getByTestId('phase').textContent).not.toBe('unlocked');
    expect(await loadSecret(ORIGINAL_SLOT)).toBeNull();
  });

  it('a piece from a DIFFERENT CUT of the same account is named as exactly that', async () => {
    /* The rules keep superseded sets alive by design, so this is the ordinary
     * mix-up: old and new cards from the same drawer. */
    const secretA = newSecret();
    const setOld = await splitSecret(secretA, PLACEMENTS, 2);
    const setNew = await splitSecret(secretA, PLACEMENTS, 2);
    mount();
    addPiece(setNew, 0);
    fireEvent.change(screen.getByLabelText("The piece's letters, from its card"), {
      target: { value: toBase64Url(setOld.pieces[1]?.bytes ?? new Uint8Array()) },
    });
    fireEvent.change(screen.getByLabelText('Where this piece came from'), {
      target: { value: 'the safe' },
    });
    fireEvent.click(screen.getByText('Add this piece'));
    expect(document.querySelector('.error')?.textContent ?? '')
      .toMatch(/different cut of the same account/);
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();
  });

  it('garbage that is not a piece gets a sentence, not a crash', () => {
    mount();
    fireEvent.change(screen.getByLabelText("The piece's letters, from its card"), {
      target: { value: '!!!not-a-piece!!!' },
    });
    fireEvent.click(screen.getByText('Add this piece'));
    expect(document.querySelector('.error')?.textContent ?? '').not.toBe('');
  });

  it('cancelling drops the gathered pieces — every one — and offers a clean start', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mount();
    addPiece(set, 0);
    expect(screen.getByTestId('gathered-count').textContent).toBe('1');
    fireEvent.click(screen.getByText(/Stop this recovery/));
    expect(screen.getByText('This recovery was stopped.')).toBeTruthy();
    expect(screen.getByText(/pieces it had gathered were\s+dropped/)).toBeTruthy();
    /* Second half: the sentence is checked against the PROVIDER, not
     * against itself — the session the provider holds carries no pieces.
     * Replacing the `cancelRecovery` call with an inline state flip that
     * keeps the bytes turns this red. */
    expect(screen.getByTestId('gathered-count').textContent).toBe('0');
    fireEvent.click(screen.getByText('Start a new recovery'));
    expect(screen.getByText('Recover an account.')).toBeTruthy();
  });

  it('a cancelled ceremony after the rebuild leaves the account LANDED, behind the doorway phase', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mockCreatePasskey.mockRejectedValue(
      new Error('the passkey was not created — it was cancelled, or it timed out.'));
    mount();
    addPiece(set, 0);
    addPiece(set, 1);
    fireEvent.click(screen.getByText('Put the account back on this machine'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('account-no-passkey'));
    /* The recovered secret is sealed on this machine despite the cancelled
     * gate — the doorway screen's adopt button finishes the job. */
    const held = await loadSecret(ORIGINAL_SLOT);
    expect(held && toBase64Url(fingerprintOf(held))).toBe(toBase64Url(fingerprintOf(secret)));

    /* The SCREEN states the ceremony's outcome as its own fact. The
     * rebuild's tick does not print the gate's: no claim a passkey opens it
     * here, the failure in its own words, and the doorway named. */
    expect(screen.getByText(/one step left/)).toBeTruthy();
    expect(screen.queryByText(/A new passkey opens it here/)).toBeNull();
    expect(screen.getByText(/it was cancelled, or it timed out\./)).toBeTruthy();
    expect(screen.getByText(/Make a new passkey for this wallet/)).toBeTruthy();
  });

  it('the landing itself retires the OLD passkey record, not the ceremony', async () => {
    /*
     * A browser that already held passkeys used to fall back to `locked`
     * behind the OLD credential when the ceremony was cancelled — the doorway
     * only ever appeared in an empty browser. The reset belongs to the
     * landing: the moment the recovered secret is sealed, every credential on
     * record gates an account that is no longer here.
     */
    savePasskey(passkeyFixture('cred-old'), ORIGINAL_SLOT);
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mockCreatePasskey.mockRejectedValue(new Error('cancelled at the sheet.'));
    mount();
    addPiece(set, 0);
    addPiece(set, 1);
    fireEvent.click(screen.getByText('Put the account back on this machine'));
    /* The doorway, in EVERY browser — not `locked` behind a stale credential. */
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('account-no-passkey'));
    expect(allPasskeys(ORIGINAL_SLOT)).toEqual([]);
  });

  it('a landing that cannot store says so, and the session is NOT spent', async () => {
    /* Recovery shared the pairing hole: `completeRecovery` was announced
     * before `saveSecret`, so a browser that could not store showed
     * "rebuilt and sealed" over nothing, and a retry met "this recovery is
     * already completed". */
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mount();
    addPiece(set, 0);
    addPiece(set, 1);
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => { throw new Error('refused by this profile'); },
    };
    fireEvent.click(screen.getByText('Put the account back on this machine'));
    /* The storage sentence, on THIS screen's error line — and the screen is
     * still the gathering screen, because nothing completed. */
    expect(await screen.findByText(/this browser is refusing/)).toBeTruthy();
    expect(screen.queryByText(/The account is back/)).toBeNull();
    expect(screen.getByText(/Enough pieces/)).toBeTruthy();

    /* Storage returns; the SAME press finishes the SAME session. */
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-recovered'));
    fireEvent.click(screen.getByText('Put the account back on this machine'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('unlocked'));
    expect(screen.getByTestId('secret-fp').textContent)
      .toBe(toBase64Url(fingerprintOf(secret)));
  });

  it('withdrawing a piece steps the count back', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mount();
    addPiece(set, 0);
    addPiece(set, 1);
    fireEvent.click(screen.getAllByText('Take it back out')[0] as Element);
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();
  });
});

describe('the landing over what is already here', () => {
  const gatherReady = async (): Promise<void> => {
    const other = newSecret();
    const set = await splitSecret(other, PLACEMENTS, 2);
    addPiece(set, 0);
    addPiece(set, 1);
    await screen.findByText(/Enough pieces/);
  };

  it('a clean browser: the finish is one button, and says nothing is replaced', async () => {
    mount();
    await gatherReady();
    expect(screen.getByText('Put the account back on this machine')).toBeTruthy();
    expect(screen.getByText(/Nothing is stored in this browser, so nothing is replaced/))
      .toBeTruthy();
    expect(screen.queryByText(/already holds a wallet/)).toBeNull();
  });

  /*
   * THIS REPLACES BOTH OF THE TESTS THAT USED TO STAND HERE, AND WHAT THEY
   * PINNED IS NOW PINNED THE OTHER WAY UP.
   *
   * They asserted the two destructive landings: a stored wallet with a piece
   * map, and the worse one with none — each named, each behind an explicit
   * confirm, because finishing a recovery took the stored wallet's place.
   * **A recovery now lands in a compartment of its own**, so there is no
   * destruction to warn about and no confirm to stand in front of it. The
   * assertion that matters becomes the one the old tests could never make:
   * after the landing, the wallet that was here still opens.
   */
  it('a browser already holding a wallet: one button, and it says what is here is kept',
    async () => {
      const existing = newSecret();
      await saveSecret(existing);
      await saveSecuredSetup(existing, await splitSecret(existing, PLACEMENTS, 2), {
        'my cloud': 'never', 'the safe': null, 'my sister': 'never',
      });
      mount();
      await gatherReady();

      /* The one-click primary button is here, for every landing. */
      expect(screen.getByText('Put the account back on this machine')).toBeTruthy();
      /* And the danger apparatus is gone, because the danger is. */
      expect(screen.queryByText('Replace the wallet stored here…')).toBeNull();
      expect(screen.queryByText(/destroyed for good/)).toBeNull();
      expect(screen.queryByText(/This replaces/)).toBeNull();

      /* What is here is NAMED, and the sentence says it stays — before the
       * ceremony, which is what the change asks for. */
      expect(screen.getByText(/This browser already holds one wallet/)).toBeTruthy();
      expect(screen.getByText(/Nothing stored here is replaced/)).toBeTruthy();
    });

  it('THE LANDING ADDS A WALLET: the one that was here still opens afterwards', async () => {
    const existing = newSecret();
    const existingSlot = await saveSecret(existing);
    await saveSecuredSetup(existing, await splitSecret(existing, PLACEMENTS, 2), {
      'my cloud': 'never', 'the safe': null, 'my sister': 'never',
    });
    const existingMap = securedSetupOnRecord(existingSlot);

    mockCreatePasskey.mockResolvedValue(registrationFixture);
    mockVerifyRegistration.mockResolvedValue(passkeyFixture('cred-recovered'));
    mount();

    const other = newSecret();
    const set = await splitSecret(other, PLACEMENTS, 2);
    addPiece(set, 0);
    addPiece(set, 1);
    await screen.findByText(/Enough pieces/);
    fireEvent.click(screen.getByText('Put the account back on this machine'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('unlocked'));

    /* TWO WALLETS, and the recovered one is the one that is open. */
    expect(heldWallets()).toHaveLength(2);
    const recoveredSlot = heldWallets().find((w) => w.id !== existingSlot)?.id as string;
    expect([...(await loadSecret(recoveredSlot))!]).toEqual([...other]);

    /* THE ASSERTION THE OLD TESTS COULD NOT MAKE: the wallet that was here is
     * still sealed here, still opens to its own secret, and its map is
     * untouched — no `superseded`, because nothing was superseded. */
    expect([...(await loadSecret(existingSlot))!]).toEqual([...existing]);
    expect(securedSetupOnRecord(existingSlot)).toEqual(existingMap);
    expect(loadSecuredSetup(other)?.superseded ?? []).toHaveLength(0);
  });
});

describe('what the door refuses to count, at the screen', () => {
  const typePiece = (bytes: Uint8Array, from: string): void => {
    fireEvent.change(screen.getByLabelText("The piece's letters, from its card"), {
      target: { value: toBase64Url(bytes) },
    });
    fireEvent.change(screen.getByLabelText('Where this piece came from'), {
      target: { value: from },
    });
    fireEvent.click(screen.getByText('Add this piece'));
  };

  it('a blob the library cannot read is refused in its words, and moves nothing', () => {
    mount();
    typePiece(new Uint8Array(10), 'the safe');
    expect(document.querySelector('.error')?.textContent ?? '')
      .toMatch(/a recovery piece is more than/);
    /* No progress card appeared — nothing was counted. */
    expect(screen.queryByText(/of \d+ pieces\./)).toBeNull();
  });

  it('a piece that disagrees about the threshold is refused BY NAME and the number stands', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mount();
    addPiece(set, 0);
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();

    /* A real piece of this same cut with only its threshold byte altered —
     * so the account and cut checks pass and the threshold check itself is
     * what fires. (The original forged blob now trips the
     * different-account sentence first, which the tests above pin.) */
    const altered = Uint8Array.from(set.pieces[1]?.bytes ?? new Uint8Array());
    altered[1] = 9;
    typePiece(altered, 'the safe');
    expect(document.querySelector('.error')?.textContent ?? '')
      .toMatch(/says 9 pieces are needed, and the piece already in says 2/);
    /* Never "2 of 9": the agreed number describes the pieces that are in. */
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();
    expect(screen.queryByText(/of 9 pieces/)).toBeNull();
  });

  it('a replacement says which piece it replaced', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    mount();
    addPiece(set, 0, 'same-holder');
    addPiece(set, 1, 'Same-Holder');
    expect(screen.getByText('1 of 2 pieces.')).toBeTruthy();
    expect(screen.getByText(/That replaced the piece already entered from “same-holder”/))
      .toBeTruthy();
  });
});
