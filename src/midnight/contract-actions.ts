/**
 * Every action the chain has taken on one contract, asked of Midnight's indexer in two questions: the newest action
 * over HTTP, which names the transaction the list has to reach, then every action from the start of the chain over
 * the indexer's subscription, the one query that lists a contract's actions rather than answering for one block.
 * A list that stopped before that newest transaction is refused, never handed back short, because a short list could
 * leave out exactly the step a reader needed. A vault's transaction list and a contract's history both read through
 * here; each names the fields it asks for, what it keeps from each action, and how its refusals read.
 */
import { shownAddress } from '../core/networks.js';
import {
  bare, everyThingSaid, theQuestionCannotBeAsked, NoteIndexUnaskable, NoteIndexUnreadable, type IndexerSocket,
} from './note-index.js';

const HEX_HASH = /^[0-9a-f]{64}$/;

/** One action as the indexer serves it, every field unchecked until a reader checks it. */
export type ServedAction = {
  readonly __typename?: unknown;
  readonly state?: unknown;
  readonly entryPoint?: unknown;
  readonly transaction?: {
    readonly hash?: unknown;
    readonly raw?: unknown;
    readonly block?: { readonly height?: unknown; readonly timestamp?: unknown };
    readonly transactionResult?: { readonly status?: unknown };
  };
} | null | undefined;

/** An HTTP answer to the question for the newest action. */
type LatestAnswer = { errors?: unknown; data?: { contractAction?: { transaction?: { hash?: unknown } } | null } } | undefined;

/** One message on the indexer's subscription. */
type Frame = { type?: unknown; payload?: { errors?: unknown; data?: { contractActions?: ServedAction } } | unknown[] } | null;

/** How each refusal reads for one kind of reader: the vault's list or a contract's history. */
export interface ActionsWording {
  /** The newest action could not be asked for at all. */
  readonly latestUnasked: (indexerUrl: string, cause: unknown) => string;
  /** The indexer will never take the question for the newest action. */
  readonly latestUnaskable: (said: string) => string;
  /** The indexer refused the question for the newest action this once. */
  readonly latestRefused: (said: string) => string;
  /** The indexer holds no action for the contract. */
  readonly noneHeld: string;
  /** The newest action came back without a readable transaction hash. */
  readonly latestUnhashed: string;
  /** The list stopped before the newest action, after `seen` entries. */
  readonly stoppedShort: (why: string, seen: number) => string;
  /** The subscription could not be opened. */
  readonly cannotOpen: (indexerWsUrl: string, cause: unknown) => string;
  /** The indexer will never take the question for the list. */
  readonly listUnaskable: (said: string) => string;
  /** The indexer refused the question for the list this once. */
  readonly listRefused: (said: string) => string;
}

/**
 * The hash of the newest transaction that acted on `address`, as the indexer names it. Refuses when the indexer
 * cannot be reached, refuses the question, holds no action for the contract, or names one without a hash of
 * sixty-four hex characters: without that hash nothing can tell a complete list from a short one.
 */
export async function latestActionOf(
  post: typeof fetch,
  indexerUrl: string,
  address: string,
  say: ActionsWording,
): Promise<string> {
  let body: LatestAnswer;
  try {
    const res = await post(indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query ($a: HexEncoded!) { contractAction(address: $a) { transaction { hash } } }',
        variables: { a: bare(address) },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`the indexer answered HTTP ${res.status}`);
    body = await res.json();
  } catch (cause) {
    throw new NoteIndexUnreadable(say.latestUnasked(shownAddress(indexerUrl), cause), { cause });
  }
  const errors = body?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const said = everyThingSaid(errors);
    throw theQuestionCannotBeAsked(errors)
      ? new NoteIndexUnaskable(say.latestUnaskable(said))
      : new NoteIndexUnreadable(say.latestRefused(said));
  }
  const action = body?.data?.contractAction;
  if (action == null) throw new NoteIndexUnreadable(say.noneHeld);
  const hash = bare(String(action.transaction?.hash ?? ''));
  if (!HEX_HASH.test(hash)) throw new NoteIndexUnreadable(say.latestUnhashed);
  return hash;
}

/** What a reader can do with each action the subscription serves. */
export interface ActionStep<T> {
  /** What has been kept so far, in the order served. */
  readonly seen: T[];
  /** Refuse the whole list: it stopped, or served something unreadable, before the newest action. */
  short(why: string): void;
  /** Hand back `list` as complete. */
  finish(list: T[]): void;
  /** Hand back what has been kept once `ms` pass with no further call; a later call starts the wait again. */
  settleAfter(ms: number): void;
}

/**
 * Every action on `address` from the start of the chain, as `keep` reads each one. The subscription asks for
 * `fields` on each action; `keep` is handed the action as served and decides what is kept and when the list is
 * complete. Refuses when the socket cannot be opened, fails, closes, or ends, when an answer is not JSON, when the
 * indexer refuses the question, and when `timeoutMs` passes first.
 */
export function everyActionOf<T>(
  open: (url: string, protocol: string) => IndexerSocket,
  indexerWsUrl: string,
  address: string,
  fields: string,
  timeoutMs: number,
  say: ActionsWording,
  keep: (action: ServedAction, step: ActionStep<T>) => void,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const seen: T[] = [];
    let done = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let socket: IndexerSocket;
    const finish = (outcome: { list: T[] } | { error: Error }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settle);
      try { socket.close(); } catch { /* the answer is already decided */ }
      if ('list' in outcome) resolve(outcome.list); else reject(outcome.error);
    };
    const short = (why: string) => finish({ error: new NoteIndexUnreadable(say.stoppedShort(why, seen.length)) });
    const step: ActionStep<T> = {
      seen,
      short,
      finish: (list) => finish({ list }),
      settleAfter: (ms) => {
        clearTimeout(settle);
        settle = setTimeout(() => finish({ list: [...seen] }), ms);
      },
    };
    const timer = setTimeout(() => short(`no answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    try {
      socket = open(indexerWsUrl, 'graphql-transport-ws');
    } catch (cause) {
      clearTimeout(timer);
      done = true;
      reject(new NoteIndexUnreadable(say.cannotOpen(shownAddress(indexerWsUrl), cause), { cause }));
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    socket.onerror = () => short('the connection failed');
    socket.onclose = () => short('the indexer closed the connection');
    socket.onmessage = (ev) => {
      let m: Frame;
      try { m = JSON.parse(String(ev.data)); } catch { short('an answer that is not JSON'); return; }
      if (m?.type === 'connection_ack') {
        socket.send(JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: {
            query: `subscription ($a: HexEncoded!, $o: BlockOffset) { contractActions(address: $a, offset: $o) ${fields} }`,
            variables: { a: bare(address), o: { height: 0 } },
          },
        }));
        return;
      }
      const payload = m?.payload;
      const served = Array.isArray(payload) ? undefined : payload;
      if (m?.type === 'error' || (m?.type === 'next' && Array.isArray(served?.errors) && served.errors.length > 0)) {
        const listed = served?.errors;
        const errors: unknown[] = Array.isArray(payload) ? payload : (Array.isArray(listed) ? listed : []);
        const said = everyThingSaid(errors);
        finish({
          error: theQuestionCannotBeAsked(errors)
            ? new NoteIndexUnaskable(say.listUnaskable(said))
            : new NoteIndexUnreadable(say.listRefused(said)),
        });
        return;
      }
      if (m?.type === 'next') {
        keep(served?.data?.contractActions, step);
        return;
      }
      if (m?.type === 'complete') short('the subscription ended');
    };
  });
}
