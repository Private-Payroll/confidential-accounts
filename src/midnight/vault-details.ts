/**
 * WHICH OF THE VAULT'S TWO DETAILS CIRCUITS BELONGS TO WHICH KIND OF PAYEE.
 *
 * A run's leaf is the payment's details hashed with the payee's own secret, and
 * the DETAILS are the vault's own commitment over a recipient, a token, an
 * amount and a blinding. The vault has two of those circuits — one for a
 * shielded recipient and one for a public one — under different domain
 * separators, deliberately, so that a leaf built for one kind cannot satisfy the
 * other.
 *
 * **THE PAIRING IS THE HAZARD AND IT IS WRITTEN HERE ONCE.** The mapping is two
 * lines and the two lines are one mistake apart: bind `shielded` to the
 * unshielded circuit and every leaf in every run is built for the wrong door.
 * The contract refuses the payment, so no money moves — but the refusal arrives
 * as *"that payee is not in the approved run"*, after the signatures are in and
 * the fee is spent, naming nobody. So the mapping lives in one function that
 * both the product and its fixtures call, rather than being retyped wherever a
 * `DetailsOfKind` is needed.
 *
 * **THE CIRCUITS THEMSELVES ARE THE COMPILED CONTRACT'S OWN AND ARE NEVER
 * REIMPLEMENTED.** The vault owns what turns a payment into thirty-two opaque
 * bytes, because the vault is the only contract that ever sees a recipient. A
 * second derivation anywhere builds a tree the chain rejects.
 *
 * **THE VAULT'S GENERATED MODULE IS REACHED BY A DYNAMIC IMPORT**, matching
 * every other place in this folder that needs it. **WHAT THAT BUYS IS EXACTLY
 * ONE THING AND IT IS WORTH BEING PRECISE ABOUT, BECAUSE THE OBVIOUS READING IS
 * WRONG:** it does not keep the module out of a bundle — a build that can reach
 * this file still emits the vault's compiled contract and its WebAssembly. What
 * it keeps out is the EVALUATION at load time, which is the failure that once
 * left a page blank: generated glue that throws while it is still being
 * evaluated takes down everything that imported it, whether or not anything ever
 * calls it. **What keeps this file out of the browser page is that the page
 * never imports it**, and there is an assertion over the page's module graph
 * that says so.
 */
import type { DetailsOf, DetailsOfKind } from './payout-tree.js';

/** The shape this file needs from the vault's compiled contract, and no more. */
export interface VaultDetailsCircuits {
  payoutDetails: DetailsOf;
  unshieldedPayoutDetails: DetailsOf;
}

/**
 * THE MAPPING. One function, so there is one place where a kind is bound to a
 * circuit and one place to read to check it.
 *
 * Frozen, because a `DetailsOfKind` handed to a run builder decides which door
 * every payee's money can come out of, and a value that can be edited after it
 * is handed over is a value that can be edited between two runs.
 */
export const detailsOfKind = (circuits: VaultDetailsCircuits): DetailsOfKind =>
  Object.freeze({
    shielded: circuits.payoutDetails,
    unshielded: circuits.unshieldedPayoutDetails,
  });

/**
 * The pairing over the vault contract this build was compiled against.
 *
 * Asynchronous because of the dynamic import above it, and that is the whole of
 * the difference from `detailsOfKind`.
 */
export const vaultDetailsOf = async (): Promise<DetailsOfKind> => {
  const { pureCircuits } = await import('../../contracts/managed-vault/contract/index.js');
  return detailsOfKind(pureCircuits as unknown as VaultDetailsCircuits);
};
