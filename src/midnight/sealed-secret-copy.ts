/**
 * **ONE SIGNER'S COPY OF A VAULT'S NONCE SECRET, SEALED TO THE KEY THEIR OWN
 * RECOVERY WORDS DERIVE, IN EXACTLY THE FOUR THIRTY-TWO-BYTE PARTS THE VAULT
 * KEEPS ON THE CHAIN.**
 *
 * A vault takes no money until every signer's sealed copy of its current secret
 * is written into it (`writeSecretCopy`). Each copy is the secret sealed to the
 * public half of that signer's records key (`recordsKeypairFrom`), which is a
 * pure function of their recovery words and the company's label. So a signer
 * holding nothing but their words, with every device and this product's server
 * gone, reads their copy off the chain and opens it here.
 *
 * **THE FORM, AND WHY IT FITS.** The vault holds 128 bytes per copy. A copy is
 * the same construction a wrapped key uses here (`wrapKey`: an x25519 agreement
 * with an ephemeral key, the shared secret hashed into a key, AES-GCM), written
 * as bytes rather than as hex text:
 *
 *   byte 0        the form's version, 1
 *   bytes 1-32    the ephemeral public key
 *   bytes 33-44   the twelve-byte nonce
 *   bytes 45-92   the secret encrypted, with its sixteen-byte tag
 *   bytes 93-127  zero
 *
 * Ninety-three bytes, padded with zeros to 128 and cut into four parts. A copy
 * whose padding is not zero, or whose version is not this one, does not open.
 *
 * **SEALED THE SAME WAY EVERY TIME.** The ephemeral key and the nonce are
 * derived from the secret, the vault and the reader, so sealing the same secret
 * to the same reader for the same vault gives the same four parts. That is what
 * lets a vault's start be run again after a device stopped half way: the tree of
 * copies the signers approved is rebuilt from the filed secret exactly as it was
 * approved, and each copy still to be written is written as approved. Anybody
 * who can derive the ephemeral key already holds the secret, so nothing is given
 * away by making it this way, and the nonce is never used twice with one key,
 * because the key is the reader's agreement with an ephemeral key no other copy
 * uses.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { fromHex, toHex, utf8, type Hex, type WrappingKeypair } from '../core/crypto.js';

/** How many parts a copy is written in, and how wide each one is: what `writeSecretCopy` takes. */
export const SEALED_COPY_PARTS = 4;
export const SEALED_COPY_PART_BYTES = 32;
/** Everything a copy may take, padding included. */
export const SEALED_COPY_BYTES = SEALED_COPY_PARTS * SEALED_COPY_PART_BYTES;

const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SEALED_SECRET_BYTES = KEY_BYTES + 16;
/** What a copy uses before its padding. */
export const SEALED_COPY_USED_BYTES = 1 + KEY_BYTES + NONCE_BYTES + SEALED_SECRET_BYTES;

const HEX32 = /^[0-9a-f]{64}$/u;
const EPHEMERAL = utf8('confidential-accounts/vault-secret-copy/ephemeral/v1');
const NONCE = utf8('confidential-accounts/vault-secret-copy/nonce/v1');
const KEK = utf8('confidential-accounts/vault-secret-copy/key/v1');

/** Thrown for a copy that does not open with this reader's key. Nothing is read from it. */
export class SecretCopyUnreadable extends Error {
  constructor(why: string) {
    super(`this sealed copy of the vault's secret could not be opened: ${why}. Nothing was read from it.`);
    this.name = 'SecretCopyUnreadable';
  }
}

const bytes32 = (name: string, value: string): Uint8Array => {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new Error(`a sealed copy names its ${name} as 64 lower-case hex characters, and this is not one. Nothing was sealed.`);
  }
  return fromHex(value);
};

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const keyFor = (shared: Uint8Array, ephemeral: Uint8Array, reader: Uint8Array, vault: Uint8Array): Uint8Array =>
  hkdf(sha256, shared, KEK, join(ephemeral, reader, vault), KEY_BYTES);

/**
 * **THE SECRET SEALED TO ONE READER, AS FOUR PARTS.** `reader` is the public half
 * of the signer's records key; `vault` is the vault the secret belongs to, which
 * the copy is bound to.
 */
export function sealSecretCopy(input: { readonly vault: Hex; readonly secret: Hex; readonly reader: Hex }): Uint8Array[] {
  const vault = bytes32('vault', input.vault);
  const secret = bytes32('secret', input.secret);
  const reader = bytes32('reader key', input.reader);
  if (secret.every((b) => b === 0)) throw new Error('a secret of zeros is no secret. Nothing was sealed.');
  const ephemeralSecret = hkdf(sha256, secret, EPHEMERAL, join(vault, reader), KEY_BYTES);
  const ephemeral = x25519.getPublicKey(ephemeralSecret);
  const nonce = hkdf(sha256, secret, NONCE, join(vault, reader), NONCE_BYTES);
  const kek = keyFor(x25519.getSharedSecret(ephemeralSecret, reader), ephemeral, reader, vault);
  const sealed = gcm(kek, nonce, vault).encrypt(secret);
  ephemeralSecret.fill(0);
  kek.fill(0);
  const whole = new Uint8Array(SEALED_COPY_BYTES);
  whole.set(join(Uint8Array.of(VERSION), ephemeral, nonce, sealed), 0);
  return Array.from({ length: SEALED_COPY_PARTS }, (_, i) =>
    whole.slice(i * SEALED_COPY_PART_BYTES, (i + 1) * SEALED_COPY_PART_BYTES));
}

/**
 * **OPENS ONE COPY WITH THE READER'S OWN RECORDS KEY.** Refuses parts of the
 * wrong shape, a form this does not know, padding that is not zero, a copy for
 * another vault and a copy sealed to anybody else.
 */
export function openSecretCopy(input: {
  readonly vault: Hex; readonly parts: readonly Uint8Array[]; readonly reader: WrappingKeypair;
}): Hex {
  const vault = bytes32('vault', input.vault);
  if (!Array.isArray(input.parts) || input.parts.length !== SEALED_COPY_PARTS
    || input.parts.some((p) => !(p instanceof Uint8Array) || p.length !== SEALED_COPY_PART_BYTES)) {
    throw new SecretCopyUnreadable(`it is not ${SEALED_COPY_PARTS} parts of ${SEALED_COPY_PART_BYTES} bytes`);
  }
  if (typeof input.reader?.secret !== 'string' || !HEX32.test(input.reader.secret)) {
    throw new SecretCopyUnreadable('the key it was opened with is not a records key');
  }
  const whole = join(...input.parts);
  if (whole[0] !== VERSION) throw new SecretCopyUnreadable('it is in a form this device does not know');
  if (whole.subarray(SEALED_COPY_USED_BYTES).some((b) => b !== 0)) {
    throw new SecretCopyUnreadable('its padding is not empty, so it is not a copy this product sealed');
  }
  const readerSecret = fromHex(input.reader.secret);
  const reader = x25519.getPublicKey(readerSecret);
  const ephemeral = whole.slice(1, 1 + KEY_BYTES);
  const nonce = whole.slice(1 + KEY_BYTES, 1 + KEY_BYTES + NONCE_BYTES);
  const sealed = whole.slice(1 + KEY_BYTES + NONCE_BYTES, SEALED_COPY_USED_BYTES);
  let secret: Uint8Array;
  try {
    const kek = keyFor(x25519.getSharedSecret(readerSecret, ephemeral), ephemeral, reader, vault);
    secret = gcm(kek, nonce, vault).decrypt(sealed);
  } catch {
    throw new SecretCopyUnreadable('it is not sealed to this reader\x27s key for this vault');
  }
  if (secret.length !== KEY_BYTES || secret.every((b) => b === 0)) throw new SecretCopyUnreadable('it does not hold a secret');
  return toHex(secret);
}

/** The vault's own key function for where one part of a copy sits (`copyKeyOf`). */
export type CopyKeyOf = (commitment: Uint8Array, reader: Uint8Array, place: bigint, part: bigint) => Uint8Array;

/**
 * **ONE READER'S COPY, READ OFF THE VAULT'S OWN LEDGER.** The vault keeps each
 * part under a key made from the secret's commitment, the reader's key, the
 * copy's place in the approved tree and the part, so a signer who knows only
 * their own records key and the commitment the chain shows looks at each place
 * the secret's tree has. `null` when no copy for this reader is on the chain.
 */
export function secretCopyOnTheChain(
  copies: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array },
  keyOf: CopyKeyOf,
  input: { readonly commitment: Hex; readonly reader: Hex; readonly count: bigint },
): Uint8Array[] | null {
  const commitment = bytes32('secret\x27s commitment', input.commitment);
  const reader = bytes32('reader key', input.reader);
  for (let place = 0n; place < input.count; place += 1n) {
    const first = keyOf(commitment, reader, place, 0n);
    if (!copies.member(first)) continue;
    return [0n, 1n, 2n, 3n].map((part) => copies.lookup(keyOf(commitment, reader, place, part)));
  }
  return null;
}
