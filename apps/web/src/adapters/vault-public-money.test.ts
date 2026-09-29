import { describe, expect, it } from 'vitest';
import { formatTokenAmount, PublicAmount, visibilityOf } from 'vaults-ui/format/token-amount';
import { SEED_ASSETS, StaticAssetRegistry, type Asset } from '../../../../src/core/assets.js';
import { vaultPublicMoney } from './vault-public-money.js';

/*
 * THE ADAPTER OVER THE SHARED READER OF A VAULT'S PUBLIC MONEY. Nothing here
 * stands in for the reader: each case hands the adapter a view of the vault as
 * the service would report it, and the shared reader reads it.
 */
const NIGHT = SEED_ASSETS.find((a) => a.code === 'NIGHT')!;
const NIGHT_TOKEN = NIGHT.ledger.unshielded!;
const UNLISTED = 'ab'.repeat(32);
const view = (rows: unknown) => async () => ({ onChain: true, publicBalances: rows });

/** Every value in an answer that is not a public amount made by publicAmount, with where it is. */
function looseValues(value: unknown, at = 'answer'): string[] {
  if (value instanceof PublicAmount) return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => looseValues(v, `${at}[${i}]`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => looseValues(v, `${at}.${k}`));
  return [`${at}: ${typeof value}`];
}

describe('a vault\'s public money, through the adapter', () => {
  /* RED WHEN: an amount leaves the adapter as a bare bigint or number, with decimals or a code that are not the token's record, or marked private although anyone can look it up. */
  it('hands on each amount as an amount, with its token\'s decimals and code', async () => {
    const answer = await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '12500000' }]));
    expect(answer?.amounts.length).toBe(1);
    const [night] = answer!.amounts;
    expect(night).toBeInstanceOf(PublicAmount);
    expect(visibilityOf(night!)).toBe('public');
    expect(night!.code).toBe('NIGHT');
    expect(NIGHT.decimals).toBe(6);
    expect(formatTokenAmount(night!, 'en')).toBe('12.5');
  });

  /* RED WHEN: the decimals are written in the adapter instead of read from the token's record, so a record with other decimals is shown the same. */
  it('reads the decimals from the registry it is given', async () => {
    const eight: Asset = { ...NIGHT, decimals: 8 };
    const registry = new StaticAssetRegistry([...SEED_ASSETS.filter((a) => a.code !== 'NIGHT'), eight]);
    const answer = await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '12500000' }]), registry);
    expect(formatTokenAmount(answer!.amounts[0]!, 'en')).toBe('0.125');
  });

  /* RED WHEN: a currency the registry has switched off is hidden, though a vault still holds it. */
  it('reads a currency that is switched off', async () => {
    const off: Asset = { ...NIGHT, enabled: false };
    const registry = new StaticAssetRegistry([...SEED_ASSETS.filter((a) => a.code !== 'NIGHT'), off]);
    const answer = await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '5' }]), registry);
    expect([answer?.amounts.map((a) => a.code), answer?.unrecognised]).toEqual([['NIGHT'], 0]);
  });

  /* RED WHEN: two assets naming one token are resolved by whichever came last, so a holding is shown in the wrong currency and decimals. */
  it('answers null when two assets name the same token', async () => {
    const twin: Asset = { ...NIGHT, code: 'TWIN', decimals: 0 };
    const registry = { all: () => [NIGHT, twin], enabled: () => [NIGHT, twin], find: () => null, require: () => NIGHT };
    expect(await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '5000000' }]), registry)).toBeNull();
  });

  /* RED WHEN: a currency no record names is shown as a figure, or is dropped instead of counted. */
  it('counts a currency the registry does not name, and shows no figure for it', async () => {
    const answer = await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '1' }, { token: UNLISTED, amount: '7' }]));
    expect(answer?.amounts.map((a) => a.code)).toEqual(['NIGHT']);
    expect(answer?.unrecognised).toBe(1);
    expect(await vaultPublicMoney(view([]))).toEqual({ amounts: [], unrecognised: 0 });
  });

  /* RED WHEN: a reading that failed is handed on as nothing held, or with the reader's words in it. */
  it('answers null when the reader could not read, and carries none of its words', async () => {
    expect(await vaultPublicMoney(async () => { throw new Error('the service did not answer'); })).toBeNull();
    expect(await vaultPublicMoney(async () => ({ onChain: false }))).toBeNull();
    expect(await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '1.5' }]))).toBeNull();
    expect(await vaultPublicMoney(view('not a list'))).toBeNull();
  });

  /* RED WHEN: anything leaves the adapter but amounts and the one count: a bigint, a number posing as money, or a string a screen could show. */
  it('hands on nothing but amounts and the count', async () => {
    const answer = await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '3' }, { token: UNLISTED, amount: '7' }, { token: 'cd'.repeat(32), amount: '4' }]));
    expect(looseValues(answer)).toEqual(['answer.unrecognised: number']);
    expect([answer?.amounts.length, answer?.unrecognised]).toEqual([1, 2]);
  });

  /*
   * RED WHEN: two rows for one token are added together, which could show twice
   * what the vault holds, or shown as two amounts of one currency, or one of
   * them dropped, a token the registry does not name included. The choice is
   * to refuse.
   */
  it('refuses two rows for one token', async () => {
    expect(await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '3' }, { token: NIGHT_TOKEN, amount: '4' }]))).toBeNull();
    expect(await vaultPublicMoney(view([{ token: UNLISTED, amount: '3' }, { token: UNLISTED, amount: '4' }]))).toBeNull();
    expect((await vaultPublicMoney(view([{ token: NIGHT_TOKEN, amount: '3' }, { token: UNLISTED, amount: '4' }])))?.amounts.length).toBe(1);
  });
});
