/**
 * The four part keys of a sealed copy, worked out the way the contracts work them out: one SHA-256 over the copy's
 * own tag and inputs, read as a field element (its first thirty-one bytes), plus the part, kept to thirty-one bytes.
 * Tests use it to pin that the exported key is that hash plus the part.
 */
import { createHash } from 'node:crypto';
import { degradeToTransient, upgradeFromTransient } from '@midnight-ntwrk/compact-runtime';

/** A text tag as the contracts pad it: its bytes, then zeros, to thirty-two. */
const tagOf = (text: string): Uint8Array => {
  const tag = new Uint8Array(32);
  tag.set(new TextEncoder().encode(text));
  return tag;
};

/** A number as `as Field as Bytes<32>` writes it: thirty-two bytes, least significant first. */
const fieldBytesOf = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0, v = n; i < 32; i += 1, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
};

const sha256Of = (...parts: Uint8Array[]): Uint8Array =>
  new Uint8Array(createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest());

/** The hash a signer's four pay-record key parts share (`payKeyWrapBaseOf`). */
export const wrapBaseOf = (account: Uint8Array, sk: Uint8Array): Uint8Array =>
  sha256Of(tagOf('midnight-accounts:roles:wrap:'), account, sk);

/** The hash a sealed copy's four parts share (`copyBaseOf`). */
export const copyBaseOf = (commitment: Uint8Array, reader: Uint8Array, place: bigint): Uint8Array =>
  sha256Of(tagOf('midnight-vault:secret-copy:'), commitment, reader, fieldBytesOf(place));

/** One part's key from the shared hash: the hash as a field element, plus the part, as the runtime writes it back. */
export const partKeyOf = (base: Uint8Array, part: bigint): Uint8Array =>
  upgradeFromTransient(degradeToTransient(base) + part);
