import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64Url, sameBytes, toBase64Url } from '../passkey/bytes.js';
import { SECRET_BYTES } from '../keys/derivation.js';
import type { Secret } from '../keys/derivation.js';

/**
 * GETTING KEYS ONTO A NEW MACHINE BY SCANNING A CODE. §1, §4 step 6.
 *
 * The passkey syncs, so it gets somebody **in** on a new device. It carries no
 * key material by design (§3), so their **keys** still have to arrive, and this
 * is the short way: the new device shows a code, a device that already has the
 * keys scans it, both screens show the same two digits, the person confirms,
 * and the keys cross. Once per device, not once per sign-in.
 *
 * THE FIRST VERSION OF THIS FILE WAS BROKEN AND THE BREAK WAS TOTAL.
 *
 *   It computed the two digits from the sealer's ephemeral key and the scanned
 *   code, with no commitment anywhere. So a relay swapped in its own code, took
 *   the whole secret, then **ground its own ephemeral keypair until the digits
 *   matched the ones it had just watched the other screen display.** 245 tries
 *   — a COUNT, measured. How long those tries took has never been measured in
 *   this repository, so no figure is given here: what matters is that 245 is a
 *   number a laptop reaches without anybody waiting for it. Both screens then
 *   agreed, the person confirmed, and the attack looked exactly like a
 *   successful pairing.
 *
 *   Two digits is one chance in a hundred only against somebody who must fix
 *   their contribution BEFORE learning the target. Without a commitment it is
 *   one in one, and adding digits does not help — four digits is ten thousand
 *   tries, which is the same kind of nothing as 245.
 *
 * SO THE PROTOCOL COMMITS FIRST, and it is four short steps:
 *
 *   1. NEW  shows a code carrying its public key.
 *   2. OLD  scans it, makes an ephemeral key, and sends a COMMITMENT to it —
 *           a hash, revealing nothing.
 *   3. NEW  checks it has not seen that commitment before and answers with a
 *           fresh random NONCE.
 *   4. OLD  reveals its ephemeral key. The digits are a hash of the code key,
 *           the revealed key AND the nonce — so the old device could not have
 *           chosen them, because the nonce did not exist when it committed, and
 *           the new device verifies the commitment before believing any of it.
 *
 * **AND THE OLD DEVICE ONLY ANSWERS ONCE.** Found when the fix above was
 * re-audited. Committing to the key bound one of the two contributions and left
 * the other free: the relay sent a throwaway nonce to learn the ephemeral key,
 * ran the honest side to see what number the other screen would show, then
 * **ground a second nonce** until the old device displayed the same one.
 * Seventy-one tries. The commitment moved the grind; it did not end it.
 *
 * The asymmetry was the tell — the new device already refused a second
 * commitment, *"rather than letting a second device join a conversation already
 * in progress"*, and **the side holding the money refused nothing.** So a
 * pending offer is now one-use and carries its own deadline, and the reveal is
 * the step that spends it.
 *
 * Only now do both screens show a number, and **only after the person confirms
 * is anything sealed.** That is the second half of it: the earlier version
 * sealed the secret before the comparison, so a mismatch was a notification
 * rather than a gate — by the time the person could say stop, the secret had
 * already been produced in a form the attacker could open.
 *
 * WHAT EACH DEFENCE ACTUALLY COVERS:
 *
 *   photographing the code   an offer they cannot open: the code's secret key
 *                            never leaves the new device
 *   swapping the code        the digits differ, and cannot be ground to match
 *   replaying anything       a request is one-use, and a code carries a life
 *                            the scanning device will not exceed
 *
 * NONE OF THE CRYPTOGRAPHY IS OURS: X25519, HKDF-SHA256, XChaCha20-Poly1305,
 * SHA-256, all `@noble`.
 */

const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const SAS_NONCE_BYTES = 16;
/** Long enough that guessing is hopeless, short enough to be a QR code. */
export const PAIRING_TTL_MS = 3 * 60 * 1000;

export type PairingFailure =
  | 'not-an-offer'
  | 'expired'
  | 'lives-too-long'
  | 'already-used'
  | 'out-of-order'
  | 'commitment-broken'
  | 'digits-do-not-match'
  | 'will-not-open'
  | 'secret-wrong-length';

export class PairingError extends Error {
  readonly code: PairingFailure;
  constructor(code: PairingFailure, message: string) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

/**
 * Held privately by the NEW device. Never shown, never sent.
 *
 * It is a value rather than a handle so a host can keep it, but the secret key
 * inside it is the whole point of the scheme — it must not leave the machine.
 */
export interface PairingRequest {
  readonly secretKey: Uint8Array;
  /** The string that becomes a QR code. Safe to display. */
  readonly code: string;
  readonly expiresAt: number;
  /** What the old device committed to, once it has. */
  readonly commitment: string | null;
  /** The nonce this device chose in answer. Fixes the digits. */
  readonly nonce: string | null;
  /** One use. A request that has produced a secret will not produce another. */
  readonly used: boolean;
}

/**
 * Held privately by the OLD device between committing and revealing.
 *
 * **It answers exactly one nonce and it expires.** Revealing is what
 * spends it, and sealing refuses until it has been spent — so the order is
 * enforced rather than conventional, on the side that is holding the account.
 *
 * IT IS A CLASS WITH A MUTABLE FLAG, AND THAT IS THE POINT. Everything else in
 * this library is a frozen value that returns a new one, which is right for
 * things a host stores — but "one use" expressed that way is enforced by the
 * caller remembering to keep the new copy and throw the old one away. **A rule
 * a caller can decline to follow is not a rule.** This one is spent in place.
 *
 * It must never be serialised: it holds the ephemeral secret, and it is alive
 * for about as long as somebody takes to read two digits off a screen.
 */
export class PendingOffer {
  readonly ephemeralSecret: Uint8Array;

  readonly ephemeralPublic: Uint8Array;

  readonly theirPublicKey: Uint8Array;

  readonly commitment: string;

  readonly expiresAt: number;

  private answered: string | null = null;

  constructor(parts: {
    ephemeralSecret: Uint8Array; ephemeralPublic: Uint8Array;
    theirPublicKey: Uint8Array; commitment: string; expiresAt: number;
  }) {
    this.ephemeralSecret = parts.ephemeralSecret;
    this.ephemeralPublic = parts.ephemeralPublic;
    this.theirPublicKey = parts.theirPublicKey;
    this.commitment = parts.commitment;
    this.expiresAt = parts.expiresAt;
  }

  /** The one nonce this offer will ever answer. Null until it has. */
  get answeredNonce(): string | null {
    return this.answered;
  }

  /** Spends it. A second call throws, whatever the caller kept a reference to. */
  answerOnce(nonce: string): void {
    if (this.answered !== null) {
      throw new PairingError(
        'already-used',
        'this device has already shown a number for this pairing. Start again rather '
        + 'than answering twice — being asked twice is what somebody in the middle '
        + 'has to do.');
    }
    this.answered = nonce;
  }
}

/** Step two: what the old device sends after scanning. Reveals nothing. */
export interface Commitment {
  readonly commitment: string;
}

/**
 * Step four: what travels, and what goes on the screen — **and they are not the
 * same thing.**
 *
 * `ephemeralPublic` is sent. `digits` is displayed and **never transmitted**,
 * which is the entire idea: two devices compute the number independently and a
 * person compares them. A number that arrived over the wire would be a number
 * whoever controls the wire chose.
 *
 * An earlier version put `digits` in the message and had the receiving side
 * check it. That was worse in both directions — it invited a relay to omit the
 * field, and it made the honest caller carry a value it should never have had.
 */
export interface Reveal {
  /** Sent to the other device. */
  readonly ephemeralPublic: string;
  /** Shown on THIS device's screen. Not sent anywhere. */
  readonly digits: string;
}

/** Step six: the keys themselves, produced only after the person confirms. */
export interface SealedKeys {
  readonly sealed: string;
}

interface Code {
  readonly publicKey: Uint8Array;
  readonly expiresAt: number;
}

/* ---------- step 1, on the NEW device ---------- */

export function askToPair(now: number, ttlMs: number = PAIRING_TTL_MS): PairingRequest {
  const keys = x25519.keygen();
  const expiresAt = now + Math.max(1, Math.min(ttlMs, PAIRING_TTL_MS));
  return Object.freeze({
    secretKey: keys.secretKey,
    code: encodeCode({ publicKey: keys.publicKey, expiresAt }),
    expiresAt,
    commitment: null,
    nonce: null,
    used: false,
  });
}

/* ---------- step 2, on the OLD device: scan and commit ---------- */

export function beginOffer(
  code: string, now: number,
): { readonly pending: PendingOffer; readonly message: Commitment } {
  const scanned = decodeCode(code);
  if (now >= scanned.expiresAt) {
    throw new PairingError(
      'expired',
      'that code has expired. Ask the new device for a fresh one — they last a few '
      + 'minutes on purpose, so a photograph taken earlier is worth nothing.');
  }
  /*
   * THE LIFE OF A CODE IS BOUNDED BY THE DEVICE THAT SCANS IT, not by the
   * device that wrote it. The expiry is a number inside the code, set by the
   * side there is no reason to trust: without this, a code claiming a hundred
   * years is accepted, and still accepted a decade later.
   */
  if (scanned.expiresAt - now > PAIRING_TTL_MS) {
    throw new PairingError(
      'lives-too-long',
      'that code claims to be valid for far longer than a pairing code should be. '
      + 'Ask the other device for a fresh one.');
  }

  /*
   * A FRESH KEYPAIR, FROM THE SYSTEM'S RANDOMNESS, AND NOTHING ELSE.
   *
   * Deriving it from anything the other side supplies — the scanned code, for
   * instance — would be invisible in every test and would mean **anybody who
   * photographs the code and captures the sealed blob opens it**, because
   * X25519 opens for either private key. The half that never leaves the new
   * device is only half the confidentiality; this is the other half.
   */
  const ephemeral = x25519.keygen();
  const commitment = toBase64Url(sha256(
    joined(`midnight-identity/pairing-commit/v${VERSION}/`, ephemeral.publicKey)));

  return {
    pending: new PendingOffer({
      ephemeralSecret: ephemeral.secretKey,
      ephemeralPublic: ephemeral.publicKey,
      theirPublicKey: scanned.publicKey,
      commitment,
      expiresAt: scanned.expiresAt,
    }),
    message: Object.freeze({ commitment }),
  };
}

/* ---------- step 3, on the NEW device: answer with a nonce ---------- */

export function answerCommitment(
  request: PairingRequest, message: Commitment, now: number,
): { readonly request: PairingRequest; readonly nonce: string } {
  alive(request, now);
  if (request.commitment) {
    throw new PairingError(
      'out-of-order',
      'this pairing has already had an answer. Start a new one rather than '
      + 'letting a second device join a conversation already in progress.');
  }
  if (!message?.commitment) {
    throw new PairingError('not-an-offer', 'that is not a commitment.');
  }
  /*
   * FRESH RANDOMNESS, AND ITS UNPREDICTABILITY IS THE WHOLE DEFENCE. A constant
   * here — or a short one — hands the other side back the grind this file was
   * written about, and no test that only checks "the digits move when the nonce
   * moves" would notice. `pairing.test.ts` asks whether it is a surprise.
   */
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(SAS_NONCE_BYTES)));
  return {
    request: Object.freeze({ ...request, commitment: message.commitment, nonce }),
    nonce,
  };
}

/* ---------- step 4, on the OLD device: reveal and show the number ---------- */

export function revealAndShow(pending: PendingOffer, nonce: string, now: number): Reveal {
  if (now >= pending.expiresAt) {
    throw new PairingError('expired', 'this pairing has expired. Start it again.');
  }
  if (!nonce || fromBase64Url(nonce).length < SAS_NONCE_BYTES) {
    throw new PairingError(
      'not-an-offer',
      `the other device answered with ${nonce ? 'too little' : 'nothing'} to fix the `
      + 'number by. Start again.');
  }
  /*
   * ONE ANSWER, EVER, AND IT IS SPENT IN PLACE. A second reveal with a
   * different nonce is the whole attack: it lets the other side keep asking
   * until the number on this screen matches one it has arranged elsewhere.
   */
  pending.answerOnce(nonce);
  return Object.freeze({
    ephemeralPublic: toBase64Url(pending.ephemeralPublic),
    digits: digitsFor(pending.ephemeralPublic, pending.theirPublicKey, nonce),
  });
}

/* ---------- step 5, on the NEW device: check, then show the same number ---------- */

/**
 * What the new device puts on its screen.
 *
 * It verifies the commitment first: the old device is only allowed the
 * ephemeral key it named before the nonce existed, which is what makes the two
 * digits unguessable rather than merely unlikely.
 */
export function checkAndShow(
  request: PairingRequest, revealedKey: string, now: number,
): string {
  alive(request, now);
  if (!request.commitment || !request.nonce) {
    throw new PairingError(
      'out-of-order', 'nothing has been committed to yet, so there is nothing to reveal.');
  }

  const ephemeralPublic = readKey(revealedKey, 'the revealed key');
  const recomputed = toBase64Url(sha256(
    joined(`midnight-identity/pairing-commit/v${VERSION}/`, ephemeralPublic)));
  if (recomputed !== request.commitment) {
    throw new PairingError(
      'commitment-broken',
      'the other device revealed a different key from the one it committed to. '
      + 'Stop: that is what somebody sitting in the middle has to do.');
  }

  const ours = x25519.getPublicKey(request.secretKey);
  return digitsFor(ephemeralPublic, ours, request.nonce);
}

/* ---------- step 6, on the OLD device: only now, after the person confirms ---------- */

/**
 * Seal the secret.
 *
 * **Called after the person has compared the numbers, never before.** The
 * earlier version sealed at step two, so by the time somebody could say stop,
 * the secret had already been produced in a form the other side could open.
 * The digits need only the public keys and the nonce, so nothing is lost by
 * waiting.
 */
export function sealKeys(pending: PendingOffer, secret: Secret, now: number): SealedKeys {
  if (now >= pending.expiresAt) {
    throw new PairingError('expired', 'this pairing has expired. Start it again.');
  }
  /*
   * NOTHING IS SEALED BEFORE A NUMBER HAS BEEN SHOWN. Without this the ordering
   * is a convention rather than a rule, and `sealKeys` succeeds the instant the
   * code is scanned — which is that second half arriving again through the
   * back door.
   */
  if (pending.answeredNonce === null) {
    throw new PairingError(
      'out-of-order',
      'no number has been shown for this pairing yet, so nobody can have confirmed '
      + 'it. Reveal first.');
  }
  if (secret?.length !== SECRET_BYTES) {
    throw new PairingError(
      'secret-wrong-length',
      `a secret is ${SECRET_BYTES} bytes; got ${secret?.length ?? 'nothing'}.`);
  }
  const shared = x25519.getSharedSecret(pending.ephemeralSecret, pending.theirPublicKey);
  const key = hkdf(
    sha256, shared, undefined, info(pending.ephemeralPublic, pending.theirPublicKey), 32);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const body = xchacha20poly1305(key, nonce).encrypt(secret);

  const sealed = new Uint8Array(1 + NONCE_BYTES + body.length);
  sealed[0] = VERSION;
  sealed.set(nonce, 1);
  sealed.set(body, 1 + NONCE_BYTES);
  return Object.freeze({ sealed: toBase64Url(sealed) });
}

/* ---------- step 7, on the NEW device: open it ---------- */

export function acceptKeys(
  request: PairingRequest, revealedKey: string, keys: SealedKeys,
  confirmedDigits: string, now: number,
): { readonly secret: Secret; readonly request: PairingRequest } {
  /*
   * `confirmedDigits` is what the person read off the OTHER screen and agreed
   * to. It is the only place a number crosses between the two devices, and it
   * crosses through a human — which is the whole design.
   */
  const digits = checkAndShow(request, revealedKey, now);
  if (digits !== (confirmedDigits ?? '').trim()) {
    throw new PairingError(
      'digits-do-not-match',
      `this device is showing ${digits}. Stop unless the other one shows the same.`);
  }

  const sealed = readBytes(keys?.sealed, 'the sealed keys');
  if (sealed.length <= 1 + NONCE_BYTES || sealed[0] !== VERSION) {
    throw new PairingError('not-an-offer', 'that is not something this library sealed.');
  }

  const ephemeralPublic = readKey(revealedKey, 'the revealed key');
  const ours = x25519.getPublicKey(request.secretKey);
  const shared = x25519.getSharedSecret(request.secretKey, ephemeralPublic);
  const key = hkdf(sha256, shared, undefined, info(ephemeralPublic, ours), 32);

  let secret: Uint8Array;
  try {
    secret = xchacha20poly1305(key, sealed.slice(1, 1 + NONCE_BYTES))
      .decrypt(sealed.slice(1 + NONCE_BYTES));
  } catch {
    throw new PairingError(
      'will-not-open',
      'this will not open on this device. It was sealed for a different code, or it '
      + 'has been altered on the way.');
  }
  if (secret.length !== SECRET_BYTES) {
    throw new PairingError(
      'will-not-open',
      `this carried ${secret.length} bytes rather than ${SECRET_BYTES}.`);
  }
  return { secret, request: Object.freeze({ ...request, used: true }) };
}

/**
 * THE NUMBER BOTH SCREENS SHOW.
 *
 * Two digits from a hash of both public keys **and the nonce the new device
 * chose after the old one had committed**. That last part is what stops it
 * being ground: whoever wants a particular number has to choose their key
 * before the nonce exists.
 *
 * Two digits is then a genuine one-in-a-hundred for somebody in the middle, and
 * that is a deliberate trade — the attack needs them present at that exact
 * moment, the person is looking at both screens, and a longer number is one
 * people stop reading. §1 calls it "match a two-digit number".
 */
export function digitsFor(a: Uint8Array, b: Uint8Array, nonce: string): string {
  const label = new TextEncoder().encode(`midnight-identity/pairing-digits/v${VERSION}/`);
  const salt = fromBase64Url(nonce);
  const material = new Uint8Array(label.length + a.length + b.length + salt.length);
  material.set(label, 0);
  material.set(a, label.length);
  material.set(b, label.length + a.length);
  material.set(salt, label.length + a.length + b.length);
  const digest = sha256(material);
  return String((((digest[0] as number) << 8) | (digest[1] as number)) % 100).padStart(2, '0');
}

/* ---------- plumbing ---------- */

function alive(request: PairingRequest, now: number): void {
  if (request.used) {
    throw new PairingError(
      'already-used',
      'this pairing has already handed over the keys once. Start another one — '
      + 'a code that works twice is a code worth stealing.');
  }
  if (now >= request.expiresAt) {
    throw new PairingError('expired', 'this pairing has expired. Start it again.');
  }
}

function readBytes(value: string | undefined, what: string): Uint8Array {
  try {
    return fromBase64Url((value ?? '').trim());
  } catch (e) {
    throw new PairingError('not-an-offer', `${what} is not readable: ${(e as Error).message}`);
  }
}

function readKey(value: string | undefined, what: string): Uint8Array {
  const bytes = readBytes(value, what);
  if (bytes.length !== KEY_BYTES) {
    throw new PairingError('not-an-offer', `${what} is ${bytes.length} bytes, not ${KEY_BYTES}.`);
  }
  return bytes;
}

function joined(label: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const head = new TextEncoder().encode(label);
  const total = parts.reduce((n, p) => n + p.length, head.length);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let at = head.length;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const info = (ephemeralPublic: Uint8Array, devicePublic: Uint8Array): Uint8Array =>
  joined(`midnight-identity/pairing/v${VERSION}/`, ephemeralPublic, devicePublic);

function encodeCode(code: Code): string {
  const out = new Uint8Array(1 + KEY_BYTES + 8);
  out[0] = VERSION;
  out.set(code.publicKey, 1);
  new DataView(out.buffer).setBigUint64(1 + KEY_BYTES, BigInt(code.expiresAt), false);
  return toBase64Url(out);
}

function decodeCode(code: string): Code {
  const bytes = readBytes(code, 'that pairing code');
  if (bytes.length !== 1 + KEY_BYTES + 8) {
    throw new PairingError(
      'not-an-offer',
      `a pairing code is ${1 + KEY_BYTES + 8} bytes; that one is ${bytes.length}.`);
  }
  if (bytes[0] !== VERSION) {
    throw new PairingError(
      'not-an-offer',
      `that code is format ${bytes[0]} and this device reads format ${VERSION}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    publicKey: bytes.slice(1, 1 + KEY_BYTES),
    expiresAt: Number(view.getBigUint64(1 + KEY_BYTES, false)),
  };
}

/** Exported for the tests that prove neither side can choose the digits. */
export const publicKeyOf = (secretKey: Uint8Array): Uint8Array => x25519.getPublicKey(secretKey);
export { sameBytes };
