/*
 * The vault filings an upkeep holds back and sends as one batch: what landed is done, and anything else but a stop is
 * left for the company's next seat action, a pool version another seat filed first among them, since the notes this
 * seat found are not in the pool the other seat filed.
 */
import { describe, expect, it } from 'vitest';
import { VaultPoolVersionAlreadyFiled } from '../../../../src/midnight/vault-pool.js';
import { heldFilingsSent } from './upkeep.js';

const batchOf = (...outcomes: PromiseSettledResult<void>[]) => ({
  sent: async () =>
    outcomes.map((outcome, i) => ({ record: i === 0 ? 'pool' : 'nonce-secret', vault: `v${i}`, outcome }))
});

describe("AN UPKEEP'S BATCH OF VAULT FILINGS", () => {
  it('leaves a pool version another seat filed first for the next seat action, as it leaves a refused one', async () => {
    let left = 0;
    const lost = new VaultPoolVersionAlreadyFiled('v0', 2);
    await heldFilingsSent(
      batchOf({ status: 'rejected', reason: lost }, { status: 'fulfilled', value: undefined }),
      () => {
        left += 1;
      }
    );
    /* RED WHEN: a lost race on a pool is passed over, so the step says done while the notes it found are filed nowhere. */
    expect(left).toBe(1);
  });
});
