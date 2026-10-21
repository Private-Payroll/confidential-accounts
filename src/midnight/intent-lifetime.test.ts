import { describe, expect, it } from 'vitest';
import {
  A_STEP_IS_BUILT_AGAIN_BELOW_MS, A_STEP_MAY_BE_REPLACED_BELOW_MS, A_STEP_NEEDS_LEFT_MS, INTENT_LIFETIME_MS, aStepIsShortOfLife,
} from './intent-lifetime.js';

describe('HOW MUCH LIFE A BUILT TRANSACTION MUST STILL HAVE TO BE SENT', () => {
  const MIN = 60_000;
  /* RED WHEN: the lifetime a builder stamps, or any of the three lines drawn inside it, is changed without this being looked at again. */
  it('is built for thirty minutes, is sent with fifteen left, built again below seventeen, replaced from nineteen', () => {
    expect(INTENT_LIFETIME_MS).toBe(30 * MIN);
    expect(A_STEP_NEEDS_LEFT_MS).toBe(15 * MIN);
    expect(A_STEP_IS_BUILT_AGAIN_BELOW_MS).toBe(17 * MIN);
    expect(A_STEP_MAY_BE_REPLACED_BELOW_MS).toBe(19 * MIN);
  });

  it('is short of life from the minute fewer than seventeen are left, and not before', () => {
    const builtAt = 1_000_000_000;
    /* RED WHEN: a step with plenty of life left is built again at every press. */
    expect(aStepIsShortOfLife(builtAt, builtAt)).toBe(false);
    expect(aStepIsShortOfLife(builtAt, builtAt + 13 * MIN)).toBe(false);
    /* RED WHEN: a step with less than the device's line left is sent as it is. */
    expect(aStepIsShortOfLife(builtAt, builtAt + 13 * MIN + 1)).toBe(true);
    expect(aStepIsShortOfLife(builtAt, builtAt + 2 * 60 * MIN)).toBe(true);
  });

  it('counts a step whose build time is not known as short of life', () => {
    /* RED WHEN: a creation kept before the time was kept, or kept with a time that is not one, is sent as it is. */
    expect(aStepIsShortOfLife(undefined, 5)).toBe(true);
    expect(aStepIsShortOfLife(Number.NaN, 5)).toBe(true);
  });
});
