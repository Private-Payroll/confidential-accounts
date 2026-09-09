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

/**
 * **WHAT A SPONSOR NEEDS FROM A FUNDED WALLET, AND NOTHING MORE. THIS IS THE
 * SEAM, AND IT IS WIDER THAN ONE ROW ASKED FOR ON PURPOSE.**
 *
 * The party that pays is the only component in this system with spend
 * authority, so what it is allowed to ask a wallet for is worth deciding once
 * rather than growing a method at a time. Every member below is here because
 * paying for somebody else's transaction cannot be done without it:
 *
 *   `balanceFinalizedTransaction`  add the fee leg to a transaction that is
 *                                  already balanced, signed and finalised by
 *                                  its owner. **The FINALIZED method and not
 *                                  the unbound one**, and that is a custody
 *                                  decision rather than a preference: the
 *                                  unbound form mutates, re-signs and re-binds
 *                                  the transaction it is given, so a sponsor
 *                                  using it could alter the legs it is paying
 *                                  for. This one cannot.
 *   `finalizeRecipe`               the fee leg comes back unproven. Skipping
 *                                  this hands a recipe to a node instead of a
 *                                  transaction, and the failure surfaces from
 *                                  inside the vendor SDK naming none of this.
 *   `submitTransaction`            whoever pays the fee submits.
 *   `revert`                       **release coins this wallet booked and did
 *                                  not spend.** See below - it is the member
 *                                  this interface was missing, and its absence
 *                                  was not a gap in tidiness.
 *   `balances`                     what is left to pay with, so an operator
 *                                  learns the fee budget is running out before
 *                                  customers start failing.
 *   the two keys                   what the balancing call is given.
 *
 * **WHY `revert` IS REQUIRED AND NOT OPTIONAL.** Balancing marks coins as
 * in-flight in the wallet's own state. Nothing releases them by time - the
 * vendor's sweep for that is documented as a no-op - and nothing releases them
 * on failure, because a transaction that was balanced and never submitted never
 * acquires a result for the vendor's own cleanup to act on. **So a booking made
 * by a call that then threw stands for ever, and the next attempt balances onto
 * a fresh coin set because the first one is filtered out as pending.** The
 * balance quietly falls with each failure and nothing anywhere says why. An
 * optional member would mean a wallet could be wired in with no way to release,
 * which is the state this seam is in today.
 *
 * **WHAT IS DELIBERATELY NOT HERE, SO THAT ADDING IT LATER IS A DECISION AND
 * NOT A DISCOVERY.** The vendor offers a sponsor two spend controls at exactly
 * this call site - checking that what it is about to pay for was actually
 * signed, and estimating the fee before committing to it - and neither is
 * called anywhere in this product. **Nothing caps what a sponsor pays**: the
 * fee follows the transaction's complexity, and the customer composes the
 * transaction. Those two belong here the day something uses them; a seam member
 * nobody implements is a member that gets stubbed, and a stub in the one
 * component with spend authority is worse than an absence. **A later change adds
 * them to this interface and to the class below, and to nothing else - which is
 * the whole reason the seam is one narrow interface in one file.**
 */
export interface SponsorWallet {
  balanceFinalizedTransaction(
    tx: unknown,
    secretKeys: { shieldedSecretKeys: unknown; dustSecretKey: unknown },
    options: { ttl: Date; tokenKindsToBalance?: string[] },
  ): Promise<unknown>;
  finalizeRecipe(recipe: unknown): Promise<unknown>;
  submitTransaction(tx: unknown): Promise<string>;
  /**
   * Release coins booked by a balance that was not spent.
   *
   * Takes whatever the balancing produced - the recipe, or the transaction it
   * became - because which of the two is in hand depends on how far the attempt
   * got, and a release that could only be given one of them would be a release
   * that cannot run at the point it is needed.
   */
  revert(booking: unknown): Promise<void>;
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
      /*
       * **DUST ONLY, ALWAYS, AND NEVER THE ARGUMENT'S OWN DEFAULT.** Anything
       * wider re-balances what the customer already balanced, which the node
       * reads as a double spend. And the default if this were omitted is
       * *everything*: the sponsor would quietly pay the customer's shielded and
       * unshielded legs out of its own coins, with no error and no warning.
       * **A constant rather than an argument, so no caller can widen it.**
       */
      { ttl, tokenKindsToBalance: [...SPONSOR_BALANCES] },
    );

    /*
     * **FROM THIS LINE THE COINS ARE BOOKED**, so every way out of the rest of
     * this method has to release them. Nothing else will: time does not, and
     * the vendor's own cleanup never sees a transaction that was balanced and
     * not submitted.
     *
     * `balancingTransaction` arrives unproven. Skipping the call below produces
     * a recipe rather than a transaction, and the failure lands at submission
     * as a type error from inside the SDK — which names none of this.
     */
    try {
      return await this.wallet.finalizeRecipe(recipe);
    } catch (e) {
      await this.release(recipe);
      throw e;
    }
  }

  /**
   * Phase 3: whoever pays the fee submits.
   *
   * **A THROW HERE IS NOT PROOF THE TRANSACTION DID NOT LAND**, and this method
   * does not pretend otherwise: it releases the booking and re-raises, and what
   * the state machine above makes of that is the state machine's business. What
   * it must not do is leave the coins booked on the one path where the outcome
   * is unknown, because that is the path most likely to be tried again.
   */
  async submit(finalisedTransaction: unknown): Promise<TxRef> {
    let ref: string;
    try {
      ref = await this.wallet.submitTransaction(finalisedTransaction);
    } catch (e) {
      await this.release(finalisedTransaction);
      throw e;
    }
    if (this.onPay) {
      const { dust } = await this.wallet.balances().catch(() => ({ dust: undefined as any }));
      this.onPay({ remaining: dust });
    }
    return { ref: String(ref), at: new Date().toISOString() };
  }

  /**
   * **A RELEASE THAT FAILS MUST NEVER REPLACE THE FAILURE THAT CAUSED IT.**
   *
   * Whether the vendor's release accepts a booking that has already been part
   * consumed is not established, and this is a cleanup running on a path that
   * has already gone wrong. If it throws, the caller still needs the original
   * error: that is the one naming what actually happened, and swapping it for a
   * complaint about tidying up sends whoever reads it to the wrong place.
   *
   * So a failed release is swallowed here, and it is the one thing in this
   * class that is. The cost is a booking that stays booked and says nothing,
   * which is the state everything before this line exists to avoid — **so a
   * release that cannot report its own failure is a gap this seam still has,
   * and it is named here rather than left to be discovered.**
   */
  private async release(booking: unknown): Promise<void> {
    try {
      await this.wallet.revert(booking);
    } catch {
      /* deliberately swallowed - see above */
    }
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
