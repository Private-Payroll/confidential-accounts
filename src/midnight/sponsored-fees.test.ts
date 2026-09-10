/**
 * **THE RECORD OF WHAT WAS PAID AND FOR WHOM, AND THE TWO WAYS IT COULD BE
 * WORSE THAN NOT KEEPING ONE.**
 *
 * A record that cannot be written is a record that is lost. A record that
 * writes a number nobody measured is a record that is WRONG, and a wrong one is
 * worse, because nothing afterwards can tell it from a right one.
 */
import { describe, it, expect } from 'vitest';
import {
  feeOverrun, fileFeeSink, inMemoryFeeSink, sponsoredFeeLine, type SponsoredFee,
} from './sponsored-fees.js';

const entry = (over: Partial<SponsoredFee> = {}): SponsoredFee => ({
  at: '2026-09-10T00:00:00.000Z',
  company: 'acc_one',
  estimated: 1_000n,
  actual: 1_200n,
  ref: 'tx_1',
  ...over,
});

describe('what a sponsored fee is written down as', () => {
  it('writes both fees as decimal strings, not as JSON numbers', () => {
    /*
     * **A FEE IN SPECKS IS PAST WHAT A JSON NUMBER HOLDS EXACTLY**, so writing
     * one as a number is writing a different number - silently, and only for
     * the large ones, which are the ones anybody would care about.
     *
     * RED WHEN: either `.toString()` is removed. `JSON.stringify` throws on a
     * `bigint` rather than writing anything, so the line is not merely wrong,
     * there is no line at all.
     */
    const parsed = JSON.parse(sponsoredFeeLine(entry({
      estimated: 9_007_199_254_740_993n, actual: 9_007_199_254_740_995n,
    })));
    expect(parsed.estimated).toBe('9007199254740993');
    expect(parsed.actual).toBe('9007199254740995');
  });

  it('writes a reading nobody took as null and never as zero', () => {
    /*
     * **ZERO IS A FEE. NULL IS THE ABSENCE OF A READING.** A record full of
     * zeros says every transaction was free, which is a claim, and it is false.
     *
     * RED WHEN: either `=== null ? null :` guard becomes `?? 0` or the field is
     * coerced with `Number(...)`.
     */
    const parsed = JSON.parse(sponsoredFeeLine(entry({ estimated: null, actual: null })));
    expect(parsed.estimated).toBeNull();
    expect(parsed.actual).toBeNull();
  });

  it('keeps the company on the line, because it is the part that cannot be recovered', () => {
    // RED WHEN: `company` is dropped from the written object. Everything else
    // on the line can be found again from the chain; this cannot be found
    // anywhere, by anybody, ever.
    expect(JSON.parse(sponsoredFeeLine(entry())).company).toBe('acc_one');
    expect(JSON.parse(sponsoredFeeLine(entry({ company: null }))).company).toBeNull();
  });
});

describe('the difference between what was expected and what was charged', () => {
  it('is the overrun when both ends were read', () => {
    // RED WHEN: the subtraction is reversed, which turns every overspend into
    // an underspend and vice versa.
    expect(feeOverrun(entry())).toBe(200n);
    expect(feeOverrun(entry({ estimated: 1_500n, actual: 1_200n }))).toBe(-300n);
  });

  it('is nothing at all when either end was not read', () => {
    /*
     * **AN ABSENT READING MUST NOT BECOME A DIFFERENCE OF NOTHING.** Treated as
     * zero, an unread estimate makes every transaction look like a 100%
     * overrun, and an unread actual makes every one look like a full refund.
     *
     * RED WHEN: the guard uses `!entry.estimated`, which is also true of a
     * genuine zero, or the fields are defaulted with `?? 0n`.
     */
    expect(feeOverrun(entry({ estimated: null }))).toBeNull();
    expect(feeOverrun(entry({ actual: null }))).toBeNull();
  });

  it('and a genuine zero is a reading, not an absence', () => {
    // RED WHEN: the null guards are written as falsiness checks. `0n` is falsy.
    expect(feeOverrun(entry({ estimated: 0n, actual: 0n }))).toBe(0n);
  });
});

describe('a sink cannot fail a payment', () => {
  it('swallows a write that throws, because the money has already moved', () => {
    /*
     * **THIS RUNS AFTER THE SUBMISSION.** A full disk turning a transaction
     * that settled into an error a caller reports as a failure is how somebody
     * raises the same round again.
     *
     * RED WHEN: the `try` around `append` is removed.
     */
    const sink = fileFeeSink('/nowhere/at/all.jsonl', () => {
      throw new Error('read-only file system');
    });
    expect(() => sink.record(entry())).not.toThrow();
  });

  it('appends one line per transaction, ending in a newline', () => {
    // RED WHEN: the `+ '\n'` is dropped, which runs every record into the next
    // one and makes the file unreadable a line at a time.
    const written: string[] = [];
    const sink = fileFeeSink('/somewhere.jsonl', (_p, l) => { written.push(l); });
    sink.record(entry());
    sink.record(entry({ ref: 'tx_2' }));
    expect(written).toHaveLength(2);
    expect(written.every(l => l.endsWith('\n'))).toBe(true);
    expect(written.join('').trimEnd().split('\n')).toHaveLength(2);
  });

  it('writes to the path it was given', () => {
    // RED WHEN: `path` is not passed through, so every deployment's records
    // land in one place or in none.
    const seen: string[] = [];
    fileFeeSink('/the/expected/path.jsonl', (p) => { seen.push(p); }).record(entry());
    expect(seen).toEqual(['/the/expected/path.jsonl']);
  });

  it('the in-memory one keeps what it was given, in order', () => {
    const sink = inMemoryFeeSink();
    sink.record(entry({ ref: 'a' }));
    sink.record(entry({ ref: 'b' }));
    expect(sink.entries.map(e => e.ref)).toEqual(['a', 'b']);
  });
});
