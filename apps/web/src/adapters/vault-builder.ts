import { NETWORK } from 'midnight-identity/network';
import type { AccountCreationBuilder } from 'vaults-web-shared/keyring.js';
import { startVaultBuilder, type VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';
import { builderIsUp } from './proofs-running.js';

/*
 * THE PART OF THE PAGE THAT BUILDS AND READS VAULT AND ACCOUNT TRANSACTIONS,
 * ONE FOR THE PAGE: the shared vault worker, started the first time anything
 * asks for it (once somebody signs in, its proving files are fetched ahead),
 * and kept for the life of the page. A start that failed is not kept, so the
 * next ask tries again.
 */
let started: Promise<VaultBuilderClient> | null = null;

export const theVaultBuilder = (): Promise<VaultBuilderClient> => {
  started ??= startVaultBuilder(NETWORK).then((client) => { builderIsUp(client); return client; });
  started.catch(() => { started = null; });
  return started;
};

/**
 * The page's vault worker as the keyring reads a kept creation with it: whether its account is on the chain, for
 * starting a creation again. A company's account is built, signed and proved in the wallet, never by this worker.
 */
export async function theCreationBuilder(): Promise<AccountCreationBuilder | null> {
  const w: VaultBuilderClient = await theVaultBuilder();
  const { accountPresence } = w;
  return accountPresence === undefined ? {} : { accountPresence };
}
