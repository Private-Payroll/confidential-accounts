/**
 * **A WALLET'S SIGNED CLAIM OF AN UNSHIELDED ADDRESS, CHECKED WHERE THE LEDGER LOADS.**
 *
 * A person or vendor added by an unshielded address is paid there only with their wallet's claim of it, signed with
 * that address's key. Checking the signature needs the ledger's WebAssembly, which a page's own code never loads: a
 * page reaches this through its vault builder's worker, and the wallet, which loads the ledger, calls it directly.
 * Both run this one function, so the check is the same wherever a company's people and vendors are read.
 */
import type { AddressClaimFor, UnshieldedAddressClaim } from 'midnight-identity/profile/address-claim';
import { unshieldedClaimRefusal } from 'midnight-identity/profile/address-claim-signed';

/**
 * Why the claim does not prove the address for this company, record and payslip key on the network it is made for,
 * or null when it does. It trusts nothing in the claim: the address is derived from the claim's own verifying key and
 * the signature is checked over all of it.
 */
export const signedClaimRefusal = async (claim: UnshieldedAddressClaim, f: AddressClaimFor): Promise<string | null> =>
  unshieldedClaimRefusal(claim, f, f.network as never);
