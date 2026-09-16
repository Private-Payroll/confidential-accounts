/**
 * **WHAT A LEDGER SAYS ABOUT FEES FOLLOWS WHO IS IN THE SEAT.** Both ledgers
 * used to describe themselves as paying fees whatever they had been given.
 */
import { describe, it, expect } from 'vitest';
import { paysNoFees } from './fee-seat.js';
import { MidnightLedger, type FeeSponsor } from './ledger.js';
import { VaultLedger } from './vault-ledger.js';
import { chainLedger } from '../wiring/chain.js';
import { ContractBook } from '../wiring/account-contract.js';

const payer = (over: Partial<FeeSponsor> = {}): FeeSponsor => ({
  addFeeAndFinalise: async (tx) => tx,
  submit: async () => ({ ref: 'r', at: '' }),
  release: async () => {},
  payingFor: () => {},
  capacity: async () => ({ dust: 0n, night: 0n }),
  ...over,
});
const standIn = (): FeeSponsor => ({ ...payer(), paysNothing: true });

const cfg: any = { networkId: 'preview', nodeUrl: 'https://rpc.example', indexerUrl: '', indexerWsUrl: '', proverUrl: '', zkConfigPath: '', privateStateId: 'p' };

describe('who is in the fee payer seat', () => {
  /* RED WHEN: the mark is ignored, so the refusing stand-in counts as somebody paying. */
  it('the stand-in and an empty seat pay nothing; anything else is a fee payer', () => {
    expect(paysNoFees(standIn())).toBe(true);
    expect(paysNoFees(undefined)).toBe(true);
    expect(paysNoFees(null)).toBe(true);
    expect(paysNoFees(payer())).toBe(false);
  });

  /* RED WHEN: `MidnightLedger.describe` goes back to one sentence whatever it was given. */
  it('the chain ledger says which it has', () => {
    const over = (s: FeeSponsor) =>
      new MidnightLedger(cfg, s, {} as never, async () => null, async () => ({}), undefined).describe();
    expect(over(standIn())).toMatch(/with no fee payer, so nothing can be written/);
    expect(over(payer())).toMatch(/with fees paid by the fee payer it was given/);
    expect(over(standIn())).not.toMatch(/sponsored/);
  });

  /* RED WHEN: `VaultLedger.describe` reads the seat's truthiness again. */
  it('and so does the vault client', () => {
    const over = (s: FeeSponsor) =>
      new VaultLedger(cfg, s, async () => ({}), undefined, {} as never, '/nowhere').describe();
    expect(over(standIn())).toMatch(/with no fee payer;/);
    expect(over(payer())).toMatch(/with fees paid by the fee payer it was given;/);
    expect(over(standIn())).toMatch(/pinned by the vault on chain/);
  });

  /*
   * THROUGH THE WIRING THAT SHIPS. RED WHEN: the refusing stand-in the chain
   * wiring puts in the seat stops carrying the mark, so the ledger under a
   * read-only deployment says it has a fee payer.
   */
  it('the ledger under a deployment that cannot pay says it has no fee payer', () => {
    const d: any = {
      network: 'stagenet', contractAddress: 'bcb61fef', indexerUrl: 'https://indexer.example',
      indexerWsUrl: 'wss://indexer.example', nodeUrl: 'https://rpc.example', proverUrl: 'http://prover.invalid:1',
      sealedStateRoot: '/nowhere/sealed', privateStateId: 'p', zkConfigPath: '/nowhere/managed',
      vaultZkConfigPath: '/nowhere/managed-vault',
    };
    const ledger = chainLedger(d, new ContractBook(() => null, 'chain'));
    expect((ledger as any).inner.describe()).toMatch(/with no fee payer, so nothing can be written/);
  });
});

