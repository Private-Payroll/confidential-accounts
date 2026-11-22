/**
 * WHICH CIRCUITS A COMPANY ACCOUNT CARRIES, BY NAME, IN ONE PLACE, AND IN WHICH
 * STEP OF ITS CREATION EACH ONE ARRIVES.
 *
 * A deploy writes every verifier key it carries, and the chain refuses a
 * transaction that writes more than the per-transaction ceiling
 * (`PER_TRANSACTION_CEILING`, derived in `scripts/dispatch-ceiling.ts`) with
 * `1010: Invalid Transaction: Transaction would exhaust the block limits`. The
 * whole account is over it, so a company is created in two steps: a deploy
 * carrying `FIRST_STEP_CIRCUITS`, then one maintenance update that inserts
 * `SECOND_STEP_CIRCUITS`. Every step is measured against the ceiling before
 * anything is paid for.
 *
 * The ceiling is derived, not calibrated: `scripts/dispatch-ceiling.ts` holds
 * the only two real submissions, `ACCEPTED_BYTES_WRITTEN` and
 * `REFUSED_BYTES_WRITTEN`, and a step between them is in a band no chain has
 * been seen to accept or refuse.
 *
 * The list of DEFERRED circuits stays, empty. A deploy leaves a circuit out
 * because that list says so, or it leaves none out: anything that reads or
 * reports the deployment reads the same lists, so a smaller deployment than the
 * one these lists describe cannot be reached by accident. If the account ever
 * grows past what its two steps can carry, a deferral goes back in here and
 * every reader inherits it.
 *
 * WHAT DEFERRED MEANS, kept so nothing downstream mistakes it if the list
 * fills again:
 *
 *   - The deployed contract HAS NO OPERATION under a deferred name. A call to
 *     one is refused by the chain itself as
 *     `MalformedTransaction::VerifierKeyNotPresent`: the ledger looks the
 *     entry point up in the deployed operations map and it is not there
 *     (`midnight-ledger` at `ledger-9.1.0.0-rc.3`, `ledger/src/verify.rs:109-124`).
 *   - They do not arrive later in the same contract. That is what separates
 *     a deferred circuit from a SECOND-STEP one (below): a company's creation
 *     inserts its second-step circuits by one maintenance update straight after
 *     the deploy (`SingleUpdate::VerifierKeyInsert`), signed by the key the
 *     deploy installed. Whoever may sign a maintenance update may change which
 *     proofs the contract accepts at any time, second step or not, and that is
 *     the maintenance authority's risk, not this list's. A deferred circuit
 *     arrives only in a NEW deployment.
 */

import { BYTES_WRITTEN_LIMIT, extrinsicCeiling } from '../../scripts/dispatch-ceiling.js';

/**
 * The twenty-three circuits a finished company account carries: every circuit
 * the contract has. **They do not fit one deploy**: the whole account in one
 * deploy is over the per-transaction ceiling. So a company is created in two
 * steps, a deploy carrying `FIRST_STEP_CIRCUITS` and then one maintenance update
 * that only inserts `SECOND_STEP_CIRCUITS`. This list is what the account
 * carries once both have landed, and every reader that asks "which circuits
 * does a company have" reads it. `retireVault` is in it because the vault calls
 * `account.retireVault(...)` and retirement is a vault's only ending.
 *
 * Sorted, and kept sorted, so a diff of this list is a diff of the deployment.
 */
export const DEPLOYED_CIRCUITS = [
  'adopt',
  'anchor',
  'approve',
  'approveVaultChange',
  'cancel',
  'clearRun',
  'closeExpiredRun',
  'holdRun',
  'propose',
  'proposeCompanyChange',
  'recordBatchFromVault',
  'recordPaymentFromVault',
  'recoverAnchor',
  'releaseHold',
  'removeSignerAndSetThreshold',
  'reseatSigner',
  'retireVault',
  'sealPayKey',
  'seatInvited',
  'setPolicy',
  'setPolicyBar',
  'setThreshold',
  'setVaultThreshold',
] as const;

/**
 * NOTHING IS DEFERRED: every circuit arrives in one of the two creation steps.
 *
 * Kept as a list rather than deleted. The checks below are what make a
 * smaller-than-decided deployment impossible to reach by accident, and an empty
 * list says the current contract needs none of them, not that they were
 * removed. Everything that reads it derives its behaviour from the list, so
 * refilling it is the whole of deferring a circuit again.
 */
export const DEFERRED_CIRCUITS: readonly string[] = [];

export type DeployedCircuit = (typeof DEPLOYED_CIRCUITS)[number];

/**
 * THE FIRST STEP: THE CIRCUITS THE DEPLOY ITSELF CARRIES. Everything a company
 * needs to exist and to govern itself: seat a signer an invitation names and
 * remove signers, raise (a run, or a change to the company through its own
 * circuit), approve and withdraw proposals, set its threshold, adopt a vault.
 * Measured with the ledger's own cost function over the deploy itself, unproven
 * and unbalanced, with this build's own keys: the nine write 25,087 bytes,
 * 78.4% of the 31,997 ceiling, 6,910 bytes of headroom, and the second step
 * 30,078. Read each as about ±260 once proven and balanced, which stays below
 * the largest deploy a chain has accepted. Neither the invited seat nor `proposeCompanyChange` can go in
 * the second step instead: with either, that update writes over the ceiling
 * (32,227 bytes with `proposeCompanyChange`).
 *
 * **WHY THESE NINE AND NOT MORE THAT WOULD FIT.** The second step
 * carries every circuit that moves money or depends on a vault's receipt: a
 * company whose second step never lands can seat its signers and approve
 * proposals, and can pay nothing, because the chain refuses a call to an
 * operation the contract does not hold. It fails closed. `proposeCompanyChange`
 * moves no money and opens nothing a payment can be recorded against, so it
 * keeps that. The room left in the deploy is kept for the circuits the next
 * contract changes add.
 */
export const FIRST_STEP_CIRCUITS = [
  'adopt',
  'approve',
  'cancel',
  'closeExpiredRun',
  'propose',
  'proposeCompanyChange',
  'removeSignerAndSetThreshold',
  'seatInvited',
  'setThreshold',
] as const satisfies readonly DeployedCircuit[];

/**
 * THE SECOND STEP: THE CIRCUITS ONE MAINTENANCE UPDATE INSERTS, straight after
 * the deploy, signed by the maintenance authority the deploy installed. It only
 * inserts: it never removes a key and never replaces the authority. Measured the
 * same way: 30,078 bytes written for the fourteen keys, 94.0% of the ceiling,
 * which leaves no room for a fifteenth key of the size the others are. The
 * step that approves a change to a vault, `approveVaultChange`, the
 * spending policy's circuits, `setPolicy`, `setPolicyBar` and `clearRun`, the
 * hold and its release, and the re-seat that changes a signer's rights are here
 * with the other circuits that move money or depend on a vault, and so is the
 * batch's receipt, `recordBatchFromVault`. So is `anchor`, which moves the
 * company's record anchor on, and `recoverAnchor`, by which a quorum moves it past
 * a batch nobody can check: the deploy has no room for them, and nothing a
 * company does before its second step lands needs its records anchored.
 */
export const SECOND_STEP_CIRCUITS = [
  'anchor',
  'approveVaultChange',
  'clearRun',
  'holdRun',
  'recordBatchFromVault',
  'recordPaymentFromVault',
  'recoverAnchor',
  'releaseHold',
  'reseatSigner',
  'retireVault',
  'sealPayKey',
  'setPolicy',
  'setPolicyBar',
  'setVaultThreshold',
] as const satisfies readonly DeployedCircuit[];

const FIRST = new Set<string>(FIRST_STEP_CIRCUITS);
const SECOND = new Set<string>(SECOND_STEP_CIRCUITS);

/** The two steps of a company's creation, as the one builder of the second step takes them. */
export const CREATION_STEPS = { first: FIRST_STEP_CIRCUITS, second: SECOND_STEP_CIRCUITS } as const;

/**
 * **THE MOST BYTES ONE TRANSACTION MAY WRITE**, derived from the node's own
 * weights, the size weight it adds to every transaction included
 * (`scripts/dispatch-ceiling.ts`). Every step of a company's creation is
 * measured against this before anything is paid for.
 */
export const PER_TRANSACTION_CEILING = extrinsicCeiling(BYTES_WRITTEN_LIMIT);

/** Why a transaction writing `bytesWritten` would be refused for its size, or null when it fits. */
export function overTheCeiling(bytesWritten: bigint | number, what: string): string | null {
  const written = Number(bytesWritten);
  if (!Number.isFinite(written) || written < 0) return `${what} could not be measured, so it is not sent. Nothing was sent.`;
  return written <= PER_TRANSACTION_CEILING
    ? null
    : `${what} writes ${written.toLocaleString('en')} bytes, more than the ${PER_TRANSACTION_CEILING.toLocaleString('en')} one `
      + 'transaction may write, so the chain would refuse it. Nothing was sent.';
}

/** Which step of a company's creation adds a circuit, or null for a name the account does not have. */
export const creationStepOf = (name: string): 1 | 2 | null =>
  FIRST.has(name) ? 1 : SECOND.has(name) ? 2 : null;

/**
 * Refuses two steps that do not add up to the whole account: a circuit in both,
 * or in neither. Called by the deploy before anything is built, so a list edited
 * on one side only stops a creation instead of leaving a company without a circuit.
 */
export function assertCreationSteps(): void {
  const both = FIRST_STEP_CIRCUITS.filter((n) => SECOND.has(n));
  const all = new Set<string>([...FIRST_STEP_CIRCUITS, ...SECOND_STEP_CIRCUITS]);
  const neither = DEPLOYED_CIRCUITS.filter((n) => !all.has(n));
  const stray = [...all].filter((n) => !(DEPLOYED_CIRCUITS as readonly string[]).includes(n));
  if (both.length > 0 || neither.length > 0 || stray.length > 0) {
    throw new Error(
      'the two steps of a company\'s creation do not add up to the account: ' +
        (both.length ? `in both steps: ${both.join(', ')}. ` : '') +
        (neither.length ? `in neither step: ${neither.join(', ')}. ` : '') +
        (stray.length ? `not circuits of the account: ${stray.join(', ')}. ` : '') +
        'Put every circuit in exactly one of FIRST_STEP_CIRCUITS and SECOND_STEP_CIRCUITS in ' +
        'src/midnight/deferral.ts, and measure the deploy against the ceiling again.',
    );
  }
}

const DEFERRED = new Set<string>(DEFERRED_CIRCUITS);
const DEPLOYED = new Set<string>(DEPLOYED_CIRCUITS);

export const isDeferredCircuit = (name: string): boolean => DEFERRED.has(name);
export const isDeployedCircuit = (name: string): boolean => DEPLOYED.has(name);

/**
 * Refuses a contract whose circuit list is not exactly the deployed and the
 * deferred circuits above.
 *
 * Called by the deploy path with the names the COMPILED contract actually
 * exports, before anything is pruned. If the contract gains a circuit, or
 * renames one, the deploy stops here with both lists printed, rather than
 * quietly deploying a shape this file no longer describes and so a deployment
 * smaller than anyone decided.
 */
export function assertKnownCircuitSet(names: string[]): void {
  const expected = [...DEPLOYED_CIRCUITS, ...DEFERRED_CIRCUITS].sort();
  const actual = [...names].sort();
  if (expected.length !== actual.length || expected.some((n, i) => n !== actual[i])) {
    throw new Error(
      `the compiled contract does not export the ${expected.length} circuits the deferral list describes.\n` +
        `  compiled: ${actual.join(', ')}\n` +
        `  expected: ${expected.join(', ')}\n` +
        'src/midnight/deferral.ts is the single definition of which circuits deploy and which ' +
        'defer. If the contract changed shape, that list must be decided again against the derived ' +
        'per-transaction ceiling (scripts/dispatch-ceiling.ts), not patched to make this error go away.',
    );
  }
}

/**
 * The error a call to a deferred circuit gets, and it names the cause.
 *
 * UNREACHABLE WHILE `DEFERRED_CIRCUITS` IS EMPTY: its only caller gates on
 * `isDeferredCircuit`, which is false for every name. It is kept because it is
 * the client-side half of the deferral, and without it a circuit deferred again
 * would get the SDK's failure instead of this one.
 *
 * Without it the failure is the SDK's: `findDeployedContract` compares every
 * compiled verifier key against the deployed state and throws
 * `ContractTypeError` naming the deferred circuits as "undefined or have
 * mismatched verifier keys", which reads as key corruption, fires on every
 * call including the ones that ARE deployed, and says nothing about deferral
 * being deliberate.
 */
export function deferredCircuitError(circuit: string): Error {
  return new Error(
    `"${circuit}" is deferred: it is one of the ${DEFERRED_CIRCUITS.length} circuits ` +
      `(${DEFERRED_CIRCUITS.join(', ')}) deliberately left out of the ` +
      `${DEPLOYED_CIRCUITS.length}-circuit deployment, because the full contract exceeds the ` +
      "chain's per-transaction write ceiling. The deployed contract has no such operation: the chain itself " +
      'would refuse the call with VerifierKeyNotPresent. These circuits arrive only in a ' +
      'future deployment; they cannot be added to this one, and no retry will change the ' +
      'answer.',
  );
}
