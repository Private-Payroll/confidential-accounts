import { describe, it, expect } from 'vitest';
import { explainNodeError } from '../../scripts/node-errors.js';

describe('node rejection codes', () => {
  it('decodes the exact line that killed the deploy', () => {
    const line = '2026-08-12 10:47:23        RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 170';
    expect(explainNodeError(line)).toMatch(/170 = InvalidDustSpendProof/);
  });
  it('names an unknown code rather than swallowing it', () => {
    expect(explainNodeError('Custom error: 99')).toMatch(/99 \(not in our table\)/);
  });
  it('is quiet when there is no code', () => {
    expect(explainNodeError('some other failure')).toBeNull();
  });
});
