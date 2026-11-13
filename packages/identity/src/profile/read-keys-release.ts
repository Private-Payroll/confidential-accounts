/**
 * **THE READ KEYS A READER'S WALLET HANDS A PAGE, FOR ONE COMPANY**, and the one reader of them.
 *
 * A reader holds no seat and is never given the company's key. What its wallet hands over, at the end of the
 * `reader-keys` action, is only the keys the read grant in force wraps to it: per key epoch, one key per kind of record
 * its role reads. The shape is closed: the company's record id, then epochs as decimal numbers, each naming record
 * kinds by name and a sixty-four hex key; anything else, more of them than a company can have, or on any other action's
 * answer, is refused whole. The kinds of record are the company's closed list of purposes, which the caller that knows
 * it passes in (`known`): the wallet before it sends, and the page before it takes any key.
 */
export const READER_KEYS_INTENT = 'reader-keys';

/** The read keys released: for `accountId`, by key epoch, each record kind's key as lowercase hex. */
export interface ReadKeysReleased {
  readonly accountId: string;
  readonly byEpoch: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The most key epochs a release carries, and the most kinds of record in one. */
export const MOST_RELEASED_EPOCHS = 256;
export const MOST_RELEASED_PURPOSES = 32;

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const EPOCH = /^(?:0|[1-9][0-9]{0,8})$/u;
const PURPOSE = /^[a-z]+(?:-[a-z]+){0,3}$/u;
const KEY = /^[0-9a-f]{64}$/u;

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The keys of one epoch read whole, or null. */
const purposesRead = (raw: unknown, known: (purpose: string) => boolean): Readonly<Record<string, string>> | null => {
  if (!plainObject(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MOST_RELEASED_PURPOSES) return null;
  const out: Record<string, string> = {};
  for (const [purpose, key] of entries) {
    if (!PURPOSE.test(purpose) || !known(purpose) || typeof key !== 'string' || !KEY.test(key)) return null;
    out[purpose] = key;
  }
  return Object.freeze(out);
};

/**
 * The release read whole, or null when any part of it is not in its one shape or names a kind of record `known` does
 * not; without `known`, a kind is checked for its form alone, as the channel reads an end before anyone places it.
 */
export function readReleasedReadKeys(raw: unknown, known: (purpose: string) => boolean = () => true): ReadKeysReleased | null {
  if (!plainObject(raw) || Object.keys(raw).sort().join(',') !== 'accountId,byEpoch') return null;
  const { accountId, byEpoch } = raw;
  if (typeof accountId !== 'string' || !RECORD_ID.test(accountId) || !plainObject(byEpoch)) return null;
  const epochs = Object.entries(byEpoch);
  if (epochs.length === 0 || epochs.length > MOST_RELEASED_EPOCHS) return null;
  const out: Record<string, Readonly<Record<string, string>>> = {};
  for (const [epoch, keys] of epochs) {
    const read = EPOCH.test(epoch) ? purposesRead(keys, known) : null;
    if (read === null) return null;
    out[epoch] = read;
  }
  return Object.freeze({ accountId, byEpoch: Object.freeze(out) });
}
