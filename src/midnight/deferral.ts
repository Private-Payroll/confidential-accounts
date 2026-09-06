/**
 * WHICH CIRCUITS THE DEPLOYMENT CARRIES, BY NAME, IN ONE PLACE. S8c, re-decided
 * S9, and CLOSED BY S25: nothing is deferred any more.
 *
 * The history matters, because the shape of this file is the record of it. The
 * account contract used to compile fifteen circuits, then thirteen after the
 * `S11` merges, and the chain would not accept a deploy carrying them: the
 * per-extrinsic ceiling is 32,497 bytesWritten (~65% of 50,000, derived in
 * scripts/dispatch-ceiling.ts — NOT the 37,500 this file used to cite), and the
 * node refuses a deploy over it with
 * `1010: Invalid Transaction: Transaction would exhaust the block limits`.
 * `S8b` chose Option B — deploy fewer, DEFER the rest — and `S9` chose which
 * two deferred.
 *
 * `S23` SHED `credit` AND `attestSolvency` FROM THE CONTRACT ITSELF, which is
 * the reason this file no longer needs a deferred list. The contract now
 * exports TEN circuits and the deployment must carry all ten. **THE FIGURES
 * BELOW ARE THE ELEVEN-CIRCUIT MEASUREMENT AND ARE NOW STALE**: `C292`/`S26`
 * deleted `execute`, and no instrument has read the ten-circuit shape yet. The
 * door is `MEASURE-DEPLOY-SHAPE.command`, and until it is walked no number here
 * describes what would be deployed. Measured, not argued:
 * `REPORT-DEPLOY-SHAPE.txt`, 30 Aug — eleven circuits, 22,541 bytes of
 * key, 31,499 bytesWritten, 96.9% of the ceiling, 998 bytes under it, read
 * ±~260 once proven and balanced. `contracts/managed/keys/`,
 * `contracts/managed/zkir/` and `contracts/managed/compiler/contract-info.json`
 * agree on the same ten.
 *
 * **THAT HEADROOM IS AGAINST A DERIVED CEILING, NOT A CALIBRATED ONE, AND THE
 * DIFFERENCE MATTERS BEFORE A DEPLOY.** `scripts/dispatch-ceiling.ts:130,135`
 * holds the only two real submissions: 31,201 ACCEPTED, 35,748 REFUSED. At
 * 31,499 ± ~260 this deployment is between about 40 and 560 bytes ABOVE the
 * largest deploy any chain has actually accepted, inside a band nothing has
 * measured. `C219` is the row. **It fits the arithmetic; it has not been shown
 * to fit the chain**, and the deploy is the measurement.
 *
 * `docs/the-deploy-problem.md` carries the arithmetic;
 * `MEASURE-DEPLOY-SHAPE.command` re-derives it from disk.
 *
 * THIS FILE IS STILL THE DEFERRAL, and it stays even though it defers nothing.
 * `C224` is the record of how quietly-smaller nearly lied about the one number
 * the architecture was chosen on: a deploy omits a circuit because this list
 * says so, or it does not omit one at all. Anything that reads or reports the
 * deployment reads the same list. One definition, the same rule as decision
 * 0004. If a future contract grows past the ceiling again, the deferral goes
 * back in HERE and every reader inherits it.
 *
 * WHAT DEFERRED MEANS, kept so nothing downstream mistakes it if the list
 * fills again:
 *
 *   - The deployed contract HAS NO OPERATION under a deferred name. A call to
 *     one is refused by the chain itself as
 *     `MalformedTransaction::VerifierKeyNotPresent` — the ledger looks the
 *     entry point up in the deployed operations map and it is not there
 *     (`midnight-src/midnight-ledger/ledger/src/verify.rs:104-119`).
 *   - They do not arrive later in the same contract. A maintenance update
 *     could insert them (`SingleUpdate::VerifierKeyInsert`,
 *     `ledger/src/structure.rs:2692-2696`), and that path is rejected as a
 *     design: whoever may sign a maintenance update may change which proofs
 *     the contract accepts. They arrive in a NEW deployment.
 */

/**
 * The ten circuits the deployment carries — every circuit the contract has.
 *
 * `retireVault` IS IN THIS LIST, and `S25` put it there. It was deferred by
 * `S9` on the reasoning that "a vault cannot be retired on this deployment,
 * which version one accepts". Version one no longer accepts it: `C288` is the
 * row for a live account that cannot retire a vault, and shedding two circuits
 * is what bought the room to close it. `Vault.compact:1018` calls
 * `account.retireVault(...)`, and retirement is a vault's only ending.
 *
 * Sorted, and kept sorted, so a diff of this list is a diff of the deployment.
 */
export const DEPLOYED_CIRCUITS = [
  'adopt',
  'amendSigner',
  'approve',
  'cancel',
  'closeExpiredRun',
  'propose',
  'recordPayment',
  'retireVault',
  'setThreshold',
  'setVaultThreshold',
] as const;

/**
 * NOTHING IS DEFERRED.
 *
 * `S9` deferred `attestSolvency` and `retireVault`. `S23` shed `attestSolvency`
 * and `credit` from the contract, which took the contract to eleven circuits, and
 * `C292`/`S26` then deleted `execute`, which takes it to ten —
 * a shape that fits under the ceiling whole — so `retireVault` came back into
 * the deployment and this list emptied.
 *
 * IT IS KEPT AS A LIST RATHER THAN DELETED. The deferral machinery below is
 * what makes a smaller-than-decided deployment impossible to reach by accident
 *, and an empty list is the honest statement that the current contract
 * needs none of it — not that the mechanism was removed. Everything that reads
 * it derives its behaviour from the list, so refilling it is the whole of
 * re-deferring.
 */
export const DEFERRED_CIRCUITS: readonly string[] = [];

export type DeployedCircuit = (typeof DEPLOYED_CIRCUITS)[number];

const DEFERRED = new Set<string>(DEFERRED_CIRCUITS);
const DEPLOYED = new Set<string>(DEPLOYED_CIRCUITS);

export const isDeferredCircuit = (name: string): boolean => DEFERRED.has(name);
export const isDeployedCircuit = (name: string): boolean => DEPLOYED.has(name);

/**
 * Refuses a contract whose circuit list is not exactly these ten.
 *
 * Called by the deploy path with the names the COMPILED contract actually
 * exports, before anything is pruned. If the contract ever gains a twelfth
 * circuit, or renames one, the deploy stops here with both lists printed —
 * rather than quietly deploying a shape this file no longer describes. The
 * alternative failure is `C224`'s: a deployment smaller than anyone decided.
 *
 * This is the check that caught `S23`: the shed left the contract at eleven
 * while this file still named thirteen, and `MEASURE-DEPLOY-SHAPE.command`
 * refused to score the set rather than scoring the wrong one.
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
        'defer (S8b Option B; the split re-decided by S9, emptied by S25). If the contract ' +
        'changed shape, that list must be re-decided against the derived per-extrinsic ceiling ' +
        '(scripts/dispatch-ceiling.ts) — not patched to make this error go away. docs/the-deploy-problem.md has the arithmetic.',
    );
  }
}

/**
 * The error a call to a deferred circuit gets, and it names the cause.
 *
 * UNREACHABLE WHILE `DEFERRED_CIRCUITS` IS EMPTY — its only caller gates on
 * `isDeferredCircuit`, which is false for every name — and kept for that
 * reason: it is the client-side half of the deferral, and deleting it would
 * mean a future re-deferral gets the SDK's failure instead of this one.
 *
 * Without it the failure is the SDK's: `findDeployedContract` compares every
 * compiled verifier key against the deployed state and throws
 * `ContractTypeError` naming the deferred circuits as "undefined or have
 * mismatched verifier keys…" — which reads as key corruption, fires on every
 * call including the ones that ARE deployed, and says nothing about deferral
 * being deliberate.
 */
export function deferredCircuitError(circuit: string): Error {
  return new Error(
    `"${circuit}" is deferred: it is one of the ${DEFERRED_CIRCUITS.length} circuits ` +
      `(${DEFERRED_CIRCUITS.join(', ')}) deliberately left out of the ` +
      `${DEPLOYED_CIRCUITS.length}-circuit deployment, because the full contract exceeds the ` +
      "chain's per-transaction write ceiling (S8b Option B; which circuits defer was " +
      'decided by S9). The deployed contract has no such operation — the chain itself ' +
      'would refuse the call with VerifierKeyNotPresent. These circuits arrive only in a ' +
      'future deployment; they cannot be added to this one, and no retry will change the ' +
      'answer.',
  );
}
