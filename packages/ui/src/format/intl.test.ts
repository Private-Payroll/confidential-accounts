import { describe, expect, it } from 'vitest';
import { formatDate, formatNumber } from './intl.js';

describe('a plain number', () => {
  /* RED WHEN: the plain-number formatter writes a bigint, so an amount passed to it by a cast is shown unmarked. */
  it('is a number and never a bigint', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(() => formatNumber(12n as unknown as number, 'en')).toThrow(/an amount is shown by Amount/);
  });

  /* RED WHEN: a date given no style is not written in the medium style, or a style given is ignored. */
  it('writes a date in the medium style unless told otherwise', () => {
    const d = new Date(Date.UTC(2026, 8, 28, 12));
    expect(formatDate(d, 'en')).toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(d));
    expect(formatDate(d, 'en', { year: 'numeric' })).toBe('2026');
  });
});
