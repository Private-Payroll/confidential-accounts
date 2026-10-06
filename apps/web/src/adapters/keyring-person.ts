import type { SealedAccount } from '../../../../src/core/types.js';
import {
  api, canOpenCompanies, currentUser, directoryEntryOwed, finishPendingSeat, forgetLocally, keysFor, pendingSeatsFor, reopenSavedKeys, resumeSession,
  type AccountKeys,
} from 'vaults-web-shared/keyring.js';
import { fileTheOwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { readSignIn } from './kept-sign-in.js';
import { tabStorage } from './kept-skips.js';

/*
 * THE SHARED KEYRING, BROUGHT TO THE PERSON SIGNED IN IN THIS TAB.
 *
 * Creating a company, opening one and handing one over are the keyring's
 * work, and it acts only for the person it knows. After a sign-in in this tab
 * it knows them already (`session.ts` hands it the answer). After a reload it
 * knows nobody, and picks the sign-in up from the service, which asks the
 * person nothing. The service does not say again which address the sign-in
 * was for, so the address kept in this tab at the sign-in (`kept-sign-in.ts`)
 * is handed back with it, and the keyring takes it only for the person the
 * service names: a person with nothing saved yet can then create their first
 * company without signing in again. A keyring that knows somebody else
 * forgets them first.
 */

/** Whether the keyring now acts for `personId`: true, or false when the service says somebody else, or nobody, is signed in. It throws when the service cannot be asked. */
export async function keyringFor(personId: string): Promise<boolean> {
  if (currentUser()?.id === personId) return true;
  forgetLocally();
  await resumeSession(readSignIn(tabStorage()));
  return currentUser()?.id === personId;
}

/**
 * THIS PERSON'S KEYS FOR THE COMPANY `companyId`, found on the way into it as
 * the legacy page finds them: keys saved in another tab since this one opened
 * them are read first, and a seat this device published and did not finish
 * saving is finished before anything asks for the company's keys. Nothing to
 * finish is the ordinary case: the company's record is not asked for and
 * nothing is written. A directory entry this person's wallet signed and the
 * directory did not take yet is filed again (`fileTheOwedDirectoryEntry`); a
 * refusal leaves it owed and stops nothing. Null when this device holds no
 * keys for the company.
 */
export async function keysOnTheWayIn(companyId: string, sealed: () => Promise<SealedAccount>): Promise<AccountKeys | null> {
  if (keysFor(companyId) === null && canOpenCompanies()) await reopenSavedKeys();
  if (pendingSeatsFor(companyId).length > 0) await finishPendingSeat(companyId, await sealed());
  const owed = directoryEntryOwed(companyId);
  if (owed.read() !== null) await fileTheOwedDirectoryEntry(api, companyId, owed);
  return keysFor(companyId);
}
