import type { KeyringHandedIn, SealedKeyring } from 'midnight-identity/profile/unlock';
import type { Identity, Secret } from 'midnight-identity/keys/derivation';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { canonical, toHex, type Hex } from '../../../../src/core/crypto.js';
import {
  counterOf, KeyringDidNotOpen, metadataOf, openKeyring, sealedDigestOf, sealKeyring, type Keyring, type KeyringMetadata,
} from '../../../../packages/web-shared/src/keyring-blob.js';
import { keyringMarkOf, raiseKeyringMark, type KeyringMarkKept } from '../accounts/storage.js';
import { watchFor, watchTheSavedKeys } from './nothing-secret-crosses.js';
import { keyringKeyBeforeTheSeal, keyringParentFor, keyringSealKeyFor } from './seal-key.js';

/**
 * A PERSON'S SAVED KEYS, OPENED IN THIS WALLET FROM THE SEALED COPY A PAGE HANDED IT, changed here and sealed again
 * for the page to keep. The page fetches and stores the sealed copy; it never holds the key that opens it here, which
 * is a key no page was ever given (`seal-key.ts`).
 *
 * **A COPY SEALED UNDER THE OLD KEY**, the one pages were once given, opens here only while this device's mark does not
 * say it has a copy under the new key, and only when it is the copy the mark names (its count and hash): the copy this
 * device last opened or kept, so a page that kept the old key cannot seal a later copy of its own making and have it
 * taken as the newest. A device with no mark opens the first copy it is handed, as it always has. Every seal is under
 * the new key, so the first change, or the keyring answer that hands such a copy back re-sealed
 * (`read-for-the-page.ts`), moves the person's saved keys to it, every seat as it was, and the mark then says so
 * (`under: 2`): a copy under the old key is refused from then on.
 *
 * Every secret opened or made here - each seat's, the keys and their parent - is watched (`nothing-secret-crosses.ts`),
 * so a message carrying one is refused before it reaches the page.
 *
 * The service can hand the page an older copy, or another copy sealed at the same count, and the page can hand this
 * wallet either. So this wallet keeps, per person, the highest count of writes it has opened or seen kept and a hash of
 * the sealed copy it saw at that count (`keyring-marks` in its own storage), and refuses a copy whose sealed count is
 * lower, another copy at that count, and no copy at all once it has seen one. A wallet that has seen none for this
 * person, on a new device or after its storage was cleared, takes the first copy it opens as the newest.
 *
 * A change is applied to the saved keys held now and may add seats and keep, change or drop creations; it may never
 * drop or alter a seat already held, so no step can seal away the only copy of a seat's secrets.
 */

/** Why saved keys were refused: they did not open with this wallet's key for the person, or they are an older copy. */
export type SavedKeysRefusal = 'keys-did-not-open' | 'older-keys';

export class SavedKeysRefused extends Error {
  readonly why: SavedKeysRefusal;
  constructor(why: SavedKeysRefusal, says: string) {
    super(says);
    this.name = 'SavedKeysRefused';
    this.why = why;
  }
}

/** The highest count seen for a person and the hash of the sealed copy seen at it. */
export type KeyringMark = KeyringMarkKept;

/**
 * Where the mark for each person is kept: this wallet's own storage, or a stand-in a test hands in. `raise` keeps a
 * mark only when its count is higher than the one kept.
 */
export interface KeyringMarks {
  markOf(person: string): KeyringMark | null;
  raise(person: string, mark: KeyringMark): void;
}

/** The marks kept in this wallet's own storage for the wallet this secret opens. */
export const keyringMarksFor = (secret: Secret): KeyringMarks => ({
  markOf: (person) => keyringMarkOf(secret, person),
  raise: (person, mark) => raiseKeyringMark(secret, person, mark),
});

/** A change to saved keys that would drop or alter a seat already held. Nothing was sealed. */
export class SeatChangeRefused extends Error {
  constructor(says: string) {
    super(says);
    this.name = 'SeatChangeRefused';
  }
}

/**
 * Saved keys sealed again, for the page to write over `ifVersion`. `kept` is called once the page says the service
 * took them, with the version it now holds: only then does this wallet count them as the newest copy.
 */
export interface SealedAgain {
  readonly sealed: SealedKeyring;
  readonly ifVersion: number;
  readonly counter: number;
  kept(version: number): void;
  /** The page did not say they were kept: they are not counted, and saved keys may be sealed again from what is held. */
  notKept(): void;
}

export interface HeldKeyring {
  /** A copy of the saved keys as opened, or as last kept: a step that keeps or changes it changes nothing held here. */
  read(): Keyring;
  /** The parts of them that open nothing, for a page to list. */
  metadata(): KeyringMetadata;
  /**
   * Applies `change` to a copy of the saved keys held now and seals the result one write on, whatever count it
   * carries. Refuses, with `SeatChangeRefused`, a result that drops or alters any seat or seat sealed before its leaf
   * that is held now, and refuses once the keyring is let go.
   */
  seal(change: (current: Keyring) => Keyring): SealedAgain;
  /** Drops the key and the saved keys from this object; nothing more can be read or sealed with it. */
  letGo(): void;
  /** Whether the copy handed in was sealed under the old key, so the next seal moves it to the new one. */
  readonly underTheOldKey?: boolean;
}

export interface OpenedFrom {
  readonly identity: Identity;
  /** The page that asked, and the site's identifier for the person; the key is derived from these and the seed. */
  readonly ask: Pick<KeyringRequest, 'requester' | 'person'>;
  readonly handedIn: KeyringHandedIn;
  readonly marks: KeyringMarks;
}

/* What resolves an older copy, in both of the places it can be: the page, or the service itself. */
const WAY_OUT =
  ' Nothing was opened or changed. If the page read your saved keys before a newer copy was written, reloading the '
  + 'page reads them again and that is enough. If the page still hands over this copy after a reload, the service '
  + 'holds an older copy of your saved keys than this device has seen: this device will not open it, because an older '
  + 'copy can be missing a seat you hold. Use the device where your saved keys were last changed, or ask whoever runs '
  + 'the service to restore the newest copy of your saved keys.';
const OLDER =
  'the saved keys the page handed this wallet are an older copy than ones it has already opened for you.' + WAY_OUT;
const OTHER_COPY =
  'the saved keys the page handed this wallet are not the copy it opened for you at the same point: another copy was '
  + 'written beside it, and it may be missing a seat you hold.' + WAY_OUT;
const MISSING =
  'the page handed this wallet no saved keys, and it has already opened saved keys of yours, so it does not start '
  + 'new ones over them.' + WAY_OUT;
const SEAT_DROPPED =
  'this action tried to drop or change a seat already in your saved keys, which an action may never do: it would lose '
  + 'the only copy of that seat. Nothing was sealed and your saved keys are as they were. The action has to be '
  + 'corrected before it can run; nothing you do here resolves it.';

/** Whether every seat in `before` is in `after`, unchanged. */
const seatsKept = (before: Keyring, after: Keyring): boolean => {
  const kept = (a: Readonly<Record<string, unknown>> | undefined, b: Readonly<Record<string, unknown>> | undefined): boolean =>
    Object.entries(a ?? {}).every(([id, entry]) => b !== undefined && Object.prototype.hasOwnProperty.call(b, id)
      && canonical(b[id]) === canonical(entry));
  return typeof after.accounts === 'object' && after.accounts !== null
    && kept(before.accounts, after.accounts) && kept(before.pendingSeats, after.pendingSeats);
};
const DID_NOT_OPEN =
  'the saved keys the page handed this wallet did not open with this wallet’s key for you. They may be another '
  + 'wallet’s or another person’s. Nothing was changed.';
const LATER_UNDER_THE_OLD_KEY =
  'the saved keys the page handed this wallet are sealed the way they were before this wallet moved them to the key '
  + 'no page holds, and they are not the copy this device last opened that way. Only that copy is opened that way '
  + 'again: whoever kept the old key could have sealed this one.' + WAY_OUT;
const SEALED_BEFORE =
  'the saved keys the page handed this wallet are sealed the way they were before this device moved them to the key '
  + 'no page holds, so they are an older copy.' + WAY_OUT;

/**
 * OPENS THE SAVED KEYS A PAGE HANDED IN, or refuses them with `SavedKeysRefused`: ones that do not open with this
 * wallet's key for the person, a copy whose count is below the one this wallet has seen, another copy at that count,
 * and no copy when it has seen one. Saved keys written before writes were counted read as count 0, so they open where
 * this wallet has seen none, or saw this same copy at 0. Opening a higher count keeps it and its copy as the mark.
 */
export function openHeldKeyring(from: OpenedFrom): HeldKeyring {
  /* The derived bytes are zeroed once the key is in the form the seal takes. The hex string itself, and the plaintext
   * strings the seal reads and writes, cannot be wiped: a JavaScript string is never overwritten in place, so they last
   * until nothing refers to them. */
  const hexOf = (derived: Uint8Array): Hex => {
    try { watchFor(derived); return toHex(derived); } finally { derived.fill(0); }
  };
  let key: Hex | null = hexOf(keyringSealKeyFor(from.identity, from.ask));
  watchFor(keyringParentFor(from.identity));
  const person = from.ask.person;
  const mark = from.marks.markOf(person);
  let held: Keyring;
  let underTheOldKey = false;
  if (from.handedIn.sealed === null) {
    if (mark !== null) throw new SavedKeysRefused('older-keys', MISSING);
    held = { accounts: {} };
  } else {
    const sealed = from.handedIn.sealed;
    const tried = (k: Hex): Keyring | null => {
      try { return openKeyring(sealed, k); } catch (e) { if (e instanceof KeyringDidNotOpen) return null; throw e; }
    };
    let opened = tried(key);
    if (opened === null) {
      /* A copy sealed before the key no page had: opened once, with the old key, only where this device has not yet
       * opened a copy under the new one. The old key is wiped at once and seals nothing. */
      const old = hexOf(keyringKeyBeforeTheSeal(from.identity, from.ask));
      const before = tried(old);
      if (before === null) throw new SavedKeysRefused('keys-did-not-open', DID_NOT_OPEN);
      if (mark?.under === 2) throw new SavedKeysRefused('older-keys', SEALED_BEFORE);
      opened = before;
      underTheOldKey = true;
    }
    held = opened;
    watchTheSavedKeys(held);
    const counter = counterOf(held);
    const digest = sealedDigestOf(sealed);
    if (mark !== null && counter < mark.counter) throw new SavedKeysRefused('older-keys', OLDER);
    if (mark !== null && counter === mark.counter && digest !== mark.digest) throw new SavedKeysRefused('older-keys', OTHER_COPY);
    if (underTheOldKey && mark !== null && counter !== mark.counter) throw new SavedKeysRefused('older-keys', LATER_UNDER_THE_OLD_KEY);
    from.marks.raise(person, { counter, digest, ...(underTheOldKey ? {} : { under: 2 as const }) });
  }
  let version = from.handedIn.version;
  let sealing = false;

  const open = (): Hex => {
    if (key === null) throw new Error('these saved keys have been let go, so nothing more is read or sealed with them.');
    return key;
  };

  return Object.freeze({
    read: (): Keyring => { open(); return structuredClone(held); },
    metadata: (): KeyringMetadata => { open(); return metadataOf(held); },
    seal: (change: (current: Keyring) => Keyring): SealedAgain => {
      const k = open();
      if (sealing) throw new Error('saved keys already sealed again are waiting to be kept, so no second copy is sealed beside them.');
      const next = change(structuredClone(held));
      watchTheSavedKeys(next);
      if (!seatsKept(held, next)) throw new SeatChangeRefused(SEAT_DROPPED);
      const { sealed, written } = sealKeyring({ ...next, counter: counterOf(held) }, k);
      const counter = counterOf(written);
      const digest = sealedDigestOf(sealed);
      sealing = true;
      let settled = false;
      return Object.freeze({
        sealed: Object.freeze({ iv: sealed.iv, tag: sealed.tag, body: sealed.body }),
        ifVersion: version,
        counter,
        kept: (now: number): void => {
          if (settled) return;
          settled = true;
          sealing = false;
          from.marks.raise(person, { counter, digest, under: 2 });
          held = written;
          underTheOldKey = false;
          version = now;
        },
        notKept: (): void => {
          if (settled) return;
          settled = true;
          sealing = false;
        },
      });
    },
    letGo: (): void => { key = null; held = { accounts: {} }; },
    get underTheOldKey() { return underTheOldKey; },
  });
}
