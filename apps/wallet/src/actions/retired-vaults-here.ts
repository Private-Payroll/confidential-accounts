/**
 * **THE VAULTS THE COMPANY RETIRED WHOSE SECRET THIS WALLET STILL KEEPS, AS IT READS THEM.** A retired vault holds what
 * it held and pays out once adopted again, so one that may hold private money has its secret changed with the others
 * after a removal, and a removal is judged against it; and one whose last secret change is half written pays no public
 * money out until every sealed copy is written, so its change is finished too. Read from the account's own state and
 * each vault's, through this wallet's own indexer; a side that could not be read is never taken as empty, and a read
 * that failed is never taken as a change finished.
 */
import type { Hex } from '../../../../src/core/crypto.js';
import type { ChainHereDoors } from '../../../../packages/web-shared/src/vault-doors.js';
import { ON_CHAIN, moneyOnChainOf } from '../../../../packages/web-shared/src/money-on-chain.js';
import { readHereOrUnread } from '../../../../packages/web-shared/src/vault-read-here.js';
import type { VaultOnChainOnTheWire } from '../../../../packages/web-shared/src/vault-worker-client.js';
import type { CompanyReach } from './company-reach.js';

const lower = (x: string): Hex => String(x).toLowerCase() as Hex;

/** What one vault's holdings are read through: this wallet's builder, its indexer and the company's account. */
type VaultReadDoors = Pick<ChainHereDoors, 'builder' | 'indexer' | 'account'>;

/** Every vault the company's account retired and does not hold again now, as the account's own state lists them. */
export async function retiredVaultsOnChain(
  r: Pick<CompanyReach, 'builder' | 'chain' | 'account'>
): Promise<readonly Hex[]> {
  const reads = r.builder.superAdmins?.reads(r.chain.indexer);
  if (reads === undefined)
    throw new Error(
      "this wallet cannot read the vaults the company's account retired. Reload it to get the current version."
    );
  const read = await reads.accountAt(lower(String(r.account)));
  if (read === null || read.vaults === null) {
    throw new Error(
      "the company's account does not list the vaults it adopted and retired, so the vaults a removal reaches are not known."
    );
  }
  const adopted = new Set(read.vaults.adopted.map(lower));
  return read.vaults.retired.map(lower).filter((v) => !adopted.has(v));
}

/**
 * Whether a vault's last secret change is half written on the chain: the vault is not started, so not every sealed copy
 * of its secret is written, and a secret is set (its commitment is not all zero). A vault never started holds an
 * all-zero commitment and is not; a read that failed, or that gave no commitment, is never taken as finished.
 */
export const secretChangeHalfWritten = (read: VaultOnChainOnTheWire | null): boolean => {
  if (read === null || !read.onChain) return true;
  if (read.started) return false;
  return read.nonceCommitment === undefined || !/^0*$/u.test(read.nonceCommitment);
};

/** What a vault's secret holds at stake: private money it may hold, the copies its half-written change still owes, or the deposits it takes. */
export type SecretAtStake = 'private-money' | 'copies' | 'deposits';

/**
 * **WHAT A VAULT'S SECRET HOLDS AT STAKE, FROM ONE READ OF IT HERE**: `private-money` when its private side may hold
 * money (held, or not read, never taken as empty); else `copies` when its last secret change is half written, so its
 * payouts wait on the sealed copies still to be written; else, for a vault the account holds and not one it `retired`,
 * `deposits` when a secret is set, since it takes private money at any time; else null. A retired vault takes no
 * deposit, so one read empty with its change finished has nothing at stake.
 */
export async function secretAtStakeHere(
  doors: VaultReadDoors,
  vault: Hex,
  retired: boolean
): Promise<SecretAtStake | null> {
  const read = await readHereOrUnread(doors, vault);
  if (read === null || moneyOnChainOf(read).notes !== ON_CHAIN.none) return 'private-money';
  if (secretChangeHalfWritten(read)) return 'copies';
  const secretSet = read.onChain && read.nonceCommitment !== undefined && !/^0*$/u.test(read.nonceCommitment);
  return !retired && secretSet ? 'deposits' : null;
}

/**
 * **THE RETIRED VAULTS WHOSE SECRET IS STILL KEPT**: each that may hold private money, or whose last secret change is
 * half written, each read once and all of them together. Their secret's change is raised after a removal and finished, and their secret is given
 * to the seats that lack it, as an adopted vault's is; a retired vault that never started is passed over.
 */
export async function retiredVaultsKeptHere(
  r: Pick<CompanyReach, 'builder' | 'chain' | 'account'>,
  doors: VaultReadDoors
): Promise<readonly Hex[]> {
  const retired = await retiredVaultsOnChain(r);
  const stakes = await Promise.all(retired.map((vault) => secretAtStakeHere(doors, vault, true)));
  return retired.filter((_v, i) => stakes[i] !== null);
}
