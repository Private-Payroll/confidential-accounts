import { treeKeptHere } from 'vaults-web-shared/tree-kept-here.js';
import { companyJudges } from 'vaults-web-shared/company-judges.js';
import type { JudgeView } from 'vaults-web-shared/company-view-judges.js';
import { indexerOnPage, openOnPage, type PageDoors } from 'vaults-web-shared/company-view-on-page.js';
import { readerDirectoryFor } from 'vaults-web-shared/reader-directory-here.js';
import type { DirectoryRead } from 'vaults-web-shared/vault-page-doors.js';
import type { PurposeWrapsHeld } from 'vaults-web-shared/purpose-wraps.js';
import type { ReaderLink } from './reader-records.js';
import { Fault, FAULT } from '../faults.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';
import { onlyItsOwn } from './filing-judge.js';

/*
 * WHO A READER'S PAGE BELIEVES FILED A COMPANY'S RECORDS. A reader holds no seat and no company key: it reads with
 * the purpose keys its wallet released, and the service answers it only for the kinds its grant names. Each opening
 * of the reader's page reads the company through one view of it (company-view-on-page.ts), which asks the reader's
 * own wallet who holds the account once for the opening; the directory is believed with the purpose keys, and its
 * records are proven with no anchor checkpoint kept on this device.
 */

/** One company as one opening of the reader's page reads it. */
export type ReaderView = JudgeView;

/* Why the reader's page ends a view, as the view says it to whoever reads through it afterwards. */
const ENDED = { readDone: 'its read is done' } as const;

/* A reader holds no seat on the company, so its page opens no account and no company key. */
const readerHoldsNoSeat = (): never => {
  throw new Fault(FAULT.readerHoldsNoSeat);
};

/** The judges of a reader's view: every one of them reads the company through it, and through it alone, and none holds a seat. */
export const readerJudgesOf = (view: ReaderView) =>
  companyJudges({
    view: onlyItsOwn(view),
    indexer: () => indexerOnPage(view),
    builder: () => theVaultBuilder(),
    keysFor: () => null,
    servedKeyFor: readerHoldsNoSeat,
    released: () => null,
    askReleased: async () => null,
    treeKept: () => treeKeptHere(),
    openAccount: async () => null,
    seatsAdmittedFor: async () => readerHoldsNoSeat(),
    noAccount: readerHoldsNoSeat
  });

/** The company's directory as a reader's page believes it over `view`: read with the purpose keys `held`, never a company key. */
export const readerDirectoryIn = (view: ReaderView, link: ReaderLink, held: PurposeWrapsHeld): DirectoryRead => {
  const judges = readerJudgesOf(view);
  return readerDirectoryFor({
    view,
    label: link.label,
    account: link.account,
    leaves: judges.leavesFor(link.account),
    anchored: judges.anchoredForAReader(view.company, link.label, link.account),
    invitedSeats: judges.invitedSeatsFor(link.label, link.account),
    proposalIdentity: judges.identityHere
  })(held);
};

/** The reader's page doors: its wallet and builder, and its directory believed with the purpose keys `held`. */
const readerDoors = (link: ReaderLink, held: PurposeWrapsHeld): PageDoors => ({
  walletOrigin: ACCOUNT_ORIGIN,
  builder: () => theVaultBuilder(),
  /* A reader's records are proven against its own directory with no checkpoint kept (`anchoredForAReader`), never through a seat's held read. */
  held: () => readerHoldsNoSeat,
  directory: (view) => readerDirectoryIn(view, link, held)()
});

/** `read` through a view of the company `link` names, opened for one opening of the reader's page and ended when it is done. */
export const readThroughAReaderView = async <T>(
  link: ReaderLink,
  held: PurposeWrapsHeld,
  read: (view: ReaderView) => Promise<T>
): Promise<T> => {
  const view = openOnPage(link.id, readerDoors(link, held));
  try {
    return await read(view);
  } finally {
    view.end(ENDED.readDone);
  }
};
