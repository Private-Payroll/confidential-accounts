/**
 * A TOKEN AMOUNT, WRITTEN OUT EXACTLY IN THE PERSON'S LANGUAGE.
 *
 * An amount is an object, never a bare number: it carries the exact count of
 * the token's smallest unit as a `bigint`, how many decimals the token has, and
 * the token's code, and it is made only by `tokenAmount`. A JavaScript number
 * cannot hold every amount a token can have, and one that loses a digit shows a
 * person a balance they do not have.
 *
 * IT CANNOT BE SHOWN EXCEPT THROUGH `Amount`. React refuses an object as a
 * child, so `<span>{amount}</span>` stops the page instead of writing digits
 * with no decimals and no Public pill. Turning one into text or a number any
 * other way (`String(amount)`, a template, `+amount`, `Number(amount)`,
 * `JSON.stringify`, a number formatter) throws, and the count of units is not a
 * property anything outside this file can read. Its code is readable, because
 * a code is not an amount.
 *
 * The whole part is formatted as a `bigint` by `Intl.NumberFormat`, so it is
 * exact and grouped the way the language groups (`1,23,45,678` in `en-IN`,
 * `1234` in `es`). The decimal separator is the language's own, and every
 * fractional digit is written, trailing zeros included, in the language's
 * digits: nothing is rounded and nothing is dropped.
 *
 * How many decimals a token has, and its code, are the caller's to say, from
 * the token's own record; nothing here knows any token.
 */

/** Held by this file alone, so only `tokenAmount` can make one. */
const MADE_HERE = Symbol();

/* Assigned in the class's static block, the one place that can reach its private fields, so only this file can make an amount or read its units and decimals. */
let make: (units: bigint, decimals: number, code: string) => TokenAmount;
let unitsOf: (amount: TokenAmount) => bigint;
let decimalsOf: (amount: TokenAmount) => number;

export class TokenAmount {
  readonly #units: bigint;
  readonly #decimals: number;
  readonly #code: string;

  static {
    make = (units, decimals, code) => new TokenAmount(MADE_HERE, units, decimals, code);
    unitsOf = (amount) => amount.#units;
    decimalsOf = (amount) => amount.#decimals;
  }

  /** Not called directly: `tokenAmount` makes one. */
  private constructor(made: symbol, units: bigint, decimals: number, code: string) {
    if (made !== MADE_HERE) throw new TypeError('a token amount is made by tokenAmount, and by nothing else');
    this.#units = units;
    this.#decimals = decimals;
    this.#code = code;
    Object.freeze(this);
  }

  /** The token's code, written the same in every language. */
  get code(): string {
    return this.#code;
  }

  [Symbol.toPrimitive](): never {
    throw new TypeError('a token amount is shown only by Amount, and is never turned into text or a number anywhere else');
  }

  toString(): never {
    throw new TypeError('a token amount is shown only by Amount, and is never turned into text or a number anywhere else');
  }

  toJSON(): never {
    throw new TypeError('a token amount is shown only by Amount, and is never turned into text or a number anywhere else');
  }
}

/**
 * THE ONE WAY A TOKEN AMOUNT IS MADE: the count of the token's smallest unit,
 * and the token's decimals and code from its own record.
 */
export function tokenAmount(units: bigint, decimals: number, code: string): TokenAmount {
  if (typeof units !== 'bigint') {
    throw new TypeError(`a token amount is a bigint of the token's smallest unit, and this is a ${typeof units}`);
  }
  if (units < 0n) throw new RangeError('a token amount is never below zero');
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError(`a token's decimals are a whole number from 0 up, and this is ${String(decimals)}`);
  }
  if (typeof code !== 'string' || code === '') throw new TypeError('a token amount carries its token\'s code');
  return make(units, decimals, code);
}

/** The decimal separator and the ten digits of a language, as its number format writes them. */
function partsOf(tag: string): { decimal: string; digits: readonly string[] } {
  const plain = new Intl.NumberFormat(tag, { useGrouping: false });
  const decimal = plain.formatToParts(1.5).find((p) => p.type === 'decimal')?.value;
  if (decimal === undefined) throw new Error(`the number format for "${tag}" writes no decimal separator`);
  const digits = Array.from({ length: 10 }, (_, d) => plain.format(d));
  return { decimal, digits };
}

/** The figure of an amount, without its code, in the language `tag` names. Used by `Amount`, and by nothing a screen reaches. */
export function formatTokenAmount(amount: TokenAmount, tag: string): string {
  if (!(amount instanceof TokenAmount)) {
    throw new TypeError(`a token amount is made by tokenAmount, and this is a value of type ${typeof amount}`);
  }
  const units = unitsOf(amount);
  const decimals = decimalsOf(amount);
  const unit = 10n ** BigInt(decimals);
  const whole = new Intl.NumberFormat(tag).format(units / unit);
  if (decimals === 0) return whole;
  const { decimal, digits } = partsOf(tag);
  const fraction = (units % unit).toString().padStart(decimals, '0');
  return whole + decimal + [...fraction].map((d) => digits[Number(d)]).join('');
}
