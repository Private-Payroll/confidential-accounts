import type { Hex } from '../../../../src/core/crypto.js';
import { MONEY_UNREAD, ON_CHAIN, type MoneyOnChain } from 'vaults-web-shared/money-on-chain.js';
import { moneyHeldHere } from 'vaults-web-shared/vault-read-here.js';
import type { ChainHereDoors } from 'vaults-web-shared/vault-doors.js';
import { onTheChainIn, walletIndexerIn, type PageView } from './filing-judge.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * What a retired vault holds, read from the chain alone: the notes in its pool and its public balances, by the one
 * read a retire's approvers are shown (`moneyHeldHere`). It needs no note record on this device and no company key, so a
 * note paid in after the retire, which no record names, still counts. A side that cannot be read is said to be unread,
 * never empty: a retired vault is hidden only when both sides read empty. The company's account and the indexer the
 * wallet names are the company's view's, read once for it; a door of that view that fails to be read is thrown.
 */

export { ON_CHAIN };

/** One retired vault's two sides as the chain shows them. */
export type RetiredVaultOnChain = MoneyOnChain;

/** Whether the chain shows the vault holding nothing at all, on both sides. */
export const emptyOnChain = (r: RetiredVaultOnChain): boolean => r.notes === ON_CHAIN.none && r.public === ON_CHAIN.none;

type CompanyDoors = Pick<ChainHereDoors, 'builder' | 'indexer'>;

/** The company's door to the chain as its view reads it, or null when the company has no account there or the wallet named no indexer. */
async function companyDoorsIn(view: PageView): Promise<CompanyDoors | null> {
  if (await onTheChainIn(view) === null) return null;
  const indexer = await walletIndexerIn(view);
  if (indexer === null) return null;
  return { builder: await theVaultBuilder(), indexer: async () => indexer };
}

/**
 * What the chain shows `vault` holding; unread on any side the indexer, the account or the vault's state did not give,
 * and on both when the company has no account or indexer to read it through, or the vault's read failed
 * (`moneyHeldHere`). Any other failure is thrown, never read as unread.
 */
export async function readRetiredVaultOnChain(view: PageView, vault: string): Promise<RetiredVaultOnChain> {
  const doors = await companyDoorsIn(view);
  if (doors === null) return MONEY_UNREAD;
  return moneyHeldHere(doors, vault.toLowerCase() as Hex);
}
