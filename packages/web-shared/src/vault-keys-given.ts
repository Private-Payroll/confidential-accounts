import type { Hex } from '../../../src/core/crypto.js';
import type { CompanyKeys } from '../../../src/core/company-key.js';
import type { CommitteeKey } from '../../../src/midnight/seat-directory.js';
import type { Signer } from '../../../src/core/types.js';
import { recordsKeySignedBy, type DirectoryEntryStatement, type RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { OwedDirectoryEntry } from './keyring-blob.js';
import { fileTheOwedDirectoryEntry, type EntryView, type OwedEntryFiled } from './directory-filed-here.js';
import { RosterNotFiled, type RosterReads } from './roster-here.js';
import { fileTheRosterFollowedHere, foldOffersHere, offerVaultKeysHere } from './roster-filed-here.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { RosterViewHeld } from './roster-through-the-view.js';

/*
 * GIVING A SEAT'S VAULT KEYS, the three filings in their order, for whichever
 * device holds the seat's secrets: its own directory entry, its vault keys
 * offered to the company (unless the roster already holds them as offered),
 * and the offers folded into the roster; and the
 * roster filed again from the seat when no device believes the one filed.
 * Each is signed with the seat's own key and sealed under the company's keys as
 * the directory believes them; the service is reached through the step's
 * `view` of the company.
 */

/** Files the directory entry this seat owes, if it owes one: as `fileTheOwedDirectoryEntry` says. */
export const ownEntryFiled = (
  accountId: string, owed: { read(): OwedDirectoryEntry | null; settle(): Promise<void> },
  seat: { readonly signingSecret: Hex; readonly companyKeys: CompanyKeys }, founding: () => Promise<string | null>, view: EntryView,
): Promise<OwedEntryFiled> =>
  fileTheOwedDirectoryEntry(accountId, owed, async () => ({ signingSecret: seat.signingSecret, viewingKey: seat.companyKeys }), founding, view);

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
  readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress;
  readonly signingSecret: Hex; readonly companyKeys: CompanyKeys; readonly reads: RosterReads; readonly entered: RecordsEntered;
  readonly view: RosterViewHeld;
}): Promise<{ readonly changed: boolean; readonly refused: readonly { readonly seat: string; readonly why: string }[] }> => {
  const doors = {
    accountId: input.accountId, viewingKey: input.companyKeys, signingSecret: input.signingSecret,
    label: input.label, account: input.account, reads: input.reads, entered: input.entered, view: input.view,
  };
  const followed = await fileTheRosterFollowedHere(doors);
  const folded = await foldOffersHere(doors).catch((e: unknown) => {
    if (e instanceof RosterNotFiled) return null;
    throw e;
  });
  return { changed: followed !== null || (folded !== null && folded.folded.length > 0), refused: folded?.refused ?? [] };
};

/** What a roster holds for one seat that an offer of its vault keys would change: its vault keys and its own directory entry. */
export type HeldForTheSeat = Pick<Signer, 'vaultKeys' | 'directoryEntry'>;

/**
 * Whether the roster already holds what this seat would offer: vault keys with the same committee key and records key,
 * signed for the same seat by a statement that verifies under that committee key for this company and account (one any
 * seat filed wrong is offered again, so the seat repairs it), and the seat's own directory entry for the same account,
 * signing key, wrapping key and seat under the same committee key. Each signing makes new signature bytes over the same content, so an offer of what is
 * held would only make the fold file a version of the roster that changes nothing.
 */
export const offerAlreadyHeld = (
  held: HeldForTheSeat | undefined,
  offer: { readonly committeeKey: CommitteeKey; readonly recordsKey: RecordsKeyStatement; readonly entry: DirectoryEntryStatement },
  company: { readonly label: CompanyLabel; readonly account: AccountAddress },
): boolean => {
  const [keys, entry] = [held?.vaultKeys ?? null, held?.directoryEntry ?? null];
  if (keys === null || entry === null || !keys.recordsKeyStatement || !keys.recordsKeySeat) return false;
  const statement = { recordsKey: keys.recordsKey, seat: keys.recordsKeySeat, signature: keys.recordsKeyStatement };
  if (!recordsKeySignedBy(company.label, company.account, keys.committeeKey, statement)) return false;
  const same = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const sameKey = (k: CommitteeKey): boolean => k.tag === offer.committeeKey.tag && same(k.value, offer.committeeKey.value);
  return sameKey(keys.committeeKey) && same(keys.recordsKey, offer.recordsKey.recordsKey) && same(keys.recordsKeySeat, offer.recordsKey.seat)
    && sameKey(entry.committeeKey) && (['account', 'signingKey', 'wrappingKey', 'seat'] as const).every((k) => same(entry.statement[k], offer.entry[k]));
};

/**
 * Offers the company this seat's vault keys, unless the roster this step read already holds them and the seat's own
 * entry as offered (`held`, `offerAlreadyHeld`), and folds the open offers into the roster. The fold is any seat's to
 * make, so one that does not go through here is left for the next seat that opens the company's vaults.
 */
export async function vaultKeysOfferedAndFolded(input: {
  readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress;
  readonly signerId: string; readonly signingSecret: Hex; readonly companyKey: Hex; readonly companyKeys: CompanyKeys;
  readonly committeeKey: CommitteeKey; readonly recordsKey: RecordsKeyStatement; readonly entry: DirectoryEntryStatement;
  readonly held?: HeldForTheSeat;
  readonly reads: RosterReads; readonly entered: RecordsEntered; readonly view: RosterViewHeld;
}): Promise<void> {
  if (!offerAlreadyHeld(input.held, { committeeKey: input.committeeKey, recordsKey: input.recordsKey, entry: input.entry }, input)) {
    await offerVaultKeysHere(input.accountId, {
      signerId: input.signerId, signingSecret: input.signingSecret, companyKey: input.companyKey,
      committeeKey: input.committeeKey as never, recordsKey: input.recordsKey, entry: input.entry, viewingKey: input.companyKeys,
    }, input.view);
  }
  try {
    await foldOffersHere({
      accountId: input.accountId, viewingKey: input.companyKeys, signingSecret: input.signingSecret,
      label: input.label, account: input.account, reads: input.reads, entered: input.entered, view: input.view,
    });
  } catch {
    /* The fold is any seat's to make: an offer left unfolded here is folded by the next seat that opens the company's vaults. */
  }
}
