import type { KeysHeld } from '../../../src/core/company-key.js';
import type { AssetId } from '../../../src/core/assets.js';
import type { PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { approveOnDevice, type GovernedCallDoors, type RoundOnThePage } from './governed-call-on-device.js';
import { raiseOneOffHere, type OneOffAsked, type OneOffRaiseDoors } from './one-off-raised-here.js';
import { chargeTheRunHere, type ChargeDoors } from './run-charged-here.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { spendingPolicyHere } from './spending-policy-here.js';

/*
 * THE ONE-OFF PAYMENT'S SHARED STEPS AS THE WALLET CALLS THEM, each handed the company's keys this device holds as
 * `keys`. The shared steps take those keys under the field the indexer uses for a wallet's viewing key, a name the
 * wallet's own source never spells, so that nothing in the wallet can be the call that hands an indexer a viewing key.
 * Each function here passes its arguments on unchanged and decides nothing itself.
 */

/** Raises a one-off payment (`raiseOneOffHere`), sealing its proposal and record under `keys`. */
export const raiseOneOffWith = (doors: OneOffRaiseDoors, input: OneOffAsked, keys: KeysHeld): Promise<RoundOnThePage> =>
  raiseOneOffHere(doors, { ...input, viewingKey: keys });

/** Approves a proposal from this seat (`approveOnDevice`), opening its round with `keys`. */
export const approveWith = (doors: GovernedCallDoors, round: RoundOnThePage, keys: KeysHeld): Promise<RoundOnThePage> =>
  approveOnDevice(doors, { round, viewingKey: keys });

/** Charges a one-off to its vault's period when the vault has a spending policy (`chargeTheRunHere`), reading the records with `keys`. */
export const chargeWith = (
  doors: ChargeDoors & { readonly records: CompanyRecordsHere; readonly accountId: string }, keys: KeysHeld,
  run: { readonly order: PrivatePaymentOrderOnTheWire; readonly proposalId: string },
): ReturnType<typeof chargeTheRunHere> => chargeTheRunHere({ ...doors, viewingKey: keys }, run);

/** Where the vault's spending policy for this currency stands (`spendingPolicyHere`), its record opened with `keys`. */
export const spendingPolicyWith = (
  records: CompanyRecordsHere, accountId: string, keys: KeysHeld, payment: { readonly vault: string; readonly asset: AssetId },
): ReturnType<typeof spendingPolicyHere> => spendingPolicyHere({ records, accountId, viewingKey: keys }, payment);
