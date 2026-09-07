import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Purposes } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';
import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';

/**
 * THE LOCK ON A PIECE — separate from the home it sits in. §7.10.
 *
 * A home is where the bytes are kept: their own Google account, paper, a second
 * device. A lock is what has to be present to open them. Keeping the two apart
 * is what makes a wallet-locked piece in a cloud account, or a printed
 * wallet-locked QR code, free rather than a rewrite.
 *
 * **ONE LOCK SHIPS: another wallet.** Outside wallets — MetaMask, hardware keys
 * — are deferred until the sign-twice determinism check exists, because a
 * wallet that signs differently the second time destroys the piece silently.
 *
 * A CORRECTION TO WHAT WAS WRITTEN IN §7.10, made after reading the shipped
 * ledger rather than assuming. That section says a Midnight wallet publishes an
 * encryption key as half of every address and we encrypt the piece to that.
 * **The key is published; the decryption is not.** `EncryptionSecretKey` in
 * `ledger-v9` exposes `test(offer)` and serialisation, and no way to decrypt
 * arbitrary bytes — it is for finding coins meant for you, not for receiving
 * messages. So encrypting to somebody's payment address is not something the
 * platform can do.
 *
 * What ships instead, and it is the same user-facing feature: **every identity
 * publishes a RECOVERY KEY** — an X25519 public key from the authority
 * compartment, deliberately not the money one, so it is never mistaken for an
 * address and nothing can be paid to it. A piece locked to it can be opened by
 * that wallet and nothing else.
 *
 * NONE OF THE CRYPTOGRAPHY IS OURS. X25519 for the agreement, HKDF-SHA256 to
 * turn the agreed bytes into a key, XChaCha20-Poly1305 to seal — all
 * `@noble`, all standard, and the sealed value carries its own tag so a single
 * altered byte is a refusal rather than rubbish.
 *
 * WHO ELSE THIS WORKS FOR. A trusted person is the same operation: they publish
 * their recovery key, the piece is locked to it, and only they can open it. The
 * format is fixed and written down below so another wallet can implement it.
 */

/** The sealed form: version, ephemeral public key, nonce, ciphertext+tag. */
const VERSION = 1;
const EPHEMERAL_BYTES = 32;
const NONCE_BYTES = 24;
const HEADER = 1 + EPHEMERAL_BYTES + NONCE_BYTES;

export type LockFailure =
  | 'not-a-recovery-key'
  | 'locked-to-itself'
  | 'will-not-open-where-it-is'
  | 'not-sealed-by-this-library'
  | 'wrong-key'
  | 'damaged';

export class LockError extends Error {
  readonly code: LockFailure;
  constructor(code: LockFailure, message: string) {
    super(message);
    this.name = 'LockError';
    this.code = code;
  }
}

export interface RecoveryKeypair {
  /** Published. Shown to whoever is locking a piece for this wallet. */
  readonly publicKey: string;
  readonly secretKey: Uint8Array;
}

/**
 * The keypair a wallet opens locked pieces with.
 *
 * Produced from the identity every time rather than stored, which is the whole
 * point of a derived key: there is nothing to back up and nothing to lose.
 */
export function recoveryKeypair(identity: Identity, index = 0): RecoveryKeypair {
  const secretKey = identity.authority(Purposes.Recovery, index);
  return Object.freeze({
    publicKey: toBase64Url(x25519.getPublicKey(secretKey)),
    secretKey,
  });
}

/** What somebody publishes so a piece can be locked to their wallet. */
export const recoveryKeyOf = (identity: Identity, index = 0): string =>
  recoveryKeypair(identity, index).publicKey;

function readPublicKey(published: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(published.trim());
  } catch (e) {
    throw new LockError(
      'not-a-recovery-key',
      `that is not a recovery key: ${(e as Error).message}`);
  }
  if (bytes.length !== EPHEMERAL_BYTES) {
    throw new LockError(
      'not-a-recovery-key',
      `a recovery key is ${EPHEMERAL_BYTES} bytes; that one is ${bytes.length}. `
      + 'A payment address is not a recovery key — they are different things and '
      + 'nothing should ever be paid to this one.');
  }
  return bytes;
}

/**
 * Lock a piece so only the holder of that recovery key can open it.
 *
 * A fresh ephemeral key is used every time, so **locking the same piece twice
 * produces two different values** and nobody watching a storage location can
 * tell that the same piece was written again.
 */
export function lockPiece(
  piece: Uint8Array, toRecoveryKey: string, ownRecoveryKey: string,
): Uint8Array {
  /*
   * THE OWNER'S KEY IS A REQUIRED ARGUMENT, not something a caller may pass to
   * a separate checker it might forget, for the fourth time:
   * the first fix was a function nothing called, and `lockPiece` is the only
   * door into locking. A set locked entirely to the splitter's own key passes
   * every other check in this library and can only be opened by holding the
   * thing it exists to recover.
   */
  checkLockPlan([toRecoveryKey], ownRecoveryKey);
  const theirPublic = readPublicKey(toRecoveryKey);
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, theirPublic);

  /*
   * BOTH PUBLIC KEYS GO INTO THE KEY DERIVATION, not just the shared secret.
   * Binding the sealed value to the pair it was made for is what stops a
   * ciphertext being re-pointed at a different recipient by an attacker who can
   * edit storage.
   */
  const key = hkdf(sha256, shared, undefined, info(ephemeral.publicKey, theirPublic), 32);
  /*
   * THE NONCE IS RANDOM AND IT IS NOT WHAT MAKES THIS SAFE, which is worth
   * saying because it looks like it is. The ephemeral key is fresh for every
   * lock, so the derived key is fresh too and exactly one message is ever
   * encrypted under it — the case a nonce exists to prevent cannot arise.
   *
   * Which also means **no test can catch a fixed nonce here**: the output
   * already differs every time because the ephemeral key does. Measured, not
   * assumed — a zeroed nonce leaves the whole suite green. It stays random as
   * cover for a future change that reuses an ephemeral key, and this note is
   * here so nobody reads the randomness as load-bearing.
   */
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = xchacha20poly1305(key, nonce).encrypt(piece);

  const out = new Uint8Array(HEADER + sealed.length);
  out[0] = VERSION;
  out.set(ephemeral.publicKey, 1);
  out.set(nonce, 1 + EPHEMERAL_BYTES);
  out.set(sealed, HEADER);
  return out;
}

/** Open a piece locked to this wallet's recovery key. */
export function unlockPiece(locked: Uint8Array, keypair: RecoveryKeypair): Uint8Array {
  if (locked.length <= HEADER) {
    throw new LockError(
      'not-sealed-by-this-library',
      `a locked piece is at least ${HEADER + 1} bytes; that one is ${locked.length}.`);
  }
  if (locked[0] !== VERSION) {
    throw new LockError(
      'not-sealed-by-this-library',
      `this was locked in format ${locked[0]} and this library reads format ${VERSION}.`);
  }

  const ephemeralPublic = locked.slice(1, 1 + EPHEMERAL_BYTES);
  const nonce = locked.slice(1 + EPHEMERAL_BYTES, HEADER);
  const body = locked.slice(HEADER);

  const ourPublic = x25519.getPublicKey(keypair.secretKey);
  const shared = x25519.getSharedSecret(keypair.secretKey, ephemeralPublic);
  const key = hkdf(sha256, shared, undefined, info(ephemeralPublic, ourPublic), 32);

  try {
    return xchacha20poly1305(key, nonce).decrypt(body);
  } catch {
    /*
     * ONE MESSAGE FOR BOTH CAUSES, because the tag cannot tell them apart and
     * pretending otherwise would be a guess: the wrong wallet and a damaged
     * piece both fail here, and both mean *this will not open*.
     */
    throw new LockError(
      'wrong-key',
      'this piece does not open with this wallet. Either it was locked for a '
      + 'different one, or it has been altered since — the seal cannot tell those '
      + 'apart, and either way it will not open.');
  }
}

/**
 * A PIECE LOCKED TO THE SPLITTER'S OWN KEY IS NOT A PIECE.
 *
 * §7.10 names this in writing — *"a wallet derived from the same secret is not
 * a second holder, it is the same piece wearing a hat"* — and said the §7.2
 * check applied unchanged. It did not: `checkPlan` compares placement strings
 * and a lock is not a placement, so nothing looked. A set locked entirely to
 * `recoveryKeyOf(yourself)` can only be opened by holding the secret it exists
 * to recover, and it passes every other check there is.
 */
export function checkLockPlan(
  lockedTo: readonly (string | null | undefined)[], ownRecoveryKey: string,
): void {
  const own = ownRecoveryKey.trim();
  for (const key of lockedTo) {
    if (key && key.trim() === own) {
      throw new LockError(
        'locked-to-itself',
        'this piece would be locked to the account it is meant to recover, so the '
        + 'only thing that could open it is the thing being recovered. Lock it to '
        + 'somebody else, or to nothing at all.');
    }
  }
}

/**
 * PROVE THE SET AS IT WILL ACTUALLY BE STORED — locked, not bare.
 *
 * `proveRecoverable` in `pieces.ts` rebuilds from every minimum subset of the
 * *unlocked* bytes. Locking happens afterwards, against a published key that
 * cannot be checked, and until this existed **nothing ever opened a locked
 * piece to see that it opened.** So a set could pass its proof and then be
 * sealed to a key nobody involved holds — a substituted one, a stale one, or
 * the person's own — and the failure would surface on the day there was nothing
 * else left.
 *
 * `open` is supplied by the caller because only the caller knows who holds
 * what: in a guardian set nobody has all the keys, so the honest version of
 * this check is *"each holder proves their own piece opens"*, which is exactly
 * what a set-up screen can ask them to do.
 */
export async function proveStoredPieceOpens(
  stored: Uint8Array, expected: Uint8Array,
  open: (locked: Uint8Array) => Promise<Uint8Array> | Uint8Array,
): Promise<void> {
  let opened: Uint8Array;
  try {
    opened = await open(stored);
  } catch (e) {
    throw new LockError(
      'will-not-open-where-it-is',
      `this piece does not open where it has been put: ${(e as Error).message}`);
  }
  const same = opened.length === expected.length
    && opened.every((byte, i) => byte === expected[i]);
  if (!same) {
    throw new LockError(
      'will-not-open-where-it-is',
      'this piece opens into something that is not the piece that was cut. It has '
      + 'not been recorded as placed.');
  }
}

/*
 * The domain separator. Fixed, versioned, and part of the derivation, so a
 * change to it is a change to the format rather than a silent re-key.
 */
function info(ephemeralPublic: Uint8Array, recipientPublic: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(`midnight-identity/piece-lock/v${VERSION}/`);
  const out = new Uint8Array(label.length + ephemeralPublic.length + recipientPublic.length);
  out.set(label, 0);
  out.set(ephemeralPublic, label.length);
  out.set(recipientPublic, label.length + ephemeralPublic.length);
  return out;
}
