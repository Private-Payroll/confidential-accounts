/**
 * **THE DOOR THAT CREATES A COMPANY DEPLOYS A CONTRACT AND SPENDS A FEE, SO A
 * SESSION MAY WRITE IT AND MAY NOT RUN IT. THESE CASES ARE HOW ITS REFUSALS ARE
 * WATCHED FIRING ANYWAY.**
 *
 * Every decision that door makes is next door in plain functions over plain
 * values, precisely so that none of them is reachable only by arranging a
 * wallet. A guard whose failure can only be seen by funding something is a
 * guard nobody has ever seen fire.
 */
import { describe, it, expect } from 'vitest';
import {
  CREATED, NOT_CREATED, PARTLY_CREATED, PRECONDITIONS, refuseIncompleteSetup, refuseUnprovenCompany,
  refuseUnseatableCompany, type CreatePreconditions,
} from './create-company-rules.js';

const ready = (over: Partial<CreatePreconditions> = {}): CreatePreconditions => ({
  fundedSeed: true,
  companySeed: true,
  maintenanceAuthority: true,
  compiledContract: true,
  proofServer: true,
  ...over,
});

describe('what has to be arranged before anything is spent', () => {
  it('says nothing at all when everything is there', () => {
    expect(refuseIncompleteSetup(ready())).toBeNull();
  });

  it('names EVERY missing piece and not the first one', () => {
    /*
     * **A DOOR THAT STOPS AT THE FIRST IS A DOOR SOMEBODY RUNS FIVE TIMES**,
     * arranging one thing per run, and every one of those runs is minutes of
     * waiting for a wallet to sync before it reaches the refusal.
     *
     * RED WHEN: the filter is replaced by a `find`, or the loop returns inside
     * its first iteration.
     */
    const said = refuseIncompleteSetup(ready({
      maintenanceAuthority: false, fundedSeed: false, proofServer: false,
    }))!;
    expect(said).toMatch(/who may change which proofs/);
    expect(said).toMatch(/no proof server is reachable/);
    expect(said).toMatch(/holds no funded wallet/);
  });

  it('names them in the order the work happens', () => {
    /*
     * Acquisition order, not alphabetical and not the order they happen to be
     * checked in: whoever reads this is about to go and arrange them.
     *
     * RED WHEN: `PRECONDITIONS` is reordered so the wallet comes before the
     * decision and the compile - which is the order that has somebody funding a
     * wallet for a contract they have not compiled.
     */
    expect(PRECONDITIONS[0]).toBe('maintenanceAuthority');
    expect(PRECONDITIONS.indexOf('compiledContract'))
      .toBeLessThan(PRECONDITIONS.indexOf('fundedSeed'));
  });

  it('says plainly that nothing was spent', () => {
    /*
     * **THE SENTENCE SOMEBODY ACTUALLY NEEDS.** A refusal from a door whose job
     * is to spend money leaves a reader wondering whether it spent any, and a
     * person who is unsure will not run it again.
     *
     * RED WHEN: the closing sentence is dropped.
     */
    expect(refuseIncompleteSetup(ready({ fundedSeed: false }))!)
      .toMatch(/nothing has been deployed and nothing has been spent/i);
  });

  it('does not send a reader to a file or a command', () => {
    // The person running this is not the person who wrote the paths.
    // RED WHEN: a path, a door name or a command line is put into a reason.
    for (const p of PRECONDITIONS) {
      const said = refuseIncompleteSetup(ready({ [p]: false } as Partial<CreatePreconditions>))!;
      expect(said, `the reason for ${p} names something to type`)
        .not.toMatch(/\.command|\.json|npm run|npx |\.seed\b/);
    }
  });
});

describe('what this path can seat', () => {
  it('accepts one signer at threshold one', () => {
    expect(refuseUnseatableCompany(1, 1)).toBeNull();
  });

  it('refuses more than one rather than seating the first and dropping the rest', () => {
    /*
     * **A REFUSAL AND NOT A TRUNCATION, AND THE DIFFERENCE IS A DEPLOYED
     * CONTRACT AND A SPENT FEE.** The contract creates the founder's seat and
     * nothing else. A door that accepted three names would deploy a company
     * whose record says three signers and whose chain holds one, report
     * success, and tell nobody - and a record and a chain that disagree about
     * who may approve is the shape of every way this product can lose money.
     *
     * RED WHEN: the `> 1` branch is removed, or turned into a warning.
     */
    expect(refuseUnseatableCompany(3, 2)).toMatch(/can seat one signer and was given 3/);
  });

  it('refuses none, because a company with no seat can never gain one', () => {
    /*
     * It is dead on arrival, permanently: adding a signer requires an existing
     * signer to ask, so there would be nobody able to seat the first.
     *
     * RED WHEN: the `< 1` branch is removed.
     */
    expect(refuseUnseatableCompany(0, 1)).toMatch(/needs a founding signer/);
  });

  it('refuses a bar one signer cannot reach', () => {
    /*
     * An account that cannot meet its own threshold cannot lower it either,
     * because lowering it is a change that has to be approved first.
     *
     * RED WHEN: the threshold branch is dropped, or written as `< 1`, which
     * lets a one-signer company be created at five.
     */
    expect(refuseUnseatableCompany(1, 5)).toMatch(/cannot have a threshold of 5/);
    expect(refuseUnseatableCompany(1, 0)).not.toBeNull();
  });

  it('and a threshold that is not a whole number is not a rule', () => {
    // RED WHEN: `Number.isInteger` is dropped. `NaN !== 1` is true so this one
    // survives that, but `1.0000001` and `1.5` do not.
    expect(refuseUnseatableCompany(1, 1.5)).not.toBeNull();
    expect(refuseUnseatableCompany(1, Number.NaN)).not.toBeNull();
  });
});

describe('what counts as proof that a company was created', () => {
  const created = {
    accountId: 'acc_one', recordedAddress: '00'.repeat(32),
    addressSource: 'chain', wiring: 'chain',
  };

  it('accepts a company a chain assigned an address to', () => {
    expect(refuseUnprovenCompany(created)).toBeNull();
  });

  it('refuses a company with no address, because nobody can ever read it again', () => {
    /*
     * The address exists only where the chain assigned it. A company filed
     * without one has a contract on a chain that nothing can find.
     *
     * RED WHEN: the address check is removed.
     */
    expect(refuseUnprovenCompany({ ...created, recordedAddress: null }))
      .toMatch(/no contract address was recorded/);
  });

  it('refuses an address no chain assigned, which is the whole point of the check', () => {
    /*
     * **SIXTY-FOUR HEX CHARACTERS CANNOT BE TOLD FROM SIXTY-FOUR HEX CHARACTERS
     * SOME PROCESS INVENTED FOR ITSELF.** A door that reported success on the
     * presence of an address would report success for a company that exists
     * only in a file, and reading a company at an invented address shows the
     * same balances and the same rounds to everybody.
     *
     * RED WHEN: the `addressSource` check is removed, or loosened to a
     * truthiness test - the value below is truthy.
     */
    expect(refuseUnprovenCompany({ ...created, addressSource: 'simulated' }))
      .toMatch(/no chain assigned/);
    expect(refuseUnprovenCompany({ ...created, addressSource: null }))
      .toMatch(/no chain assigned/);
  });

  it('refuses a record another boundary wrote', () => {
    /*
     * A record is read back by the word it carries, so a company marked
     * otherwise cannot be shown beside one a chain wrote and nothing afterwards
     * could work out which it was.
     *
     * RED WHEN: the `wiring` check is removed.
     */
    expect(refuseUnprovenCompany({ ...created, wiring: 'simulated' }))
      .toMatch(/rather than by the chain boundary/);
  });

  it('has a third answer for a company that WAS created and then something failed', () => {
    /*
     * **A COMPANY IS CREATED ON THE CHAIN BEFORE IT IS READ BACK.** The
     * read-back, the checks on the record and the shutting down of the wallets
     * can all fail against a company that exists and was paid for. Reported as
     * *nothing above this line succeeded*, that is a person being told to do
     * the one thing the door warns against twice.
     *
     * RED WHEN: `PARTLY_CREATED` is deleted, or is written so that it reads as
     * one of the other two - the assertions below are about what a person takes
     * from it, not about its wording.
     */
    expect(PARTLY_CREATED).toMatch(/was created/i);
    expect(PARTLY_CREATED).toMatch(/spent/i);
    expect(PARTLY_CREATED, 'the middle answer reads as the failing one')
      .not.toContain(NOT_CREATED);
    expect(PARTLY_CREATED, 'the middle answer reads as the succeeding one')
      .not.toContain(CREATED);
  });

  it('and the two verdict lines cannot be mistaken for each other', () => {
    /*
     * They are constants so that the sentence a person reads and the sentence
     * anything else looks for cannot drift apart.
     *
     * RED WHEN: either becomes a substring of the other, which is what happens
     * the day somebody writes the failing one as "NOT " plus the passing one.
     */
    expect(NOT_CREATED).not.toContain(CREATED);
    expect(CREATED).not.toContain(NOT_CREATED);
  });
});
