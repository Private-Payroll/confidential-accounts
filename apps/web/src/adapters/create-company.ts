import {
  companyAwaitingItsSecondPress, companyBeingCreated, companyCreationStanding, finishCompanyOnTheChain, sealThePayRecordKey, signCompanyCreationFromTheWallet,
  startCompanyHeldFromTheStart, type AccountCreationBuilder, type CompanyCreationState,
} from 'vaults-web-shared/keyring.js';
import type { VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * CREATING A COMPANY ON THIS DEVICE, HELD BY ITS FOUNDING SIGNER'S OWN KEY
 * FROM ITS FIRST TRANSACTION, OVER THE SHARED KEYRING'S OWN JOURNEY.
 *
 * Two presses, each carried on from wherever it stopped. The first
 * (`createCompany`) makes the company and every secret it has on this device,
 * with the person's wallet giving the key it is held by, and builds the
 * account's deploy here; nothing is sent to the chain. The second and any
 * after it (`finishCreating`) carry it on as far as the chain allows: the
 * wallet signs the step that finishes the account and both are sent, the
 * account is finished once the chain shows it, and the company's pay-record
 * key is sealed to its founding signer. A press the chain is not ready for
 * says so, and the next press carries on. This file brings the keyring to the
 * person signed in and the page's vault worker to the keyring, and turns each
 * answer into an id, a wait or a reason. It keeps nothing.
 */

/**
 * What a press's answer is when the chain does not yet show the company
 * finished (the next press of Finish carries it on), and the keyring's own word
 * for a company made here and not yet signed and sent. Compared by the code,
 * never shown.
 */
export const CREATION = { waits: 'waiting', notSent: 'not-created' } as const;

/** A company started here that the chain does not yet show finished: the next press of Finish carries it on. */
export const CREATION_WAITS = CREATION.waits;

export type Created =
  | { of: typeof ACTED.done; companyId: string }
  | { of: typeof CREATION_WAITS; companyId: string; state: CompanyCreationState }
  | { of: typeof ACTED.refused; why: ActRefusal; waiting: string | null };

/** The company's name, and the name its roster gives the person creating it. Both are sent to the service as typed, which seals them into the company's record. */
export interface NewCompany {
  name: string;
  firstSigner: string;
}

/** The role of the person creating the company, on its roster: they may do everything. */
const FIRST_SIGNER = { role: 'admin' } as const;

const refused = (e: unknown): Created => ({ of: ACTED.refused, why: refusalOf(e), waiting: companyBeingCreated() });

/** The company this person started and has not finished, or null. */
export const waitingToBeFinished = (): string | null => companyBeingCreated();

/** The page's vault worker as the keyring builds a company with it, or null when this build's worker cannot. */
async function creationBuilder(): Promise<AccountCreationBuilder | null> {
  const w: VaultBuilderClient = await theVaultBuilder();
  const { foundingSeat, accountDeploy, finishedCreation, creationAgain, payKeyStanding, governedCall } = w;
  if (foundingSeat === undefined || accountDeploy === undefined || finishedCreation === undefined || creationAgain === undefined
    || payKeyStanding === undefined) return null;
  return { foundingSeat, accountDeploy, finishedCreation, creationAgain, payKeyStanding, governedCall };
}

/** THE FIRST PRESS: create a company for `personId` on this device, with them as its one signer and one approval needed. */
export async function createCompany(personId: string, company: NewCompany): Promise<Created> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp, waiting: companyBeingCreated() };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn, waiting: companyBeingCreated() };
    const builder = await creationBuilder();
    if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish, waiting: companyBeingCreated() };
    const { accountId } = await startCompanyHeldFromTheStart(
      { name: company.name, signers: [{ name: company.firstSigner, role: FIRST_SIGNER.role }], threshold: 1 }, ACCOUNT_ORIGIN, builder);
    return { of: CREATION_WAITS, companyId: accountId, state: CREATION.notSent };
  } catch (e) {
    return refused(e);
  }
}

/** The states a press carries on from, each by the keyring's one step for it; any other waits for the chain. */
const STEP_FOR: Partial<Record<CompanyCreationState, (id: string, b: AccountCreationBuilder) => Promise<{ state: CompanyCreationState }>>> = {
  'deploy-expired': finishCompanyOnTheChain, 'finish-owed': finishCompanyOnTheChain, 'finish-expired': finishCompanyOnTheChain,
  'pay-key-owed': sealThePayRecordKey,
};

/**
 * THE SECOND PRESS, AND EVERY ONE AFTER IT, for the company this person
 * started here: signed by the wallet and sent if it was not, then carried on
 * from where the chain stands, as far as the chain allows.
 */
export async function finishCreating(personId: string): Promise<Created> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp, waiting: companyBeingCreated() };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn, waiting: companyBeingCreated() };
    const builder = await creationBuilder();
    if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish, waiting: companyBeingCreated() };
    const accountId = companyBeingCreated();
    if (accountId === null) return { of: ACTED.refused, why: ACT_REFUSAL.nothingToSign, waiting: null };
    /* Signed and sent while the service has not recorded it; otherwise carried on from where the chain stands. */
    let { state } = companyAwaitingItsSecondPress() !== null ? { state: CREATION.notSent as CompanyCreationState } : await companyCreationStanding(accountId);
    if (state === CREATION.notSent) ({ state } = await signCompanyCreationFromTheWallet(ACCOUNT_ORIGIN, builder));
    for (let steps = 0; state !== 'finished' && steps < 3; steps += 1) {
      const step = STEP_FOR[state];
      if (step === undefined) break;
      ({ state } = await step(accountId, builder));
    }
    return state === 'finished' ? { of: ACTED.done, companyId: accountId } : { of: CREATION_WAITS, companyId: accountId, state };
  } catch (e) {
    return refused(e);
  }
}
