/**
 * The one bound and the one shape of a list read: a request that names many records and is answered, entry by entry,
 * exactly as each record's own route answers it, so a page or a wallet reads what it needs in one request instead of
 * one per record. A list names one to `READ_AT_ONCE` entries, the number of records one request for proofs covers, so
 * what is read together can be proven together. Anything else is refused whole, and nothing is read.
 */
import { z } from 'zod';
import { PROVEN_AT_ONCE } from '../midnight/record-tree.js';

/** The most entries one list read names. */
export const READ_AT_ONCE = PROVEN_AT_ONCE;

/** The largest body a list read arrives in: `READ_AT_ONCE` entries, each a few hundred bytes at most. */
export const READ_BODY_LIMIT = '256kb';

/**
 * The entries of a list read's body, held under `field`, or `null` when the body is not one: an object with that one
 * field, a list of one to `READ_AT_ONCE` entries, each of `entry`'s shape. The route checks each entry's names itself.
 */
export const listAsked = <T>(body: unknown, field: string, entry: z.ZodType<T>): readonly T[] | null => {
  const read = z.object({ [field]: z.array(entry).min(1).max(READ_AT_ONCE) }).strict().safeParse(body ?? {});
  return read.success ? (read.data[field] as T[]) : null;
};
