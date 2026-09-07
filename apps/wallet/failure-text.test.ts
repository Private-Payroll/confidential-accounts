import { describe, expect, it } from 'vitest';
import { Data } from 'effect';
import { WellFormedError } from '@midnightntwrk/wallet-sdk-capabilities/validation';
import { describeFailure } from './failure-text.js';

/*
 * THE REASON A FAILURE HAPPENED MUST SURVIVE TO THE SCREEN.
 *
 * The first real send was refused by the SDK's pre-submit check and the
 * report said `the act stopped at "pre-flight validation": .` — the reason
 * was an empty string, because the error was built with a `cause` and no
 * `message` and every surface in this wallet read `.message`.
 *
 * What these tests hold: a message-less tagged error still renders
 * something a person can act on; the cause chain is walked rather than
 * dropped; and NOTHING — no shape, no depth, no cycle — comes back blank or
 * as `[object Object]`. Without this pin the defect comes back, because the
 * shape that caused it is thrown by the one SDK method whose documented job
 * is to explain a failure.
 */

/** The exact shape `validationService.js:47` throws. */
class TaggedWithCauseOnly extends Data.TaggedError('a/tagged/error')<{ cause: unknown }> {}

describe('describeFailure', () => {
  it('THE PIN: a message-less tagged error still says something a person can act on', () => {
    const error = new TaggedWithCauseOnly({ cause: new Error('the ledger says the fee is short') });

    /* The precondition the defect lived on: this really is a blank to a
     * `.message` reader. If the SDK ever starts setting a message, this
     * assertion is where that is discovered rather than assumed. */
    expect(error.message).toBe('');

    const text = describeFailure(error);
    expect(text).toContain('a/tagged/error');
    expect(text).toContain('the ledger says the fee is short');
    expect(text).not.toBe('');
  });

  it('THE PIN, against the SDK\'s own class rather than a local imitation', () => {
    const error = new WellFormedError({ cause: new Error('transaction is not well formed') });

    expect(error.message).toBe('');

    const text = describeFailure(error);
    expect(text).toContain('WellFormedError');
    expect(text).toContain('transaction is not well formed');
  });

  it('an ordinary error still reads exactly as it did before', () => {
    expect(describeFailure(new Error('the indexer did not answer'))).toBe('the indexer did not answer');
  });

  it('a message AND a cause keep both, in that order', () => {
    const text = describeFailure(new Error('could not submit', { cause: new Error('connection reset') }));
    expect(text).toBe('could not submit <- caused by: connection reset');
  });

  it('walks a chain more than one deep', () => {
    const inner = new Error('the node refused the transaction');
    const middle = new TaggedWithCauseOnly({ cause: inner });
    const outer = new TaggedWithCauseOnly({ cause: middle });
    expect(describeFailure(outer)).toContain('the node refused the transaction');
  });

  it('a string cause is the reason, not a wrapper around nothing', () => {
    const text = describeFailure(new TaggedWithCauseOnly({ cause: 'balance check failed' }));
    expect(text).toContain('balance check failed');
  });

  it('NEVER [object Object] — a blank wearing a disguise is still a blank', () => {
    const text = describeFailure(new TaggedWithCauseOnly({ cause: { code: 7, detail: 'fee too low' } }));
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('fee too low');
  });

  it('reads an Effect failure logged as a plain object, the shape the SDK logs', () => {
    const text = describeFailure({ _tag: 'Fail', error: 'No transaction found in storage' });
    expect(text).toContain('Fail');
    expect(text).toContain('No transaction found in storage');
  });

  it('a cyclic cause terminates and still says something', () => {
    const a: { cause?: unknown; message: string } = { message: 'outer' };
    const b: { cause?: unknown; message: string } = { message: 'inner' };
    a.cause = b;
    b.cause = a;
    const text = describeFailure(a);
    expect(text).toContain('outer');
    expect(text).toContain('inner');
    expect(text).not.toBe('');
  });

  it('a very deep chain is cut short rather than hanging, and says it was cut', () => {
    let error = new Error('the bottom');
    for (let i = 0; i < 50; i += 1) error = new Error(`layer ${i}`, { cause: error });
    const text = describeFailure(error);
    expect(text).toContain('[further causes not shown]');
  });

  it('NOTHING renders as a blank — every shape this wallet can be handed', () => {
    const shapes: unknown[] = [
      undefined, null, '', '   ', {}, [], 0, false, NaN,
      new Error(''),
      new TaggedWithCauseOnly({ cause: undefined }),
      new TaggedWithCauseOnly({ cause: {} }),
      { message: '' },
      { toString: () => { throw new Error('hostile'); } },
      Object.create(null) as object,
    ];
    for (const shape of shapes) {
      const text = describeFailure(shape);
      expect(text.trim(), `blank for ${String(typeof shape)}`).not.toBe('');
      expect(text).not.toContain('[object Object]');
    }
  });

  it('a bigint in an object cause does not throw JSON out of the reason', () => {
    const text = describeFailure(new TaggedWithCauseOnly({ cause: { shortfall: 681990789214992n } }));
    expect(text).toContain('681990789214992');
  });
});
