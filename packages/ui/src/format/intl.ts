/**
 * DATES AND PLAIN NUMBERS IN THE PERSON'S LANGUAGE, through the browser's own
 * formatters. A plain number is a count or a figure that is not money; money
 * goes through `Amount`, which never rounds and marks what is public.
 *
 * An amount is a `bigint`, and the browser's number formatter would write one
 * as readily as a number, unmarked. So a plain number is a JavaScript number
 * and nothing else: a `bigint` passed here by a cast is refused.
 */
export function formatNumber(value: number, tag: string, options?: Intl.NumberFormatOptions): string {
  if (typeof value !== 'number') throw new TypeError(`a plain number is a number, and this is a ${typeof value}; an amount is shown by Amount`);
  return new Intl.NumberFormat(tag, options).format(value);
}

export function formatDate(value: Date, tag: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(tag, options ?? { dateStyle: 'medium' }).format(value);
}
