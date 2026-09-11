import { createHash } from 'node:crypto';

import { SEED_ASSETS, StaticAssetRegistry, type AssetRegistry, type LedgerForm } from '../core/assets.js';
import type { VaultHoldings } from '../core/vault-holdings.js';

/**
 * **A PRIVATE TOKEN ONLY A TEST KNOWS, FOR AN ASSET THE PRODUCT CANNOT PAY
 * PRIVATELY.**
 *
 * A payroll run is always private and no asset in the product's registry has a
 * private form, so the product refuses every payroll run before a fee. Tests
 * whose subject is how a run is raised, approved, retried or reported still
 * need a run to exist. They are handed a registry in which the placeholder
 * assets carry a private token, and a vault that holds enough. What the
 * product's own registry does is pinned where the registry is tested, not
 * here.
 */
export const testPrivateToken = (code: string): string =>
  createHash('sha256').update(`a private token only a test knows: ${code}`).digest('hex');

/** The product's rows, each asset that has no form on Midnight given a private token of its own. */
export const registryWithTestPrivateForms = (): AssetRegistry => new StaticAssetRegistry(
  SEED_ASSETS.map(a => (a.ledger.shielded === null && a.ledger.unshielded === null
    ? { ...a, ledger: { shielded: testPrivateToken(a.code), unshielded: null } }
    : a)),
);

/** A vault that holds this much of everything, in notes that fit any payment, and a record of every question it was asked. */
export const aVaultHolding = (amount: bigint = 1n << 100n): VaultHoldings & {
  readonly reads: Array<{ vault: string; form: LedgerForm; token: string }>;
} => {
  const reads: Array<{ vault: string; form: LedgerForm; token: string }> = [];
  return {
    reads,
    held: async (vault, form, token) => { reads.push({ vault, form, token }); return { of: 'held', amount }; },
    fits: async () => ({ of: 'fits' }),
  };
};
