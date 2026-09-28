import { describe, expect, it } from 'vitest';
import { formatTokenAmount, privateAmount, PrivateAmount, publicAmount, PublicAmount, visibilityOf, type TokenAmount } from './token-amount.js';
import { formatDate, formatNumber } from './intl.js';

/** Larger than Number.MAX_SAFE_INTEGER by six orders of magnitude, so a number could not hold it. */
const BIG = 12_345_678_901_234_567_890_123n;
const NNBSP = ' ';
/** The figure of `units` of a token with `decimals`, written in `tag`. */
const fmt = (units: bigint, decimals: number, tag: string) => formatTokenAmount(privateAmount(units, decimals, 'USDC'), tag);

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
    expect(fmt(BIG, 6, tag)).toBe(big);
    expect(fmt(1_500_000n, 6, tag)).toBe(trailing);
    expect(fmt(1234n, 0, tag)).toBe(whole);
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
    expect([fmt(BIG, 6, 'ar'), fmt(1_500_000n, 6, 'ar')]).toEqual(expected[system]);
  });

  /* RED WHEN: a language with its own digits gets Western ones after the separator. */
  it('writes the fraction in the language\'s own digits', () => {
    expect(fmt(BIG, 6, 'ar-EG')).toBe('١٢٬٣٤٥٬٦٧٨٬٩٠١٬٢٣٤٬٥٦٧٫٨٩٠١٢٣');
  });

  /* RED WHEN: the smallest unit of an eighteen-decimal token rounds to zero, or leading zeros of the fraction go. */
  it('writes the smallest unit of a token with many decimals', () => {
    expect(fmt(5n, 18, 'en')).toBe('0.000000000000000005');
    expect(fmt(0n, 2, 'en')).toBe('0.00');
  });

  /* RED WHEN: either maker, or its type, lets a Number through, or a negative amount or a bad decimals count is written. */
  it('refuses what is not an exact amount, from either maker', () => {
    for (const make of [publicAmount, privateAmount]) {
      // @ts-expect-error a token amount is a bigint, never a number
      expect(() => make(1500000, 6, 'USDC')).toThrow(/bigint of the token's smallest unit, and this is a number/);
      expect(() => make(-1n, 6, 'USDC')).toThrow(/never below zero/);
      expect(() => make(1n, -1, 'USDC')).toThrow(/whole number from 0 up/);
      expect(() => make(1n, 1.5, 'USDC')).toThrow(/whole number from 0 up/);
      expect(() => make(1n, 2, '')).toThrow(/carries its token's code/);
    }
  });
});

describe('a token amount is an object that becomes text only through the formatter', () => {
  const a = privateAmount(12_345n, 2, 'USDC');
  const p = publicAmount(12_345n, 2, 'USDC');

  /* RED WHEN: an amount is a primitive again, so React would write it as its digits; or a constructor can be called from outside. */
  it('is an object, made only by its maker, whose code is readable and whose units are not', () => {
    for (const x of [a, p]) {
      expect(typeof x).toBe('object');
      expect(x.code).toBe('USDC');
      expect(Object.keys(x)).toEqual([]);
      expect(Object.getOwnPropertyNames(x)).toEqual([]);
      expect(Object.isFrozen(x)).toBe(true);
    }
    expect(a).toBeInstanceOf(PrivateAmount);
    expect(p).toBeInstanceOf(PublicAmount);
    // @ts-expect-error the constructor is not how an amount is made
    expect(() => new PrivateAmount(Symbol(), 1n, 0, 'USDC')).toThrow(/made by publicAmount or privateAmount, and by nothing else/);
    // @ts-expect-error nor this one
    expect(() => new PublicAmount(Symbol(), 1n, 0, 'USDC')).toThrow(/made by publicAmount or privateAmount, and by nothing else/);
  });

  /* RED WHEN: any way of turning an amount into text or a number, outside the formatter, writes its figure instead of refusing. */
  it('refuses every conversion to text or a number', () => {
    for (const x of [a, p]) {
      const conversions: [string, () => unknown][] = [
        ['String', () => String(x)], ['template', () => `${x as unknown as string}`], ['+ a string', () => (x as unknown as string) + ''],
        ['unary +', () => +(x as unknown as number)], ['Number', () => Number(x)], ['BigInt', () => BigInt(x as unknown as bigint)],
        ['toString', () => x.toString()], ['JSON', () => JSON.stringify({ x })], ['NumberFormat', () => new Intl.NumberFormat('en').format(x as unknown as bigint)],
        ['toLocaleString', () => x.toLocaleString()], ['join', () => [x].join('')], ['comparison', () => (x as unknown as number) > 1],
      ];
      for (const [name, convert] of conversions) expect(convert, name).toThrow(/shown only by Amount/);
    }
  });

  /* RED WHEN: the formatter takes anything but an amount made by a maker, so a bigint passed by a cast is written unmarked. */
  it('is the only thing the formatter writes', () => {
    expect(formatTokenAmount(a, 'en')).toBe('123.45');
    expect(formatTokenAmount(p, 'en')).toBe('123.45');
    expect(() => formatTokenAmount(12_345n as unknown as TokenAmount, 'en')).toThrow(/made by publicAmount or privateAmount, and this is a value of type bigint/);
    expect(() => formatTokenAmount({ code: 'USDC' } as unknown as TokenAmount, 'en')).toThrow(/made by publicAmount or privateAmount, and this is a value of type object/);
  });
});

describe('an amount carries whether anyone can look it up', () => {
  /* RED WHEN: the visibility is read from anything but how the amount was made, or a value that is not an amount is given one. */
  it('is public when made public and private when made private, and nothing else has a visibility', () => {
    expect(visibilityOf(publicAmount(1n, 0, 'NIGHT'))).toBe('public');
    expect(visibilityOf(privateAmount(1n, 0, 'NIGHT'))).toBe('private');
    expect(() => visibilityOf(1n as unknown as TokenAmount)).toThrow(/made by publicAmount or privateAmount/);
    expect(() => visibilityOf({ code: 'NIGHT' } as unknown as TokenAmount)).toThrow(/made by publicAmount or privateAmount/);
  });

  /*
   * RED WHEN: a public amount can stand where a private one is asked for, or
   * the other way: the two types are told apart when the code is typechecked,
   * not only when it runs. Each line below is an error the typecheck must
   * report; if the two became one type, the typecheck fails on the unused
   * expectation instead.
   */
  it('is a different type for each, so one is never taken for the other', () => {
    const a = privateAmount(1n, 0, 'USDC');
    const p = publicAmount(1n, 0, 'USDC');
    const takesPrivate = (x: PrivateAmount) => visibilityOf(x);
    const takesPublic = (x: PublicAmount) => visibilityOf(x);
    // @ts-expect-error a public amount is not a private one
    expect(takesPrivate(p)).toBe('public');
    // @ts-expect-error a private amount is not a public one
    expect(takesPublic(a)).toBe('private');
    expect([takesPrivate(a), takesPublic(p)]).toEqual(['private', 'public']);
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
