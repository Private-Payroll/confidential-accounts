import {
  pureCircuits as vaultCircuits,
} from '../../contracts/managed-vault/contract/index.js';
import { detailsOfKind, type VaultDetailsCircuits } from '../midnight/vault-details.js';
import type { DetailsOfKind } from '../midnight/payout-tree.js';

/**
 * THE VAULT'S TWO DETAILS CIRCUITS, AS `buildRun` TAKES THEM.
 *
 * ONE DEFINITION, for `payees.ts`'s reason one file along: this pair is exactly
 * the kind of two-line object that gets retyped into the next test file that
 * needs it, and **the two lines are one hazard apart.** Swap them — `shielded`
 * bound to `unshieldedPayoutDetails` — and every leaf in every run is built for
 * the wrong door. The contract refuses the payment, so no money moves, but the
 * failure arrives as *"not in the approved run"* in whichever test happens to
 * run first, naming nothing.
 *
 * **THE CIRCUITS ARE THE COMPILED CONTRACT'S OWN, NEVER REIMPLEMENTED.** That
 * is `DetailsOf`'s standing rule: the vault owns what turns a payment into 32
 * opaque bytes, and a second derivation anywhere builds a tree the chain rejects
 * after the approvals are collected and the fees paid.
 *
 * **THIS FILE NO LONGER HOLDS THE MAPPING AND THAT IS THE POINT.** It used to
 * say that it was a fixture *because production has no single place holding
 * both*. That stopped being true the day the product could raise a run: there
 * is now one place, `src/midnight/vault-details.ts`, and this file calls it.
 * What is left here is the STATIC import — a test wants the circuits without
 * awaiting anything, and a test may have the vault's compiled contract in its
 * module graph where a browser build may not.
 */
export const vaultDetails: DetailsOfKind =
  detailsOfKind(vaultCircuits as unknown as VaultDetailsCircuits);
