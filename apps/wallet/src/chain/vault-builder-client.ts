import { vaultBuilderOnWorkers, WALLET_VAULT_BUILDER, type VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { NETWORK } from '../config.js';

/**
 * THE WALLET'S VAULT BUILDER, asked through the same client a page's device
 * uses: started on first use in the wallet's own worker, under the name the
 * builder knows as the wallet's, and answering with what that worker built
 * from the wallet's own keys and proofs.
 */
export const walletVaultBuilder = (): VaultBuilderClient =>
  vaultBuilderOnWorkers(() => new Worker(new URL('./vault-builder-worker.ts', import.meta.url), { type: 'module', name: WALLET_VAULT_BUILDER }) as never, NETWORK);
