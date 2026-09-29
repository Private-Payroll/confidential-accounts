import { NETWORK } from 'midnight-identity/network';
import { startVaultBuilder, type VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';

/*
 * THE PART OF THE PAGE THAT BUILDS AND READS VAULT TRANSACTIONS, ONE FOR THE
 * PAGE: the shared vault worker, started the first time a vault is created,
 * handed over or has its private money read, and kept for the life of the
 * page. A start that failed is not kept, so the next ask tries again.
 */
let started: Promise<VaultBuilderClient> | null = null;

export const theVaultBuilder = (): Promise<VaultBuilderClient> => {
  started ??= startVaultBuilder(NETWORK);
  started.catch(() => { started = null; });
  return started;
};
