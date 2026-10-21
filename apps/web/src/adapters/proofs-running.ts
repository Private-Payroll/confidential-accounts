import type { ProofInProgress, VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';

let builder: VaultBuilderClient | null = null;

/** Remembers the builder client once it is up, so a screen can ask it which proofs are running without starting it. */
export function builderIsUp(client: VaultBuilderClient): void {
  builder = client;
}

/** The proofs the vault builder is making right now, each with when it began; none when the builder is not up. */
export function proofsRunning(): readonly ProofInProgress[] {
  return builder?.proofsInProgress?.() ?? [];
}
