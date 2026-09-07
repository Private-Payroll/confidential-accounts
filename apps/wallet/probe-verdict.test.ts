import { describe, expect, it } from 'vitest';
import {
  LAG_BOUND_MIN_RUNS, boundSentence, exitCodeFor, unfinishedSentence, verdictFor, worstLag,
} from './scripts/probe-verdict.mjs';

/*
 * THE DRIVER'S OWN RULES, PINNED.
 *
 * The probe driver had never had a test, and what that cost was a
 * run that closed its own tab on purpose, reported `VERDICT: FAILED`, and
 * told its reader it had waited 2,700,000ms when the two report timestamps
 * on disk say 189 seconds. Nothing in the suite could see any of it.
 *
 * These are pure functions the driver now reports by, so the rules are
 * checkable without a browser, a network or a real payment.
 */

describe('a run that ended where it meant to is not a failure', () => {
  it('THE PIN: a killed run is ABANDONED-BY-DESIGN, never FAILED', () => {
    /* `done` is false by construction — the page it was reading is gone. */
    expect(verdictFor({ killed: true, done: false, pageVerdict: null }))
      .toBe('ABANDONED-BY-DESIGN');
    expect(verdictFor({ killed: true, done: false, pageVerdict: null }))
      .not.toBe('FAILED');
  });

  it('an ordinary unfinished run is still FAILED — the word keeps its meaning', () => {
    expect(verdictFor({ killed: false, done: false, pageVerdict: null })).toBe('FAILED');
    expect(verdictFor({ killed: false, done: false, pageVerdict: 'FULL' })).toBe('FAILED');
  });

  it('a finished run reports the page\'s own verdict, unchanged', () => {
    expect(verdictFor({ killed: false, done: true, pageVerdict: 'FULL' })).toBe('FULL');
    expect(verdictFor({ killed: false, done: true, pageVerdict: 'ACT-FAILED' })).toBe('ACT-FAILED');
  });

  it('THE PIN: an abandoned-by-design run exits 0 — it succeeded', () => {
    expect(exitCodeFor('ABANDONED-BY-DESIGN')).toBe(0);
    expect(exitCodeFor('FULL')).toBe(0);
    expect(exitCodeFor('FAILED')).toBe(1);
    expect(exitCodeFor('ACT-FAILED')).toBe(2);
  });

  it('a viewing key on the wire fails the run whatever the verdict says', () => {
    expect(exitCodeFor('FULL', true)).toBe(1);
    expect(exitCodeFor('ABANDONED-BY-DESIGN', true)).toBe(1);
  });
});

describe('the report may only claim a timeout that happened', () => {
  it('THE PIN: a killed run says nothing about not finishing', () => {
    expect(unfinishedSentence({
      killed: true, done: false, waitedMs: 189_000, leashMs: 2_700_000,
    })).toBeNull();
  });

  it('THE PIN: stopping early is NOT reported as the leash running out', () => {
    const said = unfinishedSentence({
      killed: false, done: false, waitedMs: 189_000, leashMs: 2_700_000, progress: 'proving',
    });
    expect(said).toContain('189000ms');
    expect(said).toContain('NOT a timeout');
    /* The exact shape of the old lie: the leash quoted as if it had elapsed. */
    expect(said).not.toMatch(/did not finish within 2700000ms(?!.*NOT a timeout)/u);
  });

  it('a real timeout says so, and carries both numbers', () => {
    const said = unfinishedSentence({
      killed: false, done: false, waitedMs: 2_700_004, leashMs: 2_700_000, progress: 'syncing',
    });
    expect(said).toContain('did not finish within 2700000ms');
    expect(said).toContain('waited 2700004ms');
  });

  it('a finished run says nothing', () => {
    expect(unfinishedSentence({ killed: false, done: true, waitedMs: 10, leashMs: 20 })).toBeNull();
  });
});

describe('a run that never found it is not a bound', () => {
  it('THE PIN: one never-found run means there is NO bound, however many found', () => {
    const seen = worstLag([
      { foundAfterMs: 1_200 }, { foundAfterMs: 3_400 }, { foundAfterMs: null },
    ]);
    expect(seen.isBound).toBe(false);
    expect(seen.neverFound).toBe(1);
    /* And the worst FOUND is still reported — it is a real number, it is
     * just not the answer to "how long can this take". */
    expect(seen.worstFoundMs).toBe(3_400);
  });

  it('a never-found run is not folded in as zero or as its own patience', () => {
    const withMiss = worstLag([{ foundAfterMs: 1_000 }, { foundAfterMs: null }]);
    const withoutMiss = worstLag([{ foundAfterMs: 1_000 }]);
    expect(withMiss.worstFoundMs).toBe(withoutMiss.worstFoundMs);
    expect(withMiss.found).toBe(1);
    expect(withMiss.runs).toBe(2);
  });

  it('CORRECTED: every run finding it is NOT enough on its own', () => {
    /* This test used to assert that two clean runs were a bound, and that
     * assertion was the defect named above — it encoded "did any run fail?"
     * as if it answered "is this enough runs to say?". Two clean runs give a
     * worst OBSERVED figure and nothing more. Corrected rather than deleted,
     * because the wrong version is the record of how the flag came to be
     * wrong. */
    const seen = worstLag([{ foundAfterMs: 900 }, { foundAfterMs: 2_100 }]);
    expect(seen.allFound).toBe(true);
    expect(seen.worstFoundMs).toBe(2_100);
    expect(seen.isBound).toBe(false);
  });

  it('no runs at all is not a bound either', () => {
    expect(worstLag([]).isBound).toBe(false);
    expect(worstLag([]).worstFoundMs).toBeNull();
  });
});

/*
 * A "YES" THAT CANNOT NAME ITS SAMPLE SIZE.
 *
 * The flag built to stop a number looking measured printed
 * `IS THIS A BOUND? yes — every recorded run found it` directly beneath
 * `runs recorded: 1`. It asked "did any run fail to find it?" and answered
 * "is this enough runs to bound a worst case?" — a data point wearing a
 * conclusion, and the sixth summary line in this project to claim more than
 * the evidence printed above it.
 *
 * The sentence is what a person reads, so the sentence is what is pinned.
 */
const clean = (n: number, ms = 1_000) =>
  Array.from({ length: n }, (_, i) => ({ foundAfterMs: ms + i }));

describe('too few runs is not a bound either', () => {
  it('THE PIN: one clean run is NOT a bound, however clean it is', () => {
    const seen = worstLag([{ foundAfterMs: 1_345 }]);
    expect(seen.allFound).toBe(true);
    expect(seen.isBound).toBe(false);
    expect(seen.worstFoundMs).toBe(1_345);
  });

  it('THE PIN: the sentence a person reads says WHY it is not a bound', () => {
    const said = boundSentence(worstLag([{ foundAfterMs: 1_345 }]));
    expect(said).toMatch(/^NO/u);
    expect(said).toContain('only 1 run');
    expect(said).toContain(String(LAG_BOUND_MIN_RUNS));
    /* The exact shape of the defect: a bare yes with nothing behind it. */
    expect(said).not.toMatch(/^yes/u);
  });

  it('THE PIN: a yes NAMES how many runs it came from', () => {
    const said = boundSentence(worstLag(clean(LAG_BOUND_MIN_RUNS)));
    expect(said).toMatch(/^yes/u);
    expect(said).toContain(`${LAG_BOUND_MIN_RUNS} of ${LAG_BOUND_MIN_RUNS} runs`);
    expect(said).toContain('worst');
  });

  it('one short of the minimum is still NO', () => {
    const seen = worstLag(clean(LAG_BOUND_MIN_RUNS - 1));
    expect(seen.enoughRuns).toBe(false);
    expect(seen.isBound).toBe(false);
    expect(boundSentence(seen)).toMatch(/^NO/u);
  });

  it('the earlier condition still holds: enough runs but one never found is NO', () => {
    const history = [...clean(LAG_BOUND_MIN_RUNS), { foundAfterMs: null }];
    const seen = worstLag(history);
    expect(seen.enoughRuns).toBe(true);
    expect(seen.allFound).toBe(false);
    expect(seen.isBound).toBe(false);
    const said = boundSentence(seen);
    expect(said).toMatch(/^NO/u);
    expect(said).toContain('never found it');
  });

  it('no runs at all is NO, and says so as a shortfall rather than a silence', () => {
    const seen = worstLag([]);
    expect(seen.isBound).toBe(false);
    expect(seen.worstFoundMs).toBeNull();
    expect(boundSentence(seen)).toMatch(/^NO/u);
  });

  it('the minimum is a stated number, not a magic one', () => {
    /* Overridable so the threshold is a decision rather than a constant
     * nobody can see — and pinned so raising it is a deliberate act. */
    expect(LAG_BOUND_MIN_RUNS).toBe(10);
    expect(worstLag(clean(3), 3).isBound).toBe(true);
    expect(worstLag(clean(3), 4).isBound).toBe(false);
  });
});
