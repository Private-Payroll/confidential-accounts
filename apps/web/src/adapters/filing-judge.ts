import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../../src/core/crypto.js';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { Account, SealedAccount } from '../../../../src/core/types.js';
import {
  api, companyKeyReleasedFor, companyKeysForVaults, holdersFromTheWallet, openAccount, seatHeldHere, seatsAdmittedFor, viewingKeyFor, type OpenedAccount,
} from 'vaults-web-shared/keyring.js';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import { signersCheckNoted, type RosterReads } from 'vaults-web-shared/roster-here.js';
import type { DirectoryRead } from 'vaults-web-shared/vault-page-doors.js';
import type { FreshJudge } from 'vaults-web-shared/http-sealed-pool-store.js';
import { treeKeptHere } from 'vaults-web-shared/tree-kept-here.js';
import { companyJudges } from 'vaults-web-shared/company-judges.js';
import { Fault, FAULT } from '../faults.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/* Why a company did not open here, as a code: handed on with the company read, so a list loads it with this file. */
export { ACT_REFUSAL, refusalOf } from './refusals.js';

/*
 * WHO THIS PAGE BELIEVES FILED A COMPANY'S RECORDS, the one way every screen
 * asks it: the judges every device reads a company with (`companyJudges`),
 * built here from this page's doors - the company's service, the person's own
 * wallet asked again who holds the account now (with no press: nothing is
 * signed), this page's vault worker and what the wallet read from the saved
 * keys for this tab (each seat's public halves, each company's viewing key it
 * opened) - so every read is made afresh and rests on no read made before it.
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

/* Each door reaches its module at the moment it is used, never when this file loads. */
const judges = companyJudges({
  api: (path, init) => api(path, init),
  holders: holdersHere,
  indexer: walletIndexerFor,
  builder: () => theVaultBuilder(),
  keysFor: (companyId) => seatHeldHere(companyId),
  /* This seat's served copy of the company's key, as the wallet opened it, only ever checked against the directory before it is used. */
  servedKeyFor: viewingKeyFor,
  released: (companyId) => companyKeyReleasedFor(companyId),
  askReleased: async (companyId) => (await companyKeysForVaults(companyId, ACCOUNT_ORIGIN)).companyKey as Hex,
  treeKept: () => treeKeptHere(),
  openAccount: (...a) => openAccount(...a),
  seatsAdmittedFor: (...a) => seatsAdmittedFor(...a),
  noAccount: () => { throw new Fault(FAULT.companyKeysWithNoAccount); },
});

/** What a roster is read with on this page. */
export const rosterReadsFor: (companyId: string, company: CompanyLabel, account: AccountAddress) => RosterReads = judges.rosterReadsFor;
/** The company as this page believes it, its signers read from its roster record only; a refusal is written to the console report, then thrown, and a company with no account yet is said once as that. */
export const openedHere = (sealed: SealedAccount): Promise<OpenedAccount | null> => signersCheckNoted(() => judges.openedHere(sealed), sealed.id);
/** Whether a filing's signer is one the company's directory believes, as this page reads it. */
export const filingJudgeFor: (
  companyId: string, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
) => FreshJudge = judges.filingJudgeFor;
/** The company's directory as this page believes it, read afresh at each call. */
export const directoryHereFor: (
  companyId: string, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
) => DirectoryRead = judges.directoryHereFor;
/** The company's key of each epoch this page can use, every one found in the directory's filings and believed there. */
export const companyKeysFor: (
  companyId: string, sealed: SealedAccount, keys: { readonly signingPublicKey: Hex },
) => Promise<CompanyKeyHere> = judges.companyKeysFor;
