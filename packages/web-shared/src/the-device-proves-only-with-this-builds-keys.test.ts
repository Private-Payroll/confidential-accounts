/**
 * **THE VAULT WORKER PROVES ONLY WITH THE KEYS THIS BUILD WAS COMPILED WITH.**
 *
 * The service hands the worker every file a proof needs. These tests serve the
 * real compiled files of this build, then the same files with one byte changed,
 * through the one source the worker composes, and through the worker's own
 * loader, and show that only this build's bytes are ever used.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadDeps, thisBuildsSources, type ThisBuild } from './vault-worker-entry.js';
import { MemoryArtefactCache, ProvingMaterialRefused } from './key-material.js';
import { byCircuitName, zkConfigOver } from './zk-config.js';
import { VAULT_CIRCUITS } from '../../../src/midnight/vault-contract.js';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import * as accountModule from '../../../contracts/managed/contract/index.js';
import vaultManifest from '../../../contracts/managed-vault/compiler/contract-manifest.json';
import accountManifest from '../../../contracts/managed/compiler/contract-manifest.json';
import networkKeys from '../../../apps/wallet/public/keys/manifest.json';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const BUILD: ThisBuild = {
  vault: { expectedVk: (vaultModule as any).expectedVk, manifest: vaultManifest as any },
  account: { expectedVk: (accountModule as any).expectedVk, manifest: accountManifest as any },
  network: networkKeys as any,
};
const vk = (which: 'vault' | 'account', c: string): string => BUILD[which].expectedVk[c]!;
const at = (circuit: string, which: 'vault' | 'account' = 'vault'): string => `contract:${'ab'.repeat(32)}/${circuit}?vk=${vk(which, circuit)}`;

/* The contract files this application's service would serve, read from this build's own folders. */
const fileFor = (url: string): string | null => {
  const m = /^\/artefacts\/vault(\/account)?\/(keys|zkir)\/(\w+\.(?:prover|verifier|bzkir))$/u.exec(url);
  if (m) return join(ROOT, 'contracts', m[1] ? 'managed' : 'managed-vault', m[2]!, m[3]!);
  /* The network's shielded circuits, as this build's wallet carries them. */
  const network = /^\/artefacts\/vault\/builtin\/zswap\/9\/(?:keys|zkir)\/(\w+\.(?:prover|verifier|bzkir))$/u.exec(url);
  if (network) return join(ROOT, NETWORK_KEYS, network[1]!);
  return null;
};
/* Where this build's wallet carries the network's shielded circuits once they are fetched and checked against its pins. */
const NETWORK_KEYS = 'apps/wallet/public/keys/zswap/9';
const HAS_KEYS = Object.keys(BUILD.vault.expectedVk).length > 0
  && existsSync(join(ROOT, 'contracts', 'managed-vault', 'keys', 'payout.prover'))
  && existsSync(join(ROOT, 'contracts', 'managed', 'keys', 'anchor.prover'));
/* A deposit's warm-up also fetches the keys of the network's output circuit, which a deposit's coin is made with. */
const HAS_NETWORK_KEYS = existsSync(join(ROOT, NETWORK_KEYS, 'output.prover'))
  && existsSync(join(ROOT, NETWORK_KEYS, 'output.verifier'));

/** A pretend service: the real files, except those a test has changed. */
const aService = () => {
  const changed = new Set<string>();
  const fetched: string[] = [];
  const fetchImpl = (async (url: string) => {
    fetched.push(url);
    const file = fileFor(url);
    if (file === null || !existsSync(file)) return { ok: false, status: 404 } as Response;
    const bytes = new Uint8Array(readFileSync(file));
    if (changed.has(url)) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  }) as unknown as typeof fetch;
  return { changed, fetched, fetchImpl };
};

const refused = async (work: Promise<unknown>, kind: string): Promise<void> => {
  const e = await work.then(() => null, (x: unknown) => x);
  expect(e, `proved with what should have been refused as ${kind}`).toBeInstanceOf(ProvingMaterialRefused);
  expect((e as ProvingMaterialRefused).kind).toBe(kind);
};

describe('THE NETWORK\'S SHIELDED CIRCUITS AND THE PUBLIC PARAMETERS THE WORKER PROVES WITH', () => {
  it('are checked against the network\'s own pins and Midnight\'s published digests, so other bytes are refused', async () => {
    /* RED WHEN: the worker's source proves a shielded circuit or with public parameters it has not checked. */
    const served = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } })) as unknown as typeof fetch;
    const { source } = thisBuildsSources({ fetchImpl: served, cache: new MemoryArtefactCache() }, BUILD);
    await refused(source.lookupKey('midnight/zswap/spend'), 'other-bytes-served');
    await refused(source.getParams(9), 'other-bytes-served');
  });
});

describe.skipIf(!HAS_KEYS)('THE ONE SOURCE THE VAULT WORKER PROVES FROM [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
  it('this build\'s own files are used for a vault payment, the company\'s anchor and its recovery', async () => {
    /* RED WHEN: the anchor or its recovery is fetched from the vault's folder, or a file of this build is refused. */
    const s = aService();
    const { source } = thisBuildsSources({ fetchImpl: s.fetchImpl, cache: new MemoryArtefactCache() }, BUILD);
    for (const location of [at('payout'), at('anchor', 'account'), at('recoverAnchor', 'account')]) {
      expect(await source.lookupKey(location), location).toBeDefined();
    }
    expect(s.fetched.filter((u) => /anchor|recoverAnchor/u.test(u)).every((u) => u.startsWith('/artefacts/vault/account/'))).toBe(true);
  });

  it('a proving key the service changed by one byte is refused by name, in the vault\'s folder and the account\'s', async () => {
    /* RED WHEN: the composed source trusts any of its folders. */
    for (const [location, url] of [
      [at('payout'), '/artefacts/vault/keys/payout.prover'],
      [at('anchor', 'account'), '/artefacts/vault/account/keys/anchor.prover'],
    ] as const) {
      const s = aService();
      s.changed.add(url);
      const { source } = thisBuildsSources({ fetchImpl: s.fetchImpl, cache: new MemoryArtefactCache() }, BUILD);
      await refused(source.lookupKey(location), 'other-bytes-served');
    }
  });

  it('a vault deployed from this device carries this build\'s verifying keys, never ones the service changed', async () => {
    /* RED WHEN: the verifying keys a deploy puts on the chain are read by bare circuit name without a check. */
    const s = aService();
    const zk = zkConfigOver(thisBuildsSources({ fetchImpl: s.fetchImpl, cache: new MemoryArtefactCache() }, BUILD).source, byCircuitName);
    const keys = await zk.getVerifierKeys([...VAULT_CIRCUITS]);
    expect(keys.map(([c]) => c)).toEqual([...VAULT_CIRCUITS]);

    const t = aService();
    t.changed.add('/artefacts/vault/keys/retire.verifier');
    const zkChanged = zkConfigOver(thisBuildsSources({ fetchImpl: t.fetchImpl, cache: new MemoryArtefactCache() }, BUILD).source, byCircuitName);
    await refused(zkChanged.getVerifierKeys([...VAULT_CIRCUITS]), 'other-bytes-served');
  });

  it('the worker\'s own loader proves, deploys and checks a creation with the checked source', async () => {
    /* RED WHEN: the worker's loader builds its source, or the creation's key check, over unchecked fetches. */
    const s = aService();
    s.changed.add('/artefacts/vault/keys/payout.verifier');
    s.changed.add('/artefacts/vault/account/keys/adopt.verifier');
    const noStore = { open: () => { const r: any = {}; queueMicrotask(() => r.onerror?.()); return r; } };
    const deps = await loadDeps({ indexedDB: noStore, fetch: s.fetchImpl, console: { warn: () => {} } })();
    await refused((deps as any).zkConfig.getVerifierKey('payout'), 'other-bytes-served');
    await refused(deps.vaultKeys.getVerifierKey('payout'), 'other-bytes-served');
    await refused(deps.accountKeys.getVerifierKey('adopt'), 'other-bytes-served');
    expect((await deps.vaultKeys.getVerifierKey('retire')).length).toBeGreaterThan(0);
  }, 60_000);

  it.skipIf(!HAS_NETWORK_KEYS)('the worker\'s own loader warms a deposit\'s keys through the checked source, so another build\'s key is refused [needs apps/wallet/public/keys/zswap/9 as well; `npm run vendor-keys` fetches it]', async () => {
    /* RED WHEN: the files fetched right after sign-in are read through a source that does not check them against this build. */
    const s = aService();
    s.changed.add('/artefacts/vault/keys/deposit.prover');
    /*
     * Reading a circuit's size means parsing it, over a minute in a browser, so every circuit answers here with
     * nothing. It answers only once every key the warm-up asked for has been fetched and checked, so the changed
     * key's refusal is the first failure on any machine, however slow. The worker says it is busy as each artefact
     * is asked for and again as it settles: the asks are all made before the first fetch, and every key has settled
     * when the words after them number the keys fetched.
     */
    let words = 0;
    let asked: number | null = null;
    let keysFetched = 0;
    let released = false;
    const held: Array<() => void> = [];
    const releaseOnceTheKeysSettle = (): void => {
      if (released || asked === null || keysFetched + held.length !== asked || words - asked !== keysFetched) return;
      released = true;
      setTimeout(() => { for (const answer of held.splice(0)) answer(); }, 0);
    };
    const scope = {
      indexedDB: { open: () => { const r: any = {}; queueMicrotask(() => r.onerror?.()); return r; } },
      console: { warn: () => {} },
      postMessage: (word: { kind?: unknown }) => {
        if (word?.kind !== 'vault-worker-busy') return;
        words += 1;
        releaseOnceTheKeysSettle();
      },
      fetch: async (url: string) => {
        asked ??= words;
        if (!url.includes('/zkir/')) {
          keysFetched += 1;
          return s.fetchImpl(url);
        }
        if (!released) {
          await new Promise<void>((answer) => { held.push(answer); releaseOnceTheKeysSettle(); });
        }
        return { ok: false, status: 404 } as Response;
      },
    };
    const deps = await loadDeps(scope)();
    words = 0;
    asked = null;
    keysFetched = 0;
    const e = await deps.provingWarmed().then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ProvingMaterialRefused);
    expect([(e as ProvingMaterialRefused).kind, (e as ProvingMaterialRefused).keyLocation]).toEqual(['other-bytes-served', 'deposit']);
  }, 60_000);
});
