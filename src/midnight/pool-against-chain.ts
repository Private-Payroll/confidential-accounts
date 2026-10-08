/**
 * **A VAULT'S RECORD OF ITS NOTES AGAINST THE NOTES THE CHAIN HOLDS FOR IT,
 * DECIDED IN ONE PLACE.**
 *
 * A vault's private money is its notes. The chain holds a commitment to each
 * one and nothing about its value. The record of the notes is trusted as far
 * as the chain bears it out:
 *
 *   - every note the record holds must be one the chain holds. A note the
 *     chain does not hold would be offered to a payment and refused, so a
 *     record holding one claims money the vault cannot spend, and it is never
 *     summed;
 *   - a note the chain holds that the record does not is either ours or not.
 *     It is ours when one of this vault's journals names it - a payment's
 *     change or a deposit written down before the call, whose pool write has
 *     not happened yet - and then it is recovered and counted. A note nothing
 *     names was never ours: anyone may deposit into a vault, and a coin whose
 *     opening never reached us can be spent by nobody. It is ignored and
 *     counted, never a reason to stop: the vault goes on paying from the notes
 *     it holds.
 *
 * The service's vault client and a signer's device both ask this, over the same
 * commitments, so the two cannot come to different answers about the same
 * record and the same chain. How each one reads the chain, computes a
 * commitment, and words the answer for its reader is its own; which answer it
 * is, is decided here.
 */

/** What comparing a record of notes with the chain's set says. */
export type PoolAgainstChain<N> =
  /**
   * The record holds only notes the chain holds. `recovered`: notes a journal
   * names that the chain holds and the record does not yet; they are the
   * vault's. `ignored`: how many notes the chain holds that nothing accounts
   * for; none of them is the vault's money to spend.
   */
  | { readonly of: 'agrees'; readonly recovered: readonly N[]; readonly ignored: bigint }
  /** Notes the record holds that the chain does not: the record claims more than the vault can spend. */
  | { readonly of: 'pool-claims-more'; readonly missing: readonly N[] }
  /** The record names one note more than once, so it counts money twice. */
  | { readonly of: 'counts-differ'; readonly chainHolds: bigint; readonly poolHolds: bigint };

/**
 * Compares a record of notes, each with the commitment the vault holds on
 * chain for it, with the chain's set of the vault's commitments.
 *
 * `accountedFor` is every note a journal names that the record may not hold
 * yet, with its commitment; a note the record already holds is not counted
 * twice.
 *
 * `chain.has` is asked with each note's commitment exactly as it is handed in;
 * a reader whose commitments are spelt differently from the chain's (case, a
 * prefix) makes `has` answer for that spelling.
 */
export function poolAgainstChain<N>(
  held: ReadonlyArray<{ readonly note: N; readonly commitment: string }>,
  chain: { has(commitment: string): boolean; readonly size: bigint },
  accountedFor: ReadonlyArray<{ readonly note: N; readonly commitment: string }> = [],
): PoolAgainstChain<N> {
  const missing = held.filter((h) => !chain.has(h.commitment)).map((h) => h.note);
  if (missing.length > 0) return { of: 'pool-claims-more', missing };
  const recorded = new Set(held.map((h) => h.commitment));
  if (BigInt(recorded.size) !== BigInt(held.length)) {
    return { of: 'counts-differ', chainHolds: chain.size, poolHolds: BigInt(held.length) };
  }
  const recovered: N[] = [];
  for (const a of accountedFor) {
    if (recorded.has(a.commitment) || !chain.has(a.commitment)) continue;
    recorded.add(a.commitment);
    recovered.push(a.note);
  }
  return { of: 'agrees', recovered, ignored: chain.size - BigInt(recorded.size) };
}
