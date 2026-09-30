/**
 * A RUN'S SUM TREE REFUSES WHAT THE CONTRACT WOULD REFUSE, BEFORE ANYBODY
 * APPROVES IT.
 *
 * The contract casts every sum on a payee's path to 128 bits, so an amount or a
 * total past that cannot be paid. The builder refuses both while the run is
 * still being raised, and a negative amount, which no payment can be.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';

import { rootOfLeaves } from './payout-tree.js';

const leaf = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const GBP = '474250'.padEnd(64, '0');
const MAX = (1n << 128n) - 1n;

describe('the amounts a run can carry', () => {
  it('refuses a negative amount, naming the payee', () => {
    /* RED WHEN the lower bound goes: a negative amount then reaches the tree. */
    expect(() => rootOfLeaves([leaf(1), leaf(2)], [5n, -1n], GBP))
      .toThrow(/payee 2's amount is below zero, and a payment is never negative/);
  });

  it('refuses one amount past 128 bits, and accepts the largest that fits', () => {
    /* RED WHEN the upper bound goes, or moves by one. */
    expect(() => rootOfLeaves([leaf(1)], [MAX + 1n], GBP))
      .toThrow(/payee 1's amount is larger than any payment can be; check the amount and its units/);
    expect(rootOfLeaves([leaf(1)], [MAX], GBP)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a total past 128 bits, though each amount fits', () => {
    /* RED WHEN the sum check at each level goes. */
    expect(() => rootOfLeaves([leaf(1), leaf(2)], [MAX, 1n], GBP))
      .toThrow(/this run's total is larger than any run can carry; check the amounts and their units/);
  });
});
