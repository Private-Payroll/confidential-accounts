import { readTransaction, type VaultBuilderDeps } from './vault-builder.js';
import { fromBase64 } from './base64-bytes.js';
import { indexerTransactionsByIdentifier, vaultCallByIdentifiers } from '../../../src/midnight/note-index.js';
import type { WorkerDeps } from './vault-worker-entry.js';
import type { VaultAnswer, VaultAsk } from './vault-worker-client.js';

/** The worker's answer to whether the chain holds a vault call this device sent, looked for by its transaction's identifiers. */
export async function vaultCallOnChainAnswered(
  d: Pick<WorkerDeps, 'transactionsAt'>, withNetwork: VaultBuilderDeps, ask: Extract<VaultAsk, { ask: 'vault-call-on-chain' }>,
): Promise<Extract<VaultAnswer, { ask: 'vault-call-on-chain' }>> {
    /*
     * The call is looked for by the identifiers of the transaction this device holds, read here from its bytes. The
     * service merges its fee in as a separate intent, which changes the hash and leaves every identifier as it was, so
     * the service's hash is never needed and never believed. Which part of the transaction carries the call is read
     * from the same bytes, because the indexer names none.
     */
    if (!/^[0-9a-f]{64}$/iu.test(ask.vault)) throw new Error('that is not a vault, so no call to it was looked for.');
    if (!Array.isArray(ask.entryPoints) || ask.entryPoints.length === 0 || !ask.entryPoints.every((e) => typeof e === 'string')) {
      throw new Error('no circuit of the vault was named, so no call to it was looked for.');
    }
    const { refuseEndpointsThatCannotWork } = await import('./public-data.js');
    refuseEndpointsThatCannotWork(ask.indexer);
    const held = readTransaction(withNetwork, fromBase64(ask.transaction));
    if (held === null) throw new Error('the transaction could not be read, so it cannot be looked for on the chain.');
    if (held.identifiers.length === 0) throw new Error('the transaction names no identifier, so it cannot be looked for on the chain.');
    const reader = (d.transactionsAt ?? ((i) => indexerTransactionsByIdentifier(i.indexerUri)))(ask.indexer);
    const seen = await vaultCallByIdentifiers(reader, held, { vault: ask.vault, entryPoints: ask.entryPoints });
    return { id: ask.id, ok: true, ask: 'vault-call-on-chain', seen };
}
