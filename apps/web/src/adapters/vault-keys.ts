import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import type { Account } from '../../../../src/core/types.js';
import { api, companyKeysForVaults, currentUser, recordsKeyFromTheWallet } from 'vaults-web-shared/keyring.js';
import { fileOwnDirectoryEntry, giveVaultKeys } from 'vaults-web-shared/vault-page-doors.js';
import { ACT_REFUSAL, ACTED, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * A SIGNER'S VAULT KEYS, GIVEN FOR A COMPANY, the one way every page gives
 * them: the company's keys released by the person's account first, then their
 * records key signed by their account for the seat their own key makes, then this
 * signer's vault keys, signed with their own key, sent with the company's
 * viewing key. The service keeps the first set a signer gives, and takes the
 * account's statement again whenever it is given again, so it follows the seat.
 * In the same press the account signs this signer's entry in the company's
 * seat directory - their filing key, their records key and their seat - and it
 * is filed once the account is held by its committee, unless the directory
 * already holds exactly that entry.
 */

/** What giving the keys hands back: the account's release, and its signed statement with who holds the company. */
type Given = Awaited<ReturnType<typeof companyKeysForVaults>> & { signed: Awaited<ReturnType<typeof recordsKeyFromTheWallet>> };

/** This signer's own part: who they are on the roster, the key they sign with, and what their seat is made from. */
interface SignerKeys { readonly signerId: string; readonly signingSecret: Hex; readonly blinding: Hex; readonly scope?: Hex }

/**
 * GIVE THE VAULT KEYS of `signer` for the company `companyId`. The keys the
 * account released, and its signed statement with who holds the company now as
 * it read it, are handed back for what follows. Refused before the account is
 * asked for anything - before the company's keys are released - when the
 * company's records name no seat for this signer (`noSeat`), or a seat their
 * own key does not make (`notYourSeat`).
 */
export async function giveTheVaultKeys(
  companyId: string, signer: SignerKeys, viewingKey: Hex, roster: () => Promise<Pick<Account, 'signers'>>,
): Promise<{ of: typeof ACTED.refused; why: ActRefusal } | (Given & { of: typeof ACTED.done })> {
  /*
   * This signer's seat, worked out from their own key material and not taken from the records the service serves:
   * the records must name the same one, and the account checks it against the seats the chain holds. Both are
   * asked of this device alone, so a signer with no seat, or the wrong one, is refused before any account prompt.
   */
  const named = (await roster()).signers.find((s) => s.id === signer.signerId && s.status === 'active')?.leafCommitment ?? null;
  if (named === null) return { of: ACTED.refused, why: ACT_REFUSAL.noSeat };
  const scope = signer.scope === undefined ? {} : { scope: signer.scope };
  const seat = (await (await theVaultBuilder()).ownSeat({ signingSecret: signer.signingSecret, blinding: signer.blinding, ...scope })).toLowerCase();
  if (seat !== named.toLowerCase()) return { of: ACTED.refused, why: ACT_REFUSAL.notYourSeat };
  const person = currentUser()?.id ?? null;
  if (person === null) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
  const released = await companyKeysForVaults(companyId, ACCOUNT_ORIGIN);
  const signingKey = signingPublicKeyOf(signer.signingSecret).toLowerCase();
  const signed = await recordsKeyFromTheWallet(ACCOUNT_ORIGIN, { company: released.company, account: released.account, seat, signingKey });
  await giveVaultKeys(api, companyId, {
    committeeKey: released.committeeKey, companyKey: released.companyKey, signingSecret: signer.signingSecret,
    signerId: signer.signerId, viewingKey, recordsKey: signed.statement,
  });
  /*
   * The answer was read against this filing key, so it carries the entry; a wallet that signed none is refused there.
   * An entry is believed only once the account is held by the committee that lists this signer's key, so it is filed
   * from the first press after that, as the wallet read who holds the account in this same press.
   */
  const mine = signed.committeeKey;
  if (signed.seats.committee.some((k) => k.tag === mine.tag && k.value.toLowerCase() === mine.value.toLowerCase())) {
    await fileOwnDirectoryEntry(api, companyId, person, released.company, { committeeKey: signed.committeeKey, entry: signed.entry! });
  }
  return { of: ACTED.done, ...released, signed };
}
