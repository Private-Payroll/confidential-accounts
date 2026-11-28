/**
 * Where the chain filed a vault's note, read from the chain's record of the transaction that created it. The position
 * is assigned when the transaction is applied, so it is read from the ledger's events, never counted here.
 */
import type { Hex } from '../core/crypto.js';
import type { NotePool } from './vault-ledger.js';
import type { Note } from './vault-notes.js';
export {
  indexerNoteEvents,
  type IndexerSocket,
  indexerTransactionsByIdentifier,
  indexerVaultTransactions,
  type TransactionByIdentifier
} from './indexer-queries.js';
import type { TransactionByIdentifier } from './indexer-queries.js';

/** A note's index as the chain reported it: only `noteIndexFrom` makes one, so a counted number does not type-check. */
export type ChainReadIndex = bigint & { readonly __readFromTheChain: unique symbol };

/** The transaction that created a note, as the chain names it. */
export type CreatingTransaction = { readonly hash: Hex } | { readonly identifier: Hex };

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

/** One zswap event as it crosses a wire: the same fields, its index as decimal digits. */
export interface EventOnTheWire {
  readonly transactionHash: string;
  readonly details: {
    readonly tag: string;
    readonly commitment?: string;
    readonly contract?: string;
    readonly mtIndex?: string;
  };
}

/** The one way an event is written for a wire. */
export const eventOnTheWire = (e: ServedEvent): EventOnTheWire => ({
  transactionHash: e.transactionHash,
  details: {
    tag: e.details.tag,
    ...(e.details.commitment === undefined ? {} : { commitment: e.details.commitment }),
    ...(e.details.contract === undefined ? {} : { contract: e.details.contract }),
    ...(e.details.mtIndex === undefined ? {} : { mtIndex: e.details.mtIndex.toString() })
  }
});

/** Where a transaction's events come from. The indexer, in production. */
export interface NoteEvents {
  /**
   * Every zswap event the chain holds for one transaction, never an empty list for one it could not find. Throws
   * `NoteIndexUnreadable` when it cannot say yet, and `NoteIndexUnaskable` when the question is refused.
   */
  eventsOf(tx: CreatingTransaction): Promise<readonly ServedEvent[]>;
}

/** The chain could not be asked, or has not caught up. Reading again later may answer. */
export class NoteIndexUnreadable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoteIndexUnreadable';
  }
}

/**
 * The indexer will not take the question (a renamed field, an unknown query or argument): reading again cannot help,
 * only bringing this client and the indexer back into step.
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

export const bare = (hex: string): string => hex.trim().toLowerCase().replace(/^0x/, '');

export const named = (tx: CreatingTransaction): string =>
  'hash' in tx ? `transaction ${tx.hash}` : `transaction identifier ${tx.identifier}`;

/** Errors that mean the question is wrong, not the moment; GraphQL marks none permanent, so these are what servers send. */
const CANNOT_BE_ASKED_CODES = new Set(['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT']);

// Not `PERSISTED_QUERY_NOT_FOUND`: it asks for the same question again with its full text, which is a retry.
const CANNOT_BE_ASKED_SAYS = [
  /cannot query field/i,
  /unknown field ["']/i,
  /unknown argument ["']/i,
  /unknown type ["']/i,
  /^syntax error/i,
  /is not defined by type/i,
  /did not match expected type/i,
  /must not have a selection/i,
  /of required type/i,
  /^validation error/i
];

/**
 * Whether asking again could never answer. Anything unrecognised stays retryable, because a note whose index is never
 * read is money nobody reaches.
 */
const messageOf = (e: unknown): unknown =>
  typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined;
const codeOf = (e: unknown): unknown =>
  typeof e === 'object' && e !== null && 'extensions' in e && typeof e.extensions === 'object' && e.extensions !== null
    ? 'code' in e.extensions
      ? e.extensions.code
      : undefined
    : undefined;

export function theQuestionCannotBeAsked(errors: readonly unknown[]): boolean {
  return errors.some((e) => {
    const code = codeOf(e);
    if (typeof code === 'string' && CANNOT_BE_ASKED_CODES.has(code)) return true;
    const message = messageOf(e);
    const said = typeof message === 'string' ? message : '';
    return CANNOT_BE_ASKED_SAYS.some((shape) => shape.test(said));
  });
}

/** Every error, not the first, since a schema that moved complains about several fields; bounded, being another's output. */
export function everyThingSaid(errors: readonly unknown[]): string {
  // Stripped of control characters: this reaches a terminal, where an escape sequence could overwrite printed lines.
  const plain = (text: string): string =>
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this takes out.
    text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 400);
  const said = errors.slice(0, 5).map((e) => {
    const rawCode = codeOf(e);
    const message = messageOf(e);
    const code = typeof rawCode === 'string' ? plain(rawCode) : '';
    const text = typeof message === 'string' && message ? plain(message) : 'no message';
    return code ? `${text} [${code}]` : text;
  });
  const more = errors.length - said.length;
  return said.join('; ') + (more > 0 ? ` (and ${more} more)` : '');
}

/**
 * The ledger's commitment for a coin this vault owns, read off an output built for it and discarded. Not the vault's own
 * `notes` commitment, which adds a blinding and never appears in an event.
 */
export async function vaultNoteCommitment(coin: NoteCoin, vault: Hex): Promise<string> {
  const { ZswapOutput } = await import('@midnight-ntwrk/midnight-js-protocol/v9');
  const output = ZswapOutput.newContractOwned(
    { type: bare(coin.token), nonce: bare(coin.nonce), value: coin.value },
    0,
    bare(vault)
  );
  return bare(output.commitment);
}

/**
 * The hash of the transaction these events are from, refused unless it is sixty-four hex characters. Named by identifier,
 * the hash comes from the answer itself, and a bad one would be recorded as a healthy note until it is spent.
 */
export function theTransactionTheseEventsAreFrom(
  events: readonly ServedEvent[],
  transaction: CreatingTransaction
): Hex {
  const fromTheCaller = 'hash' in transaction;
  const value = fromTheCaller ? bare(transaction.hash) : bare(events[0]!.transactionHash);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new NoteIndexRefused(
      fromTheCaller
        ? `"${transaction.hash}" is not a transaction hash. One is thirty-two bytes written as ` +
            'sixty-four hex characters. Nothing is recorded against a name no spend could read ' +
            'the note\x27s place from.'
        : `the chain answered about ${named(transaction)} without naming its hash: it gave ` +
            `"${events[0]!.transactionHash}", and a transaction hash is thirty-two bytes written ` +
            'as sixty-four hex characters. Nothing is recorded, because a note recording a hash ' +
            'no spend can use reads as a healthy note until the moment it is spent. Read again ' +
            'once the transaction shows on the indexer, or name it by its hash.'
    );
  }
  return value as Hex;
}

/**
 * One note's index from the events of the transaction that created it: exactly one output with its commitment, owned
 * by this vault, and every event from that transaction. Anything else is refused with what would resolve it.
 */
export function noteIndexFrom(
  events: readonly ServedEvent[],
  want: { readonly vault: Hex; readonly commitment: string; readonly transaction: CreatingTransaction }
): ChainReadIndex {
  const where = named(want.transaction);

  if (events.length === 0) {
    throw new NoteIndexUnreadable(
      `the chain returned no events for ${where}. That is not the chain saying this note does ` +
        'not exist: a transaction the node has finalised can be missing from the indexer for a ' +
        'moment. Read the index again once the transaction shows on the indexer.'
    );
  }

  const asked = theTransactionTheseEventsAreFrom(events, want.transaction);
  const other = events.find((e) => bare(e.transactionHash) !== asked);
  if (other) {
    throw new NoteIndexRefused(
      `the events returned for ${where} include one from transaction ${other.transactionHash}. ` +
        'Nothing is recorded from an answer that is about more than one transaction. Check which ' +
        'indexer this client is pointed at, then read again.'
    );
  }

  const commitment = bare(want.commitment);
  const matches = events.filter(
    (e) =>
      e.details.tag === 'zswapOutput' &&
      typeof e.details.commitment === 'string' &&
      bare(e.details.commitment) === commitment
  );

  if (matches.length === 0) {
    throw new NoteIndexRefused(
      `${where} did not create this note: none of its ${events.length} events is an output ` +
        "with this note's commitment. Either this is not the transaction that created it, or " +
        'the note recorded here is not the coin that transaction sent. Name the transaction ' +
        'that paid this note into the vault and read again.'
    );
  }
  if (matches.length > 1) {
    throw new NoteIndexRefused(
      `${where} reports this note's commitment ${matches.length} times. A commitment is one ` +
        'place in the tree, so this answer cannot be right about all of them and nothing is ' +
        'recorded from it.'
    );
  }

  const found = matches[0]!.details;
  if (typeof found.contract !== 'string' || bare(found.contract) !== bare(want.vault)) {
    throw new NoteIndexRefused(
      `${where} created an output with this note's commitment, but ${
        found.contract === undefined ? 'not for a contract' : 'for a different contract'
      }. A note this vault cannot spend is ` +
        'not recorded as one it can. Check that the vault named is the vault this note was ' +
        'paid into.'
    );
  }

  if (typeof found.mtIndex !== 'bigint' || found.mtIndex < 0n) {
    throw new NoteIndexRefused(`${where} carries this note's output without a readable index. Nothing is recorded.`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the one place a chain-read index is branded.
  return found.mtIndex as ChainReadIndex;
}

/**
 * Whether one transaction created one note, with its hash in the shape a spend reads. Every writer of a note's
 * `createdIn` comes through here, so none can record a hash that is refused only at the spend.
 */
export function establishCreatingTransaction(
  served: readonly ServedEvent[],
  want: { readonly vault: Hex; readonly commitment: string; readonly transaction: CreatingTransaction }
): { index: ChainReadIndex; createdIn: Hex } {
  const index = noteIndexFrom(served, want);
  return { index, createdIn: theTransactionTheseEventsAreFrom(served, want.transaction) };
}

/** The index a spend uses, read from the creating transaction's events at the moment of the spend, never from the pool. */
export async function indexForSpend(vault: Hex, note: Note, events: NoteEvents): Promise<ChainReadIndex> {
  if (note.createdIn === undefined) {
    throw new NoteIndexRefused(
      `the vault's note ${note.nonce} does not record which transaction created it, so its ` +
        "place in the chain's commitment tree cannot be read. It is still on chain and still " +
        "the vault's. Name the transaction that paid it into the vault to " +
        'recordCreatingTransaction, and pay again.'
    );
  }
  const transaction = { hash: note.createdIn };
  const commitment = await vaultNoteCommitment(note, vault);
  return noteIndexFrom(await events.eventsOf(transaction), { vault, commitment, transaction });
}

/**
 * Records which transaction created a note once its events show this vault's output with the note's commitment; only
 * the transaction is written. The pool is reloaded and saved on that version, so a concurrent write is refused.
 */
export async function recordCreatingTransaction(
  pool: NotePool,
  vault: Hex,
  nonce: Hex,
  events: NoteEvents,
  tx: CreatingTransaction
): Promise<{ index: ChainReadIndex; createdIn: Hex; previously?: Hex }> {
  const before = (await pool.load(vault)).notes.find((n) => n.nonce === nonce);
  if (!before) {
    throw new NoteIndexRefused(
      `this vault's pool has no note ${nonce}. There is nothing to record a transaction against.`
    );
  }

  const commitment = await vaultNoteCommitment(before, vault);
  const served = await events.eventsOf(tx);
  // One composition gives both, so the hash recorded is the one every event was checked against.
  const { index, createdIn } = establishCreatingTransaction(served, { vault, commitment, transaction: tx });

  const now = await pool.load(vault);
  const current = now.notes.find((n) => n.nonce === nonce);
  if (!current) {
    throw new NoteIndexRefused(
      `note ${nonce} left this vault's pool while the chain was being read, so it has been ` +
        'spent or rebuilt. Nothing is recorded.'
    );
  }
  if (current.token !== before.token || current.value !== before.value) {
    throw new NoteIndexRefused(
      `note ${nonce} changed while the chain was being read: it is no longer the coin whose ` +
        'commitment was checked. Nothing is recorded; read again.'
    );
  }
  await pool.save(
    vault,
    {
      notes: now.notes.map((n) => (n.nonce === nonce ? { ...n, createdIn } : n))
    },
    now.readAt
  );
  return current.createdIn !== undefined && bare(current.createdIn) !== createdIn
    ? { index, createdIn, previously: current.createdIn }
    : { index, createdIn };
}

/** The call a transaction this device holds was made for: one vault, and the circuits that count as that call. */
export interface VaultCall {
  readonly vault: string;
  readonly entryPoints: readonly string[];
}

/**
 * Where one vault call stands on the chain: `landed`, `refused` (taken, but the call's part failed and cannot run
 * again), `not-seen` under every identifier, or `not-known`, with `why` saying what is missing.
 */
export type VaultCallOnChain =
  | { readonly of: 'landed'; readonly transactionHash: string }
  | { readonly of: 'refused'; readonly transactionHash: string }
  | { readonly of: 'not-seen' }
  | { readonly of: 'not-known'; readonly why: string };

/**
 * One contract call in a transaction this device holds, from its own bytes: the contract (bare lower-case hex), the
 * circuit, and each part it has a transcript in, ascending (0 is the part that always runs, else an intent's number).
 */
export interface CallAsBuilt {
  readonly address: string;
  readonly entryPoint: string;
  readonly segments: readonly number[];
}

/**
 * Whether the one call to `call.vault` in a transaction this device built took effect. Its parts come from the device's
 * bytes and each part's result from the indexer; a call split across parts with only one failed is `not-known`.
 */
export function vaultCallOnChain(
  call: VaultCall,
  built: readonly CallAsBuilt[],
  found: readonly TransactionByIdentifier[]
): VaultCallOnChain {
  const into = bare(call.vault);
  const counts = (address: string, entryPoint: string | null) =>
    address === into && entryPoint !== null && call.entryPoints.includes(entryPoint);
  const ours = built.filter((c) => counts(bare(c.address), c.entryPoint));
  if (ours.length !== 1 || ours[0]!.segments.length === 0) {
    return {
      of: 'not-known',
      why: 'the transaction this device holds does not carry exactly one such call to this vault'
    };
  }
  const parts = ours[0]!.segments;
  const listed = found.find(
    (tx) => /^[0-9a-f]{64}$/u.test(tx.hash) && tx.calls.some((c) => counts(c.address, c.entryPoint))
  );
  if (listed === undefined) return { of: 'not-seen' };
  const transactionHash = listed.hash;
  if (listed.status === 'SUCCESS') return { of: 'landed', transactionHash };
  if (listed.status === 'FAILURE') return { of: 'refused', transactionHash };
  if (listed.status !== 'PARTIAL_SUCCESS' || listed.segments === null) {
    return {
      of: 'not-known',
      why: `the indexer reports the transaction ${transactionHash} with no result this can read`
    };
  }
  const results = parts.map((id) => (id === 0 ? true : listed.segments!.find((g) => g.id === id)?.success));
  if (results.some((r) => r === undefined)) {
    return {
      of: 'not-known',
      why: `the indexer reports no result for the part of ${transactionHash} that carries the call`
    };
  }
  if (results.every((r) => r === true)) return { of: 'landed', transactionHash };
  if (results.every((r) => r === false)) return { of: 'refused', transactionHash };
  return { of: 'not-known', why: `the call in ${transactionHash} runs in two parts and only one of them took effect` };
}

/**
 * `vaultCallOnChain` asked of the indexer under every identifier of the transaction in turn, until one of them answers
 * anything but `not-seen`. An indexer that cannot be read throws, as `indexerTransactionsByIdentifier` does.
 */
export async function vaultCallByIdentifiers(
  reader: { byIdentifier(identifier: string): Promise<readonly TransactionByIdentifier[]> },
  built: { readonly identifiers: readonly string[]; readonly calls: readonly CallAsBuilt[] },
  call: VaultCall
): Promise<VaultCallOnChain> {
  for (const identifier of built.identifiers) {
    const seen = vaultCallOnChain(call, built.calls, await reader.byIdentifier(identifier));
    if (seen.of !== 'not-seen') return seen;
  }
  return { of: 'not-seen' };
}

/** Every transaction that deployed or called one vault, as the chain names them. */
export interface VaultTransactions {
  /**
   * Newest first, by hash. Throws `NoteIndexUnreadable` when the chain cannot answer yet and `NoteIndexUnaskable` when
   * the question is refused, and never answers a list it knows is shorter than the chain's.
   */
  of(vault: Hex): Promise<readonly Hex[]>;
}

/** What the search found for one note: its creating transaction, or why there is none. */
export type CreatingTransactionFound =
  | { readonly nonce: Hex; readonly createdIn: Hex }
  | {
      readonly nonce: Hex;
      readonly unresolved: string;
      /**
       * Every listed transaction carrying the note's commitment that was refused, then every unreadable one, in full:
       * `unresolved` shortens hashes, and a repair takes a whole one.
       */
      readonly candidates: readonly Hex[];
    };

/**
 * Which of the vault's listed transactions created each recovered note, newest first, each put to
 * `establishCreatingTransaction`. A chain that cannot be read leaves a reason on the note, never a throw.
 */
export async function creatingTransactionsAmong(
  vault: Hex,
  notes: readonly NoteCoin[],
  chain: { readonly transactions: VaultTransactions; readonly events: NoteEvents }
): Promise<{ found: CreatingTransactionFound[]; listed: number; read: number }> {
  if (notes.length === 0) return { found: [], listed: 0, read: 0 };

  const unresolvedAll = (why: string, listed: number, read: number) => ({
    found: notes.map((n): CreatingTransactionFound => ({ nonce: n.nonce, unresolved: why, candidates: [] })),
    listed,
    read
  });

  let listed: readonly Hex[];
  try {
    listed = await chain.transactions.of(vault);
  } catch (cause) {
    if (!(cause instanceof NoteIndexUnreadable || cause instanceof NoteIndexUnaskable)) throw cause;
    return unresolvedAll(
      `the chain could not list the transactions that acted on this vault (${(cause as Error).message})`,
      0,
      0
    );
  }

  const open = new Map<Hex, { coin: NoteCoin; commitment: string; refused: string[]; carriers: Hex[] }>();
  for (const n of notes) {
    open.set(n.nonce, { coin: n, commitment: await vaultNoteCommitment(n, vault), refused: [], carriers: [] });
  }
  const answered = new Map<Hex, Hex>();
  const unreadable: string[] = [];
  const unreadHashes: Hex[] = [];
  let read = 0;

  for (const hash of listed) {
    if (open.size === 0) break;
    const transaction = { hash };
    let served: readonly ServedEvent[];
    try {
      served = await chain.events.eventsOf(transaction);
      read += 1;
    } catch (cause) {
      if (!(cause instanceof NoteIndexUnreadable || cause instanceof NoteIndexUnaskable)) throw cause;
      // An unreadable transaction may still be the creator, so a note left unanswered says one was never asked.
      unreadable.push(`${hash.slice(0, 16)}… (${(cause as Error).message})`);
      unreadHashes.push(hash);
      continue;
    }
    for (const [nonce, want] of [...open]) {
      // Only a carrier of the commitment is asked: its refusal is news, and the reason is kept for the operator.
      const carries = served.some(
        (e) =>
          e.details.tag === 'zswapOutput' &&
          typeof e.details.commitment === 'string' &&
          bare(e.details.commitment) === bare(want.commitment)
      );
      if (!carries) continue;
      try {
        const { createdIn } = establishCreatingTransaction(served, { vault, commitment: want.commitment, transaction });
        answered.set(nonce, createdIn);
        open.delete(nonce);
      } catch (cause) {
        if (!(cause instanceof NoteIndexRefused || cause instanceof NoteIndexUnreadable)) throw cause;
        want.refused.push(`${hash.slice(0, 16)}… carries it and was refused: ${(cause as Error).message}`);
        want.carriers.push(hash);
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
        ? [
            `${unreadable.length} of them could not be read, so they were never asked: ${unreadable.slice(0, 3).join('; ')}`
          ]
        : [])
    ];
    return { nonce: n.nonce, unresolved: parts.join('. '), candidates: [...want.carriers, ...unreadHashes] };
  });
  return { found, listed: listed.length, read };
}

/**
 * The transaction in this vault's history that created the output with `commitment`, owned by this vault, newest
 * first; a proposal for `establishCreatingTransaction`. Null when every listed one was read and none carries it.
 * @throws {NoteIndexUnreadable} when one could not be read and none of the rest carries it.
 */
export async function transactionThatCreatedOutput(
  vault: Hex,
  commitment: string,
  chain: { readonly transactions: VaultTransactions; readonly events: NoteEvents }
): Promise<{ readonly transactionHash: Hex; readonly events: readonly ServedEvent[] } | null> {
  const mine = bare(vault);
  const wanted = bare(commitment);
  const listed = await chain.transactions.of(vault);
  let unread: Error | null = null;
  for (const hash of listed) {
    let served: readonly ServedEvent[];
    try {
      served = await chain.events.eventsOf({ hash });
    } catch (cause) {
      if (!(cause instanceof NoteIndexUnreadable || cause instanceof NoteIndexUnaskable)) throw cause;
      unread ??= cause;
      continue;
    }
    const carries = served.some(
      (e) =>
        e.details.tag === 'zswapOutput' &&
        typeof e.details.commitment === 'string' &&
        bare(e.details.commitment) === wanted &&
        typeof e.details.contract === 'string' &&
        bare(e.details.contract) === mine
    );
    if (carries) return { transactionHash: bare(hash) as Hex, events: served };
  }
  if (unread !== null) {
    throw new NoteIndexUnreadable(
      `none of the ${listed.length} transaction(s) the chain lists for this vault that could be read ` +
        `created this output, and at least one could not be read (${unread.message}). Read again.`
    );
  }
  return null;
}
