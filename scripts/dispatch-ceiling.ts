/**
 * THE PER-EXTRINSIC CEILING, DERIVED — NEVER HELD AS A LITERAL.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * Both instruments held `const NORMAL_DISPATCH_RATIO = 0.75`, cited to
 * `runtime/src/lib.rs:307` — a real line, correctly read, and not the number
 * that decides. On 28 Aug a thirteen-circuit deploy at bytesWritten 35,748
 * (71.5% of 50,000, UNDER the 37,500 "75% ceiling") was refused with
 * `1010: Transaction would exhaust the block limits`, ninety minutes after an
 * eleven-circuit deploy at 31,201 (62.4%) was accepted. The 75% number is the
 * NORMAL CLASS's per-BLOCK budget; a single extrinsic is judged against a
 * smaller number that the same helper derives two lines further down.
 *
 * THE RULE: an instrument may not hold a limit as a literal. It
 * derives it, prints the derivation, and names what it could not derive.
 *
 * ── THE DERIVATION, from the node's own source ───────────────────────────────
 *
 * All line numbers verified 28 Aug 2026 against the sources named:
 *
 *  1. `midnight-node` `runtime/src/lib.rs:308` — `NORMAL_DISPATCH_RATIO =
 *     Perbill::from_percent(75)`; `:316-318` builds the runtime's
 *     `BlockWeights` with `with_sensible_defaults(Weight::from_parts(
 *     2u64 * WEIGHT_REF_TIME_PER_SECOND, u64::MAX), NORMAL_DISPATCH_RATIO)` —
 *     a 2-second (2×10¹² picosecond) ref_time block.
 *  2. `polkadot-sdk@polkadot-stable2606` (the tag `midnight-node/Cargo.toml:224`
 *     pins for `frame-system`), `substrate/frame/system/src/limits.rs:392-405`
 *     — `with_sensible_defaults` sets Normal `max_total = ratio × block`,
 *     Operational `max_total` = the WHOLE block, and calls
 *     `.avg_block_initialization(Perbill::from_percent(10))`.
 *  3. Same file, `:473-497` — `build()` sets `max_block` to the LARGEST class
 *     `max_total` (`:479-483`: the whole block, from Operational), computes
 *     `init_weight = 10% × max_block` (`:485`), and then (`:489-492`)
 *     **`max_extrinsic = max_total − init_weight − base_extrinsic`**.
 *  4. `base_extrinsic` defaults to `constants::ExtrinsicBaseWeight`
 *     (`limits.rs:419`), which is 108,157 ns × 1,000 ps/ns of ref_time
 *     (`substrate/frame/support/src/weights/extrinsic_weights.rs:55-56`), and
 *     the runtime does not override it.
 *  5. `midnight-node` `pallets/midnight/src/lib.rs:618` prices a transaction
 *     by scaling the largest of the ledger's five normalised dimensions
 *     (`midnight-ledger@crate-ledger-9.1.0.0-rc.3`,
 *     `ledger/src/versions/common/mod.rs:1165`, a `max`) by
 *     `BlockWeights::get().max_block.ref_time()` — the WHOLE block. So a
 *     transaction's weight fraction IS its worst dimension's fraction of that
 *     dimension's ledger limit, and the per-extrinsic weight budget maps back
 *     onto each ledger dimension as the same fraction of that dimension's
 *     limit.
 *
 * So, for a NORMAL extrinsic, in fractions of the block:
 *
 *     max_extrinsic = 0.75 − 0.10 − (108,157,000 / 2,000,000,000,000)
 *                   = 0.65 − 0.0000540785
 *                   = 0.6499459215
 *
 * and against the ledger's bytesWritten limit of 50,000 that is 32,497 —
 * not 37,500. 31,201 (accepted) fits it; 35,748 (refused) does not; both
 * agree with 65% and neither agrees with 75%. `calibrate()` below turns the
 * two real submissions into a permanent test.
 *
 * ── WHAT COULD AND COULD NOT BE DERIVED AT RUN TIME ─────────────────────────
 *
 * The five LEDGER limits are derived live, from our own `LedgerParameters`
 * (`limitsFromLedger` in `scripts/tx-size.ts`). The four numbers above CANNOT
 * be: they are Substrate class limits, a different layer than the ledger, and
 * `LedgerParameters` does not express them. They are therefore NAMED, CITED,
 * DERIVED-BY-HAND values — held as the exact integers the sources state, never
 * as a pre-multiplied decimal — and the full chain is printed beside every
 * verdict they produce. If the node's runtime changes any of them, the
 * calibration test still holds until a NEWER submission contradicts it; add
 * that submission to the calibration points and re-derive.
 */

/* ─── The four hand-derived constants. Exact integers from the sources. ───── */

/** Normal-class share of the block. `runtime/src/lib.rs:308`. Perbill, so /1e9. */
export const NORMAL_DISPATCH_RATIO_PERBILL = 750_000_000n;
/** Average block-initialisation share. `frame/system/src/limits.rs:402`. */
export const AVG_BLOCK_INIT_PERBILL = 100_000_000n;
/** The block's ref_time: 2 s in picoseconds. `runtime/src/lib.rs:316-317`. */
export const MAX_BLOCK_REF_TIME_PS = 2_000_000_000_000n;
/**
 * A no-op extrinsic's base weight: 108,157 ns of ref_time, in picoseconds.
 * `frame/support/src/weights/extrinsic_weights.rs:55-56` at
 * `polkadot-stable2606`; reached through `frame/system/src/limits.rs:419`.
 */
export const BASE_EXTRINSIC_REF_TIME_PS = 108_157_000n;

const PERBILL = 1_000_000_000n;

/**
 * The derived per-extrinsic fraction of the block, as an exact rational
 * NUM/DEN, so nothing is rounded until a ceiling is taken against a limit.
 *
 *   0.75 − 0.10 − base/block
 * = (0.65 × block − base) / block, over a Perbill-scaled denominator.
 */
export const EXTRINSIC_FRACTION = {
  num:
    ((NORMAL_DISPATCH_RATIO_PERBILL - AVG_BLOCK_INIT_PERBILL) * MAX_BLOCK_REF_TIME_PS) / PERBILL
    - BASE_EXTRINSIC_REF_TIME_PS,
  den: MAX_BLOCK_REF_TIME_PS,
} as const;

/** The Normal CLASS's per-block fraction — the old "ceiling", kept and printed
 *  beside the real one so the difference is on the page. */
export const CLASS_FRACTION = { num: NORMAL_DISPATCH_RATIO_PERBILL, den: PERBILL } as const;

/**
 * What a single NORMAL extrinsic may take of one ledger dimension.
 * Floor, because a budget is a floor: 50,000 → 32,497.
 */
export const extrinsicCeiling = (limit: number): number =>
  Number((BigInt(Math.trunc(limit)) * EXTRINSIC_FRACTION.num) / EXTRINSIC_FRACTION.den);

/** What the whole Normal CLASS may take of one dimension per block: 50,000 → 37,500. */
export const classCeiling = (limit: number): number =>
  Number((BigInt(Math.trunc(limit)) * CLASS_FRACTION.num) / CLASS_FRACTION.den);

/** The derived fraction as a decimal, for percentage displays only. */
export const extrinsicFraction = (): number =>
  Number(EXTRINSIC_FRACTION.num) / Number(EXTRINSIC_FRACTION.den);

/* ─── Calibration: the two real submissions the ceiling must sit between. ──── */

/**
 * bytesWritten of the eleven-circuit deploy ACCEPTED 28 Aug 2026 21:04 IST,
 * block 215,346, contract `93ac5860…`.
 */
export const ACCEPTED_BYTES_WRITTEN = 31_201;
/**
 * bytesWritten of the thirteen-circuit deploy REFUSED with 1010 at
 * 28 Aug 2026 22:27 IST (`C218`, reopened; `S11`).
 */
export const REFUSED_BYTES_WRITTEN = 35_748;
/** The ledger's bytesWritten limit both submissions were judged against. */
export const BYTES_WRITTEN_LIMIT = 50_000;

/**
 * ANY ceiling this module computes for bytesWritten must sit strictly between
 * the accepted and the refused submission, or the derivation is wrong.
 * Returns the reason it fails, or null if it holds.
 */
export const calibrate = (ceiling: number = extrinsicCeiling(BYTES_WRITTEN_LIMIT)): string | null => {
  if (!(ceiling > ACCEPTED_BYTES_WRITTEN)) {
    return `the computed ceiling ${ceiling.toLocaleString()} would refuse the deploy the chain `
      + `ACCEPTED at ${ACCEPTED_BYTES_WRITTEN.toLocaleString()}`;
  }
  if (!(ceiling < REFUSED_BYTES_WRITTEN)) {
    return `the computed ceiling ${ceiling.toLocaleString()} would pass the deploy the chain `
      + `REFUSED at ${REFUSED_BYTES_WRITTEN.toLocaleString()}`;
  }
  return null;
};

/* ─── The derivation, printed. Both numbers, on every run. ─────────────────── */

/**
 * Prints the whole chain beside the verdicts that depend on it, so the
 * difference between the class budget and the extrinsic budget is on the page
 * rather than in somebody's head. `line` is the caller's printer.
 */
export const printDerivation = (line: (s?: string) => void, bytesWrittenLimit: number | null): void => {
  const lim = bytesWrittenLimit ?? BYTES_WRITTEN_LIMIT;
  line('  The ceiling, derived — never held as a literal (S11, C238):');
  line('    NORMAL_DISPATCH_RATIO        75%          runtime/src/lib.rs:308');
  line('    avg_block_initialization     10% of the WHOLE block (max_block is the');
  line('                                 Operational max_total)');
  line('                                              frame/system/src/limits.rs:392-405,:479-485');
  line('    base_extrinsic               108,157 ns of a 2 s block  (5.41e-5)');
  line('                                              frame/support/.../extrinsic_weights.rs:55-56');
  line('    max_extrinsic = max_total − init_weight − base_extrinsic');
  line('                                              frame/system/src/limits.rs:489-492');
  line(`                  = 0.75 − 0.10 − 0.0000540785 = ${extrinsicFraction().toFixed(10)} of the block`);
  line('    one transaction is priced by its WORST dimension scaled to the whole');
  line('    block — pallets/midnight/src/lib.rs:618, ledger common/mod.rs:1165 —');
  line('    so the same fraction applies to each ledger dimension.');
  line(`    bytesWritten ${lim.toLocaleString()}: the CLASS may write ${classCeiling(lim).toLocaleString()} a block (75%);`);
  line(`    ONE EXTRINSIC may write ${extrinsicCeiling(lim).toLocaleString()} (~65%). The second decides a deploy.`);
  const c = calibrate(extrinsicCeiling(lim === BYTES_WRITTEN_LIMIT ? lim : BYTES_WRITTEN_LIMIT));
  line(`    calibration: accepted ${ACCEPTED_BYTES_WRITTEN.toLocaleString()} < ceiling < refused ${REFUSED_BYTES_WRITTEN.toLocaleString()} — `
    + (c === null ? 'HOLDS' : `FAILS: ${c}`));
  line('    not derived here: whether CheckWeight adds extension weights before the');
  line('    comparison — worth at most a few bytes; the calibration window bounds it.');
};
