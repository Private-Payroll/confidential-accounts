import type { KeysHeld } from '../../../src/core/company-key.js';
import { keysByPurpose } from './keys-by-purpose.js';
import { openVaultKeysOffer, vaultKeysOfferRefusal, type OpenedVaultKeysOffer, type VaultKeysOffer } from '../../../src/core/vault-keys.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';


/**
 * **A SIGNER'S KEPT VAULT-KEYS OFFER, OPENED AND CHECKED, THE ONE WAY EVERY CALLER DOES IT.**
 *
 * The offer is opened under each epoch's roster key this device holds, newest first (`keysByPurpose`), and refused with
 * the newest one's reason when none opens it. What opens is then held to the company it names (`vaultKeysOfferRefusal`).
 * The answer is the opened offer, or the text of why it is refused: the fold files that text as the reason, and the page
 * that only reports readiness leaves the offer out. Whether the offer's entry matches the roster is the fold's to judge.
 */
export function vaultKeysOfferOpened(
  accountId: string, kept: VaultKeysOffer, viewingKey: KeysHeld, label: CompanyLabel, account: AccountAddress,
): OpenedVaultKeysOffer | string {
  const tried = keysByPurpose(viewingKey).everyEpoch().map((k) => openVaultKeysOffer(accountId, kept, k));
  const opened = tried.find((o) => typeof o !== 'string') ?? tried[0] ?? 'this device holds no roster key of the company to open it with';
  if (typeof opened === 'string') return opened;
  return vaultKeysOfferRefusal(label, account, accountId, opened) ?? opened;
}
