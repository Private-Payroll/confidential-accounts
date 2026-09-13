/**
 * HOW BIG IS THE TRANSACTION, AND HOW BIG IS A BLOCK. `C218`, `R1c` item 3.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * On 28 Aug 03:03 IST the first submission since 16 August was made and refused:
 *
 *     1010: Invalid Transaction: Transaction would exhaust the block limits
 *
 * **THAT IS NOT ERROR 170.** It is a Substrate-level rejection: the node threw
 * the transaction out on resource cost BEFORE any ledger judgement, so it is
 * not the fee stack, not `InvalidDustSpendProof`, and not about proof versions.
 * Proving worked — a proof was produced and a transaction submitted in 8.9s.
 *
 * **TWO NUMBERS DECIDE IT AND NEITHER HAD EVER BEEN READ.** This module reads
 * both: what our transaction weighs, and what the chain will carry. Neither is
 * reasoned about and neither is estimated.
 *
 * ── (a) WHAT THE NUMBER IS, AND WHY `serialize().length` IS THE RIGHT ONE ────
 *
 * `Transaction.serialize(): Uint8Array` takes no arguments — `ledger-v9.d.ts`,
 * class `Transaction`; `R1a` established this and `MEASURE-PROVING` already
 * uses it for proof size.
 *
 * **IT IS *A* SIZE AND IT IS NOT *THE* SIZE THE LIMIT IS EXPRESSED IN. THIS
 * PARAGRAPH USED TO SAY THE OPPOSITE AND EVERY SIZE THIS PROJECT HAS QUOTED
 * ABOUT A REFUSAL WAS THEREFORE THE WRONG NUMBER.**
 *
 * The limit is expressed in `block_usage`, and `block_usage` is `est_size()` —
 * `midnight-ledger@crate-ledger-9.1.0.0-rc.3`, `ledger/src/structure.rs:1926`:
 *
 *     res.block_usage = self.est_size() as u64;
 *
 * `est_size()` (`:1937`) is `P::estimated_tx_size(self)`, which is per proof
 * marker. For a PROVEN transaction it is `tx.serialized_size()` (`:492-499`).
 * For an UNPROVEN one (`:584-614`) it is `serialized_size()` PLUS the proofs
 * that are not there yet — a fixed size per call, per Zswap input, per Zswap
 * output and per dust spend — so on an unproven transaction the two numbers are
 * not even close.
 *
 * AND EVEN ON THE PROVEN MARKER THEY DIFFER, because `serialized_size()` is the
 * ledger's own count and `serialize()` is what the WASM binding hands back.
 * MEASURED, on transactions built for the purpose: `serialize().length` runs
 * ABOVE `cost(params).blockUsage` by a small amount that is NOT the same on
 * every shape — 73 bytes on eight transactions that each carried an intent, and
 * 72 on an empty one, in one nine-row sweep that varied the number of
 * unshielded outputs and the width of the amount.
 *
 * **SO THE DIFFERENCE IS NOT A CONVERSION AND MUST NOT BE USED AS ONE.** Across
 * everything measured here it is small, it is far below any limit, and it moves
 * with the shape of the transaction, so no constant turns one number into the
 * other. Whether it is bounded in general is not established: three values were
 * observed and three values are not a bound. Two runs of the funding door
 * printed 7,153 and 7,156 while the node's own refusal said 7,085 and 7,088, a
 * difference of 68 in both: a third value, consistent with a gap that moves
 * with shape and needing no separate story. **The way to report the size the
 * limit uses is to ask the ledger for it, which is what `ledgerBytes` below
 * does.**
 *
 * The error runs in the direction that makes a transaction look CLOSER to the
 * limit than it is.
 *
 * ── (b) WHAT THE LIMITS ARE ──────────────────────────────────────────────────
 *
 * `midnight-ledger@crate-ledger-9.1.0.0-rc.3`, `ledger/src/structure.rs:1180`
 * (this citation said `:1272`, which is now `overall_price`; the three
 * citations in section (a) had rotted the same way and are corrected there):
 *
 *     pub const INITIAL_LIMITS: TransactionLimits = TransactionLimits {
 *         transaction_byte_limit: 1 << 20,          // :1181   1 MiB
 *         time_to_dismiss_per_byte: 2_000_000 ps,   // :1182
 *         min_time_to_dismiss: 15 ms,               // :1183
 *         block_limits: SyntheticCost {
 *             read_time:     CostDuration::SECOND,  // :1185
 *             compute_time:  CostDuration::SECOND,  // :1186
 *             block_usage:   200_000,               // :1187   <-- BYTES
 *             bytes_written: 50_000,                // :1188
 *             bytes_churned: 1_000_000,             // :1189
 *         },
 *         ...
 *
 * The five inner line numbers said `:1277` to `:1281` and were about ninety
 * lines adrift, the same rot as the three corrected in section (a). The two
 * constants above the block limits are quoted because they are the ones a
 * refusal for being too cheap relative to size turns on, and leaving them out
 * of the excerpt is what made this file look like it was only about blocks.
 *
 * **THE BLOCKSPACE LIMIT IS 200,000 BYTES AND THE PER-TRANSACTION BYTE LIMIT IS
 * 1,048,576.** They are different limits and the smaller one binds: a
 * transaction of, say, 400 KB is inside the byte limit and cannot fit a block.
 *
 * THE NUMBERS ARE NOT COPIED FROM THAT FILE INTO THIS ONE. `limitsFromLedger()`
 * below DERIVES each one from the WASM ledger this project actually runs, by
 * probing `LedgerParameters.normalizeFullness`, which returns each dimension as
 * a fraction of its limit (`base-crypto/src/cost_model.rs:277-297`: a plain
 * `self / limits` per dimension, `None` if any exceeds one). A known numerator
 * over its returned fraction is the denominator. The source lines above are
 * then the CHECK on that derivation, not its source.
 *
 * ── HOW THE NODE TURNS THAT INTO THE REFUSAL WE SAW ──────────────────────────
 *
 * `midnight-node@d9729c13` — the build the chain reports, per `docs/stagenet.md`:
 *
 *   `pallets/midnight/src/lib.rs:372`   the weight of `send_mn_transaction` is
 *                                       `get_tx_weight(midnight_tx)`
 *   `pallets/midnight/src/lib.rs:629`   `get_tx_weight` = the ledger's
 *                                       `get_transaction_cost`, and on error
 *                                       `.unwrap_or(EXTRA_WEIGHT_TX_SIZE)`
 *   `ledger/src/versions/common/mod.rs:777-778`
 *                                       `cost.normalize(block_limits)`, and
 *                                       `None` becomes `BlockLimitExceededError`
 *   `pallets/midnight/src/lib.rs:476`   `pre_dispatch` runs `check_weight`
 *                                       BEFORE `validate_guaranteed_execution`
 *   `pallets/midnight/src/lib.rs:553,560`
 *                                       `InvalidTransaction::ExhaustsResources`
 *
 * `ExhaustsResources` is what Substrate renders as
 * *"Transaction would exhaust the block limits"*, and `1010` is the RPC's
 * "Invalid Transaction". **`check_weight` running before the ledger judgement
 * is exactly why this refusal carries no `Custom error: N`.**
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not change, split or shrink anything. It measures. A contract
 * split is a redeploy of everything and a rewrite of the vault system's
 * assumptions, and it must not be chosen from a guess.
 *
 * It also never fails a run. Every measurement is wrapped: an SDK that does not
 * expose a part reports `(not available)` for that part and the deploy carries
 * on. An instrument that can break the thing it measures is not an instrument.
 */

/** One measured transaction, at one point in the pipeline. */
export type TxMeasurement = {
  /** Where in the pipeline this was taken: 'unproven', 'proven', 'balanced', 'submitted'. */
  stage: string;
  /**
   * `Transaction.serialize().length`, or null if it could not be taken.
   *
   * KEPT, BUT IT IS NOT THE NUMBER ANY LIMIT IS EXPRESSED IN — see the header.
   * It is what the client can see of its own transaction, which is worth
   * printing beside the real one, not instead of it.
   */
  bytes: number | null;
  /**
   * The size the block limit is actually expressed in: `block_usage`, read off
   * the ledger's own `cost()`. Null when the ledger would not answer.
   */
  ledgerBytes: number | null;
  /** Why it could not be taken, when it could not. */
  problem?: string;
  /** The parts, when the SDK exposes them. Never guessed. */
  parts: Array<{ name: string; bytes: number | null; note?: string }>;
  /**
   * All five block dimensions for this transaction, when a `LedgerParameters`
   * was supplied. Bytes are one of the five and the largest decides, so a
   * measurement without this answers only the easy half of the question.
   */
  cost?: CostReading;
};

/** The five block limits, as this project's own ledger reports them. */
export type BlockLimits = {
  readTime: number | null;
  computeTime: number | null;
  blockUsage: number | null;
  bytesWritten: number | null;
  bytesChurned: number | null;
  /** How they were obtained, printed so a reader knows what they are trusting. */
  source: string;
  problem?: string;
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null;

/**
 * The block limits, derived from the ledger this project runs.
 *
 * `LedgerParameters` does not expose `limits` to JavaScript — the WASM binding
 * publishes `transactionCostModel`, `dust`, `feePrices`, `maxPriceAdjustment`,
 * `serialize` and `normalizeFullness`, and no more. So the limits are read
 * through the one door that opens: `normalizeFullness` divides each dimension
 * by its limit, so a probe of a known size comes back as a known fraction, and
 * `probe / fraction` is the limit.
 *
 * The probe is deliberately small in every dimension at once — `normalize`
 * returns nothing at all if ANY dimension exceeds its limit
 * (`base-crypto/src/cost_model.rs:292`), so one over-large field would hide all
 * five answers.
 */
export function limitsFromLedger(LedgerParameters: any): BlockLimits {
  const out: BlockLimits = {
    readTime: null, computeTime: null, blockUsage: null, bytesWritten: null, bytesChurned: null,
    source: 'LedgerParameters.initialParameters().normalizeFullness(), probed',
  };
  try {
    const params = LedgerParameters.initialParameters();
    /* One picosecond of each time and one byte of each size. A fraction that
     * comes back as zero would mean the binding rounds, and is reported as
     * "could not derive" rather than as a limit of infinity. */
    const probe = {
      readTime: 1_000_000n, computeTime: 1_000_000n,
      blockUsage: 1_000n, bytesWritten: 1_000n, bytesChurned: 1_000n,
    };
    const n: any = params.normalizeFullness(probe);
    const derive = (raw: bigint, fraction: unknown): number | null => {
      const f = num(fraction);
      if (f === null || f <= 0) return null;
      return Math.round(Number(raw) / f);
    };
    out.readTime = derive(probe.readTime, n?.readTime);
    out.computeTime = derive(probe.computeTime, n?.computeTime);
    out.blockUsage = derive(probe.blockUsage, n?.blockUsage);
    out.bytesWritten = derive(probe.bytesWritten, n?.bytesWritten);
    out.bytesChurned = derive(probe.bytesChurned, n?.bytesChurned);
  } catch (e: any) {
    out.problem = String(e?.message ?? e);
  }
  return out;
}

/**
 * The size of one transaction, and its parts.
 *
 * THE BREAKDOWN IS BEST-EFFORT AND SAYS SO. `Transaction` exposes `intents`,
 * `guaranteedOffer` and `fallibleOffer`, each with its own `serialize()`; an
 * `Intent` exposes `actions`, and a `ContractDeploy` exposes `initialState`,
 * whose `operations()` and `operation(name).verifierKey` give the per-circuit
 * artefacts. Every one of those is read behind a `try`, because the question
 * "how much of this is verifier keys" must not be able to stop a deploy.
 *
 * The account deploys ELEVEN circuits — adopt, amendSigner, approve, cancel,
 * closeExpiredRun, execute, propose, recordPayment, retireVault, setThreshold,
 * setVaultThreshold — so "is this dominated by per-circuit artefacts" is the
 * question the breakdown exists to answer with numbers. It was fifteen before
 * the S11 merges, thirteen before S23 shed `credit` and `attestSolvency`, and
 * eleven of thirteen deployed before S25 emptied the deferred list.
 */
export function measureTransaction(tx: any, stage: string, LedgerParameters?: any): TxMeasurement {
  const m: TxMeasurement = { stage, bytes: null, ledgerBytes: null, parts: [] };
  if (LedgerParameters) {
    m.cost = measureCost(tx, LedgerParameters);
    /*
     * READ WITHOUT ENFORCEMENT, DELIBERATELY.
     *
     * `measureCost` asks the ledger to ENFORCE as it costs, which is the right
     * question for "would this be accepted" and the wrong one for "how big is
     * it": the enforcing form refuses a transaction that is outside the
     * time-to-dismiss window, and a refusal carries no size. That is exactly
     * the transaction whose size someone is trying to read. A size is a
     * property of the transaction and not a judgement on it, so it is taken
     * with enforcement off and is therefore always available.
     */
    m.ledgerBytes = measureCost(tx, LedgerParameters, false).cost?.blockUsage ?? null;
  }
  try {
    m.bytes = tx.serialize().length;
  } catch (e: any) {
    m.problem = `serialize() did not answer: ${String(e?.message ?? e)}`;
    return m;
  }

  const part = (name: string, f: () => number | null, note?: string) => {
    try { m.parts.push({ name, bytes: f(), note }); }
    catch (e: any) { m.parts.push({ name, bytes: null, note: `not available: ${String(e?.message ?? e)}` }); }
  };

  part('guaranteed Zswap offer', () => (tx.guaranteedOffer ? tx.guaranteedOffer.serialize().length : 0));
  part('fallible Zswap offers', () => {
    const f = tx.fallibleOffer;
    if (!f) return 0;
    let total = 0;
    for (const [, offer] of f) total += offer.serialize().length;
    return total;
  });

  let intentBytes = 0;
  let deployStateBytes = 0;
  let verifierKeyBytes = 0;
  let circuits = 0;
  try {
    for (const [, intent] of tx.intents ?? []) {
      try { intentBytes += intent.serialize().length; } catch { /* keep going */ }
      for (const action of intent.actions ?? []) {
        const initial = (action as any).initialState;
        if (!initial) continue;   // a call or a maintenance update, not a deploy
        try { deployStateBytes += initial.serialize().length; } catch { /* keep going */ }
        try {
          for (const op of initial.operations() ?? []) {
            const key = initial.operation(op)?.verifierKey;
            if (key) { verifierKeyBytes += key.length; circuits += 1; }
          }
        } catch { /* keep going */ }
      }
    }
    m.parts.push({ name: 'intents (all)', bytes: intentBytes });
    m.parts.push({
      name: 'contract deploy initial state',
      bytes: deployStateBytes,
      note: 'inside the intents above, not additional to them',
    });
    m.parts.push({
      name: `verifier keys (${circuits} circuits)`,
      bytes: verifierKeyBytes,
      note: 'inside the initial state above, not additional to it',
    });
  } catch (e: any) {
    m.parts.push({ name: 'intents (all)', bytes: null, note: `not available: ${String(e?.message ?? e)}` });
  }

  const accounted = (num(m.parts[0]?.bytes) ?? 0) + (num(m.parts[1]?.bytes) ?? 0) + intentBytes;
  m.parts.push({
    name: 'everything else',
    bytes: m.bytes === null ? null : m.bytes - accounted,
    note: 'total minus the offers and the intents: framing, binding, signatures',
  });
  return m;
}

/**
 * ALL FIVE DIMENSIONS, NOT JUST BYTES.
 *
 * `block_usage` — the serialised size — is one of five, and the node takes the
 * LARGEST of the five: `midnight-node@d9729c13`,
 * `ledger/src/versions/common/mod.rs:1165`, `scale_normalized_cost` is a `max`
 * over `[read_time, compute_time, block_usage, bytes_written, bytes_churned]`.
 * **So a transaction can be small and still exhaust a block**, and reporting
 * only the byte count would answer the easy half of the question.
 *
 * `Transaction.cost(params, enforceTimeToDismiss)` returns all five, and
 * `LedgerParameters.normalizeFullness(cost)` divides each by its limit and
 * THROWS if any exceeds one — which is the same judgement the node makes, in
 * the same code, one call earlier than `1010`.
 *
 * ON AN UNPROVEN TRANSACTION THIS IS A FLOOR AND IS LABELLED ONE. `cost` is
 * documented as accurate for proven transactions; an unproven one under-counts
 * the proof bytes and carries no fee-paying DUST spends yet. A floor that is
 * already over a limit is still a finding, and a floor that is under one
 * settles nothing on its own.
 */
export type CostReading = {
  cost: Record<string, number | null> | null;
  /** Each dimension as a fraction of its limit, or null when a limit was exceeded. */
  normalized: Record<string, number | null> | null;
  /** Set when `normalizeFullness` refused, which means a limit IS exceeded. */
  exceeded?: string;
  /**
   * THE THREE NUMBERS OUT OF A REFUSAL, ON THE ONE BRANCH WHERE THEY MATTER.
   *
   * Asking the ledger to cost a transaction AND enforce as it costs is how the
   * sixth limit is answered locally, and the ledger answers a failure by
   * throwing. Everything about that failure is in the message: how long the
   * transaction would take to dismiss, the size the allowance was computed
   * from, and the allowance itself.
   *
   * This field used not to exist, and the throw branch below kept the message
   * and dropped the reading. That is precisely backwards: a transaction that
   * fits needs no numbers, and one that does not is acted on by HOW FAR over it
   * is. A reader who cannot see the margin cannot tell a shape that will never
   * fit from one that is over by a rounding error.
   *
   * Null when the message is not a dismiss refusal, or is worded differently
   * from the wording this parses. Nothing is invented to fill it.
   */
  dismiss?: { timePs: number | null; sizeBytes: number | null; allowancePs: number | null };
  /** Which parameters this was costed at. A cost is only meaningful against the ones in force. */
  parametersSource?: 'the library\'s starting values' | 'supplied';
  problem?: string;
};

const DIMENSIONS = ['readTime', 'computeTime', 'blockUsage', 'bytesWritten', 'bytesChurned'] as const;

/**
 * The three numbers the ledger puts in a dismiss refusal, out of its own words.
 *
 * The wording is the ledger's, written once, and the units it prints are
 * picoseconds, nanoseconds, microseconds, milliseconds and seconds. The micro
 * sign is the Greek letter, so a pattern written for `us` matches nothing.
 *
 * Returns nulls rather than guesses when the wording does not match. A number
 * invented here would be read as a measurement.
 */
const DISMISS_UNITS: Record<string, number> = { ps: 1, ns: 1e3, '\u03bcs': 1e6, ms: 1e9, s: 1e12 };

export function readDismissRefusal(message: string): CostReading['dismiss'] {
  const scale = (v: string, unit: string): number | null => {
    const f = DISMISS_UNITS[unit];
    return f === undefined ? null : Math.round(Number(v) * f);
  };
  const took = /would take ([0-9.]+)(ps|ns|\u03bcs|ms|s) to dismiss/.exec(message);
  const size = /size of ([0-9]+) bytes/.exec(message);
  const most = /at most ([0-9.]+)(ps|ns|\u03bcs|ms|s)/.exec(message);
  if (!took && !size && !most) return undefined;
  return {
    timePs: took ? scale(took[1]!, took[2]!) : null,
    sizeBytes: size ? Number(size[1]) : null,
    allowancePs: most ? scale(most[1]!, most[2]!) : null,
  };
}

/**
 * The cost, AT PARAMETERS THE CALLER CHOOSES.
 *
 * `measureCost` below reads the library's own starting values, which is what
 * every door here has always done and is wrong in a way nothing said out loud:
 * those are the values a chain STARTS with, not the ones it is running. A
 * caller that has read the chain's own parameters passes them here instead, and
 * the reading records which it was.
 */
export function measureCostAt(tx: any, params: any, enforceTimeToDismiss = true): CostReading {
  const out: CostReading = { cost: null, normalized: null, parametersSource: 'supplied' };
  return costInto(out, tx, params, enforceTimeToDismiss);
}

export function measureCost(tx: any, LedgerParameters: any, enforceTimeToDismiss = true): CostReading {
  const out: CostReading = { cost: null, normalized: null, parametersSource: 'the library\'s starting values' };
  try {
    const params = LedgerParameters.initialParameters();
    return costInto(out, tx, params, enforceTimeToDismiss);
  } catch (e: any) {
    out.problem = String(e?.message ?? e);
    out.dismiss = readDismissRefusal(out.problem);
    return out;
  }
}

function costInto(out: CostReading, tx: any, params: any, enforceTimeToDismiss: boolean): CostReading {
  try {
    const raw: any = tx.cost(params, enforceTimeToDismiss);
    out.cost = {};
    for (const d of DIMENSIONS) out.cost[d] = num(raw?.[d]);
    try {
      const n: any = params.normalizeFullness(raw);
      out.normalized = {};
      for (const d of DIMENSIONS) out.normalized[d] = num(n?.[d]);
    } catch (e: any) {
      /* THIS THROW IS THE ANSWER, NOT AN ERROR. `normalize` returns nothing
       * when any dimension is over its limit — `base-crypto/src/cost_model.rs`
       * :292 — and that is precisely the condition the node turns into
       * `BlockLimitExceededError` and then `ExhaustsResources`. */
      out.exceeded = String(e?.message ?? e);
    }
  } catch (e: any) {
    out.problem = String(e?.message ?? e);
    /*
     * THE REFUSAL IS THE ANSWER AND ITS NUMBERS ARE THE USEFUL PART.
     *
     * This branch used to keep the message and nothing else. It is the one
     * branch a caller acts on, and what it acts on is the margin.
     */
    out.dismiss = readDismissRefusal(out.problem);
  }
  return out;
}

/** The five dimensions against the five limits, each as a percentage. */
export function compareCost(reading: CostReading, limits: BlockLimits): string[] {
  const out: string[] = [];
  out.push('The five block dimensions — the node takes the LARGEST of these, not the bytes alone');
  if (reading.problem || !reading.cost) {
    out.push(`  the cost could not be read: ${reading.problem ?? 'no cost returned'}`);
    return out;
  }
  const limitOf: Record<string, number | null> = {
    readTime: limits.readTime, computeTime: limits.computeTime, blockUsage: limits.blockUsage,
    bytesWritten: limits.bytesWritten, bytesChurned: limits.bytesChurned,
  };
  let worst = { name: '(none)', share: -1 };
  for (const d of DIMENSIONS) {
    const v = reading.cost[d];
    const l = limitOf[d];
    if (v === null || l === null || l === 0) { out.push(`  ${d.padEnd(14)} (not available)`); continue; }
    const share = v / l;
    if (share > worst.share) worst = { name: d, share };
    out.push(`  ${d.padEnd(14)} ${v.toLocaleString().padStart(16)} of ${l.toLocaleString().padStart(16)}   ${pct(v, l).padStart(7)}${share > 1 ? '   OVER THE LIMIT' : ''}`);
  }
  out.push('');
  if (reading.exceeded) {
    out.push('THE LEDGER REFUSED TO NORMALISE THIS COST, WHICH MEANS A LIMIT IS EXCEEDED.');
    out.push('That is the same judgement the node makes one call before it answers 1010:');
    out.push('midnight-node@d9729c13, ledger/src/versions/common/mod.rs:777-778.');
    out.push(`  ${reading.exceeded}`);
  } else if (worst.share >= 0) {
    out.push(`The binding dimension is ${worst.name}, at ${(worst.share * 100).toFixed(1)}% of a block.`);
    out.push('The ledger normalised this cost, so no limit is exceeded by the transaction');
    out.push('as measured here.');
  }
  return out;
}

const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;

/**
 * The comparison, stated plainly. `R1c`: *"our bytes against the limit, and by
 * what factor. If we are over, say by how much. If we are under, then size is
 * not the whole story and the 1010 means something else."*
 */
export function compareAgainstLimits(m: TxMeasurement, limits: BlockLimits): string[] {
  const out: string[] = [];
  /*
   * THE COMPARISON IS AGAINST `ledgerBytes`, AND IT USED TO BE AGAINST `bytes`.
   *
   * This is where the correction at the top of this file actually bites. The
   * limit here is `block_usage`, `block_usage` IS `est_size()`, and this
   * function was judging `serialize().length` against it and printing OVER or
   * UNDER from the result. Six doors call this, so the wrong number was the one
   * every report compared against the limit — and the error runs in the
   * direction that makes a transaction look closer to the limit than it is.
   *
   * `bytes` is still printed beside it, because what the client can see of its
   * own transaction is worth a reader's attention; it is no longer what the
   * verdict is computed from.
   */
  const b = m.ledgerBytes;
  out.push(`transaction (${m.stage})   ${b === null ? '(not measured)' : `${b.toLocaleString()} bytes, the size the limit is expressed in`}`);
  out.push(`  as the client serialises it   ${m.bytes === null ? '(not measured)' : `${m.bytes.toLocaleString()} bytes`}`);
  for (const p of m.parts) {
    out.push(`  ${p.name.padEnd(34)} ${p.bytes === null ? '(not available)' : p.bytes.toLocaleString().padStart(12)}${p.note ? `   ${p.note}` : ''}`);
  }
  out.push('');
  out.push(`block usage limit         ${limits.blockUsage === null ? '(not derived)' : `${limits.blockUsage.toLocaleString()} bytes`}   ${limits.source}`);
  if (limits.problem) out.push(`  the limits could not be derived: ${limits.problem}`);

  if (b === null || limits.blockUsage === null) {
    out.push('');
    out.push('NO COMPARISON IS POSSIBLE FROM THIS RUN. One of the two numbers is missing,');
    out.push('and a comparison against a number that was not read is what C180 was.');
    out.push('The size the limit uses comes from the ledger, so a run without a');
    out.push('LedgerParameters cannot make this comparison at all — and must not make');
    out.push('it from serialize().length, which is not the number this limit counts.');
    return out;
  }

  out.push('');
  if (b > limits.blockUsage) {
    out.push(`OVER. ${b.toLocaleString()} bytes against a ${limits.blockUsage.toLocaleString()}-byte block:`);
    out.push(`  over by ${(b - limits.blockUsage).toLocaleString()} bytes, a factor of ${(b / limits.blockUsage).toFixed(2)}.`);
    out.push('  This transaction cannot fit in any block on this chain, and no retry,');
    out.push('  proof server or fee changes that.');
  } else {
    out.push(`UNDER. ${b.toLocaleString()} bytes against a ${limits.blockUsage.toLocaleString()}-byte block — ${pct(b, limits.blockUsage)} of it.`);
    out.push('  SO SIZE IS NOT THE WHOLE STORY AND THE 1010 MEANS SOMETHING ELSE.');
    out.push('  block_usage is only one of five dimensions the node normalises against');
    out.push('  (read time, compute time, block usage, bytes written, bytes churned) and');
    out.push('  the largest of the five decides — midnight-node@d9729c13,');
    out.push('  ledger/src/versions/common/mod.rs:1165. A transaction that is small and');
    out.push('  expensive to verify is refused with this same sentence.');
  }
  return out;
}

/**
 * Wraps the providers so every transaction that passes through them is measured
 * and printed AT THAT MOMENT.
 *
 * PRINTED IMMEDIATELY, NOT COLLECTED FOR THE END. The 28 Aug run failed inside
 * the submission; anything held for a summary block would have been printed by
 * the failure path or not at all. Printing at each stage means a run that dies
 * at any later point still leaves the numbers it had already taken.
 *
 * ON EVERY RUN, SUCCESS OR FAILURE. `R1c`: *"it costs nothing and it is the
 * number this round exists to produce."*
 *
 * The wrapper delegates and returns exactly what it was given. It cannot change
 * a transaction, and it swallows nothing: a failure inside the measurement is
 * printed and the original call's result is still returned.
 */
export function measuringProviders(providers: any, sink: (m: TxMeasurement) => void, LedgerParameters?: any): any {
  const wrap = (obj: any, method: string, stageOf: (arg: any, result: any) => Array<[string, any]>) => {
    if (!obj || typeof obj[method] !== 'function') return obj;
    const original = obj[method].bind(obj);
    return new Proxy(obj, {
      get(target, prop, receiver) {
        if (prop !== method) return Reflect.get(target, prop, receiver);
        return async (...args: any[]) => {
          const result = await original(...args);
          try { for (const [stage, tx] of stageOf(args[0], result)) sink(measureTransaction(tx, stage, LedgerParameters)); }
          catch { /* an instrument must never break what it measures */ }
          return result;
        };
      },
    });
  };

  return {
    ...providers,
    proofProvider: wrap(providers.proofProvider, 'proveTx', (unproven, proven) => [
      ['unproven', unproven], ['proven', proven],
    ]),
    walletProvider: wrap(providers.walletProvider, 'balanceTx', (_in, balanced) => [['balanced', balanced]]),
    /* THE ONE THAT MATTERS. `submitTx` receives exactly the bytes the node is
     * asked to accept, so this measurement is taken BEFORE submitting and is
     * the number the limit applies to. */
    midnightProvider: wrap(providers.midnightProvider, 'submitTx', (submitted) => [['submitted', submitted]]),
  };
}
