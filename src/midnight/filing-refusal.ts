/**
 * Whether a member's device believes a filing: the seat that signed it, its role, its boundary if retired, and
 * whether the chain holds it now.
 */
import type { AccountSeats } from 'midnight-identity/profile/records-key';
import type { Hex } from '../core/crypto.js';
import { mayFile, type FiledKind } from '../core/roles.js';
import type { Directory, DirectorySeat } from './seat-directory.js';
import { isRecoveryWindowKey } from './recovery-window-record.js';
import { notOnTheChainNow } from './seat-held-now.js';

/** Why a device does not believe a filing signed by `publicKey`, or null when it does. */
export type FilingRefusal = 'no-entry' | 'no-account' | 'seat-not-seated' | 'role-may-not-file' | 'past-its-boundary';

export const FILING_REFUSAL: Readonly<Record<FilingRefusal, string>> = Object.freeze({
  'no-entry': 'it is signed by a key that has no entry in the company\'s directory that this device believes',
  'no-account': 'it is signed by a seat of a company whose account on the chain could not be read, so whether the account holds that seat is not known',
  'seat-not-seated': 'it is signed by a seat the company\'s account no longer holds, and no retirement names it',
  'role-may-not-file': 'it is signed by a seat whose role may not file this kind of record',
  'past-its-boundary': 'it is signed by a retired seat, and is later than the last version that seat filed before it left',
});

/**
 * Whether a seat's role lets it file a version of the record counted under `recordKey`: its role files that kind, or
 * the record is the recovery window, whose versions any seat files with its own signature added (the window's fold
 * believes a new change only from a seat whose role files policy).
 */
export const mayFileTheRecord = (seat: Pick<DirectorySeat, 'role'>, kind: FiledKind, recordKey: string): boolean =>
  mayFile(seat).includes(kind) || isRecoveryWindowKey(recordKey);

/** A retired seat's version is believed only up to the last it filed of that record before it left. */
const withinItsBoundary = (seat: DirectorySeat, recordKey: string, version: number): boolean => {
  const last = seat.retired?.[recordKey];
  return last !== undefined && version <= last;
};

/**
 * **WHETHER A MEMBER'S DEVICE BELIEVES A FILING**: a version signed by
 * `publicKey` of the record counted under `recordKey`, of kind `kind`, at
 * `version`. The seat's role must file that kind (`mayFile`), except the
 * recovery window, which any seat files to add its signature (`mayFileTheRecord`). `chain` is what
 * this device's own wallet read off the chain for this read: a seat not
 * retired is believed only while its seat is seated - its wallet key was
 * proved for that seat by its entry's opening when the entry was believed; a
 * retired seat only within its boundary.
 */
export const filingRefusalOf = (
  dir: Directory, chain: AccountSeats, publicKey: Hex, kind: FiledKind, recordKey: string, version: number,
): FilingRefusal | null => {
  const seat = dir.seats.find((x) => x.signingKey === publicKey.toLowerCase());
  if (seat === undefined) return 'no-entry';
  if (!mayFileTheRecord(seat, kind, recordKey)) return 'role-may-not-file';
  if (seat.retired !== null) return withinItsBoundary(seat, recordKey, version) ? null : 'past-its-boundary';
  return notOnTheChainNow(seat, chain);
};
