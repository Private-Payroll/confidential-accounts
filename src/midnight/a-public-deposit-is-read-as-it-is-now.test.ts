/**
 * **A VAULT'S PUBLIC BALANCE IS READ AS THE VAULT HOLDS IT NOW, NOT AS IT WAS
 * DEPLOYED.**
 *
 * The chain below is two answers the indexer client really gives for one vault
 * that was deployed empty and then paid into publicly: its balance query, which
 * for a vault whose latest action is a call answers the DEPLOY's balances, and
 * its contract state, which is the state the latest action left. The states are
 * real contract states, built by the contract runtime, serialised, and read
 * back by the same reader the indexer client reads a state with, so the balance
 * is read off the shape the chain serves and not off a hand-made copy of it.
 *
 * §1 is the reader and the payout check over that chain. §2 is the reader's
 * rule that zero is an answer and a balance it cannot read is not.
 */
import { describe, it, expect } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { deserializeCompactContractState } from '@midnight-ntwrk/midnight-js-utils';

import { VaultCannotAfford, VaultChainUnreadable, VaultLedger, type NotePool } from './vault-ledger.js';
import { chainVaultHoldings } from './vault-holdings.js';
import { heldOf, publicHoldingsOf, PublicBalanceUnreadable } from './public-balance.js';
import { unshieldedPayeeFor } from '../testing/payees.js';
import type { Hex } from '../core/crypto.js';

const VAULT: Hex = 'e3'.repeat(32) as Hex;
const NIGHT = 'ab'.repeat(32) as Hex;
const OTHER = 'cd'.repeat(32) as Hex;
const PUBLIC_PAYEE = unshieldedPayeeFor(new Uint8Array(32).fill(0x44), 'preview');
const VAULT_ARTEFACTS = new URL('../../contracts/managed-vault', import.meta.url).pathname;

/** A contract state holding exactly these public amounts, as the chain serves it and the indexer client reads it. */
function servedState(held: Array<[Hex, bigint]>, extra: Array<[unknown, bigint]> = []) {
  const state = new runtime.ContractState();
  state.balance = new Map<runtime.TokenType, bigint>([
    ...held.map(([raw, v]) => [{ tag: 'unshielded', raw }, v] as [runtime.TokenType, bigint]),
    ...extra as Array<[runtime.TokenType, bigint]>,
  ]);
  return deserializeCompactContractState(state.serialize(), { caller: 'a public deposit is read as it is now' });
}

const refusingPool: NotePool = {
  load: async () => { throw new Error('a public read must not load the pool'); },
  save: async () => { throw new Error('a public read must not save the pool'); },
  create: async () => { throw new Error('a public read must not create a pool'); },
};

/**
 * One vault on one chain: deployed holding nothing, then `deposited` paid in
 * publicly. The balance query answers what the indexer client's query selects
 * for a call, the deploy's balances; the state is the latest action's.
 */
function vaultAfterAPublicDeposit(deposited: bigint) {
  const deployed: Array<{ tokenType: string; balance: bigint }> = [];
  /* Another public token and the fee token sit beside it, as they can in a real balance. */
  const now = servedState([[NIGHT, deposited], [OTHER, 50n]], [[{ tag: 'dust' }, 3n]]);
  const providers = async () => ({
    publicDataProvider: {
      queryUnshieldedBalances: async () => deployed,
      queryContractState: async () => now,
    },
  });
  return new VaultLedger({ networkId: 'preview' } as never, {} as never, providers as never, {}, refusingPool, VAULT_ARTEFACTS);
}

describe('§1 after a public deposit into a vault that held nothing at deploy', () => {
  it('the reader answers the deposited amount', async () => {
    const ledger = vaultAfterAPublicDeposit(700n);
    /* RED WHEN the reader asks the balance query, which answers the deploy's empty list: 0 instead of 700. */
    expect(await ledger.unshieldedBalance(VAULT, NIGHT)).toBe(700n);
    expect(await ledger.unshieldedHoldings(VAULT)).toEqual([{ token: NIGHT, amount: 700n }, { token: OTHER, amount: 50n }]);
    /* RED WHEN the run's holdings read the public form some other way than the vault client's reader. */
    expect(await chainVaultHoldings(ledger).held(VAULT, 'unshielded', NIGHT)).toEqual({ of: 'held', amount: 700n });
  });

  it('the public payout\'s check accepts a payment the vault can afford', async () => {
    const ledger = vaultAfterAPublicDeposit(700n);
    /* RED WHEN the check reads the deploy's balance: "pays 700 of a public token the chain says this vault holds 0". */
    await expect(ledger.affordable(VAULT, [{ payee: PUBLIC_PAYEE, token: NIGHT, amount: 700n }])).resolves.toBeUndefined();
    await expect(chainVaultHoldings(ledger).fits(VAULT, [{ payee: PUBLIC_PAYEE, token: NIGHT, amount: 700n }]))
      .resolves.toEqual({ of: 'fits' });
  });

  it('and still refuses one it cannot, by the total', async () => {
    const ledger = vaultAfterAPublicDeposit(700n);
    /* RED WHEN the reader over-reads (the other token's 50 or the fee token counted) and lets 701 through. */
    const failed = await ledger.affordable(VAULT, [
      { payee: PUBLIC_PAYEE, token: NIGHT, amount: 400n },
      { payee: PUBLIC_PAYEE, token: NIGHT, amount: 301n },
    ]).then(() => null, (e: unknown) => e as VaultCannotAfford);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect(failed!.why).toBe('public-balance-short');
  });

  it('and refuses one token written two ways as ONE debt against one balance', async () => {
    const ledger = vaultAfterAPublicDeposit(700n);
    /* RED WHEN the run's debts are grouped by spelling: 400 and 400 each pass against 700. */
    const failed = await ledger.affordable(VAULT, [
      { payee: PUBLIC_PAYEE, token: NIGHT, amount: 400n },
      { payee: PUBLIC_PAYEE, token: `0x${NIGHT.toUpperCase()}` as Hex, amount: 400n },
    ]).then(() => null, (e: unknown) => e as VaultCannotAfford);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect(failed!.why).toBe('public-balance-short');
  });
});

describe('§2 zero is an answer and a balance that cannot be read is not', () => {
  it('a state whose balance names no public token answers ZERO for any token', () => {
    const holdings = publicHoldingsOf(servedState([]));
    /* RED WHEN an empty balance is refused as unreadable. */
    expect(holdings).toEqual([]);
    expect(heldOf(holdings, NIGHT)).toBe(0n);
  });

  it('passes over the fee token by name, and lists every public token once, summed', () => {
    const holdings = publicHoldingsOf(servedState([[OTHER, 5n], [NIGHT, 9n]], [[{ tag: 'dust' }, 1_000n]]));
    /* RED WHEN the fee token is counted as a public token, or refused as unreadable. */
    expect(holdings).toEqual([{ token: NIGHT, amount: 9n }, { token: OTHER, amount: 5n }]);
    /* RED WHEN a token is matched by prefix or case rather than by its colour. */
    expect(heldOf(holdings, `0x${NIGHT.toUpperCase()}`)).toBe(9n);
    expect(heldOf(holdings, NIGHT.slice(0, 62))).toBe(0n);
  });

  it.each([
    ['no state at all', null],
    ['a state with no balance', {}],
    ['a balance that is a list, not a map', { balance: [{ tokenType: NIGHT, balance: 5n }] }],
    ['an amount that is not a whole number', { balance: new Map([[{ tag: 'unshielded', raw: NIGHT }, '7']]) }],
    ['a negative amount', { balance: new Map([[{ tag: 'unshielded', raw: NIGHT }, -1n]]) }],
    ['a token with no colour', { balance: new Map([[{ tag: 'unshielded' }, 7n]]) }],
    ['a token of a kind this reader does not know', { balance: new Map([[{ tag: 'mystery', raw: NIGHT }, 7n]]) }],
  ])('REFUSES rather than answering zero: %s', (_why, state) => {
    /* RED WHEN the entry is skipped or the missing map read as empty: the reader answers [] or a partial list. */
    expect(() => publicHoldingsOf(state)).toThrow(PublicBalanceUnreadable);
  });

  it('and the vault client carries that refusal as UNREADABLE, never as zero', async () => {
    const providers = async () => ({ publicDataProvider: { queryContractState: async () => ({ balance: undefined }) } });
    const ledger = new VaultLedger({ networkId: 'preview' } as never, {} as never, providers as never, {}, refusingPool, VAULT_ARTEFACTS);
    /* RED WHEN the reader turns a state it could not read into 0n. */
    await expect(ledger.unshieldedBalance(VAULT, NIGHT)).rejects.toThrow(VaultChainUnreadable);
    expect((await chainVaultHoldings(ledger).held(VAULT, 'unshielded', NIGHT)).of).toBe('unreadable');
  });
});
