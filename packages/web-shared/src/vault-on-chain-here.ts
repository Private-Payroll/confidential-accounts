/**
 * A vault as the chain holds it, read in the vault worker (never the page: the indexer reader reaches the ledger's
 * WebAssembly) from the indexer the person's own wallet names, and refused by name where the wallet names none.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import type { Hex } from '../../../src/core/crypto.js';
import { decodedState } from '../../../src/midnight/decoded-state.js';
import { outputsMadeFor, vaultOutputHistoryFrom } from '../../../src/midnight/deposit-nonce.js';
import {
  HISTORIES_AT_ONCE,
  indexerVaultHistories,
  type VaultHistories
} from '../../../src/midnight/indexer-queries.js';
import {
  type EventOnTheWire,
  eventOnTheWire,
  indexerNoteEvents,
  indexerVaultTransactions,
  type NoteEvents,
  type ServedEvent,
  transactionThatCreatedOutput,
  type VaultTransactions
} from '../../../src/midnight/note-index.js';
import { publicHoldingsOf } from '../../../src/midnight/public-balance.js';
import { circuitsNotThisBuilds, startingLedgerFrom } from '../../../src/midnight/vault-circuits.js';
import { assertVaultLedgerIsThisBuilds } from '../../../src/midnight/vault-ledger-shape.js';
import { inParts } from './company-view-batch.js';
import {
  type AccountAtOneBlock,
  accountAtOneBlockOver,
  accountCallChainOf,
  type AccountCallChainOnTheWire,
  atOneBlockOver,
  type BlockReader,
  payoutChainOf,
  type PayoutChainOnTheWire,
  toBase64,
  type VaultAtOneBlock
} from './one-block-read.js';
import { type IndexerEndpoints, publicDataProviderFor, refuseEndpointsThatCannotWork } from './public-data.js';
import { boundedRead } from './read-bound.js';
import type { VaultOnChainOnTheWire } from './vault-worker-client.js';
export { accountAtOneBlockOver, accountCallChainOf, atOneBlockOver, payoutChainOf };
export type { AccountAtOneBlock, BlockReader, VaultAtOneBlock };
export { type MoneyOnChain, moneyOnChainOf, ON_CHAIN } from './money-on-chain.js';

/** How a refusal about this vault's circuits or its account's begins: it says plainly that no money goes in or out. */
const NO_MONEY = 'no money goes in or out of this vault';

/** Where the chain is read from: one contract's state now, a vault's transactions, and each transaction's events. */
export interface VaultChainSource {
  contractState(address: string): Promise<{ serialize(): Uint8Array } | null | undefined>;
  /** The states of many contracts read in one request, in the order asked; null where it holds none. Absent, each is read alone. */
  contractStates?(addresses: readonly string[]): Promise<readonly ({ serialize(): Uint8Array } | null)[]>;
  /** The state the contract's deploy left at `address`, as the chain recorded it; null when it holds no deploy there. */
  deployState(address: string): Promise<unknown>;
  readonly transactions: VaultTransactions;
  readonly events: NoteEvents;
  /** Every transaction of many vaults with its events, in one request; without it each vault's history is read alone. */
  readonly histories?: VaultHistories;
  /** The vault's state, the commitment tree, the ledger's parameters and the account's state, all as the newest block holds them; null while either contract is not held there. */
  atOneBlock(vault: string, account: string): Promise<VaultAtOneBlock | null>;
  /** The account's state and the ledger's parameters as the newest block holds them, which a call to the account alone is built on; null while the account is not held there. */
  accountAtOneBlock?(account: string): Promise<{
    readonly blockHash: string;
    readonly account: { serialize(): Uint8Array };
    readonly parameters: { serialize(): Uint8Array };
  } | null>;
  /** Whether the indexer holds a contract at `account`, with the time of the newest block it names in the same answer. */
  accountPresence?(account: string): Promise<AccountPresence>;
}

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

/** What one read of the indexer says of an address: held or not, and the newest block's height and time (ms) as it names them. */
interface AccountPresence {
  readonly held: boolean;
  readonly blockHeight: number;
  readonly blockTime: number;
}

/**
 * Whether the indexer holds a contract at an address, with the chain's own time: `held: false` is only a clean answer
 * with a block and a null contract; a refusal, an error, a missing block or another shape throws.
 */
export async function accountPresenceAt(
  indexerUri: string,
  account: string,
  fetcher: typeof fetch = fetch
): Promise<AccountPresence> {
  const { response, body } = await boundedRead('The network indexer', async (signal) => {
    const answered = await fetcher(indexerUri, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query ($a: HexEncoded!) { block { height timestamp } contractAction(address: $a) { __typename } }',
        variables: { a: account }
      }),
      signal
    });
    if (!answered.ok) return { response: answered, body: null };
    const parsed: {
      errors?: unknown;
      data?: { block?: { height?: unknown; timestamp?: unknown } | null; contractAction?: unknown };
    } = await answered.json();
    return { response: answered, body: parsed };
  });
  if (!response.ok || body === null) throw new Error(`the indexer answered ${response.status}.`);
  if (body.errors !== undefined) throw new Error('the indexer refused the read.');
  const block = body.data?.block;
  const height = block?.height;
  const time = block?.timestamp;
  if (!isSafeInteger(height) || !isSafeInteger(time) || time <= 0)
    throw new Error('the indexer named no newest block.');
  if (body.data === undefined || !('contractAction' in body.data))
    throw new Error('the indexer did not answer for the address.');
  return { held: body.data.contractAction !== null, blockHeight: height, blockTime: time };
}

/** The chain as the indexer the wallet names serves it. */
export const vaultChainSourceAt = (indexer: IndexerEndpoints): VaultChainSource => {
  refuseEndpointsThatCannotWork(indexer);
  const reader = publicDataProviderFor(indexer);
  return {
    /* Decoded here with the contract runtime, so a refusal can read the state's authority and circuits. */
    contractState: async (address) =>
      (await import('../../../src/midnight/contract-state-at.js')).contractStateAt(await reader, address),
    contractStates: (addresses) => contractStatesAt(indexer.indexerUri, addresses),
    deployState: async (address) => {
      const read = await (await reader).queryDeployContractState(address);
      if (read === null) return null;
      const { ContractState } = await import('@midnight-ntwrk/compact-runtime');
      return decodedState(read.contractState, ContractState);
    },
    transactions: indexerVaultTransactions(indexer.indexerUri, indexer.indexerWsUri),
    events: indexerNoteEvents(indexer.indexerUri),
    histories: indexerVaultHistories(indexer.indexerUri),
    /* The reader is made once with the source and awaited by every read, never opened again. */
    atOneBlock: async (vault, account) => atOneBlockOver(await reader, vault, account),
    accountAtOneBlock: async (account) => accountAtOneBlockOver(await reader, account),
    accountPresence: (account) => accountPresenceAt(indexer.indexerUri, account)
  };
};

const messageOf = (e: unknown): string => {
  const message: unknown = typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined;
  return typeof message === 'string' ? message : String(e);
};

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Reads one vault: `onChain: false` where the indexer holds no state, a refusal where a history cannot be read in full.
 * With `accountAddress` it also says whether the account's circuits are this build's, refusing an account with no state.
 */
export async function readVaultOnChain(
  d: VaultReadDeps,
  source: VaultChainSource,
  vault: string,
  accountAddress?: string
): Promise<VaultOnChainOnTheWire> {
  const served = await source.contractState(vault);
  if (served === null || served === undefined) return { onChain: false };
  const accountCircuits =
    accountAddress === undefined ? undefined : accountCircuitsFrom(d, await source.contractState(accountAddress));
  return vaultReadFrom(d, source, vault, served, accountCircuits);
}

/** A vault's ledger as this build reads it: what its start is read from, and its notes and lists. */
type VaultLedgerRead = Parameters<typeof startingLedgerFrom>[0] & {
  notes: Iterable<Uint8Array>;
  nonceCommitment: Uint8Array;
  splitJournal: Iterable<[Uint8Array, Uint8Array]>;
};

/** What a vault is read with: its compiled vault, the account's compiled digests, and the runtime that reads a state. */
interface VaultReadDeps {
  readonly vault: {
    ledger(data: unknown): VaultLedgerRead;
    pureCircuits: { copiesWrittenKey(): Uint8Array };
    readonly expectedVk?: Readonly<Record<string, string>>;
  };
  readonly accountExpectedVk?: Readonly<Record<string, string>>;
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
}

/** What the account's circuits were found to be, as `readVaultOnChain` hands it on; undefined when no account was asked. */
type AccountCircuitsRead = ReturnType<typeof accountCircuitsFrom> | undefined;

/** One vault's answer from the state the indexer served for it (never null here) and what was found of the account's circuits. */
async function vaultReadFrom(
  d: VaultReadDeps,
  source: Pick<VaultChainSource, 'transactions' | 'events'>,
  vault: string,
  served: { serialize(): Uint8Array },
  accountCircuits: AccountCircuitsRead,
  made?: ReadonlySet<string>
): Promise<VaultOnChainOnTheWire> {
  const bytes = served.serialize();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the runtime's state is typed unknown by the callers' deps and is read for its data here.
  const state = d.runtimeState.deserialize(bytes) as { data: unknown };
  const circuits = circuitsNotThisBuilds(state, d.vault.expectedVk, sha256, NO_MONEY, "the vault's");
  const ledger = d.vault.ledger(state.data);
  let notesFromThisBuild = true;
  let notesWhy: string | undefined;
  try {
    await assertVaultLedgerIsThisBuilds(state);
  } catch (e) {
    notesFromThisBuild = false;
    notesWhy = messageOf(e);
  }
  let started = false;
  let retired = false;
  let account: string | null = null;
  try {
    const start = startingLedgerFrom(ledger, d.vault.pureCircuits.copiesWrittenKey());
    started = start.started;
    retired = start.retired;
    account = String(start.account).toLowerCase();
  } catch {
    /* a state that is not a vault's cannot be read for its account or start: `account` stays null, which the reader of this answer takes as unreadable, never as pinned elsewhere */
  }
  const everCreated = [
    ...(made ??
      (await vaultOutputHistoryFrom({ transactions: source.transactions, events: source.events }).everCreated(
        vault as Hex
      )))
  ];
  let publicBalances: { token: string; amount: string }[] | undefined;
  let publicBalancesWhy: string | undefined;
  try {
    publicBalances = publicHoldingsOf(served).map((h) => ({ token: h.token, amount: h.amount.toString() }));
  } catch (e) {
    publicBalancesWhy = messageOf(e);
  }
  return {
    onChain: true,
    state: toBase64(bytes),
    /* Notes read off a ledger of another shape are about whatever field sits in that place: not handed on at all. */
    ...(notesFromThisBuild
      ? {
          notes: [...ledger.notes].map(hexOf),
          nonceCommitment: hexOf(ledger.nonceCommitment),
          splitJournal: [...ledger.splitJournal].map(([spent, masked]) => [hexOf(spent), hexOf(masked)] as const)
        }
      : {}),
    notesFromThisBuild,
    ...(notesWhy === undefined ? {} : { notesWhy }),
    /* The vault's own retired mark: read, like the notes, only off this build's ledger. */
    ...(notesFromThisBuild ? { retired } : {}),
    everCreated,
    account,
    started,
    ...(publicBalances === undefined ? { publicBalancesWhy: publicBalancesWhy! } : { publicBalances }),
    circuits,
    ...(accountCircuits === undefined ? {} : { accountCircuits })
  };
}

/** The company account's circuits from the state the chain holds now (`served`), or why they are not this app's or not there. */
function accountCircuitsFrom(
  d: Pick<VaultReadDeps, 'accountExpectedVk' | 'runtimeState'>,
  served: { serialize(): Uint8Array } | null | undefined
): { readonly why: string; readonly circuit: string | null } | null {
  if (served === null || served === undefined) {
    return {
      why:
        `${NO_MONEY}: the chain shows no company account at the address it pays out on, so whose approvals it ` +
        'pays out on cannot be checked. Nothing was sent.',
      circuit: null
    };
  }
  return circuitsNotThisBuilds(
    d.runtimeState.deserialize(served.serialize()),
    d.accountExpectedVk,
    sha256,
    `${NO_MONEY}, because the company's account it pays out on is not the one this app was built for`,
    "the account's"
  );
}

/** What a step out of the vault is built on at one block, as base64 of each state's bytes; null while the indexer holds either contract at no block. */
export async function readChainAtOneBlock(
  source: VaultChainSource,
  vault: string,
  account: string
): Promise<PayoutChainOnTheWire | null> {
  return payoutChainOf(await source.atOneBlock(vault, account));
}

/** What a call to the account alone is built on at one block, as base64 of each state's bytes; null while the indexer holds the account at no block. */
export async function readAccountCallChain(
  source: VaultChainSource,
  account: string
): Promise<AccountCallChainOnTheWire | null> {
  if (source.accountAtOneBlock === undefined) {
    throw new Error(
      "this page cannot read the company's account at the indexer your wallet names. Reload the page to use the current build"
    );
  }
  return accountCallChainOf(await source.accountAtOneBlock(account));
}

/** Whether the indexer the person's wallet names holds a contract at `account`, with the newest block's time. Throws when it cannot say. */
export async function readAccountPresence(source: VaultChainSource, account: string): Promise<AccountPresence> {
  if (source.accountPresence === undefined)
    throw new Error(
      "this page cannot read whether the company's account is on the chain. Reload the page to use the current build"
    );
  return source.accountPresence(account);
}

/** Every zswap event the chain holds for one transaction, as it crosses back to the page. */
export async function readEventsOf(source: VaultChainSource, transactionHash: string): Promise<EventOnTheWire[]> {
  return (await source.events.eventsOf({ hash: transactionHash })).map(eventOnTheWire);
}

/** The vault's own transaction that created the output with this commitment, with its events; null while none the chain lists did. */
export async function readCreatedBy(
  source: VaultChainSource,
  vault: string,
  commitment: string
): Promise<{ transactionHash: string; events: EventOnTheWire[] } | null> {
  const found = await transactionThatCreatedOutput(vault, commitment, source);
  return found === null ? null : { transactionHash: found.transactionHash, events: found.events.map(eventOnTheWire) };
}

/** A contract's state as the indexer served it, decoded with the contract runtime, or null where it holds none. */
type ServedState = { serialize(): Uint8Array } | null;

const LEFT_OUT = "the indexer's answer left a contract out, so nothing of it is used.";

/**
 * How many contracts one request names: the indexer bounds a query's complexity (default 200), each contract costs 2
 * and the block that dates them 3, so 98 fit and this leaves room.
 */
export const STATES_AT_ONCE = 96;

/** Refuses an address that is not a contract's, so no request names it: the indexer refuses a whole request for one. */
const askable = async (address: string): Promise<void> => {
  const utils = await import('@midnight-ntwrk/midnight-js-utils');
  const check: (a: string) => void = utils.assertIsContractAddress;
  try {
    check(address);
  } catch (e) {
    throw new Error(`${String(address)} is not a contract's address, so no read of it was asked of the indexer.`, {
      cause: e
    });
  }
};

/**
 * The states of `addresses` in parts of `STATES_AT_ONCE`, one request each, every answer in the order asked. Each state is the newest
 * the indexer holds when it answers, so states of one request can be of different blocks; an answer that leaves a contract out, errs or is of another shape throws.
 */
export async function contractStatesAt(
  indexerUri: string,
  addresses: readonly string[],
  fetcher: typeof fetch = fetch
): Promise<ServedState[]> {
  for (const a of addresses) await askable(a);
  return inParts(addresses, (part) => statesInOneRequest(indexerUri, part, fetcher), STATES_AT_ONCE);
}

/** The newest block as the indexer's JSON gives it, which dates every state of the request. */
interface IndexerBlock {
  readonly protocolVersion: number;
  readonly ledgerParameters?: unknown;
}

/** Asks for the states of `addresses` in one request: one alias for each address, in the order asked. */
async function statesInOneRequest(
  indexerUri: string,
  addresses: readonly string[],
  fetcher: typeof fetch
): Promise<ServedState[]> {
  if (addresses.length === 0) return [];
  const query =
    `query (${addresses.map((_, i) => `$a${i}: HexEncoded!`).join(', ')}) { block { protocolVersion ledgerParameters } ` +
    `${addresses.map((_, i) => `c${i}: contract(address: $a${i}) { state }`).join(' ')} }`;
  const variables = Object.fromEntries(addresses.map((a, i) => [`a${i}`, a]));
  const { response, body } = await boundedRead('The network indexer', async (signal) => {
    const answered = await fetcher(indexerUri, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal
    });
    if (!answered.ok) return { response: answered, body: null };
    const parsed: {
      errors?: unknown;
      data?: ({ block?: IndexerBlock | null } & Record<`c${number}`, { state?: unknown } | null>) | null;
    } = await answered.json();
    return { response: answered, body: parsed };
  });
  if (!response.ok || body === null) throw new Error(`the indexer answered ${response.status}.`);
  if (body.errors !== undefined) throw new Error('the indexer refused the read.');
  const data = body.data;
  if (typeof data !== 'object' || data === null) throw new Error(LEFT_OUT);
  const answers = addresses.map((_, i) => {
    const c = Object.hasOwn(data, `c${i}`) ? data[`c${i}`] : undefined;
    if (c === undefined) throw new Error(LEFT_OUT);
    if (c === null || c.state === null || c.state === undefined) return null;
    if (typeof c.state !== 'string') throw new Error('the indexer served a contract state that is not text.');
    return c.state;
  });
  if (answers.every((a): a is null => a === null)) return answers;
  const block = data.block;
  if (block === null || block === undefined)
    throw new Error('the indexer served a contract state but no block to date it.');
  await parametersOfTheBlocksEra(block);
  return Promise.all(
    answers.map((hex) => (hex === null ? Promise.resolve(null) : datedState(hex, block.protocolVersion)))
  );
}

/** Refuses a block whose ledger parameters are of another era than its protocol version, as the SDK's read of one state does. */
async function parametersOfTheBlocksEra(block: IndexerBlock): Promise<void> {
  const { protocolVersionToLedger } = await import('@midnight-ntwrk/midnight-js-protocol');
  const { isHex, ledgerVersionOfLedgerParameters } = await import('@midnight-ntwrk/midnight-js-utils');
  const era = protocolVersionToLedger(block.protocolVersion, 'read');
  const hex = block.ledgerParameters;
  if (typeof hex !== 'string' || !isHex(hex))
    throw new Error('the indexer served no ledger parameters, in hex, with the block that dates its states.');
  const bare = hex.replace(/^0x/u, '');
  const raw = Uint8Array.from(bare.match(/../gu) ?? [], (b) => parseInt(b, 16));
  if (ledgerVersionOfLedgerParameters(raw) !== era)
    throw new Error('the indexer served a block whose ledger parameters are of another era than its protocol version.');
}

/** One state, dated by the block's protocol version and decoded with the contract runtime, as the SDK's read of one state does. */
async function datedState(hex: string, protocolVersion: number): Promise<{ serialize(): Uint8Array }> {
  const { protocolVersionToLedger } = await import('@midnight-ntwrk/midnight-js-protocol');
  protocolVersionToLedger(protocolVersion, 'read');
  const { isHex, ledgerVersionOfContractState } = await import('@midnight-ntwrk/midnight-js-utils');
  if (!isHex(hex)) throw new Error('the indexer served a contract state that is not hex.');
  const bare = hex.replace(/^0x/u, '');
  const raw = Uint8Array.from(bare.match(/../gu) ?? [], (b) => parseInt(b, 16));
  const { SerializedContractState } = await import('@midnight-ntwrk/midnight-js-types');
  const { ContractState } = await import('@midnight-ntwrk/compact-runtime');
  return decodedState(SerializedContractState.fromBytes(ledgerVersionOfContractState(raw), raw), ContractState);
}

/** One vault's answer, named by the vault it is about. */
interface VaultReadOnTheWire {
  readonly vault: string;
  readonly read: VaultOnChainOnTheWire;
}

/** The states of `asked`, in parts of 256 when the source can read many (each read in its indexer's parts), one state at a time when it cannot. */
const statesOf = (
  source: VaultChainSource,
  asked: readonly string[]
): Promise<readonly ({ serialize(): Uint8Array } | null | undefined)[]> => {
  const together = source.contractStates;
  return together !== undefined
    ? inParts(asked, (part) => together(part))
    : Promise.all(asked.map((a) => source.contractState(a)));
};

/**
 * Every vault a step reads, read together: each vault's answer is exactly the one `readVaultOnChain` gives for it alone, in
 * one `contractStates` call for each 256 addresses; with `account`, its circuits are worked out once from the same request.
 */
export async function readVaultsOnChain(
  d: VaultReadDeps,
  source: VaultChainSource,
  addresses: readonly string[],
  account?: string
): Promise<VaultReadOnTheWire[]> {
  const served = await statesOf(source, account === undefined ? addresses : [...addresses, account]);
  let circuits: { readonly found: AccountCircuitsRead } | null = null;
  /* Worked out only when some vault is there to carry it, as a read of one vault works it out only then. */
  const accountCircuits = (): AccountCircuitsRead => {
    if (account === undefined) return undefined;
    circuits ??= { found: accountCircuitsFrom(d, served[addresses.length]) };
    return circuits.found;
  };
  const made = await createdTogether(
    source,
    addresses.filter((_, i) => served[i] !== null && served[i] !== undefined)
  );
  return Promise.all(
    addresses.map(async (vault, i) => {
      const state = served[i];
      return {
        vault,
        read:
          state === null || state === undefined
            ? { onChain: false }
            : await vaultReadFrom(d, source, vault, state, accountCircuits(), made.get(vault))
      };
    })
  );
}

/**
 * Every coin the chain ever made for each of `vaults`, from their histories asked together. A vault left out of the answer, and
 * every vault when asking together fails, is read alone: the same answer in more requests.
 */
async function createdTogether(
  source: VaultChainSource,
  vaults: readonly string[]
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const histories = source.histories;
  if (histories === undefined || vaults.length === 0) return new Map();
  let served: readonly (readonly ServedEvent[] | null)[];
  try {
    served = await inParts(vaults as readonly Hex[], (part) => histories.eventsOfEvery(part), HISTORIES_AT_ONCE);
  } catch {
    /* Asked together the question can fail where asked alone it does not (an indexer that limits a request's size or
     * fields more than this one asks for): each vault is then read alone, which is whole or refuses on its own. */
    return new Map();
  }
  return new Map(
    vaults.flatMap((vault, i) => {
      const events = served[i];
      return events === null || events === undefined
        ? []
        : [[vault, outputsMadeFor(vault as Hex, events, new Set())] as const];
    })
  );
}
