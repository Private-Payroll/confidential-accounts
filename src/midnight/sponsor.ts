/**
 * The fee sponsor. Decision 0001, M-4.
 *
 * This is the whole SaaS story in one file. DUST is non-transferable, so it
 * cannot be topped up into a customer's account — which sounds like a problem
 * and is actually the feature. The protocol's answer is two-phase balancing:
 * the customer balances the shielded and unshielded legs of their transaction
 * and signs it, and a sponsor balances only the dust leg and submits. **The
 * customer wallet never has to hold NIGHT or register for DUST generation at
 * all.**
 *
 * So the customer never sees a token, never funds anything, never learns what
 * DUST is. We hold NIGHT, generate DUST, and pay. That is a SaaS invoice
 * instead of a crypto onboarding, and it is the difference between a product a
 * finance team will use and one they will not.
 *
 * THE ONE RULE THAT MATTERS: the token kinds must not overlap. Re-balancing a
 * kind the other party has already balanced is a double spend, and the node
 * rejects the whole transaction. The customer takes `['shielded','unshielded']`
 * and the sponsor takes `['dust']`, and neither takes `'all'`.
 *
 * Verified against the installed `@midnightntwrk/wallet-sdk-facade`, not
 * against a document:
 *
 *   balanceFinalizedTransaction(tx, { shieldedSecretKeys, dustSecretKey },
 *                               { ttl, tokenKindsToBalance? })
 *     -> { type: 'FINALIZED_TRANSACTION', originalTransaction, balancingTransaction }
 *   finalizeRecipe(recipe) -> FinalizedTransaction     // proves and merges
 *
 * `balancingTransaction` comes back UNPROVEN. `finalizeRecipe` is what proves
 * it and merges it with the customer's, which is why this class calls both and
 * a caller cannot skip the second.
 */
import type { FeeSponsor } from './ledger.js';
import type { TxRef } from '../core/ledger.js';

/** What a sponsor needs from a funded wallet, and nothing more. */
export interface SponsorWallet {
  balanceFinalizedTransaction(
    tx: unknown,
    secretKeys: { shieldedSecretKeys: unknown; dustSecretKey: unknown },
    options: { ttl: Date; tokenKindsToBalance?: string[] },
  ): Promise<unknown>;
  finalizeRecipe(recipe: unknown): Promise<unknown>;
  submitTransaction(tx: unknown): Promise<string>;
  shieldedSecretKeys: unknown;
  dustSecretKey: unknown;
  balances(): Promise<{ dust: bigint; night: bigint }>;
}

/**
 * The token kinds each party balances. Deliberately constants rather than
 * arguments: this is the invariant, not a tuning knob, and a caller who could
 * pass `'all'` here could create a double spend from a plausible-looking call.
 */
export const CUSTOMER_BALANCES = ['shielded', 'unshielded'] as const;
export const SPONSOR_BALANCES = ['dust'] as const;

export class WalletFeeSponsor implements FeeSponsor {
  constructor(
    private wallet: SponsorWallet,
    /**
     * Told when the sponsor pays, and how much capacity is left.
     *
     * Not optional in spirit: this component is the only one in the system that
     * spends, so an operator who cannot see it spending finds out that DUST ran
     * out when customers start failing.
     */
    private onPay?: (info: { fee?: bigint; remaining?: bigint }) => void,
  ) {}

  /**
   * Phase 2: balance the dust leg only, then prove and merge.
   *
   * The customer has already balanced their own legs and signed. This adds the
   * fee and hands back something submittable.
   */
  async addFeeAndFinalise(customerFinalised: unknown, ttl: Date): Promise<unknown> {
    const recipe = await this.wallet.balanceFinalizedTransaction(
      customerFinalised,
      {
        shieldedSecretKeys: this.wallet.shieldedSecretKeys,
        dustSecretKey: this.wallet.dustSecretKey,
      },
      // Dust ONLY. Anything wider re-balances what the customer already
      // balanced, which the node reads as a double spend.
      { ttl, tokenKindsToBalance: [...SPONSOR_BALANCES] },
    );

    /*
     * `balancingTransaction` arrives unproven. Skipping this step produces a
     * recipe rather than a transaction, and the failure lands at submission as
     * a type error from inside the SDK — which names none of this.
     */
    return this.wallet.finalizeRecipe(recipe);
  }

  /** Phase 3: whoever pays the fee submits. */
  async submit(finalisedTransaction: unknown): Promise<TxRef> {
    const ref = await this.wallet.submitTransaction(finalisedTransaction);
    if (this.onPay) {
      const { dust } = await this.wallet.balances().catch(() => ({ dust: undefined as any }));
      this.onPay({ remaining: dust });
    }
    return { ref: String(ref), at: new Date().toISOString() };
  }

  /**
   * Remaining capacity, so we alarm before customers start failing.
   *
   * DUST regenerates from held NIGHT rather than being bought, so "running out"
   * is a rate problem, not a balance problem: a burst of customer activity can
   * outrun generation while the NIGHT balance looks perfectly healthy. Both
   * numbers are reported for that reason.
   */
  async capacity(): Promise<{ dust: bigint; night: bigint }> {
    return this.wallet.balances();
  }
}
