/**
 * **EVERYTHING THE CHAIN HAS DONE TO ONE CONTRACT, OLDEST FIRST, WITH THE STATE
 * EACH STEP LEFT** - as the indexer serves a contract's actions.
 *
 * A contract's rules may be changed any number of times, and the chain keeps
 * only the latest; what each change left behind is in the contract's history.
 * This reads that history in full and hands back, for every step, what kind of
 * step it was, which transaction made it, and the contract's state after it.
 * Whether that history vouches for the contract is decided elsewhere, over
 * what this returns.
 *
 * **A HISTORY THAT DID NOT REACH THE CONTRACT'S LATEST TRANSACTION IS AN ERROR,
 * NEVER A SHORT HISTORY.** A short one could leave out exactly the change that
 * matters, so the list is taken as complete only once the newest transaction
 * the indexer names for the contract has come past.
 */
import {
  everyThingSaid, NoteIndexUnaskable, NoteIndexUnreadable, theQuestionCannotBeAsked, type IndexerSocket,
} from './note-index.js';

const bare = (hex: string): string => hex.trim().toLowerCase().replace(/^0x/u, '');
const HEX_HASH = /^[0-9a-f]{64}$/u;
const HEX = /^([0-9a-f]{2})*$/u;

/** One step of a contract's history, as the indexer serves it. */
export interface ContractHistoryEntry {
  readonly kind: 'deploy' | 'call' | 'update';
  readonly transaction: string;
  /** The contract's state after this step, as its bytes. */
  readonly state: Uint8Array;
}

export interface ContractHistory {
  of(address: string): Promise<ContractHistoryEntry[]>;
}

const KINDS: Readonly<Record<string, ContractHistoryEntry['kind']>> = {
  ContractDeploy: 'deploy', ContractCall: 'call', ContractUpdate: 'update',
};

const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/** The history of a contract, read over the indexer this deployment names. */
export function indexerContractHistory(
  indexerUrl: string,
  indexerWsUrl: string,
  deps: {
    post?: typeof fetch;
    open?: (url: string, protocol: string) => IndexerSocket;
    timeoutMs?: number;
    /** How long after the latest transaction's actions stop arriving the history is closed. */
    settleMs?: number;
  } = {},
): ContractHistory {
  const post = deps.post ?? fetch;
  const open = deps.open
    ?? ((url: string, protocol: string) => new (globalThis as any).WebSocket(url, protocol) as IndexerSocket);
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const settleMs = deps.settleMs ?? 500;

  const newest = async (address: string): Promise<string> => {
    let body: any;
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
      throw new NoteIndexUnreadable(
        `the indexer at ${indexerUrl} could not be asked for this contract's latest transaction `
        + `(${(cause as Error)?.message ?? String(cause)}). Read again.`, { cause });
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const said = everyThingSaid(body.errors);
      throw theQuestionCannotBeAsked(body.errors)
        ? new NoteIndexUnaskable(`the indexer will not take the question for this contract's latest transaction: ${said}.`)
        : new NoteIndexUnreadable(`the indexer refused the question for this contract's latest transaction: ${said}.`);
    }
    if (body?.data?.contractAction == null) {
      throw new NoteIndexUnreadable('the indexer holds no transaction for this contract. Read again shortly.');
    }
    const hash = bare(String(body.data.contractAction.transaction?.hash ?? ''));
    if (!HEX_HASH.test(hash)) {
      throw new NoteIndexUnreadable('the indexer named this contract\'s latest transaction without a hash of sixty-four '
        + 'hex characters, so there is nothing to know its history is complete by. Read again.');
    }
    return hash;
  };

  return {
    async of(address) {
      const last = await newest(address);
      return new Promise<ContractHistoryEntry[]>((resolve, reject) => {
        const seen: ContractHistoryEntry[] = [];
        let done = false;
        let reachedLast = false;
        let settle: ReturnType<typeof setTimeout> | undefined;
        let socket: IndexerSocket;
        const finish = (outcome: { list: ContractHistoryEntry[] } | { error: Error }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(settle);
          try { socket.close(); } catch { /* the answer is already decided */ }
          if ('list' in outcome) resolve(outcome.list); else reject(outcome.error);
        };
        const short = (why: string) => finish({
          error: new NoteIndexUnreadable(
            `the indexer's history of this contract stopped before its latest transaction (${why}), after `
            + `${seen.length} step(s). A history known to be short is not used. Read again.`),
        });
        const timer = setTimeout(() => short(`no answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
        try {
          socket = open(indexerWsUrl, 'graphql-transport-ws');
        } catch (cause) {
          clearTimeout(timer);
          done = true;
          reject(new NoteIndexUnreadable(
            `the indexer's subscription at ${indexerWsUrl} could not be opened (${(cause as Error)?.message ?? String(cause)}).`,
            { cause }));
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
                query: 'subscription ($a: HexEncoded!, $o: BlockOffset) { contractActions(address: $a, offset: $o) '
                  + '{ __typename state transaction { hash } } }',
                /* From the first block: a contract is not acted on before it is created. */
                variables: { a: bare(address), o: { height: 0 } },
              },
            }));
            return;
          }
          if (m?.type === 'error' || (m?.type === 'next' && Array.isArray(m.payload?.errors) && m.payload.errors.length > 0)) {
            const errors = Array.isArray(m.payload) ? m.payload : (m.payload?.errors ?? []);
            const said = everyThingSaid(errors);
            finish({
              error: theQuestionCannotBeAsked(errors)
                ? new NoteIndexUnaskable(`the indexer will not take the question for this contract's history: ${said}.`)
                : new NoteIndexUnreadable(`the indexer refused the question for this contract's history: ${said}.`),
            });
            return;
          }
          if (m?.type === 'next') {
            const action = m.payload?.data?.contractActions;
            const hash = bare(String(action?.transaction?.hash ?? ''));
            const kind = KINDS[String(action?.__typename ?? '')];
            const state = bare(String(action?.state ?? ''));
            if (!HEX_HASH.test(hash)) { short('a step without a transaction hash of sixty-four hex characters'); return; }
            if (kind === undefined) { short(`a step of a kind this does not know (${String(action?.__typename)})`); return; }
            if (state === '' || !HEX.test(state)) { short('a step whose state is not hex'); return; }
            seen.push({ kind, transaction: hash, state: fromHex(state) });
            /*
             * One transaction can act on a contract more than once, and the
             * latest may be such a one, so the list is closed a moment after the
             * latest transaction's actions stop arriving rather than at the
             * first of them.
             */
            if (hash === last || reachedLast) {
              reachedLast = true;
              clearTimeout(settle);
              settle = setTimeout(() => finish({ list: [...seen] }), settleMs);
            }
            return;
          }
          if (m?.type === 'complete') short('the subscription ended');
        };
      });
    },
  };
}
