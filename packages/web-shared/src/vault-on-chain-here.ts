/**
 * **A VAULT AS THE CHAIN HOLDS IT, READ ON THIS DEVICE FROM THE INDEXER THE
 * PERSON'S OWN WALLET NAMES.**
 *
 * What it reads: the vault's state, the notes it holds, every coin ever made
 * for it, whether it is started, what it holds in public money, the state its
 * deploy left, and whether every circuit of the vault and of the company's
 * account is the one this app was built with.
 *
 * What it does not read: who holds the vault. Money going in or out waits on
 * no committee, so no read here asks.
 *
 * What a step into or out of the vault is built on and judged by: one block's
 * view of the vault, the commitment tree, the ledger's parameters and the
 * company's account, each transaction's events, and which of its transactions
 * created an output. Nothing of it passes through the company's service.
 *
 * Runs in the vault worker, never in the page: the indexer reader reaches the
 * ledger's WebAssembly (see `public-data.ts`). The endpoints are the wallet's
 * own and nothing else; a wallet that names none is refused by name before
 * anything is read. The wallet and the company's service read a company's
 * account with the same `accountAtOneBlockOver`, each over its own reader.
 */
import { publicDataProviderFor, refuseEndpointsThatCannotWork, type IndexerEndpoints } from './public-data.js';
import {
  eventOnTheWire, indexerNoteEvents, indexerVaultTransactions, transactionThatCreatedOutput,
  type EventOnTheWire, type NoteEvents, type ServedEvent, type VaultTransactions,
} from '../../../src/midnight/note-index.js';
import { HISTORIES_AT_ONCE, indexerVaultHistories, type VaultHistories } from '../../../src/midnight/indexer-queries.js';
import { outputsMadeFor, vaultOutputHistoryFrom } from '../../../src/midnight/deposit-nonce.js';
import { assertVaultLedgerIsThisBuilds } from '../../../src/midnight/vault-ledger-shape.js';
import { circuitsNotThisBuilds, startingLedgerFrom } from '../../../src/midnight/vault-circuits.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Hex } from '../../../src/core/crypto.js';
import { publicHoldingsOf } from '../../../src/midnight/public-balance.js';
import { boundedRead } from './read-bound.js';
import { inParts } from './company-view-batch.js';
import { decodedState } from '../../../src/midnight/decoded-state.js';
import type { VaultOnChainOnTheWire } from './vault-worker-client.js';
import {
  accountAtOneBlockOver, accountCallChainOf, atOneBlockOver, payoutChainOf, toBase64,
  type AccountAtOneBlock, type AccountCallChainOnTheWire, type BlockReader, type PayoutChainOnTheWire, type VaultAtOneBlock,
} from './one-block-read.js';
export { accountAtOneBlockOver, accountCallChainOf, atOneBlockOver, payoutChainOf };
export type { AccountAtOneBlock, BlockReader, VaultAtOneBlock };
export { ON_CHAIN, moneyOnChainOf, type MoneyOnChain } from './money-on-chain.js';

/** How a refusal about this vault's circuits or its account's begins: it says plainly that no money goes in or out. */
const NO_MONEY = 'no money goes in or out of this vault';

/** Where the chain is read from: one contract's state now, a vault's transactions, and each transaction's events. */
export interface VaultChainSource {
  contractState(address: string): Promise<{ serialize(): Uint8Array } | null | undefined>;
  /** The states of many contracts read in one request, in the order asked; null where it holds none. Absent, each is read alone. */
  contractStates?(addresses: readonly string[]): Promise<ReadonlyArray<{ serialize(): Uint8Array } | null>>;
  /** The state the contract's deploy left at `address`, as the chain recorded it; null when it holds no deploy there. */
  deployState(address: string): Promise<unknown>;
  readonly transactions: VaultTransactions;
  readonly events: NoteEvents;
  /** Every transaction of many vaults with its events, in one request; without it each vault's history is read alone. */
  readonly histories?: VaultHistories;
  /**
   * The newest block the indexer holds, named first, and as of that one block:
   * the commitment tree, the vault's state and the ledger's parameters, and the
   * account's state. Null while either contract is not held at that block.
   */
  atOneBlock(vault: string, account: string): Promise<VaultAtOneBlock | null>;
  /**
   * The newest block the indexer holds, named first, and as of it the
   * account's state and the ledger's parameters: what a call to the account
   * alone is built on. Null while the account is not held at that block.
   */
  accountAtOneBlock?(account: string): Promise<{
    readonly blockHash: string;
    readonly account: { serialize(): Uint8Array };
    readonly parameters: { serialize(): Uint8Array };
  } | null>;
  /** Whether the indexer holds a contract at `account`, with the time of the newest block it names in the same answer. */
  accountPresence?(account: string): Promise<AccountPresence>;
}

/** What one read of the indexer says of an address: held or not, and the newest block's height and time (ms) as it names them. */
interface AccountPresence {
  readonly held: boolean;
  readonly blockHeight: number;
  readonly blockTime: number;
}

/**
 * **WHETHER THE INDEXER HOLDS A CONTRACT AT AN ADDRESS, WITH THE CHAIN'S OWN TIME.** One request names the newest block
 * and reads the address. `held: false` is only an answer from an indexer that replied cleanly with a block and a
 * null contract; a refusal, an error, a missing block or a reply of another shape is a throw, never "not held".
 */
export async function accountPresenceAt(
  indexerUri: string, account: string, fetcher: typeof fetch = fetch,
): Promise<AccountPresence> {
  const { response, body } = await boundedRead('The network indexer', async (signal) => {
    const answered = await fetcher(indexerUri, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query ($a: HexEncoded!) { block { height timestamp } contractAction(address: $a) { __typename } }',
        variables: { a: account },
      }),
      signal,
    });
    if (!answered.ok) return { response: answered, body: null };
    return { response: answered, body: await answered.json() as { errors?: unknown; data?: { block?: { height?: unknown; timestamp?: unknown } | null; contractAction?: unknown } } };
  });
  if (!response.ok || body === null) throw new Error(`the indexer answered ${response.status}.`);
  if (body.errors !== undefined) throw new Error('the indexer refused the read.');
  const block = body.data?.block;
  const height = block?.height;
  const time = block?.timestamp;
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(time) || (time as number) <= 0) throw new Error('the indexer named no newest block.');
  if (body.data === undefined || !('contractAction' in body.data)) throw new Error('the indexer did not answer for the address.');
  return { held: body.data.contractAction !== null, blockHeight: height as number, blockTime: time as number };
}


/** The chain as the indexer the wallet names serves it. */
export const vaultChainSourceAt = (indexer: IndexerEndpoints): VaultChainSource => {
  refuseEndpointsThatCannotWork(indexer);
  const reader = publicDataProviderFor(indexer);
  return {
    /* Decoded here with the contract runtime, so a refusal can read the state's authority and circuits. */
    contractState: async (address) => (await import('../../../src/midnight/contract-state-at.js')).contractStateAt(await reader, address),
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
    /*
     * Read as `atOneBlockOver` says: one block named first, and both
     * contracts as of it. The indexer's reader is made once, when this
     * source is, and every read here waits on that same reader rather
     * than opening one of its own.
     */
    atOneBlock: async (vault, account) => atOneBlockOver(await reader, vault, account),
    accountAtOneBlock: async (account) => accountAtOneBlockOver(await reader, account),
    accountPresence: (account) => accountPresenceAt(indexer.indexerUri, account),
  };
};

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * **THE VAULT, READ.** `vault` reads a vault's ledger and holds its pure
 * circuits; `runtimeState` turns the served state into the one the ledger
 * reader takes. A vault the indexer holds no state for is `onChain: false`,
 * never an empty vault. A history that cannot be read in full refuses: a list of
 * coins with a hole in it is not a list of coins.
 *
 * `circuits` says whether every circuit of the vault is the one this app was
 * built with, held against the digests the compiled vault carries
 * (`expectedVk`); with `accountAddress`, `accountCircuits` says the same of that
 * account's current state, held against the compiled account's digests
 * (`accountExpectedVk`). An account the chain holds no state for is refused,
 * never passed: a vault pays out on its account's approvals, so an account
 * whose circuits are not this app's could let money out on approvals nobody
 * gave.
 *
 * `retired` is the vault's own mark that it was retired, which its deposits
 * refuse on whatever the account says of it now; `publicBalances` is what it
 * holds in public money.
 */
export async function readVaultOnChain(
  d: VaultReadDeps,
  source: VaultChainSource,
  vault: string,
  accountAddress?: string,
): Promise<VaultOnChainOnTheWire> {
  const served = await source.contractState(vault);
  if (served === null || served === undefined) return { onChain: false };
  const accountCircuits = accountAddress === undefined ? undefined : accountCircuitsFrom(d, await source.contractState(accountAddress));
  return vaultReadFrom(d, source, vault, served, accountCircuits);
}

/** What a vault is read with: its compiled vault, the account's compiled digests, and the runtime that reads a state. */
interface VaultReadDeps {
  readonly vault: {
    ledger(data: unknown): unknown; pureCircuits: { copiesWrittenKey(): Uint8Array };
    readonly expectedVk?: Readonly<Record<string, string>>;
  };
  readonly accountExpectedVk?: Readonly<Record<string, string>>;
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
}

/** What the account's circuits were found to be, as `readVaultOnChain` hands it on; undefined when no account was asked. */
type AccountCircuitsRead = ReturnType<typeof accountCircuitsFrom> | undefined;

/**
 * One vault's answer from the state the indexer served for it (`served`, never null here) and what was found of the
 * account's circuits: its notes and lists off this build's ledger, its start and account, every coin ever made for it,
 * and what it holds in public money.
 */
async function vaultReadFrom(
  d: VaultReadDeps, source: Pick<VaultChainSource, 'transactions' | 'events'>, vault: string,
  served: { serialize(): Uint8Array }, accountCircuits: AccountCircuitsRead, made?: ReadonlySet<string>,
): Promise<VaultOnChainOnTheWire> {
  const bytes = served.serialize();
  const state = d.runtimeState.deserialize(bytes) as { data: unknown };
  const circuits = circuitsNotThisBuilds(state, d.vault.expectedVk, sha256, NO_MONEY, 'the vault\'s');
  const ledger = d.vault.ledger(state.data) as Parameters<typeof startingLedgerFrom>[0] & {
    notes: Iterable<Uint8Array>; nonceCommitment: Uint8Array; splitJournal: Iterable<[Uint8Array, Uint8Array]>;
  };
  let notesFromThisBuild = true;
  let notesWhy: string | undefined;
  try {
    await assertVaultLedgerIsThisBuilds(state);
  } catch (e) {
    notesFromThisBuild = false;
    notesWhy = (e as Error)?.message ?? String(e);
  }
  let started = false;
  let retired = false;
  let account: string | null = null;
  try {
    const start = startingLedgerFrom(ledger, d.vault.pureCircuits.copiesWrittenKey());
    started = start.started;
    retired = start.retired;
    account = String(start.account).toLowerCase();
  } catch { /* a state that is not a vault's cannot be read for its account or start: `account` stays null, which the reader of this answer takes as unreadable, never as pinned elsewhere */ }
  const everCreated = [...made ?? await vaultOutputHistoryFrom({ transactions: source.transactions, events: source.events })
    .everCreated(vault as Hex)];
  /* The one reader of a contract's public balance, over the state the indexer served now. */
  let publicBalances: Array<{ token: string; amount: string }> | undefined;
  let publicBalancesWhy: string | undefined;
  try {
    publicBalances = publicHoldingsOf(served).map((h) => ({ token: h.token, amount: h.amount.toString() }));
  } catch (e) {
    publicBalancesWhy = (e as Error)?.message ?? String(e);
  }
  return {
    onChain: true,
    state: toBase64(bytes),
    /* Notes read off a ledger of another shape are about whatever field sits in that place: not handed on at all. */
    ...(notesFromThisBuild ? {
      notes: [...ledger.notes].map(hexOf),
      nonceCommitment: hexOf(ledger.nonceCommitment),
      splitJournal: [...ledger.splitJournal].map(([spent, masked]) => [hexOf(spent), hexOf(masked)] as const),
    } : {}),
    notesFromThisBuild,
    ...(notesWhy === undefined ? {} : { notesWhy }),
    /* The vault's own retired mark: read, like the notes, only off this build's ledger. */
    ...(notesFromThisBuild ? { retired } : {}),
    everCreated,
    account,
    started,
    ...(publicBalances === undefined ? { publicBalancesWhy: publicBalancesWhy! } : { publicBalances }),
    circuits,
    ...(accountCircuits === undefined ? {} : { accountCircuits }),
  };
}

/** The company account's circuits from the state the chain holds now (`served`), or why they are not this app's or not there. */
function accountCircuitsFrom(
  d: Pick<VaultReadDeps, 'accountExpectedVk' | 'runtimeState'>,
  served: { serialize(): Uint8Array } | null | undefined,
): { readonly why: string; readonly circuit: string | null } | null {
  if (served === null || served === undefined) {
    return {
      why: `${NO_MONEY}: the chain shows no company account at the address it pays out on, so whose approvals it `
        + 'pays out on cannot be checked. Nothing was sent.',
      circuit: null,
    };
  }
  return circuitsNotThisBuilds(d.runtimeState.deserialize(served.serialize()), d.accountExpectedVk, sha256,
    `${NO_MONEY}, because the company's account it pays out on is not the one this app was built for`, 'the account\'s');
}

/**
 * **WHAT A STEP OUT OF THE VAULT IS BUILT ON, READ AT ONE BLOCK**: the vault's
 * state, the commitment tree and the ledger's parameters, and the state of the
 * account it is pinned to, all as the same block holds them, each as base64 of
 * its bytes. Null while the indexer holds either contract at no block yet.
 */
export async function readChainAtOneBlock(
  source: VaultChainSource, vault: string, account: string,
): Promise<PayoutChainOnTheWire | null> {
  return payoutChainOf(await source.atOneBlock(vault, account));
}


/**
 * **WHAT A CALL TO THE ACCOUNT ALONE IS BUILT ON, READ AT ONE BLOCK** at the
 * indexer the person's own wallet names: the account's state and the ledger's
 * parameters, each as base64 of its bytes. Null while the indexer holds the
 * account at no block. Nothing of it passes through the company's service.
 */
export async function readAccountCallChain(source: VaultChainSource, account: string): Promise<AccountCallChainOnTheWire | null> {
  if (source.accountAtOneBlock === undefined) {
    throw new Error('this page cannot read the company\'s account at the indexer your wallet names. Reload the page to use the current build');
  }
  return accountCallChainOf(await source.accountAtOneBlock(account));
}


/** Whether the indexer the person's wallet names holds a contract at `account`, with the newest block's time. Throws when it cannot say. */
export async function readAccountPresence(source: VaultChainSource, account: string): Promise<AccountPresence> {
  if (source.accountPresence === undefined) throw new Error('this page cannot read whether the company\'s account is on the chain. Reload the page to use the current build');
  return source.accountPresence(account);
}

/** Every zswap event the chain holds for one transaction, as it crosses back to the page. */
export async function readEventsOf(source: VaultChainSource, transactionHash: string): Promise<EventOnTheWire[]> {
  return (await source.events.eventsOf({ hash: transactionHash as never })).map(eventOnTheWire);
}

/**
 * **WHICH OF THIS VAULT'S OWN TRANSACTIONS CREATED ONE OUTPUT**, asked by the
 * output's commitment: only the vault's own transactions are read, and only an
 * output the vault owns answers. Null while no transaction the chain lists does.
 */
export async function readCreatedBy(
  source: VaultChainSource, vault: string, commitment: string,
): Promise<{ transactionHash: string; events: EventOnTheWire[] } | null> {
  const found = await transactionThatCreatedOutput(vault as never, commitment, source);
  return found === null ? null : { transactionHash: found.transactionHash, events: found.events.map(eventOnTheWire) };
}

/** A contract's state as the indexer served it, decoded with the contract runtime, or null where it holds none. */
type ServedState = { serialize(): Uint8Array } | null;

const LEFT_OUT = 'the indexer\'s answer left a contract out, so nothing of it is used.';

/**
 * How many contracts one request to the indexer names. The indexer bounds each query's complexity (its default
 * `max_complexity` is 200): each contract asked costs 2 (its field and its state) and the block that dates them 3 (its
 * field, protocol version and ledger parameters), so one request carries at most 98 contracts; this leaves room.
 */
export const STATES_AT_ONCE = 96;

/** Refuses an address that is not a contract's, so no request names it: the indexer refuses a whole request for one. */
const askable = async (address: string): Promise<void> => {
  const utils = await import('@midnight-ntwrk/midnight-js-utils');
  const check: (a: string) => void = utils.assertIsContractAddress;
  try {
    check(address);
  } catch (e) {
    throw new Error(`${String(address)} is not a contract's address, so no read of it was asked of the indexer.`, { cause: e });
  }
};

/**
 * **THE STATES OF MANY CONTRACTS, READ IN AS FEW REQUESTS TO THE INDEXER THE PERSON'S OWN WALLET NAMES AS IT TAKES.**
 * Each request names the newest block's protocol version and ledger parameters beside every contract it asks, and each
 * state is dated by them as the SDK's read of one contract's state alone dates it: a state the block's version cannot
 * date, or that is not hex, and parameters of another era than their block, are refused. As in that read, each state
 * is the newest the indexer holds when it answers, not pinned to one block: states of one request can be of blocks
 * either side of one indexed while it answered. A contract the indexer holds no state for is null. An address that is
 * not a contract's is refused before any request names it. An answer that leaves a contract out, carries errors, or is
 * of another shape is a throw, never "no contract there".
 *
 * The states of `addresses` come in parts of `STATES_AT_ONCE`, one request each, every answer in the order asked.
 */
export async function contractStatesAt(
  indexerUri: string, addresses: readonly string[], fetcher: typeof fetch = fetch,
): Promise<ServedState[]> {
  for (const a of addresses) await askable(a);
  return inParts(addresses, (part) => statesInOneRequest(indexerUri, part, fetcher), STATES_AT_ONCE);
}

/** Asks for the states of `addresses` in one request: one alias for each address, in the order asked. */
async function statesInOneRequest(indexerUri: string, addresses: readonly string[], fetcher: typeof fetch): Promise<ServedState[]> {
  if (addresses.length === 0) return [];
  const query = `query (${addresses.map((_, i) => `$a${i}: HexEncoded!`).join(', ')}) { block { protocolVersion ledgerParameters } `
    + `${addresses.map((_, i) => `c${i}: contract(address: $a${i}) { state }`).join(' ')} }`;
  const variables = Object.fromEntries(addresses.map((a, i) => [`a${i}`, a]));
  const { response, body } = await boundedRead('The network indexer', async (signal) => {
    const answered = await fetcher(indexerUri, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal,
    });
    if (!answered.ok) return { response: answered, body: null };
    return { response: answered, body: await answered.json() as { errors?: unknown; data?: Record<string, unknown> | null } };
  });
  if (!response.ok || body === null) throw new Error(`the indexer answered ${response.status}.`);
  if (body.errors !== undefined) throw new Error('the indexer refused the read.');
  const data = body.data;
  if (typeof data !== 'object' || data === null) throw new Error(LEFT_OUT);
  const answers = addresses.map((_, i) => {
    if (!Object.hasOwn(data, `c${i}`)) throw new Error(LEFT_OUT);
    const c = data[`c${i}`] as { state?: unknown } | null;
    if (c === null || c.state === null || c.state === undefined) return null;
    if (typeof c.state !== 'string') throw new Error('the indexer served a contract state that is not text.');
    return c.state;
  });
  if (answers.every((a) => a === null)) return answers as null[];
  const block = data['block'] as { protocolVersion?: unknown; ledgerParameters?: unknown } | null | undefined;
  if (block === null || block === undefined) throw new Error('the indexer served a contract state but no block to date it.');
  await parametersOfTheBlocksEra(block);
  return Promise.all(answers.map((hex) => (hex === null ? null : datedState(hex, block.protocolVersion))));
}

/** Refuses a block whose ledger parameters are of another era than its protocol version, as the SDK's read of one state does. */
async function parametersOfTheBlocksEra(block: { protocolVersion?: unknown; ledgerParameters?: unknown }): Promise<void> {
  const { protocolVersionToLedger } = await import('@midnight-ntwrk/midnight-js-protocol');
  const { isHex, ledgerVersionOfLedgerParameters } = await import('@midnight-ntwrk/midnight-js-utils');
  const era = protocolVersionToLedger(block.protocolVersion as number, 'read');
  const hex = block.ledgerParameters;
  if (typeof hex !== 'string' || !isHex(hex)) throw new Error('the indexer served no ledger parameters, in hex, with the block that dates its states.');
  const bare = hex.replace(/^0x/u, '');
  const raw = Uint8Array.from(bare.match(/../gu) ?? [], (b) => parseInt(b, 16));
  if (ledgerVersionOfLedgerParameters(raw) !== era) throw new Error('the indexer served a block whose ledger parameters are of another era than its protocol version.');
}

/** One state, dated by the block's protocol version and decoded with the contract runtime, as the SDK's read of one state does. */
async function datedState(hex: string, protocolVersion: unknown): Promise<{ serialize(): Uint8Array }> {
  const { protocolVersionToLedger } = await import('@midnight-ntwrk/midnight-js-protocol');
  protocolVersionToLedger(protocolVersion as number, 'read');
  const { isHex, ledgerVersionOfContractState } = await import('@midnight-ntwrk/midnight-js-utils');
  if (!isHex(hex)) throw new Error('the indexer served a contract state that is not hex.');
  const bare = hex.replace(/^0x/u, '');
  const raw = Uint8Array.from(bare.match(/../gu) ?? [], (b) => parseInt(b, 16));
  const { SerializedContractState } = await import('@midnight-ntwrk/midnight-js-types');
  const { ContractState } = await import('@midnight-ntwrk/compact-runtime');
  return decodedState(SerializedContractState.fromBytes(ledgerVersionOfContractState(raw), raw), ContractState);
}

/** One vault's answer, named by the vault it is about. */
interface VaultReadOnTheWire { readonly vault: string; readonly read: VaultOnChainOnTheWire }

/** The states of `asked`, in parts of 256 when the source can read many (each read in its indexer's parts), one state at a time when it cannot. */
const statesOf = (source: VaultChainSource, asked: readonly string[]): Promise<ReadonlyArray<{ serialize(): Uint8Array } | null | undefined>> => {
  const together = source.contractStates;
  return together !== undefined ? inParts(asked, (part) => together(part)) : Promise.all(asked.map((a) => source.contractState(a)));
};

/**
 * **EVERY VAULT A STEP READS, READ TOGETHER**: the states of the vaults, and of the company's account when one is
 * named, in one `VaultChainSource.contractStates` call for each 256 addresses; each vault's answer is then exactly
 * the one a read of it alone gives (`vaultReadFrom`). Every coin ever made for each vault is still read from that
 * vault's own history, all of them at once: the indexer lists a contract's transactions one address at a time.
 *
 * **THE VAULTS, READ.** Each vault the indexer holds no state for is `onChain: false`; with `account`, each answer
 * carries what was found of that account's circuits, worked out once from its state read in the same request.
 */
export async function readVaultsOnChain(
  d: VaultReadDeps, source: VaultChainSource, addresses: readonly string[], account?: string,
): Promise<VaultReadOnTheWire[]> {
  const served = await statesOf(source, account === undefined ? addresses : [...addresses, account]);
  let circuits: { readonly found: AccountCircuitsRead } | null = null;
  /* Worked out only when some vault is there to carry it, as a read of one vault works it out only then. */
  const accountCircuits = (): AccountCircuitsRead => {
    if (account === undefined) return undefined;
    circuits ??= { found: accountCircuitsFrom(d, served[addresses.length]) };
    return circuits.found;
  };
  const made = await createdTogether(source, addresses.filter((_, i) => served[i] !== null && served[i] !== undefined));
  return Promise.all(addresses.map(async (vault, i) => {
    const state = served[i];
    return {
      vault,
      read: state === null || state === undefined ? { onChain: false } : await vaultReadFrom(d, source, vault, state, accountCircuits(), made.get(vault)),
    };
  }));
}

/**
 * Every coin the chain ever made for each of `vaults`, from their histories asked together, in parts the indexer's
 * query complexity takes. A vault left out of the answer (its list may be cut short) is read alone, and so is every
 * vault when the question asked together fails: the answer is the same, in more requests.
 */
async function createdTogether(source: VaultChainSource, vaults: readonly string[]): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const histories = source.histories;
  if (histories === undefined || vaults.length === 0) return new Map();
  let served: ReadonlyArray<ReadonlyArray<ServedEvent> | null>;
  try {
    served = await inParts(vaults as readonly Hex[], (part) => histories.eventsOfEvery(part), HISTORIES_AT_ONCE);
  } catch {
    /* Asked together the question can fail where asked alone it does not (an indexer that limits a request's size or
     * fields more than this one asks for): each vault is then read alone, which is whole or refuses on its own. */
    return new Map();
  }
  return new Map(vaults.flatMap((vault, i) => {
    const events = served[i];
    return events === null || events === undefined ? [] : [[vault, outputsMadeFor(vault as Hex, events, new Set())] as const];
  }));
}
