/**
 * **WHO MAY APPROVE EACH VAULT'S RUNS ONCE A SIGNER IS REMOVED, COUNTED AT THE BANDS IN FORCE.** One count for every
 * check of a removal, the wallet's early check and the device's check before each send alike, so neither passes what the
 * other refuses. The approvers come from the caller's own read of the company's roster and the chain; the bands from the
 * spending policies the company's records hold and the chain names. A policy in force this device cannot open is refused,
 * never left out.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import { withBandsInForce, type ApproverRoster, type BandInForce } from '../../../src/core/vault-approvers.js';
import type { GovernanceDoors } from './governed-call-on-device.js';
import { NotOpenedOnThisDevice } from './round-opened-here.js';
import { bandsInForceHere } from './spending-policy-here.js';

/** What the count reads: who may approve, the company's records, and the account they are read for. */
type RemovalApproversDoors = Pick<GovernanceDoors, 'approvers' | 'records' | 'accountId'>;

/**
 * The bands of every spending policy in force, for a removal: a removal takes
 * approvers away, so a vault is counted at its top band, and a policy in force
 * this device cannot open is refused rather than left out (`bandsInForceHere`,
 * strict). Refuses, with nothing sent, a page that cannot read the policies.
 */
async function bandsForARemovalHere(doors: RemovalApproversDoors, viewingKey: KeysHeld): Promise<readonly BandInForce[]> {
  if (doors.records?.spendingPolicies === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s spending policies, so it cannot count who approves each '
      + 'vault\'s runs at its bands once this signer is removed. Nothing was sent. Reload the page to get the current version.');
  }
  return bandsInForceHere({ records: doors.records, accountId: doors.accountId, viewingKey }, { strict: true });
}

/** The approvers once a signer is removed, each vault counted at the highest band of a policy in force on it. */
export const removalApproversHere = async (doors: RemovalApproversDoors, viewingKey: KeysHeld): Promise<ApproverRoster> =>
  withBandsInForce(await doors.approvers(), await bandsForARemovalHere(doors, viewingKey));
