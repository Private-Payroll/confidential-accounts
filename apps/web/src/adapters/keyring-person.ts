import { currentUser, forgetLocally, resumeSession } from 'vaults-web-shared/keyring.js';

/*
 * THE SHARED KEYRING, BROUGHT TO THE PERSON SIGNED IN IN THIS TAB.
 *
 * Creating a company, opening one and handing one over are the keyring's
 * work, and it acts only for the person it knows. After a sign-in in this tab
 * it knows them already (`session.ts` hands it the answer). After a reload it
 * knows nobody, and picks the sign-in up from the service, which asks the
 * person nothing. A sign-in picked up that way carries no address, so a
 * person with nothing saved yet cannot have their first keys saved from this
 * tab until they sign in again here: creating their first company is refused
 * as "sign in again". A keyring that knows somebody else forgets them first.
 */

/** Whether the keyring now acts for `personId`: true, or false when the service says somebody else, or nobody, is signed in. It throws when the service cannot be asked. */
export async function keyringFor(personId: string): Promise<boolean> {
  if (currentUser()?.id === personId) return true;
  forgetLocally();
  await resumeSession();
  return currentUser()?.id === personId;
}
