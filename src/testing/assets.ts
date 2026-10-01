import { createHash } from 'node:crypto';

import {
  SEED_ASSETS, StaticAssetRegistry, type Asset, type AssetId, type AssetRegistry, type LedgerForm,
} from '../core/assets.js';
import type { VaultHoldings } from '../core/vault-holdings.js';

/**
 * **A TOKEN ONLY A TEST KNOWS: 64 HEX CHARACTERS NO MINT EVER PRODUCED.**
 * Different labels give different tokens, so a test can hold two.
 */
export const testToken = (label: string): AssetId =>
  createHash('sha256').update(`a token only a test knows: ${label}`).digest('hex');

/** A fixture row for a test token, in the forms asked for. */
export const testTokenRow = (
  label: string,
  opts: { symbol: string; decimals: number; forms: readonly LedgerForm[]; name?: string; sortOrder?: number },
): Asset => {
  const code = testToken(label);
  return {
    code, symbol: opts.symbol, name: opts.name ?? `Test token ${opts.symbol}`, decimals: opts.decimals,
    ledger: {
      shielded: opts.forms.includes('shielded') ? code : null,
      unshielded: opts.forms.includes('unshielded') ? code : null,
    },
    enabled: true, sortOrder: opts.sortOrder ?? 95,
  };
};

/**
 * **A TOKEN WITH BOTH FORMS, WHICH NO SEED ROW HAS.** No token in the product's
 * registry can be paid both privately and publicly, so tests whose subject is
 * how a run is raised, approved, retried or reported, for either kind of
 * payee, are handed a registry that holds this fixture row beside the
 * product's own, and a vault that holds enough. Two decimal places, so an
 * amount a test types reads as it always did. What the product's own registry
 * does is pinned where the registry is tested, not here.
 */
export const TEST_TOKEN_ROW: Asset = testTokenRow('both forms', {
  symbol: 'tPAY', name: 'Test Pay', decimals: 2, forms: ['shielded', 'unshielded'],
});

/** The fixture token, in both forms. */
export const TEST_TOKEN: AssetId = TEST_TOKEN_ROW.code;

/** A second fixture token, in both forms, for a test that needs two tokens. */
export const OTHER_TEST_TOKEN_ROW: Asset = testTokenRow('another token, both forms', {
  symbol: 'tOTH', name: 'Test Other', decimals: 2, forms: ['shielded', 'unshielded'], sortOrder: 96,
});

/** The second fixture token. */
export const OTHER_TEST_TOKEN: AssetId = OTHER_TEST_TOKEN_ROW.code;

/** The product's rows, and the fixture tokens beside them. */
export const registryWithTestPrivateForms = (): AssetRegistry => new StaticAssetRegistry(
  [...SEED_ASSETS, TEST_TOKEN_ROW, OTHER_TEST_TOKEN_ROW],
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
