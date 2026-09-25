/**
 * **THE QUESTION EVERY RAISE ASKS, AS VALUES: IS SOMEBODY ON THIS RUN ALREADY
 * PAID, OR STILL ABLE TO BE PAID, THIS KIND OF PAYMENT FOR THIS MONTH?**
 */
import { describe, it, expect } from 'vitest';
import {
  PAYMENT_KINDS, alreadyPaying, confirmationCovers, kindOfRun, paidTwiceOnOneRun, samePayee,
  unaccountedOnChain, type RunPaying,
} from './already-paid.js';

const sameMonth = (a: string, b: string) => a === b;
const ada = { id: 'emp_ada', name: 'Ada', address: 'mn_shield-addr_ada' };
const bo = { id: 'emp_bo', name: 'Bo', address: 'mn_shield-addr_bo' };
/** Ada again, under a second roster entry, paid at the same address. */
const adaAgain = { id: 'emp_ada2', name: 'Ada L', address: 'MN_SHIELD-ADDR_ADA' };
const run = <K extends string>(id: string, month: string, kind: K, people: typeof ada[]): RunPaying<K> =>
  ({ id, month, kind, people });

describe('the same payee', () => {
  it('is one roster entry, or one address in any case, and nothing else', () => {
    /* RED WHEN an entry stops matching itself. */
    expect(samePayee(ada, { ...ada, address: null })).toBe(true);
    /* RED WHEN the address is compared by its spelling rather than its value. */
    expect(samePayee(ada, adaAgain)).toBe(true);
    /* RED WHEN two people with no address are matched by their absence. */
    expect(samePayee({ ...ada, address: null }, { ...bo, address: null })).toBe(false);
    expect(samePayee(ada, bo)).toBe(false);
  });
});

describe('who an earlier run already pays', () => {
  const september = run('run_sep', '2026-09', 'salary', [ada, bo]);

  it('names the earlier run and the people it covers, by entry or by address', () => {
    const again = run('run_new', '2026-09', 'salary', [adaAgain]);
    /* RED WHEN a person on the roster twice is not the same payee to the question. */
    expect(alreadyPaying(again, [september], sameMonth))
      .toEqual([{ run: september, people: [adaAgain] }]);
  });

  it('does not reach into another month, or compare a run with itself', () => {
    /* RED WHEN the month stops separating two runs over the same people. */
    expect(alreadyPaying(run('run_oct', '2026-10', 'salary', [ada, bo]), [september], sameMonth)).toEqual([]);
    /* RED WHEN a leg raised again, or a retry, is refused by its own run. */
    expect(alreadyPaying(september, [september], sameMonth)).toEqual([]);
  });

  it('is keyed by the kind of payment, so a later kind is a value and not a rewrite', () => {
    /* Salary is the only kind a run pays. */
    expect(PAYMENT_KINDS).toEqual(['salary']);
    expect(kindOfRun({})).toBe('salary');
    /* A kind that does not exist yet, spelled here only to show what is keyed.
       RED WHEN the kind stops being part of the question. */
    const another = run<'salary' | 'another'>('run_x', '2026-09', 'another', [ada]);
    expect(alreadyPaying(another, [september], sameMonth)).toEqual([]);
    expect(alreadyPaying({ ...another, kind: 'salary' }, [september], sameMonth)).toHaveLength(1);
  });
});

describe('the same payee twice on one run', () => {
  it('is found once per pair, and nobody else is', () => {
    /* RED WHEN two entries paid at one address are two payees on one run. */
    expect(paidTwiceOnOneRun([ada, bo, adaAgain])).toEqual([[ada, adaAgain]]);
    expect(paidTwiceOnOneRun([ada, bo])).toEqual([]);
  });
});

describe('what the chain holds that the records cannot account for', () => {
  it('is every open round they do not name, in any case, and every payment beyond the known ones', () => {
    /* RED WHEN a round the records name is counted as unknown because of its case. */
    expect(unaccountedOnChain({ openRounds: ['0xAA', '0xbb'], payments: 5 }, { rounds: ['0xaa'], paid: 3 }))
      .toEqual({ rounds: ['0xbb'], payments: 2, cannotSay: false });
    expect(unaccountedOnChain({ openRounds: [], payments: 0 }, { rounds: [], paid: 0 }))
      .toEqual({ rounds: [], payments: 0, cannotSay: false });
  });

  it('counts every payment when the chain cannot say which it made', () => {
    /* RED WHEN "cannot say" is read as "nobody". */
    expect(unaccountedOnChain({ openRounds: [], payments: 4 }, { rounds: [], paid: null }))
      .toEqual({ rounds: [], payments: 4, cannotSay: true });
  });

  it('is covered by a confirmation that names every round and counts at least as many payments', () => {
    const found = { rounds: ['0xbb'], payments: 2 };
    expect(confirmationCovers(found, { of: ['0xBB'], chainPayments: 2 })).toBe(true);
    /* RED WHEN a round nobody named is let through. */
    expect(confirmationCovers(found, { of: [], chainPayments: 2 })).toBe(false);
    /* RED WHEN a payment nobody counted is let through. */
    expect(confirmationCovers(found, { of: ['0xbb'], chainPayments: 1 })).toBe(false);
    expect(confirmationCovers(found, undefined)).toBe(false);
    expect(confirmationCovers({ rounds: [], payments: 0 }, undefined)).toBe(true);
  });
});
