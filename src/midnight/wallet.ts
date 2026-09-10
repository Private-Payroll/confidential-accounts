/**
 * The customer wallet and the fee sponsor: decision 0001 as executable code.
 *
 * These are the two implementations M-5 was missing. Everything here is written
 * against the published `@midnight-ntwrk/wallet-sdk-facade` in node_modules,
 * whose `WalletFacade` is what `testkit-js` itself drives.
 *
 * THE SHAPE OF THE FLOW, verified against the installed .d.ts rather than
 * remembered:
 *
 *   customer  balanceUnboundTransaction(tx, keys, { ttl, tokenKindsToBalance: ['shielded','unshielded'] })
 *                -> UnboundTransactionRecipe
 *             signRecipe(recipe, sign)      -> BalancingRecipe
 *             finalizeRecipe(signed)        -> FinalizedTransaction
 *
 *   sponsor   balanceFinalizedTransaction(finalized, keys, { ttl, tokenKindsToBalance: ['dust'] })
 *                -> FinalizedTransactionRecipe
 *             signRecipe(recipe, sign)      -> BalancingRecipe
 *             finalizeRecipe(signed)        -> FinalizedTransaction
 *             submitTransaction(tx)         -> TransactionIdentifier
 *
 * `tokenKindsToBalance` is real and published: `'all' | ('dust'|'shielded'|'unshielded')[]`.
 * That was the single load-bearing assumption under decision 0001 and it holds.
 *
 * THE FAILURE MODE TO EXPECT. The two token-kind sets must not overlap. If the
 * customer balances dust, or the sponsor balances shielded, the node rejects
 * the transaction as a double spend. The sets are named as constants below
 * precisely so that nobody edits one without seeing the other.
 *
 * WHAT IS STILL UNVERIFIED. Nothing in this file has settled a transaction.
 * It is written from the published types and the Foundation's own README
 * example, and it has been executed only as far as this sandbox can reach,
 * which is not as far as a node. Treat the first real run as the test.
 *
 * THE CUSTOMER BALANCES AND RELEASES. `balanceOwnLegs` books coins at its first
 * line and had two more awaits after it with no guard around either, and the
 * interface it satisfies had no release member at all - so nothing above it
 * could let go of what it booked. Both halves are closed: the method releases
 * its own booking when signing or finalising throws, and the layer that owns
 * both phases can release one that was abandoned after this method returned.
 * These are a company's coins rather than our fee budget, which is why the
 * member is required rather than optional.
 */
import type { TxRef } from '../core/ledger.js';
import type { CustomerWallet } from './providers.js';

/* ------------------------------------------------------------------ *
 * the two halves of the split, named once
 * ------------------------------------------------------------------ */

/**
 * What the customer balances. Their own legs, and never dust.
 *
 * The customer wallet does not hold NIGHT and is not registered for DUST
 * generation, so it has no dust to offer even if it tried.
 */
export const CUSTOMER_TOKEN_KINDS = ['shielded', 'unshielded'] as const;

/**
 * What the sponsor balances. Dust only.
 *
 * Adding 'shielded' here would re-balance a kind the customer already
 * balanced, which is a double spend. This is the line to look at first when a
 * transaction is rejected for no obvious reason.
 */
export const SPONSOR_TOKEN_KINDS = ['dust'] as const;

/**
 * The subset of `WalletFacade` we actually use.
 *
 * Declared structurally rather than imported as a class so that this module
 * has no runtime dependency on the wallet SDK: the product can be built,
 * type-checked and unit tested without it, and the concrete facade is injected
 * by whatever is driving it (testkit in scripts, a browser wallet in the
 * hosted product, an HSM-backed signer in production).
 */
export interface BalancingWallet {
  balanceUnboundTransaction(tx: unknown, secretKeys: unknown, options: { ttl: Date; tokenKindsToBalance?: unknown }): Promise<unknown>;
  balanceFinalizedTransaction(tx: unknown, secretKeys: unknown, options: { ttl: Date; tokenKindsToBalance?: unknown }): Promise<unknown>;
  signRecipe(recipe: unknown, signSegment: (data: Uint8Array) => unknown): Promise<unknown>;
  finalizeRecipe(recipe: unknown): Promise<unknown>;
  submitTransaction(tx: unknown): Promise<string>;
  /**
   * Lets go of coins a balance marked in-flight.
   *
   * **REQUIRED, NOT OPTIONAL, AND FOR THE SAME REASON THE FEE PAYER'S SEAM
   * MADE ITS OWN REQUIRED.** An optional member means a wallet can be wired in
   * with no way to release, and every layer above carries on as though there
   * were one. Balancing books; nothing releases by time; and a transaction that
   * was balanced and never submitted never gets an answer from the chain for
   * the vendor's own cleanup to act on.
   *
   * It takes the recipe or the transaction, because which is in hand depends on
   * how far the attempt got.
   */
  revert(booking: unknown): Promise<void>;
}

/** The secret material a facade needs to balance. Opaque to us on purpose. */
export interface WalletSecrets {
  shieldedSecretKeys: unknown;
  dustSecretKey: unknown;
}

/** Signs the unshielded segment. A keystore, or later an HSM. */
export type SegmentSigner = (data: Uint8Array) => unknown;

/* ------------------------------------------------------------------ *
 * customer
 * ------------------------------------------------------------------ */

/**
 * A customer wallet that balances only what it owns.
 *
 * The customer never learns DUST exists. That is not a nicety: it is the
 * product claim. If this class ever needs a dust key to work, the sponsorship
 * design has failed and decision 0001 needs rewriting rather than patching.
 */
export class SponsoredCustomerWallet implements CustomerWallet {
  constructor(
    private wallet: BalancingWallet,
    private secrets: WalletSecrets,
    private sign: SegmentSigner,
    private keys: { coinPublicKey: string; encryptionPublicKey: string },
  ) {}

  coinPublicKey(): string {
    return this.keys.coinPublicKey;
  }

  encryptionPublicKey(): string {
    return this.keys.encryptionPublicKey;
  }

  /**
   * Phase 1. Balance the shielded and unshielded legs, sign them, and finalise
   * so the sponsor has something it can add dust to.
   *
   * **THIS METHOD BOOKS COINS AT ITS FIRST LINE AND THEN HAS TWO MORE AWAITS,
   * AND UNTIL THIS GUARD EXISTED NEITHER OF THEM COULD LET GO.** Either can
   * throw - a keystore that refuses to sign, a proof that will not build - and
   * the booking stood afterwards for ever: nothing releases it by time, and the
   * vendor's own cleanup only acts on transactions the chain answered for,
   * which one that was never submitted never gets. **These are the COMPANY'S
   * coins, on a device we do not operate**, so the repair is a resync somebody
   * has to be asked to perform rather than anything this product can do.
   *
   * The shape is the fee payer's, line for line, and deliberately so: one
   * window, one answer, and a reader who has understood one has understood
   * both.
   */
  async balanceOwnLegs(tx: unknown, ttl: Date): Promise<unknown> {
    const recipe = await this.wallet.balanceUnboundTransaction(tx, this.secrets, {
      ttl,
      tokenKindsToBalance: [...CUSTOMER_TOKEN_KINDS],
    });
    /*
     * **FROM THIS LINE THE COINS ARE BOOKED**, so every way out of the rest of
     * this method has to release them.
     *
     * The booking named is the recipe the balance produced, which is what the
     * vendor's release looks a booking up by. **On this path - the UNBOUND one
     * - the balance also mutates the transaction it was handed**, so the recipe
     * and the transaction are two views of one booking rather than two
     * bookings; naming the recipe is naming the thing the balance returned,
     * which is the only handle this method is given.
     */
    try {
      const signed = await this.wallet.signRecipe(recipe, this.sign);
      return await this.wallet.finalizeRecipe(signed);
    } catch (e) {
      /* Swallowed HERE rather than inside the release: `e` names what actually
       * went wrong, and a complaint about tidying up in its place sends whoever
       * reads it to the wrong layer. */
      try { await this.release(recipe); } catch { /* see above */ }
      throw e;
    }
  }

  /**
   * **IT REPORTS ITS OWN FAILURE, AND THE SWALLOW LIVES AT THE CALL SITES THAT
   * HAVE AN ORIGINAL FAILURE TO PROTECT.**
   *
   * A release that fails must never replace the failure that caused it, which
   * is a property of the path this is called on rather than of the release. So
   * the guard above swallows, by name, and the layer that owns both phases
   * swallows too - and a caller with nothing to protect is told the truth,
   * because a release that cannot fail is a release nobody can assert on.
   *
   * **IT IS PUBLIC BECAUSE THE WINDOW IT GUARDS IS NOT ONLY INSIDE THIS
   * CLASS.** The balance above is one of two calls the layer that owns both
   * phases makes; what goes wrong between them goes wrong where this method is
   * not running, so that layer has to be able to say *let that go*.
   */
  async release(booking: unknown): Promise<void> {
    await this.wallet.revert(booking);
  }
}

/* ------------------------------------------------------------------ *
 * sponsor
 * ------------------------------------------------------------------ */

/**
 * **A SPONSOR THAT BOOKS COINS AND NEVER RELEASES THEM. IT IS NOT THE LIVE ONE
 * AND IT MUST NEVER BE IMPORTED AS THOUGH IT WERE.**
 *
 * The live fee sponsor is in `sponsor.ts`. It carries the release logic: every
 * path that balances and does not submit lets the booking go, because balancing
 * marks coins in-flight and nothing releases them by time.
 *
 * **THIS ONE DOES NOT, AND ITS TWO METHODS ARE WHY THIS RENAME HAPPENED.**
 * `addFeeAndFinalise` books at its first line and has two awaits after it with
 * no guard around either; `submit` has none. The class carried the SAME NAME as
 * the live one and satisfied the same interface, so an import fixed to this
 * module compiled, passed every boundary check there is, and silently deleted
 * every release - in the one component in this system with spend authority.
 *
 * **IT NO LONGER DECLARES `FeeSponsor`, AND THAT IS THE SECOND HALF OF THE
 * PROTECTION RATHER THAN AN OVERSIGHT.** A rename stops the wrong import being
 * plausible; dropping the declaration stops it being possible, because this
 * class can no longer be passed anywhere a fee payer is expected. Adding the
 * missing member instead would have written a release nothing exercises, into
 * the one class that spends - which is the failure this file already is.
 *
 * **WHY THE FILE IS STILL HERE AT ALL.** `SponsoredCustomerWallet` above is the
 * only implementation of `CustomerWallet` in this repository, and the customer
 * half is one of the pieces a deployment needs before anything can be balanced
 * or submitted at all. The sponsor below is kept beside it, renamed, until the
 * round that supplies that capability has said what it took from this file.
 */
export class SponsorWithoutRelease {
  constructor(
    private wallet: BalancingWallet,
    private secrets: WalletSecrets,
    private sign: SegmentSigner,
    /** Reports remaining capacity so M-6 has something to alarm on. */
    private readCapacity: () => Promise<{ dust: bigint; night: bigint }>,
  ) {}

  /** Phase 2. Add the dust leg and finalise. Dust only. */
  async addFeeAndFinalise(customerFinalised: unknown, ttl: Date): Promise<unknown> {
    const recipe = await this.wallet.balanceFinalizedTransaction(customerFinalised, this.secrets, {
      ttl,
      tokenKindsToBalance: [...SPONSOR_TOKEN_KINDS],
    });
    const signed = await this.wallet.signRecipe(recipe, this.sign);
    return this.wallet.finalizeRecipe(signed);
  }

  /** Phase 3. Whoever pays the fee submits. */
  async submit(finalisedTransaction: unknown): Promise<TxRef> {
    const id = await this.wallet.submitTransaction(finalisedTransaction);
    return { ref: id, at: new Date().toISOString() } as TxRef;
  }

  capacity(): Promise<{ dust: bigint; night: bigint }> {
    return this.readCapacity();
  }
}
