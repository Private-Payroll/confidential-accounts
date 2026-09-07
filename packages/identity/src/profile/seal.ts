import { Purposes } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';
import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';
import type { Profile } from './model.js';

/**
 * **NO PLAINTEXT AT REST, EVEN LOCALLY.**
 *
 * WHY ENCRYPT SOMETHING THAT NEVER LEAVES THIS BROWSER — and the reason is next
 * year rather than today:
 *
 *   - **The day there is somewhere durable to keep a blob, sync is a STORAGE
 *     BACKEND and not a rewrite.** We would be holding ciphertext under a key we
 *     never have. Plaintext now means re-encrypting live personal data in the
 *     field later, and it means the version of us that adds sync becomes a data
 *     controller by accident.
 *   - **It carries the profile through pairing for free** (`travel.ts`): the
 *     blob is already sealed, so the pairing channel moves ciphertext and the
 *     key simply exists on the far side, because it is derived from the secret
 *     that just crossed. Nothing in `packages/identity/src/devices/pairing.ts` changes.
 *   - **It upgrades recovery for free.** Anyone who rebuilds the secret can
 *     decrypt the blob, so decision 4 — *recovery does not restore the
 *     profile* — can be revisited later without touching the format.
 *
 * WHAT IT DOES NOT BUY, said plainly for the same reason `storage.ts` says it:
 * a script on this page can USE the key while the page is open, because the
 * key is derived from a secret the page holds. This stops a copied blob being
 * opened elsewhere. It does not stop an XSS on this origin. The passkey gates
 * the interface; this gates the bytes; **they are not connected.**
 */

/** One profile per account — decision 1 — so one key at one index. */
const PROFILE_INDEX = 0;

/**
 * Bound into every seal as additional data. Changing this string makes every
 * blob in existence unopenable, which is why it carries a version rather than
 * being edited.
 */
const ENVELOPE = 'midnight-identity/profile-seal/v1';
const VERSION = 1;
const IV_BYTES = 12;

export type SealFailure = 'will-not-open' | 'not-a-sealed-profile';

export class SealError extends Error {
  readonly code: SealFailure;
  constructor(code: SealFailure, message: string) {
    super(message);
    this.name = 'SealError';
    this.code = code;
  }
}

/** What a stored blob looks like. Base64url so it survives `localStorage`. */
export interface SealedProfile {
  readonly v: number;
  readonly iv: string;
  readonly sealed: string;
}

/**
 * THE KEY. `Purposes.Profile`, index 0, imported NON-EXTRACTABLE.
 *
 * Non-extractable is not the same protection `storage.ts` gets from a
 * WebCrypto-generated key — the raw bytes exist in memory before this call,
 * because they are derived rather than generated. It still means the imported
 * handle cannot be exported, and it costs nothing. The real protection is that
 * the bytes are a pure function of the account secret and are never stored.
 */
export async function profileKey(identity: Identity): Promise<CryptoKey> {
  const raw = identity.authority(Purposes.Profile, PROFILE_INDEX);
  return crypto.subtle.importKey(
    'raw', raw as BufferSource, 'AES-GCM', /* extractable: */ false,
    ['encrypt', 'decrypt']);
}

const aad = (): BufferSource => new TextEncoder().encode(ENVELOPE) as BufferSource;

export async function seal(key: CryptoKey, profile: Profile): Promise<SealedProfile> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new TextEncoder().encode(JSON.stringify(profile));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad() }, key, body));
  return Object.freeze({ v: VERSION, iv: toBase64Url(iv), sealed: toBase64Url(sealed) });
}

/**
 * WHAT AN OPEN CAN SAY, AND WHY THERE ARE THREE ANSWERS RATHER THAN TWO.
 *
 * The rule is that a read must not destroy: a store that returned EMPTY for
 * a blob it could not open would let the next save overwrite a person's whole
 * profile with nothing, in silence. So *there is nothing here* and *there is
 * something here and it will not open* are different values, and the writer
 * refuses to write over the second one unless it is told to.
 *
 * A blob belonging to ANOTHER account is `unopenable` rather than a fourth
 * state, and deliberately: the key is the only discriminator, nothing about the
 * account is stored in the clear, and both states mean the same thing to a
 * person — *something is here and this account cannot read it.*
 */
export type Opened =
  | { readonly of: 'none' }
  | { readonly of: 'profile'; readonly profile: Profile }
  | { readonly of: 'unopenable'; readonly why: string };

const looksLikeAProfile = (parsed: unknown): parsed is Profile => (
  typeof parsed === 'object' && parsed !== null
  && (parsed as Profile).schema === 'midnight-identity/profile/v1'
  && Array.isArray((parsed as Profile).held)
  && Array.isArray((parsed as Profile).grants));

export async function open(key: CryptoKey, blob: SealedProfile): Promise<Opened> {
  if (typeof blob?.iv !== 'string' || typeof blob?.sealed !== 'string' || blob?.v !== VERSION) {
    return {
      of: 'unopenable',
      why: 'something is stored here that this wallet did not seal, or sealed under a '
        + 'different version.',
    };
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(blob.iv) as BufferSource, additionalData: aad() },
      key, fromBase64Url(blob.sealed) as BufferSource);
  } catch {
    return {
      of: 'unopenable',
      why: 'the details stored here will not open with this account\'s key. They belong to '
        + 'another account, or they have been altered.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return { of: 'unopenable', why: 'the details stored here opened but are not readable.' };
  }
  if (!looksLikeAProfile(parsed)) {
    return { of: 'unopenable', why: 'the details stored here are not a profile this wallet knows.' };
  }
  return { of: 'profile', profile: parsed };
}
