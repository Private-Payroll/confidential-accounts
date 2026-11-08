import { keyInForce, keysHeld, type KeysHeld } from '../../../src/core/company-key.js';
import { openVaultKeysOffer, vaultKeysOfferRefusal, type OpenedVaultKeysOffer, type VaultKeysOffer } from '../../../src/core/vault-keys.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';


/**
 * **A SIGNER'S KEPT VAULT-KEYS OFFER, OPENED AND CHECKED, THE ONE WAY EVERY CALLER DOES IT.**
 *
 * The offer is opened under each key of the company this device holds, newest first as `keysHeld` lists them, and under
 * the key in force when none of those opens it. What opens is then held to the company it names (`vaultKeysOfferRefusal`).
 * The answer is the opened offer, or the text of why it is refused: the fold files that text as the reason, and the page
 * that only reports readiness leaves the offer out. Whether the offer's entry matches the roster is the fold's to judge.
 */
export function vaultKeysOfferOpened(
  accountId: string, kept: VaultKeysOffer, viewingKey: KeysHeld, label: CompanyLabel, account: AccountAddress,
): OpenedVaultKeysOffer | string {
  const opened = keysHeld(viewingKey).map((k) => openVaultKeysOffer(accountId, kept, k)).find((o) => typeof o !== 'string')
    ?? openVaultKeysOffer(accountId, kept, keyInForce(viewingKey));
  if (typeof opened === 'string') return opened;
  return vaultKeysOfferRefusal(label, account, accountId, opened) ?? opened;
}
