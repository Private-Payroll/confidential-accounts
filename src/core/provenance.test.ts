import { describe, it, expect } from 'vitest';
import {
  provenanceOf, countProvenance, isMixed, decideList, refuseSelectionOver,
  refuseSelectionOverHistory,
  type Marked, type WiringName,
} from './provenance.js';

/**
 * **THE RULES ABOUT WHICH LEDGER WROTE A RECORD, DRIVEN DIRECTLY.**
 *
 * They live in their own file with no store, no service and no server in them
 * precisely so this can happen: every case below calls the rule itself, so a
 * case that goes red names the rule that changed rather than a route that
 * happens to use it.
 */

/** A record carrying nothing but its marker, which is all these rules read. */
const rec = (wiring?: WiringName | null): Marked => (wiring === undefined ? {} : { wiring });

describe('what can be said about one record', () => {
  it('a record that says which ledger wrote it is believed', () => {
    // RED WHEN: provenanceOf stops reading `wiring` and answers a constant.
    expect(provenanceOf(rec('chain'))).toBe('chain');
    expect(provenanceOf(rec('simulated'))).toBe('simulated');
  });

  it('ABSENT IS NOT A CHAIN\'S, AND IT IS NOT A REHEARSAL EITHER', () => {
    /*
     * RED WHEN: the final branch of provenanceOf answers 'chain' or
     * 'simulated' instead of 'unknown'. Both were watched.
     *
     * The two halves are asserted separately because they fail for opposite
     * reasons and only one of them loses money: reading absence as a chain's
     * vouches for a record nothing can vouch for, and reading it as a
     * rehearsal dismisses a payment that may really have been made.
     */
    expect(provenanceOf(rec())).toBe('unknown');
    expect(provenanceOf(rec(null))).toBe('unknown');
  });

  it('a word this version does not recognise is unknown rather than the nearest match', () => {
    // RED WHEN: provenanceOf falls through to a default of 'chain' or 'simulated',
    // or matches on a prefix rather than on the whole word.
    expect(provenanceOf({ wiring: 'chain-testnet' } as unknown as Marked)).toBe('unknown');
    expect(provenanceOf({ wiring: '' } as unknown as Marked)).toBe('unknown');
    expect(provenanceOf({ wiring: 'Chain' } as unknown as Marked)).toBe('unknown');
  });
});

describe('counting a list', () => {
  it('every kind is counted, and a kind with none of it is a zero rather than a gap', () => {
    // RED WHEN: countProvenance builds its result by adding keys as it meets them,
    // so a list with no chain records answers `{ simulated: 1, unknown: 1 }` and a
    // caller reading `.chain` gets undefined instead of 0.
    expect(countProvenance([rec('simulated'), rec()]))
      .toEqual({ chain: 0, simulated: 1, unknown: 1 });
    expect(countProvenance([])).toEqual({ chain: 0, simulated: 0, unknown: 0 });
  });
});

describe('when a list is mixed', () => {
  it('a chain record beside one nothing vouches for is mixed', () => {
    // RED WHEN: isMixed drops either side of its conjunction.
    expect(isMixed({ chain: 1, simulated: 1, unknown: 0 })).toBe(true);
    expect(isMixed({ chain: 1, simulated: 0, unknown: 1 })).toBe(true);
  });

  it('A REHEARSAL BESIDE AN UNRECORDED ONE IS NOT MIXED, BECAUSE NEITHER CLAIMS A CHAIN', () => {
    /*
     * RED WHEN: isMixed becomes "more than one kind present", which is the
     * obvious-looking generalisation and is wrong. It would refuse a company
     * every list of its own rehearsals, for ever, over a distinction that
     * misleads nobody: nothing in such a list says a payment was settled.
     */
    expect(isMixed({ chain: 0, simulated: 3, unknown: 2 })).toBe(false);
  });

  it('one kind on its own is never mixed', () => {
    // RED WHEN: isMixed answers on count rather than on kind.
    expect(isMixed({ chain: 4, simulated: 0, unknown: 0 })).toBe(false);
    expect(isMixed({ chain: 0, simulated: 0, unknown: 9 })).toBe(false);
    expect(isMixed({ chain: 0, simulated: 0, unknown: 0 })).toBe(false);
  });
});

describe('what a company is shown', () => {
  it('a list of one kind is served whole, and every row carries its own word', () => {
    // RED WHEN: decideList returns the rows untouched, so nothing on the wire
    // says what any of them is.
    const verdict = decideList('simulated', [rec('simulated'), rec()]);
    expect(verdict.listed).toBe(true);
    if (!verdict.listed) throw new Error('unreachable');
    expect(verdict.rows.map(r => r.provenance)).toEqual(['simulated', 'unknown']);
  });

  it('NOTHING IS DROPPED FROM A LIST THAT IS SERVED', () => {
    /*
     * RED WHEN: decideList filters the rows it cannot vouch for instead of
     * marking them. That is the cheapest way to satisfy the property and the
     * worst: a company that raised three runs opens the page, sees none, and
     * nothing anywhere says why - a withheld list and an empty one look
     * identical.
     */
    const rows = [rec(), rec(), rec('simulated')];
    const verdict = decideList('chain', rows);
    expect(verdict.listed).toBe(true);
    if (!verdict.listed) throw new Error('unreachable');
    expect(verdict.rows).toHaveLength(rows.length);
  });

  it('a mixed list is refused whole, and nothing from it is served', () => {
    // RED WHEN: decideList serves a mixed list, or serves the chain half of it.
    const verdict = decideList('chain', [rec('chain'), rec()]);
    expect(verdict.listed).toBe(false);
    if (verdict.listed) throw new Error('unreachable');
    expect(verdict.refusal).toBe('records-from-more-than-one-ledger');
    expect(Object.keys(verdict)).not.toContain('rows');
  });

  it('the refusal counts what it refused, so the sentence is about real records', () => {
    // RED WHEN: the counts on a refusal are computed after the rows are dropped,
    // or are the counts of a different list.
    const verdict = decideList('chain', [rec('chain'), rec('chain'), rec('simulated'), rec()]);
    if (verdict.listed) throw new Error('unreachable');
    expect(verdict.counts).toEqual({ chain: 2, simulated: 1, unknown: 1 });
  });

  it('THE REFUSAL NAMES THE STATE THAT RESOLVES IT AND NOT A THING TO RUN', () => {
    /*
     * RED WHEN: the message is replaced by a code, a short label, or an
     * instruction to change a setting. Whoever reads this is a person looking
     * at a list of their own company's payroll; there is no file they can edit
     * and no process they can restart, so a refusal that names one tells them
     * nothing and reads as a fault in the product.
     */
    const verdict = decideList('chain', [rec('chain'), rec()]);
    if (verdict.listed) throw new Error('unreachable');
    expect(verdict.message).toContain('not all written against the same ledger');
    expect(verdict.message).toContain('keeping the records that never reached a chain separate');
    expect(verdict.message).not.toMatch(/\.command|npm run|environment variable|config/i);
  });

  it('the same records are refused whichever ledger is running, because the danger is theirs', () => {
    // RED WHEN: decideList only refuses when `running` is the chain, which would
    // let the same misleading list through the moment it is read anywhere else.
    const rows = [rec('chain'), rec()];
    expect(decideList('chain', rows).listed).toBe(false);
    expect(decideList('simulated', rows).listed).toBe(false);
  });

  it('an empty list is served rather than refused', () => {
    // RED WHEN: the refusal fires on a list with nothing in it, which would make
    // a company with no runs unable to reach the page that creates one.
    expect(decideList('chain', []).listed).toBe(true);
  });
});

describe('refusing the selection itself', () => {
  it('records nothing recorded refuse a chain selection', () => {
    // RED WHEN: refuseSelectionOver answers null while unknown records exist.
    expect(refuseSelectionOver('chain', { chain: 2, simulated: 0, unknown: 1 })).not.toBeNull();
  });

  it('IT CANNOT FIRE WHILE THE PRODUCT IS REHEARSING', () => {
    /*
     * RED WHEN: the `running === 'simulated'` arm is removed. Every record
     * written before markers existed is unknown, so without this arm the
     * product refuses to start against its own ordinary state and the check
     * gets deleted within a day.
     */
    expect(refuseSelectionOver('simulated', { chain: 0, simulated: 0, unknown: 40 })).toBeNull();
  });

  it('MARKED REHEARSALS DO NOT REFUSE A CHAIN SELECTION', () => {
    /*
     * RED WHEN: the check widens from "nothing recorded" to "anything not a
     * chain's". A marked rehearsal is a known quantity that the list rule
     * already shows with the word rehearsal on it, and refusing to start over
     * one would make this check the strictest thing in the product for the
     * least reason.
     */
    expect(refuseSelectionOver('chain', { chain: 0, simulated: 12, unknown: 0 })).toBeNull();
  });

  it('a store with nothing unrecorded in it starts', () => {
    // RED WHEN: the check fires on a count of records rather than on the unknown ones.
    expect(refuseSelectionOver('chain', { chain: 9, simulated: 0, unknown: 0 })).toBeNull();
  });

  it('the refusal says how many and what would resolve it', () => {
    // RED WHEN: the sentence loses its number, or names a file or a setting.
    const said = refuseSelectionOver('chain', { chain: 0, simulated: 0, unknown: 3 })!;
    expect(said).toContain('3 stored records');
    expect(said).toContain('records that each say which ledger produced them');
    expect(said).not.toMatch(/\.command|npm run|environment variable/i);
  });
});

describe('refusing a store two ledgers have written to', () => {
  it('one ledger, or none, starts', () => {
    // RED WHEN: the check fires on a store with a single writer, which is every
    // store this product has ever produced.
    expect(refuseSelectionOverHistory([])).toBeNull();
    expect(refuseSelectionOverHistory(['simulated'])).toBeNull();
    expect(refuseSelectionOverHistory(['chain'])).toBeNull();
  });

  it('TWO LEDGERS HAVING WRITTEN HERE IS REFUSED, AND IT STAYS TRUE AFTER THE RECORDS GO', () => {
    /*
     * RED WHEN: the check is dropped, or reads a count of records instead of
     * the history.
     *
     * This is the half a count cannot see. A company can cancel every round it
     * raised under the old ledger and the count of unrecorded records falls to
     * zero, while the store is still one two ledgers have written to and the
     * next list it produces can still be mixed.
     */
    expect(refuseSelectionOverHistory(['simulated', 'chain'])).not.toBeNull();
    expect(refuseSelectionOverHistory(['simulated', 'chain'])).toContain('more than one ledger');
  });

  it('the refusal names both of them, in the order they were seen', () => {
    // RED WHEN: the sentence is written without the names, leaving a reader
    // knowing something is wrong and not what has been here.
    expect(refuseSelectionOverHistory(['simulated', 'chain']))
      .toContain('simulated and then chain');
  });
});
