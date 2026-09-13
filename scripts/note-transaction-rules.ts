/**
 * **THE RULES BEHIND RECORDING WHICH TRANSACTION CREATED A NOTE, WITH NO
 * NETWORK IN THEM.**
 *
 * A vault spends a note by proving where the chain filed it, and that place is
 * read from the events of the transaction that created the note. A note whose
 * pool entry does not say which transaction that was cannot be spent: the money
 * is on chain, it is the vault's, and no payment can reach it.
 *
 * The repair is to name that transaction. These are the rules that decide what
 * a person may name and which note they are naming, separated from the network
 * so each refusal can be watched turning red without a chain, a wallet or a
 * fee.
 *
 * **NOTHING HERE READS AN INDEX AND NOTHING HERE WRITES ONE.** The index is
 * read from the chain at the moment of a spend and never stored; what this
 * repairs is the record of WHERE TO READ IT FROM.
 */

/** A note as the pool holds it, reduced to the fields these rules decide on. */
export interface PooledNote {
  readonly nonce: string;
  readonly token: string;
  readonly value: bigint;
  readonly createdIn?: string;
}

/** The chain's two names for one transaction. */
export type NamedTransaction =
  | { readonly hash: string }
  | { readonly identifier: string };

/** What a person typed cannot be acted on, and the message says what would be. */
export class NotUsable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotUsable';
  }
}

const bare = (s: string): string => s.trim().toLowerCase().replace(/^0x/, '');

/**
 * **THE TWO NAMES ARE DIFFERENT LENGTHS, AND THAT IS WHAT TELLS THEM APART.**
 *
 * A transaction hash is 32 bytes. An identifier is 33, and a deposit reports
 * the identifier while the pool records the hash — so the number a person has
 * written down after a deposit is USUALLY THE ONE THE POOL DOES NOT HOLD.
 * Refusing it would send them to look for a value they were never shown, so
 * both are accepted and each is passed on under its own name.
 *
 * Anything else is refused with its length, because "that is not valid" does
 * not tell somebody holding a truncated value what is wrong with it.
 */
export function transactionFromText(typed: string): NamedTransaction {
  const t = bare(typed);
  if (t === '') {
    throw new NotUsable(
      'no transaction was named. A note is spent by its place in the chain\'s commitment tree, '
      + 'and that place is read from the transaction that created the note, so there is nothing '
      + 'to read without one.');
  }
  if (!/^[0-9a-f]+$/.test(t)) {
    throw new NotUsable(
      `"${typed.trim()}" is not a transaction: a transaction is named in hexadecimal and this `
      + 'carries other characters. Both names the chain uses are digits and the letters a to f.');
  }
  if (t.length === 64) return { hash: t };
  if (t.length === 66) return { identifier: t };
  throw new NotUsable(
    `that is ${t.length / 2} bytes, and neither name the chain uses is that long: a transaction `
    + 'hash is 32 bytes and an identifier is 33. A value that arrived shortened by a screen is '
    + 'not enough to read a note\'s place with, and nothing is guessed from a prefix.');
}

/**
 * **THE NOTES THAT CANNOT BE SPENT, AND THE ONLY REASON THIS FILE CAN SEE.**
 *
 * A note with no recorded transaction is money on chain that no payment can
 * reach. Returned in the pool's own order so a person reading the list twice
 * sees the same list.
 */
export const notesWithNoTransaction = (
  notes: ReadonlyArray<PooledNote>,
): ReadonlyArray<PooledNote> => notes.filter((n) => n.createdIn === undefined);

/**
 * **THE ONE NOTE A PERSON MEANT, OR A REFUSAL NAMING WHAT THEY COULD HAVE
 * MEANT.**
 *
 * A nonce is 32 bytes and nobody types one correctly, so a leading part of one
 * is enough — as long as it picks out exactly one note. Two matches are refused
 * rather than resolved by order: an order is not a decision a person made, and
 * the wrong note here is the wrong money.
 */
export function theNoteNamed(
  notes: ReadonlyArray<PooledNote>,
  typed: string,
): PooledNote {
  const want = bare(typed);
  if (want === '') {
    throw new NotUsable('no note was named, and there is deliberately no default: a pool can hold many.');
  }
  if (!/^[0-9a-f]+$/.test(want)) {
    throw new NotUsable(
      `"${typed.trim()}" is not part of a nonce. A nonce is hexadecimal, and the first few `
      + 'characters of one are enough here.');
  }
  const matches = notes.filter((n) => bare(n.nonce).startsWith(want));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new NotUsable(
      `this vault's pool holds no note whose nonce begins ${want}. `
      + (notes.length === 0
        ? 'The pool holds no notes at all.'
        : `It holds ${notes.length}: ${notes.map((n) => bare(n.nonce).slice(0, 12)).join(', ')}.`));
  }
  throw new NotUsable(
    `${matches.length} of this vault's notes have a nonce beginning ${want}, so this does not `
    + `name one of them: ${matches.map((n) => bare(n.nonce).slice(0, 16)).join(', ')}. `
    + 'Give more of the nonce.');
}

/**
 * **A NOTE THAT ALREADY RECORDS A TRANSACTION IS NOT REPAIRED BY ACCIDENT.**
 *
 * Replacing one is a real act — the recorded transaction may be the wrong one,
 * and then the note is unspendable until it is replaced — but it is never the
 * act somebody performs without meaning to, because the note they are about to
 * overwrite is already spendable.
 */
export function assertReplacingIsMeant(
  note: PooledNote,
  replacing: boolean,
): void {
  if (note.createdIn === undefined || replacing) return;
  throw new NotUsable(
    `note ${bare(note.nonce).slice(0, 12)} already records the transaction that created it `
    + `(${bare(note.createdIn).slice(0, 16)}…), so its place in the commitment tree can already `
    + 'be read and it can already be spent. Recording a different one would make it unspendable '
    + 'until the right one was named again.\n'
    + 'If the recorded one IS wrong -- the note is refused when it is spent, or the chain '
    + 'contradicts it -- run this again with REPLACE_RECORDED=yes set, which is the only way '
    + 'past this and is deliberately not a prompt.');
}
