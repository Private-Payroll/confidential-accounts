/**
 * **A SIGNER'S VAULT KEYS, FOLDED INTO THE ROSTER AS A SEAT THE COMPANY BELIEVES
 * FOLDS THEM FROM ITS DEVICE**, for the tests here that drive a vault rather
 * than the fold. The keys are checked as the fold checks them
 * (`rosterWithVaultKeys`: signed for the signer's own entry by the signing key
 * it holds, and a records-key statement only for the seat it holds) and written
 * where these tests keep the roster, with the index made from it. This stands
 * in for the device's filing; the offer and the fold themselves, over the
 * served routes, are driven in `src/server/vault-keys-are-offered-and-folded.test.ts`.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { openAccount, sealAccount } from '../../src/core/account.js';
import { rosterWithVaultKeys, vaultKeyIndexOf, type CompanyVaultKeyIndex, type SignedVaultKeys } from '../../src/core/vault-keys.js';
import type { SealedAccount } from '../../src/core/types.js';
import type { Hex } from '../../src/core/crypto.js';

interface RosterStore {
  getAccount(accountId: string): SealedAccount | null;
  putAccount(a: SealedAccount): void;
  putVaultKeyIndex(k: CompanyVaultKeyIndex): void;
}

export const keysFoldedIntoTheRoster = async (
  store: RosterStore, accountId: string, viewingKey: string, label: CompanyLabel | string, account: string,
  signerId: string, keys: SignedVaultKeys,
): Promise<void> => {
  const rec = store.getAccount(accountId)!;
  const next = rosterWithVaultKeys(openAccount(rec, viewingKey as Hex), accountId, label as CompanyLabel, account as AccountAddress, signerId, keys);
  if (next === 'already-given') return;
  store.putAccount(sealAccount(next, viewingKey as Hex, rec.pendingSigners, rec.keyEpoch));
  store.putVaultKeyIndex(vaultKeyIndexOf(next));
};
