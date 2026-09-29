import type { Hex } from '../../../../src/core/crypto.js';
import { api, companyKeysForVaults } from 'vaults-web-shared/keyring.js';
import { giveVaultKeys } from 'vaults-web-shared/vault-page-doors.js';
import { ACCOUNT_ORIGIN } from './session.js';

/*
 * A SIGNER'S VAULT KEYS, GIVEN FOR A COMPANY, the one way every page gives
 * them: the company's keys released by the person's account first, then this
 * signer's vault keys, signed with their own key, sent with the company's
 * viewing key. The service keeps the first set a signer gives.
 */

/** This signer's own part: who they are on the roster and the key they sign with. */
interface SignerKeys { readonly signerId: string; readonly signingSecret: Hex }

/** GIVE THE VAULT KEYS of `signer` for the company `companyId`; the keys the account released are handed back for what follows. */
export async function giveTheVaultKeys(companyId: string, signer: SignerKeys, viewingKey: Hex) {
  const released = await companyKeysForVaults(companyId, ACCOUNT_ORIGIN);
  await giveVaultKeys(api, companyId, {
    committeeKey: released.committeeKey, companyKey: released.companyKey, signingSecret: signer.signingSecret,
    signerId: signer.signerId, viewingKey,
  });
  return released;
}
