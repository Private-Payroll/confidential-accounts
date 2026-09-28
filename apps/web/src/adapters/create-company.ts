import { companyAwaitingSetup, createCompanyWithWallet, finishCompanyCreation } from 'vaults-web-shared/keyring.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';

/*
 * CREATING A COMPANY, OVER THE SHARED KEYRING'S OWN JOURNEY.
 *
 * `createCompanyWithWallet` is where the order lives: open the keys saved for
 * this person with their account, create the company, and save its creator's
 * keys beside the others. This file brings the keyring to the person signed
 * in, makes that one call with the creator as the only signer and one
 * approval needed, and turns the answer into an id or a reason. It keeps
 * nothing.
 *
 * A COMPANY CREATED WHOSE KEYS WERE NOT SAVED IS WAITING TO BE FINISHED. The
 * keyring holds its keys in this tab only, and nothing else is started until
 * they are saved; `finishCreating` saves them.
 */

export type Created =
  | { of: typeof ACTED.done; companyId: string }
  | { of: typeof ACTED.refused; why: ActRefusal; waiting: string | null };

/** The company's name, and the name its roster gives the person creating it. Both are sent to the service as typed, which seals them into the company's record. */
export interface NewCompany {
  name: string;
  firstSigner: string;
}

/** The role of the person creating the company, on its roster: they may do everything. */
const FIRST_SIGNER = { role: 'admin' } as const;

const refused = (e: unknown): Created => ({ of: ACTED.refused, why: refusalOf(e), waiting: companyAwaitingSetup() });

/** The company this tab created whose keys are not saved yet, or null. */
export const waitingToBeFinished = (): string | null => companyAwaitingSetup();

/** CREATE A COMPANY for `personId`, with them as its one signer and one approval needed. */
export async function createCompany(personId: string, company: NewCompany): Promise<Created> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp, waiting: companyAwaitingSetup() };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn, waiting: companyAwaitingSetup() };
    const { accountId } = await createCompanyWithWallet(
      { name: company.name, signers: [{ name: company.firstSigner, role: FIRST_SIGNER.role }], threshold: 1 }, ACCOUNT_ORIGIN);
    return { of: ACTED.done, companyId: accountId };
  } catch (e) {
    return refused(e);
  }
}

/** SAVE THE KEYS of the company this tab created and could not save them for. No account is asked. */
export async function finishCreating(): Promise<Created> {
  try {
    const { accountId } = await finishCompanyCreation();
    return { of: ACTED.done, companyId: accountId };
  } catch (e) {
    return refused(e);
  }
}
