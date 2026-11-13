/**
 * **A COMPANY'S RUNS AND PROPOSALS, READ BY A READER.** A reader holds no company key and no seat: the only keys it
 * has are the purpose keys its wallet released for this company on this visit (`PurposeWrapsHeld`), and every record
 * here is opened with those and nothing else. A purpose the grant does not name, and an epoch it never wrapped, open
 * nothing: that record reads as unreadable. A kind the service does not let this reader fetch answers "not found",
 * which is said as `not-in-access`, never as a grant taken away: whether the grant still stands is the wallet's answer
 * to a release, not a route's. What a proposal pays is sealed under the company key and is not read here.
 */
import { reviveBigints } from '../../../../src/core/crypto.js';
import { openRoster } from '../../../../src/core/roster-record.js';
import type { PayrollRun, SealedAccount, SealedProposal, SealedRun } from '../../../../src/core/types.js';
import type { SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { api, NotOnTheService } from 'vaults-web-shared/keyring.js';
import { purposeKeysAt, type PurposeWrapsHeld } from 'vaults-web-shared/purpose-wraps.js';
import { readerDirectoryHereFor } from './filing-judge.js';
import {
  proposalRow, proposalsHere, runRow, runsPaidFromTheChain, SERVICE, type ProposalRow, type RunRow, type SignerRow,
} from './company-records.js';
import { openRun } from './runs-and-proposals-opened.js';
import { READ, type Read } from './reads.js';

/** The company a reader opens: its id on the service and the label and contract address its link named. */
export interface ReaderLink {
  readonly id: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
}

/** A read that may also be one the reader's access does not include. */
/** A read the service answered as not found: outside this reader's access. Compared by the code. */
export const NOT_IN_ACCESS = 'not-in-access';
type ReaderRead<T> = Read<T> | { readonly of: typeof NOT_IN_ACCESS };

export const READER_OF = { open: 'open', refused: 'refused' } as const;
export const READER_REFUSED = { notTheCompanys: 'not-the-companys', unreached: 'unreached' } as const;

export type ReaderCompany =
  | { readonly of: typeof READER_OF.open; readonly id: string; readonly label: CompanyLabel; readonly runs: ReaderRead<ReaderRuns>; readonly proposals: ReaderRead<readonly ProposalRow[]> }
  | { readonly of: typeof READER_OF.refused; readonly why: (typeof READER_REFUSED)[keyof typeof READER_REFUSED] };

type SealedWithRoster = SealedAccount & { readonly roster?: SealedCompanyRecord | null };
type Signers = readonly (SignerRow & { readonly signingPublicKey?: string })[];

const ask = async (path: string): Promise<unknown> => reviveBigints(await api(path));

/** One read on its own: a failure is handed on as unreadable, and a "not found" as outside this reader's access. */
async function readerRead<T>(read: () => Promise<T>): Promise<ReaderRead<T>> {
  try { return { of: READ.read, value: await read() }; } catch (e) {
    return e instanceof NotOnTheService ? { of: NOT_IN_ACCESS } : { of: READ.unreadable };
  }
}

/** The company's signers as its roster names them, opened with the roster key this reader was released; none when it does not open. */
function signersOf(held: PurposeWrapsHeld, sealed: SealedWithRoster): Signers {
  const roster = sealed.roster ?? null;
  if (roster === null || roster.company !== held.accountId) return [];
  try {
    return openRoster(roster, purposeKeysAt(held, roster.keyEpoch)).signers.map((s) => ({ id: s.id, name: s.name, signingPublicKey: s.signingPublicKey }));
  } catch {
    /* A roster that does not open with this reader's keys names nobody: the rows then name no raiser, and nothing else is lost. */
    return [];
  }
}

/** The runs of a company that open with this reader's keys, and the id and period of each that does not. */
interface RunsOpened {
  readonly opened: readonly PayrollRun[];
  readonly unreadable: readonly ReaderRunUnread[];
}

/** A run this reader's keys do not open: it is named by what the service serves beside the seal. */
interface ReaderRunUnread {
  readonly id: string;
  readonly period: string;
}

/** The runs the reader's payroll key opens, each opened on its own so one sealed at an epoch the grant never wrapped is listed, not fatal. */
async function readReaderRuns(held: PurposeWrapsHeld, id: string): Promise<RunsOpened> {
  const served = await ask(SERVICE.company + id + SERVICE.runs) as SealedRun[];
  const opened: PayrollRun[] = [];
  const unreadable: ReaderRunUnread[] = [];
  for (const r of served) {
    try { opened.push(openRun(r, held)); } catch { unreadable.push({ id: r.id, period: r.period }); }
  }
  return { opened, unreadable };
}

/** A company's runs as rows, newest period first, and the runs that did not open. */
interface ReaderRuns {
  readonly rows: readonly RunRow[];
  readonly unreadable: readonly ReaderRunUnread[];
}

/** The proposals, as the chain holds them and as the roster's signers filed them, each opened with the proposals key of its epoch. */
async function readReaderProposals(
  held: PurposeWrapsHeld, link: ReaderLink, sealed: SealedWithRoster, runs: readonly PayrollRun[],
): Promise<readonly ProposalRow[]> {
  const served = await ask(SERVICE.company + link.id + SERVICE.proposals) as SealedProposal[];
  const directory = readerDirectoryHereFor(link.id, link.label, link.account)(held);
  const here = await proposalsHere(link.id, sealed, served, directory, held);
  const signers = signersOf(held, sealed);
  return [...here.believed.map((p) => proposalRow(p.opened, p.standing, signers, runs)), ...here.unreadable];
}

/** Reads the company a reader's link names, refusing a link whose label or address is not the one the service holds for that company. */
export async function readReaderCompany(held: PurposeWrapsHeld, link: ReaderLink): Promise<ReaderCompany> {
  let sealed: SealedWithRoster;
  try {
    sealed = await ask(SERVICE.company + link.id) as SealedWithRoster;
  } catch {
    return { of: READER_OF.refused, why: READER_REFUSED.unreached };
  }
  if (held.accountId !== link.id || sealed.companyLabel !== link.label || sealed.contractAddress?.toLowerCase() !== link.account.toLowerCase()) {
    return { of: READER_OF.refused, why: READER_REFUSED.notTheCompanys };
  }
  const opened = await readerRead(() => readReaderRuns(held, link.id));
  const runs: ReaderRead<ReaderRuns> = opened.of !== READ.read ? opened : await readerRead(async () => ({
    rows: await runsPaidFromTheChain(sealed, opened.value.opened.map((r) => runRow(r)).sort((a, b) => b.period.localeCompare(a.period))),
    unreadable: opened.value.unreadable,
  }));
  const proposals = await readerRead(() => readReaderProposals(held, link, sealed, opened.of === READ.read ? opened.value.opened : []));
  return { of: READER_OF.open, id: link.id, label: link.label, runs, proposals };
}
