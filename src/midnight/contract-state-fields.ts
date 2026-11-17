/**
 * Reading one field of an account contract's decoded state: a map, a set's size, or the movements already paid.
 * A field missing from the decoded state is refused with `UndecodedLedgerField`, never read as empty, because an
 * empty map is a true statement about the account and a missing one is only that the service could not read it.
 */
import type { Hex } from '../core/crypto.js';
import { toHex } from '../core/crypto.js';

/**
 * One of the contract's maps, or a refusal naming which one was missing.
 *
 * The generated reader declares each of these maps as a non-optional accessor with
 * `[Symbol.iterator](): Iterator<[Uint8Array, ...]>`. That is right about the shape and says nothing about
 * presence: a map that arrives `undefined` and is spread throws a `TypeError` naming an internal expression.
 *
 * The refusal is the point, and `?? []` would be the defect. Coercing a missing map to an empty one is the
 * dangerous direction for `thresholds`:
 *
 *   - an account where nobody has set an exception decodes to an empty map, and the honest answer is "every
 *     vault inherits the account's threshold"
 *   - a map we failed to read is not that, and answering "inherit" for it means a vault somebody deliberately
 *     gave a higher threshold is judged by the account's lower one, and a run settles early
 *
 * Those two are distinguishable, and this function is where the distinction is kept. An empty map is an accessor
 * that iterates zero times; a missing one is not an accessor at all. The decoding test for the compiled ledger
 * pins both sides, because a property that is only true while nobody writes `?? []` is not a property.
 *
 * Every collection the boundary reads goes through a guard: each map through `mapField` (including
 * `approvalCounts`, read as a `CountedMap`) and each set through `setSize` or `paidMovementsIn`. A guard on one
 * collection of several makes the others look checked, so a new collection exported by the contract needs its
 * own guard here.
 *
 * `Symbol.iterator` rather than `isEmpty` is the test deliberately: the real reader returns an accessor and the
 * tests supply arrays, and what both promise, and all this function needs, is that they iterate as pairs.
 *
 * The pair type is written at each call site, copied from the generated `.d.ts` rather than inferred
 * (`openProposals` is `Iterator<[Uint8Array, Uint8Array]>` and `thresholds` is `Iterator<[Uint8Array, bigint]>`).
 * Writing them down makes a future mismatch a compile error in the strict tree, where a loosely typed script
 * tree would accept a spread of an `any`.
 */
export class UndecodedLedgerField extends Error {
  /*
   * `kind` defaults to `map` so the map refusals keep their exact sentence, which tests assert; a set needs the
   * message to say which noun it means.
   */
  constructor(readonly field: string, kind: 'map' | 'set' = 'map') {
    super(
      `the contract's "${field}" ${kind} was not in the decoded state, so this boundary ` +
        'cannot say what it holds. **This is not the same as the map being empty** — an ' +
        'empty map is a true statement about the account and a missing one is our ' +
        'ignorance, and for "thresholds" the two have opposite meanings: empty means every ' +
        'vault inherits the account\'s threshold, missing means a vault with its own may be ' +
        'about to be judged by the wrong number. Read the state again.',
    );
    this.name = 'UndecodedLedgerField';
  }
}

/**
 * The account's completed payments, off its decoded public state, as hex.
 * Separate so it can be held against the compiled contract's own state
 * without a chain. A field that did not decode as a set refuses rather than
 * reading as an empty one.
 */
export function paidMovementsIn(parsed: any): Hex[] {
  const movements = parsed?.movements;
  if (movements == null || typeof movements[Symbol.iterator] !== 'function') {
    throw new UndecodedLedgerField('movements', 'set');
  }
  return [...(movements as Iterable<Uint8Array>)].map((m) => toHex(m).toLowerCase());
}

/**
 * A decoded map this boundary looks a key up in, rather than only iterating.
 *
 * Copied from the generated reader rather than inferred. Both halves are used: `mapField` proves the map is there
 * by its iterator, and `lookup` is how a count is fetched for one proposal.
 */
export type CountedMap = Iterable<[Uint8Array, bigint]> & { lookup(key: Uint8Array): bigint };

/** The account contract's ledger field holding the addresses of the vaults it adopted. */
export const ADOPTED_SET = 'vaults';

export const mapField = <T>(parsed: any, field: string): Iterable<T> => {
  const m = parsed?.[field];
  if (m == null || typeof m[Symbol.iterator] !== 'function') {
    throw new UndecodedLedgerField(field);
  }
  return m as Iterable<T>;
};

/**
 * One of the contract's sets, counted, or a refusal naming which one was missing. `mapField`'s sibling, and
 * everything argued there applies here unchanged.
 *
 * The seat count is a read of `signerLeaves`, a `Set` accessor (`{ isEmpty, size, member, [Symbol.iterator] }`)
 * over single values rather than pairs. `mapField` would accept it and hand back an iterable this caller does not
 * want; `size()` is the on-chain read the boundary needs.
 *
 * The dangerous direction is the same one. An account can never have an empty `signerLeaves`, since the
 * constructor seats one, which is why this returns the count rather than tolerating zero. A collection we failed
 * to read answering `0` would make every caller downstream refuse every threshold change and every removal on a
 * live account. `?? 0n` is the defect, exactly as `?? []` is for a map.
 *
 * `typeof size === 'function'` rather than `Symbol.iterator`, because `size` is the thing being called and a
 * guard that proves a different member is present is a guard on the wrong member.
 */
export const setSize = (parsed: any, field: string): bigint => {
  const s = parsed?.[field];
  if (s == null || typeof s.size !== 'function') {
    throw new UndecodedLedgerField(field, 'set');
  }
  return s.size();
};
