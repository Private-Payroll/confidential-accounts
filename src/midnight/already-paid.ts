/**
 * Whether the chain already records a person as paid for a month, read from the account's set of pay-record
 * nonces, and the sentence the approving device shows for it. A run that would pay the same occurrence again is
 * marked refused, because the chain refuses that payment. Also the two approval bars a company's state carries:
 * the account's threshold and the approvals a policy change needs.
 */
import type { Hex } from '../core/crypto.js';
import { policyBarKey } from './spending-policy.js';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import { payRecordNonceOf, type PayRecord } from './run-keys.js';
export type PaidFor = Omit<PayRecord, 'occurrence'> & { occurrence?: number };

/** What the chain has recorded as paid for one person's kind of pay for one month. */
export interface AlreadyPaid {
  person: string;
  month: string;
  kind: string;
  /** Every occurrence the chain records as paid, lowest first. Empty when none is. */
  paid: number[];
  /** The occurrence the run pays this person as, when the caller said. */
  occurrence?: number;
  /** True when the chain already records the occurrence this run would pay. */
  refused: boolean;
}

/**
 * How many occurrences the device asks about for each person: the first
 * payment and seven numbered extras. A person paid more extras than that for
 * one month reads as paid for the ones asked about.
 */
export const OCCURRENCES_ASKED = 8;

/**
 * **THE APPROVING DEVICE'S CHECK, AS A PURE FUNCTION OF THE CHAIN'S ANSWER.**
 * For each person, which occurrences of their kind of pay for their month the
 * account records as paid, and whether the occurrence this run pays them as is
 * one of them. `has` answers for one nonce whether the account holds its
 * `paidOnceOf`; the chain cannot tell a run that paid a person from one whose
 * payment was recorded without being made, so a `paid` occurrence means
 * recorded on chain as paid, and nothing more.
 */
export const alreadyPaidOf = (
  has: (nonce: Hex) => boolean, key: Hex, asked: readonly PaidFor[], upTo = OCCURRENCES_ASKED,
): AlreadyPaid[] =>
  asked.map((p) => {
    const limit = Math.max(upTo, (p.occurrence ?? 0) + 1);
    const paid: number[] = [];
    for (let occurrence = 0; occurrence < limit; occurrence++) {
      if (has(payRecordNonceOf(key, { person: p.person, month: p.month, kind: p.kind, occurrence }))) {
        paid.push(occurrence);
      }
    }
    return {
      person: p.person, month: p.month, kind: p.kind, paid,
      ...(p.occurrence === undefined ? {} : { occurrence: p.occurrence }),
      refused: p.occurrence !== undefined && paid.includes(p.occurrence),
    };
  });

/**
 * **THE WORDS FOR ONE PERSON'S CHECK**, or null when the chain records nothing
 * for them. Never more than the chain can say: recorded on chain as paid.
 */
export const alreadyPaidSentence = (a: AlreadyPaid, name: string): string | null => {
  if (a.paid.length === 0) return null;
  const one = (o: number) => (o === 0 ? 'the regular payment' : `extra ${o}`);
  const which = a.paid.map(one).join(' and ');
  const [year, month] = a.month.split('-').map(Number);
  const named = year && month
    ? new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : a.month;
  return `${name}: ${a.kind} for ${named} is recorded on chain as paid (${which}).`
    + (a.refused && a.occurrence !== undefined
      ? ` This run pays ${one(a.occurrence)} again. The chain will refuse that one payment.`
      : '');
};

/**
 * The approvals a change of who is seated, a policy change, or a change to the
 * number a policy change needs, asks for (`bar`, the one rule `seatBarOf`), and
 * that number itself (`policyBar`), which reads as the threshold while none is
 * stored.
 */
export function seatBarParts(state: {
  threshold: bigint;
  vaultThresholds: Array<{ vault: Hex; threshold: number }>;
}): { bar: bigint; policyBar: bigint } {
  const key = policyBarKey();
  const stored = state.vaultThresholds.find(v => v.vault === key);
  const storedBar = stored ? BigInt(stored.threshold) : null;
  return { bar: seatBarOf(state.threshold, storedBar), policyBar: storedBar ?? state.threshold };
}
