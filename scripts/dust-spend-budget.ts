/**
 * HOW MANY DUST SPENDS THIS WALLET CAN EMIT, AND WHY THAT IS A CEILING RATHER
 * THAN A SETTING.
 *
 * ── THE REFUSAL THIS EXISTS TO EXPLAIN ───────────────────────────────────────
 *
 * A deposit can be refused at submission for being too CHEAP relative to its
 * size: the allowance a transaction gets is a function of how big it is, and
 * below a knee it is a flat minimum. A transaction that sits just under that
 * knee is judged against the flat allowance and loses.
 *
 * The remedy is counter-intuitive and it is the only one that pays: make the
 * transaction BIGGER by adding another dust spend. Bytes on their own are not
 * addable — every byte belongs to an item and there is no free-bytes field —
 * and of the items that can be added, an extra unshielded input or output costs
 * far more per byte than the allowance grants per byte and makes the refusal
 * worse. An extra dust spend costs less per byte than the allowance grants, so
 * it is the one lever that moves the comparison the right way.
 *
 * ── WHY IT IS A PRECONDITION AND NOT A KNOB ─────────────────────────────────
 *
 * Spending a dust UTXO marks it pending and does NOT put the successor it
 * creates back where the same transaction can reach it, so each dust spend in a
 * transaction consumes a DISTINCT dust UTXO. A dust UTXO is minted per
 * registered NIGHT UTXO. So the number of dust spends a wallet can emit is the
 * number of NIGHT UTXOs it holds that are registered for dust generation.
 *
 * **A WALLET HOLDING ONE REGISTERED NIGHT UTXO CAN EMIT EXACTLY ONE DUST SPEND,
 * AND THIS WAY OUT DOES NOT EXIST FOR IT AT ANY PRICE.** Consolidation is the
 * normal end state of a wallet that has been used, so this is a failure that
 * arrives with time rather than with a change, and the chain does not explain
 * itself when it happens: the submission is refused and the reason is a code.
 *
 * This module turns that into a sentence before the run spends the minutes of
 * proving on its way to the same refusal.
 */

/**
 * The dust spends an ordinary deposit carries: one.
 *
 * It comes from the fee having to be PAID, not from the well-formedness rule
 * that refuses dust actions with no spend and no registration — that rule takes
 * either, so a registration-only transaction satisfies it. A deposit that pays
 * its own fee out of dust spends one dust UTXO to do it.
 */
export const SPENDS_AN_ORDINARY_DEPOSIT_CARRIES = 1;

/**
 * ── WHY THE ESCAPE COSTS EXACTLY ONE MORE, WITH THE ARITHMETIC RATHER THAN A
 *    NARRATIVE ────────────────────────────────────────────────────────────────
 *
 * The allowance is `max(time_to_dismiss_per_byte x size, min_time_to_dismiss)`,
 * so below the knee it is flat and adding bytes buys nothing; above it, every
 * byte buys more allowance than an extra dust spend costs. The measured inputs,
 * and the reason one extra spend is enough:
 */
export type EscapeArithmetic = {
  readonly refusedSizeBytes: number;
  readonly refusedCostMs: number;
  readonly allowanceMsPerByte: number;
  readonly minAllowanceMs: number;
  readonly bytesPerExtraSpend: number;
  readonly costMsPerExtraSpend: number;
};

export const ESCAPE_ARITHMETIC: EscapeArithmetic = {
  /** The refused transaction, from the node's own sentence. */
  refusedSizeBytes: 7_088,
  /** Its dismiss cost, from the same sentence, in milliseconds. */
  refusedCostMs: 15.038,
  /** Allowance granted per byte above the knee, in milliseconds. */
  allowanceMsPerByte: 0.002,
  /** The flat allowance below the knee, in milliseconds. */
  minAllowanceMs: 15,
  /** What one more dust spend adds to the transaction. */
  bytesPerExtraSpend: 3_002,
  /** And what it adds to the dismiss cost, in milliseconds. */
  costMsPerExtraSpend: 2.652,
};

/** Whether `extra` additional dust spends would clear the refusal. Pure. */
export function escapeClearsRefusal(extra: number, a: EscapeArithmetic = ESCAPE_ARITHMETIC): boolean {
  const size = a.refusedSizeBytes + extra * a.bytesPerExtraSpend;
  const cost = a.refusedCostMs + extra * a.costMsPerExtraSpend;
  return cost <= Math.max(a.allowanceMsPerByte * size, a.minAllowanceMs);
}

/**
 * What the only known way past a refusal for being too cheap relative to size
 * costs, in dust spends. **A wallet that cannot reach this number cannot take
 * that way out at any price**, which is why this rather than the ordinary
 * number is what the budget is measured against.
 *
 * It is DERIVED, not typed: the smallest number of extra spends for which
 * `escapeClearsRefusal` is true, plus the one an ordinary deposit already
 * carries. If the circuit gets cheaper, the knee moves, or the per-byte
 * allowance changes, this moves with them instead of staying at two.
 */
export const SPENDS_TO_ESCAPE_A_SIZE_REFUSAL = (() => {
  for (let extra = 1; extra <= 64; extra++) {
    if (escapeClearsRefusal(extra)) return SPENDS_AN_ORDINARY_DEPOSIT_CARRIES + extra;
  }
  return SPENDS_AN_ORDINARY_DEPOSIT_CARRIES + 64;
})();

export type DustSpendBudget = {
  /** Distinct unspent NIGHT UTXOs the fee payer holds. */
  nightUtxos: number;
  /** Of those, the ones registered for DUST generation: one dust UTXO each. */
  registered: number;
  /**
   * How many dust spends are needed for the way past a size-versus-cost
   * refusal to exist. Not a guess about this deposit: it is
   * `SPENDS_TO_ESCAPE_A_SIZE_REFUSAL`, and the caller passes that constant
   * rather than a number of its own.
   */
  needed: number;
};

export type BudgetVerdict = {
  /** False means the known way past a size-versus-cost refusal is unavailable here. */
  ok: boolean;
  /** One line, in terms someone can act on. */
  line: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
};

/** A UTXO as the wallet reports it, narrowed to the two fields that decide this. */
export type HeldUtxo = {
  utxo?: { type?: unknown; value?: unknown };
  meta?: { registeredForDustGeneration?: unknown };
};

/**
 * Counts the fee payer's NIGHT UTXOs and how many can mint a dust spend.
 *
 * Pure and total: anything it cannot read counts as not present, because a
 * count that guesses high turns this check into one that passes when it should
 * not, and that is the failure the check exists to prevent.
 */
export function budgetFrom(coins: readonly HeldUtxo[] | undefined, nightRaw: string, needed: number): DustSpendBudget {
  const held = Array.isArray(coins) ? coins : [];
  const night = held.filter(c => String(c?.utxo?.type ?? '') === nightRaw);
  const registered = night.filter(c => c?.meta?.registeredForDustGeneration === true);
  return { nightUtxos: night.length, registered: registered.length, needed };
}

/**
 * Whether the wallet can reach the only known way past the refusal.
 *
 * Pure. The sentence names both numbers, because "it will not work" without
 * them is a sentence nobody can act on.
 */
export function budgetVerdict(b: DustSpendBudget): BudgetVerdict {
  const s = (n: number) => (n === 1 ? '' : 's');
  const held =
    `this wallet holds ${b.nightUtxos} spendable NIGHT output${s(b.nightUtxos)}, ` +
    `${b.registered} of them registered for DUST generation, so it can put at most ` +
    `${b.registered} dust spend${s(b.registered)} in one transaction`;

  /*
   * AT MOST, AND THE WORDS MATTER. This counts UTXOs, not the dust on them. A
   * registered NIGHT output whose dust has not generated enough to cover its
   * share buys no usable spend, and that failure appears inside the balancer
   * rather than here. So a pass means the ceiling is not what stops this run,
   * never that the run will work.
   */

  if (b.registered >= b.needed) {
    return {
      ok: true,
      line:
        `${held}; the way past a refusal for being too cheap needs ${b.needed}, so the ceiling ` +
        'is not what would stop it. Whether each of those outputs has generated enough dust to ' +
        'be spendable is a separate question this does not answer.',
    };
  }
  return {
    ok: false,
    line: `${held}; the way past a refusal for being too cheap needs ${b.needed}`,
    remedy:
      'The only known way past a refusal for being too cheap relative to size needs more ' +
      `dust spends than this wallet can emit. It cannot be reached by changing anything in ` +
      'this project: it needs the fee payer to hold more registered NIGHT outputs than it ' +
      'does, which means splitting the one it has into several and registering them, in a ' +
      'separate transaction that carries its own fee and its own risk of the same refusal.',
  };
}
