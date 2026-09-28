/**
 * A TOKEN AMOUNT, WRITTEN OUT EXACTLY IN THE PERSON'S LANGUAGE.
 *
 * An amount is a `bigint` of the token's smallest unit, never a JavaScript
 * number: a number cannot hold every amount a token can have, and one that
 * loses a digit shows a person a balance they do not have. The type refuses a
 * number, and so does the function, for a caller that got past the type.
 *
 * The whole part is formatted as a `bigint` by `Intl.NumberFormat`, so it is
 * exact and grouped the way the language groups (`1,23,45,678` in `en-IN`,
 * `1234` in `es`). The decimal separator is the language's own, and every
 * fractional digit is written, trailing zeros included, in the language's
 * digits: nothing is rounded and nothing is dropped.
 *
 * How many decimals a token has is the caller's to say, from the token's own
 * record; nothing here knows any token.
 */
export type TokenAmount = bigint;

/** The decimal separator and the ten digits of a language, as its number format writes them. */
function partsOf(tag: string): { decimal: string; digits: readonly string[] } {
  const plain = new Intl.NumberFormat(tag, { useGrouping: false });
  const decimal = plain.formatToParts(1.5).find((p) => p.type === 'decimal')?.value;
  if (decimal === undefined) throw new Error(`the number format for "${tag}" writes no decimal separator`);
  const digits = Array.from({ length: 10 }, (_, d) => plain.format(d));
  return { decimal, digits };
}

export function formatTokenAmount(amount: TokenAmount, decimals: number, tag: string): string {
  if (typeof amount !== 'bigint') {
    throw new TypeError(`a token amount is a bigint of the token's smallest unit, and this is a ${typeof amount}`);
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError(`a token's decimals are a whole number from 0 up, and this is ${String(decimals)}`);
  }
  if (amount < 0n) throw new RangeError('a token amount is never below zero');
  const unit = 10n ** BigInt(decimals);
  const whole = new Intl.NumberFormat(tag).format(amount / unit);
  if (decimals === 0) return whole;
  const { decimal, digits } = partsOf(tag);
  const fraction = (amount % unit).toString().padStart(decimals, '0');
  return whole + decimal + [...fraction].map((d) => digits[Number(d)]).join('');
}
