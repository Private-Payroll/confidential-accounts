import { describe, expect, it } from 'vitest';
import { formatTokenAmount } from './token-amount.js';
import { formatDate, formatNumber } from './intl.js';

/** Larger than Number.MAX_SAFE_INTEGER by six orders of magnitude, so a number could not hold it. */
const BIG = 12_345_678_901_234_567_890_123n;
const NNBSP = ' ';

describe('a token amount is written out exactly, in the language', () => {
  /*
   * RED WHEN: the amount passes through a Number (the last digits change), the
   * whole part is grouped like English whatever the language, the separator is
   * not the language's, or a trailing zero is dropped.
   */
  const cases: [string, [string, string, string]][] = [
    ['en', ['12,345,678,901,234,567.890123', '1.500000', '1,234']],
    ['en-IN', ['12,34,56,78,90,12,34,567.890123', '1.500000', '1,234']],
    ['de', ['12.345.678.901.234.567,890123', '1,500000', '1.234']],
    ['fr', [`12${NNBSP}345${NNBSP}678${NNBSP}901${NNBSP}234${NNBSP}567,890123`, '1,500000', `1${NNBSP}234`]],
    ['es', ['12.345.678.901.234.567,890123', '1,500000', '1234']],
  ];
  it.each(cases)('%s', (tag, [big, trailing, whole]) => {
    expect(formatTokenAmount(BIG, 6, tag)).toBe(big);
    expect(formatTokenAmount(1_500_000n, 6, tag)).toBe(trailing);
    expect(formatTokenAmount(1234n, 0, tag)).toBe(whole);
  });

  /*
   * Arabic is written with Western digits or Arabic-Indic ones depending on the
   * locale data the runtime carries; both expected texts are written out, and
   * the one for the digits this runtime chose is the one required.
   * RED WHEN: the fraction is written in other digits than the whole part, or a
   * digit is lost.
   */
  it('ar, in whichever digits the runtime writes Arabic with', () => {
    const system = new Intl.NumberFormat('ar').resolvedOptions().numberingSystem;
    const expected: Record<string, [string, string]> = {
      latn: ['12,345,678,901,234,567.890123', '1.500000'],
      arab: ['١٢٬٣٤٥٬٦٧٨٬٩٠١٬٢٣٤٬٥٦٧٫٨٩٠١٢٣', '١٫٥٠٠٠٠٠'],
    };
    expect(Object.keys(expected)).toContain(system);
    expect([formatTokenAmount(BIG, 6, 'ar'), formatTokenAmount(1_500_000n, 6, 'ar')]).toEqual(expected[system]);
  });

  /* RED WHEN: a language with its own digits gets Western ones after the separator. */
  it('writes the fraction in the language\'s own digits', () => {
    expect(formatTokenAmount(BIG, 6, 'ar-EG')).toBe('١٢٬٣٤٥٬٦٧٨٬٩٠١٬٢٣٤٬٥٦٧٫٨٩٠١٢٣');
  });

  /* RED WHEN: the smallest unit of an eighteen-decimal token rounds to zero, or leading zeros of the fraction go. */
  it('writes the smallest unit of a token with many decimals', () => {
    expect(formatTokenAmount(5n, 18, 'en')).toBe('0.000000000000000005');
    expect(formatTokenAmount(0n, 2, 'en')).toBe('0.00');
  });

  /* RED WHEN: the type or the function lets a Number through, or a negative amount or a bad decimals count is written. */
  it('refuses what is not an exact amount', () => {
    // @ts-expect-error a token amount is a bigint, never a number
    expect(() => formatTokenAmount(1500000, 6, 'en')).toThrow(/bigint of the token's smallest unit, and this is a number/);
    expect(() => formatTokenAmount(-1n, 6, 'en')).toThrow(/never below zero/);
    expect(() => formatTokenAmount(1n, -1, 'en')).toThrow(/whole number from 0 up/);
    expect(() => formatTokenAmount(1n, 1.5, 'en')).toThrow(/whole number from 0 up/);
  });
});

describe('dates and plain numbers follow the language', () => {
  /* RED WHEN: the language is ignored, so every language is formatted one way. */
  it('formats by the tag given', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(1234.5, 'de')).toBe('1.234,5');
    const d = new Date(Date.UTC(2026, 8, 28, 12));
    expect(formatDate(d, 'en', { dateStyle: 'long', timeZone: 'UTC' })).toBe('September 28, 2026');
    expect(formatDate(d, 'de', { dateStyle: 'long', timeZone: 'UTC' })).toBe('28. September 2026');
  });
});
