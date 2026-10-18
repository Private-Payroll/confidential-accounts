/**
 * **THE COMPANY KEY AFTER A SIGNER LEAVES: HOW A NEW KEY IS CHECKED, HANDED TO
 * EACH STAYING SEAT AND CHAINED BACK TO EVERY OLDER ONE.**
 *
 * A change of the company's key is filed in its seat directory. It names the
 * new key only by a check (`keyCheckOf`), wraps the key to each staying seat's
 * records key as the directory holds it, and carries the key it replaces and
 * the company's new payout seed sealed under keys made from the new one, so the
 * new key opens every older key and nothing opens a later one. Everything here
 * is pure and runs on a device; the service sees only what this makes, which it
 * cannot open.
 */
import { canonical, commit, seal, unseal, unwrapKey, wrapKey, type Hex, type Sealed } from './crypto.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX24 = /^[0-9a-f]{24}$/u;
const HEX = /^(?:[0-9a-f]{2})*$/u;

const KEY_CHECK_DOMAIN = 'confidential-accounts/company-key-check/v1';
const PREVIOUS_DOMAIN = 'confidential-accounts/company-key-previous/v1';
const SEED_DOMAIN = 'confidential-accounts/company-key-seed/v1';

/** A key wrapped to one seat's records key: whoever holds that key's secret opens it, and nobody else. */
export type WrappedCompanyKey = { readonly ephemeral: Hex } & Sealed;

/** One staying seat's copy of the new key. */
export interface SeatWrap { readonly seat: string; readonly wrap: WrappedCompanyKey }

const keyRefusal = (key: unknown, what: string): Hex => {
  if (typeof key !== 'string' || !HEX64.test(key.toLowerCase())) {
    throw new Error(`${what} is a 32-byte key, and this is not one. Nothing was made.`);
  }
  return key.toLowerCase() as Hex;
};

/**
 * **WHAT NAMES A COMPANY KEY IN THE DIRECTORY WITHOUT SHOWING IT**: a hash
 * over this company, the key's epoch and the key, under its own domain, so a
 * check for one company or epoch never matches another's, and a device that
 * opens its copy can tell whether it holds the key everybody else was given.
 */
export const keyCheckOf = (company: string, epoch: number, key: Hex): Hex => {
  if (typeof company !== 'string' || company.length === 0) throw new Error('a key check names its company, and none was given. Nothing was made.');
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('a key check names the epoch of its key, a whole number from 0, and this is not one. Nothing was made.');
  return commit(canonical({ company, epoch, key: keyRefusal(key, 'a company key') }), KEY_CHECK_DOMAIN);
};

/**
 * **THE NEW KEY WRAPPED TO EACH STAYING SEAT**, to the records key the seat's
 * directory entry names (`wrappingKey`), which that seat's own wallet works out
 * again from its recovery words: a copy opens on any device of that seat, and
 * never with the wrapping key a person's saved keys hold.
 */
export const wrapsFor = (
  key: Hex, seats: readonly { readonly seat: string; readonly wrappingKey: Hex }[],
): readonly SeatWrap[] => {
  const k = keyRefusal(key, 'the key wrapped to each seat');
  return seats.map((s) => ({ seat: s.seat, wrap: wrapKey(k, keyRefusal(s.wrappingKey, 'a seat\'s records key')) }));
};

/**
 * **ONE SEAT'S COPY OF THE KEY, OPENED** with the secret of its records key
 * (`recordsKeypairFrom` over the key the seat's wallet releases), or null when
 * it does not open with that secret or does not hold a key. Whether the key
 * opened is the one the directory names is the caller's check, by `keyCheckOf`.
 */
export const openedWrap = (wrap: WrappedCompanyKey, recordsSecret: Hex): Hex | null => {
  try {
    const key = unwrapKey(wrap, recordsSecret).toLowerCase();
    return HEX64.test(key) ? key as Hex : null;
  } catch {
    return null;
  }
};

/* Each sealing under the new key uses a key of its own made from it, so a key sealed as one thing is never opened as the other. */
const sealingKeyOf = (key: Hex, domain: string): Hex => commit(keyRefusal(key, 'the key a value is sealed under'), domain);

const opened = (sealed: Sealed, key: Hex, domain: string): Hex | null => {
  try {
    const value = unseal(sealed, sealingKeyOf(key, domain)).toLowerCase();
    return HEX64.test(value) ? value as Hex : null;
  } catch {
    return null;
  }
};

/** **THE KEY BEING REPLACED, SEALED UNDER THE NEW ONE**: whoever holds the new key opens the old, and never the other way round. */
export const sealedPrevious = (newKey: Hex, previousKey: Hex): Sealed =>
  seal(keyRefusal(previousKey, 'the key being replaced'), sealingKeyOf(newKey, PREVIOUS_DOMAIN));

/** The key a change of key replaced, opened with the new key, or null when it does not open with it. */
export const openedPrevious = (newKey: Hex, sealed: Sealed): Hex | null => opened(sealed, newKey, PREVIOUS_DOMAIN);

/** **THE COMPANY'S NEW PAYOUT SEED, SEALED UNDER THE NEW KEY**, which only the seats that hold it open. */
export const sealedSeed = (newKey: Hex, seed: Hex): Sealed =>
  seal(keyRefusal(seed, 'a payout seed'), sealingKeyOf(newKey, SEED_DOMAIN));

/** The payout seed a change of key carries, opened with the new key, or null when it does not open with it. */
export const openedSeed = (newKey: Hex, sealed: Sealed): Hex | null => opened(sealed, newKey, SEED_DOMAIN);

/* A 32-byte seed is sealed as its 64 hex characters, and the seal adds its 16-byte tag to the body. */
const SEALED_SEED_BODY_HEX = (64 + 16) * 2;

/**
 * **WHETHER A SEALED SEED HAS THE SHAPE OF ONE 32-BYTE SEED**, judged without
 * opening it: what a directory can check of a seed before any key is held.
 */
export const sealedSeedShaped = (sealed: unknown): boolean => {
  const s = sealed as Partial<Sealed> | null;
  return typeof s === 'object' && s !== null && Object.keys(s).sort().join(',') === 'body,iv,tag'
    && typeof s.iv === 'string' && HEX24.test(s.iv) && s.tag === ''
    && typeof s.body === 'string' && HEX.test(s.body) && s.body.length === SEALED_SEED_BODY_HEX;
};

/**
 * **THE COMPANY'S KEYS AS ONE DEVICE HOLDS THEM**: the key in force and its
 * epoch, the newest epoch the directory names, the key at every older epoch
 * this seat can reach, the payout seeds the changes of the key carried, and
 * the key a new record is sealed under (`sealing`), which refuses while
 * sealing is paused. Made by `companyKeyHere` from the company's directory.
 */
export interface CompanyKeys {
  readonly epoch: number;
  readonly key: Hex;
  readonly newest: number;
  readonly keyAt: (epoch: number) => Hex;
  readonly sealing: () => { readonly key: Hex; readonly epoch: number };
  readonly seeds?: readonly { readonly epoch: number; readonly seed: string }[];
  /**
   * The answers each believed change of the key found waiting, by the epoch of the key whose inbox they were sealed
   * to: an answer sealed to an older inbox is believed only when its digest is here (`answerOpenedWith`).
   */
  readonly answered?: ReadonlyMap<number, ReadonlySet<string>>;
}

/**
 * What a reader or sealer is given: the company's keys, or one bare key.
 * A bare key is the one key its holder has, used for every record whatever
 * its epoch, as for a company whose key has never changed; a page always
 * passes the keys its directory gives (`companyKeyHere`).
 */
export type KeysHeld = CompanyKeys | Hex | string;

const isBare = (keys: KeysHeld): keys is Hex | string => typeof keys === 'string';

/** The key a record sealed at `epoch` opens under. */
export const keyOf = (keys: KeysHeld, epoch: number | undefined): Hex =>
  (isBare(keys) ? keys as Hex : keys.keyAt(typeof epoch === 'number' ? epoch : 0));

/** The key in force now: what opens an answer sealed to the company's inbox as it stands. */
export const keyInForce = (keys: KeysHeld): Hex => (isBare(keys) ? keys as Hex : keys.key);

/**
 * The key and epoch a new record is sealed under. A bare key seals at the
 * epoch its caller names; the company's keys seal at the epoch in force and
 * refuse while sealing is paused.
 */
export const sealingWith = (keys: KeysHeld, epoch: number): { readonly key: Hex; readonly epoch: number } =>
  (isBare(keys) ? { key: keys as Hex, epoch } : keys.sealing());

/** Every key held, newest first: what is tried on a record that does not name its epoch. */
export const keysHeld = (keys: KeysHeld): readonly Hex[] => {
  if (isBare(keys)) return [keys as Hex];
  const out: Hex[] = [];
  for (let e = keys.epoch; e >= 0; e -= 1) {
    try { out.push(keys.keyAt(e)); } catch { /* an epoch this seat cannot reach opens nothing here */ }
  }
  return out;
};

/** The payout seeds the changes of the key carried, none for a bare key. */
export const rotationSeedsOf = (keys: KeysHeld): readonly { readonly epoch: number; readonly seed: string }[] =>
  (isBare(keys) ? [] : keys.seeds ?? []);

/** `open` tried with every key held, newest first; the first that opens is the answer. */
export const openedWithAnyKey = <T>(keys: KeysHeld, open: (key: Hex) => T): T => {
  let last: unknown = new Error('this device holds no key of the company.');
  for (const k of keysHeld(keys)) {
    try { return open(k); } catch (e) { last = e; }
  }
  throw last;
};

/**
 * The epoch a record names when nothing in it is sealed under the company's
 * key (a spending policy's version, sealed to each reader's own key): the
 * epoch in force, or the one a bare key's caller names. Never paused, since
 * nothing a removed signer holds seals it.
 */
export const epochInForce = (keys: KeysHeld, epoch: number): number => (isBare(keys) ? epoch : keys.epoch);
