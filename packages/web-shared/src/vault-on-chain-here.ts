/**
 * **A VAULT AS THE CHAIN HOLDS IT, READ ON THIS DEVICE FROM THE INDEXER THE
 * PERSON'S OWN WALLET NAMES** - its state, the notes it holds, every coin ever
 * made for it, who holds it, whether it is started, what it holds in public
 * money, and the state its deploy left. Nothing of it passes
 * through the company's service.
 *
 * Runs in the vault worker, never in the page: the indexer reader reaches the
 * ledger's WebAssembly (see `public-data.ts`). The endpoints are the wallet's
 * own and nothing else; a wallet that names none is refused by name before
 * anything is read.
 */
import { publicDataProviderFor, refuseEndpointsThatCannotWork, type IndexerEndpoints } from './public-data.js';
import { indexerNoteEvents, indexerVaultTransactions, type NoteEvents, type VaultTransactions } from '../../../src/midnight/note-index.js';
import { vaultOutputHistoryFrom } from '../../../src/midnight/deposit-nonce.js';
import { assertVaultLedgerIsThisBuilds } from '../../../src/midnight/vault-ledger-shape.js';
import { authorityOfState, startingLedgerFrom } from '../../../src/midnight/vault-circuits.js';
import type { Hex } from '../../../src/core/crypto.js';
import { publicHoldingsOf } from '../../../src/midnight/public-balance.js';
import type { VaultOnChainOnTheWire } from './vault-worker-client.js';

/** Where the chain is read from: one contract's state now, a vault's transactions, and each transaction's events. */
export interface VaultChainSource {
  contractState(address: string): Promise<{ serialize(): Uint8Array } | null | undefined>;
  /** The state the contract's deploy left at `address`, as the chain recorded it; null when it holds no deploy there. */
  deployState(address: string): Promise<unknown>;
  readonly transactions: VaultTransactions;
  readonly events: NoteEvents;
}

/** The chain as the indexer the wallet names serves it. */
export const vaultChainSourceAt = (indexer: IndexerEndpoints): VaultChainSource => {
  refuseEndpointsThatCannotWork(indexer);
  const reader = publicDataProviderFor(indexer);
  return {
    contractState: async (address) =>
      (await (await reader).queryContractState(address)) as { serialize(): Uint8Array } | null | undefined,
    deployState: async (address) => (await (await reader).queryDeployContractState(address)) ?? null,
    transactions: indexerVaultTransactions(indexer.indexerUri, indexer.indexerWsUri),
    events: indexerNoteEvents(indexer.indexerUri),
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
