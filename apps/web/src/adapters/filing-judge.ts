import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { Account, SealedAccount } from '../../../../src/core/types.js';
import { api, holdersFromTheWallet, openAccount, rosterBelievedBeforeFor } from 'vaults-web-shared/keyring.js';
import type { BelievedAccount, RosterReads } from 'vaults-web-shared/roster-here.js';
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
/** Who holds the company's account now, as this person's own wallet reads the chain, with no press. */
const holdersHere = async (company: CompanyLabel, account: AccountAddress): Promise<AccountHoldersRead> =>
  (await holdersFromTheWallet(ACCOUNT_ORIGIN, { company, account })).holders;

/**
 * The indexer this person's own wallet reads the chain through, as it said in
 * a fresh read with no press, or null when it said none: the one place a
 * vault is read from on this device. No other address is ever used.
 */
export const walletIndexerFor = async (
  company: CompanyLabel, account: AccountAddress,
): Promise<{ readonly indexerUri: string; readonly indexerWsUri: string } | null> =>
  (await holdersFromTheWallet(ACCOUNT_ORIGIN, { company, account })).indexer;

/** What this page reads, afresh for each read, to believe a company's roster and each entry in it. */
export const rosterReadsFor = (companyId: string, company: CompanyLabel, account: AccountAddress): RosterReads => ({
  filings: () => directoryFilingsFrom(api, companyId),
  holders: () => holdersHere(company, account),
  believed: rosterBelievedBeforeFor(companyId),
});

/** The company as this page believes it (`openAccount`), its signers read from its roster record only. */
export const openedHere = (sealed: SealedAccount): Promise<BelievedAccount | null> => openAccount(sealed, holdersHere);

/** What this page reads to believe a company's directory, the one way every screen asks it. */
const directoryDeps = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): DirectoryHereDeps => ({
  accountId: companyId,
  label: company,
  ...rosterReadsFor(companyId, company, account),
  attested: async () => attestedIn(await roster()),
});

export const filingJudgeFor = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): FreshJudge => directoryJudge(directoryDeps(companyId, company, account, roster));

/** The company's directory as this page believes it, read afresh at each call by the same reads: who a vault's records are wrapped to. */
export const directoryHereFor = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): (() => Promise<DirectoryHere>) => () => directoryHere(directoryDeps(companyId, company, account, roster));
