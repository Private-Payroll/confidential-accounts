import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Purposes, type Identity } from 'midnight-identity';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { keyringKeyFor } from 'midnight-identity/profile/unlock';

/**
 * **THE KEY A PERSON'S SAVED KEYS ARE SEALED UNDER: ONE NO PAGE EVER HAD.**
 *
 * A page that kept a key it was given could open a person's saved keys, every seat's secrets with them, and seal an
 * older copy as the newest. So the saved keys are sealed under a key no page is given. It is derived from the same
 * parent as the keyring key (`keyringKeyFor`) - the seed's keyring authority, which never leaves this wallet - under
 * a salt of its own, so knowing the keyring key gives nothing of it. It is derived where the saved keys are opened,
 * held only by the opened keyring (`held-keyring.ts`) and wiped when it is let go; no answer, message or store
 * carries it.
 *
 * The site's identifier for the person is the only other ingredient, as it is for the old key: the origin gates and
 * the address the page signed in as gates, and neither is part of it (`unlock.ts`, the keyring key, says why).
 */
const SEAL_SALT = new TextEncoder().encode('midnight-identity/keyring-seal/v2');
const KEYRING_PARENT_INDEX = 0;
const KEY_BYTES = 32;
const PERSON = /^[A-Za-z0-9_-]{1,64}$/u;

/** The key the person's saved keys are sealed under now. Checks the asker and the person as the old key does. */
export function keyringSealKeyFor(identity: Identity, ask: Pick<KeyringRequest, 'requester' | 'person'>): Uint8Array {
  /* The old derivation checks the origin and the person's shape; its key is wiped at once and used for nothing. */
  keyringKeyFor(identity, ask).fill(0);
  if (!PERSON.test(ask.person)) throw new Error('the person is not named in a way this wallet can use.');
  return hkdf(sha256, keyringParentFor(identity), SEAL_SALT, new TextEncoder().encode(ask.person), KEY_BYTES);
}

/** The parent both keys come from: the seed's keyring authority. Read here so the wallet can refuse to send it. */
export const keyringParentFor = (identity: Identity): Uint8Array => identity.authority(Purposes.Keyring, KEYRING_PARENT_INDEX);

/**
 * **THE OLD KEY, FOR ONE THING ONLY**: opening a copy of the saved keys sealed before this key existed, and only the
 * one copy this device last opened that way, on a device whose mark does not say it has seen a copy under the new key
 * (`held-keyring.ts`). It seals nothing.
 */
export const keyringKeyBeforeTheSeal = (identity: Identity, ask: Pick<KeyringRequest, 'requester' | 'person'>): Uint8Array =>
  keyringKeyFor(identity, ask);
