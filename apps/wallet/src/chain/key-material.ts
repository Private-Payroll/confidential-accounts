import type { KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2';
import { describeFailure } from '../lib/failure-text.js';

/**
 * KEY MATERIAL FROM OUR OWN ORIGIN, HASH-PINNED — closing the CORS defect and the
 * open half of it.
 *
 * WHY THIS FILE EXISTS. Proving needs circuit key material, and the SDK's
 * default provider downloads it from a hardcoded Amazon bucket with "dev" in
 * its name (`makeDefaultKeyMaterialProvider` — wallet-sdk-prover-client/
 * dist/effect/WasmProver.js:146–201). Measured on a real machine, 20 Aug:
 * that bucket has CORS disabled — Amazon's own words, *"CORSResponse: CORS
 * is not enabled for this bucket"* — so no web page anywhere can fetch those
 * keys, and every in-browser send died at proving (measured,
 * a measurement). And nothing ever checked what came back
 * from it: no pin, no checksum, TLS and trust.
 *
 * THE SEAM IS THE SDK'S OWN. `WasmProvingConfiguration` declares
 * `keyMaterialProvider?: KeyMaterialProvider` — optional, injectable
 * (wallet-sdk-capabilities/dist/proving/provingService.d.ts:25). The bucket
 * is only what you get for passing nothing; a row records the day this
 * project mistook that default for a mechanism. This file is the injection:
 * the same two-method shape the SDK's own provider has (`KeyMaterialProvider`
 * — @midnight-ntwrk/zkir-v2/zkir-v2.d.ts:20–23), differing in three
 * deliberate ways:
 *
 *  1. **The artefacts come from THIS wallet's own origin** — `/keys/…`,
 *     vendored onto disk by `npm run vendor-keys`. Same origin, so there is
 *     no CORS to be refused by and no third party whose outage stops a send.
 *  2. **Every byte is verified against a pinned SHA-256 before use** — the
 *     pins live in `/keys/manifest.json`, taken by the vendoring run itself.
 *     A hash that does not match REFUSES TO PROVE, loudly, naming the file
 *     and both hashes. There is no fallback to the bucket — not on mismatch,
 *     not on absence, not ever: a wrong key must stop the wallet, not route
 *     it somewhere less checked.
 *  3. **Verified bytes are cached in IndexedDB**, so proving is not a
 *     20 MB download every session — and the cache is re-verified on every
 *     read, because a cache is one more place bytes can rot.
 */

/* The SDK's own keyLocation → path map, verbatim (WasmProver.js:166–171),
 * including its version-9 path segment. When the SDK bumps the circuit
 * version, these paths change, the vendored files will not exist under the
 * new names, and every proof refuses with the exact missing path — loud,
 * and pointing at the re-vendoring that a new circuit version requires. */
const CIRCUIT_PATHS: Readonly<Record<string, string>> = {
  'midnight/zswap/spend': 'zswap/9/spend',
  'midnight/zswap/output': 'zswap/9/output',
  'midnight/zswap/sign': 'zswap/9/sign',
  'midnight/dust/spend': 'dust/9/spend',
};

export interface KeyManifest {
  /** The circuit version the artefacts were vendored for. */
  readonly version: number;
  /** ISO date of the vendoring run that took the pins. */
  readonly generatedAt: string;
  /** Relative path → its pinned size and SHA-256, hex. */
  readonly artefacts: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
}

/** A place verified bytes rest between sessions. Injectable so tests need
 * no IndexedDB; the default is the real one below. */
export interface ArtefactCache {
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

const KEYS_DB = 'midnight-identity-keys';
const KEYS_STORE = 'artefacts';

function keysDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(KEYS_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(KEYS_STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** The real cache. Any storage failure is treated as a MISS, never an
 * error: the artefacts re-fetch from our own origin and re-verify, so a
 * broken IndexedDB costs bandwidth, not correctness. */
export const idbArtefactCache = (): ArtefactCache => ({
  get: async (path) => {
    try {
      const db = await keysDb();
      return await new Promise((resolve) => {
        const request = db.transaction(KEYS_STORE, 'readonly').objectStore(KEYS_STORE).get(path);
        request.onsuccess = () => {
          resolve(request.result instanceof Uint8Array ? request.result : null);
        };
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },
  put: async (path, bytes) => {
    try {
      const db = await keysDb();
      await new Promise<void>((resolve) => {
        const request = db.transaction(KEYS_STORE, 'readwrite').objectStore(KEYS_STORE)
          .put(bytes, path);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      });
    } catch { /* a cache that cannot write is a cache that misses */ }
  },
  remove: async (path) => {
    try {
      const db = await keysDb();
      await new Promise<void>((resolve) => {
        const request = db.transaction(KEYS_STORE, 'readwrite').objectStore(KEYS_STORE)
          .delete(path);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      });
    } catch { /* gone is gone */ }
  },
});

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

export interface PinnedKeyMaterialOptions {
  /** Where the vendored artefacts are served from. Same origin by default —
   * that is the point. */
  readonly baseUrl?: string;
  /** Injectable for tests; the app uses the real fetch. */
  readonly fetchFn?: typeof fetch;
  /** Injectable for tests; the app uses IndexedDB. */
  readonly cache?: ArtefactCache;
}

/** What a refused artefact says — one shape, so every failure names the
 * file, the reason, and the remedy in the same breath. */
class KeyMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyMaterialError';
  }
}

/**
 * The provider. One instance per facade — its in-memory map means a warm
 * proof re-reads nothing, its IndexedDB means a new session re-downloads
 * nothing, and its pins mean neither of those conveniences is trusted.
 */
export function makePinnedKeyMaterialProvider(
  options: PinnedKeyMaterialOptions = {},
): KeyMaterialProvider {
  const base = options.baseUrl ?? '/keys';
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  const cache = options.cache ?? idbArtefactCache();
  const inMemory = new Map<string, unknown>();

  let manifestPromise: Promise<KeyManifest> | null = null;
  const manifest = (): Promise<KeyManifest> => {
    manifestPromise ??= (async () => {
      let response: Response;
      try {
        response = await fetchFn(`${base}/manifest.json`);
      } catch (e) {
        throw new KeyMaterialError('the key-material manifest could not be read from '
          + `${base}/manifest.json (${describeFailure(e)}). `
          + 'Without it nothing can be verified, so nothing will be proved. '
          + 'Run `npm run vendor-keys` to vendor and pin the key material.');
      }
      if (!response.ok) {
        throw new KeyMaterialError(`there is no key material vendored at ${base} `
          + `(the manifest answered ${response.status}). Proving needs the circuit `
          + 'keys and their pinned hashes on this wallet\'s own origin — run '
          + '`npm run vendor-keys` once, then try again. This wallet never falls '
          + 'back to the Foundation\'s bucket.');
      }
      /* A dev server answers a MISSING file with the app page itself (the
       * SPA fallback, status 200) — measured: the un-vendored state arrived
       * here as "<!DOCTYPE ..." and a JSON parse error. Not-parseable IS
       * not-vendored, and it must say so in the remedy's name. */
      let parsed: KeyManifest;
      try {
        parsed = await response.json() as KeyManifest;
      } catch {
        throw new KeyMaterialError(`there is no key material vendored at ${base} — `
          + 'the server answered something that is not the manifest (typically the '
          + 'app page itself, which is what a dev server serves for a missing '
          + 'file). Run `npm run vendor-keys` once, then try again. This wallet '
          + 'never falls back to the Foundation\'s bucket.');
      }
      if (typeof parsed !== 'object' || parsed === null
        || typeof parsed.artefacts !== 'object' || parsed.artefacts === null) {
        throw new KeyMaterialError(`the manifest at ${base}/manifest.json is damaged — `
          + 'it carries no artefact pins. Re-run `npm run vendor-keys`.');
      }
      return parsed;
    })();
    /* A failed manifest read must not be cached as failure for ever — the
     * person may vendor the keys and press again without reloading. */
    manifestPromise.catch(() => { manifestPromise = null; });
    return manifestPromise;
  };

  /** One artefact: pinned, cached, verified EVERY time it is handed out. */
  const artefact = async (path: string, wanted: string): Promise<Uint8Array> => {
    const pins = await manifest();
    const pin = pins.artefacts[path];
    if (!pin) {
      throw new KeyMaterialError(`"${path}" is not in the vendored key material — `
        + `the manifest (made ${pins.generatedAt}) has no pin for it, and an unpinned `
        + `file must not be trusted to ${wanted}. If the SDK now asks for artefacts `
        + 'the vendoring did not cover (a new circuit, a new parameter size, a new '
        + 'circuit version), re-run `npm run vendor-keys` and read its report.');
    }
    const cached = await cache.get(path);
    if (cached) {
      if (await sha256Hex(cached) === pin.sha256) return cached;
      /* A damaged cache is a miss, not a verdict — the origin copy decides. */
      await cache.remove(path);
    }
    let response: Response;
    try {
      response = await fetchFn(`${base}/${path}`);
    } catch (e) {
      throw new KeyMaterialError(`the vendored "${path}" could not be read from this `
        + `wallet's own origin (${describeFailure(e)}). `
        + 'Nothing was proved.');
    }
    if (!response.ok) {
      throw new KeyMaterialError(`the vendored "${path}" is missing from this wallet's `
        + `own origin (${response.status}) though the manifest pins it. Re-run `
        + '`npm run vendor-keys`; this wallet never falls back to the bucket.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const got = await sha256Hex(bytes);
    if (got !== pin.sha256) {
      throw new KeyMaterialError(`REFUSING TO PROVE: "${path}" does not match its pin. `
        + `The manifest (made ${pins.generatedAt}) pins SHA-256 ${pin.sha256}; the file `
        + `served hashes to ${got}. A proving key that is not the one vendored must `
        + 'never be used — no proof was built, and there is no fallback. Find out '
        + 'what changed the file before re-vendoring.');
    }
    await cache.put(path, bytes);
    return bytes;
  };

  return {
    lookupKey: async (keyLocation: string) => {
      /* Unknown keyLocation → undefined, exactly as the SDK's own provider
       * answers it (WasmProver.js:167–173) — the zkir side owns that error. */
      const path = CIRCUIT_PATHS[keyLocation];
      if (path === undefined) return undefined;
      if (inMemory.has(path)) {
        return inMemory.get(path) as { proverKey: Uint8Array; verifierKey: Uint8Array; ir: Uint8Array };
      }
      const [proverKey, verifierKey, ir] = await Promise.all([
        artefact(`${path}.prover`, `prove ${keyLocation}`),
        artefact(`${path}.verifier`, `verify ${keyLocation}`),
        artefact(`${path}.bzkir`, `run ${keyLocation}'s circuit`),
      ]);
      const material = { proverKey, verifierKey, ir };
      inMemory.set(path, material);
      return material;
    },
    getParams: async (k: number) => {
      const path = `bls_midnight_2p${k}`;
      if (inMemory.has(path)) return inMemory.get(path) as Uint8Array;
      const bytes = await artefact(path, `prove with parameter size 2^${k}`);
      inMemory.set(path, bytes);
      return bytes;
    },
  };
}

/** One key-material ask, seen from outside — what the probe records so the
 * log can say which circuits and WHICH PARAMETER SIZE a real send fetches. */
export type KeyMaterialAsk =
  | { readonly kind: 'circuit'; readonly keyLocation: string; readonly ms: number; readonly proverBytes: number }
  | { readonly kind: 'params'; readonly k: number; readonly ms: number; readonly bytes: number };

/**
 * WHO ASKED. A probe that fetches three named circuits to warm its caches is
 * telling itself what to fetch; a prover asking for a circuit is evidence
 * about what a proof needs. Trouble is what happens when the two are not
 * distinguished — the report printed the pre-fetch and it read as the
 * measurement.
 */
export type KeyAskSource = 'probe-prefetch' | 'proof';

/** Where key-material asks are recorded — the probe's result, in practice. */
export interface KeyAskRecord {
  paramsFetched?: { k: number; ms: number; bytes: number }[];
  circuitsAsked?: {
    keyLocation: string; ms: number; proverBytes: number; askedBy: KeyAskSource;
  }[];
}

/**
 * RECORD ONE ASK.
 *
 * `KeyMaterialAsk` has carried a `'circuit'` variant for a while and every
 * caller handled only `'params'`, so `getParams(k)` was measured and
 * `lookupKey` was silently dropped. The hosting number that came out of the
 * vendored run therefore had a measured half and an asserted half: k = 13,
 * 14, 15 came from real asks, while "20.75 MB of circuits" was summed from
 * everything VENDORED, `zswap/sign` included, which nothing shows a proof
 * ever asking for.
 *
 * The consequence is sharper than a wrong figure. This wallet's provider
 * refuses any unpinned path and has no fallback anywhere, so a send that
 * needs a circuit nobody vendored does not degrade — it stops dead, after
 * the person has pressed send and waited out the proving.
 */
export function recordKeyAsk(
  into: KeyAskRecord,
  ask: KeyMaterialAsk,
  askedBy: KeyAskSource,
): void {
  if (ask.kind === 'params') {
    into.paramsFetched ??= [];
    into.paramsFetched.push({ k: ask.k, ms: ask.ms, bytes: ask.bytes });
    return;
  }
  into.circuitsAsked ??= [];
  into.circuitsAsked.push({
    keyLocation: ask.keyLocation, ms: ask.ms,
    proverBytes: ask.proverBytes, askedBy,
  });
}

/**
 * A see-through wrapper: same provider, every ask reported. Built for the
 * probe — `getParams(k)` was invisible before this, and which `k` a send
 * asks for is the number the hosting decision needs.
 */
export function recordingKeyMaterial(
  inner: KeyMaterialProvider,
  onAsk: (ask: KeyMaterialAsk) => void,
): KeyMaterialProvider {
  return {
    lookupKey: async (keyLocation) => {
      const start = performance.now();
      const material = await inner.lookupKey(keyLocation);
      if (material) {
        onAsk({
          kind: 'circuit', keyLocation,
          ms: Math.round(performance.now() - start),
          proverBytes: material.proverKey.byteLength,
        });
      }
      return material;
    },
    getParams: async (k) => {
      const start = performance.now();
      const bytes = await inner.getParams(k);
      onAsk({
        kind: 'params', k,
        ms: Math.round(performance.now() - start),
        bytes: bytes.byteLength,
      });
      return bytes;
    },
  };
}
