/**
 * DATES AND PLAIN NUMBERS IN THE PERSON'S LANGUAGE, through the browser's own
 * formatters. A plain number is a count or a figure that is not money; money
 * goes through `Amount`, which never rounds and marks what is public.
 *
 * A count of a token's smallest units is a `bigint`, and the browser's number
 * formatter would write one as readily as a number, unmarked. So a plain number
 * is a JavaScript number and nothing else: a `bigint` passed here by a cast is
 * refused, and so is an amount, which refuses to become a number at all.
 */
export function formatNumber(value: number, tag: string, options?: Intl.NumberFormatOptions): string {
  if (typeof value !== 'number') throw new TypeError(`a plain number is a number, and this is a ${typeof value}; an amount is shown by Amount`);
  return new Intl.NumberFormat(tag, options).format(value);
}

export function formatDate(value: Date, tag: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(tag, options ?? { dateStyle: 'medium' }).format(value);
}

/** The units a time ago is said in: the browser's names for them, passed and never shown. */
const UNIT = { second: 'second', minute: 'minute', hour: 'hour', day: 'day' } as const;

/** Below each number of seconds, the unit a time ago is said in: seconds under a minute, minutes under an hour, hours under a day. */
const STEPS = [[60, UNIT.second], [3_600, UNIT.minute], [86_400, UNIT.hour]] as const;

/**
 * HOW LONG AGO `since` WAS, AT `now`, in the person's language: in seconds
 * under a minute, minutes under an hour, hours under a day, and days after.
 */
export function formatTimeAgo(since: Date, now: Date, tag: string): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  const words = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  let per = 1;
  for (const [below, unit] of STEPS) {
    if (seconds < below) return words.format(-Math.floor(seconds / per), unit);
    per = below;
  }
  return words.format(-Math.floor(seconds / 86_400), UNIT.day);
}
