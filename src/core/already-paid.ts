/**
 * **WHO A RUN WOULD PAY A SECOND TIME, FOR THE SAME KIND OF PAYMENT FOR THE SAME
 * MONTH - DECIDED ONCE, AS VALUES, FOR EVERY DOOR THAT RAISES A RUN.**
 *
 * Every run derives its people's payment secrets from its own id, so two runs
 * that pay one person for one month are, to the account, two unrelated
 * payments: the account records a completed payment by the payment itself and
 * cannot connect them. Whatever stops the second one has to be asked before a
 * run is raised, and this is the question.
 *
 * **KEYED BY THE KIND OF PAYMENT AS WELL AS THE MONTH.** A person paid salary
 * for a month is not thereby paid everything for it; a later kind of payment
 * for the same month is a different question, and adding one is one more value
 * of `PaymentKind` rather than a second copy of this file. Salary is the only
 * kind a run pays today.
 *
 * **A PERSON IS THE SAME PAYEE BY THEIR ROSTER ENTRY OR BY WHERE THEY ARE
 * PAID.** A person can be on the roster twice - joined again, or onboarded a
 * second time from the same wallet - and the account pays an address, not an
 * entry. Two entries paid at one address are one payee to the money.
 *
 * **AND THE CHAIN IS ASKED AS WELL AS THE RECORDS.** Everything above reads
 * this service's own records of its runs, and a service restored from an older
 * copy of them has no trace of a run raised after that copy was taken. The
 * chain keeps every round while it is open and every payment for ever, so
 * `unaccountedOnChain` compares those with what the records know; what the
 * records cannot account for may be this month's pay for these people.
 */

/** The kinds of payment a run can make. */
export const PAYMENT_KINDS = ['salary'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** What a run pays. Every run this product draws pays salary. */
export const kindOfRun = (_run: object): PaymentKind => 'salary';

/** One person on a run, as far as being paid twice is concerned. */
export interface Payee {
  readonly id: string;
  readonly name: string;
  /** Where they are paid. `null` for somebody with no address, who cannot be paid at all. */
  readonly address: string | null;
}

/** A run, as far as being paid twice is concerned. */
export interface RunPaying<K extends string = PaymentKind> {
  readonly id: string;
  readonly month: string;
  readonly kind: K;
  readonly people: readonly Payee[];
}

/** The same roster entry, or paid at the same address. */
export const samePayee = (a: Payee, b: Payee): boolean =>
  a.id === b.id
  || (a.address !== null && b.address !== null && a.address.toLowerCase() === b.address.toLowerCase());

/**
 * **THE EARLIER RUNS THAT ALREADY PAY, OR MAY STILL PAY, SOMEBODY ON `run` FOR
 * THE SAME KIND OF PAYMENT FOR THE SAME MONTH**, with the people on `run` each
 * one covers.
 *
 * `earlier` is every run that may pay: the caller leaves out a run that can no
 * longer reach the chain, and a run a confirmation lets through. The run itself
 * is never compared with itself, so a leg raised again, or a retry, is not
 * refused by its own run. `sameMonth` is the caller's, so the month is read the
 * way every other guard reads it.
 */
export function alreadyPaying<K extends string>(
  run: RunPaying<K>,
  earlier: ReadonlyArray<RunPaying<K>>,
  sameMonth: (a: string, b: string) => boolean,
): Array<{ readonly run: RunPaying<K>; readonly people: readonly Payee[] }> {
  return earlier
    .filter(e => e.id !== run.id && e.kind === run.kind && sameMonth(e.month, run.month))
    .map(e => ({ run: e, people: run.people.filter(p => e.people.some(q => samePayee(p, q))) }))
    .filter(c => c.people.length > 0);
}

/** Pairs of people on one run who are the same payee, each pair once, in the order they are listed. */
export function paidTwiceOnOneRun(people: readonly Payee[]): Array<readonly [Payee, Payee]> {
  const pairs: Array<readonly [Payee, Payee]> = [];
  people.forEach((a, i) => {
    for (const b of people.slice(i + 1)) if (samePayee(a, b)) pairs.push([a, b]);
  });
  return pairs;
}

/**
 * **WHAT THE CHAIN HOLDS FOR THIS ACCOUNT THAT ITS RECORDS CANNOT ACCOUNT FOR.**
 *
 * `rounds` are the chain's open rounds that no proposal in the records names.
 * `payments` is how many of the chain's completed payments are not among the
 * leaves of the records' runs. `cannotSay` is set when the chain holds payments
 * and could not say which of the known leaves they are, in which case every one
 * of them is counted as unaccounted: nothing is known about them, which is not
 * the same as knowing they are accounted for.
 */
export function unaccountedOnChain(
  chain: { readonly openRounds: readonly string[]; readonly payments: number },
  known: {
    readonly rounds: readonly string[];
    /** How many of the known leaves the chain says it has paid, or `null` when it cannot say. */
    readonly paid: number | null;
  },
): { rounds: string[]; payments: number; cannotSay: boolean } {
  const recorded = new Set(known.rounds.map(r => r.toLowerCase()));
  const rounds = chain.openRounds.map(r => r.toLowerCase()).filter(r => !recorded.has(r));
  const cannotSay = chain.payments > 0 && known.paid === null;
  const payments = Math.max(0, chain.payments - (known.paid ?? 0));
  return { rounds, payments, cannotSay };
}

/**
 * **WHETHER A CONFIRMATION COVERS WHAT THE CHAIN HOLDS UNACCOUNTED FOR.** Every
 * unaccounted round must be named in it, and it must have confirmed at least as
 * many unaccounted payments as there are now. One more payment than was
 * confirmed is one nobody has read about.
 */
export const confirmationCovers = (
  unaccounted: { readonly rounds: readonly string[]; readonly payments: number },
  confirmed: { readonly of: readonly string[]; readonly chainPayments?: number } | undefined,
): boolean => {
  const named = new Set((confirmed?.of ?? []).map(r => r.toLowerCase()));
  return unaccounted.rounds.every(r => named.has(r.toLowerCase()))
    && unaccounted.payments <= (confirmed?.chainPayments ?? 0);
};
