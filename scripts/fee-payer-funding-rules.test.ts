/**
 * THE SEVEN REFUSALS, PINNED WHERE A TEST CAN REACH THEM.
 *
 * The door these belong to submits a transaction that cannot be undone and
 * nobody runs it by hand to see whether it refuses correctly. So the rules live
 * in their own module and are driven from here.
 *
 * EACH ASSERTION NAMES THE CHANGE THAT TURNS IT RED, AND EACH OF THOSE CHANGES
 * WAS APPLIED TO A COPY OF THE MODULE OUTSIDE THIS REPOSITORY AND WATCHED
 * FAILING BEFORE THE ASSERTION WAS KEPT. A copy, never a link.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE: that the number of NIGHT outputs is
 * three. An assertion comparing a constant against a copy of itself cannot
 * fail, and this file is not the place to keep one for comfort. What that
 * number is safe against is a property of the chain and of the wallet library,
 * and it is measured against them rather than restated here.
 */
import { describe, expect, it } from 'vitest';

import {
  abilityToPay,
  checkBalancer,
  checkCost,
  checkOutputs,
  checkParameters,
  checkRegistration,
  checkSection,
  checkSpare,
  feePayingSpendsOf,
  fundingVerdicts,
  maySubmit,
  allowanceFor,
  dismissLimitsFrom,
  outputsOf,
  parseDismissMessage,
  planOutputs,
  registrationsOf,
  signaturesOf,
  toPicoseconds,
  type BuiltOutput,
  type FundingReading,
} from './fee-payer-funding-rules.js';
import type { ParametersReading } from './live-ledger-parameters.js';

const liveReading: ParametersReading = {
  source: 'live', parameters: {}, payloadBytes: 791, tag: 'midnight:ledger-parameters', node: 'https://a.node',
};

const out = (owner: string, value: bigint, section: 'guaranteed' | 'fallible' = 'fallible'): BuiltOutput =>
  ({ owner, value, section });

/** A registration whose generation goes where it should, unless told otherwise. */
const reg = (owner: string | null, dustReceiver: string | null = 'the new wallet dust address',
             expectedDustReceiver: string | null = 'the new wallet dust address') =>
  ({ owner, dustReceiver, expectedDustReceiver });

/** The message the chain's own cost call produces when it refuses, word for word. */
const REFUSAL_MESSAGE =
  'exceeded the maximum time to dismiss for transaction size; this transaction would take '
  + '15.038ms to dismiss, but given its size of 7088 bytes, it may take at most 15.000ms';

describe('1 - THE PARAMETERS WERE READ FROM THE CHAIN', () => {
  it('passes a live reading and says where it came from', () => {
    // TURNS RED IF: the live case is made to refuse, or stops naming the node
    // and the payload, which is the only evidence a reader has that it is live.
    const v = checkParameters(liveReading);
    expect(v.passed).toBe(true);
    expect(v.line).toContain('https://a.node');
    expect(v.line).toContain('791');
  });

  it('REFUSES the library constant and names the check that could not run', () => {
    /*
     * TURNS RED IF: the fallback branch is dropped, or downgraded to a warning.
     *
     * The constant is not what any live chain runs. A verdict computed at it
     * describes a chain that does not exist, and this project has published
     * numbers taken that way without a single one of them saying so.
     */
    const v = checkParameters({
      source: 'fallback', parameters: {}, payloadBytes: null, tag: null, node: null,
      problem: 'the node did not answer',
    });
    expect(v.passed).toBe(false);
    expect(v.line).toContain('state call');
    expect(v.line).toContain('the node did not answer');
  });

  it('REFUSES a live reading that carries no parameters', () => {
    // TURNS RED IF: the null check is dropped, which would let a reading whose
    // decode failed pass on the strength of its label alone.
    const v = checkParameters({ ...liveReading, parameters: null, problem: 'the answer could not be decoded' });
    expect(v.passed).toBe(false);
    expect(v.line).toContain('could not be decoded');
  });
});

describe('2 - THE CHAIN\'S OWN COST CALL, AND THE NUMBERS IN ITS REFUSAL', () => {
  it('reads all three numbers out of the refusal, word for word as the chain writes it', () => {
    // TURNS RED IF: any of the three patterns stops matching the wording the
    // ledger actually formats, which is the one branch where the numbers matter.
    const n = parseDismissMessage(REFUSAL_MESSAGE);
    expect(n.dismissPs).toBe(15_038_000_000);
    expect(n.allowancePs).toBe(15_000_000_000);
    expect(n.sizeBytes).toBe(7088);
  });

  it('reads microseconds written with the Greek letter, which is what is printed', () => {
    /*
     * TURNS RED IF: the micro sign in the pattern is replaced with the letter u.
     *
     * The formatter writes the Greek small letter mu. A parser written for `us`
     * silently reads every microsecond figure as unmatched, and unmatched here
     * means the door prints "not read" for a number it was handed.
     */
    const n = parseDismissMessage('would take 900.000μs to dismiss, but given its size of 10 bytes, it may take at most 15.000ms');
    expect(n.dismissPs).toBe(900_000_000);
  });

  it('returns nothing rather than inventing a number when the wording does not match', () => {
    // TURNS RED IF: a default or a zero is substituted for an unmatched number.
    // A zero here reads as a transaction that costs nothing to dismiss.
    const n = parseDismissMessage('something else entirely went wrong');
    expect(n.dismissPs).toBeNull();
    expect(n.allowancePs).toBeNull();
    expect(n.sizeBytes).toBeNull();
  });

  it('scales every unit the formatter can print', () => {
    // TURNS RED IF: any scale in the table is wrong by a factor of a thousand,
    // which is the error that makes a refusal look like a comfortable margin.
    expect(toPicoseconds(1, 'ps')).toBe(1);
    expect(toPicoseconds(1, 'ns')).toBe(1_000);
    expect(toPicoseconds(1, 'μs')).toBe(1_000_000);
    expect(toPicoseconds(1, 'ms')).toBe(1_000_000_000);
    expect(toPicoseconds(1, 's')).toBe(1_000_000_000_000);
    expect(toPicoseconds(1, 'fortnights')).toBeNull();
  });

  it('REFUSES a refused cost AND KEEPS THE NUMBERS, with the overage worked out', () => {
    /*
     * TURNS RED IF: the refusal branch keeps the message and drops the reading.
     *
     * That is what the existing size instrument does on exactly this branch,
     * and it is the only branch on which the numbers are worth anything: a
     * transaction that fits needs no explanation, and one that does not is
     * acted on by how far over it is.
     */
    const v = checkCost({ kind: 'refused', numbers: parseDismissMessage(REFUSAL_MESSAGE), message: REFUSAL_MESSAGE });
    expect(v.passed).toBe(false);
    expect(v.line).toContain('15.038ms');
    expect(v.line).toContain('15.000ms');
    expect(v.line).toContain('7088 bytes');
    expect(v.line).toContain('over by');
  });

  it('REFUSES a cost that could not be computed at all', () => {
    // TURNS RED IF: an unreadable cost is allowed to pass. Not knowing what the
    // node will say is not the same as knowing it will accept.
    const v = checkCost({ kind: 'unreadable', message: 'the call is not available' });
    expect(v.passed).toBe(false);
    expect(v.line).toContain('the call is not available');
  });

  it('passes a cost within the allowance and states the margin', () => {
    // TURNS RED IF: the passing branch stops reporting the margin, leaving a
    // reader unable to see that it fits by a hair.
    const v = checkCost({ kind: 'within', numbers: { dismissPs: 12_000_000_000, allowancePs: 15_000_000_000, sizeBytes: 700 } });
    expect(v.passed).toBe(true);
    expect(v.line).toContain('under');
    expect(v.line).toContain('20.0%');
  });
});

describe('3 - EVERY NIGHT OUTPUT IS IN THE FALLIBLE HALF', () => {
  it('passes when they all are', () => {
    // TURNS RED IF: the fallible case is made to refuse.
    expect(checkSection([out('b', 1n), out('b', 2n)]).passed).toBe(true);
  });

  it('REFUSES when even one is in the guaranteed half', () => {
    /*
     * TURNS RED IF: the section is not asserted, or only the first output is
     * looked at.
     *
     * The dismiss allowance is charged on the guaranteed half alone. Against
     * the parameters this chain runs, one NIGHT output fits there and two do
     * not. Three works only because the wallet library puts NIGHT transfers in
     * the other half, and nothing announces a change to that.
     */
    const v = checkSection([out('b', 1n), out('b', 2n, 'guaranteed')]);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('1 of 2');
    expect(v.line).toContain('guaranteed half');
  });

  it('REFUSES an empty list rather than passing it vacuously', () => {
    // TURNS RED IF: an empty list is allowed through. Reading no outputs means
    // the question was never asked, and a check with nothing to check is the
    // shape that passes for ever without ever being able to fail.
    expect(checkSection([]).passed).toBe(false);
  });
});

describe('4 - EXACTLY THE PLANNED OUTPUTS, AND NOTHING THE LIBRARY ADDED', () => {
  const intended = [
    { owner: 'new', value: 10n, purpose: 'ordinary' },
    { owner: 'new', value: 10n, purpose: 'exit' },
    { owner: 'old', value: 5n, purpose: 'the spare' },
  ];

  it('passes when the built list matches the plan', () => {
    // TURNS RED IF: the comparison is made stricter than the plan, for instance
    // by taking order into account, which the library does not preserve.
    expect(checkOutputs(intended, [out('old', 5n), out('new', 10n), out('new', 10n)]).passed).toBe(true);
  });

  it('REFUSES an output nobody asked for', () => {
    /*
     * TURNS RED IF: the built-against-planned direction is dropped.
     *
     * Coin selection prepends its own change output inside the library, where
     * the caller never sees it, and it counts against the same allowance as
     * every other output.
     */
    const v = checkOutputs(intended, [out('old', 5n), out('new', 10n), out('new', 10n), out('change', 3n)]);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('nobody asked for');
  });

  it('REFUSES a planned output that is not on the transaction', () => {
    // TURNS RED IF: the planned-against-built direction is dropped. An output
    // that was asked for and never built is a different failure with the same
    // remedy, and only one of the two directions catches it.
    const v = checkOutputs(intended, [out('old', 5n), out('new', 10n)]);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('not on the transaction');
  });

  it('REFUSES outputs with the right owners and the WRONG AMOUNTS', () => {
    /*
     * TURNS RED IF: an output is identified by its owner alone.
     *
     * IT WAS NOT ASSERTED UNTIL SOMEBODY MUTATED IT. Every fixture above
     * differs in owner as well as in amount, so dropping the value from the
     * comparison left all four of this group's assertions green. The whole act
     * is a four-way split of one wallet's money: owners right and amounts wrong
     * is precisely the failure this check is named for.
     */
    const v = checkOutputs(intended, [out('old', 5n), out('new', 1n), out('new', 19n)]);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('nobody asked for');
  });

  it('counts repeats rather than collapsing them, so a lost duplicate is seen', () => {
    /*
     * TURNS RED IF: the comparison is done with sets instead of counts.
     *
     * Two of the three outputs carry the same owner and the same value by
     * design. With sets, building one of them instead of two compares equal
     * and the door would submit a transaction short of an output.
     */
    const v = checkOutputs(intended, [out('old', 5n), out('new', 10n), out('new', 10n), out('new', 10n)]);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('nobody asked for');
  });
});

describe('5 - EVERY NIGHT OUTPUT IS REGISTERED, AND THIS IS THE ONE THAT PROTECTS THE MONEY', () => {
  it('passes when this transaction registers the owner of every output', () => {
    // TURNS RED IF: the covering case is made to refuse, which would stop the
    // ordinary act.
    const v = checkRegistration(
      [out('new', 10n), out('new', 10n), out('new', 10n)],
      { derivedFromThisTransaction: [reg('new')], alreadyRegisteredOnChain: [] },
    );
    expect(v.passed).toBe(true);
    expect(v.line).toContain('3 of 3 covered');
  });

  it('REFUSES when ONE output of several is not covered', () => {
    /*
     * TURNS RED IF: the rule asks whether SOME output is covered rather than
     * every one.
     *
     * MEASURED AGAINST THE LEDGER: two outputs to a registered address and one
     * to an unregistered address applies cleanly, and leaves two dust against
     * the registered address and one NIGHT output that can never be spent. The
     * transaction succeeds. Every check written as "is the registration right"
     * rather than "is every output covered" passes that transaction.
     */
    const v = checkRegistration(
      [out('new', 10n), out('new', 10n), out('stranger', 10n)],
      { derivedFromThisTransaction: [reg('new')], alreadyRegisteredOnChain: [] },
    );
    expect(v.passed).toBe(false);
    expect(v.line).toContain('1 of 3');
    expect(v.line).toContain('never be spent');
  });

  it('accepts an owner registered in an EARLIER transaction, read off the chain', () => {
    /*
     * TURNS RED IF: coverage is narrowed to this transaction's own
     * registrations.
     *
     * MEASURED: an output sent to an address registered earlier generates dust
     * with no registration in the transaction that creates it. The spare output
     * deliberately goes back to the old wallet, which registered long ago, so
     * narrowing this would refuse the exact shape the plan requires.
     */
    const v = checkRegistration(
      [out('new', 10n), out('old', 5n)],
      { derivedFromThisTransaction: [reg('new')], alreadyRegisteredOnChain: ['old'] },
    );
    expect(v.passed).toBe(true);
    expect(v.line).toContain('1 by a registration read off the chain');
  });

  it('REFUSES a registration whose key could not be turned into an address', () => {
    /*
     * TURNS RED IF: keys that could not be derived are quietly filtered out.
     *
     * Filtering them leaves a shorter list that may still cover every output by
     * accident, so the door would report full coverage while holding a
     * registration it cannot account for.
     */
    const v = checkRegistration(
      [out('new', 10n)],
      { derivedFromThisTransaction: [reg('new'), reg(null)], alreadyRegisteredOnChain: [] },
    );
    expect(v.passed).toBe(false);
    expect(v.line).toContain('could not be turned into an owner address');
  });

  it('REFUSES when an output leans on the chain and the chain could not be asked', () => {
    /*
     * TURNS RED IF: a chain that could not be read is treated as a warning.
     *
     * The second source of coverage is evidence or it is nothing. Assuming it
     * is the one assumption here that cannot be undone.
     */
    const v = checkRegistration(
      [out('new', 10n), out('old', 5n)],
      { derivedFromThisTransaction: [reg('new')], alreadyRegisteredOnChain: [], chainProblem: 'the indexer did not answer' },
    );
    expect(v.passed).toBe(false);
    expect(v.line).toContain('the indexer did not answer');
  });

  it('passes with an unreadable chain when THIS transaction covers every output', () => {
    /*
     * TURNS RED IF: a chain problem is made fatal on its own.
     *
     * Nothing is leaning on the chain in this shape, so stopping would be
     * refusing a safe transaction over a reading nothing needed. A refusal has
     * to name a risk that is actually present.
     */
    const v = checkRegistration(
      [out('new', 10n)],
      { derivedFromThisTransaction: [reg('new')], alreadyRegisteredOnChain: [], chainProblem: 'the indexer did not answer' },
    );
    expect(v.passed).toBe(true);
  });

  it('REFUSES a registration that sends the generation to a DIFFERENT wallet', () => {
    /*
     * TURNS RED IF: the delegated address is not read, or is compared against
     * itself rather than against where these outputs were meant to generate.
     *
     * THIS IS THE SAME LOSS AS AN UNREGISTERED OUTPUT, REACHED BY A
     * TRANSACTION THAT LOOKS RIGHT. The registration names the correct owner,
     * so the outputs are registered and do generate; the generation belongs to
     * another wallet, so the one holding the NIGHT still cannot pay to move it.
     * A check reading only the night key calls all of it covered.
     */
    const v = checkRegistration(
      [out('new', 10n), out('new', 10n), out('new', 10n)],
      { derivedFromThisTransaction: [reg('new', 'the OLD wallet dust address')], alreadyRegisteredOnChain: [] },
    );
    expect(v.passed).toBe(false);
    expect(v.line).toContain('other than the one these outputs are for');
    expect(v.line).toContain('could not pay a fee to move it');
  });

  it('REFUSES a misdirected delegation EVEN WHEN the chain could not be read', () => {
    /*
     * TURNS RED IF: the delegation check is made conditional on the chain
     * having been read.
     *
     * THIS IS THE HOLE THAT PUTS THE WHOLE LOSS BACK, BEHIND A NETWORK BLIP.
     * Where the generation goes is answered entirely off this transaction and
     * needs no chain at all. Guard it on the chain and an indexer that hiccups
     * lets a registration through that hands every speck to another wallet -
     * and because this transaction's own registrations cover every output,
     * nothing is leaning on the chain, so the chain-problem branch does not
     * fire either and the whole check passes.
     */
    const v = checkRegistration(
      [out('new', 10n)],
      {
        derivedFromThisTransaction: [reg('new', 'the OLD wallet dust address')],
        alreadyRegisteredOnChain: [],
        chainProblem: 'the indexer did not answer',
      },
    );
    expect(v.passed).toBe(false);
    expect(v.line).toContain('other than the one these outputs are for');
  });

  it('REFUSES when the SECOND of two registrations misdirects the generation', () => {
    /*
     * TURNS RED IF: only the first registration is looked at.
     *
     * THE SAME LESSON THIS FILE ALREADY WROTE DOWN FOR OUTPUTS, and it was not
     * applied here until somebody mutated it: every other fixture in this group
     * carries exactly one registration, so a check reading only the first was
     * indistinguishable from one reading all of them. The reader this feeds
     * collects registrations from every intent, so it is written for a list.
     */
    const v = checkRegistration(
      [out('new', 10n)],
      {
        derivedFromThisTransaction: [reg('new'), reg('new', 'the OLD wallet dust address')],
        alreadyRegisteredOnChain: [],
      },
    );
    expect(v.passed).toBe(false);
  });

  it('compares the delegated address exactly, not loosely', () => {
    // TURNS RED IF: either side is normalised, trimmed or truncated before the
    // comparison. The two sides are one number printed twice; anything that
    // tidies one of them is a comparison that stopped reading the value.
    const v = checkRegistration(
      [out('new', 10n)],
      {
        derivedFromThisTransaction: [reg('new', '442025205592104378', '4420252055921043780')],
        alreadyRegisteredOnChain: [],
      },
    );
    expect(v.passed).toBe(false);
  });

  it('REFUSES when where the generation would go was not read at all', () => {
    // TURNS RED IF: an unread delegation is allowed through. Not knowing who
    // would own the generation is not the same as knowing it is the right one.
    expect(checkRegistration([out('new', 10n)],
      { derivedFromThisTransaction: [reg('new', null)], alreadyRegisteredOnChain: [] }).passed).toBe(false);
    expect(checkRegistration([out('new', 10n)],
      { derivedFromThisTransaction: [reg('new', 'x', null)], alreadyRegisteredOnChain: [] }).passed).toBe(false);
  });

  it('REFUSES an empty list of outputs rather than passing it vacuously', () => {
    // TURNS RED IF: an empty list passes. Checking nothing is not the same as
    // finding nothing wrong, and this is the check where that distinction is
    // the whole balance of the project.
    expect(checkRegistration([], { derivedFromThisTransaction: [reg('new')], alreadyRegisteredOnChain: [] }).passed).toBe(false);
  });
});

describe('6 - THE OLD WALLET KEEPS SOMETHING THAT CAN PAY FOR A REPAIR', () => {
  it('REFUSES when what it would hold afterwards was never established', () => {
    // TURNS RED IF: an unestablished count is treated as satisfying the rule.
    expect(checkSpare(null).passed).toBe(false);
  });

  it('REFUSES a clean sweep that leaves it with nothing', () => {
    // TURNS RED IF: the comparison admits zero. Zero is the state in which no
    // wallet anywhere can pay for the transaction that would fix a mistake.
    const v = checkSpare(0);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('no wallet left able to fix it');
  });

  it('passes when one is left behind', () => {
    // TURNS RED IF: the rule demands more than one, which would cost a second
    // output for nothing.
    expect(checkSpare(1).passed).toBe(true);
  });
});

describe('7 - THE FEE BALANCER, AND A THROW THAT MUST NOT READ AS NOTHING-HAPPENED', () => {
  it('REFUSES when the balancer failed, and says what it said', () => {
    // TURNS RED IF: the throw branch loses the message, leaving a reader with a
    // refusal and no cause.
    const v = checkBalancer({ kind: 'threw', message: 'did not converge in 64 iterations' }, 1);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('did not converge in 64 iterations');
  });

  it('REFUSES a transaction carrying NO fee-paying spend', () => {
    /*
     * TURNS RED IF: zero is allowed through.
     *
     * Two different failures arrive as zero and both must stop. A transaction
     * that owes a fee and offers nothing to pay it with is refused by the chain
     * as malformed. And a count taken from an object that does not have the
     * thing being counted is also zero - which is what an earlier version of
     * this door did - and reads as having balanced perfectly on the first pass.
     */
    const v = checkBalancer({ kind: 'converged', feePayingSpends: 0 }, 1);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('no fee-paying spend at all');
  });

  it('REFUSES when what the balancer did was never recorded', () => {
    /*
     * TURNS RED IF: the unrecorded case is folded in with the passing one.
     *
     * This project has already submitted on a wallet whose set-up threw, because
     * the throw was reported as nothing-having-changed and no caller stopped.
     * A failure that is not recorded reads exactly like a success.
     */
    const v = checkBalancer({ kind: 'unknown', why: 'the outcome was not captured' }, 1);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('reads exactly like a success');
  });

  it('REFUSES when it paid with more spends than the shape was measured to need', () => {
    // TURNS RED IF: the comparison is dropped, or loosened to the library's own
    // cap, which is a bound against hanging rather than a statement that this is
    // the shape that was measured.
    const v = checkBalancer({ kind: 'converged', feePayingSpends: 5 }, 1);
    expect(v.passed).toBe(false);
    expect(v.line).toContain('5 fee-paying spends where 1');
  });

  it('passes at the expected number and under it, above zero', () => {
    // TURNS RED IF: the comparison becomes exact equality, which would refuse a
    // transaction that balanced more cheaply than expected.
    expect(checkBalancer({ kind: 'converged', feePayingSpends: 2 }, 2).passed).toBe(true);
    expect(checkBalancer({ kind: 'converged', feePayingSpends: 1 }, 2).passed).toBe(true);
  });
});

describe('THE ALLOWANCE, WHICH THE PARAMETERS DO NOT EXPOSE TO A CALLER', () => {
  /** The parameters as they actually print themselves, abridged. */
  const PRINTED = 'LedgerParameters { limits: LedgerLimits { transaction_byte_limit: 1048576, '
    + 'time_to_dismiss_per_byte: 2.000\u03bcs, min_time_to_dismiss: 15.000ms }, block_usage: 1000000 }';

  it('reads both terms out of the printed parameters', () => {
    /*
     * TURNS RED IF: either field name or the unit handling changes.
     *
     * The published object offers the cost model, the dust parameters, the fee
     * prices, a normaliser and a serialiser, and NO LIMITS AT ALL. The printed
     * form is the only route to these two, which is why the door treats what
     * comes out of it as a weaker reading than everything else here.
     */
    expect(dismissLimitsFrom(PRINTED)).toEqual({ perBytePs: 2_000_000, floorPs: 15_000_000_000 });
  });

  it('returns nothing rather than a guess when the wording does not match', () => {
    // TURNS RED IF: a missing term is defaulted. A defaulted floor would print a
    // margin nobody measured, next to a decision about money.
    expect(dismissLimitsFrom('LedgerParameters { }')).toEqual({ perBytePs: null, floorPs: null });
  });

  it('takes the larger of the per-byte cost and the floor', () => {
    /*
     * TURNS RED IF: the two are added, or the smaller is taken.
     *
     * Below about 7,500 bytes the floor binds and the per-byte term is
     * irrelevant; above it the floor is. Taking the wrong one understates the
     * allowance for every small transaction, which is all of these.
     */
    const limits = { perBytePs: 2_000_000, floorPs: 15_000_000_000 };
    expect(allowanceFor(limits, 1_000)).toBe(15_000_000_000);
    expect(allowanceFor(limits, 100_000)).toBe(200_000_000_000);
  });

  it('answers nothing when any term is missing, rather than part of an answer', () => {
    // TURNS RED IF: a missing term is treated as zero, which makes the allowance
    // the other term alone and the margin wrong without saying so.
    expect(allowanceFor({ perBytePs: null, floorPs: 1 }, 10)).toBeNull();
    expect(allowanceFor({ perBytePs: 1, floorPs: null }, 10)).toBeNull();
    expect(allowanceFor({ perBytePs: 1, floorPs: 1 }, null)).toBeNull();
  });

  it('says the margin was not established rather than printing blanks for it', () => {
    /*
     * TURNS RED IF: an accepted cost with no numbers goes back to printing
     * "(not read)" in place of each one.
     *
     * It still PASSES, and should: what passed it is the chain's own call
     * accepting the transaction, not the numbers printed beside it. What it
     * must not do is read like a margin somebody measured.
     */
    const v = checkCost({ kind: 'within', numbers: { dismissPs: null, allowancePs: null, sizeBytes: 700 } });
    expect(v.passed).toBe(true);
    expect(v.line).toContain('THE MARGIN WAS NOT ESTABLISHED');
    expect(v.line).not.toContain('(not read) to dismiss');
  });
});

/* ------------------------------------------------------------------------- */

const passing = (): FundingReading => ({
  parameters: liveReading,
  cost: { kind: 'within', numbers: { dismissPs: 12_000_000_000, allowancePs: 15_000_000_000, sizeBytes: 700 } },
  intended: [
    { owner: 'new', value: 10n, purpose: 'ordinary' },
    { owner: 'new', value: 10n, purpose: 'exit' },
    { owner: 'new', value: 10n, purpose: 'spare for the new wallet' },
    { owner: 'old', value: 5n, purpose: 'the spare left behind' },
  ],
  built: [out('new', 10n), out('new', 10n), out('new', 10n), out('old', 5n)],
  coverage: { derivedFromThisTransaction: [reg('new')], alreadyRegisteredOnChain: ['old'] },
  oldWalletRegisteredOutputsAfter: 1,
  balancer: { kind: 'converged', feePayingSpends: 1 },
  feePayingSpendsExpected: 1,
});

/** One spoiler per check, each touching only what that check reads. */
const spoil: Record<number, (r: FundingReading) => FundingReading> = {
  1: (r) => ({ ...r, parameters: { ...liveReading, source: 'fallback', problem: 'no answer' } }),
  2: (r) => ({ ...r, cost: { kind: 'unreadable', message: 'not available' } }),
  // NOT the first output: a spoiler that only ever moves the first cannot tell a
  // check that looks at every output from one that looks at the first.
  3: (r) => ({ ...r, built: r.built.map((o, i) => (i === r.built.length - 1 ? { ...o, section: 'guaranteed' as const } : o)) }),
  4: (r) => ({ ...r, built: [...r.built, out('change', 3n)] }),
  5: (r) => ({ ...r, coverage: { derivedFromThisTransaction: [], alreadyRegisteredOnChain: ['old'] } }),
  6: (r) => ({ ...r, oldWalletRegisteredOutputsAfter: 0 }),
  7: (r) => ({ ...r, balancer: { kind: 'threw', message: 'it failed' } }),
};

describe('ALL SEVEN, AND NOT ONE OF THEM DECORATIVE', () => {
  it('answers all seven whatever the readings say, in a fixed order', () => {
    /*
     * TURNS RED IF: a check is dropped from the list, or the list is filtered
     * down to failures.
     *
     * A door that prints only what failed cannot show that a check ran, and a
     * check that quietly did not run looks exactly like one that passed. The
     * length is the only thing that makes the difference visible.
     */
    const v = fundingVerdicts(passing());
    expect(v).toHaveLength(7);
    expect(v.map((x) => x.check)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('lets a wholly sound plan through', () => {
    // TURNS RED IF: any check refuses the ordinary act, which would make the
    // door useless and invite somebody to route around it.
    const v = fundingVerdicts(passing());
    expect(v.filter((x) => !x.passed)).toEqual([]);
    expect(maySubmit(v)).toBe(true);
  });

  it('stops the submission when ANY ONE of the seven fails, one at a time', () => {
    /*
     * TURNS RED IF: any single check stops being able to stop a submission.
     *
     * Seven checks are seven claims that something is being prevented. A check
     * whose failure does not stop the door is a sentence rather than a guard,
     * and this project has shipped two assertions that could not fail inside a
     * fix for a defect whose entire cause was a test that could not fail.
     */
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const verdicts = fundingVerdicts(spoil[n]!(passing()));
      expect(verdicts.find((v) => v.check === n)!.passed).toBe(false);
      expect(maySubmit(verdicts)).toBe(false);
    }
  });

  it('refuses to submit on a list that is not EXACTLY seven, in either direction', () => {
    /*
     * TURNS RED IF: the length check is dropped, or loosened to "at least
     * seven".
     *
     * Short was asserted from the start. LONG WAS NOT, and loosening it
     * survived a mutation: a list longer than seven is one this module did not
     * produce, and a rule accepting more than it expects is accepting somebody
     * else's list.
     */
    const pass = (check: number) => ({ check, name: 'x', passed: true, line: '' });
    expect(maySubmit([pass(1)])).toBe(false);
    expect(maySubmit([])).toBe(false);
    expect(maySubmit([1, 2, 3, 4, 5, 6, 7].map(pass))).toBe(true);
    expect(maySubmit([1, 2, 3, 4, 5, 6, 7, 8].map(pass))).toBe(false);
  });
});

describe('WHAT THE NEW WALLET CAN PAY FOR, WHICH IS NOT A COUNT', () => {
  it('says NOT YET while the balance is short, and does not call the count a capability', () => {
    /*
     * TURNS RED IF: the count is reported as ability to pay.
     *
     * The count of registered outputs is the CEILING on dust spends in one
     * transaction. Dust accrues over time, and for roughly half a minute after
     * funding the wallet holds the outputs and not the balance.
     */
    const line = abilityToPay(0n, 1_000n, 3);
    expect(line).toContain('NOT YET');
    expect(line).toContain('at most 3 dust spends');
  });

  it('does not answer a question it was not given the fee for', () => {
    // TURNS RED IF: a missing fee is treated as zero, which would report every
    // wallet as able to pay.
    expect(abilityToPay(0n, null, 3)).toContain('is not answered');
  });

  it('states the balance against the fee once it is enough', () => {
    // TURNS RED IF: the sufficient case starts claiming readiness from the
    // count rather than from the balance.
    const line = abilityToPay(5_000n, 1_000n, 3);
    expect(line).not.toContain('NOT YET');
    expect(line).toContain('5000');
  });
});

/* ------------------------------------------------------------------------- */

/** A transaction shaped the way the ledger carries one: intents keyed by segment. */
const tx = (...intents: unknown[]) => ({ intents: new Map(intents.map((i, n) => [n + 1, i])) });
const offer = (outputs: unknown[], inputs: unknown[] = [], signatures: unknown[] = []) =>
  ({ outputs, inputs, signatures });
const o = (owner: string, value: bigint, type = 'night') => ({ owner, value, type });

describe('READING A BUILT TRANSACTION, WHICH IS THE ONLY THING THE DOOR TRUSTS', () => {
  it('finds NIGHT outputs in both halves and labels each with the half it is in', () => {
    // TURNS RED IF: a half stops being read, or both are given the same label.
    // Which half an output is in is the whole of check 3.
    const found = outputsOf(tx({
      guaranteedUnshieldedOffer: offer([o('a', 1n)]),
      fallibleUnshieldedOffer: offer([o('b', 2n)]),
    }), 'night');
    expect(found).toEqual([
      { owner: 'a', value: 1n, section: 'guaranteed' },
      { owner: 'b', value: 2n, section: 'fallible' },
    ]);
  });

  it('reads EVERY intent, not just the first', () => {
    // TURNS RED IF: only one intent is read. The balancing puts its fee-paying
    // intent in a segment of its own, so a transaction routinely has two.
    expect(outputsOf(tx(
      { fallibleUnshieldedOffer: offer([o('a', 1n)]) },
      { fallibleUnshieldedOffer: offer([o('b', 2n)]) },
    ), 'night')).toHaveLength(2);
  });

  it('ignores outputs of another token, and does not read the shielded offers', () => {
    /*
     * TURNS RED IF: the token filter goes, or the shielded offers come back.
     *
     * A transaction also carries `guaranteedOffer` and `fallibleOffer`. Those
     * are the shielded side and their outputs have no owner, type or value.
     * Reading them matched nothing and was a line standing on a wrong belief.
     */
    const t: any = tx({ fallibleUnshieldedOffer: offer([o('a', 1n), o('b', 2n, 'other')]) });
    t.guaranteedOffer = offer([o('shielded', 99n)]);
    t.fallibleOffer = offer([o('shielded', 98n)]);
    expect(outputsOf(t, 'night')).toEqual([{ owner: 'a', value: 1n, section: 'fallible' }]);
  });

  it('survives a transaction with no intents at all rather than throwing', () => {
    // TURNS RED IF: the absent case throws. A door that crashes here reports
    // nothing, and the checks are built to refuse an empty reading instead.
    expect(outputsOf({}, 'night')).toEqual([]);
    expect(outputsOf(undefined, 'night')).toEqual([]);
    expect(feePayingSpendsOf({})).toBe(0);
  });
});

describe('READING THE REGISTRATIONS, WHICH CARRY TWO ADDRESSES AND NOT ONE', () => {
  const derive = (k: unknown) => `owner-of-${String(k)}`;

  it('reads the owner AND the address the earnings would go to', () => {
    // TURNS RED IF: either field stops being read, or one is read out of the
    // other. They are separate fields and they can name different wallets.
    expect(registrationsOf(tx({ dustActions: { registrations: [{ nightKey: 'K', dustAddress: 42n }] } }), derive, '42'))
      .toEqual([{ owner: 'owner-of-K', dustReceiver: '42', expectedDustReceiver: '42' }]);
  });

  it('reads every registration on every intent', () => {
    // TURNS RED IF: only the first registration, or only the first intent, is
    // read. The check downstream refuses if ANY is misdirected, which it cannot
    // do if only one reaches it.
    expect(registrationsOf(tx(
      { dustActions: { registrations: [{ nightKey: 'A', dustAddress: 1n }, { nightKey: 'B', dustAddress: 2n }] } },
      { dustActions: { registrations: [{ nightKey: 'C', dustAddress: 3n }] } },
    ), derive, '1')).toHaveLength(3);
  });

  it('turns a MISSING delegation into null and not into a string saying so', () => {
    /*
     * TURNS RED IF: an absent address is stringified.
     *
     * The absent form is a deregistration. Stringified it becomes "undefined",
     * which is a value, compares unequal to the expected address and happens to
     * refuse for the wrong reason today - and would pass the moment anything
     * compared loosely. Null is the answer, and the check treats null as unread.
     */
    expect(registrationsOf(tx({ dustActions: { registrations: [{ nightKey: 'K' }] } }), derive, '1')[0]!.dustReceiver)
      .toBeNull();
    expect(registrationsOf(tx({ dustActions: { registrations: [{ nightKey: 'K', dustAddress: null }] } }), derive, '1')[0]!.dustReceiver)
      .toBeNull();
  });

  it('turns a key that will not derive into null rather than letting it throw', () => {
    // TURNS RED IF: the derivation is left unguarded. A throw here loses the
    // whole reading, and the check is built to refuse an underivable key.
    const angry = () => { throw new Error('not a key'); };
    expect(registrationsOf(tx({ dustActions: { registrations: [{ nightKey: 'K', dustAddress: 1n }] } }), angry, '1')[0]!.owner)
      .toBeNull();
  });

  it('stamps the expected destination on every entry, from one place', () => {
    // TURNS RED IF: the expectation is read off the transaction instead of
    // being supplied. Compared against itself it can never disagree.
    const found = registrationsOf(tx({ dustActions: { registrations: [{ nightKey: 'A', dustAddress: 1n }, { nightKey: 'B', dustAddress: 2n }] } }), derive, 'wanted');
    expect(found.map((r) => r.expectedDustReceiver)).toEqual(['wanted', 'wanted']);
  });
});

describe('THE FEE-PAYING SPENDS, AND WHAT HAS BEEN SIGNED', () => {
  it('sums the spends across every intent', () => {
    // TURNS RED IF: only one intent is counted. The balancing puts its spends
    // in an intent of its own, so counting the first finds none of them.
    expect(feePayingSpendsOf(tx(
      { dustActions: { spends: [1, 2] } },
      { dustActions: { spends: [3] } },
    ))).toBe(3);
  });

  it('counts the signatures against the inputs, and the registrations separately', () => {
    /*
     * TURNS RED IF: either count is dropped.
     *
     * TWO WALLETS SIGN THIS TRANSACTION. The inputs belong to the wallet
     * paying; the registration has to be signed by the key it registers, which
     * is the wallet being funded. One signer cannot make both signatures, so
     * counting only one of them cannot tell a half-signed transaction from a
     * finished one.
     */
    expect(signaturesOf(tx({
      fallibleUnshieldedOffer: offer([o('a', 1n)], ['in1', 'in2'], ['sig1']),
      dustActions: { registrations: [{ nightKey: 'K', signature: 's' }, { nightKey: 'J' }] },
    }))).toEqual({ inputs: 2, signatures: 1, registrations: 2, signedRegistrations: 1 });
  });

  it('counts signatures across EVERY intent, not just the first', () => {
    /*
     * TURNS RED IF: only one intent is read.
     *
     * THE ONE READER OF THE FIVE THAT HAD NO SUCH ASSERTION, AND THE ONE WHOSE
     * FAILURE NOTHING ELSE CATCHES - because this reading IS the check that
     * stands in for a signing step nobody can run. This transaction really does
     * carry two intents: the transfer in one and the fee-paying balancing in
     * another.
     */
    const t = { intents: new Map([
      [1, { fallibleUnshieldedOffer: offer([], ['in1'], ['sig1']) }],
      [2, { fallibleUnshieldedOffer: offer([], ['in2'], []) }],
    ]) };
    expect(signaturesOf(t)).toMatchObject({ inputs: 2, signatures: 1 });
  });

  it('reads nothing at all from a shape it does not understand, rather than half of it', () => {
    /*
     * TURNS RED IF: a shape other than the segment map starts being interpreted.
     *
     * Reading nothing is safe here and reading half is not: an empty list
     * reaches the section and registration checks, and both refuse on empty, so
     * an unrecognised shape becomes a refusal rather than a quiet zero.
     */
    expect(signaturesOf({ intents: [{ dustActions: { registrations: [{ signature: 's' }] } }] }))
      .toMatchObject({ registrations: 0 });
    expect(outputsOf({ intents: { 1: { fallibleUnshieldedOffer: offer([o('a', 1n)]) } } }, 'night')).toEqual([]);
  });

  it('does not count an absent registration signature as present', () => {
    // TURNS RED IF: the presence test is loosened to truthiness or to `in`.
    // An unsigned registration is refused by the chain, and this is the only
    // place the door can see that before it sends.
    expect(signaturesOf(tx({ dustActions: { registrations: [{ nightKey: 'K', signature: undefined }] } })).signedRegistrations).toBe(0);
    expect(signaturesOf(tx({ dustActions: { registrations: [{ nightKey: 'K', signature: null }] } })).signedRegistrations).toBe(0);
  });
});

describe('THE SPLIT, WHICH IS THREE LINES OF ARITHMETIC ABOUT ALL THE MONEY', () => {
  it('adds back to exactly what was there', () => {
    /*
     * TURNS RED IF: the remainder is dropped, or a share is rounded up.
     *
     * NIGHT that does not add up is refused by the chain rather than burnt, so
     * an error here costs the act and not the money. It costs it every time
     * until somebody finds it, and nothing was asserting it at all.
     */
    for (const total of [100n, 101n, 7n, 1_000_000_007n, 5_000_000_000n]) {
      const plan = planOutputs(total, 3, 'new', 'old')!;
      expect(plan.reduce((t, p) => t + p.value, 0n)).toBe(total);
    }
  });

  it('gives the new wallet the asked-for number of outputs and the old wallet one', () => {
    // TURNS RED IF: the count is off by one in either direction, which would
    // either short the new wallet or leave nothing behind.
    const plan = planOutputs(100n, 3, 'new', 'old')!;
    expect(plan.filter((p) => p.owner === 'new')).toHaveLength(3);
    expect(plan.filter((p) => p.owner === 'old')).toHaveLength(1);
  });

  it('puts the remainder with the OLD wallet, so the spare is never the smallest', () => {
    // TURNS RED IF: the remainder is put on one of the new wallet's outputs.
    // The output left behind is the only thing that can pay for a repair, and
    // it should not be the one that got the short share.
    const plan = planOutputs(103n, 3, 'new', 'old')!;
    const spare = plan.find((p) => p.owner === 'old')!;
    expect(spare.value).toBe(103n - 25n * 3n);
    expect(spare.value).toBeGreaterThanOrEqual(plan[0]!.value);
  });

  it('refuses rather than planning outputs of nothing', () => {
    // TURNS RED IF: a total too small to split produces zero-value outputs. An
    // output of nothing is not a spare and not a fee payer.
    expect(planOutputs(3n, 3, 'new', 'old')).toBeNull();
    expect(planOutputs(0n, 3, 'new', 'old')).toBeNull();
    expect(planOutputs(100n, 0, 'new', 'old')).toBeNull();
  });
});
