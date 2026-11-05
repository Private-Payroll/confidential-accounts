/**
 * THE ONE QUESTION THE SERVICE AND THE PAGE BOTH ASK: IS MONEY FUNDED INTO A
 * VAULT IN THIS STANDING.
 */
import { describe, it, expect } from 'vitest';
import { VAULT, vaultStandingIsFunded } from './vault-standing.js';

describe('the standing in which a vault is funded', () => {
  /* RED WHEN: any standing but the committee holding the vault is funded, or that one is not. */
  it('funds the held standing and no other of the eight', () => {
    const all = Object.values(VAULT);
    expect(all).toHaveLength(8);
    expect(all.filter(vaultStandingIsFunded)).toEqual([VAULT.held]);
  });

  /* RED WHEN: a word the service never reports is funded. */
  it('does not fund a standing it does not know', () => {
    expect(vaultStandingIsFunded('held-by-committee-later')).toBe(false);
    expect(vaultStandingIsFunded('')).toBe(false);
  });
});
