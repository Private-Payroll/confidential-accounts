import type { Hex } from '../../../src/core/crypto.js';
import type { BuiltOnHereDoors } from './vault-doors.js';
import { chainAtOneBlockHere } from './vault-read-here.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

/** What reading the account's removal count needs: the chain at one block, and the worker that reads the account there. */
type RemovalsDoors = Pick<BuiltOnHereDoors, 'account' | 'indexer'> & {
  readonly builder: Pick<VaultBuilderClient, 'chainAtOneBlock' | 'eventsOf' | 'createdBy' | 'startStanding'>;
  readonly clock?: () => number;
};

/**
 * **THE REMOVALS AND RE-SEATS THE COMPANY'S ACCOUNT HAS COUNTED**, read on this
 * device from the account's state at one block, through the wallet's indexer.
 * A vault's nonce secret is good for a count; a record good for fewer is behind
 * the chain (`secretBehindTheChain`). Refuses, naming the read, when the chain
 * could not be read.
 */
export async function removalsOnTheChainHere(doors: RemovalsDoors, vault: Hex): Promise<number> {
  const chain = await chainAtOneBlockHere(doors, vault);
  const now = Math.floor((doors.clock?.() ?? Date.now()) / 1000);
  const read = await doors.builder.startStanding({
    vault, account: chain.account, accountState: chain.accountState, vaultState: chain.vaultState, now: String(now),
  });
  const removals = read.standing.removals;
  if (!Number.isSafeInteger(removals) || removals < 0) {
    throw new Error('this device could not read how many signers the company has removed, so nothing was done. Try again.');
  }
  return removals;
}
