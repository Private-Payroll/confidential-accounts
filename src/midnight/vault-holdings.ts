import type { LedgerForm } from '../core/assets.js';
import type { Hex } from '../core/crypto.js';
import type { FitAnswer, HoldingAnswer, PaymentAsked, VaultHoldings } from '../core/vault-holdings.js';
import type { Payee } from './payee-address.js';
import {
  VaultCannotAfford, VaultChainUnreadable, VaultPoolDisagreesWithChain, type VaultLedger,
} from './vault-ledger.js';

/**
 * **WHAT A VAULT HOLDS, AND WHETHER IT CAN MAKE A SET OF PAYMENTS, READ FROM THE
 * CHAIN BY THE VAULT CLIENT'S OWN READS.**
 *
 * One read per form, because the two forms have different truth conditions and
 * the vault client already keeps them apart:
 *
 *   - **public:** `unshieldedBalance`, the ledger's own figure for the contract
 *     in that token, from the indexer. Zero only when the chain published what
 *     the contract holds and the token is not among it.
 *   - **private:** `balance`, which sums the vault's notes only after the chain's
 *     set of the vault's commitments has been read and found to hold every note
 *     and nothing else.
 *
 * And whether the payments can be made is `affordable`, which reconciles the
 * same way and then walks each private payment through the note a payment
 * would spend. None of this decides anything; it only turns the client's three
 * kinds of refusal into three answers a caller cannot mistake for each other.
 */
export const chainVaultHoldings = (
  vault: Pick<VaultLedger, 'balance' | 'unshieldedBalance' | 'affordable'>,
): VaultHoldings => ({
  held: async (address: string, form: LedgerForm, token: string): Promise<HoldingAnswer> => {
    try {
      if (form === 'unshielded') return { of: 'held', amount: await vault.unshieldedBalance(address, token as Hex) };
      if (form === 'shielded') return { of: 'held', amount: await vault.balance(address, token as Hex) };
    } catch (cause) {
      if (cause instanceof VaultChainUnreadable) return { of: 'unreadable', why: cause.message };
      if (cause instanceof VaultPoolDisagreesWithChain) return { of: 'contradicted', why: cause.message };
      throw cause;
    }
    throw new Error(`"${String(form)}" is not a form money takes on Midnight`);
  },

  fits: async (address: string, payments: ReadonlyArray<PaymentAsked>): Promise<FitAnswer> => {
    try {
      /* `affordable` reads only each payee's kind, token and amount. */
      await vault.affordable(address, payments as ReadonlyArray<{ payee: Payee; token: Hex; amount: bigint }>);
      return { of: 'fits' };
    } catch (cause) {
      if (cause instanceof VaultCannotAfford) {
        /*
         * The note-level reason ends by advising a merge, and no vault can merge
         * notes, so that sentence is not passed on to a screen.
         */
        const why = ((cause as { cause?: unknown }).cause as Error | undefined)?.message
          ?.replace(/\s*Merge them first[^.]*\.?\s*$/, '');
        switch (cause.why) {
          case 'chain-unreadable': return { of: 'unreadable', why: why ?? 'the chain could not be read' };
          case 'pool-disagrees': return { of: 'contradicted', why: why ?? 'the pool and the chain disagree' };
          default: return {
            of: 'does-not-fit',
            why: why ?? 'its public balance changed between two reads and no longer covers these payments',
          };
        }
      }
      if (cause instanceof VaultChainUnreadable) return { of: 'unreadable', why: cause.message };
      if (cause instanceof VaultPoolDisagreesWithChain) return { of: 'contradicted', why: cause.message };
      throw cause;
    }
  },
});
