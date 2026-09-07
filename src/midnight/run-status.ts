/**
 * WHO HAS BEEN PAID, ANSWERED BY THE CHAIN.
 *
 * A payroll run is paid one payee at a time, so at any moment some are paid and
 * some are not. **A run that reports "completed" while two people are unpaid is
 * worse than one that fails outright, because nobody goes looking.** The
 * standard: pay a hundred people, have three fail, and see exactly which three.
 *
 * WHY THIS READS THE CHAIN AND NOT OUR DATABASE. A status column we write is a
 * second record of a fact the chain already holds, and the two can disagree —
 * after a crash, a timeout whose result we never saw, or a transaction that
 * landed while our process was dying. The chain cannot disagree with itself.
 * That is the same rule the vault follows by keeping no replay record of its
 * own, applied to the view rather than the contract.
 *
 * **AND IT IS NOW THE ONLY ANSWER THERE IS.** V-61 removed the account's own
 * count of outstanding payees — it was a read-modify-write that serialised
 * every payment of a run — so completion is no longer a thing the chain asserts.
 * It is derived, here, from the payments the chain recorded. There is no
 * completion flag to disagree with, which is a stronger property than having
 * two sources that happen to agree.
 *
 * The one thing this needs from our side is the run's LEAVES, which are not
 * secret to the company and are not on chain — the tree only travels as a root.
 * A company that lost them can rebuild them from the payroll they approved.
 */
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import type { PaymentsAmong } from '../core/ledger.js';
import {
  skippedIndices, skipReasonFor, registerFor,
  type SkipRegister, type SkipDecision,
} from './run-skips.js';

/**
 * WHAT WE KNOW ABOUT ONE PAYEE OF ONE RUN.
 *
 * `paid` comes from the chain. `skipped` does not and cannot: the chain records
 * what happened, and a decision NOT to pay somebody leaves no trace on it. V-68.
 *
 * **That distinction is the difference between a leaver who was removed on
 * purpose and an employee whose payment failed four times.** Both are unpaid
 * leaves. On a hundred-person run, collapsing them is how somebody goes unpaid
 * for a month without anyone noticing — the operator sees three outstanding,
 * assumes they are the two leavers plus one, and stops looking.
 */
export interface PayeeStatus {
  /** Where they sit in the run — the index their merkle path proves. */
  index: number;
  leaf: Hex;
  /**
   * FOUR STATES, NOT TWO. V-68.
   *
   *   paid     the chain says so, and nothing overrides it
   *   skipped  a person decided not to pay them, and their name is on it
   *   failed   we tried and it did not go through
   *   unsent   nobody has tried yet
   *
   * The last two are the ones that must never merge with `skipped`. "Three
   * outstanding" reads as "the two leavers plus one" and the third person waits
   * a month.
   */
  state: 'paid' | 'skipped' | 'failed' | 'unsent';
  paid: boolean;
  skipped: boolean;
  /** Why they are being skipped and who said so. Present only when skipped. */
  skipDecision?: SkipDecision;
  /** What happened when we tried. Absent means nobody has. */
  attempts?: PayeeAttempts;
}

/** What our own submission history says about one payee. Never the chain's opinion. */
export interface PayeeAttempts {
  tries: number;
  /** The last refusal, verbatim. An operator cannot act on "it failed". */
  lastError?: string;
}

/** Whether a run may still be paid, judged against the block time. V-67. */
export type RunPhase = 'not started' | 'open' | 'closed';

export interface RunStatus {
  /**
   * Whether the leaves reported on were PROVED to be this proposal's. V-72.
   *
   * **False is not a warning, it is a disclaimer**, and the product must render
   * it as one. An unverified view is a list of payments that may belong to a
   * different run entirely — a stale payroll, an edited spreadsheet, last
   * month's file — and every "paid" and "outstanding" in it would be about
   * somebody else.
   */
  verified: boolean;
  paid: PayeeStatus[];
  /** Unpaid and not deliberately skipped — the ones somebody has to act on. */
  outstanding: PayeeStatus[];
  /** Unpaid on purpose. Not a problem, and must never be counted as one. */
  skipped: PayeeStatus[];
  /** Tried and refused. The ones an operator has to do something about first. */
  failed: PayeeStatus[];
  /**
   * Every payee accounted for — paid or deliberately skipped.
   *
   * DERIVED, never read from the chain, because the chain no longer holds an
   * opinion about it. See the note at the top of this file.
   */
  complete: boolean;
  phase: RunPhase;
  /**
   * True when the window has closed with people still owed. **The one state an
   * operator must not miss:** those payees need a fresh proposal, because
   * nothing can pay them from this run any more.
   */
  stranded: PayeeStatus[];
}

/** The subset of the account's ledger this needs. Narrow on purpose: a status
 *  view should not be able to touch anything. */
export interface ChainView {
  movements: { member(value: Uint8Array): boolean };
}

/** The run's approved window, in seconds since the Unix epoch. V-67. */
export interface RunWindow {
  from: bigint;
  until: bigint;
}

export interface RunInputs {
  /** The run's payout leaves, in the order the tree was built. */
  leaves: Hex[];
  /** The window the signers approved. */
  window: RunWindow;
  /**
   * WHAT PROVES THESE LEAVES ARE THE RUN'S. V-72.
   *
   * Until V-61 this view cross-checked its own count against the account's
   * count of outstanding payees, and shouted when they disagreed. That count is
   * gone — it serialised every payment of a run — and removing it took the
   * cross-check with it. **What replaced it is stronger:** rebuild the run's
   * root from the leaves in hand, recompute the proposal id the contract itself
   * would compute from that root, and require it to equal the id on chain.
   *
   * A count could only say "these are the wrong number of people". This says
   * "these are not that run", which is the question actually being asked.
   *
   * Optional, because a caller who genuinely has only the leaves can still get
   * a view — clearly marked `verified: false`.
   */
  proposal?: {
    /** The id the run is open under, read from the chain. */
    id: Hex;
    /**
     * The contract's own id derivation, composed by the caller and passed in —
     * never reimplemented here, the same rule `movementOf` follows. A second
     * derivation would produce a dashboard confidently wrong about which run it
     * is describing, which is the exact failure this exists to prevent.
     */
    idFrom: (leaves: Hex[], window: RunWindow) => Hex;
  };
  /**
   * The run's skip register — who we are deliberately not paying, and on whose
   * say-so. OURS, not the chain's; see `run-skips.ts`.
   *
   * Checked against this run before it is applied. Last month's skips silently
   * applied to this month's run mark the wrong people as deliberately unpaid,
   * and they are then the people nobody looks at.
   */
  skips?: SkipRegister;
  /** What our submissions did, per payee index. Absent for anyone never tried. */
  attempts?: Record<number, PayeeAttempts>;
}

/**
 * Reads a run's progress off the chain.
 *
 * @param inputs   the run's leaves, window, and any deliberate skips
 * @param chain    the account's ledger
 * @param movementOf the contract's own `paidMovementOf` circuit — passed in
 *   rather than imported so this file does not depend on generated code, and
 *   never reimplemented here, because a second derivation of it would produce a
 *   dashboard that is confidently wrong about who has their salary
 * @param now      seconds since the Unix epoch, to compare against the window
 *
 * NOTE THE MISSING ARGUMENT. This used to take the proposal id, because a
 * payment's record was the proposal and the leaf together. It is the leaf alone
 * now (V-64), which is what lets a retry run reuse a leaf and be safe — and it
 * means this view answers "has this payment been made" across every run at
 * once, rather than within one.
 */
export const runStatus = (
  inputs: RunInputs,
  chain: ChainView,
  movementOf: (leaf: Uint8Array) => Uint8Array,
  now: number | bigint = Math.floor(Date.now() / 1_000),
): RunStatus => {
  /*
   * Checked FIRST, and it throws rather than returning a flagged result.
   *
   * A caller who supplied a proposal id asked to be told. Handing them a
   * populated status object with `verified: false` buried in it would be an
   * answer about the wrong run, formatted to look like an answer about theirs.
   */
  let verified = false;
  if (inputs.proposal) {
    const rebuilt = inputs.proposal.idFrom(inputs.leaves, inputs.window);
    if (rebuilt !== inputs.proposal.id) {
      throw new Error(
        'these are not that run\'s payees: the proposal id rebuilt from these leaves is '
        + `${rebuilt}, and the run on chain is ${inputs.proposal.id}. `
        + 'Reporting on them would describe a different payroll.');
    }
    verified = true;
  }

  const register = inputs.skips
    ? registerFor(inputs.skips, inputs.proposal?.id ?? inputs.skips.proposalId,
                  inputs.leaves.length)
    : undefined;
  const skip = new Set(register ? skippedIndices(register) : []);

  const all: PayeeStatus[] = inputs.leaves.map((leaf, index) => {
    const isPaid = chain.movements.member(movementOf(fromHex(leaf)));
    /*
     * PAID WINS OVER EVERYTHING, and it is the one precedence that is not a
     * judgement call: somebody paid before the skip was decided has their
     * money, and reporting them as skipped would be a lie about a transaction
     * that exists on chain.
     */
    const isSkipped = !isPaid && skip.has(index);
    const attempts = inputs.attempts?.[index];
    const state: PayeeStatus['state'] = isPaid
      ? 'paid'
      : isSkipped ? 'skipped'
      : (attempts?.tries ?? 0) > 0 ? 'failed' : 'unsent';
    return {
      index,
      leaf,
      state,
      paid: isPaid,
      skipped: isSkipped,
      skipDecision: isSkipped && register ? skipReasonFor(register, index) : undefined,
      attempts,
    };
  });

  const paid = all.filter((p) => p.state === 'paid');
  const skipped = all.filter((p) => p.state === 'skipped');
  const failed = all.filter((p) => p.state === 'failed');
  const outstanding = all.filter((p) => p.state === 'failed' || p.state === 'unsent');

  const t = BigInt(now);
  const phase: RunPhase = t < inputs.window.from
    ? 'not started'
    : t < inputs.window.until ? 'open' : 'closed';

  return {
    verified,
    paid,
    outstanding,
    skipped,
    failed,
    complete: outstanding.length === 0,
    phase,
    stranded: phase === 'closed' ? outstanding : [],
  };
};

/**
 * The payees to attempt next.
 *
 * Deliberately the same list whether a run has never been started, was
 * interrupted, or is being retried after failures: **there is no "resume"
 * mode.** An operator retrying everything and an operator retrying nothing but
 * the failures issue the same instructions, because the account refuses a payee
 * who has already been paid. That is what makes the button safe to press twice.
 *
 * Returns nothing once the window has closed, because nothing can be paid then
 * and offering the attempt would be inviting a transaction that must fail.
 */
export const stillToPay = (status: RunStatus): number[] =>
  status.phase === 'closed' ? [] : status.outstanding.map((p) => p.index);

/** A line an operator can read, for the case where a number alone would mislead. */
export const describeRun = (status: RunStatus): string => {
  const total = status.paid.length + status.outstanding.length + status.skipped.length;
  const skipped = status.skipped.length > 0 ? `, ${status.skipped.length} skipped` : '';
  /* Said first, because everything after it is conditional on it. */
  const unverified = status.verified ? '' : 'UNVERIFIED against the proposal — ';

  if (status.stranded.length > 0) {
    return `${unverified}${status.paid.length} of ${total} paid${skipped} — the window has CLOSED with `
      + `${status.stranded.length} still owed. They need a new proposal; nothing can pay them `
      + `from this run.`;
  }
  if (status.complete) {
    /*
     * **BOTH BRANCHES CARRY THE DISCLAIMER, AND ONE OF THEM DID NOT.**
     *
     * The no-skips branch read `all ${total} paid` with no prefix, so the one
     * sentence that says *this list may describe a different payroll* was
     * dropped from the one case where nobody would go looking for it — the
     * reassuring one. Every other branch of this function carried it.
     *
     * That is the worst place to lose it. An unverified view is a list of
     * payments that may belong to a stale run, an edited spreadsheet, or last
     * month's file, and "all 12 paid" printed over the wrong run reads as a
     * finished payroll to the person whose job is to notice it is not.
     */
    return status.skipped.length > 0
      ? `${unverified}all ${status.paid.length} paid${skipped}`
      : `${unverified}all ${total} paid`;
  }
  if (status.phase === 'not started') {
    return `${unverified}not started — ${total} payees${skipped}, window opens later`;
  }
  /*
   * FAILED IS NAMED SEPARATELY FROM OUTSTANDING, always. An operator reading
   * "3 outstanding" fills the gap themselves — usually with "the leavers" —
   * and the person whose payment was refused four times waits another month.
   */
  const failed = status.failed.length > 0
    ? `, ${status.failed.length} FAILED and needing attention` : '';
  return `${unverified}${status.paid.length} of ${total} paid${skipped}${failed}, `
    + `${status.outstanding.length} outstanding`;
};


/**
 * **THE SAME VIEW, ASKED OF A LEDGER RATHER THAN OF A SET SOMEBODY ASSEMBLED.**
 *
 * `runStatus` above takes the chain's payment set and the contract's derivation
 * as arguments, because that is what makes it testable against the real
 * circuits without a chain anywhere near it. **A product screen has neither.**
 * It has a run, and a ledger that may or may not be able to say who was paid.
 *
 * This is the door between the two, and it lives beside `runStatus` rather than
 * in a module of its own for one reason: there is exactly one definition of
 * *who has been paid* in this product and it should stay countable on no
 * fingers.
 *
 * **WHAT IT ADDS THAT MATTERS, AND IT IS THE DISCRIMINANT AND NOT THE
 * CONVENIENCE.** A ledger that cannot answer and a ledger that answers *nobody*
 * are different facts, and a screen holding a `RunStatus` cannot tell them
 * apart — every payee reads `unsent` either way. So the answer is a union, and
 * a caller has to branch on `answered` before it can reach a single count.
 * **A screen cannot print "0 of 100 paid" over an unanswered question, because
 * there is no field to print it from.**
 */
export type RunPayments =
  /**
   * **NOTHING HERE IS ABOUT PEOPLE.** The question was not answered, and
   * `why` is the sentence saying so in words an operator can act on.
   */
  | { readonly answered: false; readonly payees: number; readonly why: string }
  /** The question was answered, and `status` is about these people. */
  | { readonly answered: true; readonly status: RunStatus; readonly sentence: string };

/**
 * Reads a run's progress from a ledger's answer about its own payees.
 *
 * @param inputs the run's leaves, window and any deliberate skips — from the
 *   company's own record, because the tree travels to the chain as a root and
 *   the leaves never do
 * @param among  what the ledger said about exactly those leaves, or `null` when
 *   the ledger does not hold this account at all
 */
export const runPayments = (
  inputs: RunInputs | null,
  among: PaymentsAmong | null,
  now: number | bigint = Math.floor(Date.now() / 1_000),
): RunPayments => {
  /*
   * **A RUN WITH NO PAYOUT MATERIAL IS REFUSED HERE AND NOT REPORTED ON.**
   *
   * `runStatus` over an empty list is internally consistent and externally a
   * lie: no payee is outstanding, so `complete` is true, and `describeRun`
   * prints "all 0 paid" for a run nobody has been paid from.
   *
   * **NULLABLE RATHER THAN AN EMPTY SHAPE, so a caller that has no material has
   * to say so out loud.** The alternative asks it to invent a window and a leaf
   * list to fill the type with, and a fabricated window is a number nothing
   * measured sitting in the input of a view about money. The empty list is
   * refused too, for a caller that assembles one from a record that turns out
   * to hold nothing.
   */
  if (inputs === null || inputs.leaves.length === 0) {
    return {
      answered: false,
      payees: 0,
      why: 'this run has no payout leaves on record, so there is nothing to check against '
        + 'the payments the account holds. The leaves are not secret and are not on chain — '
        + 'the run reaches the chain as a single root — so they live with the run here, and '
        + 'a run raised without them cannot be reported on. They can be rebuilt from the '
        + 'payroll that was approved.',
    };
  }

  if (among === null) {
    return {
      answered: false,
      payees: inputs.leaves.length,
      why: 'this account is not on the ledger this service is wired to, so nothing can be '
        + 'said about who has been paid.',
    };
  }

  if (!among.known) {
    return {
      answered: false,
      payees: inputs.leaves.length,
      why: 'the ledger this service is wired to does not record payments, so it cannot say '
        + 'who has been paid. This is not a statement that nobody has been: it is that '
        + 'nobody here can tell you either way.',
    };
  }

  /*
   * **THE ANSWER MUST BE ABOUT THIS RUN'S PAYEES, CHECKED AND NOT ASSUMED.**
   *
   * The ledger derives the recorded value from each leaf and answers with the
   * LEAVES that matched, so what comes back is a subset of what went out. The
   * composition below depends on that and would still typecheck if it stopped
   * being true — a boundary that started answering with the derived values
   * instead would produce a view in which nobody had ever been paid, silently,
   * with every count present and every one of them zero.
   *
   * So it is checked. A value that is not one of this run's leaves means the
   * answer is about something else, and an answer about something else is not
   * an answer.
   *
   * **WHAT THIS DOES NOT COVER, SAID HERE SO NOBODY READS IT AS MORE THAN IT
   * IS.** It checks where the answer came from and never whether it is right.
   * A ledger returning the WRONG SUBSET of the right leaves passes it
   * completely — the inverted test that reports the paid as unpaid, and the
   * over-generous one that reports everybody paid. The second of those is the
   * direction that costs somebody their salary, and nothing on this side of
   * the boundary can see it. It is held where the set is read, and by the
   * tests over that reader, not here.
   */
  const asked = new Set(inputs.leaves);
  for (const leaf of among.paid) {
    if (!asked.has(leaf)) {
      throw new Error(
        'the ledger answered with a payment that is not one of this run\'s payees, so this '
        + 'view would be describing something other than this run. Nothing is being reported.');
    }
  }

  /*
   * **BOTH SIDES ARE SPELLED THE SAME WAY BEFORE EITHER IS COMPARED.**
   *
   * The comparison below is between a string the ledger returned and a string
   * this function derives by taking a leaf apart and putting it back together.
   * Those agree only while every leaf is spelled in the one casing the
   * round-trip produces, and a leaf that arrives spelled any other way would
   * match nothing — reporting a paid person as never attempted, silently and
   * for every payee at once. Normalising both ends removes the assumption
   * rather than documenting it.
   */
  const spelling = (h: Hex) => toHex(fromHex(h));
  const paid = new Set(among.paid.map(spelling));
  /*
   * **THE IDENTITY, AND IT IS NOT A SHORTCUT.** `runStatus` composes
   * `movements.member(movementOf(leaf))`, and the ledger has already done both
   * halves: it applied the contract's own derivation and tested the set. What
   * is left for this side is the leaf it asked about, so the derivation here is
   * the one that does nothing — rather than a second spelling of a rule the
   * contract owns, which is the mistake `movementOf` exists to make impossible.
   */
  const alreadyDerived = (leaf: Uint8Array) => leaf;
  const chain: ChainView = { movements: { member: (v) => paid.has(toHex(v)) } };

  const status = runStatus(inputs, chain, alreadyDerived, now);
  return { answered: true, status, sentence: describeRun(status) };
};
