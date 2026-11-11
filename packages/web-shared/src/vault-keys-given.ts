import type { Hex } from '../../../src/core/crypto.js';
import type { CompanyKeys } from '../../../src/core/company-key.js';
import type { CommitteeKey } from '../../../src/midnight/seat-directory.js';
import type { DirectoryEntryStatement, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { OwedDirectoryEntry } from './keyring-blob.js';
import { fileTheOwedDirectoryEntry, type OwedEntryFiled } from './vault-page-doors.js';
import { fileTheRosterFollowedHere, foldOffersHere, offerVaultKeysHere, RosterNotFiled, type RosterReads } from './roster-here.js';
import type { RecordsEntered } from './record-entered-here.js';

/*
 * GIVING A SEAT'S VAULT KEYS, the three filings in their order, for whichever
 * device holds the seat's secrets: its own directory entry, its vault keys
 * offered to the company, and the offers folded into the roster; and the
 * roster filed again from the seat when no device believes the one filed.
 * Each is signed with the seat's own key and sealed under the company's keys as
 * the directory believes them; the service is reached through `api`.
 */

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** Files the directory entry this seat owes, if it owes one: as `fileTheOwedDirectoryEntry` says. */
export const ownEntryFiled = (
  api: Api, accountId: string, owed: { read(): OwedDirectoryEntry | null; settle(): Promise<void> },
  seat: { readonly signingSecret: Hex; readonly companyKeys: CompanyKeys }, founding: () => Promise<string | null>,
): Promise<OwedEntryFiled> =>
  fileTheOwedDirectoryEntry(api, accountId, owed, async () => ({ signingSecret: seat.signingSecret, viewingKey: seat.companyKeys }), founding);

/**
 * Files the company's roster again from this seat when no device believes the
 * version filed, or when it still seats a signer whose removal is anchored and
 * carried out on the chain (`fileTheRosterFollowedHere`), then folds every open
 * offer of vault keys into it (`foldOffersHere`): a seat whose role may not
 * file the roster offers its keys and leaves the fold to one that may.
 * `changed` is true when a version was filed; `refused` names each offer the
 * fold turned down, by its seat, with why, so the seat can be told to offer
 * again (none when the roster could not be filed here).
 */
export const rosterFollowed = async (input: {
  readonly api: Api; readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress;
  readonly signingSecret: Hex; readonly companyKeys: CompanyKeys; readonly reads: RosterReads; readonly entered: RecordsEntered;
}): Promise<{ readonly changed: boolean; readonly refused: readonly { readonly seat: string; readonly why: string }[] }> => {
  const doors = {
    api: input.api, accountId: input.accountId, viewingKey: input.companyKeys, signingSecret: input.signingSecret,
    label: input.label, account: input.account, reads: input.reads, entered: input.entered,
  };
  const followed = await fileTheRosterFollowedHere(doors);
  const folded = await foldOffersHere(doors).catch((e: unknown) => {
    if (e instanceof RosterNotFiled) return null;
    throw e;
  });
  return { changed: followed !== null || (folded !== null && folded.folded.length > 0), refused: folded?.refused ?? [] };
};

/**
 * Offers the company this seat's vault keys and folds the offers into the
 * roster. The fold is any seat's to make, so one that does not go through here
 * is left for the next seat that opens the company's vaults.
 */
export async function vaultKeysOfferedAndFolded(input: {
  readonly api: Api; readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress;
  readonly signerId: string; readonly signingSecret: Hex; readonly companyKey: Hex; readonly companyKeys: CompanyKeys;
  readonly committeeKey: CommitteeKey; readonly recordsKey: RecordsKeyStatement; readonly entry: DirectoryEntryStatement;
  readonly reads: RosterReads; readonly entered: RecordsEntered;
}): Promise<void> {
  await offerVaultKeysHere(input.api, input.accountId, {
    signerId: input.signerId, signingSecret: input.signingSecret, companyKey: input.companyKey,
    committeeKey: input.committeeKey as never, recordsKey: input.recordsKey, entry: input.entry, viewingKey: input.companyKeys,
  });
  try {
    await foldOffersHere({
      api: input.api, accountId: input.accountId, viewingKey: input.companyKeys, signingSecret: input.signingSecret,
      label: input.label, account: input.account, reads: input.reads, entered: input.entered,
    });
  } catch {
    /* The fold is any seat's to make: an offer left unfolded here is folded by the next seat that opens the company's vaults. */
  }
}
