/**
 * THE MOST ONE TRANSACTION MAY SPEND FROM OUR DUST, AND THE REFUSAL ABOVE IT.
 *
 * The fee payer pays for transactions somebody else composed, and what a
 * transaction costs follows what is in it. Without a ceiling the failure is a
 * bill rather than an outage: one oversized transaction, or many, drain the fee
 * budget and nothing says so until every company's writes stop.
 *
 * -- WHAT IS COMPARED, AND WHY IT IS NOT THE ESTIMATE ----------------------
 *
 * **THE AMOUNT THE BALANCED TRANSACTION DECLARES IT WILL SPEND FROM DUST.**
 * Each DUST spend in a transaction carries the fee it pays, and the spending
 * wallet's DUST falls by exactly that amount. So the sum of those fields on the
 * transaction about to be submitted is the most the chain can take from the
 * fee payer for it - read off the object that is sent, after the balance and
 * before the submission, with no model and no estimate in between.
 *
 * It counts every DUST spend in the transaction, not only the fee payer's. The
 * company balances no DUST, so any other spend is somebody else's money and not
 * ours; counting it can only make the number larger, which is the direction
 * that refuses more rather than less.
 *
 * **THE ESTIMATE IS CHECKED TOO, EARLIER, AND IT DECIDES LESS.** It is read
 * before anything is booked, so refusing on it costs nothing - no coin is marked
 * in flight and nothing has to be released. But it is a prediction, and a
 * prediction that could not be read is not a reason to refuse: the check on the
 * balanced transaction still runs and still decides.
 *
 * -- WHAT A SAFE REFUSAL LOOKS LIKE WITHOUT ANY NUMBER --------------------
 *
 * **IF THE AMOUNT CANNOT BE READ OFF THE BALANCED TRANSACTION, IT IS NOT PAID
 * FOR.** A ceiling that lets through what it cannot measure is not a ceiling.
 * The booking is released and the refusal says nothing was sent.
 *
 * -- WHERE THE NUMBER COMES FROM ------------------------------------------
 *
 * **IT IS CHOSEN, NOT DEFAULTED.** A fee payer is not built without one. There
 * is no default because the only honest default is *uncapped*, which is the
 * state this file exists to end.
 */
import { NothingWasSent } from '../core/jobs.js';

/** The most one transaction may spend from the fee payer's DUST, in SPECKs. */
export interface FeeCeiling {
  readonly perTransaction: bigint;
}

/** The setting a fee payer reads its ceiling from, in SPECKs. */
export const FEE_CEILING_SETTING = 'MIDNIGHT_FEE_CEILING_SPECKS';

/**
 * A refusal from the fee payer that happened before anything was submitted.
 *
 * **IT CARRIES THE MARK THE JOB QUEUE AND THE SERVER READ AS "NOTHING WAS
 * SENT"**, because that is exactly what it is: every path that throws this has
 * either booked nothing or released what it booked, and no submission was
 * attempted. Reported as an unknown outcome instead, it would send a person to
 * check the chain for a payment that provably never existed.
 */
export class FeeRefused extends NothingWasSent {
  constructor(message: string) {
    super(message);
    this.name = 'FeeRefused';
  }
}

/**
 * The ceiling, read from a deployment's settings.
 *
 * **IT THROWS RATHER THAN DEFAULTING**, with a sentence naming the setting and
 * what it means, so the fee payer does not start without one.
 */
export function feeCeilingFrom(env: Readonly<Record<string, string | undefined>>): FeeCeiling {
  const raw = env[FEE_CEILING_SETTING];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `${FEE_CEILING_SETTING} is not set, and a fee payer is not built without it. It is the `
      + 'most one transaction may spend from our DUST, in SPECKs, and nothing above it is paid '
      + 'for. There is no default, because the only default available is to pay whatever a '
      + 'transaction costs. Set it to a whole number of SPECKs where the fee payer runs.');
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed) || BigInt(trimmed) === 0n) {
    throw new Error(
      `${FEE_CEILING_SETTING} is set to something that is not a whole number of SPECKs above `
      + 'zero, so no fee payer was built. Set it to digits only, with no unit, no sign and no '
      + 'decimal point.');
  }
  return { perTransaction: BigInt(trimmed) };
}

/**
 * The DUST a transaction declares it will spend, in SPECKs, or `null` when that
 * cannot be read off it.
 *
 * **IT READS THE SHAPE THE LEDGER PUBLISHES AND NOTHING ELSE:** a map of intents,
 * each with optional DUST actions, each with a list of spends carrying `vFee`.
 * Anything that does not have that shape answers `null`, and `null` is refused
 * by the caller rather than treated as zero.
 *
 * A transaction whose intents carry no DUST spends answers zero, which is true:
 * nothing is taken from DUST to send it.
 */
export function dustSpentBy(tx: unknown): bigint | null {
  const intents = (tx as { intents?: unknown } | null | undefined)?.intents;
  if (!(intents instanceof Map)) return null;
  let total = 0n;
  for (const intent of intents.values()) {
    if (!intent || typeof intent !== 'object') return null;
    const actions = (intent as { dustActions?: unknown }).dustActions;
    if (actions === undefined || actions === null) continue;
    const spends = (actions as { spends?: unknown }).spends;
    if (!Array.isArray(spends)) return null;
    for (const spend of spends) {
      const fee = (spend as { vFee?: unknown } | null)?.vFee;
      if (typeof fee !== 'bigint' || fee < 0n) return null;
      total += fee;
    }
  }
  return total;
}

/**
 * Whether the fee a transaction is EXPECTED to cost is already over the
 * ceiling. Asked before anything is booked.
 *
 * **AN ESTIMATE THAT WAS NOT READ IS NOT A REFUSAL HERE**: the check on the
 * balanced transaction runs afterwards and does not depend on it.
 */
export function refusalForExpected(expected: bigint | null, ceiling: FeeCeiling): string | null {
  if (expected === null || expected <= ceiling.perTransaction) return null;
  return `this transaction is expected to cost ${expected} SPECKs, and the most one transaction `
    + `may spend from the fee payer's DUST is ${ceiling.perTransaction}. Nothing was booked and `
    + 'nothing was sent. If a transaction this size is expected, the ceiling is raised by '
    + `changing ${FEE_CEILING_SETTING} where the fee payer runs; otherwise the transaction is `
    + 'larger than anything this product pays for.';
}

/**
 * Whether the balanced transaction, as it would be submitted, spends more than
 * the ceiling. Asked after the balance and before the submission.
 *
 * **AN AMOUNT THAT COULD NOT BE READ IS A REFUSAL.** This is the check that
 * decides, and it does not let through what it cannot measure.
 */
export function refusalForCommitted(committed: bigint | null, ceiling: FeeCeiling): string | null {
  if (committed === null) {
    return 'the DUST this transaction would spend could not be read off it, so it could not be '
      + 'checked against the fee ceiling and it was not paid for. Nothing was sent, and what was '
      + 'booked for it was released. This is a fault in the fee payer rather than in the '
      + 'request: it is resolved by a fee payer that can read the fee off what it balances.';
  }
  if (committed <= ceiling.perTransaction) return null;
  return `this transaction would spend ${committed} SPECKs of the fee payer's DUST, and the most `
    + `one transaction may spend is ${ceiling.perTransaction}. Nothing was sent, and what was `
    + 'booked for it was released. If a transaction this size is expected, the ceiling is raised '
    + `by changing ${FEE_CEILING_SETTING} where the fee payer runs; otherwise the transaction is `
    + 'larger than anything this product pays for.';
}
