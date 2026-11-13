import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { SealedAccount } from '../../../../src/core/types.js';
import type { Hex } from '../../../../src/core/crypto.js';
import { api } from 'vaults-web-shared/keyring.js';
import { ON_CHAIN, moneyOnChainOf, type MoneyOnChain } from 'vaults-web-shared/money-on-chain.js';
import { readHere } from 'vaults-web-shared/vault-read-here.js';
import type { ChainHereDoors } from 'vaults-web-shared/vault-doors.js';
import { companyRoute } from './handover-state.js';
import { walletIndexerFor } from './filing-judge.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * What a retired vault holds, read from the chain alone: the notes in its pool and its public balances, by the one
 * reading the retire refuses on (`moneyOnChainOf`). It needs no note record on this device and no company key, so a
 * note paid in after the retire, which no record names, still counts. A side that cannot be read is said to be unread,
 * never empty: a retired vault is hidden only when both sides read empty. The company's account and the indexer the
 * wallet names are read once per company for the page, and each vault through the shared chain read (`readHere`).
 */

export { ON_CHAIN };

/** One retired vault's two sides as the chain shows them. */
export type RetiredVaultOnChain = MoneyOnChain;

const UNREAD: RetiredVaultOnChain = { notes: ON_CHAIN.unread, public: ON_CHAIN.unread };

/** Whether the chain shows the vault holding nothing at all, on both sides. */
export const emptyOnChain = (r: RetiredVaultOnChain): boolean => r.notes === ON_CHAIN.none && r.public === ON_CHAIN.none;

type CompanyDoors = Pick<ChainHereDoors, 'builder' | 'indexer'>;

/** Each company's door to the chain, read once and kept for the page; a door that could not be read is not kept. */
const doorsByCompany = new Map<string, Promise<CompanyDoors | null>>();

async function companyDoorsRead(companyId: string): Promise<CompanyDoors | null> {
  const sealed = await api(companyRoute(companyId)) as SealedAccount;
  if (sealed.companyLabel == null || sealed.contractAddress == null) return null;
  const indexer = await walletIndexerFor(sealed.companyLabel as CompanyLabel, sealed.contractAddress as AccountAddress);
  if (indexer === null) return null;
  return { builder: await theVaultBuilder(), indexer: async () => indexer };
}

function companyDoorsOf(companyId: string): Promise<CompanyDoors | null> {
  const kept = doorsByCompany.get(companyId);
  if (kept !== undefined) return kept;
  const reading = companyDoorsRead(companyId).catch(() => {
    /* A door that failed to be read answers as none, as one with no account or indexer does: the vault then reads as unread, never as empty. */
    return null;
  }).then((doors) => {
    if (doors === null) doorsByCompany.delete(companyId);
    return doors;
  });
  doorsByCompany.set(companyId, reading);
  return reading;
}

/** What the chain shows `vault` holding; unread on any side the indexer, the account or the vault's state did not give. */
export async function readRetiredVaultOnChain(companyId: string, vault: string): Promise<RetiredVaultOnChain> {
  try {
    const doors = await companyDoorsOf(companyId);
    if (doors === null) return UNREAD;
    return moneyOnChainOf(await readHere(doors, vault.toLowerCase() as Hex));
  } catch {
    /* A read that failed is unread, which keeps the vault listed: never taken as empty. */
    return UNREAD;
  }
}
