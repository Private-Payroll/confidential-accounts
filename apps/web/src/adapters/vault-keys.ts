import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { recordsEnteredOver } from 'vaults-web-shared/record-entered-here.js';
import type { Account, SealedProposal } from '../../../../src/core/types.js';
import { seatInviterIn } from '../../../../src/core/proposal-filing.js';
import { inviterForTheWallet } from 'vaults-web-shared/invitation-on-device.js';
import {
  api, companyKeysForVaults, currentUser, directoryEntryOwed, invitedByForTheWallet, oweDirectoryEntry, recordsKeyFromTheWallet,
} from 'vaults-web-shared/keyring.js';
import { fileTheOwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { foldOffersHere, offerVaultKeysHere } from 'vaults-web-shared/roster-here.js';
import type { Inviter } from '../../../../src/core/invitation.js';
import { keyInForce, keysHeld } from '../../../../src/core/company-key.js';
import { openVaultKeysOffer, vaultKeysOfferRefusal, type OpenedVaultKeysOffer, type VaultKeysOffer } from '../../../../src/core/vault-keys.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { rosterReadsFor } from './filing-judge.js';
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import { SERVICE } from './company-records.js';
import { ACT_REFUSAL, ACTED, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * A SIGNER'S VAULT KEYS, GIVEN FOR A COMPANY, the one way every page gives
 * them: the company's keys released by the person's account first, then their
 * records key signed by their account for the seat their own key makes - with
 * the invitation they joined by, for an account that has not kept the company
 * yet - then the directory entry their account signed in the same press, filed
 * as soon as the directory takes it, then this signer's vault keys, signed with
 * their own key and sealed, offered to the service.
 * The offer waits until a seat the company already believes folds it into the
 * roster from its own device: this one, once the company's directory believes
 * it, which it tries at every press. The entry is kept with their keys until
 * the directory takes it: now, or on a later way into the company, unless the
 * directory already holds exactly that entry.
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
 * own key does not make (`notYourSeat`); and, once the account has been asked, when the directory has not taken this
 * signer's entry (`entryNotFiled`, or `entryWaitsForItsInvitation` while the invitation behind it is not read): then
 * no keys are offered, and the entry stays kept for the next way in.
 */
export async function giveTheVaultKeys(
  companyId: string, signer: SignerKeys, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
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
  /*
   * The inviter handed to the wallet: the one kept from the invitation (or its re-issue), or the seat that raised the
   * proposal seating this person, whichever the account holds now as their own wallet reads it (`inviterForTheWallet`).
   * A list or a read that cannot be had leaves the kept one, and the wallet says what is wrong with it.
   */
  let carried: Inviter | null = null;
  let onTheChain: readonly string[] = [];
  try {
    const listed: unknown = await api(SERVICE.company + companyId + SERVICE.proposals);
    carried = seatInviterIn(Array.isArray(listed) ? listed as SealedProposal[] : [], companyId, viewingKey, seat);
    onTheChain = (await rosterReadsFor(companyId, released.company, released.account).holders()).seats;
  } catch {
    /* Nothing better than what this device kept. */
  }
  const signed = await recordsKeyFromTheWallet(ACCOUNT_ORIGIN, {
    company: released.company, account: released.account, seat, signingKey,
    ...invitedByForTheWallet(inviterForTheWallet(signer.invitedBy, carried, onTheChain)),
  });
  /*
   * The answer was read against this filing key, so it carries the entry; a wallet that signed none is refused there.
   * The entry is filed first: the service keeps an offer only for a person who has filed an entry for the seat, or
   * while nobody has, so a claim another member filed on this seat first would refuse an offer made before it. An
   * entry is believed on its sealed opening and its seat's leaf alone, but it can be filed only once this device
   * holds its seat's opening and can open the company's key, which may be after this press, so it is kept with this
   * person's keys and filed now and on every way into the company until the directory holds it
   * (`fileTheOwedDirectoryEntry`): seating files it, with no later press needed.
   * While it is not filed the press is refused, by which wait it is, and nothing is offered.
   */
  await oweDirectoryEntry(companyId, { person, company: released.company, signed: { committeeKey: signed.committeeKey, entry: signed.entry! } });
  const filed = await fileTheOwedDirectoryEntry(api, companyId, directoryEntryOwed(companyId), async () => ({ signingSecret: signer.signingSecret, viewingKey }),
    /* The founding seat, as the person's own wallet reads the account: the only entry filed without an invitation. */
    async () => (await rosterReadsFor(companyId, released.company, released.account).holders()).founding ?? null);
  /* An entry the directory has not taken stays owed and is tried at every way in; no keys are offered on a seat with no entry filed. */
  if (typeof filed === 'object') {
    return { of: ACTED.refused, why: (filed as { notYet?: string }).notYet === undefined ? ACT_REFUSAL.entryWaitsForItsInvitation : ACT_REFUSAL.entryNotFiled };
  }
  await offerVaultKeysHere(api, companyId, {
    signerId: signer.signerId, signingSecret: signer.signingSecret, companyKey: released.companyKey,
    committeeKey: released.committeeKey, recordsKey: signed.statement, entry: signed.entry!, viewingKey,
  });
  /*
   * Every open offer, this signer's own included, folded into the roster from this device - which the service files
   * only once the company's directory believes this seat. Until then the offer waits for a seat it does believe.
   */
  try {
    await foldOffersHere({
      api, accountId: companyId, viewingKey, signingSecret: signer.signingSecret, label: released.company, account: released.account,
      reads: rosterReadsFor(companyId, released.company, released.account),
      entered: recordsEnteredOver(api, companyId, signer.signingSecret),
    });
  } catch {
    /* Not believed yet, or the roster moved meanwhile: the offer stays open for the next press or another seat. */
  }
  return { of: ACTED.done, ...released, signed };
}

/**
 * THE VAULT-KEY OFFERS OPEN ON THE SERVICE THIS DEVICE CAN OPEN, by the seat each is for: `served` is the service's answer
 * for the company's open offers. An offer counts only when it opens under a key the company holds, is the shape of an offer,
 * and carries a directory entry and vault keys the signer's own wallet and key signed for this company
 * (`vaultKeysOfferRefusal`): the same opening and checks the fold makes before it files one into the roster. Whose offer it
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
      const opened = keysHeld(viewingKey).map((k) => openVaultKeysOffer(companyId, offer, k)).find((o) => typeof o !== 'string')
        ?? openVaultKeysOffer(companyId, offer, keyInForce(viewingKey));
      if (typeof opened === 'string' || vaultKeysOfferRefusal(label, account, companyId, opened) !== null) continue;
      open.set(seat, opened);
    } catch {
      /* An offer this device cannot read is not counted. */
    }
  }
  return open;
}
