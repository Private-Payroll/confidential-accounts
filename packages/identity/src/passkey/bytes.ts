/**
 * Base64url, and nothing else. WebAuthn speaks it everywhere — credential ids,
 * challenges, the `challenge` field inside `clientDataJSON` — and it is base64
 * with two characters swapped and the padding removed.
 *
 * Written out rather than pulled in because it is fifteen lines and because a
 * decoder that silently accepts ordinary base64 would let a challenge compare
 * equal to one it is not. This one does not: `+` and `/` are not in the
 * alphabet, and anything outside it is a refusal.
 */

const ALPHABET = /^[A-Za-z0-9_-]*$/u;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function fromBase64Url(value: string): Uint8Array {
  if (!ALPHABET.test(value)) {
    throw new Error('not base64url: it may only contain A-Z a-z 0-9 - and _');
  }
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Constant-time-ish equality for two byte strings.
 *
 * Nothing compared here is a secret today — a challenge and an rpId hash are
 * both public — so the constant time is not load-bearing. It is here so that
 * the day something secret IS compared, the habit is already in place rather
 * than being remembered.
 *
 * The CORRECTNESS is load-bearing: this is what compares the rpId hash, and a
 * version that only looked at the last byte passed the whole suite by luck of
 * which two domains the fixtures happened to use. It has its own test now.
 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
