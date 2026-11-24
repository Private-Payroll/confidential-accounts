import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import type { Hex } from '../../../../src/core/crypto.js';
import type { Account, SealedAccount } from '../../../../src/core/types.js';
import { companyKeyReleasedFor, companyKeysForVaults, seatHeldHere, viewingKeyFor, watchCompanyKeyReleased, type OpenedAccount } from 'vaults-web-shared/keyring.js';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import { signersCheckNoted, type RosterReads } from 'vaults-web-shared/roster-here.js';
import type { DirectoryRead } from 'vaults-web-shared/vault-page-doors.js';
import { readsJoinedIn, type FreshJudge, type ReadsThroughTheView } from 'vaults-web-shared/http-sealed-pool-store.js';
import { treeKeptHere } from 'vaults-web-shared/tree-kept-here.js';
import { companyJudges, openAccountWith, seatsAdmittedWith } from 'vaults-web-shared/company-judges.js';
import type { JudgeView } from 'vaults-web-shared/company-view-judges.js';
import {
  accountOnPage, indexerOnPage, onTheChain, openOnPage, vaultOnPage, vaultRoundOnPage, whereOnTheChainIn, type OnTheChain, type PageDoors,
} from 'vaults-web-shared/company-view-on-page.js';
import type { VaultOnChainOnTheWire } from 'vaults-web-shared/vault-worker-client.js';
import { watchReadsStale } from 'vaults-web-shared/company-reads-stale.js';
import { Fault, FAULT } from '../faults.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/* Why a company did not open here, as a code: handed on with the company read, so a list loads it with this file. */
export { ACT_REFUSAL, refusalOf } from './refusals.js';

/*
 * WHO THIS PAGE BELIEVES FILED A COMPANY'S RECORDS, the one way every screen
 * asks it: the judges every device reads a company with (`companyJudges`),
 * built for one view of the company (company-view-on-page.ts) from this page's
 * doors - the view itself, which reads the company's service and asks the
 * person's own wallet who holds the account once for every judge of the
 * opening (with no press: nothing is signed), this page's vault worker and
 * what the wallet read from the saved keys for this tab (each seat's public
 * halves, each company's viewing key it opened). What is built on the
 * company's directory is built once for the view and goes with it.
 */

/** One company as one opening of a screen on this page reads it. */
export type PageView = JudgeView;

/* Why this page ends a view, as the view says it to whoever reads through it afterwards. */
export const ENDED = { keyReleased: 'the wallet released the company\'s key', readDone: 'its read is done', movedOn: 'the page moved on' } as const;

type Judges = ReturnType<typeof companyJudges>;
const judgesFor = new WeakMap<PageView, Judges>();

/**
 * How a record store reaches the company's records on this page: through the opening's view alone, for reads only. The
 * page files nothing through a store, so the reach carries no way to file, and a store that could file cannot be made
 * over it. A body newer than the view's held answer is judged once more over a fresh one (the view's `heldAgain`).
 */
export const storeReachIn = (view: PageView): ReadsThroughTheView => {
  const { vaultRecord, companyRecord, company, heldAgain } = readsJoinedIn({ current: () => view });
  return { vaultRecord, companyRecord, company, heldAgain };
};

/* Each door reaches its module at the moment it is used, never when this file loads. */
const pageDoors: PageDoors = {
  walletOrigin: ACCOUNT_ORIGIN,
  builder: () => theVaultBuilder(),
  held: (view, where) => judgesOf(view).heldReaderFor(view.company, where.account),
  directory: async (view) => {
    const opened = judgesOf(view).openedInOrder(await sealedIn(view));
    if (opened === null) throw new Fault(FAULT.directoryWithNoKeysHere);
    return (await opened.directory())();
  },
};

/** The view itself for its own company; a judge asked about any other company is a mistake in this code, and reads nothing. */
export const onlyItsOwn = <V extends { readonly company: string }>(view: V) => (companyId: string): V => {
  if (companyId !== view.company) throw new Fault(FAULT.judgeAskedAnotherCompany);
  return view;
};

/** The judges of one view: every one of them reads the company through it, and through it alone. */
function judgesOf(view: PageView): Judges {
  const made = judgesFor.get(view);
  if (made !== undefined) return made;
  const roster = { view: onlyItsOwn(view), keysFor: seatHeldHere, servedKeyFor: viewingKeyFor };
  const judges = companyJudges({
    view: onlyItsOwn(view),
    indexer: () => indexerOnPage(view),
    builder: () => theVaultBuilder(),
    keysFor: (companyId) => seatHeldHere(companyId),
    /* This seat's served copy of the company's key, as the wallet opened it, only ever checked against the directory before it is used. */
    servedKeyFor: viewingKeyFor,
    released: (companyId) => companyKeyReleasedFor(companyId),
    askReleased: async (companyId) => (await companyKeysForVaults(companyId, ACCOUNT_ORIGIN)).companyKey as Hex,
    treeKept: () => treeKeptHere(),
    openAccount: (...a) => openAccountWith(roster, ...a),
    seatsAdmittedFor: (...a) => seatsAdmittedWith(roster, ...a),
    noAccount: () => { throw new Fault(FAULT.companyKeysWithNoAccount); },
  });
  judgesFor.set(view, judges);
  return judges;
}

/**
 * A new view of `companyId`, for one opening of a screen: the screen holds it, hands it to every tile, hook and action
 * of the opening, and ends it. `where`, when the opener already has it, is where the company is on the chain, so the
 * view finds it there without reading the company's account (`openOnPage`).
 */
export const openViewOf = (companyId: string, where?: OnTheChain): PageView => openOnPage(companyId, pageDoors, where);

/**
 * `read` through a view of `companyId` opened for it alone and ended when it is done: a read no screen's opening
 * makes (each company in the list of the person's companies, a deposit that runs on whatever the screen does), and a
 * read made again after an action in the wallet ended the screen's view. `listedAs`, a row of the person's companies
 * the opener already has, names where the company is on the chain, so the view reads no account to find it.
 */
export const readThroughAViewOf = async <T>(companyId: string, read: (view: PageView) => Promise<T>, listedAs?: unknown): Promise<T> => {
  const view = openViewOf(companyId, whereOnTheChainIn(listedAs) ?? undefined);
  try {
    return await read(view);
  } finally {
    view.end(ENDED.readDone);
  }
};

/**
 * Tells `ends` each time the screen's view of `companyId` must end under it, with why, and whether the screen opens
 * another: the wallet released the company's key, an action in the wallet ran on the company or somebody signed in
 * (it opens another); the sign-in ended (it does not: nobody is signed in to read as). Returns the way to stop.
 */
export const watchViewEndsFor = (companyId: string, ends: (why: string, again: boolean) => void): (() => void) => {
  const stops = [
    watchCompanyKeyReleased((accountId) => { if (accountId === companyId) ends(ENDED.keyReleased, true); }),
    watchReadsStale((stale) => { if (stale.company === null || stale.company === companyId) ends(stale.why, stale.signedIn); }),
  ];
  return () => { for (const stop of stops) stop(); };
};

/** The company's account as the service keeps it, read once for the view; it does not wait for the wallet. */
export const sealedIn = async (view: PageView): Promise<SealedAccount> => await accountOnPage(view) as SealedAccount;

/**
 * The company as the wallet is asked to name it: its record, its label and its account on the chain, as the page's
 * view of it reads them from the service's record of it; the wallet checks them on the chain itself before it acts.
 * Null for a company with no account on the chain yet.
 */
export const namedIn = async (view: PageView): Promise<{ record: string; company: string; account: string } | null> => {
  const where = await onTheChain(view);
  return where === null ? null : { record: view.company, company: where.company, account: where.account };
};

/** Where the view's company is on the chain, or null while it has no account there. */
export const onTheChainIn = (view: PageView): Promise<OnTheChain | null> => onTheChain(view);

/**
 * The indexer this person's own wallet reads the chain through, as it said when the view asked it who holds the
 * company, or null when it said none: the one place a vault is read from on this device. No other address is ever used.
 */
export const walletIndexerIn = (view: PageView): Promise<WalletIndexer | null> => indexerOnPage(view);

/**
 * A vault on the chain at the wallet's indexer, read through the view with every vault the account adopted, once for
 * every tile of the opening; `round` is 0, or one `vaultReadAgainIn` handed out (`vaultOnPage`).
 */
export const vaultOnChainIn = (view: PageView, vault: string, indexer: WalletIndexer, round = 0): Promise<VaultOnChainOnTheWire> =>
  vaultOnPage(view, vault, indexer, round);

/** A new round of reading the vaults again on this opening, for one press to read again (`vaultRoundOnPage`). */
export const vaultReadAgainIn = (view: PageView): number => vaultRoundOnPage(view);

/** What a roster is read with on this page. */
export const rosterReadsIn = (view: PageView, where: OnTheChain): RosterReads => judgesOf(view).rosterReadsFor(view.company, where.company, where.account);
/** The company as this page believes it, its signers read from its roster record only; a refusal is written to the console report, then thrown, and a company with no account yet is said once as that. */
export const openedHere = (view: PageView, sealed: SealedAccount): Promise<OpenedAccount | null> => signersCheckNoted(() => judgesOf(view).openedHere(sealed), sealed.id);
/** The company opened as a page load reads it: the wallet is never asked (`openedQuietlyHere`). */
export const openedQuietly = (view: PageView, sealed: SealedAccount): Promise<OpenedAccount | null> => signersCheckNoted(() => judgesOf(view).openedQuietlyHere(sealed), sealed.id);

/** Whether a filing's signer is one the company's directory believes, as this page reads it. */
export const filingJudgeFor = (
  view: PageView, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
): FreshJudge => judgesOf(view).filingJudgeFor(view.company, company, account, viewingKey, roster);
/** The company's directory as this page believes it, read through the view at each call. */
export const directoryHereFor = (
  view: PageView, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
): DirectoryRead => judgesOf(view).directoryHereFor(view.company, company, account, viewingKey, roster);
/** The company's directory with every record it names read beside it, which gives a stop in the records as a state and does not refuse the read. */
export const directoryWithItsRecordsFor = (
  view: PageView, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
): DirectoryRead => judgesOf(view).directoryWithItsRecordsFor(view.company, company, account, viewingKey, roster);
/** The company's key of each epoch this page can use, every one found in the directory's filings and believed there. */
export const companyKeysFor = (
  view: PageView, sealed: SealedAccount, keys: { readonly signingPublicKey: Hex },
): Promise<CompanyKeyHere> => judgesOf(view).companyKeysFor(view.company, sealed, keys);

/** What the shared judges are told to keep the wallet out of the read. */
const QUIETLY = 'not-opened';

/** The company's keys as a page load reads them: the wallet is never asked, and a copy it has not released on this visit is named in `notOpened`. */
export const companyKeysQuietlyFor = (
  view: PageView, sealed: SealedAccount, keys: { readonly signingPublicKey: Hex },
): Promise<CompanyKeyHere> => judgesOf(view).companyKeysFor(view.company, sealed, keys, QUIETLY);
