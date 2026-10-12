import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { Account, SealedAccount } from '../../../../src/core/types.js';
import { api, holdersFromTheWallet, openAccount, viewingKeyFor, type AccountKeys } from 'vaults-web-shared/keyring.js';
import { governedCallServiceFor } from 'vaults-web-shared/governed-call-on-device.js';
import { vouchedRunsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import type { BelievedAccount, RosterReads } from 'vaults-web-shared/roster-here.js';
import {
  attestedIn, directoryFilingsFrom, directoryHere, directoryJudge, directoryWithItsRecordsHere, fileDirectoryFiling, type DirectoryHereDeps,
  type DirectoryRead,
} from 'vaults-web-shared/vault-page-doors.js';
import type { FreshJudge } from 'vaults-web-shared/http-sealed-pool-store.js';
import { manifestServiceFor, recordsEnteredFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { treeKeptHere } from 'vaults-web-shared/tree-kept-here.js';
import {
  anchoredOnTheWayIn, anchorsOnChainAt, anchorServiceFor, heldFor, type AnchorDoors, type OnTheWayIn,
} from 'vaults-web-shared/records-anchored-here.js';
import { ownOpeningFiled, tagSeatsHere, type SeatOpeningsDoors } from 'vaults-web-shared/seat-openings-here.js';
import { companyRoute } from './handover-state.js';
import { ACT_REFUSAL } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

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

/**
 * **EVERY HEAD THE COMPANY'S ACCOUNT'S HISTORY SHOWS, ONE PER BLOCK**, read in the
 * page's vault worker from the account's history at the indexer this person's
 * own wallet names, and from nowhere else: never from the company's service.
 */
export const anchorsOnChainFor = (company: CompanyLabel, account: AccountAddress): AnchorDoors['onChain'] => async () =>
  anchorsOnChainAt(await theVaultBuilder(), account, await walletIndexerFor(company, account));

/**
 * **THE RUNS THAT MAY VOUCH FOR A HEAD, FOR THIS DEVICE NEW TO THE COMPANY**:
 * the company's proposals as the service serves them, opened here with the
 * viewing key this device unwraps (`vouchedRunsHere`), and the identity each
 * would have raised over the head it seals, made by the account's own
 * functions in the page's worker. Read only when this device kept nothing of
 * the company's records.
 */
const vouchingFor = (companyId: string): NonNullable<AnchorDoors['vouching']> => ({
  runs: async (chainIds) => {
    const sealed = await api(companyRoute(companyId)) as SealedAccount;
    const proposals = await governedCallServiceFor(api).sealedProposals!(companyId);
    return vouchedRunsHere(proposals, companyId, viewingKeyFor(sealed), chainIds);
  },
  identity: async (run) => (await theVaultBuilder()).vouchedRunIdentity(run),
});

/** What reading and filing the seats' openings asks of this page: the company's viewing key and epoch, and the page's vault worker. */
const openingDoorsFor = async (companyId: string, account: AccountAddress): Promise<SeatOpeningsDoors> => {
  const sealed = await api(companyRoute(companyId)) as SealedAccount;
  return { accountId: companyId, account, viewingKey: viewingKeyFor(sealed), keyEpoch: sealed.keyEpoch, api, builder: await theVaultBuilder() };
};

/** Which seat each tag is, for the seats who hold the account now as the person's own wallet reads it (`tagSeatsHere`). */
const tagSeatsFor = (companyId: string, company: CompanyLabel, account: AccountAddress): NonNullable<AnchorDoors['tagSeats']> => async () =>
  tagSeatsHere(await openingDoorsFor(companyId, account), (await holdersHere(company, account)).seats);

/**
 * **THE COMPANY'S RECORDS AS THE HEAD ON CHAIN HOLDS THEM**, for what each
 * read asks, checked on this page for every read: every anchor call the
 * account's history holds at the indexer the person's own wallet names, every
 * header since the last head this browser's database says it checked, the
 * leaves the service proves against that head's root, and the account's own
 * functions in the page's vault worker. A header the service no longer gives,
 * kept in that database, is filed again from here.
 */
const anchoredHere = (companyId: string, company: CompanyLabel, account: AccountAddress): DirectoryHereDeps['anchored'] => async (directory, asked) => heldFor({
  accountId: companyId, tree: treeServiceFor(api), manifest: manifestServiceFor(api), ...treeKeptHere(), onChain: anchorsOnChainFor(company, account),
  builder: await theVaultBuilder(), vouching: vouchingFor(companyId), tagSeats: tagSeatsFor(companyId, company, account),
})(directory, asked);

/** What this page reads, afresh for each read, to believe a company's roster and each entry in it. */
export const rosterReadsFor = (companyId: string, company: CompanyLabel, account: AccountAddress): RosterReads => ({
  filings: () => directoryFilingsFrom(api, companyId),
  holders: () => holdersHere(company, account),
  anchored: anchoredHere(companyId, company, account),
});

/** The company as this page believes it (`openAccount`), its signers read from its roster record only. */
export const openedHere = (sealed: SealedAccount): Promise<BelievedAccount | null> => openAccount(sealed, holdersHere, anchoredHere);

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
): DirectoryRead => (asked) => directoryHere(directoryDeps(companyId, company, account, roster), asked);

/** The same directory with the records it was replayed with, stopped or not: what anchoring reads, to refuse on a stop in its own words. */
const directoryWithItsRecordsFor = (
  companyId: string, company: CompanyLabel, account: AccountAddress, roster: () => Promise<Pick<Account, 'signers'>>,
): DirectoryRead => (asked) => directoryWithItsRecordsHere(directoryDeps(companyId, company, account, roster), asked);

/**
 * Why the one-a-day anchor did not run, where this page decides it rather than
 * the anchor: a company with no account on the chain has nothing to anchor. A
 * code, never wording: the language file holds the words for it.
 */
export const NOT_ANCHORED = { noAccount: 'no-account' } as const;

/**
 * **THE ONE-A-DAY ANCHOR, AS THIS PAGE ENTERS A COMPANY** (`anchoredOnTheWayIn`):
 * with this seat's own keys, the directory as this page believes it, and the
 * page's vault worker. Never thrown; what it did is its answer.
 */
export const anchoredOnTheWayInFor = async (
  sealed: SealedAccount, keys: AccountKeys, roster: () => Promise<Pick<Account, 'signers'>>,
): Promise<OnTheWayIn> => {
  try {
    const company = sealed.companyLabel as CompanyLabel | undefined;
    const account = sealed.contractAddress as AccountAddress | undefined;
    if (company === undefined || company === null || account === undefined || account === null) {
      return { notAnchored: NOT_ANCHORED.noAccount };
    }
    return await anchoredOnTheWayIn({
      accountId: sealed.id,
      material: { signingSecret: keys.signingSecret, blinding: keys.blinding, scope: keys.scope },
      manifest: manifestServiceFor(api),
      tree: treeServiceFor(api),
      ...treeKeptHere(),
      directory: directoryWithItsRecordsFor(sealed.id, company, account, roster),
      directoryFilings: () => directoryFilingsFrom(api, sealed.id),
      fileDirectory: (filing) => fileDirectoryFiling(api, sealed.id, filing),
      onChain: anchorsOnChainFor(company, account),
      vouching: vouchingFor(sealed.id),
      tagSeats: tagSeatsFor(sealed.id, company, account),
      ownOpening: async () => ownOpeningFiled({
        ...(await openingDoorsFor(sealed.id, account)),
        material: { signingSecret: keys.signingSecret, blinding: keys.blinding, scope: keys.scope },
        entered: recordsEnteredFor(manifestServiceFor(api), sealed.id, keys.signingSecret),
      }),
      service: anchorServiceFor(api),
      builder: await theVaultBuilder(),
    });
  } catch (e) {
    return { notAnchored: e instanceof Error ? e.message : ACT_REFUSAL.didNotFinish };
  }
};
