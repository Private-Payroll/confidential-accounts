/**
 * The fee payer adds only DUST to a company's transaction, and the company's wallet balances only its own
 * shielded and unshielded coins. The wallet SDK balances every kind of token when a balance names none, so
 * each balance must name its kinds in the options the SDK reads, or the fee payer's public NIGHT pays for
 * the company's legs.
 */
import { describe, it, expect } from 'vitest';
import { Intent, Transaction } from '@midnightntwrk/ledger-v9';
import { WalletFeeSponsor, type SponsorWallet } from './sponsor.js';
import { SponsoredCustomerWallet, type BalancingWallet } from './wallet.js';

/** What a balance spent, by kind, as the wallet SDK decides it: every kind, unless the options name some. */
const kindsBalanced = (options: unknown): string[] => {
  const named = (options as { tokenKindsToBalance?: unknown } | undefined)?.tokenKindsToBalance;
  return Array.isArray(named) ? [...named] : ['dust', 'shielded', 'unshielded'];
};

/** A finalised transaction with one intent and no DUST spends, which the fee ceiling reads as costing nothing. */
const finalised = () => Transaction.fromParts('undeployed', undefined, undefined, Intent.new(new Date(Date.now() + 60_000))).bind();

const handle = { serialize: () => new Uint8Array([1]), stage: 'Finalized' };

describe('who pays which leg of a company transaction', () => {
  it('the fee payer balances DUST only, so its public NIGHT never pays for a company', async () => {
    const spent: string[][] = [];
    const wallet = {
      handleOf: () => handle,
      ledgerTransactionOf: (tx: unknown) => tx,
      balanceFinalizedTransaction: async (_tx: unknown, options: unknown) => {
        spent.push(kindsBalanced(options));
        return { type: 'FINALIZED_TRANSACTION' };
      },
      finalizeRecipe: async () => finalised(),
      submitTransaction: async () => 'tx',
      revert: async () => {},
      estimateFee: async () => 1n,
      paidFee: async () => 1n,
      balances: async () => ({ dust: 10n, night: 10n }),
    } as unknown as SponsorWallet;
    await new WalletFeeSponsor(wallet, { perTransaction: 1_000n }).addFeeAndFinalise(finalised(), new Date());
    // RED WHEN the fee payer's balance stops naming its kinds where the SDK reads them, and so balances them all.
    expect(spent).toEqual([['dust']]);
  });

  it('the company balances its own shielded and unshielded coins, and never DUST', async () => {
    const spent: string[][] = [];
    const wallet = {
      adoptTransaction: () => handle,
      balanceUnboundTransaction: async (_tx: unknown, options: unknown) => {
        spent.push(kindsBalanced(options));
        return { type: 'UNBOUND_TRANSACTION' };
      },
      signRecipe: async (recipe: unknown) => recipe,
      finalizeRecipe: async () => handle,
      revert: async () => {},
    } as unknown as BalancingWallet;
    const company = new SponsoredCustomerWallet(wallet, async () => ({}) as never, { coinPublicKey: 'c', encryptionPublicKey: 'e' });
    await company.balanceOwnLegs(finalised(), new Date());
    // RED WHEN the company's balance stops naming its kinds where the SDK reads them, and so spends DUST it does not hold.
    expect(spent).toEqual([['shielded', 'unshielded']]);
  });
});

describe('what the fee payer hands its wallet', () => {
  it('adopts a company transaction by its bytes, and refuses anything that is not one', async () => {
    const { finalisedHandleFor } = await import('./sponsor.js');
    const adopted: Array<[number[], string]> = [];
    const handleFor = finalisedHandleFor(((bytes: Uint8Array, stage: string) => {
      adopted.push([[...bytes], stage]);
      return { adopted: true };
    }) as never);
    expect(handleFor({ serialize: () => Uint8Array.of(7) })).toEqual({ adopted: true });
    // RED WHEN the transaction's bytes are not what the wallet is asked to adopt, or not as a finalised one.
    expect(adopted).toEqual([[[7], 'Finalized']]);
    // RED WHEN something that is not a transaction reaches the wallet: nothing is paid and nothing is sent.
    expect(() => handleFor({ tx: 1 })).toThrow(/not a finalised transaction, so no fee was paid and nothing was sent/);
  });
});
