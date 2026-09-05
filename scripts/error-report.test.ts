/**
 * THE FAILURE REPORT'S CAPS, PROVED AGAINST THE SHAPE THAT ACTUALLY EXPLODED.
 *
 * `R1b` forced `deploy-preview`'s failure path and this defect survived it,
 * because the forced failure was `throw 'a string'` — no `cause`, no nesting,
 * nothing to recurse into. The report then grew to 3.04 GB on the first real
 * SDK failure. **A guard proved against the easy shape is not proved.**
 *
 * So the fixture here is the shape from the 28 Aug run: an Effect
 * `FiberFailure` wrapping a `SubmissionError`, whose `cause` chain comes back
 * to an error already in it, carrying the node's rejection line at every level.
 * Run it against the OLD implementation — `JSON.stringify` with a `WeakSet`
 * that only ever saw plain objects — and it does not return.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  collapseRepeatedLines,
  describeDropped,
  serialiseWhole,
  serialiseWholeDetailed,
} from './error-report';

const NODE_LINE =
  '2026-08-28 03:03:44        RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ' +
  'ExtrinsicStatus:: 1010: Invalid Transaction: Transaction would exhaust the block limits';

/**
 * The 28 Aug shape. `FiberFailure` -> `SubmissionError` -> ... -> back to the
 * `SubmissionError` already in the chain. Self-referential, not merely deep:
 * a depth cap alone would bound it, and a cycle guard alone would bound it,
 * and the old code had a cycle guard that could not see Errors at all.
 */
function sdkShapedFailure(): Error {
  const submission = new Error('SubmissionError: Transaction submission error');
  submission.name = 'SubmissionError';
  (submission as any).nodeLine = NODE_LINE;

  let head: Error = submission;
  for (let i = 0; i < 40; i += 1) {
    const wrapper = new Error('SubmissionError: Transaction submission error');
    wrapper.name = 'FiberFailure';
    (wrapper as any).nodeLine = NODE_LINE;
    (wrapper as any).cause = head;
    head = wrapper;
  }
  // The knot: the deepest error points back at the top. This is what made the
  // old guard useless — every level produced a NEW plain object, so the
  // WeakSet never recognised a repeat.
  (submission as any).cause = head;
  return head;
}

describe('serialiseWhole, against the shape that produced 3.04 GB', () => {
  it('terminates and stays inside the byte cap', () => {
    const { text, dropped } = serialiseWholeDetailed(sdkShapedFailure());
    expect(text.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxBytes + 200);
    // Something was necessarily dropped from a 41-deep self-referential chain.
    expect(dropped.depth + dropped.circular + dropped.repeats).toBeGreaterThan(0);
  });

  it('says what it dropped, in the output itself', () => {
    const whole = serialiseWhole(sdkShapedFailure());
    expect(whole).toMatch(/What was dropped:/);
    // The count is the point: a reader must not have to wonder whether the
    // evidence was complete.
    expect(whole).toMatch(/repeat\(s\) of an error already printed|deeper than the depth cap/);
  });

  it('prints the repeated error once and carries its count', () => {
    const { dropped } = serialiseWholeDetailed(sdkShapedFailure());
    const collapsed = dropped.messages.find((m) => m.message.includes('Transaction submission error'));
    expect(collapsed).toBeDefined();
    expect(collapsed!.occurrences).toBeGreaterThan(1);
    expect(describeDropped(dropped).join('\n')).toMatch(/occurred \d+ times and is printed once/);
  });

  it("keeps the node's own rejection line", () => {
    // Bounding the report must not cost the evidence the run exists to produce.
    expect(serialiseWhole(sdkShapedFailure())).toContain('Transaction would exhaust the block limits');
  });

  it('does not follow a cause chain past the depth cap', () => {
    const { text } = serialiseWholeDetailed(sdkShapedFailure(), { ...DEFAULT_LIMITS, maxDepth: 3 });
    expect(text).toMatch(/depth cap: 3 levels reached|already printed above/);
  });
});

describe('serialiseWhole, on the ordinary shapes', () => {
  it('reports a complete object as complete', () => {
    const out = serialiseWhole(new Error('plain'));
    expect(out).toContain('Nothing was dropped');
  });

  it('survives a bare string throw — the shape R1b forced', () => {
    expect(serialiseWhole('just a string')).toContain('just a string');
  });

  it('renders bigints rather than throwing on them', () => {
    expect(serialiseWhole({ fee: 361713260935196n })).toContain('361713260935196n');
  });

  it('caps a very long string and says by how much', () => {
    const { text, dropped } = serialiseWholeDetailed({ blob: 'x'.repeat(50_000) });
    expect(dropped.stringChars).toBe(50_000 - DEFAULT_LIMITS.maxString);
    expect(text).toContain('more characters');
  });

  it('caps a very wide array and says by how much', () => {
    const { dropped } = serialiseWholeDetailed({ xs: Array.from({ length: 500 }, (_, i) => i) });
    expect(dropped.arrayEntries).toBe(500 - DEFAULT_LIMITS.maxArray);
  });
});

describe("collapseRepeatedLines, on the node's own output", () => {
  it('keeps one copy of an identical line and states the count', () => {
    const out = collapseRepeatedLines(Array.from({ length: 17 }, () => NODE_LINE));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('emitted 17 times');
    // UNABRIDGED: the line itself is not shortened, only its copies removed.
    expect(out[0]).toContain('Transaction would exhaust the block limits');
  });

  it('keeps every distinct line', () => {
    const out = collapseRepeatedLines([NODE_LINE, 'Custom error: 170', NODE_LINE]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('Custom error: 170');
  });
});
