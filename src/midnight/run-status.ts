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
import { fromHex, type Hex } from '../core/crypto.js';
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
    return status.skipped.length > 0
      ? `${unverified}all ${status.paid.length} paid${skipped}`
      : `all ${total} paid`;
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
