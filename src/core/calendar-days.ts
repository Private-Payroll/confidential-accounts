/**
 * **THE CALENDAR AS THE RECORDS WRITE IT**: a calendar day, a UTC moment and a pay period, each checked or put in its
 * one written form here. Kept apart so the people's and vendors' records, and the screens that read them, read dates
 * without the invitation or the run code behind them.
 *
 * Pure: the server and the page both import it.
 */

/** True for a calendar date written as year, month and day (2026-07-01): a date, never a moment, so no timezone moves it. */
export const isCalendarDate = (x: unknown): x is string => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(x)) return false;
  const [y, m, d] = x.split('-').map(Number) as [number, number, number];
  const at = Date.UTC(y, m - 1, d);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === x;
};

/** True for one UTC moment to the second (2026-06-20T15:00:00Z); each viewer shows it in their own local time. */
export const isUtcMoment = (x: unknown): x is string => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(x)) return false;
  const at = Date.parse(x);
  return Number.isFinite(at) && utcMomentOf(at) === x;
};

/** The UTC moment, to the second, of a time in milliseconds. */
export const utcMomentOf = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/u, 'Z');

/**
 * A pay period has one spelling, and anything else is refused here rather than compared later. Every guard against
 * paying somebody twice (`samePeriod`, `refuseAPeriodAlreadyRaised`) compares periods, and `2026-8` or `2026-08 `
 * would otherwise be a different period to all of them: a second run could be drawn beside the first and both paid.
 * So a period is made canonical where it enters, by this pure function that the server and the page both import, and
 * no path to a guard carries a loose spelling. Returns `YYYY-MM` for anything that names a month; throws for
 * anything else, with the form that is wanted.
 */
export const canonicalPeriod = (period: string): string => {
  const written = period.trim();
  const named = /^(\d{4})-(\d{1,2})$/.exec(written);
  const month = named ? Number(named[2]) : 0;
  if (!named || month < 1 || month > 12) {
    throw new Error(
      `"${period}" does not name a pay period. A run is drawn for one month, written as the `
      + 'year, a hyphen and the month: 2026-08 is August 2026. Write the month that way and '
      + 'draw the run again.');
  }
  return `${named[1]}-${String(month).padStart(2, '0')}`;
};
