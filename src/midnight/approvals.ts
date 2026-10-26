/**
 * HOW MANY APPROVALS A PROPOSAL HAS, SAID IN A WAY NOBODY MISREADS. V-66.
 *
 * `propose` counts the raiser's approval when the raiser may approve what they
 * raised: every governance proposal, and a run on a vault the raiser's rights
 * let them approve. So "A raises it, B and C approve" is three approvals from
 * three different signers, and the raiser cannot approve it a second time. A
 * run raised by a seat that may raise but not approve on that vault starts at
 * nought.
 *
 * Whichever it is, a count read without its threshold misleads: a screen
 * showing "2" while the operator believes they have three is a payroll that
 * silently does not run, discovered on payday. So nothing here ever prints an
 * approval count without the threshold beside it. A bare number is the bug.
 */

export interface ApprovalState {
  approvals: number;
  threshold: number;
}

/** Whether the proposal has what it needs. The only question that matters. */
export const isApproved = (s: ApprovalState): boolean => s.approvals >= s.threshold;

/** How many more people have to act. Never negative. */
export const stillNeeded = (s: ApprovalState): number =>
  Math.max(0, s.threshold - s.approvals);

/**
 * The ONE approved way to render an approval count.
 *
 * There is no variant that returns the number alone, deliberately. A helper
 * that could produce "2" would eventually be used to produce "2", and the
 * whole point is that "2" is the thing that misleads.
 */
export const describeApprovals = (s: ApprovalState): string => {
  if (s.threshold < 1) throw new Error('a threshold of zero would authorise anything');
  if (s.approvals < 0) throw new Error('an approval count cannot be negative');
  if (isApproved(s)) return `approved — ${s.approvals} of ${s.threshold}`;
  const need = stillNeeded(s);
  return `${s.approvals} of ${s.threshold} — ${need} more ${need === 1 ? 'approval' : 'approvals'} needed`;
};

/**
 * What a raiser has to be told the moment they raise something: whether their
 * own approval was counted, with the count and its threshold.
 *
 * Written here rather than in a screen because it is the same sentence on every
 * screen, and because a sentence that only exists in one component is a
 * sentence the next component forgets.
 */
export const proposerReminder = (s: ApprovalState): string =>
  s.approvals === 0
    ? `Raised, and not yet approved: your seat may not approve here. ${describeApprovals(s)}.`
    : `Raised, and your approval is counted. ${describeApprovals(s)}.`;
