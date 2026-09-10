/**
 * **THE PAIR A SERVER IS HANDED PAYS DUST ONLY AND RECORDS WHAT IT PAID.**
 *
 * `fundedPartiesOver` is the one construction the stagenet launcher uses. These
 * cases drive the fee payer it builds with a wallet double and read what that
 * fee payer asked the wallet for and what it filed.
 */
import { describe, it, expect } from 'vitest';
import { fundedPartiesOver, type LiveWalletParts } from './funded-wallets.js';
import type { SponsoredFee } from '../src/midnight/sponsored-fees.js';

type Call = { method: string; args: unknown[] };

const live = (calls: Call[], label: string): LiveWalletParts => {
  const rec = (method: string, answer: (...a: any[]) => unknown) =>
    async (...args: unknown[]) => { calls.push({ method: `${label}.${method}`, args }); return answer(...args); };
  return {
    provider: {
      zswapSecretKeys: `${label}-shielded`,
      dustSecretKey: `${label}-dust`,
      submitTx: rec('submitTx', () => 'ref-1'),
      unshieldedKeystore: { signDataAsync: rec('signDataAsync', () => 'sig') },
      getCoinPublicKey: () => `${label}-coin`,
      getEncryptionPublicKey: () => `${label}-enc`,
    },
    facade: {
      estimateTransactionFee: rec('estimateTransactionFee', () => 700n),
      balanceFinalizedTransaction: rec('balanceFinalizedTransaction', (tx: unknown) => ({ recipe: tx })),
      balanceUnboundTransaction: rec('balanceUnboundTransaction', (tx: unknown) => ({ recipe: tx })),
      finalizeRecipe: rec('finalizeRecipe', (r: any) => r.recipe),
      signRecipe: rec('signRecipe', (r: unknown) => r),
      revert: rec('revert', () => undefined),
    },
    dust: () => 1n,
    night: () => 1n,
  };
};

const sink = (records: SponsoredFee[]) => ({ record: (e: SponsoredFee) => { records.push(e); } });

describe('the fee payer handed to the server', () => {
  /*
   * RED WHEN: the fee payer's balancing call omits `tokenKindsToBalance`, or
   * widens it past dust - which pays the company's own legs out of ours - or
   * when `fundedPartiesOver` builds a fee payer that is not `WalletFeeSponsor`.
   */
  it('asks the paying wallet to balance dust and nothing else', async () => {
    const calls: Call[] = [];
    const parties = fundedPartiesOver(
      live(calls, 'payer'), live(calls, 'company'), async () => 650n, sink([]), () => {});
    await parties.sponsor.addFeeAndFinalise({ tx: 1 }, new Date(Date.now() + 60_000));

    const balance = calls.find(c => c.method === 'payer.balanceFinalizedTransaction');
    expect(balance, 'the paying wallet was never asked to balance').toBeDefined();
    const options = balance!.args[2] as { tokenKindsToBalance?: unknown };
    expect(options.tokenKindsToBalance, 'the argument was left to its default').toBeDefined();
    expect(options.tokenKindsToBalance).toEqual(['dust']);
    expect(calls.some(c => c.method.startsWith('company.')),
      'the company wallet was touched while the fee was paid').toBe(false);
  });

  /*
   * RED WHEN: the record is not passed through to the fee payer, or the
   * company, the estimate or the chain's figure is lost on the way.
   */
  it('files one row per payment with the company, the estimate and the actual', async () => {
    const records: SponsoredFee[] = [];
    const calls: Call[] = [];
    const parties = fundedPartiesOver(
      live(calls, 'payer'), live(calls, 'company'), async () => 650n, sink(records), () => {});
    parties.sponsor.payingFor('acc_demo');
    const finalised = await parties.sponsor.addFeeAndFinalise({ tx: 1 }, new Date(Date.now() + 60_000));
    await parties.sponsor.submit(finalised);

    expect(records).toHaveLength(1);
    expect(records[0]!.company).toBe('acc_demo');
    expect(String(records[0]!.estimated)).toBe('700');
    expect(String(records[0]!.actual)).toBe('650');
    expect(records[0]!.ref).toBe('ref-1');
  });

  /* RED WHEN: the refusal for a missing record is removed. */
  it('refuses to build a fee payer with nowhere to record what it pays', () => {
    expect(() => fundedPartiesOver(
      live([], 'payer'), live([], 'company'), async () => null, undefined as never, () => {}))
      .toThrow(/nowhere to record what it pays/);
  });

  /*
   * RED WHEN: the two halves are built over the wrong wallets - the company
   * half reporting the paying wallet's keys would put the company's legs in
   * the hands of the only wallet with spend authority.
   */
  it('the company half carries the company wallet\'s keys', () => {
    const parties = fundedPartiesOver(
      live([], 'payer'), live([], 'company'), async () => null, sink([]), () => {});
    expect(parties.customer.coinPublicKey()).toBe('company-coin');
    expect(parties.customer.encryptionPublicKey()).toBe('company-enc');
  });
});
