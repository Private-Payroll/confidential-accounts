import { vaultKeysOfferOpened } from 'vaults-web-shared/vault-keys-offer-opened.js';
import type { OpenedVaultKeysOffer, VaultKeysOffer } from '../../../../src/core/vault-keys.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { CompanyKeys } from '../../../../src/core/company-key.js';

/**
 * THE VAULT-KEY OFFERS OPEN ON THE SERVICE THIS DEVICE CAN OPEN, by the seat each is for: `served` is the service's answer
 * for the company's open offers. An offer counts only when it opens under a key the company holds, is the shape of an offer,
 * and carries a directory entry and vault keys the signer's own wallet and key signed for this company
 * (`vaultKeysOfferRefusal`): the one opening and check, `vaultKeysOfferOpened`, that the fold makes before it files one into the roster. Whose offer it
 * is, and whether its seat is believed, are for the reader to check.
 */
export function offersOpenHere(
  companyId: string, served: unknown, viewingKey: CompanyKeys, label: CompanyLabel, account: AccountAddress,
): ReadonlyMap<string, OpenedVaultKeysOffer> {
  const offers = (served as { offers?: unknown } | null)?.offers;
  const kept = Array.isArray(offers) ? offers as VaultKeysOffer[] : [];
  const open = new Map<string, OpenedVaultKeysOffer>();
  for (const offer of kept) {
    const seat = (offer?.seat ?? '').toLowerCase();
    try {
      const opened = vaultKeysOfferOpened(companyId, offer, viewingKey, label, account);
      if (typeof opened === 'string') continue;
      open.set(seat, opened);
    } catch {
      /* An offer this device cannot read is not counted. */
    }
  }
  return open;
}
