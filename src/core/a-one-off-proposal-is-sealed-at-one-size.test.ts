import { describe, it, expect } from 'vitest';
import type { Hex } from './crypto.js';
import { batchDigestOf, sealTransferProposal } from './proposal-filing.js';

const sealedFor = (amount: bigint) => sealTransferProposal({
  accountId: 'acc_one', viewingKey: '5c'.repeat(32) as Hex, vault: 'fa'.repeat(32) as Hex, summary: 'One-off payment from a vault',
  oneOff: { id: `one_${'ab'.repeat(16)}`, version: 1 },
  change: { asset: '11'.repeat(32), amount, batchDigest: batchDigestOf([]), salt: '5a'.repeat(32) as Hex }, proposedBy: 'cd'.repeat(32),
});

describe('A ONE-OFF PAYMENT\'S PROPOSAL IS SEALED AT ONE SIZE, WHATEVER IT PAYS', () => {
  it('THE SAME LENGTH FOR 5, 50,000 AND 5,000,000,000', () => {
    const lengths = [5n, 50_000n, 5_000_000_000n, (1n << 128n) - 1n].map((a) => sealedFor(a).body.length);
    /* RED WHEN: the sealed proposal's length follows the number of digits in the amount, so the service learns the size of a private payment. */
    expect(new Set(lengths).size).toBe(1);
  });
});
