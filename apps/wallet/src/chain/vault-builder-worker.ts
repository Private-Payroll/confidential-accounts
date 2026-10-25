import { ensureBuffer } from 'midnight-identity/browser';
import { startVaultWorker } from '../../../../packages/web-shared/src/vault-worker-entry.js';
import { vaultBuilderDeps } from './vault-builder.js';

/**
 * THE WALLET'S VAULT BUILDER, AS A MODULE WORKER. Started under the name the
 * builder knows as the wallet's, so it starts only once, here, with the
 * wallet's own keys and prover; the contract runtime is given Node's Buffer
 * before anything loads.
 */
ensureBuffer();
const scope = self as unknown as Parameters<typeof startVaultWorker>[0];
startVaultWorker(scope, vaultBuilderDeps({
  keyMaterial: { onNotKept: (file, why) => { try { scope.postMessage({ kind: 'keys-not-kept', file, why }); } catch { /* the asker has gone */ } } },
}));
