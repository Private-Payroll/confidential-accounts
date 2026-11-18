/**
 * The questions the service asks Midnight's indexer about a vault: the note events of one transaction, the
 * transactions behind a list of identifiers, and every transaction that acted on a vault. Each answer is read
 * whole and refused when it is unreadable or incomplete, never shortened, because a short answer would say a
 * note was never created when the chain holds it. What the answers mean is decided in note-index.ts.
 */
import type { Hex } from '../core/crypto.js';
import { shownAddress } from '../core/networks.js';
import {
  bare, everyThingSaid, named, theQuestionCannotBeAsked, NoteIndexRefused, NoteIndexUnaskable, NoteIndexUnreadable,
  type NoteEvents, type ServedEvent, type VaultTransactions,
} from './note-index.js';
import { everyActionOf, latestActionOf, type ActionsWording } from './contract-actions.js';


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
          `the indexer at ${shownAddress(indexerUrl)} could not be asked about ${where} `
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

      const { Event } = await import('@midnight-ntwrk/midnight-js-protocol/v9');
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

/**
 * **ONE TRANSACTION AS THE INDEXER HOLDS IT, FOUND BY AN IDENTIFIER THIS DEVICE WORKED OUT ITSELF.**
 *
 * A transaction's identifiers are read off its own parts: each intent's binding commitment and each coin's value
 * commitment. Binding a transaction and merging the service's fee into it leave every one of them as it was, so a page
 * can look for the very transaction its person's wallet signed without being told its hash by anybody. Each entry
 * carries the result the ledger applied it with and every contract it called; nothing is judged here.
 */
export interface TransactionByIdentifier {
  /** The hash of the transaction as the chain finalised it, fee and all. */
  readonly hash: string;
  /** `SUCCESS`, `PARTIAL_SUCCESS` or `FAILURE` as the indexer reports it; null when it reports none. */
  readonly status: string | null;
  /** Each part's own result, which the indexer reports for a partial success only; null when it reports none. */
  readonly segments: ReadonlyArray<{ readonly id: number; readonly success: boolean }> | null;
  /** Every contract the transaction called or deployed, and the circuit it called (null for a deploy). */
  readonly calls: ReadonlyArray<{ readonly address: string; readonly entryPoint: string | null }>;
}

/**
 * Every transaction the indexer at `indexerUrl` lists under one identifier, with its result, each part's result and its
 * contract calls.
 * Refuses, rather than answering "none", when the indexer cannot be reached or will not answer: a missing answer is not
 * a transaction that never landed.
 */
export function indexerTransactionsByIdentifier(
  indexerUrl: string,
  post: typeof fetch = fetch,
): { byIdentifier(identifier: string): Promise<TransactionByIdentifier[]> } {
  return {
    async byIdentifier(identifier) {
      const where = named({ identifier: identifier as Hex });
      let body: any;
      try {
        const res = await post(indexerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: 'query ($offset: TransactionOffset!) { transactions(offset: $offset) { hash '
              + '... on RegularTransaction { transactionResult { status segments { id success } } } '
              + 'contractActions { address ... on ContractCall { entryPoint } } } }',
            variables: { offset: { identifier: bare(identifier) } },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          throw new Error(`the indexer answered HTTP ${res.status}`);
        }
        body = await res.json();
      } catch (cause) {
        throw new NoteIndexUnreadable(
          `the indexer at ${shownAddress(indexerUrl)} could not be asked about ${where} `
          + `(${(cause as Error)?.message ?? String(cause)}). That is not an answer about whether it landed.`, { cause });
      }
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const said = everyThingSaid(body.errors);
        if (theQuestionCannotBeAsked(body.errors)) {
          throw new NoteIndexUnaskable(`the indexer will not take this question about ${where}: ${said}.`);
        }
        throw new NoteIndexUnreadable(`the indexer refused the question about ${where}: ${said}.`);
      }
      const txs = body?.data?.transactions;
      if (!Array.isArray(txs)) {
        throw new NoteIndexUnreadable(`the indexer's answer about ${where} is not a list of transactions.`);
      }
      return txs.map((tx: any): TransactionByIdentifier => ({
        hash: bare(String(tx?.hash ?? '')),
        status: typeof tx?.transactionResult?.status === 'string' ? tx.transactionResult.status : null,
        segments: Array.isArray(tx?.transactionResult?.segments)
          ? tx.transactionResult.segments
            .filter((g: any) => Number.isInteger(g?.id) && typeof g?.success === 'boolean')
            .map((g: any) => ({ id: g.id as number, success: g.success as boolean }))
          : null,
        calls: Array.isArray(tx?.contractActions)
          ? tx.contractActions.map((a: any) => ({
            address: bare(String(a?.address ?? '')),
            entryPoint: typeof a?.entryPoint === 'string' ? a.entryPoint : null,
          }))
          : [],
      }));
    },
  };
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
  return {
    async of(vault) {
      const last = await latestActionOf(post, indexerUrl, vault, VAULT_WORDING);
      const list = await everyActionOf<Hex>(open, indexerWsUrl, vault, '{ transaction { hash } }', timeoutMs, VAULT_WORDING,
        (action, step) => {
          const hash = bare(String(action?.transaction?.hash ?? ''));
          if (!HEX_HASH.test(hash)) {
            step.short('a transaction without a hash of sixty-four hex characters');
            return;
          }
          if (!step.seen.includes(hash as Hex)) step.seen.push(hash as Hex);
          if (hash === last) step.finish([...step.seen].reverse());
        });
      return list;
    },
  };
}

const HEX_HASH = /^[0-9a-f]{64}$/;

/** How the vault's transaction list words each refusal. */
const VAULT_WORDING: ActionsWording = {
  latestUnasked: (indexerUrl, cause) =>
    `the indexer at ${indexerUrl} could not be asked for this vault's latest transaction `
    + `(${(cause as Error)?.message ?? String(cause)}). Check this machine can reach the `
    + 'indexer, then read again.',
  latestUnaskable: (said) =>
    `the indexer will not take the question for this vault's latest transaction: ${said}. `
    + 'Asking again changes nothing; this client and that indexer are out of step.',
  latestRefused: (said) => `the indexer refused the question for this vault's latest transaction: ${said}.`,
  noneHeld: 'the indexer holds no transaction for this vault. A vault the node has just finalised can '
    + 'be missing from the indexer for a moment; read again shortly.',
  latestUnhashed: 'the indexer named this vault\x27s latest transaction without a hash of sixty-four hex '
    + 'characters, so there is nothing to know the list is complete by. Read again.',
  stoppedShort: (why, seen) =>
    `the indexer's list of this vault's transactions stopped before the latest one (${why}), `
    + `after ${seen} transaction(s). A list known to be short is not used. Read again.`,
  cannotOpen: (indexerWsUrl, cause) =>
    `the indexer's subscription at ${indexerWsUrl} could not be opened `
    + `(${(cause as Error)?.message ?? String(cause)}). Read again.`,
  listUnaskable: (said) =>
    `the indexer will not take the question for this vault's transactions: ${said}. `
    + 'Asking again changes nothing; this client and that indexer are out of step.',
  listRefused: (said) => `the indexer refused the question for this vault's transactions: ${said}.`,
};
