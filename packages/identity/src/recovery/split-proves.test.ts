import { afterEach, describe, expect, it, vi } from 'vitest';
import { newSecret } from '../keys/derivation.js';
import type { Placement } from './pieces.js';

/**
 * ONE PROPERTY, IN A FILE OF ITS OWN, BECAUSE PROVING IT NEEDS THE SPLITTING
 * LIBRARY REPLACED.
 *
 * `splitSecret` proves its own output before returning it. The comment above
 * that line used to claim no test could catch its removal — the library is
 * correct, so the proof always passes and deleting the call changes nothing.
 * **That was wrong**: swap the library at
 * the module boundary for one that returns shares which do not rebuild, and the
 * door is the thing that refuses. If it is not, the mutation is invisible and
 * the failure moves from the split to the day somebody recovers.
 *
 * It lives here rather than in `pieces.test.ts` because mocking a module
 * changes it for every test in a file, and every other test in that file wants
 * the real one.
 */

const THREE: readonly Placement[] = [
  { label: 'Your Google account', holder: 'google:person@example.com' },
  { label: 'Printed', holder: 'paper' },
  { label: 'My other laptop', holder: 'device:laptop-2' },
];

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('shamir-secret-sharing');
});

describe('splitSecret proves its own output', () => {
  it('REFUSES a set the scheme cannot rebuild, rather than handing it back', async () => {
    /*
     * A splitting library that produces plausible shares which combine into
     * something else. That is the shape of a subtly broken scheme, and it is
     * exactly what §7.6 says is easy to get wrong and silent until the day it
     * is needed.
     */
    vi.doMock('shamir-secret-sharing', () => ({
      split: async (_secret: Uint8Array, count: number) =>
        Array.from({ length: count }, (_, i) => Uint8Array.from(
          { length: 33 }, (__, j) => (i * 31 + j * 7 + 1) & 0xff)),
      combine: async () => new Uint8Array(32).fill(9),
    }));
    const { splitSecret, RecoveryError } = await import('./pieces.js');
    await expect(splitSecret(newSecret(), THREE, 2)).rejects.toThrow(RecoveryError);
  });

  it('returns the set when the scheme is the real one', async () => {
    const { splitSecret } = await import('./pieces.js');
    const set = await splitSecret(newSecret(), THREE, 2);
    expect(set.pieces).toHaveLength(3);
    expect(set.threshold).toBe(2);
  });
});
