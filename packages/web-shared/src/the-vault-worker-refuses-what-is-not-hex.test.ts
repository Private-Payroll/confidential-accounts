import { describe, it, expect } from 'vitest';
import { answerVaultAsk, type WorkerDeps } from './vault-worker-entry.js';
import type { VaultAsk } from './vault-worker-client.js';

/*
 * THE VAULT WORKER REFUSES A VAULT OR A SECRET THAT IS NOT HEX BEFORE
 * IT READS ANYTHING WITH IT. What it is built with is stood in by an object
 * that records any use, so a refusal that came after a read is seen as that
 * read.
 */
const touched: string[] = [];
const deps = async (): Promise<WorkerDeps> => new Proxy({}, {
  get: (_t, p) => {
    /* Awaiting the deps asks whether they are a promise; that is not a read of what the ask is built with. */
    if (p === 'then') return undefined;
    touched.push(String(p));
    throw new Error(`the worker read ${String(p)}`);
  },
}) as WorkerDeps;
const ask = (kind: string, rest: Record<string, unknown>) => answerVaultAsk(deps, { id: 1, network: 'undeployed', ask: kind, ...rest } as unknown as VaultAsk);

describe('THE VAULT WORKER REFUSES WHAT IS NOT HEX', () => {
  it('a vault or a secret that is not hex is refused, and nothing is read or compared', async () => {
    for (const [why, rest] of [
      ['a vault that is not hex', { vault: 'zz'.repeat(32), state: 'AAAA', secret: 'cd'.repeat(32) }],
      ['a secret that is not hex', { vault: 'ab'.repeat(32), state: 'AAAA', secret: 'not a secret' }],
      ['a secret one byte short', { vault: 'ab'.repeat(32), state: 'AAAA', secret: 'cd'.repeat(31) }],
    ] as const) {
      touched.length = 0;
      /* RED WHEN: the worker's hex check on the vault or the secret is removed or loosened. */
      await expect(ask('secret-is-the-vaults', rest), why).rejects.toThrow(/not a vault and a secret, so nothing was compared/);
      expect(touched, why).toEqual([]);
    }
    /* The positive control: a vault and a secret that are hex go on to be read. */
    touched.length = 0;
    await ask('secret-is-the-vaults', { vault: 'ab'.repeat(32), state: 'AAAA', secret: 'cd'.repeat(32) }).catch(() => undefined);
    expect(touched.length).toBeGreaterThan(0);
  });
});
