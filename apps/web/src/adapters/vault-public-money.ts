import { publicAmount, type PublicAmount } from 'vaults-ui';
import { readPublicHoldings } from 'vaults-web-shared/device-vault-holdings.js';
import { assets, type AssetRegistry } from '../../../../src/core/assets.js';

/*
 * WHAT A VAULT HOLDS PUBLICLY, HANDED TO A SCREEN AS AMOUNTS.
 *
 * This folder holds the application's adapters, the only files the source
 * rules let reach the shared browser code, the product's own code, the service
 * or the person's wallet, and the only files that make an amount. This one
 * reads a vault's public money through the shared reader, which returns bare
 * `bigint` counts of a token's smallest unit, and makes each a public amount
 * with `publicAmount`, from the decimals and symbol of the token's record in the
 * asset registry, so a screen never holds a number it could show as money, and
 * the Public pill is written for each without the screen being told. None of
 * the reader's words are handed on: a screen says what happened in its own
 * phrases.
 */

/** What a vault holds publicly, as a screen shows it. */
export interface VaultPublicMoney {
  /** One amount for each token the registry names, in the order the service listed them. */
  readonly amounts: readonly PublicAmount[];
  /** How many currencies it holds that no asset in the registry names. They are counted, and never shown as a figure: with no record there are no decimals to write one with. */
  readonly unrecognised: number;
}

/**
 * WHAT A VAULT HOLDS IN PUBLIC MONEY, read by the shared reader from the
 * vault's view as the company's service reports it (`viewOfTheVault`), or
 * `null` when it could not be read: the service did not answer, the vault is
 * not on the chain yet, the service sent something that is not a list of
 * tokens and whole amounts, two assets in the registry name the same token,
 * so which one a holding is in cannot be said, or the service names one token
 * in two rows. Null is never shown as nothing held.
 *
 * TWO ROWS FOR ONE TOKEN ARE REFUSED, NOT ADDED. The service reads a vault's
 * public money as one row a token, so two rows mean a reading this cannot
 * vouch for: adding them could show twice what the vault holds, and showing
 * both would show one token twice. Refusing says it could not be read,
 * which is true.
 *
 * Every asset in the registry is read, not only those a person may choose
 * today: a token switched off is still money a vault holds.
 */
export async function vaultPublicMoney(viewOfTheVault: () => Promise<unknown>, registry: AssetRegistry = assets): Promise<VaultPublicMoney | null> {
  const answer = await readPublicHoldings(viewOfTheVault);
  if (answer.of === 'unreadable') return null;
  const byToken = new Map<string, { decimals: number; symbol: string }>();
  for (const asset of registry.all()) {
    const token = asset.ledger.unshielded;
    if (typeof token !== 'string') continue;
    if (byToken.has(token)) return null;
    byToken.set(token, asset);
  }
  const tokens = answer.holdings.map((h) => h.token.toLowerCase());
  if (new Set(tokens).size !== tokens.length) return null;
  const amounts: PublicAmount[] = [];
  let unrecognised = 0;
  for (const holding of answer.holdings) {
    const asset = byToken.get(holding.token);
    if (asset === undefined) unrecognised += 1;
    else amounts.push(publicAmount(holding.amount, asset.decimals, asset.symbol));
  }
  return { amounts, unrecognised };
}
