/**
 * Whether a proposal written down and not yet on the chain may still reach it, by the chain's own time as the person's
 * own wallet reads it, and only while the seat that filed it still sits on the account, so a seat since removed cannot
 * keep refiling to hold a person or an address. By default its raise holds only within one raise window of when it was
 * written (`raiseHoldsWhatItNamesAt`), so a record dated far ahead holds an address off for no longer than a day; a
 * caller that must not act while the raise can still land asks up to its raise-by time (`raiseMayStillLandAt`). A record
 * that does not say when it was written holds nothing, since no deadline can be read from it.
 */
import { raiseHoldsWhatItNamesAt } from '../../../src/core/proposal-filing.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';

type DirectoryRead = Awaited<ReturnType<CompanyRecordsHere['directory']>>;

/** The signing keys of the seats the directory names, not retired, whose seat the chain holds now. */
export const sittingSigningKeysIn = (here: DirectoryRead, onTheChain: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(here.dir.seats.filter((x) => x.retired === null && onTheChain.has(String(x.seat).toLowerCase()))
    .map((x) => String(x.signingKey).toLowerCase()));

/**
 * The records of `filed` whose raise still holds by the chain's time, as `holdsAt` judges it (one raise window of when
 * it was written, unless the caller asks otherwise), or 'time-not-read' when that time cannot be read while a record
 * with a deadline is waiting: the caller refuses then, never lets the record pass as gone.
 */
export const raisesStillHolding = async <T extends { readonly raiseBy?: string }>(
  filed: readonly T[], chainTime: (() => Promise<number>) | undefined,
  holdsAt: (raiseBy: string, atMs: number) => boolean = raiseHoldsWhatItNamesAt,
): Promise<readonly T[] | 'time-not-read'> => {
  const dated = filed.filter((x) => x.raiseBy !== undefined);
  if (dated.length === 0) return [];
  const at = chainTime === undefined ? undefined : await chainTime().catch(() => {
    /* A chain time not read is refused by the caller with words to try again, never let through. */
    return undefined;
  });
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return 'time-not-read';
  return dated.filter((x) => holdsAt(x.raiseBy!, at));
};
