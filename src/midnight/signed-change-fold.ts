/**
 * **ONE FOLD FOR A COMPANY RECORD WHOSE CHANGES COUNT ONCE ITS SIGNERS AT THE SEAT BAR HAVE SIGNED THEM.**
 *
 * A record of this sort holds numbered changes (`sequence`), each signed by seats in their own wallets. Its versions
 * are judged in order: a version that does not open, is not in its shape, or is neither the change in force filed
 * again nor the next change after it, is not believed. A believed version counts its signatures against who held the
 * company's account as the records anchored it, or against now for a version not yet anchored, and comes into force
 * once the count reaches the seat bar; below it, it is the change still gathering signatures. The read grants and the
 * recovery window are both judged here, each giving only what is its own: its shape, when a version follows the one in
 * force, how its signatures count, and any check of its own once they are counted.
 */
import type { DirectorySeat, SeatSignature } from './seat-directory.js';

/** Who counts toward the bar: the seats the directory believes, the test of a seat the chain holds, and the seat bar. */
export interface SignedCount {
  readonly seats: readonly DirectorySeat[];
  readonly held: (seat: DirectorySeat) => boolean;
  readonly bar: number;
}

/**
 * Who counts toward the bar now, and, for a version the company's records anchor, who counted as they anchored it
 * (`asAnchored`): such a version is counted against that, so a signer who leaves later, or a bar raised later, never
 * drops a change the bar once carried. Undefined for a version not yet anchored, which is counted against now.
 */
export interface SignedQuorum extends SignedCount {
  readonly asAnchored?: (version: number) => SignedCount | undefined;
}

/** The refusals every record of this sort shares. */
export type FoldRefusal = 'not-opened' | 'not-the-next-change' | 'not-signed' | 'below-quorum';

/** One numbered, signed change. */
export interface SignedChange {
  readonly sequence: number;
  readonly signatures: readonly SeatSignature[];
}

/** One version as filed: its number and its change, or null when it did not open here. */
export interface FiledVersion<C extends SignedChange> {
  readonly version: number;
  readonly change: C | null;
}

/** What one record gives the fold: what is its own in judging a version. */
export interface FoldRules<V extends FiledVersion<C>, C extends SignedChange, R extends string> {
  /** A refusal of the version's own shape, or null. */
  readonly shape: (v: V, change: C) => R | null;
  /** Whether the version may follow the one in force: filed again (`again`, the same sequence), or the next change. */
  readonly follows: (v: V, change: C, prior: { readonly v: V; readonly change: C }, again: boolean) => boolean;
  /** How many of the counted seats signed it, or why its signatures are refused. */
  readonly counted: (count: SignedCount, v: V, change: C, prior: { readonly v: V; readonly change: C } | null, again: boolean) => number | string;
  /** A check of the record's own once the signatures are counted, or null. */
  readonly afterCount?: (count: SignedCount, v: V, change: C, n: number, prior: { readonly v: V; readonly change: C } | null) => R | null;
  /** Told of each version that comes into force, with the one it replaces. */
  readonly cameIntoForce?: (v: V, change: C, prior: { readonly v: V; readonly change: C } | null, again: boolean) => void;
}

/** The fold's answer: the version in force, the newest next change still below the bar, and why each other version is not believed. */
export interface SignedInForce<V extends FiledVersion<C>, C extends SignedChange, R extends string> {
  readonly inForce: (V & { readonly change: C }) | null;
  readonly waiting: (V & { readonly change: C }) | null;
  readonly refused: ReadonlyMap<number, R | FoldRefusal>;
}

/** **THE FOLD.** Each version in order of its number, judged against the version in force before it. */
export function signedChangesInForce<V extends FiledVersion<C>, C extends SignedChange, R extends string>(
  versions: readonly V[], quorum: SignedQuorum, rules: FoldRules<V, C, R>,
): SignedInForce<V, C, R> {
  let prior: { readonly v: V; readonly change: C } | null = null;
  let waiting: { readonly v: V; readonly change: C } | null = null;
  const refused = new Map<number, R | FoldRefusal>();
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    const change = v.change;
    if (change === null) { refused.set(v.version, 'not-opened'); continue; }
    const shape = rules.shape(v, change);
    if (shape !== null) { refused.set(v.version, shape); continue; }
    const again = prior !== null && change.sequence === prior.change.sequence;
    if (prior !== null && !rules.follows(v, change, prior, again)) { refused.set(v.version, 'not-the-next-change'); continue; }
    const count = quorum.asAnchored?.(v.version) ?? quorum;
    const n = rules.counted(count, v, change, prior, again);
    if (typeof n === 'string') { refused.set(v.version, 'not-signed'); continue; }
    const own = rules.afterCount?.(count, v, change, n, prior) ?? null;
    if (own !== null) { refused.set(v.version, own); continue; }
    if (n < count.bar) {
      refused.set(v.version, 'below-quorum');
      if (!again) waiting = { v, change };
      continue;
    }
    rules.cameIntoForce?.(v, change, prior, again);
    prior = { v, change };
    if (waiting !== null && waiting.change.sequence <= change.sequence) waiting = null;
  }
  const opened = (f: { readonly v: V; readonly change: C } | null): (V & { readonly change: C }) | null => (f === null ? null : { ...f.v, change: f.change });
  return { inForce: opened(prior), waiting: opened(waiting), refused };
}
