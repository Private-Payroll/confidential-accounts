import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import type { Account } from '../../../../src/core/types.js';
import {
  api, companyKeysForVaults, currentUser, directoryEntryOwed, invitedByForTheWallet, oweDirectoryEntry, recordsKeyFromTheWallet,
} from 'vaults-web-shared/keyring.js';
import { fileTheOwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { foldOffersHere, offerVaultKeysHere } from 'vaults-web-shared/roster-here.js';
import type { Inviter } from '../../../../src/core/invitation.js';
import { rosterReadsFor } from './filing-judge.js';
import { ACT_REFUSAL, ACTED, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * A SIGNER'S VAULT KEYS, GIVEN FOR A COMPANY, the one way every page gives
 * them: the company's keys released by the person's account first, then their
 * records key signed by their account for the seat their own key makes - with
 * the invitation they joined by, for an account that has not kept the company
 * yet - then this signer's vault keys, signed with their own key, offered to
 * the service with the directory entry their account signed in the same press.
 * The offer waits until a seat the company already believes folds it into the
 * roster from its own device: this one, once the company's directory believes
 * it, which it tries at every press. The entry is kept with their keys and
 * filed as soon as the directory takes it: now, or on a later way into the
 * company, unless the directory already holds exactly that entry.
 */

/** What giving the keys hands back: the account's release, and its signed statement with who holds the company. */
type Given = Awaited<ReturnType<typeof companyKeysForVaults>> & { signed: Awaited<ReturnType<typeof recordsKeyFromTheWallet>> };

/** This signer's own part: who they are on the roster, the key they sign with, and what their seat is made from. */
interface SignerKeys {
  readonly signerId: string; readonly signingSecret: Hex; readonly blinding: Hex; readonly scope?: Hex;
  /** The seat that invited this signer, as the invitation carried it: for their account's first records-key ask. */
  readonly invitedBy?: Inviter;
}

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
  const signed = await recordsKeyFromTheWallet(ACCOUNT_ORIGIN, {
    company: released.company, account: released.account, seat, signingKey, ...invitedByForTheWallet(signer.invitedBy),
  });
  await offerVaultKeysHere(api, companyId, {
    signerId: signer.signerId, signingSecret: signer.signingSecret, companyKey: released.companyKey,
    committeeKey: released.committeeKey, recordsKey: signed.statement, entry: signed.entry!,
  });
  /*
   * The answer was read against this filing key, so it carries the entry; a wallet that signed none is refused there.
   * An entry is believed only once the account is held by a committee that lists this signer's key, which may be after
   * this press, so it is kept with this person's keys and filed now and on every way into the company until the
   * directory holds it (`fileTheOwedDirectoryEntry`): seating files it, with no later press needed.
   */
  await oweDirectoryEntry(companyId, { person, company: released.company, signed: { committeeKey: signed.committeeKey, entry: signed.entry! } });
  await fileTheOwedDirectoryEntry(api, companyId, directoryEntryOwed(companyId));
  /*
   * Every open offer, this signer's own included, folded into the roster from this device - which the service files
   * only once the company's directory believes this seat. Until then the offer waits for a seat it does believe.
   */
  try {
    await foldOffersHere({
      api, accountId: companyId, viewingKey, signingSecret: signer.signingSecret, label: released.company, account: released.account,
      reads: rosterReadsFor(companyId, released.company, released.account),
    });
  } catch {
    /* Not believed yet, or the roster moved meanwhile: the offer stays open for the next press or another seat. */
  }
  return { of: ACTED.done, ...released, signed };
}
