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
 */
import type { TxRef } from '../core/ledger.js';
import type { FeeSponsor } from './ledger.js';
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
   */
  async balanceOwnLegs(tx: unknown, ttl: Date): Promise<unknown> {
    const recipe = await this.wallet.balanceUnboundTransaction(tx, this.secrets, {
      ttl,
      tokenKindsToBalance: [...CUSTOMER_TOKEN_KINDS],
    });
    const signed = await this.wallet.signRecipe(recipe, this.sign);
    return this.wallet.finalizeRecipe(signed);
  }
}

/* ------------------------------------------------------------------ *
 * sponsor
 * ------------------------------------------------------------------ */

/**
 * The sponsor. Holds NIGHT, therefore generates DUST, therefore pays.
 *
 * This is the only component in the system with spend authority, which is why
 * `FeeSponsor` is a narrow interface and why this implementation should stay
 * small enough to read in one sitting.
 */
export class WalletFeeSponsor implements FeeSponsor {
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
