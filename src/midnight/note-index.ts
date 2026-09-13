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

  const asked = 'hash' in want.transaction
    ? bare(want.transaction.hash) : bare(events[0].transactionHash);
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
  const index = noteIndexFrom(served, { vault, commitment, transaction: tx });
  /* Every event carries the same hash, which `noteIndexFrom` has just checked. */
  const createdIn = bare(served[0].transactionHash);

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
