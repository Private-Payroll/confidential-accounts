// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KEYS_FOLDER, VAULT_KEYS_FOLDER, idbArtefactCache, makePinnedKeyMaterialProvider, recordKeyAsk, recordingKeyMaterial, sha256Hex,
} from './key-material.js';
import type { ArtefactCache, KeyAskRecord, KeyMaterialAsk } from './key-material.js';

/*
 * KEY MATERIAL FROM OUR OWN ORIGIN, HASH-PINNED. What these
 * tests hold: nothing unpinned is ever handed to the prover; a mismatch
 * REFUSES rather than retries; nothing here can even name the Foundation's
 * bucket (there is no fallback to fall back to); and the cache is a
 * convenience that gets re-verified, never a source of truth.
 */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A tiny vendored origin: manifest + files, with counted fetches. */
const fakeOrigin = async (files: Record<string, Uint8Array>) => {
  const artefacts: Record<string, { bytes: number; sha256: string }> = {};
  for (const [path, bytes] of Object.entries(files)) {
    artefacts[path] = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
  }
  const manifest = { version: 9, generatedAt: '2026-08-20', artefacts };
  const fetched: string[] = [];
  const fetchFn = (async (url: string) => {
    fetched.push(url);
    if (url === '/keys/manifest.json') {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    const path = url.replace('/keys/', '');
    const bytes = files[path];
    return bytes
      ? new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
      : new Response('no such artefact', { status: 404 });
  }) as typeof fetch;
  return { manifest, fetched, fetchFn };
};

const mapCache = (): ArtefactCache & { readonly store: Map<string, Uint8Array>; readonly read: string[] } => {
  const store = new Map<string, Uint8Array>();
  const read: string[] = [];
  return {
    store,
    read,
    get: async (path) => { read.push(path); return store.get(path)?.slice() ?? null; },
    put: async (path, bytes) => { store.set(path, bytes.slice()); },
    remove: async (path) => { store.delete(path); },
  };
};

const dustFiles = (): Record<string, Uint8Array> => ({
  'dust/9/spend.prover': bytesOf('the prover key'),
  'dust/9/spend.verifier': bytesOf('the verifier key'),
  'dust/9/spend.bzkir': bytesOf('the circuit ir'),
  bls_midnight_2p14: bytesOf('the shared parameters, size 14'),
});

describe('the remedy these refusals name is a remedy that exists', () => {
  /*
   * EVERY REFUSAL BELOW ENDS BY TELLING A STRANGER WHAT TO RUN. An earlier
   * version named a local double-click tool that a clone of this repository
   * does not have; it now names `npm run vendor-keys`, and this asserts that
   * script is really there.
   *
   * **THE ASSERTIONS BELOW PIN THE MESSAGE TEXT AND CANNOT PIN THIS.** Rename
   * the script in `package.json` and every one of them stays green while the
   * remedy a person is told to run answers `Missing script`. That is the same
   * shape — an honest failure state pointing at nothing — which is the defect
   * naming a real script existed to remove, so it gets its own check rather
   * than being assumed.
   */
  it('`npm run vendor-keys` is a script this package actually defines', async () => {
    /* `process.cwd()` and not `import.meta.url`: this file runs under jsdom,
     * where `import.meta.url` is not a file URL. Vitest's cwd is the project
     * root — the same root `npm run` resolves scripts from. */
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['vendor-keys']).toBeTruthy();
  });
});

describe('nothing unpinned reaches the prover', () => {
  it('no manifest → refuses, naming `npm run vendor-keys` — vendoring is the remedy', async () => {
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: (async () => new Response('not here', { status: 404 })) as typeof fetch,
      cache: mapCache(),
    });
    await expect(provider.lookupKey('midnight/dust/spend'))
      .rejects.toThrow(/npm run vendor-keys/u);
    /* And the refusal says the one thing that must never happen. */
    await expect(provider.getParams(14)).rejects.toThrow(/never falls back/u);
  });

  it('verified material comes back whole, and the origin is not asked for it again', async () => {
    const origin = await fakeOrigin(dustFiles());
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(),
    });
    const material = await provider.lookupKey('midnight/dust/spend');
    expect(material).toBeTruthy();
    expect(new TextDecoder().decode(material?.proverKey)).toBe('the prover key');
    expect(new TextDecoder().decode(material?.ir)).toBe('the circuit ir');
    const fetchesAfterFirst = origin.fetched.length;
    await provider.lookupKey('midnight/dust/spend');
    expect(origin.fetched.length).toBe(fetchesAfterFirst);
    /* getParams too. */
    const params = await provider.getParams(14);
    expect(new TextDecoder().decode(params)).toBe('the shared parameters, size 14');
  });

  it('a hash mismatch REFUSES TO PROVE, loudly, with both hashes — and asks nobody else', async () => {
    const files = dustFiles();
    const origin = await fakeOrigin(files);
    /* The origin starts serving different bytes than were pinned. */
    files['dust/9/spend.prover'] = bytesOf('NOT the prover key');
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(),
    });
    await expect(provider.lookupKey('midnight/dust/spend'))
      .rejects.toThrow(/REFUSING TO PROVE/u);
    /* NO FALLBACK: every request this provider ever made was to our own
     * origin — the bucket's host cannot appear because no code path knows
     * it. This is the "never fall back" half of the fix, held as a pin. */
    expect(origin.fetched.every((url) => url.startsWith('/keys/'))).toBe(true);
  });

  it('a parameter size the vendoring did not cover refuses by name', async () => {
    const origin = await fakeOrigin(dustFiles());
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(),
    });
    await expect(provider.getParams(17)).rejects.toThrow(/bls_midnight_2p17/u);
    await expect(provider.getParams(17)).rejects.toThrow(/npm run vendor-keys/u);
  });

  it('an unknown circuit answers undefined — the SDK\'s own contract for it', async () => {
    const origin = await fakeOrigin(dustFiles());
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(),
    });
    expect(await provider.lookupKey('midnight/no-such/circuit')).toBeUndefined();
  });
});

describe('the cache is a convenience, never a source of truth', () => {
  it('a damaged cache entry is discarded and the origin copy re-verified', async () => {
    const origin = await fakeOrigin(dustFiles());
    const cache = mapCache();
    cache.store.set('dust/9/spend.prover', bytesOf('rotted bytes'));
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache,
    });
    const material = await provider.lookupKey('midnight/dust/spend');
    expect(new TextDecoder().decode(material?.proverKey)).toBe('the prover key');
    /* The rot was evicted and replaced by the verified copy. */
    expect(new TextDecoder().decode(cache.store.get('dust/9/spend.prover') ?? new Uint8Array()))
      .toBe('the prover key');
  });

  it('a fresh provider serves from the (re-verified) cache without refetching artefacts', async () => {
    const origin = await fakeOrigin(dustFiles());
    const cache = mapCache();
    const first = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache });
    await first.getParams(14);
    const counted = origin.fetched.filter((u) => u !== '/keys/manifest.json').length;
    const second = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache });
    await second.getParams(14);
    expect(origin.fetched.filter((u) => u !== '/keys/manifest.json').length).toBe(counted);
  });
});

describe('the recording wrapper sees every ask — the probe\'s eyes on getParams(k)', () => {
  it('reports circuits and the parameter size k, with sizes', async () => {
    const origin = await fakeOrigin(dustFiles());
    const asks: KeyMaterialAsk[] = [];
    const provider = recordingKeyMaterial(
      makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache: mapCache() }),
      (ask) => asks.push(ask));
    await provider.lookupKey('midnight/dust/spend');
    await provider.getParams(14);
    expect(asks.map((a) => a.kind)).toEqual(['circuit', 'params']);
    const params = asks[1];
    if (params?.kind !== 'params') throw new Error('no params ask');
    expect(params.k).toBe(14);
    expect(params.bytes).toBeGreaterThan(0);
  });
});

/*
 * WHICH CIRCUITS A PROOF ASKS FOR IS MEASURED, NOT ASSERTED.
 *
 * The recorder has reported circuit asks all along; every caller dropped
 * them, so the parameter half of the key-hosting number came from real asks
 * and the circuit half was summed from what happened to be vendored. These
 * pin that a circuit ask is RECORDED, and that a pre-fetch can never be
 * counted as a proof's ask — the distinction is the whole finding.
 */
describe('a circuit ask is recorded, and who asked is kept', () => {
  const circuitAsk = (keyLocation: string): KeyMaterialAsk => ({
    kind: 'circuit', keyLocation, ms: 3, proverBytes: 11_020_001,
  });

  it('THE PIN: a circuit ask is recorded rather than dropped', () => {
    const into: KeyAskRecord = {};
    recordKeyAsk(into, circuitAsk('midnight/zswap/spend'), 'proof');
    expect(into.circuitsAsked).toHaveLength(1);
    expect(into.circuitsAsked?.[0]?.keyLocation).toBe('midnight/zswap/spend');
    expect(into.circuitsAsked?.[0]?.proverBytes).toBe(11_020_001);
  });

  it('a parameter ask still records exactly as it did', () => {
    const into: KeyAskRecord = {};
    recordKeyAsk(into, { kind: 'params', k: 13, ms: 8, bytes: 1_573_252 }, 'proof');
    expect(into.paramsFetched).toEqual([{ k: 13, ms: 8, bytes: 1_573_252 }]);
    expect(into.circuitsAsked).toBeUndefined();
  });

  it('the probe\'s own pre-fetch is never counted as a proof\'s ask', () => {
    const into: KeyAskRecord = {};
    recordKeyAsk(into, circuitAsk('midnight/zswap/spend'), 'probe-prefetch');
    recordKeyAsk(into, circuitAsk('midnight/dust/spend'), 'proof');
    const byProof = (into.circuitsAsked ?? []).filter((c) => c.askedBy === 'proof');
    expect(byProof.map((c) => c.keyLocation)).toEqual(['midnight/dust/spend']);
  });

  it('the recorder and the record agree — every ask the wrapper sees is storable', async () => {
    const origin = await fakeOrigin(dustFiles());
    const into: KeyAskRecord = {};
    const provider = recordingKeyMaterial(
      makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache: mapCache() }),
      (ask) => recordKeyAsk(into, ask, 'proof'));
    await provider.lookupKey('midnight/dust/spend');
    await provider.getParams(14);
    expect(into.circuitsAsked?.map((c) => c.keyLocation)).toEqual(['midnight/dust/spend']);
    expect(into.paramsFetched?.map((p) => p.k)).toEqual([14]);
  });
});

const ADDRESS = 'c0'.repeat(32);
const accountFiles = (): Record<string, Uint8Array> => ({
  [`${ACCOUNT_KEYS_FOLDER}/propose.prover`]: bytesOf('the proposal prover key'),
  [`${ACCOUNT_KEYS_FOLDER}/propose.verifier`]: bytesOf('the proposal verifier key'),
  [`${ACCOUNT_KEYS_FOLDER}/propose.bzkir`]: bytesOf('the proposal circuit'),
  [`${ACCOUNT_KEYS_FOLDER}/clearRun.prover`]: bytesOf('a prover key the wallet does not use'),
  [`${ACCOUNT_KEYS_FOLDER}/clearRun.verifier`]: bytesOf('a verifier key the wallet does not use'),
  [`${ACCOUNT_KEYS_FOLDER}/clearRun.bzkir`]: bytesOf('a circuit the wallet does not prove'),
});
const locationOf = async (circuit: string, verifier: Uint8Array): Promise<string> =>
  `contract:${ADDRESS}/${circuit}?vk=${await sha256Hex(verifier)}`;
/** The verifier keys this build compiled, as the account's module names them. */
const compiledFrom = async (files: Record<string, Uint8Array>): Promise<Record<string, string>> => ({
  propose: await sha256Hex(files[`${ACCOUNT_KEYS_FOLDER}/propose.verifier`]!),
  clearRun: await sha256Hex(files[`${ACCOUNT_KEYS_FOLDER}/clearRun.verifier`]!),
});

describe('a company account circuit is served by the location the contract names', () => {
  it('a circuit the wallet proves is served from its own pinned files, by the contract\'s location', async () => {
    // RED WHEN: the provider answers a contract's key location with nothing, so the wallet cannot prove a call to the company account
    const files = accountFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache: mapCache(), accountCircuits: ['propose'], compiledVerifierKeys: await compiledFrom(files) });
    const material = await provider.lookupKey(await locationOf('propose', files[`${ACCOUNT_KEYS_FOLDER}/propose.verifier`]!));
    expect(new TextDecoder().decode(material?.proverKey)).toBe('the proposal prover key');
    expect(new TextDecoder().decode(material?.ir)).toBe('the proposal circuit');
    expect(new TextDecoder().decode(await provider.accountVerifierKey('propose'))).toBe('the proposal verifier key');
  });

  it('a location naming another verifier key is refused, and nothing is proved', async () => {
    // RED WHEN: a key is served for a call that names a different verifier key, so a proof is made against a key the contract does not hold
    const files = accountFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache: mapCache(), accountCircuits: ['propose'], compiledVerifierKeys: await compiledFrom(files) });
    await expect(provider.lookupKey(await locationOf('propose', bytesOf('another build\'s verifier key'))))
      .rejects.toThrow(/REFUSING TO PROVE: the call asks for "propose" with the verifier key/u);
  });

  it('a circuit of the account the wallet does not prove is refused before any file is read', async () => {
    // RED WHEN: the wallet serves a key for any circuit of the contract, not only the ones it proves
    const files = accountFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache: mapCache(), accountCircuits: ['propose'], compiledVerifierKeys: await compiledFrom(files) });
    await expect(provider.lookupKey(await locationOf('clearRun', files[`${ACCOUNT_KEYS_FOLDER}/clearRun.verifier`]!)))
      .rejects.toThrow(/"clearRun" is not a circuit of the company account or the vault this wallet proves/u);
    await expect(provider.accountVerifierKey('clearRun')).rejects.toThrow(/not a circuit of the company account/u);
    const transfer = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache: mapCache() });
    await expect(transfer.lookupKey(await locationOf('propose', files[`${ACCOUNT_KEYS_FOLDER}/propose.verifier`]!)))
      .rejects.toThrow(/not a circuit of the company account/u);
    expect(origin.fetched.filter((u) => u.includes('clearRun') || u.includes('propose'))).toEqual([]);
  });
});

describe('a proving key leaves memory with the proof, and a key not kept is said', () => {
  it('each ask reads its key again rather than from a copy kept in memory', async () => {
    // RED WHEN: the provider keeps every key it served in memory for as long as the wallet is open
    const origin = await fakeOrigin(dustFiles());
    const cache = mapCache();
    const provider = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache });
    const first = await provider.lookupKey('midnight/dust/spend');
    const second = await provider.lookupKey('midnight/dust/spend');
    expect(cache.read.filter((p) => p === 'dust/9/spend.prover')).toHaveLength(2);
    expect(second?.proverKey).not.toBe(first?.proverKey);
    await provider.getParams(14);
    await provider.getParams(14);
    expect(cache.read.filter((p) => p === 'bls_midnight_2p14')).toHaveLength(2);
  });

  it('a key this device could not keep is reported with the browser\'s reason, and the proof still gets it', async () => {
    // RED WHEN: a refused write to the device's store is swallowed, so nobody can say the keys are not kept here
    const origin = await fakeOrigin(dustFiles());
    const told: Array<[string, string]> = [];
    const refusing: ArtefactCache = {
      get: async () => null,
      put: async () => { throw new Error('QuotaExceededError: the store is full'); },
      remove: async () => {},
    };
    const provider = makePinnedKeyMaterialProvider({ fetchFn: origin.fetchFn, cache: refusing, onNotKept: (file, why) => told.push([file, why]) });
    const params = await provider.getParams(14);
    expect(new TextDecoder().decode(params)).toBe('the shared parameters, size 14');
    expect(told).toEqual([['bls_midnight_2p14', expect.stringContaining('the store is full')]]);
  });

  it('the device\'s own store rejects a write the browser refused, instead of reporting it kept', async () => {
    // RED WHEN: the device's store resolves a write the browser aborted, so a full store reads as kept
    const was = (globalThis as { indexedDB?: unknown }).indexedDB;
    const db = {
      transaction: () => {
        const tx: Record<string, unknown> = { error: new Error('QuotaExceededError') };
        tx['objectStore'] = () => ({
          put: () => {
            const request: Record<string, unknown> = {};
            queueMicrotask(() => (request['onsuccess'] as (() => void) | undefined)?.());
            queueMicrotask(() => queueMicrotask(() => (tx['onabort'] as (() => void) | undefined)?.()));
            return request;
          },
        });
        return tx;
      },
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => {
        const request: Record<string, unknown> = { result: db };
        queueMicrotask(() => (request['onsuccess'] as (() => void) | undefined)?.());
        return request;
      },
    };
    try {
      await expect(idbArtefactCache().put('bls_midnight_2p14', bytesOf('x'))).rejects.toThrow(/QuotaExceededError/u);
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = was;
    }
  });
});

describe('an account key is served only from the compile the wallet was built with', () => {
  it('a key the call names, but this build did not compile, is refused when a proof asks for it', async () => {
    // RED WHEN: a proof uses an account key from another compile because the call it was built from named that key
    const files = accountFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), accountCircuits: ['propose'], compiledVerifierKeys: { propose: 'ab'.repeat(32) },
    });
    await expect(provider.lookupKey(await locationOf('propose', files[`${ACCOUNT_KEYS_FOLDER}/propose.verifier`]!)))
      .rejects.toThrow(/REFUSING TO PROVE: the verifier key this wallet holds for "propose" .* different compiles/u);
  });

  it('and a call is not built against a verifier key this build did not compile', async () => {
    // RED WHEN: a call is built against an account verifier key from another compile
    const files = accountFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), accountCircuits: ['propose'],
    });
    await expect(provider.accountVerifierKey('propose')).rejects.toThrow(/different compiles/u);
  });
});


const vaultFiles = (): Record<string, Uint8Array> => ({
  [`${VAULT_KEYS_FOLDER}/setNonceSecret.prover`]: bytesOf('the vault secret prover key'),
  [`${VAULT_KEYS_FOLDER}/setNonceSecret.verifier`]: bytesOf('the vault secret verifier key'),
  [`${VAULT_KEYS_FOLDER}/setNonceSecret.bzkir`]: bytesOf('the vault secret circuit'),
  [`${VAULT_KEYS_FOLDER}/deposit.verifier`]: bytesOf('the deposit verifier key'),
  [`${VAULT_KEYS_FOLDER}/deposit.prover`]: bytesOf('a deposit prover key the wallet does not use'),
  [`${VAULT_KEYS_FOLDER}/deposit.bzkir`]: bytesOf('a deposit circuit the wallet does not prove'),
});
const vaultCompiled = async (files: Record<string, Uint8Array>): Promise<Record<string, string>> => ({
  setNonceSecret: await sha256Hex(files[`${VAULT_KEYS_FOLDER}/setNonceSecret.verifier`]!),
  deposit: await sha256Hex(files[`${VAULT_KEYS_FOLDER}/deposit.verifier`]!),
});

describe('a vault circuit the wallet proves is served by the vault\'s location, from the vault\'s own compile', () => {
  it('serves the vault\'s first secret from its own pinned files, and a deploy\'s verifier key for every circuit it holds one of', async () => {
    // RED WHEN: the wallet cannot prove setting a vault's first secret, or cannot build a vault's deploy from keys it holds
    const files = vaultFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), vaultCircuits: ['setNonceSecret'], vaultVerifiers: ['deposit'], compiledVaultVerifierKeys: await vaultCompiled(files),
    });
    const material = await provider.lookupKey(await locationOf('setNonceSecret', files[`${VAULT_KEYS_FOLDER}/setNonceSecret.verifier`]!));
    expect(new TextDecoder().decode(material?.proverKey)).toBe('the vault secret prover key');
    expect(new TextDecoder().decode(await provider.vaultVerifierKey('deposit'))).toBe('the deposit verifier key');
    expect(new TextDecoder().decode(await provider.vaultVerifierKey('setNonceSecret'))).toBe('the vault secret verifier key');
  });

  it('refuses to prove a vault circuit it holds only a verifier key for, one from another compile, and one another key names', async () => {
    const files = vaultFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), vaultCircuits: ['setNonceSecret'], vaultVerifiers: ['deposit'], compiledVaultVerifierKeys: await vaultCompiled(files),
    });
    // RED WHEN: the wallet proves any circuit of the vault, not only the ones it builds
    await expect(provider.lookupKey(await locationOf('deposit', files[`${VAULT_KEYS_FOLDER}/deposit.verifier`]!)))
      .rejects.toThrow(/not a circuit of the company account or the vault this wallet proves/u);
    // RED WHEN: a vault verifier key the wallet does not hold for any circuit is served
    await expect(provider.vaultVerifierKey('payout')).rejects.toThrow(/not a circuit of the vault this wallet builds/u);
    // RED WHEN: a proof asks for the vault circuit with another verifier key and is served the wallet's
    await expect(provider.lookupKey(await locationOf('setNonceSecret', bytesOf('another vault\'s verifier key'))))
      .rejects.toThrow(/REFUSING TO PROVE: the call asks for "setNonceSecret" with the verifier key/u);
    const another = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), vaultCircuits: ['setNonceSecret'], compiledVaultVerifierKeys: { setNonceSecret: 'ab'.repeat(32) },
    });
    // RED WHEN: a vault key from another compile than this build's vault is served for a proof or a deploy
    await expect(another.lookupKey(await locationOf('setNonceSecret', files[`${VAULT_KEYS_FOLDER}/setNonceSecret.verifier`]!)))
      .rejects.toThrow(/this build's vault was compiled with .* different compiles/u);
    await expect(another.vaultVerifierKey('setNonceSecret')).rejects.toThrow(/different compiles/u);
  });
});

const calleeFiles = (): Record<string, Uint8Array> => ({
  ...vaultFiles(),
  [`${ACCOUNT_KEYS_FOLDER}/approveVaultChange.prover`]: bytesOf('the account approval prover key'),
  [`${ACCOUNT_KEYS_FOLDER}/approveVaultChange.verifier`]: bytesOf('the account approval verifier key'),
  [`${ACCOUNT_KEYS_FOLDER}/approveVaultChange.bzkir`]: bytesOf('the account approval circuit'),
  [`${ACCOUNT_KEYS_FOLDER}/recordPaymentFromVault.prover`]: bytesOf('a payment prover key the wallet does not use'),
  [`${ACCOUNT_KEYS_FOLDER}/recordPaymentFromVault.verifier`]: bytesOf('a payment verifier key the wallet does not use'),
  [`${ACCOUNT_KEYS_FOLDER}/recordPaymentFromVault.bzkir`]: bytesOf('a payment circuit the wallet does not prove'),
});
const calleeCompiled = async (files: Record<string, Uint8Array>): Promise<Record<string, string>> => ({
  approveVaultChange: await sha256Hex(files[`${ACCOUNT_KEYS_FOLDER}/approveVaultChange.verifier`]!),
  recordPaymentFromVault: await sha256Hex(files[`${ACCOUNT_KEYS_FOLDER}/recordPaymentFromVault.verifier`]!),
});

describe('the account circuit a vault circuit the wallet proves calls is served for that call alone', () => {
  it('serves the account\'s approval that setting a vault\'s secret asks for, from the account\'s own pinned files', async () => {
    // RED WHEN: the wallet holds no key for the account call that setting a vault's secret makes, so every new vault stops before its first secret
    const files = calleeFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), vaultCircuits: ['setNonceSecret'],
      compiledVerifierKeys: await calleeCompiled(files), compiledVaultVerifierKeys: await vaultCompiled(files),
    });
    const material = await provider.lookupKey(await locationOf('approveVaultChange', files[`${ACCOUNT_KEYS_FOLDER}/approveVaultChange.verifier`]!));
    expect(new TextDecoder().decode(material?.proverKey)).toBe('the account approval prover key');
    expect(new TextDecoder().decode(material?.ir)).toBe('the account approval circuit');
  });

  it('refuses that key to a wallet that does not prove its caller, refuses an account call no vault circuit it proves makes, and builds no call to it', async () => {
    const files = calleeFiles();
    const origin = await fakeOrigin(files);
    const compiled = await calleeCompiled(files);
    const withoutCaller = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), vaultCircuits: ['writeSecretCopy', 'deposit'], compiledVerifierKeys: compiled,
    });
    // RED WHEN: the account's approval is served to any wallet that proves a vault circuit, not only one that proves the circuit calling it
    await expect(withoutCaller.lookupKey(await locationOf('approveVaultChange', files[`${ACCOUNT_KEYS_FOLDER}/approveVaultChange.verifier`]!)))
      .rejects.toThrow(/"approveVaultChange" is not a circuit of the company account or the vault this wallet proves/u);
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), vaultCircuits: ['setNonceSecret', 'writeSecretCopy', 'deposit'], compiledVerifierKeys: compiled,
    });
    // RED WHEN: the wallet serves a key for an account circuit only a vault payment calls, which no circuit it proves makes
    await expect(provider.lookupKey(await locationOf('recordPaymentFromVault', files[`${ACCOUNT_KEYS_FOLDER}/recordPaymentFromVault.verifier`]!)))
      .rejects.toThrow(/"recordPaymentFromVault" is not a circuit of the company account or the vault this wallet proves/u);
    // RED WHEN: the wallet builds a call of its own to the account's approval, which only a vault's circuit may make
    await expect(provider.accountVerifierKey('approveVaultChange')).rejects.toThrow(/not a circuit of the company account this wallet proves/u);
    expect(origin.fetched.filter((u) => u.includes('recordPaymentFromVault') || u.includes('approveVaultChange'))).toEqual([]);
  });

  it('refuses the account\'s approval from another compile than this build\'s account', async () => {
    // RED WHEN: the key for the account call a vault's secret makes is served without being checked against this build's account
    const files = calleeFiles();
    const origin = await fakeOrigin(files);
    const provider = makePinnedKeyMaterialProvider({
      fetchFn: origin.fetchFn, cache: mapCache(), vaultCircuits: ['setNonceSecret'], compiledVerifierKeys: { approveVaultChange: 'ab'.repeat(32) },
    });
    await expect(provider.lookupKey(await locationOf('approveVaultChange', files[`${ACCOUNT_KEYS_FOLDER}/approveVaultChange.verifier`]!)))
      .rejects.toThrow(/this build's company account was compiled with .* different compiles/u);
  });
});
