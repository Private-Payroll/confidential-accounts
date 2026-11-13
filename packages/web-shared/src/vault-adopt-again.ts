import type { Hex } from '../../../src/core/crypto.js';
import type { CreateVaultDoors } from './vault-doors.js';
import { theWalletsIndexer } from './vault-read-here.js';

/*
 * Whether a vault's adoption again under a given retire is already closed on the chain. The account closes an adoption
 * once it carries it out and never forgets the approvals it took, so an adoption made again under an older retire,
 * after the vault was retired again, could never gather them. Read through the person's own wallet's indexer, with no
 * seat: only where the adoption stands on the chain is asked.
 */

/** Why a vault is not adopted again under a retire whose adoption the chain already closed, and what clears it. */
export const ADOPTED_AGAIN_SINCE = 'the vault was retired again since this retire, and its adoption under this one is already closed. '
  + 'Nothing was sent. Reload the page, and adopt it again under the newest retire.';

/** True when the chain shows the adoption round `adoption` of `vault` closed; throws when where it stands cannot be read. */
export async function adoptionAlreadyClosed(doors: CreateVaultDoors, vault: Hex, adoption: Hex): Promise<boolean> {
  const id = adoption.toLowerCase();
  let held: string | undefined;
  try {
    const indexer = await theWalletsIndexer(doors, vault);
    held = (await doors.builder.roundsOnChain({ account: String(doors.account).toLowerCase(), indexer, chainIds: [id] }))[id]?.held;
  } catch (e) {
    throw new Error(`where the vault's adoption stands could not be read from the chain (${String((e as Error)?.message ?? e).replace(/\.$/u, '')}). `
      + 'Nothing was sent. Press again in a minute.');
  }
  if (held === undefined) throw new Error('the chain read did not say where the vault\'s adoption stands. Nothing was sent. Press again in a minute.');
  return held === 'closed';
}
