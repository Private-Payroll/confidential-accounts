/**
 * **A HOLDER'S KEYS, BY PURPOSE.** Every reader on this device asks here for the keys of the purpose it opens, the
 * directory's one check included, and never for the company key itself, so a holder given some purposes alone reads
 * what those purposes cover and is refused the rest (`keyForThePurpose`). What a holder holds comes from this device:
 * a seat holds the company key, of each epoch it can reach, and each purpose key is derived from it; a reader holds the
 * purpose keys its read grant wraps to it (`purpose-wraps.ts`), which never answer a former key, so a reader never opens
 * a person sealed under `payroll` before people had a purpose of their own.
 */
import { keyOf, keysHeld, type KeysHeld } from '../../../src/core/company-key.js';
import { purposeKeysOfTheCompanyKey, type PurposeKeys } from '../../../src/core/sealed-records.js';
import { isPurposeWraps, purposeKeysAt, purposeKeysOfEveryEpoch, type PurposeWrapsHeld } from './purpose-wraps.js';

/** What a holder holds that opens records: the company's keys of each epoch it can reach, or a reader's purpose keys. */
export type HeldForReading = KeysHeld | PurposeWrapsHeld;

/** A holder's keys by purpose, of one epoch at a time. */
interface KeysByPurpose {
  /** The keys of the epoch a record names; a holder that cannot reach that epoch is refused (`keyOf`, or no key for the purpose). */
  readonly at: (epoch: number | undefined) => PurposeKeys;
  /** The keys of every epoch the holder can reach, newest first, for a record that does not name its epoch. */
  readonly everyEpoch: () => readonly PurposeKeys[];
}

/** The keys by purpose of whoever holds `held`. */
export const keysByPurpose = (held: HeldForReading): KeysByPurpose => (isPurposeWraps(held)
  ? { at: (epoch) => purposeKeysAt(held, epoch), everyEpoch: () => [...purposeKeysOfEveryEpoch(held)].reverse() }
  : {
    at: (epoch) => purposeKeysOfTheCompanyKey(keyOf(held, epoch)),
    everyEpoch: () => keysHeld(held).map(purposeKeysOfTheCompanyKey),
  });

/** What `open` makes of the first epoch's keys it does not throw on, newest first; the last refusal when every epoch's does. */
export const openedWithAnyEpoch = <T>(keys: KeysByPurpose, open: (keys: PurposeKeys) => T): T => {
  let last: unknown = new Error('this device holds no key of the company.');
  for (const k of keys.everyEpoch()) {
    try { return open(k); } catch (e) { last = e; }
  }
  throw last;
};
