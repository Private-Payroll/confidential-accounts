/**
 * **THE DAYS AND THE SALARY A PAYEE IS PAID BY**, read from their record's dates and salary history, for either of a
 * company's lists. A run, the raise, the approval and the payout ask here which days of a month a payee is payable
 * for, and which salary line a month pays; a change is refused here when it would alter a month already raised.
 * Kept apart from the records themselves so the run code reads it without them.
 *
 * Pure: the server and the page both import it.
 */
import { canonicalPeriod, isCalendarDate } from './calendar-days.js';
import type { EmployeeClassification } from './invitation.js';
import type { PayLine, RosterEmployee } from './types.js';

/** The dates a payee on either list is paid within: calendar days, never converted between timezones. */
export interface PayableDates {
  readonly startDate: string;
  readonly endDate?: string | null;
  readonly leavingDate?: string | null;
}

/** A run of calendar days, both ends included. */
export interface PayableDays {
  readonly first: string;
  readonly last: string;
}

/** The first and last calendar day of a period written as a year and a month. Throws on anything that is not a period. */
export const daysOfPeriod = (period: string): PayableDays => {
  const month = canonicalPeriod(period);
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { first: `${month}-01`, last: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};

/** The two dates a payee's payments stop on, each with how a refusal names it. */
export const STOPS = [['endDate', 'end date'], ['leavingDate', 'leaving date']] as const;

/** Why a record's own dates cannot be paid by, or null: each must be a calendar date, and none may end before the start. */
export const datesOfTheRecordRefusal = (d: PayableDates): string | null => {
  if (!isCalendarDate(d.startDate)) return 'their record\'s start date is not a calendar date';
  for (const [field, said] of STOPS) {
    const day = d[field];
    if (day === undefined || day === null) continue;
    if (!isCalendarDate(day)) return `their record's ${said} is not a calendar date`;
    if (day < d.startDate) return `their record's ${said} is before their start date`;
  }
  return null;
};

/** The earlier of the end and leaving dates, with which one it is, or null when neither is set. */
export const earliestStopOf = (d: Pick<PayableDates, 'endDate' | 'leavingDate'>): { readonly day: string; readonly said: string } | null => stopOf(d);

const stopOf = (d: Pick<PayableDates, 'endDate' | 'leavingDate'>): { readonly day: string; readonly said: string } | null => {
  let stop: { day: string; said: string } | null = null;
  for (const [field, said] of STOPS) {
    const day = d[field];
    if (typeof day === 'string' && (stop === null || day < stop.day)) stop = { day, said };
  }
  return stop;
};

/**
 * **THE DAYS OF `period` A PAYEE ON EITHER LIST IS PAYABLE FOR**, or null when none: from the later of the period's
 * first day and their start date, to the earlier of the period's last day and their end or leaving date. Nothing
 * here splits a month's pay between the days; a run pays a month whole for anybody payable on any day of it.
 * Throws when the period or the record's own dates are not calendar dates.
 */
export const payableDaysIn = (d: PayableDates, period: string): PayableDays | null => {
  const bad = datesOfTheRecordRefusal(d);
  if (bad !== null) throw new Error(bad);
  const month = daysOfPeriod(period);
  const stop = stopOf(d);
  const first = d.startDate > month.first ? d.startDate : month.first;
  const last = stop !== null && stop.day < month.last ? stop.day : month.last;
  return first <= last ? { first, last } : null;
};

/**
 * **THE DAYS OF `period` A PAYEE IS PAYABLE FOR, OR WHY NONE**: `{ days }` with the first and last payable calendar
 * day (`payableDaysIn`), or `{ days: null, why }` when their dates leave out every day of it or are not dates at all.
 * The one dated check both lists are paid by; a pay calculation for part of a month reads its days from here.
 */
export const payableDaysOrWhy = (d: PayableDates, period: string): { readonly days: PayableDays; readonly why?: never } | { readonly days: null; readonly why: string } => {
  const bad = datesOfTheRecordRefusal(d);
  if (bad !== null) return { days: null, why: bad };
  const days = payableDaysIn(d, period);
  if (days !== null) return { days };
  const month = canonicalPeriod(period);
  if (d.startDate > daysOfPeriod(period).last) return { days: null, why: `they start on ${d.startDate}, after ${month}` };
  const stop = stopOf(d)!;
  return { days: null, why: `their ${stop.said} is ${stop.day}, before ${month}` };
};

/** Why a payee is not payable for any day of `period`, or null when they are for at least one (`payableDaysOrWhy`). */
export const outsideTheirDates = (d: PayableDates, period: string): string | null => payableDaysOrWhy(d, period).why ?? null;

/**
 * **A PERSON'S SALARY HISTORY**, oldest first. A record filed before the history was kept is read as one line: the
 * amount they were hired at, from their start date, made by nobody the record names.
 */
export const payLinesOf = (p: Pick<RosterEmployee, 'baseAmount' | 'startDate' | 'pay'>): readonly PayLine[] =>
  p.pay !== undefined && p.pay.length > 0 ? p.pay : [{ amount: p.baseAmount, from: p.startDate, madeBy: null, madeAt: null }];

/** The line in force on `day`: the latest from-date on or before it, and of two from the same day, the later added. */
const inForceOn = <L extends { readonly from: string }>(lines: readonly L[], day: string): L | null => {
  let found: L | null = null;
  for (const line of lines) if (line.from <= day && (found === null || line.from >= found.from)) found = line;
  return found;
};

/** The salary line in force on a calendar day, or null before the first. */
export const payLineOn = (p: Pick<RosterEmployee, 'baseAmount' | 'startDate' | 'pay'>, day: string): PayLine | null => inForceOn(payLinesOf(p), day);

/** The salary line a run for `period` pays: the one in force on the period's last day. No month is split between two lines. */
export const payLineFor = (p: Pick<RosterEmployee, 'baseAmount' | 'startDate' | 'pay'>, period: string): PayLine | null =>
  payLineOn(p, daysOfPeriod(period).last);

/** An employee's classification on a calendar day, or null before the first line. */
export const classificationOn = (p: Pick<RosterEmployee, 'classifications'>, day: string): EmployeeClassification | null =>
  inForceOn(p.classifications ?? [], day)?.classification ?? null;

/** The months, as year and month, that have a run past draft: paid, or raised to be. A month in any other form is not one. */
export const periodsPastDraft = (runs: readonly { readonly period: string; readonly status: string }[]): string[] => {
  const months = new Set<string>();
  for (const r of runs) {
    if (r.status === 'draft') continue;
    try { months.add(canonicalPeriod(r.period)); } catch { /* not a month a run can be raised for */ }
  }
  return [...months].sort();
};

/**
 * Why an end or leaving date (`said` names which) may not be set to `day`, or null: it is a calendar date, and it
 * does not leave out the latest month with a run past draft, though it may fall inside it. Taking a date away
 * (`null`) leaves nobody out.
 */
export const stopDateRefusal = (day: string | null, said: string, pastDraft: readonly string[]): string | null => {
  if (day === null) return null;
  const an = /^[aeiou]/iu.test(said) ? 'an' : 'a';
  if (!isCalendarDate(day)) return `${an} ${said} is a calendar date such as 2026-07-01`;
  const latest = [...pastDraft].sort().at(-1);
  if (latest !== undefined && day < daysOfPeriod(latest).first) {
    return `a run has been raised for ${latest}, so ${an} ${said} of ${day} would leave out a month already raised: set it on ${daysOfPeriod(latest).first} or later`;
  }
  return null;
};
