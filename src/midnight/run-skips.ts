/**
 * WHO WE ARE DELIBERATELY NOT PAYING, AND WHO DECIDED THAT. V-68.
 *
 * The case: ten people are paid monthly, two leave, and the run for the month
 * they left already exists and is approved. **Removing them costs nothing** —
 * payments are individual, so their leaves simply expire with the window. No
 * cancel, no re-approval, no transaction.
 *
 * The trap is not the payment. It is the report.
 *
 * **The chain records what was paid. It cannot record an intention not to
 * pay.** So a leaver who was skipped on purpose and an employee whose payment
 * failed four times are the same thing on chain: an unpaid leaf. On a
 * hundred-person run that is how somebody goes unpaid for a month without
 * anyone noticing — the operator sees three outstanding, assumes it is the two
 * leavers plus one, and stops looking.
 *
 * The intention is ours to hold. This file is where it is held.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS A LOG AND NOT A SET OF INDICES
 *
 * A set answers "is this person skipped". It cannot answer the questions that
 * actually get asked when somebody is unpaid at the end of the month: **who
 * decided, when, and did anybody change their mind.** A payroll decision with
 * no name on it is the kind of thing that is nobody's fault afterwards.
 *
 * So: append-only, latest decision per payee wins, nothing is ever edited or
 * removed. Un-skipping is a decision too and is recorded as one.
 *
 * ------------------------------------------------------------------------
 * WHERE IT LIVES
 *
 * Sealed under the account's `payroll` purpose key, exactly like the staff
 * list, so **every admin sees the same skips and nobody outside sees any of
 * them.** The same argument as V-63: a decision that lives on one operator's
 * machine is a decision the rest of the company cannot see, act on, or
 * challenge — and the person who made it is the one most likely to be away when
 * it matters.
 */
import { sealRecord, openRecord } from '../core/sealed-records.js';
import type { Sealed, Hex } from '../core/crypto.js';

/** One decision about one payee. Never edited; superseded by a later one. */
export interface SkipDecision {
  /** The payee's index in the run the register belongs to. */
  index: number;
  /** True to stop paying them, false to put them back in. */
  skip: boolean;
  /** The signer who decided. Not optional: an unattributed payroll decision is nobody's. */
  by: string;
  /** ISO 8601, from the deciding machine. Ordering within the log is what actually decides. */
  at: string;
  /**
   * Why, in the operator's words.
   *
   * Required for a skip and meaningless for an un-skip, which is why it is
   * checked rather than typed — a blank reason on a person who did not get paid
   * is the report saying "somebody decided something".
   */
  reason?: string;
}

export interface SkipRegister {
  /** The run these decisions are about. A register from another run is refused. */
  proposalId: Hex;
  /** How many payees the run has, so an index can be checked against something. */
  payees: number;
  decisions: SkipDecision[];
}

export const emptyRegister = (proposalId: Hex, payees: number): SkipRegister => {
  if (!Number.isInteger(payees) || payees < 1) {
    throw new Error(`a run has at least one payee; got ${payees}`);
  }
  return { proposalId, payees, decisions: [] };
};

/**
 * Records a decision, returning a new register.
 *
 * Validated here rather than at the edges, because this is the only way in and
 * a register that reached the store malformed would be discovered by a report
 * being wrong rather than by anything failing.
 */
export const decide = (register: SkipRegister, decision: SkipDecision): SkipRegister => {
  if (!Number.isInteger(decision.index)
      || decision.index < 0 || decision.index >= register.payees) {
    throw new Error(
      `this run has ${register.payees} payees; there is no payee ${decision.index}`);
  }
  if (!decision.by.trim()) throw new Error('a skip has to be attributable to somebody');
  if (decision.skip && !decision.reason?.trim()) {
    throw new Error('say why this person is not being paid; a blank reason is not a record');
  }
  if (Number.isNaN(Date.parse(decision.at))) {
    throw new Error(`"${decision.at}" is not a time`);
  }
  return { ...register, decisions: [...register.decisions, decision] };
};

/** The decision in force for each payee — the last one recorded about them. */
export const skippedIndices = (register: SkipRegister): number[] => {
  const current = new Map<number, SkipDecision>();
  for (const d of register.decisions) current.set(d.index, d);
  return [...current.entries()]
    .filter(([, d]) => d.skip)
    .map(([i]) => i)
    .sort((a, b) => a - b);
};

/** Why a payee is being skipped, and on whose say-so. What a report has to show. */
export const skipReasonFor = (
  register: SkipRegister, index: number,
): SkipDecision | undefined => {
  const inForce = [...register.decisions].reverse().find((d) => d.index === index);
  return inForce?.skip ? inForce : undefined;
};

/**
 * Refuses a register raised for a different run.
 *
 * The failure it prevents is quiet and expensive: last month's skips applied to
 * this month's run marks the wrong people as deliberately unpaid, and they are
 * the people nobody then looks at.
 *
 * **THE RUN'S IDENTITY IS AN ARGUMENT AND NEVER A DEFAULT, WHICH IS WHY IT IS
 * TYPED AS POSSIBLY ABSENT.** A caller that does not know which run it is
 * reporting on has to arrive here and be refused. Typed as always present, it
 * reaches instead for the nearest value that satisfies the type, and the
 * nearest value is this record's own id: the comparison below then holds a
 * value against itself, returns the record, and reports success having
 * compared nothing. That is not a weaker check than this one. It is no check,
 * wearing this one's clothes.
 *
 * **AND A BLANK ID IS ABSENT, NOT AN IDENTITY.** An id is a string, so the
 * empty one satisfies the type, and a record minted with the same nothing
 * compares equal to it - a comparison carrying no information again, reached by
 * a second route. Trimmed, on the same ground and by the same means `decide`
 * refuses an unattributed decision: a guard that cites that one and does not
 * trim is a space away from the hole it was written to close.
 */
export const registerFor = (
  register: SkipRegister, proposalId: Hex | undefined, payees: number,
): SkipRegister => {
  if (!proposalId?.trim()) {
    throw new Error(
      'these skips cannot be applied: they were decided about one particular run, and '
      + 'nothing here says which run is being reported on. Skips carried over from another '
      + 'run mark the wrong people as deliberately unpaid, and those are the people nobody '
      + 'then looks at. Identify the run these payees belong to, or ask for it without '
      + 'its skips.');
  }
  if (register.proposalId !== proposalId) {
    throw new Error(
      `those skips are for run ${register.proposalId}, not ${proposalId}`);
  }
  if (register.payees !== payees) {
    throw new Error(
      `those skips are for a run of ${register.payees}, and this run has ${payees}`);
  }
  return register;
};

/* Sealed under the account's payroll key: the same reach as the staff list,
 * because it says the same kind of thing about the same people. */
export const sealSkipRegister = (
  accountId: string, register: SkipRegister, viewingKey: Hex,
): Sealed => sealRecord('payroll', accountId, register, viewingKey);

export const openSkipRegister = (
  accountId: string, sealed: Sealed, viewingKey: Hex,
): SkipRegister => openRecord<SkipRegister>('payroll', accountId, sealed, viewingKey);
