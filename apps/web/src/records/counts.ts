import type { CompanyRecords, ProposalRow } from '../adapters/company-records.js';
import { wasRead } from '../adapters/reads.js';

/*
 * The counts the menu shows beside a page's name. Only types are taken from
 * the records' adapter, so the list of pages, which the first download
 * carries, does not carry the code that opens a company's records.
 */

/** The proposals waiting for approval, which the menu counts beside Proposals; null when they could not be read. */
export const proposalsWaiting = (records: CompanyRecords): number | null =>
  wasRead(records.proposals) ? records.proposals.value.filter((p) => p.status === 'open').length : null;

/** How many of the listed proposals this device could not read: they are listed by their numbers alone, and never counted as waiting. */
export const proposalsNotRead = (rows: readonly ProposalRow[]): number => rows.filter((p) => p.kind === 'unreadable').length;
