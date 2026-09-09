/**
 * **WHICH LEDGER WROTE A RECORD, AND WHAT A LIST MAY SAY ABOUT IT.**
 *
 * A company forms its belief about what exists by reading a list. So this is
 * where the question is answered, and not at the point where somebody tries to
 * spend: a guard at the payment is a guard that fires after a decision has
 * already been taken on a screen.
 *
 * ── THE RULE THIS FILE IS BUILT ON ───────────────────────────────────────
 *
 * **ABSENT MEANS NOT KNOWN, AND NOT KNOWN IS NEVER READ AS A CHAIN'S.** The
 * company address carries the same rule for the same reason: a record written
 * before anything recorded its ledger cannot be interrogated after the fact,
 * and reading its silence as `'chain'` would vouch for exactly the records
 * nothing can vouch for. Reading it as `'simulated'` is the same mistake
 * pointing the other way - it would let a real payment be dismissed as a
 * rehearsal. **There are three answers here and not two.**
 *
 * ── AND NOTHING HERE INFERS A PROVENANCE FROM SHAPE ──────────────────────
 *
 * The simulated ledger mints an address as thirty-two random bytes spelled
 * exactly as a contract address is spelled, on purpose, so that no downstream
 * check could ever pass by accident. Its transaction references happen to
 * carry a recognisable prefix today; nothing promises they will, that prefix
 * exists on proposals and never on runs, and it records the moment a proposal
 * was raised rather than anything about the record's life afterwards.
 * **A discriminator that is almost reliable is worse than none, because the
 * first reader to trust it stops looking for the real one.** So the only thing
 * read here is a marker something wrote down at the time.
 */

/**
 * The ledger a record was written against, as a word.
 *
 * The two implementations of the boundary, and no third value: a reader that
 * meets a word it does not know answers `'unknown'` rather than guessing which
 * of these it resembles.
 */
export type WiringName = 'simulated' | 'chain';

/** What can be said about one record. Three answers, and the third is real. */
export type Provenance = 'chain' | 'simulated' | 'unknown';

/** Anything persisted that carries the marker. Optional, because older records have none. */
export interface Marked {
  readonly wiring?: WiringName | null;
}

/** One record, with the word the list is allowed to say about it. */
export type WithProvenance<T> = T & { readonly provenance: Provenance };

/**
 * **FAIL CLOSED IN BOTH DIRECTIONS.**
 *
 * Only the two words this product writes are believed. Anything else - absent,
 * null, an empty string, a word a later version of this product introduced -
 * is `'unknown'`, which is the only honest answer a reader that does not
 * recognise a marker can give.
 */
export const provenanceOf = (rec: Marked): Provenance =>
  rec.wiring === 'chain' ? 'chain'
    : rec.wiring === 'simulated' ? 'simulated'
      : 'unknown';

/** How many records of each kind a list holds. Every key present, so a zero is visible. */
export interface ProvenanceCounts {
  readonly chain: number;
  readonly simulated: number;
  readonly unknown: number;
}

export const countProvenance = (rows: readonly Marked[]): ProvenanceCounts => {
  const counts = { chain: 0, simulated: 0, unknown: 0 };
  for (const row of rows) counts[provenanceOf(row)] += 1;
  return counts;
};

/**
 * **A LIST IS MIXED WHEN IT HOLDS SOMETHING A CHAIN WROTE AND SOMETHING NO
 * CHAIN VOUCHES FOR.** That is the state the whole of this file exists to
 * refuse, stated as a predicate so it can be read on its own.
 *
 * Simulated and unknown together are NOT mixed. Neither of them claims to have
 * reached a chain, so nothing in that list is misread as more settled than it
 * is - and they still carry different words, because *this was a rehearsal*
 * and *nobody recorded what this was* are different facts and collapsing them
 * is how a guess gets written down.
 */
export const isMixed = (counts: ProvenanceCounts): boolean =>
  counts.chain > 0 && counts.simulated + counts.unknown > 0;

export type ListRefusal = 'records-from-more-than-one-ledger';

export type ListVerdict<T> =
  | { readonly listed: true; readonly rows: ReadonlyArray<WithProvenance<T>>; readonly counts: ProvenanceCounts }
  | { readonly listed: false; readonly refusal: ListRefusal; readonly counts: ProvenanceCounts; readonly message: string };

/**
 * **WHAT A COMPANY IS SHOWN.**
 *
 * Every record it has, each carrying the word for where it came from - unless
 * the list is mixed, in which case none of it is shown and the reason is said
 * out loud.
 *
 * ── WHY NOT THE TWO SIMPLER ANSWERS ──────────────────────────────────────
 *
 * **Dropping the records nothing vouches for** is the cheapest thing to build
 * and the worst thing to own: a company that raised three payroll runs opens
 * the page and sees none, with no sentence anywhere saying why. An empty list
 * and a withheld list look identical, so the product would be lying by
 * omission about the one subject it must never be vague on.
 *
 * **Refusing every list that holds anything unvouched** is the safest and it
 * buys nothing the rule below does not. A company whose records are all
 * rehearsals would be unable to see any of them, for as long as they exist,
 * although nothing in that list could be misread as settled - there is nothing
 * beside them to misread them against.
 *
 * **So the refusal is keyed to the mixture and not to the ingredient**, which
 * is what the property actually says: a record that never reached a chain must
 * never appear beside one that did with nothing to tell them apart. A list
 * that is entirely one thing has no *beside*.
 *
 * ── WHY THE RUNNING LEDGER DOES NOT CHANGE THE VERDICT ───────────────────
 *
 * It is taken so the refusal can say which way round the mixture is, and for
 * nothing else. The danger is a property of the records, not of the process
 * reading them: a store holding both kinds is just as misleading opened by a
 * process that cannot reach a chain at all, and a rule that only fires one way
 * round is a rule that stops firing the day somebody reads the same data
 * somewhere else.
 */
export function decideList<T extends Marked>(
  running: WiringName,
  rows: readonly T[],
): ListVerdict<T> {
  const counts = countProvenance(rows);
  if (isMixed(counts)) {
    return {
      listed: false,
      refusal: 'records-from-more-than-one-ledger',
      counts,
      message: refusalMessage(running, counts),
    };
  }
  return {
    listed: true,
    counts,
    rows: rows.map(row => ({ ...row, provenance: provenanceOf(row) })),
  };
}

/**
 * **THE SENTENCE A COMPANY READS, AND IT NAMES WHAT WOULD RESOLVE IT.**
 *
 * Not a setting to change and not a file to edit - neither exists for whoever
 * is looking at this screen. What resolves it is a state: these records are
 * kept apart from the ones a chain wrote, or the ones no chain wrote are gone.
 */
export function refusalMessage(running: WiringName, counts: ProvenanceCounts): string {
  const unvouched = counts.simulated + counts.unknown;
  const detail = counts.unknown > 0
    ? `${unvouched} were not, and ${counts.unknown} of those carry no record of which ledger wrote them`
    : `${unvouched} were written while this product was rehearsing against no chain`;
  return 'these records were not all written against the same ledger, so they are not shown '
    + `together: ${counts.chain} were written on a chain and ${detail}. `
    + 'A record that never reached a chain is indistinguishable from one that did once they '
    + 'are in the same list, and this product will not show a list it cannot tell apart. '
    + 'Seeing them again means keeping the records that never reached a chain separate from '
    + `the ones that did. ${running === 'chain' ? 'This company is running against a chain.' : 'This company is not running against a chain.'}`;
}

/* ------------------------------------------------------------------ *
 * refusing the SELECTION, which is a different question from refusing
 * a list
 * ------------------------------------------------------------------ */

/**
 * **A LEDGER MAY NOT BE SELECTED OVER RECORDS NOTHING VOUCHES FOR.**
 *
 * The rule above decides what one company is shown. This one decides whether
 * the product may run at all against a given set of records, and it is asked
 * once, before anything is served.
 *
 * ── WHY IT IS NOT ENOUGH THAT THE LIST RULE ALREADY REFUSES ──────────────
 *
 * It is enough to keep any single company from being misled, and that is the
 * property. It is not enough to keep the situation VISIBLE: without this, a
 * product pointed at a chain over records nothing recorded serves normally for
 * everybody whose records happen to be uniform, and refuses one company at a
 * time as the mixtures appear. **Whoever pointed it there finds out last, from
 * a support conversation, one company at a time.** So the question is asked
 * once, out loud, by whoever starts the process.
 *
 * ── AND IT IS DELIBERATELY NARROWER THAN THE LIST RULE ───────────────────
 *
 * It refuses only on records whose ledger was never recorded, and only when
 * the selection is not the rehearsal one. Records that a rehearsal ledger
 * wrote and MARKED are not refused here: they are a known quantity, they are
 * shown with the word *rehearsal* on them, and a company can still read its
 * own history. **An unrecorded one is the only state nothing can ever resolve,
 * which is what makes it worth stopping for.**
 *
 * Returns the sentence to refuse with, or `null` to proceed.
 */
export function refuseSelectionOver(
  running: WiringName, counts: ProvenanceCounts,
): string | null {
  if (running === 'simulated') return null;
  if (counts.unknown === 0) return null;
  return `${counts.unknown} stored records do not say which ledger wrote them, and this product `
    + 'has been pointed at a chain. Nothing can establish after the fact whether such a record '
    + 'was settled or rehearsed, and nothing here will invent it: every company holding one '
    + 'beside a record a chain wrote will be refused its own list, one at a time, as those '
    + 'pairs appear. That is said once, here, rather than discovered by each of them in turn. '
    + 'Running against a chain means running against records that each say which ledger '
    + 'produced them.';
}

/**
 * **A STORE THAT TWO LEDGERS HAVE BOTH WRITTEN TO WILL PRODUCE MIXED LISTS,
 * AND IT GOES ON BEING TRUE AFTER THE RECORDS THAT PROVED IT ARE GONE.**
 *
 * This is the one question counting the records cannot answer. A count says
 * what is in the store now; a company can cancel a round, supersede a run or
 * be removed, and the count follows it - while the fact that this store has
 * been written under two different ledgers stays true for everything still in
 * it and everything written into it next.
 *
 * Asked once, by whoever starts the process, for the reason the check above is
 * asked once: the alternative is finding out one refused company at a time.
 *
 * Returns the sentence to refuse with, or `null` to proceed.
 */
export function refuseSelectionOverHistory(seen: readonly WiringName[]): string | null {
  if (seen.length < 2) return null;
  return 'this store has been written by more than one ledger - ' + seen.join(' and then ')
    + '. Records written under different ledgers cannot be shown in one list, because a '
    + 'record that never reached a chain and one that did are indistinguishable once they '
    + 'are side by side. Running means running against records one ledger wrote.';
}
