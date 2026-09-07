import type { SealedKeys } from '../devices/pairing.js';
import type { SealedProfile } from './seal.js';

/**
 * **THE PROFILE TRAVELS WITH PAIRING, SEALED.**
 * Decision 2.
 *
 * ── WHY THIS FILE EXISTS AND `packages/identity/src/devices/pairing.ts` IS UNTOUCHED ────────
 * `sealKeys` seals EXACTLY the 32-byte account secret and `acceptKeys` refuses
 * anything that opens to a different length — `pairing.ts:374-407`, and that
 * refusal is load-bearing. `pairing.ts` is in the frozen set. So the
 * profile does not go INSIDE the pairing envelope; it rides BESIDE it, and this
 * module is the whole of that arrangement: two strings and a separator.
 *
 * ── WHY IT NEEDS NO ENVELOPE OF ITS OWN, WHICH IS THE POINT OF §4 ─────────
 * **The profile blob is ALREADY ciphertext, under a key derived from the
 * account secret** (`Purposes.Profile`, `seal.ts`). It is not sealed to the new
 * device because it does not have to be: the key is a pure function of the
 * secret, and the secret is what the pairing envelope carries. So the new
 * device opens the keys, derives the same profile key, and the blob opens.
 * **Nothing is re-encrypted, nothing is re-keyed, and no key is transported.**
 *
 * That is exactly §4's argument arriving early: with a purpose-derived key,
 * moving a profile is a transport decision and never a migration. The same
 * property is what makes sync later a storage backend.
 *
 * ── WHAT THIS COSTS, AND IT IS A REAL COST ───────────────────────────────
 * **The blob's confidentiality in transit rests on the account key alone.**
 * Somebody who photographs the pairing code holds ciphertext they cannot open —
 * they cannot open the keys half either, because its X25519 secret never left
 * the new device — but the two halves are NOT equally protected: the keys half
 * would survive a later compromise of the account secret and the profile half
 * would not. Sealing the profile to the pairing channel as well would close
 * that, and it would mean re-deriving the pairing shared secret outside
 * `pairing.ts` — a second implementation of a frozen protocol's crypto, which
 * is the thing this project refuses on principle. **Named in the entry rather
 * than decided quietly.**
 *
 * ── THE FORMAT, AND WHY IT HAS THREE CASES AND NOT TWO ───────────────────
 *   `<base64url>`                a bare sealed wallet — what `pairing.ts`
 *                                itself produces, and still accepted
 *   `mi1.<keys>.<profile>`       a sealed wallet AND a sealed profile
 *   `mi1.<keys>.`                a sealed wallet, and **the sender had no
 *                                profile to send**
 *
 * The last two are different facts and get different spellings — that is the
 * row about one `null` standing for two states. *There is nothing to carry* and
 * *this came from a build that could not carry one* are things a screen would
 * say differently, so they are not one value.
 */

const PREFIX = 'mi1';
const BASE64URL = /^[A-Za-z0-9_-]*$/u;

export type Carried =
  | { readonly of: 'keys-only'; readonly keys: SealedKeys }
  | { readonly of: 'keys-and-profile'; readonly keys: SealedKeys; readonly profile: SealedProfile }
  | { readonly of: 'keys-and-no-profile'; readonly keys: SealedKeys };

export type TravelFailure = 'not-a-pairing-payload' | 'profile-unreadable';

export class TravelError extends Error {
  readonly code: TravelFailure;
  constructor(code: TravelFailure, message: string) {
    super(message);
    this.name = 'TravelError';
    this.code = code;
  }
}

const encode = (blob: SealedProfile): string =>
  btoa(JSON.stringify(blob)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

const decode = (text: string): SealedProfile => {
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  const parsed = JSON.parse(atob(padded)) as SealedProfile;
  if (typeof parsed !== 'object' || parsed === null
    || typeof parsed.iv !== 'string' || typeof parsed.sealed !== 'string') {
    throw new Error('not a sealed profile');
  }
  return parsed;
};

/** What the OLD device puts on the screen. */
export function pack(keys: SealedKeys, profile: SealedProfile | null): string {
  return `${PREFIX}.${keys.sealed}.${profile === null ? '' : encode(profile)}`;
}

/**
 * What the NEW device reads. Total: every refusal is a named code, and a
 * payload this cannot make sense of never becomes a half-understood one.
 */
export function unpack(text: string): Carried {
  const raw = (text ?? '').trim();
  if (raw === '') {
    throw new TravelError('not-a-pairing-payload', 'there is nothing here to read.');
  }
  if (!raw.startsWith(`${PREFIX}.`)) {
    /* A bare sealed wallet, exactly as `pairing.ts` produces it. */
    if (!BASE64URL.test(raw)) {
      throw new TravelError(
        'not-a-pairing-payload', 'that is not something this wallet sealed.');
    }
    return { of: 'keys-only', keys: Object.freeze({ sealed: raw }) };
  }
  const parts = raw.slice(PREFIX.length + 1);
  const at = parts.indexOf('.');
  if (at < 0) {
    throw new TravelError(
      'not-a-pairing-payload', 'that pairing payload is cut short.');
  }
  const keysText = parts.slice(0, at);
  const profileText = parts.slice(at + 1);
  if (keysText === '' || !BASE64URL.test(keysText)) {
    throw new TravelError('not-a-pairing-payload', 'that is not something this wallet sealed.');
  }
  const keys: SealedKeys = Object.freeze({ sealed: keysText });
  if (profileText === '') return { of: 'keys-and-no-profile', keys };
  if (!BASE64URL.test(profileText)) {
    throw new TravelError(
      'profile-unreadable',
      'the wallet in this pairing is readable and the details beside it are not. '
      + 'Nothing has been opened.');
  }
  let profile: SealedProfile;
  try {
    profile = decode(profileText);
  } catch {
    throw new TravelError(
      'profile-unreadable',
      'the wallet in this pairing is readable and the details beside it are not. '
      + 'Nothing has been opened.');
  }
  return { of: 'keys-and-profile', keys, profile };
}
