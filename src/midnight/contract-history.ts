/**
 * **EVERYTHING THE CHAIN HAS DONE TO ONE CONTRACT, OLDEST FIRST, WITH THE STATE
 * EACH STEP LEFT** - as the indexer serves a contract's actions.
 *
 * A contract's rules may be changed any number of times, and the chain keeps
 * only the latest; what each change left behind is in the contract's history.
 * This reads that history in full and hands back, for every step, what kind of
 * step it was, which transaction made it, and the contract's state after it;
 * for a call, that transaction's bytes too.
 * Whether that history vouches for the contract is decided elsewhere, over
 * what this returns.
 *
 * **A HISTORY THAT DID NOT REACH THE CONTRACT'S LATEST TRANSACTION IS AN ERROR,
 * NEVER A SHORT HISTORY.** A short one could leave out exactly the change that
 * matters, so the list is taken as complete only once the newest transaction
 * the indexer names for the contract has come past.
 */
import { bare, type IndexerSocket } from './note-index.js';
import { everyActionOf, latestActionOf, type ActionsWording } from './contract-actions.js';

const HEX_HASH = /^[0-9a-f]{64}$/u;
const HEX = /^([0-9a-f]{2})*$/u;

/** One step of a contract's history, as the indexer serves it. */
export interface ContractHistoryEntry {
  readonly kind: 'deploy' | 'call' | 'update';
  readonly transaction: string;
  /**
   * The contract's state as the indexer holds it for this step, as its bytes:
   * the state after the whole block the step is in, the same for every step of
   * this contract in that block. Steps of transactions that failed are listed too.
   * Two calls of one transaction, even to one circuit, are two steps.
   */
  readonly state: Uint8Array;
  /** The block the step's transaction is in: its height, and the time its author set for it, in milliseconds. */
  readonly block: { readonly height: number; readonly at: number };
  /** For a call, the name of the circuit it called, as the indexer names the call's entry point; absent for a deploy or an update. */
  readonly entryPoint?: string;
  /**
   * Whether the step's transaction succeeded in full, as the indexer records
   * its result: false for one that failed, one that succeeded only in part (the
   * indexer does not say in which part each step is), and one whose result it
   * does not give.
   */
  readonly succeeded: boolean;
  /**
   * For a call, its whole transaction as its bytes, as the indexer serves them:
   * the same for every step of that transaction. Which proposal each call
   * raised or closed is read from the operations they carry, which a state,
   * one per block, cannot say. Absent for a deploy or an update.
   */
  readonly raw?: Uint8Array;
}

export interface ContractHistory {
  of(address: string): Promise<ContractHistoryEntry[]>;
  /** The hash of the contract's latest transaction, as the indexer names it: a history read again only when it moves. */
  latest(address: string): Promise<string>;
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

  return {
    latest: (address) => latestActionOf(post, indexerUrl, address, HISTORY_WORDING),
    async of(address) {
      const last = await latestActionOf(post, indexerUrl, address, HISTORY_WORDING);
      let reachedLast = false;
      return everyActionOf<ContractHistoryEntry>(open, indexerWsUrl, address, HISTORY_FIELDS, timeoutMs, HISTORY_WORDING,
        (action, step) => {
          const hash = bare(String(action?.transaction?.hash ?? ''));
          const kind = KINDS[String(action?.__typename ?? '')];
          const state = bare(String(action?.state ?? ''));
          if (!HEX_HASH.test(hash)) { step.short('a step without a transaction hash of sixty-four hex characters'); return; }
          if (kind === undefined) { step.short(`a step of a kind this does not know (${String(action?.__typename)})`); return; }
          if (state === '' || !HEX.test(state)) { step.short('a step whose state is not hex'); return; }
          const height = action?.transaction?.block?.height;
          const at = action?.transaction?.block?.timestamp;
          if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0
            || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
            step.short('a step whose block has no height or time');
            return;
          }
          /*
           * At a ledger hard fork the indexer serves a contract's latest action
           * again, with its own transaction and entry point but its state
           * translated and dated at the fork block. It is not a step the chain
           * took, so it is not listed: counted, it would be a second anchor call
           * where there was one. Its state is the same state in the new
           * encoding, so the steps of that transaction carry it from then on,
           * and a reader of the state now reads one the new ledger decodes. A
           * step's own state is dated at its own block.
           */
          const dated = action?.stateAt?.height;
          if (typeof dated !== 'number' || !Number.isSafeInteger(dated) || dated < 0) { step.short('a step whose state is not dated at a block'); return; }
          const reEmitted = dated > height;
          const named = action?.entryPoint;
          const entryPoint = typeof named === 'string' ? named : '';
          if (kind === 'call' && entryPoint === '') { step.short('a call whose entry point is not named'); return; }
          const served = action?.transaction?.raw;
          const raw = typeof served === 'string' ? bare(served) : '';
          if (kind === 'call' && (raw === '' || !HEX.test(raw))) { step.short('a call whose transaction\'s bytes are not hex'); return; }
          const succeeded = action?.transaction?.transactionResult?.status === 'SUCCESS';
          if (reEmitted) {
            const translated = fromHex(state);
            step.seen.forEach((s, i) => { if (s.transaction === hash) step.seen[i] = { ...s, state: translated }; });
          } else step.seen.push({
            kind, transaction: hash, state: fromHex(state), block: { height, at }, ...(kind === 'call' ? { entryPoint, raw: fromHex(raw) } : {}), succeeded,
          });
          /*
           * One transaction can act on a contract more than once, and the
           * latest may be such a one, so the list is closed a moment after the
           * latest transaction's actions stop arriving rather than at the
           * first of them.
           */
          if (hash === last || reachedLast) {
            reachedLast = true;
            step.settleAfter(settleMs);
          }
        });
    },
  };
}

/** What the history asks the indexer for on each action. */
const HISTORY_FIELDS = '{ __typename state stateAt { height } transaction { hash raw block { height timestamp } '
  + '... on RegularTransaction { transactionResult { status } } } ... on ContractCall { entryPoint } }';

/** How a contract's history words each refusal. */
const HISTORY_WORDING: ActionsWording = {
  latestUnasked: (indexerUrl, cause) =>
    `the indexer at ${indexerUrl} could not be asked for this contract's latest transaction `
    + `(${(cause as Error)?.message ?? String(cause)}). Read again.`,
  latestUnaskable: (said) => `the indexer will not take the question for this contract's latest transaction: ${said}.`,
  latestRefused: (said) => `the indexer refused the question for this contract's latest transaction: ${said}.`,
  noneHeld: 'the indexer holds no transaction for this contract. Read again shortly.',
  latestUnhashed: 'the indexer named this contract\'s latest transaction without a hash of sixty-four '
    + 'hex characters, so there is nothing to know its history is complete by. Read again.',
  stoppedShort: (why, seen) =>
    `the indexer's history of this contract stopped before its latest transaction (${why}), after `
    + `${seen} step(s). A history known to be short is not used. Read again.`,
  cannotOpen: (indexerWsUrl, cause) =>
    `the indexer's subscription at ${indexerWsUrl} could not be opened (${(cause as Error)?.message ?? String(cause)}).`,
  listUnaskable: (said) => `the indexer will not take the question for this contract's history: ${said}.`,
  listRefused: (said) => `the indexer refused the question for this contract's history: ${said}.`,
};
