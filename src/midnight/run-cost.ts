/**
 * HOW MANY TRANSACTIONS A PAYROLL RUN COSTS. V-73.
 *
 * Not an estimate and not a fee: a COUNT of circuit calls, which is what every
 * DUST gate in this repo is really budgeting against.
 *
 * WHY IT IS A FUNCTION AND NOT A NUMBER. `run-preview.ts` budgeted 11 calls for
 * a run that submits 14 (M-137). It passed the gate and would have run out of
 * DUST on the twelfth call — **the exact failure the gate exists to prevent**,
 * produced by a hand-counted constant that stopped matching the script beside
 * it. A payroll run makes that inevitable rather than unlucky: the count is not
 * a property of the code at all, it is a property of how many people are being
 * paid, and no constant can be right for both a five-person company and a
 * two-hundred-person one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: convert to DUST. The fee per circuit varies
 * by chain and by circuit and is measured at run time through
 * `estimateRegistration`. Multiplying is the caller's job; getting the count
 * right is this file's.
 *
 * **AND NOTHING IN THE PRODUCT CALLS THIS FILE YET, WHICH IS STATED HERE
 * RATHER THAN LEFT TO BE FOUND.** `T-344`, `SC13` §4 `F5`, `S58`. Its only
 * importer is its own test. **`scripts/run-preview.ts` still carries
 * `const CIRCUITS = 13` behind four `.command` doors, and that is not a missed
 * wiring:** its thirteen counts a fixed scripted walk — two governance rounds
 * with an `amendSigner` each, a payment round, and a job section ending in a
 * `cancel` — and this function has no term for an `amendSigner` or a `cancel`.
 * **They take different inputs and model different things, so substituting one
 * for the other would produce a wrong number, not a derived one.**
 *
 * **THE HONEST STATEMENT OF THE GAP:** what this file demonstrates is that the
 * count is a property of the payroll and not of the code, and the file the
 * doors actually run has not been given the same treatment for the shape IT
 * counts. Closing that needs a second cost function, not a call to this one.
 */

export interface RunCostInput {
  /** How many people the run pays. */
  payees: number;
  /** How many approvals the run needs — the account's threshold, or the vault's. */
  threshold: number;
  /**
   * Payments expected to need a second attempt.
   *
   * **Budget for some.** A run that pays 99 of 100 and cannot afford the
   * hundredth has failed at the only thing it was for, and the person who is
   * unpaid is the one the shortfall picked at random.
   */
  retries?: number;
}

export interface RunCost {
  /** Each named step and how many calls it is. Itemised so a wrong total is visible. */
  items: Array<{ what: string; calls: number }>;
  total: number;
}

/**
 * The calls a run makes, from raising it to sweeping it.
 *
 * `closeExpiredRun` is counted even though anybody may call it and nothing
 * breaks if nobody does. A budget that assumes somebody else will tidy up is a
 * budget that is short whenever they do not.
 */
export const circuitsForRun = (input: RunCostInput): RunCost => {
  const { payees, threshold } = input;
  if (!Number.isInteger(payees) || payees < 1) {
    throw new Error(`a run pays at least one person; got ${payees}`);
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`a threshold is at least one; got ${threshold}`);
  }
  const retries = input.retries ?? 0;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error(`retries cannot be negative; got ${retries}`);
  }

  const items = [
    { what: 'proposeRun', calls: 1 },
    /*
     * The approval round, and the proposer's own approval is inside it rather
     * than beside it: `propose` leaves the count at zero (V-66), so reaching a
     * threshold of three genuinely costs three approvals whoever they come
     * from. `proposerApproves` would be a second way to say the same thing and
     * a second way to get it wrong.
     */
    { what: 'approvals', calls: threshold },
    { what: 'payments', calls: payees },
    { what: 'retried payments', calls: retries },
    { what: 'closeExpiredRun', calls: 1 },
  ].filter((i) => i.calls > 0);

  return { items, total: items.reduce((n, i) => n + i.calls, 0) };
};

/**
 * A RETRY RUN for the people a run did not reach, which is a whole second run.
 *
 * Worth its own name because the cheap intuition — "it is only the stragglers"
 * — misses that a retry needs its own proposal and its own full approval round.
 * Ten stragglers on a three-of-five account is fourteen calls, not ten.
 */
export const circuitsForRetry = (outstanding: number, threshold: number): RunCost =>
  circuitsForRun({ payees: outstanding, threshold });

/** A sentence for an operator, because a number alone invites the wrong guess. */
export const describeRunCost = (cost: RunCost): string =>
  `${cost.total} transactions — ` + cost.items.map((i) => `${i.calls} ${i.what}`).join(', ');
