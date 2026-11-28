/**
 * **THE COMPANY ACCOUNT'S HISTORY, READ IN THE VAULT WORKER AT THE INDEXER THE PERSON'S OWN WALLET NAMES**, and
 * what is read off it: the anchors and who holds the account, which payments it records, which runs a removal has
 * outrun, and which seat each invitation took. Nothing here is taken from the company's service.
 */
import {
  accountDeployedIn,
  anchorsLandedIn,
  batchHoldersIn,
  runsOutrunIn,
  seatsNamedBy,
  vouchingRunsIn,
  type AnchorsOnChain
} from './governed-call-builder.js';
import { seatingsIn, seatsInvitedIn, type Seating } from './seats-invited-in.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { VaultBuilderDeps } from './vault-builder.js';
import type { VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/*
 * An account's history as last read, per indexer and account, with the latest
 * transaction it was read up to and the anchors and seatings read off it: read
 * again in full only when the account has acted since, because a history only
 * ever grows.
 */
type HistorySteps = Awaited<ReturnType<import('../../../src/midnight/contract-history.js').ContractHistory['of']>>;
/** One history read, with what is worked out from it once and kept while it stands: its anchors, and its seatings. */
type HistoryRead = {
  readonly latest: string;
  readonly steps: HistorySteps;
  anchors?: AnchorsOnChain;
  seatings?: readonly Seating[];
};
const historiesRead = new Map<string, HistoryRead>();

/**
 * **THE ACCOUNT'S HISTORY, READ HERE AT THE INDEXER THE PERSON'S OWN WALLET
 * NAMES**, every step oldest first: the one read the anchors and where the
 * company's proposals stand are both made from.
 */
export async function historyHere(
  d: Pick<WorkerDeps, 'historyAt'>,
  ask: { readonly account: string; readonly indexer: { indexerUri: string; indexerWsUri: string } },
  what: string
): Promise<HistoryRead> {
  const account = String(ask.account).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(account))
    throw new Error(`${what} not read: that is not a company account this device can name.`);
  const { indexerContractHistory } = await import('../../../src/midnight/contract-history.js');
  const history = (d.historyAt ?? ((i) => indexerContractHistory(i.indexerUri, i.indexerWsUri)))(ask.indexer);
  const key = `${ask.indexer.indexerUri}|${account}`;
  const latest = await history.latest(account);
  const known = historiesRead.get(key);
  if (known !== undefined && known.latest === latest) return known;
  const steps = await history.of(account);
  if (steps.length === 0) throw new Error(`${what} not read: its history at the indexer your wallet names is empty.`);
  const read = { latest, steps };
  historiesRead.set(key, read);
  return read;
}

/**
 * **EVERY HEAD THE ACCOUNT'S HISTORY SHOWS, ONE PER BLOCK, AND WHO HOLDS IT NOW, READ
 * HERE** from its history at the indexer the person's own wallet names, each
 * state read with the account's own functions: who holds it in the latest
 * state as a batch's header names them (`batchHoldersIn`), how it was
 * deployed, its committee then read the one way a wallet reads it
 * (`accountDeployedIn`, `seatsInAccountState`), and the seat bar in each
 * head's state read the one way a wallet reads it (`governanceInAccountState`,
 * under the key the account's own `policyBarKey` makes).
 */
async function anchorsOnChainHere(
  d: Pick<WorkerDeps, 'accountPure' | 'accountLedger' | 'runtimeState' | 'historyAt'>,
  ask: { readonly account: string; readonly indexer: { indexerUri: string; indexerWsUri: string } }
): Promise<AnchorsOnChain> {
  const history = await historyHere(d, ask, "the account's anchors were");
  if (history.anchors !== undefined) return history.anchors;
  const { steps } = history;
  const { governanceInAccountState, seatsInAccountState } = await import('midnight-identity/profile/account-state');
  const { policyBarKey } = d.accountPure as unknown as { policyBarKey?: () => Uint8Array };
  if (typeof policyBarKey !== 'function') {
    throw new Error(
      "this device was not given the account's function for the key its policy bar is kept under, so its anchors were not read."
    );
  }
  const barKey = Array.from(policyBarKey(), (b) => b.toString(16).padStart(2, '0')).join('');
  const landed = anchorsLandedIn(d, steps, (state) => governanceInAccountState(state, barKey).seatBar);
  const now = batchHoldersIn(d, steps[steps.length - 1]!.state);
  const deployed = accountDeployedIn(d, steps, seatsInAccountState);
  const read: AnchorsOnChain = {
    landed,
    now,
    seatsNow: seatsNamedBy(d, now.signers),
    deployed,
    vouching: vouchingRunsIn(d, steps)
  };
  history.anchors = read;
  return read;
}

/**
 * **WHICH OF THE LEAVES ASKED ABOUT THE ACCOUNT RECORDS PAID, READ HERE** from
 * the latest state of the account's history at the indexer the person's own
 * wallet names, never from the company's service: a leaf is paid once the
 * account's `movements` hold the entry its own `paidMovementOf` makes of it
 * (`recordedAt`). Keyed by each leaf, as 64 lower-case hex digits. A state that
 * cannot be read is refused, never an answer of "not paid". `false` means only
 * "not seen in the newest state this indexer holds": an indexer behind the
 * chain gives it for a leaf just paid, so it is never read as owed, and a
 * caller treats it as not yet seen.
 */
async function paidLeavesHere(
  d: Pick<WorkerDeps, 'accountPure' | 'accountLedger' | 'runtimeState' | 'historyAt'>,
  ask: {
    readonly account: string;
    readonly indexer: { indexerUri: string; indexerWsUri: string };
    readonly leaves: readonly string[];
  }
): Promise<Record<string, boolean>> {
  const movementOf = d.accountPure.paidMovementOf;
  if (d.accountLedger === undefined || typeof movementOf !== 'function') {
    throw new Error(
      "this device was not given the account's reader, so which payments the account records was not read. Reload the page"
    );
  }
  const leaves = ask.leaves.map((l) => String(l).toLowerCase());
  if (leaves.some((l) => !/^[0-9a-f]{64}$/u.test(l)))
    throw new Error('a payment was asked about by a leaf that is not thirty-two bytes');
  const { steps } = await historyHere(d, ask, 'which payments the account records was');
  const { recordedAt } = await import('./recorded-payments.js');
  const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const bytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
  const latest = steps[steps.length - 1]!.state;
  const paid = await recordedAt(
    { queryContractState: async () => d.runtimeState.deserialize(latest) },
    d.accountLedger,
    String(ask.account),
    leaves.map((l) => hex(movementOf.call(d.accountPure, bytes(l))) as Hex)
  );
  if (paid === null)
    throw new Error(
      'which payments the account records was not read: its latest state at the indexer your wallet names could not be read. Read again.'
    );
  return Object.fromEntries(leaves.map((l, i) => [l, paid[i]!]));
}

/**
 * **EVERY RUN OPEN NOW, WITH THE SIGNERS REMOVED SINCE ITS RAISE, READ HERE** from the account's history at the indexer the person's own
 * wallet names (`runsOutrunIn`), never from a list the company's service gives.
 */
async function runsOutrunHere(
  d: Pick<WorkerDeps, 'accountPure' | 'accountLedger' | 'runtimeState' | 'historyAt'>,
  ask: { readonly account: string; readonly indexer: { indexerUri: string; indexerWsUri: string } }
): Promise<Record<string, number>> {
  const { steps } = await historyHere(d, ask, 'which runs open on the chain a removal has outrun was');
  return runsOutrunIn(d, steps);
}

/**
 * The seat each invitation's proposal took, read from the account's own history in this worker (`seatsInvitedIn`). The
 * seatings are worked out once per history read and kept on it, so asking again decodes no transaction again; a refusal
 * keeps nothing, and is made again at the next ask.
 */
async function invitedSeatsHere(
  d: Pick<WorkerDeps, 'accountPure' | 'accountLedger' | 'runtimeState' | 'historyAt' | 'ledger'>,
  ask: {
    readonly account: string;
    readonly indexer: { indexerUri: string; indexerWsUri: string };
    readonly proposals: readonly string[];
  }
): Promise<Record<string, string | null>> {
  const history = await historyHere(d, ask, 'which seat each invitation took on the chain was');
  history.seatings ??= seatingsIn(d, history.steps, ask.account);
  return Object.fromEntries(seatsInvitedIn(history.seatings, ask.proposals));
}

/** The asks answered from the account's history; any other ask is answered elsewhere, so this gives undefined. */
export const accountHistoryAnswered = async (
  d: WorkerDeps,
  _withNetwork: VaultBuilderDeps,
  ask: VaultAsk
): Promise<VaultAnswer | undefined> => {
  switch (ask.ask) {
    case 'anchors-on-chain':
      return { id: ask.id, ok: true, ask: 'anchors-on-chain', ...(await anchorsOnChainHere(d, ask)) };
    case 'paid-leaves':
      return { id: ask.id, ok: true, ask: 'paid-leaves', paid: await paidLeavesHere(d, ask) };
    case 'runs-outrun':
      return { id: ask.id, ok: true, ask: 'runs-outrun', runs: await runsOutrunHere(d, ask) };
    case 'invited-seats':
      return { id: ask.id, ok: true, ask: 'invited-seats', seats: await invitedSeatsHere(d, ask) };
    default:
      return undefined;
  }
};
