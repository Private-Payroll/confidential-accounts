/**
 * The company's wallet when it balances its own legs of a transaction the service builds: the shielded and
 * unshielded coins it holds, and never DUST, which the fee payer adds afterwards. Written against the wallet
 * SDK's own `WalletFacade` methods, so the token kinds each balance may touch are checked by the type checker.
 * The two sets of token kinds never overlap: a kind balanced by both sides is spent twice, and the node refuses
 * the transaction. A booking this wallet makes is released whenever signing or finalising fails.
 */
import type { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import type { CustomerWallet, Serializable } from './providers.js';

/**
 * What the company balances: its own shielded and unshielded legs, never DUST. The company's wallet holds no
 * NIGHT registered for DUST, so it has none to offer.
 */
export const CUSTOMER_TOKEN_KINDS = ['shielded', 'unshielded'] as const;

/**
 * What the fee payer balances: DUST only. Adding a kind the company already balanced would spend it twice, and
 * the node refuses the transaction; adding a kind the company did not balance would spend the fee payer's own.
 */
export const SPONSOR_TOKEN_KINDS = ['dust'] as const;

/** The part of the wallet SDK's facade a balancing wallet uses, typed by the facade's own signatures. */
export type BalancingWallet = Pick<
  WalletFacade,
  'adoptTransaction' | 'balanceUnboundTransaction' | 'signRecipe' | 'finalizeRecipe' | 'revert'
>;

/** What a balance booked, as the wallet SDK releases it: the recipe, or the transaction it became. */
export type Booking = Parameters<WalletFacade['revert']>[0];

/** Signs the company's unshielded segment: its keystore. */
export type SegmentSigner = Parameters<WalletFacade['signRecipe']>[1];

/**
 * A company's wallet that balances only what it owns. Its answer is the wallet SDK's sealed, finalised handle,
 * which the fee payer adds DUST to; the company never holds or spends DUST itself.
 */
export class SponsoredCustomerWallet implements CustomerWallet {
  constructor(
    private wallet: BalancingWallet,
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
   * Balances the company's shielded and unshielded legs of `tx`, signs them and finalises, answering the sealed
   * handle the fee payer adds DUST to. The balance books the company's coins; if signing or finalising then
   * fails, the booking is released before the failure is passed on, so no coin is left marked as spent.
   */
  async balanceOwnLegs(tx: Serializable, ttl: Date): Promise<Serializable> {
    const handle = this.wallet.adoptTransaction(tx.serialize(), 'Unbound');
    const recipe = await this.wallet.balanceUnboundTransaction(handle, {
      ttl,
      tokenKindsToBalance: [...CUSTOMER_TOKEN_KINDS],
    });
    try {
      const signed = await this.wallet.signRecipe(recipe, this.sign);
      return await this.wallet.finalizeRecipe(signed);
    } catch (e) {
      // The failure above is what is passed on; a release that also fails must not replace it.
      try { await this.wallet.revert(recipe); } catch { /* the original failure is rethrown below */ }
      throw e;
    }
  }

  /**
   * Releases a booking this wallet made, for the layer that holds both the company's and the fee payer's
   * phases and abandons an attempt between them. Reports its own failure: the callers that have an original
   * failure to protect swallow it there.
   */
  async release(booking: Booking): Promise<void> {
    await this.wallet.revert(booking);
  }
}
