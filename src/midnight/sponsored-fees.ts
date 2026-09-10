/**
 * WHICH COMPANY A SPONSORED TRANSACTION WAS FOR, WHAT IT WAS EXPECTED TO COST,
 * AND WHAT IT COST.
 *
 * Nothing here bills, meters, prices, caps or refuses. It is a record, and the
 * only reason it exists now rather than when somebody needs it is that IT
 * CANNOT BE MADE LATER.
 *
 * -- WHY IT CANNOT BE RECONSTRUCTED ---------------------------------------
 *
 * What a fee payer is handed is a bound, shielded transaction. That is the
 * product: it says nothing about whose it is, and the chain's record of it says
 * nothing either. So *who was this paid for* has exactly one moment at which it
 * is knowable - while the caller that named the company is still on the stack -
 * and a fee payer that pays for whatever arrives has thrown it away before
 * anybody thinks to ask. Recording it costs a line now and is not available at
 * any price afterwards.
 *
 * -- WHY BOTH NUMBERS AND NOT ONE -----------------------------------------
 *
 * They answer different questions and they come from different places.
 *
 * The ESTIMATE is what the fee payer could have known BEFORE it committed, and
 * it is read by running the same convergence the balance is about to run. It is
 * the number a cap would one day be compared against, and it is the only one
 * available at the moment a decision could still be made.
 *
 * The ACTUAL is what was charged, and it comes back from the chain after the
 * fact. It is the number an invoice would one day be built from.
 *
 * **A GAP BETWEEN THEM IS THE FINDING.** One number cannot show one.
 *
 * -- WHAT IS NOT READ IS SAID, NEVER GUESSED ------------------------------
 *
 * Either number can be unavailable, and `null` is how this file says so. A fee
 * payer must not fail a payment because a measurement did not come back, and it
 * must not write down a number no instrument read - the balance a wallet
 * reports after a submission lags its own spend, so a difference of balances is
 * exactly the kind of value that looks like evidence and is not.
 * **`null` is a reading that was not taken. It is never a zero.**
 */

/** One sponsored transaction, as it is written down. */
export interface SponsoredFee {
  /** When the record was made, ISO 8601. */
  readonly at: string;
  /**
   * The company the transaction belonged to, or `null` when the fee payer was
   * never told.
   *
   * **NULL IS A DEFECT IN THE CALLER AND IS RECORDED RATHER THAN REPAIRED.** A
   * fee payer cannot work out whose transaction it is, so a record with no
   * company is the honest shape of a caller that did not say - and one that
   * guessed would be worse, because the guess would be indistinguishable from
   * a fact.
   */
  readonly company: string | null;
  /** What the fee payer expected to pay, in SPECKs, or `null` if not read. */
  readonly estimated: bigint | null;
  /** What was actually charged, in SPECKs, or `null` if not read. */
  readonly actual: bigint | null;
  /** The submission reference, so the record can be matched to the chain. */
  readonly ref: string;
}

/**
 * Where a record goes.
 *
 * **IT TAKES NO ANSWER AND CANNOT REFUSE**, because it runs on the path that
 * spends money and a record that can fail a payment is worse than no record.
 * Whatever it does with what it is given, it does not report back.
 */
export interface SponsoredFeeSink {
  record(entry: SponsoredFee): void;
}

/**
 * The line a record becomes.
 *
 * **SEPARATE FROM THE SINK SO THE FORMAT CAN BE READ WITHOUT ARRANGING A
 * FILESYSTEM**, and because the one thing that would make this record useless
 * is a `bigint` reaching `JSON.stringify` unconverted, which throws rather than
 * writing anything at all.
 *
 * A missing number is `null` and never `0`, and a number is written as a
 * decimal STRING rather than as a JSON number, because a fee in SPECKs is well
 * past what a JSON number holds exactly.
 */
export function sponsoredFeeLine(entry: SponsoredFee): string {
  return JSON.stringify({
    at: entry.at,
    company: entry.company,
    estimated: entry.estimated === null ? null : entry.estimated.toString(),
    actual: entry.actual === null ? null : entry.actual.toString(),
    ref: entry.ref,
  });
}

/**
 * The difference between what was expected and what was charged, or `null` when
 * either end was not read.
 *
 * **IT IS A FUNCTION AND NOT A FIELD ON THE RECORD**, so that a reading nobody
 * took can never be stored as a difference of nothing. Positive means it cost
 * more than was expected.
 */
export function feeOverrun(entry: SponsoredFee): bigint | null {
  if (entry.estimated === null || entry.actual === null) return null;
  return entry.actual - entry.estimated;
}

/** A sink that keeps records in memory. For a process with nowhere to write. */
export function inMemoryFeeSink(): SponsoredFeeSink & { entries: SponsoredFee[] } {
  const entries: SponsoredFee[] = [];
  return { entries, record: (e) => { entries.push(e); } };
}

/**
 * A sink that appends one line per transaction.
 *
 * **EVERY FAILURE IS SWALLOWED, DELIBERATELY.** This runs immediately after a
 * transaction has been submitted. A full disk, a missing directory or a
 * read-only mount must not turn a payment that succeeded into an error a caller
 * reports as a failure - the money has already moved, and the worst outcome
 * available here is a caller that retries a transaction that landed.
 *
 * The cost is stated rather than discovered: a record that could not be written
 * is lost silently, and there is no second place it exists.
 *
 * **THE WRITE IS INJECTED** so that this decision can be read without a
 * filesystem, which is the only way the swallowing branch is reachable from a
 * case at all.
 */
export function fileFeeSink(
  path: string,
  append: (path: string, line: string) => void,
): SponsoredFeeSink {
  return {
    record(entry) {
      try {
        append(path, sponsoredFeeLine(entry) + '\n');
      } catch {
        /* deliberately swallowed - see above */
      }
    },
  };
}
