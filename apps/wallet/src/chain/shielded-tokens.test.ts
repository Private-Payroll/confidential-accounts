import { describe, expect, it } from 'vitest';
import {
  holdsAnyOther, otherTokenLines, otherTokensFromStored, otherTokensToStored, shortColour,
  smallestUnits, splitShielded,
} from './shielded-tokens.js';

/* Colours invented for the test: hex of the length the chain uses, named by
 * nothing. The wallet has no registry, so no real colour is needed here. */
const NIGHT = '00'.repeat(32);
const TOKEN_A = 'ab'.repeat(32);
const TOKEN_B = 'cd'.repeat(32);

describe('the whole private balance map, not one key of it', () => {
  it('keeps NIGHT as NIGHT and carries every other held token beside it', () => {
    const split = splitShielded({ [NIGHT]: 1_234_567n, [TOKEN_A]: 5_000n, [TOKEN_B]: 7n }, NIGHT);
    /* RED WHEN NIGHT is read from any key but its own, or rounded. */
    expect(split.night).toBe(1_234_567n);
    /* RED WHEN another token is dropped, or NIGHT is listed as "another". */
    expect(split.others).toEqual({ [TOKEN_A]: 5_000n, [TOKEN_B]: 7n });
  });

  it('a wallet holding only another token: NIGHT is zero, the token is kept', () => {
    const split = splitShielded({ [TOKEN_A]: 5_000n }, NIGHT);
    /* RED WHEN a missing NIGHT key becomes anything but zero. */
    expect(split.night).toBe(0n);
    /* RED WHEN the only token held is dropped. */
    expect(split.others).toEqual({ [TOKEN_A]: 5_000n });
  });

  it('a token held at zero is not carried, so it can never be a zero line', () => {
    const split = splitShielded({ [NIGHT]: 0n, [TOKEN_A]: 0n, [TOKEN_B]: 3n }, NIGHT);
    /* RED WHEN the filter keeps a zero amount. */
    expect(Object.keys(split.others)).toEqual([TOKEN_B]);
    /* RED WHEN the display list lets a zero through a map handed to it. */
    expect(otherTokenLines({ [TOKEN_A]: 0n, [TOKEN_B]: 3n })).toEqual([[TOKEN_B, 3n]]);
  });

  it('lists the tokens in one fixed order, by colour', () => {
    /* RED WHEN the order follows insertion, so two screens could disagree. */
    expect(otherTokenLines({ [TOKEN_B]: 1n, [TOKEN_A]: 2n }).map(([c]) => c))
      .toEqual([TOKEN_A, TOKEN_B]);
  });

  it('absent is not none: an unrecorded map holds nothing we know of, and is not a zero', () => {
    /* RED WHEN an absent map is taken to hold money. */
    expect(holdsAnyOther(undefined)).toBe(false);
    /* RED WHEN a held token is not seen, or a zero is. */
    expect(holdsAnyOther({ [TOKEN_A]: 1n })).toBe(true);
    expect(holdsAnyOther({ [TOKEN_A]: 0n })).toBe(false);
  });

  it('names a token by its colour, short, and shows the amount undivided', () => {
    /* RED WHEN the short form loses either end, or invents a scale. */
    expect(shortColour(TOKEN_A)).toBe('ababab…abab');
    expect(shortColour('abc')).toBe('abc');
    /* Read as digits, so the check holds in every locale's grouping. */
    expect(smallestUnits(5_000_000n).replace(/\D/gu, '')).toBe('5000000');
  });
});

describe('the other tokens in a saved checkpoint', () => {
  it('round-trip, amounts exact beyond what a JavaScript number holds', () => {
    const others = { [TOKEN_A]: 18_446_744_073_709_551_615n, [TOKEN_B]: 1n };
    const stored = otherTokensToStored(others);
    /* RED WHEN an amount is written as a number rather than exact text. */
    expect(stored[TOKEN_A]).toBe('18446744073709551615');
    /* RED WHEN reading back loses a token or a digit. */
    expect(otherTokensFromStored(JSON.parse(JSON.stringify(stored)))).toEqual(others);
  });

  it('an older checkpoint with no map reads as NOT RECORDED, never as an empty map', () => {
    /* RED WHEN absence is turned into {} — "holds no other token". */
    expect(otherTokensFromStored(undefined)).toBeUndefined();
    /* And an empty map that WAS recorded stays a recorded empty map. */
    expect(otherTokensFromStored({})).toEqual({});
  });

  it('a damaged map is refused rather than half-read', () => {
    /* RED WHEN any of these is accepted as a map of amounts. */
    for (const bad of [null, [], 'x', { [TOKEN_A]: 5 }, { [TOKEN_A]: '5.5' }, { 'not-hex': '1' }]) {
      expect(() => otherTokensFromStored(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
