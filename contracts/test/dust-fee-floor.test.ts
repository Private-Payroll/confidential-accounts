import { describe, it, expect } from 'vitest';
import { DUST_FEE_FLOOR, dustCachePath } from '../../scripts/dust-wallet.js';

/**
 * The node refuses a transaction whose DustActions carry no spends:
 *   ledger/src/dust.rs — `if self.spends.is_empty() && self.registrations.is_empty()`
 * and the balancer selects no spends when it is handed an imbalance of 0.
 * A fee of exactly 0 is therefore not a cheap transaction, it is an invalid one.
 */
describe('the dust fee floor', () => {
  it('is not zero, which is the whole point', () => {
    expect(DUST_FEE_FLOOR).toBeGreaterThan(0n);
  });
  it('added to any fee the ledger quotes, keeps it non-zero', () => {
    // The two values actually observed on preview: 0 for the call that was
    // rejected, 1 for the eight that landed.
    for (const quoted of [0n, 1n, 250_000n]) {
      expect(quoted + DUST_FEE_FLOOR).toBeGreaterThan(0n);
    }
  });
  it('keys the cache by network and seed, so two networks cannot share one', () => {
    const a = dustCachePath('/r', 'preview', 'a073d71fc51112fac9e2');
    const b = dustCachePath('/r', 'preprod', 'a073d71fc51112fac9e2');
    expect(a).not.toBe(b);
    expect(a).toContain('preview');
  });
});
