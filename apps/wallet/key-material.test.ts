// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makePinnedKeyMaterialProvider, recordKeyAsk, recordingKeyMaterial, sha256Hex,
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

const mapCache = (): ArtefactCache & { readonly store: Map<string, Uint8Array> } => {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    get: async (path) => store.get(path) ?? null,
    put: async (path, bytes) => { store.set(path, bytes); },
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

  it('verified material comes back whole, and is served from memory after', async () => {
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
