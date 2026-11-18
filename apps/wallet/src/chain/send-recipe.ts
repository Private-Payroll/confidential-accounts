import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk-facade';
import { Transaction, nativeToken } from '@midnightntwrk/ledger-v9';
import { carriedBy } from './carried.js';

/*
 * WHAT A BALANCED RECIPE SAYS IT WILL DO, read from the recipe itself: the
 * fee it pays, what it pays one public address, and how many of its public
 * inputs carry no signature. The send engine reads these before a person is
 * asked to confirm and again before proving, so a confirmation is never read
 * from the form and a transfer the chain would refuse is never proved.
 */

/* ------------------------------------------------------- reading the recipe */

/** The recipe's own fee: every dust spend's `vFee`, summed (`DustSpend`
 * carries it). */
export const feeFromRecipe = (recipe: BalancingRecipe): bigint => {
  let fee = 0n;
  for (const tx of BalancingRecipeTransactions(recipe)) {
    for (const intent of tx.intents?.values() ?? []) {
      for (const spend of intent.dustActions?.spends ?? []) fee += spend.vFee;
    }
  }
  return fee;
};

/** STARs paid to one unshielded address, read out of the recipe's outputs
 * (`UtxoOutput.owner` and `value`). */
export const unshieldedStarsTo = (recipe: BalancingRecipe, ownerHex: string): bigint => {
  const night = nativeToken().raw;
  let stars = 0n;
  for (const tx of BalancingRecipeTransactions(recipe)) {
    for (const intent of tx.intents?.values() ?? []) {
      for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
        for (const out of offer?.outputs ?? []) {
          if (out.owner === ownerHex && out.type === night) stars += out.value;
        }
      }
    }
  }
  return stars;
};

/* The handles a recipe carries, whatever its shape — the three recipe
 * variants are the SDK's (`BalancingRecipe`). */
const handlesIn = (recipe: BalancingRecipe) => {
  switch (recipe.type) {
    case 'UNPROVEN_TRANSACTION': return [recipe.transaction];
    case 'FINALIZED_TRANSACTION': return [recipe.originalTransaction, recipe.balancingTransaction];
    case 'UNBOUND_TRANSACTION':
      return recipe.balancingTransaction
        ? [recipe.baseTransaction, recipe.balancingTransaction]
        : [recipe.baseTransaction];
  }
};

/* What this file reads of a ledger transaction: its intents' unshielded offers and DUST spends. */
interface OfferRead {
  readonly inputs?: readonly unknown[];
  readonly outputs?: readonly { readonly owner: string; readonly type: string; readonly value: bigint }[];
  readonly signatures?: readonly unknown[];
}
interface TransactionRead {
  readonly intents?: Map<number, {
    readonly guaranteedUnshieldedOffer?: OfferRead;
    readonly fallibleUnshieldedOffer?: OfferRead;
    readonly dustActions?: { readonly spends?: readonly { readonly vFee: bigint }[] };
  }>;
}

/* The ledger transactions a recipe carries. A recipe this wallet cannot read
 * in full is refused rather than read in part: a fee or a payment read from
 * half a recipe would be a confirmation of something else. */
const BalancingRecipeTransactions = (recipe: BalancingRecipe): TransactionRead[] => handlesIn(recipe).map((handle) => {
  const tx = carriedBy(handle);
  if (tx === null || typeof tx !== 'object') {
    throw new Error('this wallet could not read the transaction it built for this payment, so it shows nothing to confirm');
  }
  return tx as TransactionRead;
});

/** The identifiers of a finished transaction, read from the ledger
 * transaction its handle carries: what the chain is asked about it by. */
export const identifiersOf = (finished: unknown): string[] => {
  const tx = carriedBy(finished);
  if (!(tx instanceof Transaction)) {
    throw new Error('this wallet could not read the transaction it finished, so it did not send it');
  }
  return tx.identifiers();
};

/* ------------------------------------------------- The signature check */

/**
 * WHAT AN UNSIGNED TRANSFER LOOKS LIKE, counted.
 *
 * An unshielded input is authorised by a signature over the intent's own
 * `signatureData`. `UnshieldedOffer` carries `inputs`, `outputs` and
 * `signatures` side by side, and the chain refuses a transfer whose counts
 * do not match, in the ledger's own words:
 *
 *     unshielded offer action validation error: mismatch between number of
 *     inputs (1) and signatures (0)
 *
 * Both offers on an intent are counted: `guaranteedUnshieldedOffer` and
 * `fallibleUnshieldedOffer` — a plain transfer
 * lands in the fallible one, and reading only the guaranteed offer would
 * have found nothing to complain about.
 */
export const unsignedUnshieldedInputs = (recipe: BalancingRecipe): number => {
  let missing = 0;
  for (const tx of BalancingRecipeTransactions(recipe)) {
    for (const intent of tx.intents?.values() ?? []) {
      for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
        if (!offer) continue;
        const inputs = offer.inputs?.length ?? 0;
        const signatures = offer.signatures?.length ?? 0;
        if (inputs > signatures) missing += inputs - signatures;
      }
    }
  }
  return missing;
};
