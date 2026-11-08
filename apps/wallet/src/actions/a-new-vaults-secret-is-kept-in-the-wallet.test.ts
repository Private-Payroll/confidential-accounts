import { describe, expect, it } from 'vitest';
import { vaultSecretsKeptFor } from './vault-secret-kept.js';

/*
 * **A NEW VAULT'S SECRET IS KEPT IN THE WALLET'S OWN STORE, FOR ONE PERSON AND ONE VAULT, UNTIL IT IS DROPPED.** The
 * store is stood in for by a map; one that will not keep it refuses, so the filing that would follow never leaves.
 */

const storeOf = (refuses = false) => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { if (!refuses) m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
};
/* The wallet's sealing key stood in for by one made the same way: AES-GCM, not extractable. */
const sealWith = async (fails = false) => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
  return {
    seal: async (plain: string) => {
      if (fails) throw new Error('the sealing key is not here');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return { iv: b64(iv), sealed: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)))) };
    },
    open: async (k: { iv: string; sealed: string }) => {
      try {
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(k.iv, 'base64') }, key, Buffer.from(k.sealed, 'base64')));
      } catch { return null; }
    },
  };
};
const V = 'ab'.repeat(32) as never;
const FILED = { version: 1, sealed: 'cd' } as never;

describe('a new vault\'s secret kept in the wallet', () => {
  it('is held for the person and the vault it was kept for, and dropped when asked', async () => {
    const store = storeOf();
    const seal = await sealWith();
    const ada = vaultSecretsKeptFor('usr_ada', store, seal);
    await ada.keep(V, FILED);
    // RED WHEN: the kept record lies in the store as plain text, not sealed under the wallet's own key
    expect([...store.m.values()].join()).not.toContain('"sealed":"cd"');
    // RED WHEN: a kept secret is not given back, or is given back to another person or for another vault
    expect(await ada.held(V)).toEqual(FILED);
    expect(await vaultSecretsKeptFor('usr_bo', store, seal).held(V)).toBeNull();
    expect(await ada.held('ef'.repeat(32) as never)).toBeNull();
    await ada.drop(V);
    // RED WHEN: a secret is kept on after the vault has started
    expect(await ada.held(V)).toBeNull();
  });

  it('refuses when the store did not keep it', async () => {
    // RED WHEN: a secret the store refused is reported kept, so its filing leaves with no copy in the wallet
    await expect(vaultSecretsKeptFor('usr_ada', storeOf(true), await sealWith()).keep(V, FILED)).rejects.toThrow(/could not keep/);
    // RED WHEN: a secret that could not be sealed is kept in the open, or reported kept
    const store = storeOf();
    await expect(vaultSecretsKeptFor('usr_ada', store, await sealWith(true)).keep(V, FILED)).rejects.toThrow(/could not keep/);
    expect(store.m.size).toBe(0);
  });

  it('gives nothing back that does not open under the wallet\'s key', async () => {
    const store = storeOf();
    await vaultSecretsKeptFor('usr_ada', store, await sealWith()).keep(V, FILED);
    // RED WHEN: a record another key sealed, or a plain one written into the store, is taken as the kept secret
    expect(await vaultSecretsKeptFor('usr_ada', store, await sealWith()).held(V)).toBeNull();
    store.m.set([...store.m.keys()][0]!, JSON.stringify(FILED));
    expect(await vaultSecretsKeptFor('usr_ada', store, await sealWith()).held(V)).toBeNull();
  });

  it('keeps a secret run\'s copies tree for the person, the vault and the commitment it sets, sealed, and refuses when the store will not', async () => {
    const store = storeOf();
    const seal = await sealWith();
    const ada = vaultSecretsKeptFor('usr_ada', store, seal);
    const RUN = { vault: 'ab'.repeat(32), commitment: 'c3'.repeat(32), previous: '00'.repeat(32), copies: [{ reader: 'e1'.repeat(32), parts: ['f1'.repeat(32)], path: [] }] };
    await ada.keepRun!(V, RUN);
    // RED WHEN: the copies tree lies in the store as plain text
    expect([...store.m.values()].join()).not.toContain('f1f1');
    // RED WHEN: the tree is not given back, or given back for another person, vault or commitment
    expect(await ada.runHeld!(V, 'c3'.repeat(32) as never)).toEqual(RUN);
    expect(await ada.runHeld!(V, 'c4'.repeat(32) as never)).toBeNull();
    expect(await vaultSecretsKeptFor('usr_bo', store, seal).runHeld!(V, 'c3'.repeat(32) as never)).toBeNull();
    // RED WHEN: a later run of the same secret overwrites the earlier one, so who the earlier one sealed it to is lost
    const LATER = { ...RUN, copies: [{ reader: 'e2'.repeat(32), parts: ['f2'.repeat(32)], path: [] }] };
    await ada.keepRun!(V, LATER);
    await ada.keepRun!(V, LATER);
    expect(await ada.runsHeld!(V, 'c3'.repeat(32) as never)).toEqual([RUN, LATER]);
    expect(await ada.runHeld!(V, 'c3'.repeat(32) as never)).toEqual(LATER);
    // RED WHEN: a tree the store refused is reported kept, so the approval would go out with no copy in the wallet
    await expect(vaultSecretsKeptFor('usr_ada', storeOf(true), seal).keepRun!(V, RUN)).rejects.toThrow(/could not keep the run/);
  });
});
