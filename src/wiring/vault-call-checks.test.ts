/**
 * **EACH KIND OF VAULT CALL THE COMPANY'S FEE PAYER ADDS A FEE TO, AND THE CHECK ITS TRANSACTION MUST PASS.** The
 * transactions are the shapes the service reads, made by hand.
 */
import { describe, it, expect } from 'vitest';
import { isVaultCallKind, movesNothing, vaultCallRefusal } from './vault-call-checks.js';

const ACCOUNT = 'c0'.repeat(32);
const VAULT = 'ab'.repeat(32);
const tx = (actions: unknown[], over: Record<string, unknown> = {}) => ({ intents: new Map([[1, { actions }]]), ...over });
const call = (address: string, entryPoint: string) => ({ address, entryPoint: new TextEncoder().encode(entryPoint) });

describe('THE FEE PAYER\'S CHECK FOR A PUBLIC TOKEN TAKEN OFF A VAULT\'S LIST', () => {
  const forget = (t: unknown) => vaultCallRefusal('vault-forget', t, { vault: VAULT, account: ACCOUNT });
  it('passes one forgetUnshielded call to this vault and refuses the vault\'s retire under that kind', () => {
    expect(forget(tx([call(VAULT, 'forgetUnshielded')]))).toBeNull();
    /* RED WHEN: the vault's retire, or a forget with a retire riding beside it, is paid for as a token taken off the list. */
    expect(forget(tx([call(VAULT, 'retire'), call(ACCOUNT, 'retireVault')]))).toMatch(/Nothing was sent\./u);
    expect(forget(tx([call(VAULT, 'forgetUnshielded'), call(VAULT, 'retire')]))).toMatch(/Nothing was sent\./u);
  });

  it('is paid for as a call moving nothing, as a vault\'s retire is, and never as one moving the vault\'s coins', () => {
    /* RED WHEN: the fee payer takes a token taken off the list as a payment of the vault's coins, which it is not. */
    expect(movesNothing('vault-forget')).toBe(true);
    expect(movesNothing('vault-retire')).toBe(true);
    expect((['payout', 'merge', 'public-payout'] as const).map(movesNothing)).toEqual([false, false, false]);
  });
});

describe('ONE TABLE OF VAULT CALL KINDS, READ BY THE SERVICE AND BY THE WALLET THAT SENDS STRAIGHT TO THE CHAIN', () => {
  it('a kind whose check reads the company\'s account is refused when no account is named, and one that reads none is checked without it', () => {
    /* RED WHEN: a call checked against the company's account is let through, or checked against nothing, when the sender names no account. */
    expect(vaultCallRefusal('vault-retire', tx([call(VAULT, 'retire'), call(ACCOUNT, 'retireVault')]), { vault: VAULT, account: undefined }))
      .toBe('it names no account for the vault it calls');
    expect(vaultCallRefusal('vault-retire', tx([call(VAULT, 'retire'), call(ACCOUNT, 'retireVault')]), { vault: VAULT, account: ACCOUNT })).toBeNull();
    expect(vaultCallRefusal('vault-forget', tx([call(VAULT, 'forgetUnshielded')]), { vault: VAULT, account: undefined })).toBeNull();
  });

  it('names exactly the seven vault call kinds, and no other', () => {
    /* RED WHEN: a kind the table does not hold is taken as a vault call, so it reaches no check at all. */
    expect(['vault-secret', 'vault-copy', 'vault-retire', 'vault-forget', 'payout', 'merge', 'public-payout'].every(isVaultCallKind)).toBe(true);
    expect(['account-call', 'deposit', 'toString'].some(isVaultCallKind)).toBe(false);
  });
});
