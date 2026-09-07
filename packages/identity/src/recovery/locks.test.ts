import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import {
  LockError, checkLockPlan, lockPiece, proveStoredPieceOpens, recoveryKeyOf, recoveryKeypair,
  unlockPiece,
} from './locks.js';
import { combinePieces, splitSecret } from './pieces.js';
import {
  identityFromSecret, identityFromWords, newSecret, secretFromWords,
} from '../keys/derivation.js';
import { addressFor } from '../wallet/address.js';
import { toBase64Url } from '../passkey/bytes.js';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const me = identityFromWords(TEST_MNEMONIC);
const someoneElse = identityFromSecret(newSecret());
/** Who is doing the locking. Required, so a self-lock cannot slip past. */
const MINE = recoveryKeyOf(me);
const THEIRS = recoveryKeyOf(someoneElse);

const refuses = (what: () => unknown, code: string): void => {
  let thrown: unknown;
  try {
    what();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected this to be refused, and it was not').toBeInstanceOf(LockError);
  expect((thrown as LockError).code).toBe(code);
};

describe('a piece locked to another wallet', () => {
  it('opens with that wallet and no other', () => {
    const theirs = recoveryKeypair(someoneElse);
    const piece = crypto.getRandomValues(new Uint8Array(43));

    const locked = lockPiece(piece, THEIRS, MINE);
    expect(hex(unlockPiece(locked, theirs))).toBe(hex(piece));
    refuses(() => unlockPiece(locked, recoveryKeypair(me)), 'wrong-key');
  });

  it('opens for the SAME wallet rebuilt from its words, which is the whole point', () => {
    /*
     * The wallet that opens a piece is not a stored keypair — it is derived from
     * the identity every time. So somebody who has recovered, or who is on a new
     * device, opens it with nothing kept.
     */
    const locked = lockPiece(new Uint8Array([1, 2, 3, 4]), MINE, THEIRS);
    const rebuilt = recoveryKeypair(identityFromWords(TEST_MNEMONIC));
    expect(hex(unlockPiece(locked, rebuilt))).toBe(hex(new Uint8Array([1, 2, 3, 4])));
  });

  it('produces a DIFFERENT sealed value every time, from the same piece and key', () => {
    const piece = new Uint8Array(43).fill(7);
    const locked = Array.from({ length: 8 }, () => lockPiece(piece, THEIRS, MINE));
    expect(new Set(locked.map(hex)).size).toBe(8);
    /*
     * And specifically the EPHEMERAL KEY differs, which is the part that
     * matters — it is what makes the encryption key fresh per lock. The nonce
     * is not load-bearing here and a fixed one would leave this file green; see
     * the note in `locks.ts`.
     */
    expect(new Set(locked.map((l) => hex(l.slice(1, 33)))).size).toBe(8);
  });

  it('refuses a single altered byte anywhere in the sealed value', () => {
    const theirs = recoveryKeypair(someoneElse);
    const locked = lockPiece(new Uint8Array(43).fill(3), THEIRS, MINE);
    for (let i = 0; i < locked.length; i += 1) {
      const tampered = Uint8Array.from(locked, (b, j) => (j === i ? b ^ 0x01 : b));
      expect(() => unlockPiece(tampered, theirs)).toThrow(LockError);
    }
  });

  it('cannot be re-pointed at another recipient by editing storage', () => {
    /*
     * Both public keys go into the key derivation, so a sealed value carries
     * the pair it was made for. Swapping in somebody else's ephemeral key does
     * not turn it into a piece for them.
     */
    const theirs = recoveryKeypair(someoneElse);
    const mine = recoveryKeypair(me);
    const locked = lockPiece(new Uint8Array(43).fill(9), THEIRS, MINE);
    const relabelled = Uint8Array.from(locked);
    relabelled.set(lockPiece(new Uint8Array(43), MINE, THEIRS).slice(1, 33), 1);
    expect(() => unlockPiece(relabelled, mine)).toThrow(LockError);
    expect(() => unlockPiece(relabelled, theirs)).toThrow(LockError);
  });

  it('refuses something that was not sealed by this library', () => {
    const theirs = recoveryKeypair(someoneElse);
    for (const junk of [new Uint8Array(0), new Uint8Array(57), new Uint8Array(20)]) {
      expect(() => unlockPiece(junk, theirs)).toThrow(/at least|format/u);
    }
    const wrongVersion = lockPiece(new Uint8Array(43), THEIRS, MINE);
    wrongVersion[0] = 9;
    refuses(() => unlockPiece(wrongVersion, theirs), 'not-sealed-by-this-library');
  });
});

describe('the recovery key that gets published', () => {
  it('is the same key every time for the same wallet, and different per wallet', () => {
    expect(recoveryKeyOf(me)).toBe(recoveryKeyOf(identityFromWords(TEST_MNEMONIC)));
    expect(recoveryKeyOf(me)).not.toBe(recoveryKeyOf(someoneElse));
    expect(recoveryKeyOf(me, 0)).not.toBe(recoveryKeyOf(me, 1));
  });

  it('IS NOT AN ADDRESS, and an address is not one', () => {
    /*
     * It lives in the authority compartment, never the money one, so nothing
     * can be paid to it — and pasting an address where a recovery key belongs
     * is refused by name rather than producing a piece nobody can open.
     */
    const address = addressFor(me.money.zswap, 'testnet');
    expect(recoveryKeyOf(me)).not.toContain('mn_shield');
    refuses(() => lockPiece(new Uint8Array(43), address.bech32, MINE), 'not-a-recovery-key');
    expect(recoveryKeyOf(me)).not.toBe(toBase64Url(me.money.zswap));
  });

  it('refuses a key of the wrong length rather than locking to nothing', () => {
    for (const bad of [toBase64Url(new Uint8Array(31)), toBase64Url(new Uint8Array(33)), '']) {
      refuses(() => lockPiece(new Uint8Array(43), bad, MINE), 'not-a-recovery-key');
    }
  });
});

describe('a locked piece is still a piece', () => {
  it('recovers the account after being locked, stored and opened again', async () => {
    /*
     * The end-to-end shape of §7.10: cut, lock each piece to whoever is holding
     * it, and the set still rebuilds the account when they open theirs.
     */
    const secret = secretFromWords(TEST_MNEMONIC);
    const guardians = [identityFromSecret(newSecret()), identityFromSecret(newSecret())];
    const set = await splitSecret(secret, [
      { label: 'My brother', holder: 'person:brother' },
      { label: 'My accountant', holder: 'person:accountant' },
      { label: 'Printed', holder: 'paper' },
    ], 2);

    const stored = guardians.map((g, i) =>
      lockPiece(set.pieces[i]!.bytes, recoveryKeyOf(g), MINE));
    const opened = stored.map((locked, i) => unlockPiece(locked, recoveryKeypair(guardians[i]!)));
    expect(hex(await combinePieces(opened))).toBe(hex(secret));
  });
});

describe('locking, proved rather than assumed', () => {
  const refusesAsync = async (what: () => Promise<unknown>, code: string): Promise<void> => {
    let thrown: unknown;
    try {
      await what();
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'expected this to be refused, and it was not').toBeInstanceOf(LockError);
    expect((thrown as LockError).code).toBe(code);
  };

  it('REFUSES A PIECE LOCKED TO THE ACCOUNT IT IS MEANT TO RECOVER, at the only door', () => {
    /*
     * §7.10 names this — "a wallet derived from the same secret is not a second
     * holder, it is the same piece wearing a hat" — and said the §7.2 check
     * applied unchanged. It did not: `checkPlan` compares placement strings and
     * a lock is not a placement.
     *
     * The first fix was a function nothing called, which is a known shape for the
     * fourth time. **The owner's key is now an argument to `lockPiece`**, so
     * there is no way to lock without passing through the check.
     */
    refuses(() => lockPiece(new Uint8Array(43), MINE, MINE), 'locked-to-itself');
    refuses(() => checkLockPlan([THEIRS, MINE], MINE), 'locked-to-itself');
    expect(() => checkLockPlan([THEIRS, null, undefined], MINE)).not.toThrow();
    /* Locking to somebody else, by somebody else, is ordinary. */
    expect(() => lockPiece(new Uint8Array(43), MINE, THEIRS)).not.toThrow();
  });

  it('accepts a piece that opens where it has been put', async () => {
    const theirs = recoveryKeypair(someoneElse);
    const piece = crypto.getRandomValues(new Uint8Array(43));
    const stored = lockPiece(piece, THEIRS, MINE);
    await expect(proveStoredPieceOpens(stored, piece, (l) => unlockPiece(l, theirs)))
      .resolves.toBeUndefined();
  });

  it('REFUSES a piece sealed to a key its holder does not have', async () => {
    /*
     * The substituted-key case: a stale published key, or one somebody edited.
     * Everything up to this point succeeds — the cut, the proof of the cut, the
     * locking — and the failure would otherwise appear on the day there is
     * nothing else.
     */
    const holder = recoveryKeypair(someoneElse);
    const piece = new Uint8Array(43).fill(5);
    const sealedToTheWrongPerson = lockPiece(piece, MINE, THEIRS);
    await refusesAsync(
      () => proveStoredPieceOpens(sealedToTheWrongPerson, piece, (l) => unlockPiece(l, holder)),
      'will-not-open-where-it-is');
  });

  it('REFUSES a piece that opens into something other than the piece that was cut', async () => {
    const theirs = recoveryKeypair(someoneElse);
    const piece = new Uint8Array(43).fill(1);
    const stored = lockPiece(new Uint8Array(43).fill(2), THEIRS, MINE);
    await refusesAsync(
      () => proveStoredPieceOpens(stored, piece, (l) => unlockPiece(l, theirs)),
      'will-not-open-where-it-is');
  });
});
