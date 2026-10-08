/**
 * **A VAULT AS THE CHAIN HOLDS IT, READ ON THIS DEVICE FROM THE INDEXER THE
 * PERSON'S OWN WALLET NAMES** - its state, the notes it holds, every coin ever
 * made for it, who holds it, whether it is started, what it holds in public
 * money, and the state its deploy left; and what a step into or out of it is
 * built on and judged by: one block's view of the vault, the commitment tree,
 * the ledger's parameters and the company's account, each transaction's
 * events, and which of its transactions created an output. Nothing of it
 * passes through the company's service.
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
import { authorityOfState, startingLedgerFrom } from '../../../src/midnight/vault-circuits.js';
import type { Hex } from '../../../src/core/crypto.js';
import { publicHoldingsOf } from '../../../src/midnight/public-balance.js';
import type { PayoutChainOnTheWire, VaultOnChainOnTheWire } from './vault-worker-client.js';

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
     * **ONE BLOCK, NAMED FIRST, AND BOTH CONTRACTS READ AS OF IT.** The vault's
     * call reads the account's state inside the same circuit, so the two must
     * be the same moment; the commitment tree comes from that block too, because
     * the chain keeps only a window of past roots a spend may prove against.
     */
    atOneBlock: async (vault, account) => atOneBlockOver(await reader, vault, account),
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
 */
export async function readVaultOnChain(
  d: {
    readonly vault: { ledger(data: unknown): unknown; pureCircuits: { copiesWrittenKey(): Uint8Array } };
    readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  },
  source: VaultChainSource,
  vault: string,
): Promise<VaultOnChainOnTheWire> {
  const served = await source.contractState(vault);
  if (served === null || served === undefined) return { onChain: false };
  const bytes = served.serialize();
  const state = d.runtimeState.deserialize(bytes) as { data: unknown };
  const ledger = d.vault.ledger(state.data) as Parameters<typeof startingLedgerFrom>[0] & { notes: Iterable<Uint8Array> };
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
  } catch { /* a state that is not a vault's is not started, and pinned to nothing */ }
  const everCreated = [...await vaultOutputHistoryFrom({ transactions: source.transactions, events: source.events })
    .everCreated(vault as Hex)];
  const authority = authorityOfState(state);
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
    ...(notesFromThisBuild ? { notes: [...ledger.notes].map(hexOf) } : {}),
    notesFromThisBuild,
    ...(notesWhy === undefined ? {} : { notesWhy }),
    everCreated,
    authority: authority === null ? null : { committee: authority.committee, threshold: authority.threshold },
    account,
    started,
    ...(publicBalances === undefined ? { publicBalancesWhy: publicBalancesWhy! } : { publicBalances }),
  };
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
