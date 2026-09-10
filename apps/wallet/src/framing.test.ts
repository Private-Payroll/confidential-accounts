// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DWELL_MS, MIN_FRAME_HEIGHT, MIN_FRAME_WIDTH, consentFor } from './framing.js';
import type { WhatCanBeSeen } from './framing.js';

/**
 * **THE VISIBILITY GUARD, ONE MEASURE AT A TIME.** Each case moves one input
 * across its line and nothing else, so each refusal is watched on its own.
 */

const EMBEDDER = 'https://app.payroll.example';

const seen = (over: Partial<WhatCanBeSeen> = {}): WhatCanBeSeen => ({
  framing: { of: 'framed', embedder: EMBEDDER },
  width: 460,
  height: 720,
  documentVisible: true,
  seenForMs: DWELL_MS,
  ...over,
});

describe('consentFor', () => {
  it('a wallet in a window of its own is never held, whatever the measures say', () => {
    expect(consentFor(seen({ framing: { of: 'top' }, width: 1, height: 1, documentVisible: false, seenForMs: 0 })))
      .toEqual({ ok: true });
  });

  it('a framed wallet that meets every measure may be pressed', () => {
    expect(consentFor(seen())).toEqual({ ok: true });
  });

  it('REFUSES inside a page it does not know, with that page\'s refusal', () => {
    expect(consentFor(seen({ framing: { of: 'refused', why: 'not yours' } }))).toEqual({ ok: false, says: 'not yours' });
  });

  it('REFUSES off screen', () => {
    expect(consentFor(seen({ documentVisible: false })).ok).toBe(false);
  });

  it('REFUSES one pixel under either minimum, and allows exactly the minimum', () => {
    expect(consentFor(seen({ width: MIN_FRAME_WIDTH - 1 })).ok).toBe(false);
    expect(consentFor(seen({ height: MIN_FRAME_HEIGHT - 1 })).ok).toBe(false);
    expect(consentFor(seen({ width: MIN_FRAME_WIDTH, height: MIN_FRAME_HEIGHT })).ok).toBe(true);
  });

  it('REFUSES one millisecond short of the dwell, and allows it exactly', () => {
    expect(consentFor(seen({ seenForMs: DWELL_MS - 1 })).ok).toBe(false);
    expect(consentFor(seen({ seenForMs: DWELL_MS })).ok).toBe(true);
  });
});
