/**
 * **WHERE THE CHAIN FILED A VAULT'S NOTE, READ BACK OFF THE CHAIN'S OWN RECORD
 * OF THE TRANSACTION THAT CREATED IT.**
 *
 * A vault spends a note by proving where it sits in the chain's commitment
 * tree. That position is assigned when the transaction is applied, so no
 * client can know it when it builds the transaction, and nothing the vault's
 * owner holds is a function of it.
 *
 * **The ledger records it anyway.** Applying a transaction emits one event per
 * output, and a `zswapOutput` event carries the output's commitment, the
 * contract that owns it and its `mtIndex`, looked up by commitment rather than
 * by position. The indexer serves those events per transaction. So the index is
 * read, never worked out: not from an output's position in its offer, which is
 * wrong whenever a transaction has more than one offer or a transient, and not
 * from any count kept on this machine.
 *
 * **THREE STEPS, AND EACH REFUSES RATHER THAN GUESSING.**
 *
 *   1. `vaultNoteCommitment`: the commitment the chain holds for a note the
 *      vault owns, from the note's own colour, nonce and value.
 *   2. `indexerNoteEvents`: every zswap event the chain holds for one
 *      transaction, deserialised by the ledger. A reply that cannot be read is
 *      an error, never an empty list.
 *   3. `noteIndexFrom`: the one event for that commitment, owned by that vault,
 *      and its `mtIndex`.
 *
 * **THERE ARE THREE ANSWERS AND THEY ARE THREE ERRORS**, because each one asks
 * for a different act. A transaction the node has finalised can still be
 * missing from the indexer for a moment afterwards; that is
 * `NoteIndexUnreadable`, and reading again later is the answer to it. A
 * transaction the chain holds that did not create this note is
 * `NoteIndexRefused`, and reading again changes nothing. **And a question the
 * indexer will not take at all is `NoteIndexUnaskable`** - not the chain being
 * slow and not the chain saying no, but this client and that indexer out of
 * step, which no amount of reading again repairs.
 */
import type { Hex } from '../core/crypto.js';
import type { NotePool } from './vault-ledger.js';
import type { Note } from './vault-notes.js';

/**
 * **A NOTE'S INDEX AS THE CHAIN REPORTED IT, AND NO OTHER NUMBER.**
 *
 * A branded `bigint`. `noteIndexFrom` is the only function that makes one,
 * and `withIndexRead`, which sets the index on a payment's own copy of the pool,
 * takes nothing else, so a number that was counted, assumed or typed in does not
 * type-check there. A cast can still make one; the type is a guard against a
 * mistake, not against a decision.
 */
export type ChainReadIndex = bigint & { readonly __readFromTheChain: unique symbol };

/** The transaction that created a note, as the chain names it. */
export type CreatingTransaction =
  | { readonly hash: Hex }
  | { readonly identifier: Hex };

/** The coin a vault note is, as the pool records it. */
export interface NoteCoin {
  readonly nonce: Hex;
  /** The ledger's token type. */
  readonly token: Hex;
  readonly value: bigint;
}

/** One zswap event the chain holds for a transaction, as the ledger deserialised it. */
export interface ServedEvent {
  readonly transactionHash: string;
  readonly details: {
    readonly tag: string;
    readonly commitment?: string;
    readonly contract?: string;
    readonly mtIndex?: bigint;
  };
}

/** Where a transaction's events come from. The indexer, in production. */
export interface NoteEvents {
  /**
   * Every zswap event the chain holds for one transaction.
   *
   * Throws `NoteIndexUnreadable` when it cannot say YET, `NoteIndexUnaskable`
   * when the question itself will not be taken, and never answers an empty list
   * for a transaction it could not find.
   */
  eventsOf(tx: CreatingTransaction): Promise<ReadonlyArray<ServedEvent>>;
}

/** The chain could not be asked, or has not caught up. Reading again later may answer. */
export class NoteIndexUnreadable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoteIndexUnreadable';
  }
}

/**
 * **THE QUESTION ITSELF COULD NOT BE PUT, AND PUTTING IT AGAIN WILL NOT HELP.**
 *
 * Not the chain being slow and not the chain saying no: the indexer and this
 * client disagree about what may be ASKED. A field that has been renamed, a
 * query this schema does not have, an argument it does not take. **Every one of
 * those used to be reported as "read again shortly"**, so somebody reading it
 * waits, and reads again, for ever.
 *
 * It is a third answer rather than either of the other two because it needs a
 * different act: neither waiting nor accepting that the note has no index, but
 * a client and an indexer brought back into step.
 */
export class NoteIndexUnaskable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoteIndexUnaskable';
  }
}

/** The chain answered, and its answer does not give this note an index. Reading again will not help. */
export class NoteIndexRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteIndexRefused';
  }
}

const bare = (hex: string): string => hex.trim().toLowerCase().replace(/^0x/, '');

const named = (tx: CreatingTransaction): string =>
  'hash' in tx ? `transaction ${tx.hash}` : `transaction identifier ${tx.identifier}`;

/* ------------------------------------------------------------------ *
 * which kind of no a GraphQL error is
 * ------------------------------------------------------------------ */

/**
 * **THE SHAPES THAT MEAN THE QUESTION IS WRONG RATHER THAN THE MOMENT.**
 *
 * GraphQL says nothing about which errors are permanent, so this is read off
 * what servers actually send: a validation code in `extensions`, or one of the
 * sentences a schema check produces. It is deliberately a list of ways to say
 * PERMANENT and not a list of ways to say transient.
 */
const CANNOT_BE_ASKED_CODES = new Set([
  'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT',
]);

/*
 * **`PERSISTED_QUERY_NOT_FOUND` IS NOT ON THAT LIST AND IT LOOKS LIKE IT
 * SHOULD BE.** In the convention that sends it, it means *send the same
 * question again with its full text* - so the act it asks for is one more
 * request, which is the opposite of what this file would say about it. The
 * question above is always sent with its full text, so nothing here should ever
 * produce it; something in front of the indexer could.
 */

const CANNOT_BE_ASKED_SAYS = [
  /cannot query field/i, /unknown field ["']/i, /unknown argument ["']/i, /unknown type ["']/i,
  /^syntax error/i, /is not defined by type/i, /did not match expected type/i,
  /must not have a selection/i, /of required type/i, /^validation error/i,
];

/**
 * **WHETHER ASKING AGAIN COULD POSSIBLY ANSWER, AND THE DEFAULT IS THAT IT
 * COULD.**
 *
 * Getting this wrong in one direction tells somebody to wait for an answer that
 * will never come; **getting it wrong in the other tells them to stop waiting
 * for one that would have**. The second is worse, because a note whose index is
 * never read is money nobody reaches. So an error is permanent only when it
 * SAYS it is, and everything unrecognised stays retryable.
 */
export function theQuestionCannotBeAsked(errors: readonly unknown[]): boolean {
  return errors.some((e) => {
    const err = e as { message?: unknown; extensions?: { code?: unknown } } | null;
    const code = err?.extensions?.code;
    if (typeof code === 'string' && CANNOT_BE_ASKED_CODES.has(code)) return true;
    const said = typeof err?.message === 'string' ? err.message : '';
    return CANNOT_BE_ASKED_SAYS.some((shape) => shape.test(said));
  });
}

/**
 * **EVERY ERROR, NOT THE FIRST.** A schema that has moved usually complains
 * about several fields at once, and a reader shown one of them fixes one of
 * them. Bounded, because an error list is somebody else's output.
 */
export function everyThingSaid(errors: readonly unknown[]): string {
  /*
   * **BOUNDED IN LENGTH AS WELL AS IN COUNT, AND STRIPPED OF CONTROL
   * CHARACTERS.** This text is somebody else's output and it reaches a
   * terminal. Five messages with no length limit are as unbounded as fifty;
   * and an escape sequence in one of them moves the cursor over lines this
   * door has already printed, including the line saying nothing was written.
   */
  const plain = (text: string): string =>
    // eslint-disable-next-line no-control-regex
    text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 400);
  const said = errors.slice(0, 5).map((e) => {
    const err = e as { message?: unknown; extensions?: { code?: unknown } } | null;
    const code = typeof err?.extensions?.code === 'string' ? plain(err.extensions.code as string) : '';
    const text = typeof err?.message === 'string' && err.message ? plain(err.message) : 'no message';
    return code ? `${text} [${code}]` : text;
  });
  const more = errors.length - said.length;
  return said.join('; ') + (more > 0 ? ` (and ${more} more)` : '');
}

/**
 * **THE COMMITMENT THE CHAIN HOLDS FOR A NOTE THIS VAULT OWNS.**
 *
 * The ledger's commitment for a coin owned by a contract. The binding offers
 * no function that computes it directly for a contract, so it is read off an
 * output built for that contract; the output is built and discarded, and its
 * commitment does not depend on the segment it is built for.
 *
 * This is NOT the vault's own record of the note. The vault's `notes` set holds
 * a different commitment, over the coin and a blinding, and an event never
 * carries that one.
 */
export async function vaultNoteCommitment(coin: NoteCoin, vault: Hex): Promise<string> {
  const { ZswapOutput } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const output = ZswapOutput.newContractOwned(
    { type: bare(coin.token), nonce: bare(coin.nonce), value: coin.value },
    0,
    bare(vault),
  );
  return bare(output.commitment);
}

/**
 * **WHICH TRANSACTION THESE EVENTS ARE FROM, AS SIXTY-FOUR HEX CHARACTERS OR
 * NOT AT ALL.**
 *
 * When the transaction was named by HASH, that is the caller's own value and
 * every event is compared against it. When it was named by the 33-byte
 * IDENTIFIER, the hash is not something the caller has: it is read off the
 * first event, and the comparison that follows is then against a value taken
 * from the answer itself.
 *
 * **SO ON THAT BRANCH THE COMPARISON CANNOT REFUSE THE VALUE IT IS BUILT FROM**,
 * and an event carrying an empty hash, `0x`, or forty hex characters passed
 * every check and was written into the pool as the note's `createdIn`. A note
 * recording a hash nothing created reads as a HEALTHY note everywhere
 * afterwards - in the pool, on the screen, in the pre-flight a payment makes -
 * and is refused only at the spend, after a proposal and its approvals have
 * been paid for.
 *
 * The shape is the one the deposit path already applies to the same value: a
 * transaction hash is thirty-two bytes written as sixty-four lower-case hex
 * characters, and anything else is not one.
 */
export function theTransactionTheseEventsAreFrom(
  events: ReadonlyArray<ServedEvent>,
  transaction: CreatingTransaction,
): Hex {
  const fromTheCaller = 'hash' in transaction;
  const value = fromTheCaller ? bare(transaction.hash) : bare(events[0]!.transactionHash);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new NoteIndexRefused(
      fromTheCaller
        ? `"${transaction.hash}" is not a transaction hash. One is thirty-two bytes written as `
          + 'sixty-four hex characters. Nothing is recorded against a name no spend could read '
          + 'the note\x27s place from.'
        : `the chain answered about ${named(transaction)} without naming its hash: it gave `
          + `"${events[0]!.transactionHash}", and a transaction hash is thirty-two bytes written `
          + 'as sixty-four hex characters. Nothing is recorded, because a note recording a hash '
          + 'no spend can use reads as a healthy note until the moment it is spent. Read again '
          + 'once the transaction shows on the indexer, or name it by its hash.');
  }
  return value as Hex;
}

/**
 * **THE INDEX OF ONE NOTE, OUT OF THE EVENTS OF THE TRANSACTION THAT CREATED
 * IT.**
 *
 * Exactly one `zswapOutput` event must carry the note's commitment, it must be
 * owned by this vault, and when the transaction is named by hash every event
 * must say it came from that transaction. Anything else is refused with what
 * would resolve it.
 */
export function noteIndexFrom(
  events: ReadonlyArray<ServedEvent>,
  want: { readonly vault: Hex; readonly commitment: string; readonly transaction: CreatingTransaction },
): ChainReadIndex {
  const where = named(want.transaction);

  if (events.length === 0) {
    throw new NoteIndexUnreadable(
      `the chain returned no events for ${where}. That is not the chain saying this note does `
      + 'not exist: a transaction the node has finalised can be missing from the indexer for a '
      + 'moment. Read the index again once the transaction shows on the indexer.');
  }

  const asked = theTransactionTheseEventsAreFrom(events, want.transaction);
  const other = events.find((e) => bare(e.transactionHash) !== asked);
  if (other) {
    throw new NoteIndexRefused(
      `the events returned for ${where} include one from transaction ${other.transactionHash}. `
      + 'Nothing is recorded from an answer that is about more than one transaction. Check which '
      + 'indexer this client is pointed at, then read again.');
  }

  const commitment = bare(want.commitment);
  const matches = events.filter((e) => e.details.tag === 'zswapOutput'
    && typeof e.details.commitment === 'string'
    && bare(e.details.commitment) === commitment);

  if (matches.length === 0) {
    throw new NoteIndexRefused(
      `${where} did not create this note: none of its ${events.length} events is an output `
      + 'with this note\'s commitment. Either this is not the transaction that created it, or '
      + 'the note recorded here is not the coin that transaction sent. Name the transaction '
      + 'that paid this note into the vault and read again.');
  }
  if (matches.length > 1) {
    throw new NoteIndexRefused(
      `${where} reports this note's commitment ${matches.length} times. A commitment is one `
      + 'place in the tree, so this answer cannot be right about all of them and nothing is '
      + 'recorded from it.');
  }

  const found = matches[0].details;
  if (typeof found.contract !== 'string' || bare(found.contract) !== bare(want.vault)) {
    throw new NoteIndexRefused(
      `${where} created an output with this note's commitment, but ${found.contract === undefined
        ? 'not for a contract' : 'for a different contract'}. A note this vault cannot spend is `
      + 'not recorded as one it can. Check that the vault named is the vault this note was '
      + 'paid into.');
  }

  if (typeof found.mtIndex !== 'bigint' || found.mtIndex < 0n) {
    throw new NoteIndexRefused(
      `${where} carries this note's output without a readable index. Nothing is recorded.`);
  }
  return found.mtIndex as ChainReadIndex;
}

/**
 * **WHETHER ONE TRANSACTION CREATED ONE NOTE, AND IF SO ITS HASH: THE ONLY
 * PLACE THAT IS DECIDED.**
 *
 * The three questions, asked of one transaction's events: exactly one output
 * carries the note's commitment, that output is owned by this vault, and every
 * event is that transaction's. Then the transaction's hash, in the one shape a
 * spend can read it in.
 *
 * **EVERY WRITER OF A NOTE'S `createdIn` COMES THROUGH HERE.** A deposit whose
 * call reported no hash, the repair that is handed a transaction by name, and a
 * rebuild that has recovered a note this machine never finished writing. They
 * used to spell the composition out each time, and a hash taken any other way
 * - the first event's, say - makes the note read as healthy in the pool, on the
 * screen and in the pre-flight, and be refused at the spend after a proposal
 * and its approvals have been paid for.
 *
 * The commitment is the caller's, from `vaultNoteCommitment`, so a caller asking
 * about one note and many transactions computes it once.
 */
export function establishCreatingTransaction(
  served: ReadonlyArray<ServedEvent>,
  want: { readonly vault: Hex; readonly commitment: string; readonly transaction: CreatingTransaction },
): { index: ChainReadIndex; createdIn: Hex } {
  const index = noteIndexFrom(served, want);
  return { index, createdIn: theTransactionTheseEventsAreFrom(served, want.transaction) };
}

/**
 * **THE INDEX A SPEND USES, READ FROM THE CHAIN AT THE MOMENT OF THE SPEND.**
 *
 * Never taken from the pool. The pool records which transaction created the
 * note; the index is read from that transaction's events now, so a number
 * written down earlier is never what is spent against. An index the pool
 * happens to hold is not consulted at all, not even to compare: nothing reads
 * it, so nothing can be misled by it.
 */
export async function indexForSpend(
  vault: Hex,
  note: Note,
  events: NoteEvents,
): Promise<ChainReadIndex> {
  if (note.createdIn === undefined) {
    throw new NoteIndexRefused(
      `the vault's note ${note.nonce} does not record which transaction created it, so its `
      + 'place in the chain\'s commitment tree cannot be read. It is still on chain and still '
      + 'the vault\'s. Name the transaction that paid it into the vault to '
      + 'recordCreatingTransaction, and pay again.');
  }
  const transaction = { hash: note.createdIn };
  const commitment = await vaultNoteCommitment(note, vault);
  return noteIndexFrom(await events.eventsOf(transaction), { vault, commitment, transaction });
}

/**
 * **RECORD WHICH TRANSACTION CREATED A NOTE, ONCE THE CHAIN HAS CONFIRMED IT
 * DID.**
 *
 * For a note whose pool entry does not say, such as one recorded before the
 * creating transaction was kept with it, or one whose recorded transaction is
 * wrong. The transaction is named by hash or identifier; its events must show
 * an output with this note's commitment, owned by this vault, or nothing is
 * written.
 *
 * **ONLY THE TRANSACTION IS WRITTEN, NEVER THE INDEX.** A spend reads the index
 * from this transaction's events at the moment it spends, so a number stored
 * here would have no reader but a mismatch check, and a stored number is one a
 * later spend could be handed by mistake. The index read now is returned so a
 * caller can show it.
 *
 * The events are read first and the pool is loaded again just before the
 * write, so the copy written is not the one held across the network read. The
 * write is built on the version that second load read, so another process
 * writing the pool between that load and the save is refused at the save
 * rather than overwritten.
 */
export async function recordCreatingTransaction(
  pool: NotePool,
  vault: Hex,
  nonce: Hex,
  events: NoteEvents,
  tx: CreatingTransaction,
): Promise<{ index: ChainReadIndex; createdIn: Hex; previously?: Hex }> {
  const before = (await pool.load(vault)).notes.find((n) => n.nonce === nonce);
  if (!before) {
    throw new NoteIndexRefused(
      `this vault's pool has no note ${nonce}. There is nothing to record a transaction against.`);
  }

  const commitment = await vaultNoteCommitment(before, vault);
  const served = await events.eventsOf(tx);
  /*
   * The index and the hash come out of one composition, the one every writer of
   * `createdIn` uses. The hash is the value every event was compared against,
   * shaped by the same guard, never read off the array a second time: it used
   * to be taken straight from `served[0]`, which was the one value on this path
   * that nothing had checked.
   */
  const { index, createdIn } = establishCreatingTransaction(
    served, { vault, commitment, transaction: tx });

  const now = await pool.load(vault);
  const current = now.notes.find((n) => n.nonce === nonce);
  if (!current) {
    throw new NoteIndexRefused(
      `note ${nonce} left this vault's pool while the chain was being read, so it has been `
      + 'spent or rebuilt. Nothing is recorded.');
  }
  if (current.token !== before.token || current.value !== before.value) {
    throw new NoteIndexRefused(
      `note ${nonce} changed while the chain was being read: it is no longer the coin whose `
      + 'commitment was checked. Nothing is recorded; read again.');
  }
  await pool.save(vault, {
    notes: now.notes.map((n) => (n.nonce === nonce ? { ...n, createdIn } : n)),
  }, now.readAt);
  return current.createdIn !== undefined && bare(current.createdIn) !== createdIn
    ? { index, createdIn, previously: current.createdIn }
    : { index, createdIn };
}

/**
 * **THE ZSWAP EVENTS OF ONE TRANSACTION, FROM THE INDEXER, DESERIALISED BY THE
 * LEDGER.**
 *
 * One request, by hash or by identifier. Each served `raw` is one serialised
 * event and is deserialised whole; one that does not deserialise stops the read
 * rather than being skipped, because a skipped event is the one that would have
 * answered.
 */
export function indexerNoteEvents(
  indexerUrl: string,
  post: typeof fetch = fetch,
): NoteEvents {
  return {
    async eventsOf(tx) {
      const where = named(tx);
      const offset = 'hash' in tx ? { hash: bare(tx.hash) } : { identifier: bare(tx.identifier) };
      let body: any;
      try {
        const res = await post(indexerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: 'query ($offset: TransactionOffset!) { transactions(offset: $offset) '
              + '{ hash zswapLedgerEvents { raw } } }',
            variables: { offset },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          throw new Error(`the indexer answered HTTP ${res.status}`);
        }
        body = await res.json();
      } catch (cause) {
        throw new NoteIndexUnreadable(
          `the indexer at ${indexerUrl} could not be asked about ${where} `
          + `(${(cause as Error)?.message ?? String(cause)}). That is not an answer about the `
          + 'note. Check this machine can reach the indexer, then read again.', { cause });
      }

      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const said = everyThingSaid(body.errors);
        if (theQuestionCannotBeAsked(body.errors)) {
          throw new NoteIndexUnaskable(
            `the indexer will not take this question about ${where}: ${said}. That is not the `
            + 'chain being slow and it is not the chain saying no about the note - it is this '
            + 'client asking for something the indexer does not have, so asking again changes '
            + 'nothing. Nothing is recorded.');
        }
        throw new NoteIndexUnreadable(
          `the indexer refused the question about ${where}: ${said}. Nothing is recorded.`);
      }
      const txs = body?.data?.transactions;
      if (!Array.isArray(txs)) {
        throw new NoteIndexUnreadable(
          `the indexer's answer about ${where} is not a list of transactions. Nothing is recorded.`);
      }
      if (txs.length === 0) {
        throw new NoteIndexUnreadable(
          `the indexer does not hold ${where}. If it was only just finalised, the indexer may `
          + 'not have caught up: read again shortly. If it never landed, there is no note.');
      }
      if (txs.length > 1) {
        throw new NoteIndexRefused(
          `the indexer holds ${txs.length} transactions for ${where}, so this answer is not about `
          + 'one transaction and nothing is recorded from it. If the transaction was named by its '
          + 'identifier, name it by its hash instead.');
      }

      const { Event } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
      const served = txs[0]?.zswapLedgerEvents;
      if (!Array.isArray(served)) {
        throw new NoteIndexUnreadable(
          `the indexer's answer about ${where} carries no event list. Nothing is recorded.`);
      }
      return served.map((e: any, i: number): ServedEvent => {
        const hex = bare(String(e?.raw ?? ''));
        if (!/^(?:[0-9a-f]{2})+$/.test(hex)) {
          throw new NoteIndexUnreadable(
            `event ${i + 1} of ${where} is not hex. Nothing is recorded.`);
        }
        let event: any;
        try {
          event = Event.deserialize(Uint8Array.from(Buffer.from(hex, 'hex')));
        } catch (cause) {
          throw new NoteIndexUnreadable(
            `event ${i + 1} of ${where} did not deserialise as a ledger event `
            + `(${(cause as Error)?.message ?? String(cause)}). A skipped event could be the one `
            + 'that answers, so nothing is recorded.', { cause });
        }
        return { transactionHash: String(event.source.transactionHash), details: event.content };
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * a note nobody recorded the transaction of
 * ------------------------------------------------------------------ */

/**
 * **EVERY TRANSACTION THAT DEPLOYED OR CALLED ONE VAULT, AS THE CHAIN NAMES
 * THEM.** The indexer, in production.
 */
export interface VaultTransactions {
  /**
   * Newest first, by hash. Throws `NoteIndexUnreadable` when the chain cannot
   * answer yet and `NoteIndexUnaskable` when the question will not be taken, and
   * never answers a list it knows to be shorter than the one the chain holds.
   */
  of(vault: Hex): Promise<ReadonlyArray<Hex>>;
}

/** What the search found for one note: its creating transaction, or why there is none. */
export type CreatingTransactionFound =
  | { readonly nonce: Hex; readonly createdIn: Hex }
  | { readonly nonce: Hex; readonly unresolved: string };

/**
 * **WHICH TRANSACTION CREATED EACH OF THESE NOTES, WHEN NOBODY WROTE IT DOWN.**
 *
 * A note a rebuild recovers - a deposit whose pool write was lost, or the change
 * of a payment whose write was lost - is named from what this machine journalled
 * before the call, and a journal line is written before the transaction exists,
 * so it cannot carry the hash. A note without one cannot be spent. But the
 * transaction that created it is not unknowable: **only a call to the vault
 * changes the vault's note set**, so it is one of the transactions the chain
 * lists as having acted on this vault.
 *
 * **THE LIST ONLY PROPOSES. NOTHING ON IT IS BELIEVED.** Each listed transaction
 * is read and put to `establishCreatingTransaction`, the same three questions
 * every other writer of `createdIn` asks, and a note is given a hash only when a
 * transaction answers all three for it. So this is not a second way of
 * establishing which transaction created a note: it is a second way of finding
 * candidates to ask the one way about. A wrong list costs reads and ends in
 * `unresolved`; it cannot put a hash on a note.
 *
 * Newest first, and it stops reading once every note is answered: a recovered
 * note is almost always from the latest calls. When two transactions both carry
 * a note's commitment, the newest one that answers is recorded; either is a
 * transaction that created an output with this commitment for this vault, which
 * is exactly what the other writers establish and no more.
 *
 * **IT NEVER THROWS FOR THE CHAIN'S SAKE.** A list that cannot be read, or a
 * transaction that cannot, becomes a reason on the notes it leaves unanswered -
 * because the caller's job is to write what it recovered either way, and a note
 * written without its transaction is refused before any fee, while a note not
 * written at all is money nobody can name.
 */
export async function creatingTransactionsAmong(
  vault: Hex,
  notes: ReadonlyArray<NoteCoin>,
  chain: { readonly transactions: VaultTransactions; readonly events: NoteEvents },
): Promise<{ found: CreatingTransactionFound[]; listed: number; read: number }> {
  if (notes.length === 0) return { found: [], listed: 0, read: 0 };

  const unresolvedAll = (why: string, listed: number, read: number) => ({
    found: notes.map((n): CreatingTransactionFound => ({ nonce: n.nonce, unresolved: why })),
    listed,
    read,
  });

  let listed: ReadonlyArray<Hex>;
  try {
    listed = await chain.transactions.of(vault);
  } catch (cause) {
    if (!(cause instanceof NoteIndexUnreadable || cause instanceof NoteIndexUnaskable)) throw cause;
    return unresolvedAll(
      `the chain could not list the transactions that acted on this vault (${(cause as Error).message})`,
      0, 0);
  }

  const open = new Map<Hex, { coin: NoteCoin; commitment: string; refused: string[] }>();
  for (const n of notes) {
    open.set(n.nonce, { coin: n, commitment: await vaultNoteCommitment(n, vault), refused: [] });
  }
  const answered = new Map<Hex, Hex>();
  const unreadable: string[] = [];
  let read = 0;

  for (const hash of listed) {
    if (open.size === 0) break;
    const transaction = { hash };
    let served: ReadonlyArray<ServedEvent>;
    try {
      served = await chain.events.eventsOf(transaction);
      read += 1;
    } catch (cause) {
      if (!(cause instanceof NoteIndexUnreadable || cause instanceof NoteIndexUnaskable)) throw cause;
      /*
       * **A TRANSACTION THAT COULD NOT BE READ IS NOT ONE THAT DID NOT CREATE
       * THE NOTE**, so it is remembered: a note left unanswered says that one of
       * its candidates was never asked.
       */
      unreadable.push(`${hash.slice(0, 16)}… (${(cause as Error).message})`);
      continue;
    }
    for (const [nonce, want] of [...open]) {
      /*
       * **ONLY A TRANSACTION THAT CARRIES THE COMMITMENT IS PUT TO THE THREE
       * QUESTIONS.** This decides nothing about the note - the questions do -
       * it decides whether a refusal is worth reporting. A transaction with no
       * output of this commitment did not create it, which is the answer for
       * every call but one and not news; a transaction that carries it and is
       * still refused is, and its reason is kept for the operator.
       */
      const carries = served.some((e) => e.details.tag === 'zswapOutput'
        && typeof e.details.commitment === 'string'
        && bare(e.details.commitment) === bare(want.commitment));
      if (!carries) continue;
      try {
        const { createdIn } = establishCreatingTransaction(
          served, { vault, commitment: want.commitment, transaction });
        answered.set(nonce, createdIn);
        open.delete(nonce);
      } catch (cause) {
        if (!(cause instanceof NoteIndexRefused || cause instanceof NoteIndexUnreadable)) throw cause;
        want.refused.push(`${hash.slice(0, 16)}… carries it and was refused: ${(cause as Error).message}`);
      }
    }
  }

  const found = notes.map((n): CreatingTransactionFound => {
    const createdIn = answered.get(n.nonce);
    if (createdIn !== undefined) return { nonce: n.nonce, createdIn };
    const want = open.get(n.nonce)!;
    const parts = [
      `none of the ${listed.length} transaction(s) the chain lists for this vault answered for it`,
      ...(want.refused.length > 0 ? [want.refused.join('; ')] : []),
      ...(unreadable.length > 0
        ? [`${unreadable.length} of them could not be read, so they were never asked: ${unreadable.slice(0, 3).join('; ')}`]
        : []),
    ];
    return { nonce: n.nonce, unresolved: parts.join('. ') };
  });
  return { found, listed: listed.length, read };
}

/** The part of a WebSocket this file uses. The global one, in Node and in a browser. */
export interface IndexerSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

const HEX_HASH = /^[0-9a-f]{64}$/;

/**
 * **THE TRANSACTIONS THAT ACTED ON A VAULT, FROM THE INDEXER, ALL OF THEM.**
 *
 * Two questions. The newest action is asked for over HTTP, which names the
 * transaction the list has to reach. Then every action from the start of the
 * chain is asked for over the indexer's subscription - the one query that lists
 * a contract's actions rather than answering for one block - and the list is
 * taken as complete only when that newest transaction has come past.
 *
 * **A LIST THAT DID NOT REACH IT IS AN ERROR, NEVER A SHORT LIST.** A short list
 * is not dangerous here (nothing on it is believed), but it would answer
 * *"no transaction created this note"* about a note the chain holds, and that
 * is a sentence that sends somebody to the wrong place.
 */
export function indexerVaultTransactions(
  indexerUrl: string,
  indexerWsUrl: string,
  deps: {
    post?: typeof fetch;
    open?: (url: string, protocol: string) => IndexerSocket;
    timeoutMs?: number;
  } = {},
): VaultTransactions {
  const post = deps.post ?? fetch;
  const open = deps.open
    ?? ((url: string, protocol: string) => new (globalThis as any).WebSocket(url, protocol) as IndexerSocket);
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const newest = async (vault: Hex): Promise<Hex> => {
    let body: any;
    try {
      const res = await post(indexerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query ($a: HexEncoded!) { contractAction(address: $a) { transaction { hash } } }',
          variables: { a: bare(vault) },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the indexer answered HTTP ${res.status}`);
      body = await res.json();
    } catch (cause) {
      throw new NoteIndexUnreadable(
        `the indexer at ${indexerUrl} could not be asked for this vault's latest transaction `
        + `(${(cause as Error)?.message ?? String(cause)}). Check this machine can reach the `
        + 'indexer, then read again.', { cause });
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const said = everyThingSaid(body.errors);
      throw theQuestionCannotBeAsked(body.errors)
        ? new NoteIndexUnaskable(
          `the indexer will not take the question for this vault's latest transaction: ${said}. `
          + 'Asking again changes nothing; this client and that indexer are out of step.')
        : new NoteIndexUnreadable(`the indexer refused the question for this vault's latest transaction: ${said}.`);
    }
    const hash = bare(String(body?.data?.contractAction?.transaction?.hash ?? ''));
    if (body?.data?.contractAction == null) {
      throw new NoteIndexUnreadable(
        'the indexer holds no transaction for this vault. A vault the node has just finalised can '
        + 'be missing from the indexer for a moment; read again shortly.');
    }
    if (!HEX_HASH.test(hash)) {
      throw new NoteIndexUnreadable(
        'the indexer named this vault\x27s latest transaction without a hash of sixty-four hex '
        + 'characters, so there is nothing to know the list is complete by. Read again.');
    }
    return hash as Hex;
  };

  return {
    async of(vault) {
      const last = await newest(vault);
      return new Promise<ReadonlyArray<Hex>>((resolve, reject) => {
        const seen: Hex[] = [];
        let done = false;
        let socket: IndexerSocket;
        const finish = (outcome: { list: Hex[] } | { error: Error }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { socket.close(); } catch { /* the answer is already decided */ }
          if ('list' in outcome) resolve(outcome.list); else reject(outcome.error);
        };
        const short = (why: string) => finish({
          error: new NoteIndexUnreadable(
            `the indexer's list of this vault's transactions stopped before the latest one (${why}), `
            + `after ${seen.length} transaction(s). A list known to be short is not used. Read again.`),
        });
        const timer = setTimeout(() => short(`no answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
        try {
          socket = open(indexerWsUrl, 'graphql-transport-ws');
        } catch (cause) {
          clearTimeout(timer);
          done = true;
          reject(new NoteIndexUnreadable(
            `the indexer's subscription at ${indexerWsUrl} could not be opened `
            + `(${(cause as Error)?.message ?? String(cause)}). Read again.`, { cause }));
          return;
        }
        socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init', payload: {} }));
        socket.onerror = () => short('the connection failed');
        socket.onclose = () => short('the indexer closed the connection');
        socket.onmessage = (ev) => {
          let m: any;
          try { m = JSON.parse(String(ev.data)); } catch { short('an answer that is not JSON'); return; }
          if (m?.type === 'connection_ack') {
            socket.send(JSON.stringify({
              id: '1',
              type: 'subscribe',
              payload: {
                query: 'subscription ($a: HexEncoded!, $o: BlockOffset) { contractActions(address: $a, '
                  + 'offset: $o) { transaction { hash } } }',
                /* From the first block: an address is not acted on before it is deployed. */
                variables: { a: bare(vault), o: { height: 0 } },
              },
            }));
            return;
          }
          if (m?.type === 'error' || (m?.type === 'next' && Array.isArray(m.payload?.errors) && m.payload.errors.length > 0)) {
            const errors = Array.isArray(m.payload) ? m.payload : (m.payload?.errors ?? []);
            const said = everyThingSaid(errors);
            finish({
              error: theQuestionCannotBeAsked(errors)
                ? new NoteIndexUnaskable(
                  `the indexer will not take the question for this vault's transactions: ${said}. `
                  + 'Asking again changes nothing; this client and that indexer are out of step.')
                : new NoteIndexUnreadable(`the indexer refused the question for this vault's transactions: ${said}.`),
            });
            return;
          }
          if (m?.type === 'next') {
            const hash = bare(String(m.payload?.data?.contractActions?.transaction?.hash ?? ''));
            if (!HEX_HASH.test(hash)) {
              short('a transaction without a hash of sixty-four hex characters');
              return;
            }
            if (!seen.includes(hash as Hex)) seen.push(hash as Hex);
            if (hash === last) finish({ list: [...seen].reverse() });
            return;
          }
          if (m?.type === 'complete') short('the subscription ended');
        };
      });
    },
  };
}
