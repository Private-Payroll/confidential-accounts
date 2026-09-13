/**
 * WHAT SURVIVES AT AN ADDRESS, AND WHICH OF IT EARNS.
 *
 * The socket is not reachable from here and is deliberately thin. The
 * arithmetic is, and it is the part a wrong answer would come out of.
 *
 * Each assertion names the change that turns it red, and each of those changes
 * was applied to a COPY of the module outside this repository and watched
 * failing. A copy, never a link.
 */
import { describe, expect, it } from 'vitest';

import { describeHolding, holdingOf, SUBSCRIPTION, type ChainUtxo } from './chain-registered-night.js';

const NIGHT = 'night';
const u = (i: number, value: bigint, registered: boolean | null | undefined, token = NIGHT): ChainUtxo =>
  ({ tokenType: token, value: String(value), intentHash: 'h' + i, outputIndex: 0, registeredForDustGeneration: registered });

describe('WHAT IS STILL THERE', () => {
  it('takes spent outputs out, matching on the intent hash AND the index', () => {
    /*
     * TURNS RED IF: an output is identified by its hash alone.
     *
     * One transaction makes several outputs and they share a hash. Matching on
     * the hash alone would retire every output of a transaction as soon as one
     * of them was spent, and the holding would read low.
     */
    const created = [u(1, 10n, true), { ...u(1, 20n, true), outputIndex: 1 }];
    const h = holdingOf(created, [{ ...u(1, 10n, true), outputIndex: 0 }], NIGHT);
    expect(h.unspent).toHaveLength(1);
    expect(h.total).toBe(20n);
  });

  it('ignores outputs of another token', () => {
    // TURNS RED IF: the token filter is dropped, which would count a test token
    // as though it could pay a fee.
    const h = holdingOf([u(1, 10n, true), u(2, 99n, true, 'something-else')], [], NIGHT);
    expect(h.unspent).toHaveLength(1);
    expect(h.total).toBe(10n);
  });

  it('adds values as whole numbers, not as floating point', () => {
    // TURNS RED IF: the sum goes through Number. These values run past what a
    // double can hold exactly, and a fee decision would be made on a rounded one.
    const big = 9_007_199_254_740_993n;
    const h = holdingOf([u(1, big, true), u(2, 1n, true)], [], NIGHT);
    expect(h.total).toBe(big + 1n);
  });
});

describe('WHICH OF IT EARNS, WHICH IS THE QUESTION THE MONEY TURNS ON', () => {
  it('counts only what the chain says is registered', () => {
    // TURNS RED IF: the flag stops being read, so unregistered money is
    // reported as able to pay.
    const h = holdingOf([u(1, 10n, true), u(2, 10n, false)], [], NIGHT);
    expect(h.unspent).toHaveLength(2);
    expect(h.registered).toHaveLength(1);
  });

  it('treats a MISSING flag as not registered, and says how many were missing', () => {
    /*
     * TURNS RED IF: a missing flag is read as either answer.
     *
     * Read as true it is a licence to send money somewhere nothing established
     * can spend it. Read as false it is an alarm on every output at once, which
     * is the kind of alarm somebody switches off. It is neither: it is counted
     * as unspent, not counted as registered, and reported separately.
     */
    const h = holdingOf([u(1, 10n, undefined), u(2, 10n, null), u(3, 10n, true)], [], NIGHT);
    expect(h.unspent).toHaveLength(3);
    expect(h.registered).toHaveLength(1);
    expect(h.unknownFlags).toBe(2);
  });

  it('does not count a flag that is merely truthy', () => {
    // TURNS RED IF: the comparison is loosened to truthiness. The string 'no'
    // is truthy, and this decides whether money can ever move again.
    const h = holdingOf([{ ...u(1, 10n, undefined), registeredForDustGeneration: 'no' as any }], [], NIGHT);
    expect(h.registered).toHaveLength(0);
    expect(h.unknownFlags).toBe(1);
  });
});

describe('WHAT THE READER IS TOLD', () => {
  it('says plainly when the read did not reach the chain, so it is not mistaken for a holding', () => {
    /*
     * TURNS RED IF: an incomplete read is described the same way as a complete
     * one. A short list is indistinguishable from a smaller balance, and only
     * one of those two is safe to act on.
     */
    const lines = describeHolding('addr', {
      unspent: [], registered: [], total: 0n, complete: false, note: 'the read stopped after 45s',
    }).join('\n');
    expect(lines).toContain('DID NOT REACH');
    expect(lines).toContain('the read stopped after 45s');
  });

  it('does not raise that alarm on a complete read', () => {
    // TURNS RED IF: the warning is printed unconditionally, which teaches a
    // reader to skip it.
    const lines = describeHolding('addr', {
      unspent: [u(1, 10n, true)], registered: [u(1, 10n, true)], total: 10n, complete: true, note: 'reached',
    }).join('\n');
    expect(lines).not.toContain('DID NOT REACH');
    expect(lines).toContain('1 of them registered');
  });

  it('asks the indexer for the registration flag at all', () => {
    // TURNS RED IF: the field is dropped from the subscription, which would
    // make every flag missing and every output read as not registered.
    expect(SUBSCRIPTION).toContain('registeredForDustGeneration');
    expect(SUBSCRIPTION).toContain('spentUtxos');
  });
});
