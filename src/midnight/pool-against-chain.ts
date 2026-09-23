/**
 * **A VAULT'S RECORD OF ITS NOTES AGAINST THE NOTES THE CHAIN HOLDS FOR IT,
 * DECIDED IN ONE PLACE.**
 *
 * A vault's private money is its notes. The chain holds a commitment to each
 * one and nothing about its value, so the record of the notes can be trusted
 * only when the two agree in both directions:
 *
 *   - every note the record holds is one the chain holds. A note the chain
 *     does not hold would be offered to a payment and refused, so the record
 *     claims money the vault cannot spend;
 *   - and the chain holds no note the record does not. One it does means money
 *     reached the vault that the record never wrote down, and a balance read
 *     from that record would be short of what the vault holds.
 *
 * The service's vault client and a signer's device both ask this, over the same
 * commitments, so the two cannot come to different answers about the same
 * record and the same chain. How each one reads the chain, computes a
 * commitment, and words the answer for its reader is its own; which answer it
 * is, is decided here.
 */

/** What comparing a record of notes with the chain's set says. */
export type PoolAgainstChain<N> =
  | { readonly of: 'agrees' }
  /** Notes the record holds that the chain does not: the record claims more than the vault can spend. */
  | { readonly of: 'pool-claims-more'; readonly missing: readonly N[] }
  /**
   * Every recorded note is on chain and the counts differ. Where the chain
   * holds more, money reached the vault that the record never wrote down.
   */
  | { readonly of: 'counts-differ'; readonly chainHolds: bigint; readonly poolHolds: bigint };

/**
 * Compares a record of notes, each with the commitment the vault holds on
 * chain for it, with the chain's set of the vault's commitments.
 *
 * `chain.has` is asked with each note's commitment exactly as it is handed in;
 * a reader whose commitments are spelt differently from the chain's (case, a
 * prefix) makes `has` answer for that spelling.
 */
export function poolAgainstChain<N>(
  held: ReadonlyArray<{ readonly note: N; readonly commitment: string }>,
  chain: { has(commitment: string): boolean; readonly size: bigint },
): PoolAgainstChain<N> {
  const missing = held.filter((h) => !chain.has(h.commitment)).map((h) => h.note);
  if (missing.length > 0) return { of: 'pool-claims-more', missing };
  const poolHolds = BigInt(held.length);
  if (chain.size !== poolHolds) return { of: 'counts-differ', chainHolds: chain.size, poolHolds };
  return { of: 'agrees' };
}
