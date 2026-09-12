/**
 * THE FEE FLOOR, AND WHETHER THE COMPONENT THAT DECIDES EVER RECEIVED IT.
 *
 * ── WHY THIS FILE IS SEPARATE ────────────────────────────────────────────────
 *
 * The wallet install lives behind a door nobody may run by hand, so the rules
 * that decide whether the floor took effect are kept here, where a test can
 * reach them without a wallet, a network or a submission.
 *
 * ── WHAT WENT WRONG, AND IT WAS THE INSTRUMENT ──────────────────────────────
 *
 * The fee floor is set in one place and printed in three, and all four read the
 * same constant: the value we PASSED. A message built that way says the floor
 * is in force whether or not it is, which is the worst shape a money instrument
 * can have, because it prints a failure as a success.
 *
 * It also made a wrong reading look right. The wallet library logs
 * `Creating dust wallet with params: {... "additionalFeeOverhead":"0" ...}`
 * while building its OWN dust sub-wallet from its defaults, BEFORE ours is
 * constructed and swapped in. That line is about a different object and is not
 * evidence about the floor at all, but set beside a message that only ever
 * prints the constant, it reads as a contradiction and invites the conclusion
 * that our value is being dropped.
 *
 * ── SO THERE ARE TWO READINGS AND NEITHER IS THE CONSTANT ───────────────────
 *
 * (a) ARRIVED. Read back off the dust wallet the facade actually holds, through
 *     the facade's own field, after the swap. It answers: is the object that
 *     will be asked for a fee configured by us, or is it still the library's
 *     default? That is the question the swap can silently lose.
 *
 * (b) APPLIED. The overhead the fee arithmetic actually adds, measured as
 *     `calculateFee(tx) - tx.feesWithMargin(params, margin)` on a throwaway
 *     transaction. The fee is defined as the sum of those two terms, so the
 *     difference IS the overhead in force. It answers the question a field read
 *     cannot: that the number is not merely stored but spent.
 *
 * A reading is worth having only if it can disagree with the constant, so the
 * caller refuses when any two of the three disagree, and says which.
 */

/** The three numbers, kept apart so a disagreement between them is visible. */
export type FeeFloorReading = {
  /** The value this project asked for. */
  passed: bigint;
  /** What the installed wallet's own configuration carries, or null if unreadable. */
  arrived: bigint | null;
  /** What the fee arithmetic added, or null if it could not be measured here. */
  applied: bigint | null;
  /** Why a reading is null, when one is. */
  problem?: string;
};

/**
 * Why the verdict came out the way it did.
 *
 * **THE CALLER SWITCHES ON THIS AND NEVER RE-DERIVES IT.** A gate that looks at
 * the readings again to work out what the verdict meant is a second
 * implementation of this function, and the two drift: the first version of that
 * gate asked `arrived !== null`, which let a floor of ZERO through on a wallet
 * whose parameters could not be read back — the one case the zero check exists
 * to catch.
 */
export type FeeFloorReason =
  /** In force. */
  | 'ok'
  /** The floor is set to nothing, so it is not a floor. Known bad. */
  | 'not-a-floor'
  /** The wallet carries a different floor from the one asked for. Known bad. */
  | 'disagrees'
  /** Stored but not added by the arithmetic. Known bad. */
  | 'not-applied'
  /** Could not be read back at all. NOT known bad: unknown. */
  | 'unreadable';

export type FeeFloorVerdict = {
  /** False means the floor is not known to be in force. */
  ok: boolean;
  /** One line, in terms someone can act on. */
  line: string;
  /** Which case this is, for a caller that must decide whether to stop. */
  reason: FeeFloorReason;
};

/**
 * Whether the floor is KNOWN to be absent, as opposed to merely unverified.
 *
 * The distinction decides whether a money door stops. A floor known to be wrong
 * is a defect that no re-run clears and the door must not submit on it. A floor
 * nobody could read is a measurement that failed, and stopping every money door
 * in this project because a library renamed a field would be a worse failure
 * than the one it prevents.
 */
export const floorKnownAbsent = (reason: FeeFloorReason): boolean =>
  reason === 'not-a-floor' || reason === 'disagrees' || reason === 'not-applied';

const n = (v: bigint | null) => (v === null ? 'unreadable' : String(v));

/**
 * Whether the floor is in force, from the readings alone.
 *
 * Pure. No wallet, no network, no clock.
 *
 * `applied` is allowed to be null: it needs a ledger to measure and the caller
 * may not have one. `arrived` is not, because a floor that cannot be read back
 * off the object that will be charged is a floor nobody can vouch for.
 */
export function feeFloorVerdict(r: FeeFloorReading): FeeFloorVerdict {
  /*
   * A FLOOR OF NOTHING IS NOT A FLOOR, AND IT IS REACHABLE FROM THE ENVIRONMENT.
   *
   * The floor is overridable, and an override of `0` is a string that reads as
   * present and converts to nothing. All three numbers then agree at zero and
   * every other check here passes, which would print the confident sentence
   * about a wallet that has exactly the defect the floor exists to prevent: a
   * fee of nothing selects no dust coin, the transaction carries no dust spend,
   * and the node refuses it as malformed. Agreement at zero is the one
   * agreement that must not pass.
   */
  if (r.passed <= 0n) {
    return {
      ok: false,
      reason: 'not-a-floor',
      line:
        `the fee floor is set to ${r.passed}, which is not a floor. A fee that can come out at ` +
        'nothing selects no dust coin, and a transaction carrying no dust spend is refused as ' +
        'malformed. Set it to a positive number of specks, or leave it unset for the default.',
    };
  }
  if (r.arrived === null) {
    return {
      ok: false,
      reason: 'unreadable',
      line:
        `the fee floor could not be read back off the wallet that will pay ` +
        `(asked for ${r.passed})${r.problem ? `: ${r.problem}` : ''}. ` +
        'Nothing here can say what fee this run would offer, so it stops rather than guess.',
    };
  }
  if (r.arrived !== r.passed) {
    return {
      ok: false,
      reason: 'disagrees',
      line:
        `the fee floor did not reach the wallet: asked for ${r.passed}, the wallet carries ` +
        `${r.arrived}. A zero floor lets a fee come out at zero, and a transaction that owes ` +
        'nothing carries no dust spend and is refused as malformed.',
    };
  }
  if (r.applied !== null && r.applied !== r.arrived) {
    return {
      ok: false,
      reason: 'not-applied',
      line:
        `the wallet carries a fee floor of ${r.arrived} and its fee arithmetic added ` +
        `${n(r.applied)}. The number is stored but not spent, so the floor is not in force.`,
    };
  }
  return {
    ok: true,
    reason: 'ok',
    line:
      `fee floor ${r.arrived}, read back off the wallet that will pay` +
      (r.applied === null
        ? ' (its effect on a fee was not measured here)'
        : `, and its fee arithmetic adds exactly ${r.applied}`),
  };
}

/**
 * The overhead the installed wallet's own configuration carries.
 *
 * Reads through the object the facade holds, so it answers for the wallet that
 * will be charged rather than for the configuration this project composed. A
 * swap that silently did not take reads the library's default here.
 */
export function arrivedOverhead(dustWallet: unknown): { value: bigint | null; problem?: string } {
  try {
    const cfg = (dustWallet as any)?.constructor?.configuration?.costParameters;
    if (!cfg) return { value: null, problem: 'the wallet exposes no cost parameters' };
    const v = cfg.additionalFeeOverhead;
    if (typeof v !== 'bigint') {
      return { value: null, problem: `additionalFeeOverhead is ${typeof v}, not a bigint` };
    }
    return { value: v };
  } catch (e: any) {
    return { value: null, problem: String(e?.message ?? e).slice(0, 120) };
  }
}

/** What `appliedOverhead` needs, injected so the rule can be tested without the SDK. */
export type AppliedOverheadDeps = {
  /** Builds a transacting capability from a dust wallet configuration. */
  makeTransacting: (config: any, getContext: () => any) => { calculateFee: (tx: any, params: any) => bigint };
  /** An empty transaction to measure against. */
  newTransaction: () => { feesWithMargin: (params: any, margin: number) => bigint };
  /** The parameters both sides of the subtraction are taken at. */
  params: () => any;
};

/**
 * The overhead the fee arithmetic actually adds.
 *
 * Both terms are taken on the SAME transaction and the SAME parameters, so
 * everything except the overhead cancels. The transaction is a throwaway and is
 * never proved, signed, balanced or submitted; it exists to be measured.
 */
export function appliedOverhead(
  costParameters: unknown,
  deps: AppliedOverheadDeps,
): { value: bigint | null; problem?: string } {
  try {
    const margin = Number((costParameters as any)?.feeBlocksMargin ?? 0);
    const params = deps.params();
    const tx = deps.newTransaction();
    const cap = deps.makeTransacting({ costParameters }, () => ({}));
    const withFloor = cap.calculateFee(tx as any, params);
    const bare = tx.feesWithMargin(params, margin);
    return { value: withFloor - bare };
  } catch (e: any) {
    return { value: null, problem: String(e?.message ?? e).slice(0, 120) };
  }
}
