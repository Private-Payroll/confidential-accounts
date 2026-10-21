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
 * anything is read.
 */
import { publicDataProviderFor, refuseEndpointsThatCannotWork, type IndexerEndpoints, type PublicDataProvider } from './public-data.js';
import {
  eventOnTheWire, indexerNoteEvents, indexerVaultTransactions, transactionThatCreatedOutput,
  type EventOnTheWire, type NoteEvents, type VaultTransactions,
} from '../../../src/midnight/note-index.js';
import { vaultOutputHistoryFrom } from '../../../src/midnight/deposit-nonce.js';
import { assertVaultLedgerIsThisBuilds } from '../../../src/midnight/vault-ledger-shape.js';
import { circuitsNotThisBuilds, startingLedgerFrom } from '../../../src/midnight/vault-circuits.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Hex } from '../../../src/core/crypto.js';
import { publicHoldingsOf } from '../../../src/midnight/public-balance.js';
import { boundedRead } from './read-bound.js';
import type { AccountCallChainOnTheWire, PayoutChainOnTheWire, VaultOnChainOnTheWire } from './vault-worker-client.js';

/** Where the chain is read from: one contract's state now, a vault's transactions, and each transaction's events. */
export interface VaultChainSource {
  contractState(address: string): Promise<{ serialize(): Uint8Array } | null | undefined>;
  /** The state the contract's deploy left at `address`, as the chain recorded it; null when it holds no deploy there. */
  deployState(address: string): Promise<unknown>;
  readonly transactions: VaultTransactions;
  readonly events: NoteEvents;
  /**
   * The newest block the indexer holds, named first, and as of that one block:
   * the commitment tree, the vault's state and the ledger's parameters, and the
   * account's state. Null while either contract is not held at that block.
   */
  atOneBlock(vault: string, account: string): Promise<{
    readonly blockHash: string;
    readonly zswap: { serialize(): Uint8Array };
    readonly vault: { serialize(): Uint8Array };
    readonly parameters: { serialize(): Uint8Array };
    readonly account: { serialize(): Uint8Array };
  } | null>;
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

/** The part of the indexer's reader that names a block and reads contracts as of it, as the package declares it. */
export type BlockReader = Pick<PublicDataProvider, 'queryBlock' | 'queryZSwapAndContractState' | 'queryContractState'>;

/**
 * **ONE BLOCK, NAMED FIRST, AND BOTH CONTRACTS READ AS OF IT.** The vault's
 * call reads the account's state inside the same circuit, so the two must be
 * the same moment; the commitment tree comes from that block too, because the
 * chain keeps only a window of past roots a spend may prove against. Null when
 * the indexer names no block, or holds either contract at none.
 */
export async function atOneBlockOver(
  r: BlockReader, vault: string, account: string,
): ReturnType<VaultChainSource['atOneBlock']> {
  const block = await r.queryBlock();
  if (block === null) return null;
  const at = { type: 'blockHash' as const, blockHash: block.hash };
  const [both, accountState] = await Promise.all([r.queryZSwapAndContractState(vault, at), r.queryContractState(account, at)]);
  if (both === null || accountState === null || accountState === undefined) return null;
  const [zswap, vaultState, parameters] = both;
  return { blockHash: block.hash, zswap, vault: vaultState, parameters, account: accountState };
}

/**
 * **ONE BLOCK, NAMED FIRST, AND THE ACCOUNT READ AS OF IT, WITH THE LEDGER'S
 * PARAMETERS THE SAME READ GIVES**: what a call to the account alone - a
 * recovery of its record anchor, its proposal and approvals - is built on,
 * from the indexer the person's own wallet names. Null when the indexer names
 * no block, or holds the account at none.
 */
export async function accountAtOneBlockOver(
  r: BlockReader, account: string,
): Promise<NonNullable<Awaited<ReturnType<NonNullable<VaultChainSource['accountAtOneBlock']>>>> | null> {
  const block = await r.queryBlock();
  if (block === null) return null;
  const read = await r.queryZSwapAndContractState(account, { type: 'blockHash' as const, blockHash: block.hash });
  if (read === null || read === undefined) return null;
  const [, state, parameters] = read;
  return { blockHash: block.hash, account: state, parameters };
}

/** The chain as the indexer the wallet names serves it. */
export const vaultChainSourceAt = (indexer: IndexerEndpoints): VaultChainSource => {
  refuseEndpointsThatCannotWork(indexer);
  const reader = publicDataProviderFor(indexer);
  return {
    contractState: async (address) => (await reader).queryContractState(address),
    deployState: async (address) => (await (await reader).queryDeployContractState(address)) ?? null,
    transactions: indexerVaultTransactions(indexer.indexerUri, indexer.indexerWsUri),
    events: indexerNoteEvents(indexer.indexerUri),
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
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

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
 */
export async function readVaultOnChain(
  d: {
    readonly vault: {
      ledger(data: unknown): unknown; pureCircuits: { copiesWrittenKey(): Uint8Array };
      readonly expectedVk?: Readonly<Record<string, string>>;
    };
    readonly accountExpectedVk?: Readonly<Record<string, string>>;
    readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  },
  source: VaultChainSource,
  vault: string,
  accountAddress?: string,
): Promise<VaultOnChainOnTheWire> {
  const served = await source.contractState(vault);
  if (served === null || served === undefined) return { onChain: false };
  const bytes = served.serialize();
  const state = d.runtimeState.deserialize(bytes) as { data: unknown };
  const circuits = circuitsNotThisBuilds(state, d.vault.expectedVk, sha256, NO_MONEY, 'the vault\'s');
  const accountCircuits = accountAddress === undefined ? undefined : await accountCircuitsOf(d, source, accountAddress);
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
  let account: string | null = null;
  try {
    const start = startingLedgerFrom(ledger, d.vault.pureCircuits.copiesWrittenKey());
    started = start.started;
    account = String(start.account).toLowerCase();
  } catch { /* a state that is not a vault's cannot be read for its account or start: `account` stays null, which the reader of this answer takes as unreadable, never as pinned elsewhere */ }
  const everCreated = [...await vaultOutputHistoryFrom({ transactions: source.transactions, events: source.events })
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
    everCreated,
    account,
    started,
    ...(publicBalances === undefined ? { publicBalancesWhy: publicBalancesWhy! } : { publicBalances }),
    circuits,
    ...(accountCircuits === undefined ? {} : { accountCircuits }),
  };
}

const NO_MONEY = 'no money goes in or out of this vault';

/** The company account's circuits as the chain holds them now, or why they are not this app's or not there. */
async function accountCircuitsOf(
  d: Pick<Parameters<typeof readVaultOnChain>[0], 'accountExpectedVk' | 'runtimeState'>,
  source: VaultChainSource,
  account: string,
): Promise<{ readonly why: string; readonly circuit: string | null } | null> {
  const served = await source.contractState(account);
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
  const at = await source.atOneBlock(vault, account);
  if (at === null) return null;
  return {
    blockHash: at.blockHash,
    vaultState: toBase64(at.vault.serialize()),
    zswapState: toBase64(at.zswap.serialize()),
    parameters: toBase64(at.parameters.serialize()),
    accountState: toBase64(at.account.serialize()),
  };
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
  const at = await source.accountAtOneBlock(account);
  if (at === null) return null;
  return { blockHash: at.blockHash, accountState: toBase64(at.account.serialize()), parameters: toBase64(at.parameters.serialize()) };
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
