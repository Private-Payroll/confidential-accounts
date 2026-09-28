/**
 * DATES AND PLAIN NUMBERS IN THE PERSON'S LANGUAGE, through the browser's own
 * formatters. A plain number is a count or a figure that is not money; money
 * goes through `Amount`, which never rounds and marks what is public.
 */
export function formatNumber(value: number, tag: string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(tag, options).format(value);
}

export function formatDate(value: Date, tag: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return new Intl.DateTimeFormat(tag, options).format(value);
}
