import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE PAGE'S CREATION BUILDER, over a vault worker stood in for: what the
 * keyring is handed for a kept creation is the worker's read of whether the
 * account is on the chain, and nothing that builds, signs or proves: the
 * company's account is built in the wallet.
 */
const NAMES = ['accountDeploy', 'finishedCreation', 'creationAgain', 'governedCall', 'accountPresence'] as const;
const w = vi.hoisted(() => ({ worker: {} as Record<string, unknown>, starts: 0 }));
vi.mock('vaults-web-shared/vault-worker-client.js', () => ({ startVaultBuilder: async () => { w.starts += 1; return w.worker; } }));

const aWorker = (): Record<string, unknown> => Object.fromEntries(NAMES.map((n) => [n, async () => n]));
async function load() {
  vi.resetModules();
  return import('./vault-builder.js');
}
beforeEach(() => { w.worker = aWorker(); w.starts = 0; });

describe('the creation builder', () => {
  /* RED WHEN: the keyring is handed any of the worker's functions that builds, signs or proves a company's account, or the worker is started again. */
  it('is the page\'s worker\'s read of the account alone, from the one worker the page started', async () => {
    const m = await load();
    const b = await m.theCreationBuilder();
    expect(Object.keys(b ?? {})).toEqual(['accountPresence']);
    expect((b as Record<string, unknown>)['accountPresence']).toBe(w.worker['accountPresence']);
    await m.theCreationBuilder();
    expect(w.starts).toBe(1);
  });

  /* RED WHEN: a worker that cannot read the account is handed as one that can. */
  it('hands no read when the worker has none', async () => {
    const { accountPresence: _gone, ...rest } = aWorker();
    w.worker = rest;
    const m = await load();
    expect(await m.theCreationBuilder()).toEqual({});
  });
});
