/**
 * HOW MANY APPROVALS A PROPOSAL HAS, SAID IN A WAY NOBODY MISREADS. V-66.
 *
 * The defect this exists to prevent was found the best way available:
 * **somebody building this read it wrong.** Working an example, "A creates the
 * proposal, B and C approve" was offered as reaching a three-of-five
 * threshold. It reaches two. `propose` ends with the approval count at zero;
 * the proposer has drafted something, not endorsed it.
 *
 * If it reads that way to somebody building it, every customer will — Gnosis
 * Safe counts the creator's signature, and that is the model people arrive
 * with. A screen showing "2" while the operator believes they have three is a
 * payroll that silently does not run, discovered on payday.
 *
 * ------------------------------------------------------------------------
 * WHY THE FIX IS NOT "MAKE `propose` APPROVE"
 *
 * It was the obvious fix and it is wrong. Auto-approving the proposer quietly
 * turns a three-of-five into a two-of-five: the account would need two
 * deliberate judgements where its policy says three. **That is a security
 * change made for a user-interface convenience**, and the kind that is
 * impossible to spot afterwards because nothing about it looks like a change to
 * the threshold.
 *
 * So the chain keeps the stricter meaning and the client closes the gap: it
 * offers raising and approving as one action, and it never — anywhere — prints
 * an approval count without the threshold beside it. That second rule is what
 * this file is for. A bare number is the bug.
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
 * What a proposer has to be told the moment they raise something.
 *
 * Written here rather than in a screen because it is the same sentence on every
 * screen, and because a sentence that only exists in one component is a
 * sentence the next component forgets.
 */
export const proposerReminder = (s: ApprovalState): string =>
  s.approvals === 0
    ? `Raised, and NOT yet approved — including by you. ${describeApprovals(s)}.`
    : describeApprovals(s);
