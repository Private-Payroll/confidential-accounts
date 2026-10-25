import {
  currentUser, forgetLocally, resumeSession, seatHeldHere, type SeatPublicHalves,
} from 'vaults-web-shared/keyring.js';
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
 * THIS PERSON'S SEAT ON THE COMPANY `companyId`, found on the way into it: its
 * public halves and scope as the wallet read them from the saved keys for this
 * tab, and no secret. Null when the wallet read no seat for the company here.
 * Opening a company signs and files nothing: what the company is owed of this
 * seat (its directory entry, a change of the company's key, its roster
 * followed, its records anchored) is done by the person's next action in their
 * wallet, in that action's window.
 */
export async function keysOnTheWayIn(companyId: string): Promise<SeatPublicHalves | null> {
  return seatHeldHere(companyId);
}
