import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from '../core/crypto.js';
import { VAULT_CIRCUITS } from '../midnight/vault-contract.js';
import { vaultOutputHistoryFrom } from '../midnight/deposit-nonce.js';
import { indexerNoteEvents, indexerVaultTransactions } from '../midnight/note-index.js';
import type { VaultChain } from './company-vaults.js';
import { startingLedgerFrom } from '../wiring/vault-submission.js';

/**
 * **WHAT THE COMPANY-VAULT ROUTES READ, FROM THE INDEXER THIS DEPLOYMENT NAMES.**
 *
 * A vault's state is read as the vault's own compiled ledger reads it, whether
 * it came from the indexer or from a deploy a device sent: both are put through
 * the contract runtime's own reader first, so one function answers for both.
 */
const hex = (bytes: Uint8Array): Hex => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') as Hex;

export async function vaultChainFromTheIndexer(indexer: { url: string; wsUrl: string }): Promise<VaultChain> {
  const [{ indexerPublicDataProvider }, runtime, vault] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    import('@midnight-ntwrk/compact-runtime'),
    import('../../contracts/managed-vault/contract/index.js'),
  ]);
  const provider = indexerPublicDataProvider(indexer.url, indexer.wsUrl) as unknown as {
    queryContractState(address: string): Promise<unknown | null | undefined>;
  };
  const asRuntime = (state: unknown): { data: unknown } =>
    (runtime as unknown as { ContractState: { deserialize(b: Uint8Array): { data: unknown } } })
      .ContractState.deserialize((state as { serialize(): Uint8Array }).serialize());
  const readLedger = (vault as unknown as {
    ledger(data: unknown): Parameters<typeof startingLedgerFrom>[0] & { notes: Iterable<Uint8Array> };
  }).ledger;
  const history = vaultOutputHistoryFrom({
    transactions: indexerVaultTransactions(indexer.url, indexer.wsUrl),
    events: indexerNoteEvents(indexer.url),
  });
  return {
    contractState: async (address) => (await provider.queryContractState(address)) ?? null,
    serialize: (state) => (state as { serialize(): Uint8Array }).serialize(),
    notesOf: (state) => [...readLedger(asRuntime(state).data).notes].map(hex),
    startingLedgerOf: (state) => {
      const ledger = readLedger(asRuntime(state).data);
      if (!(ledger.account.bytes instanceof Uint8Array) || ledger.account.bytes.length !== 32) throw new Error('not a vault\'s state');
      return startingLedgerFrom(ledger);
    },
    everCreated: (address) => history.everCreated(address),
  };
}

/** Every vault circuit's verifying key, read once from this build's own artefacts. */
export function vaultVerifierKeysIn(root: string): () => Promise<ReadonlyMap<string, Uint8Array>> {
  let read: Map<string, Uint8Array> | null = null;
  return async () => {
    read ??= new Map(VAULT_CIRCUITS.map((c) => [
      c, new Uint8Array(readFileSync(join(root, 'contracts', 'managed-vault', 'keys', `${c}.verifier`))),
    ]));
    return read;
  };
}
