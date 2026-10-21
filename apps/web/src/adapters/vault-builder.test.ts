import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE PAGE'S CREATION BUILDER, over a vault worker stood in for: what the
 * keyring is handed to build a company with is the worker's own functions, and
 * a worker that cannot build an account hands nothing.
 */
const NAMES = ['foundingSeat', 'accountDeploy', 'finishedCreation', 'creationAgain', 'payKeyStanding', 'governedCall'] as const;
const w = vi.hoisted(() => ({ worker: {} as Record<string, unknown>, starts: 0 }));
vi.mock('vaults-web-shared/vault-worker-client.js', () => ({ startVaultBuilder: async () => { w.starts += 1; return w.worker; } }));

const aWorker = (): Record<string, unknown> => Object.fromEntries(NAMES.map((n) => [n, async () => n]));
async function load() {
  vi.resetModules();
  return import('./vault-builder.js');
}
beforeEach(() => { w.worker = aWorker(); w.starts = 0; });

describe('the creation builder', () => {
  /* RED WHEN: the keyring is handed anything but the page's worker's own functions to build a company with, or the worker is started again for each company. */
  it('is the page\'s worker\'s own functions, from the one worker the page started', async () => {
    const m = await load();
    const b = await m.theCreationBuilder();
    for (const n of NAMES) expect((b as unknown as Record<string, unknown>)[n], n).toBe(w.worker[n]);
    await m.theCreationBuilder();
    expect(w.starts).toBe(1);
  });

  /* RED WHEN: a worker that cannot build an account, or cannot read the pay-record key, is handed to the keyring as if it could. */
  it('hands nothing when the worker lacks a function a company is built with', async () => {
    for (const missing of NAMES.filter((n) => n !== 'governedCall')) {
      const { [missing]: _gone, ...rest } = aWorker();
      w.worker = rest;
      const m = await load();
      expect(await m.theCreationBuilder(), missing).toBeNull();
    }
  });
});
