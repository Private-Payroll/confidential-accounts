import { startCompanyHeldFromTheStart } from 'vaults-web-shared/keyring.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';

/*
 * THE FIRST PRESS OF CREATING A COMPANY, FOUNDED IN THE PERSON'S WALLET, OVER
 * THE SHARED KEYRING.
 *
 * `createCompany` has the person's wallet draw the company's label, make the
 * founding seat, sign the company's first roster and state and keep the seat
 * in the saved keys, in one window; the keyring keeps the saved keys the wallet
 * sealed and sends the service what the company was founded with. Nothing is
 * sent to the chain and no account is built: building, sending and finishing
 * the account is the next step's, one action in the wallet. This file brings
 * the keyring to the person signed in and turns the answer into an id, a label
 * or a reason. It keeps nothing.
 */

/** What the first press comes to: the company is founded and kept and its wallet-drawn label is handed on, or a reason. */
export type Created =
  | { of: typeof ACTED.done; companyId: string; label: string }
  | { of: typeof ACTED.refused; why: ActRefusal };

/** The company's name, and the name its roster gives the person creating it. Both are sent to the service as typed, which seals them into the company's record. */
export interface NewCompany {
  name: string;
  firstSigner: string;
}

/** The role of the person creating the company, on its roster: they may do everything. */
const FIRST_SIGNER = { role: 'admin' } as const;

/**
 * The first press: has the wallet found the company, sending nothing to the
 * chain, and hands back its id and the label the wallet drew. It refuses
 * by the refusal's kind.
 */
export async function createCompany(personId: string, company: NewCompany): Promise<Created> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const { accountId, label } = await startCompanyHeldFromTheStart(
      { name: company.name, signers: [{ name: company.firstSigner, role: FIRST_SIGNER.role }], threshold: 1 }, ACCOUNT_ORIGIN);
    return { of: ACTED.done, companyId: accountId, label };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
