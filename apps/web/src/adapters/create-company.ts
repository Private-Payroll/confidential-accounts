import { startCompanyHeldFromTheStart } from 'vaults-web-shared/keyring.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { theCreationBuilder } from './vault-builder.js';

/*
 * THE FIRST PRESS OF CREATING A COMPANY ON THIS DEVICE, HELD BY ITS FOUNDING
 * SIGNER'S OWN KEY FROM ITS FIRST TRANSACTION, OVER THE SHARED KEYRING.
 *
 * `createCompany` makes the company and every secret it has on this device,
 * with the person's wallet giving the key it is held by and drawing its
 * label, and builds the account's deploy here. Nothing is sent to the chain:
 * signing and sending it, and carrying it to finished, are the next step's.
 * This file brings the keyring to the person signed in and the page's vault
 * worker to the keyring, and turns the answer into an id, a label or a
 * reason. It keeps nothing.
 */

/** What the first press comes to: the company is made and kept here and its wallet-drawn label is handed on, or a reason. */
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
 * The first press: makes the company here and builds its deploy, sending nothing
 * to the chain, and hands back its id and the label the wallet drew. It refuses
 * by the refusal's kind.
 */
export async function createCompany(personId: string, company: NewCompany): Promise<Created> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const builder = await theCreationBuilder();
    if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
    const { accountId, label } = await startCompanyHeldFromTheStart(
      { name: company.name, signers: [{ name: company.firstSigner, role: FIRST_SIGNER.role }], threshold: 1 }, ACCOUNT_ORIGIN, builder);
    return { of: ACTED.done, companyId: accountId, label };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
