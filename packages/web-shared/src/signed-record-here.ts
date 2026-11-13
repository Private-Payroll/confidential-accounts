/**
 * What a device reads before it folds a company record whose changes count at the seat bar (`signedChangesInForce`):
 * whether the service gave every version the company's records name, and who counted toward the bar as the records
 * anchored each version. The read grants and the recovery window both read through these.
 */
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { SignedCount } from '../../../src/midnight/signed-change-fold.js';
import type { DirectoryHere } from './vault-page-doors.js';

/** One company record, by kind and id. */
interface CompanyRecordNamed {
  readonly kind: string;
  readonly id: string;
}

/**
 * A version of the record the company's records name (anchored, or entered and not yet anchored) that the service did
 * not serve, said by `missingSaid`; or why the record was not given at all though they name one (`withheld`, the
 * filing judge's). Null when every
 * version they name was served.
 */
export const versionsWithheldIn = (
  here: DirectoryHere, served: readonly SealedCompanyRecord[], record: CompanyRecordNamed, missingSaid: (version: number) => string,
  withheld: ((read: { readonly store: 'company'; readonly kind: string; readonly id: string }) => string | null) | undefined,
): string | null => {
  const read = { store: 'company' as const, kind: record.kind, id: record.id };
  if (served.length === 0) return withheld?.(read) ?? null;
  const named = [
    ...(here.records.history.get(recordKeyOf(read)) ?? []).map((v) => v.version),
    ...here.records.notYetAnchored.filter((e) => e.store === 'company' && e.kind === read.kind && e.id === read.id).map((e) => e.version),
  ];
  const missing = named.filter((v) => !served.some((r) => r.version === v));
  return missing.length === 0 ? null : missingSaid(Math.max(...missing));
};

/**
 * Who counted toward the bar as the company's records anchored a version of the record: the directory as it stood at
 * the directory version anchored with it, and the seats the chain held and the seat bar as that directory version was
 * anchored. Undefined only for a version the records do not anchor, which is counted against who holds the account
 * now. An anchored version whose count cannot be read here, or served as other bytes than the anchor holds, throws
 * `unread()`: counted against today instead, a signer removed since could drop a change the bar once carried.
 */
export const countAsAnchoredFor = (
  here: DirectoryHere, filed: readonly SealedCompanyRecord[], record: CompanyRecordNamed, unread: () => Error,
) => (version: number): SignedCount | undefined => {
  const anchored = (here.records.history.get(recordKeyOf({ store: 'company', kind: record.kind, id: record.id })) ?? []).find((v) => v.version === version);
  if (anchored === undefined) return undefined;
  const rec = filed.find((r) => r.version === version);
  const held = here.records.held?.(anchored.dirVersion) ?? null;
  const then = held === null ? null : here.at(anchored.dirVersion);
  if (rec === undefined || companyRecordEntry(rec).digest !== anchored.digest || held === null || then === null) throw unread();
  return { seats: then.dir.seats, held: (seat) => held.seats.includes(seat.seat), bar: held.seatBar };
};
