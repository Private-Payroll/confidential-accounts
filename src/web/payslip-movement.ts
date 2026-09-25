/**
 * **THE VALUE A COMPANY'S ACCOUNT RECORDS WHEN ONE PAYSLIP'S PAYMENT IS MADE,
 * BUILT ON THE PAYEE'S DEVICE.**
 *
 * From the address the payee's own wallet confirmed, the slip's token and
 * amount, and the payee's own nonce and blinding: the vault's details
 * commitment over the first four, the account's leaf over that and the nonce,
 * and the account's record of that leaf. The details commitment is the one for
 * the address's own kind, read off the address: `payoutDetails` for a shielded
 * address and `unshieldedPayoutDetails` for a public one, exactly as a run
 * builds its leaves. The leaf and the record are the same for both kinds, so a
 * public payment is asked about in the same account record as a private one. Every step is the compiled contract's
 * own circuit, called and never written a second way, so a value built here is
 * the value the account writes when that payment is recorded, and a receipt
 * carrying anybody else's secrets, or a slip naming another amount or token,
 * builds a value that was never recorded.
 *
 * Runs on the payslip reader's worker thread: the circuits are WebAssembly and
 * the page may not load them.
 */
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import { payeeOf, recipientOf } from '../midnight/payee-address.js';
import { isNetworkName } from '../midnight/network.js';
import type { DetailsOfKind, PayoutLeafInput } from '../midnight/payout-tree.js';
import type { PayslipPayment } from './payslip-worker-client.js';

/** The three circuits this needs, each the compiled contract's own. */
export interface PayslipCircuits {
  /** The vault's details commitments, one per kind of payee. */
  details: DetailsOfKind;
  /** The account's `payoutLeaf`. */
  leafOf: (p: PayoutLeafInput) => Hex;
  /** The account's `paidMovementOf`. */
  movementOf: (leaf: Hex) => Hex;
}

/** The value the account records when this payment is made. Throws on anything it cannot read. */
export function movementOfPayslip(circuits: PayslipCircuits, p: PayslipPayment): Hex {
  /*
   * The address is decoded by the same parse every payee address goes through,
   * on the network it names itself. A mainnet address names none, and the
   * platform's parse answers a symbol for it rather than the name.
   */
  const named: unknown = MidnightBech32m.parse(p.paidTo.trim()).network;
  const network = typeof named === 'string' ? named : 'mainnet';
  if (!isNetworkName(network)) throw new Error(`"${network}" is not a Midnight network.`);
  /* The kind is READ off the address, never taken from anything beside it. */
  const payee = payeeOf(p.paidTo, network);
  const details = toHex(circuits.details[payee.kind](
    fromHex(recipientOf(payee)), fromHex(p.token), BigInt(p.amount), fromHex(p.blinding)));
  return circuits.movementOf(circuits.leafOf({ details, nonce: p.nonce }));
}

/** The circuits of the contracts this build was compiled against, loaded the first time they are asked for. */
export const contractCircuits = async (): Promise<PayslipCircuits> => {
  const [{ payoutLeafOf, paidMovementOfLeaf }, { vaultDetailsOf }] = await Promise.all([
    import('../midnight/payout-tree.js'), import('../midnight/vault-details.js'),
  ]);
  return { details: await vaultDetailsOf(), leafOf: payoutLeafOf, movementOf: paidMovementOfLeaf };
};
