import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Account } from '../../../../src/core/types.js';
import { api, holdersFromTheWallet } from 'vaults-web-shared/keyring.js';
import { attestedIn, directoryFilingsFrom, directoryJudge } from 'vaults-web-shared/vault-page-doors.js';
import type { FreshJudge } from 'vaults-web-shared/http-sealed-pool-store.js';
import { ACCOUNT_ORIGIN } from './session.js';

/*
 * WHO THIS PAGE BELIEVES FILED A COMPANY'S RECORDS, the one way every screen
 * asks it: the company's seat directory read again, the person's own wallet
 * asked again who holds the account now (with no press: nothing is signed),
 * and the records-key statements in the roster this device opened - all of it
 * afresh for every read, so no read rests on one made before it.
 */
export const filingJudgeFor = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): FreshJudge => directoryJudge({
  accountId: companyId,
  label: company,
  filings: () => directoryFilingsFrom(api, companyId),
  holders: async () => (await holdersFromTheWallet(ACCOUNT_ORIGIN, { company, account })).holders,
  attested: async () => attestedIn(await roster()),
});
