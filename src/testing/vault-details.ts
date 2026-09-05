import {
  pureCircuits as vaultCircuits,
} from '../../contracts/managed-vault/contract/index.js';
import type { DetailsOfKind } from '../midnight/payout-tree.js';

/**
 * THE VAULT'S TWO DETAILS CIRCUITS, AS `buildRun` TAKES THEM. `C246`, `S6k`.
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
 * is `DetailsOf`'s standing rule and `M-104`: the vault owns what turns a
 * payment into 32 opaque bytes, and a second derivation anywhere builds a tree
 * the chain rejects after the approvals are collected and the fees paid.
 *
 * It is a fixture rather than production code because production has no single
 * place holding both — the client takes them as an argument, deliberately, so
 * nothing in `src/midnight/` imports the vault's generated module to get them.
 */
export const vaultDetails: DetailsOfKind = Object.freeze({
  shielded: vaultCircuits.payoutDetails,
  unshielded: vaultCircuits.unshieldedPayoutDetails,
});
