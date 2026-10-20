import { NETWORK } from 'midnight-identity/network';
import type { AccountCreationBuilder } from 'vaults-web-shared/keyring.js';
import { startVaultBuilder, type VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';

/*
 * THE PART OF THE PAGE THAT BUILDS AND READS VAULT AND ACCOUNT TRANSACTIONS,
 * ONE FOR THE PAGE: the shared vault worker, started the first time anything
 * asks for it (once somebody signs in, its proving files are fetched ahead),
 * and kept for the life of the page. A start that failed is not kept, so the
 * next ask tries again.
 */
let started: Promise<VaultBuilderClient> | null = null;

export const theVaultBuilder = (): Promise<VaultBuilderClient> => {
  started ??= startVaultBuilder(NETWORK);
  started.catch(() => { started = null; });
  return started;
};

/** The page's vault worker as the keyring builds a company with it, or null when this build's worker cannot. */
export async function theCreationBuilder(): Promise<AccountCreationBuilder | null> {
  const w: VaultBuilderClient = await theVaultBuilder();
  const { foundingSeat, accountDeploy, finishedCreation, creationAgain, payKeyStanding, governedCall } = w;
  if (foundingSeat === undefined || accountDeploy === undefined || finishedCreation === undefined || creationAgain === undefined
    || payKeyStanding === undefined) return null;
  return { foundingSeat, accountDeploy, finishedCreation, creationAgain, payKeyStanding, governedCall };
}
