import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Account } from '../../../../src/core/types.js';
import { api, holdersFromTheWallet } from 'vaults-web-shared/keyring.js';
import { attestedIn, directoryFilingsFrom, directoryHere, directoryJudge, type DirectoryHere, type DirectoryHereDeps } from 'vaults-web-shared/vault-page-doors.js';
import type { FreshJudge } from 'vaults-web-shared/http-sealed-pool-store.js';
import { ACCOUNT_ORIGIN } from './session.js';

/*
 * WHO THIS PAGE BELIEVES FILED A COMPANY'S RECORDS, the one way every screen
 * asks it: the company's seat directory read again, the person's own wallet
 * asked again who holds the account now (with no press: nothing is signed),
 * and the records-key statements in the roster this device opened - all of it
 * afresh for every read, so no read rests on one made before it.
 */
/** What this page reads to believe a company's directory, the one way every screen asks it. */
const directoryDeps = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): DirectoryHereDeps => ({
  accountId: companyId,
  label: company,
  filings: () => directoryFilingsFrom(api, companyId),
  holders: async () => (await holdersFromTheWallet(ACCOUNT_ORIGIN, { company, account })).holders,
  attested: async () => attestedIn(await roster()),
});

export const filingJudgeFor = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): FreshJudge => directoryJudge(directoryDeps(companyId, company, account, roster));

/** The company's directory as this page believes it, read afresh at each call by the same reads: who a vault's records are wrapped to. */
export const directoryHereFor = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): (() => Promise<DirectoryHere>) => () => directoryHere(directoryDeps(companyId, company, account, roster));
