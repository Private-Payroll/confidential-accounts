/**
 * A TOKEN AMOUNT, WRITTEN OUT EXACTLY IN THE PERSON'S LANGUAGE.
 *
 * An amount is an object, never a bare number: it carries the exact count of
 * the token's smallest unit as a `bigint`, how many decimals the token has, and
 * the token's code. A JavaScript number cannot hold every amount a token can
 * have, and one that loses a digit shows a person a balance they do not have.
 *
 * AND IT CARRIES WHETHER ANYONE CAN LOOK IT UP. A public amount and a private
 * one are two different types, made by two different functions,
 * `publicAmount` and `privateAmount`. Whoever makes one is whoever knows how
 * the money is held or paid, so a screen that shows it is never asked to say,
 * and cannot say it wrongly: `Amount` writes the Public pill for a public
 * amount without being told, and a place that takes only one of the two (a
 * balance's private side, its public side) refuses the other when the code is
 * typechecked.
 *
 * IT CANNOT BE SHOWN EXCEPT THROUGH `Amount` OR `Balance`. React refuses an object as a
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

/** Held by this file alone, so only `publicAmount` and `privateAmount` can make one. */
const MADE_HERE = Symbol();

/** Whether anyone can look an amount up. Read from how the money is held or paid, never from a setting. */
export type Visibility = 'private' | 'public';

/* Assigned in the classes' static blocks, the one place that can reach their private fields, so only this file can make an amount or read its units, decimals and visibility. */
let makePublic: (units: bigint, decimals: number, code: string) => PublicAmount;
let makePrivate: (units: bigint, decimals: number, code: string) => PrivateAmount;
let unitsOf: (amount: HeldAmount) => bigint;
let decimalsOf: (amount: HeldAmount) => number;
let isPublic: (amount: HeldAmount) => boolean;
let isPrivate: (amount: HeldAmount) => boolean;

/** What a public and a private amount share. Not exported: nothing outside this file can make, extend or read one. */
abstract class HeldAmount {
  readonly #units: bigint;
  readonly #decimals: number;
  readonly #code: string;

  static {
    unitsOf = (amount) => amount.#units;
    decimalsOf = (amount) => amount.#decimals;
  }

  protected constructor(made: symbol, units: bigint, decimals: number, code: string) {
    if (made !== MADE_HERE) throw new TypeError('a token amount is made by publicAmount or privateAmount, and by nothing else');
    this.#units = units;
    this.#decimals = decimals;
    this.#code = code;
  }

  /** The token's code, written the same in every language. */
  get code(): string {
    return this.#code;
  }

  [Symbol.toPrimitive](): never {
    throw new TypeError('a token amount is shown only by Amount or Balance, and is never turned into text or a number anywhere else');
  }

  toString(): never {
    throw new TypeError('a token amount is shown only by Amount or Balance, and is never turned into text or a number anywhere else');
  }

  toJSON(): never {
    throw new TypeError('a token amount is shown only by Amount or Balance, and is never turned into text or a number anywhere else');
  }
}

/** AN AMOUNT ANYONE CAN LOOK UP: money held or paid where the chain shows it. */
export class PublicAmount extends HeldAmount {
  /* The mark that makes this a type of its own: a private amount has no such field, so one is never taken for the other. */
  readonly #public = true;

  static {
    makePublic = (units, decimals, code) => new PublicAmount(MADE_HERE, units, decimals, code);
    isPublic = (amount) => #public in amount;
  }

  /** Not called directly: `publicAmount` makes one. */
  private constructor(made: symbol, units: bigint, decimals: number, code: string) {
    super(made, units, decimals, code);
    Object.freeze(this);
  }
}

/** AN AMOUNT ONLY ITS HOLDER, AND THOSE THEY SHARE IT WITH, CAN READ. */
export class PrivateAmount extends HeldAmount {
  /* The mark that makes this a type of its own: see `PublicAmount`. */
  readonly #private = true;

  static {
    makePrivate = (units, decimals, code) => new PrivateAmount(MADE_HERE, units, decimals, code);
    isPrivate = (amount) => #private in amount;
  }

  /** Not called directly: `privateAmount` makes one. */
  private constructor(made: symbol, units: bigint, decimals: number, code: string) {
    super(made, units, decimals, code);
    Object.freeze(this);
  }
}

/** Either kind of amount. A place that shows only one kind takes that kind's type instead. */
export type TokenAmount = PublicAmount | PrivateAmount;

/** What every maker checks: an exact count, whole decimals from 0 up, and a code. */
function checked(units: bigint, decimals: number, code: string): void {
  if (typeof units !== 'bigint') {
    throw new TypeError(`a token amount is a bigint of the token's smallest unit, and this is a ${typeof units}`);
  }
  if (units < 0n) throw new RangeError('a token amount is never below zero');
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError(`a token's decimals are a whole number from 0 up, and this is ${String(decimals)}`);
  }
  if (typeof code !== 'string' || code === '') throw new TypeError('a token amount carries its token\'s code');
}

/**
 * AN AMOUNT ANYONE CAN LOOK UP: the count of the token's smallest unit, and the
 * token's decimals and code from its own record. Made by whoever knows the
 * money is public, such as the reader of a vault's public holdings.
 */
export function publicAmount(units: bigint, decimals: number, code: string): PublicAmount {
  checked(units, decimals, code);
  return makePublic(units, decimals, code);
}

/** AN AMOUNT ONLY ITS HOLDER, AND THOSE THEY SHARE IT WITH, CAN READ, made the same way by whoever knows the money is private. */
export function privateAmount(units: bigint, decimals: number, code: string): PrivateAmount {
  checked(units, decimals, code);
  return makePrivate(units, decimals, code);
}

/** Whether anyone can look `amount` up, read from how it was made. Refuses anything not made here. */
export function visibilityOf(amount: TokenAmount): Visibility {
  if (!(amount instanceof HeldAmount)) {
    throw new TypeError(`a token amount is made by publicAmount or privateAmount, and this is a value of type ${typeof amount}`);
  }
  if (isPublic(amount)) return 'public';
  if (isPrivate(amount)) return 'private';
  throw new TypeError('a token amount is public or private, and this one is marked neither');
}

/** The decimal separator and the ten digits of a language, as its number format writes them. */
function partsOf(tag: string): { decimal: string; digits: readonly string[] } {
  const plain = new Intl.NumberFormat(tag, { useGrouping: false });
  const decimal = plain.formatToParts(1.5).find((p) => p.type === 'decimal')?.value;
  if (decimal === undefined) throw new Error(`the number format for "${tag}" writes no decimal separator`);
  const digits = Array.from({ length: 10 }, (_, d) => plain.format(d));
  return { decimal, digits };
}

/** The figure of an amount, without its code, in the language `tag` names. Used by the amount component (`Amount`, and the balance through `AmountFigure`), and by nothing a screen reaches. */
export function formatTokenAmount(amount: TokenAmount, tag: string): string {
  if (!(amount instanceof HeldAmount)) {
    throw new TypeError(`a token amount is made by publicAmount or privateAmount, and this is a value of type ${typeof amount}`);
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
