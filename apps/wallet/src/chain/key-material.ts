import type { KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2';
import { parseContractKeyLocation } from '@midnight-ntwrk/compact-js/effect/ContractKeyLocation';
import { describeFailure } from '../lib/failure-text.js';
import { ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS } from './account-circuits.js';

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
 *     read, because a cache is one more place bytes can rot. A write the
 *     browser refuses is reported, so the person can be told the keys are not
 *     kept on this device, rather than paying the download again unseen.
 *
 * Nothing is held in memory between asks: each ask hands out its own copy and
 * keeps none, so a proving key leaves memory with the proof that used it.
 *
 * A company account's or a vault's circuit is asked for by the location the
 * contract SDK gives it (`contract:<address>/<circuit>?vk=<hash of its
 * verifier key>`). It is served only for a circuit the caller names as one
 * this wallet proves, from the files the vendoring copied under `account/` or
 * `vault/`, and only when the verifier key served hashes both to the key this
 * build compiled for that contract and to the `vk` the location carries. A
 * vault circuit the wallet only deploys is served its verifier key alone. An
 * account circuit that a vault circuit the caller names calls inside the same
 * transaction is a proof of its own, asked for by its own location, so it is
 * served from `account/` too, checked the same way; no call to it is built here.
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
 * no IndexedDB; the default is the real one below. `get` hands back a copy the
 * caller owns (it may be moved to a worker); `put` rejects when the bytes were
 * not kept. */
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

/** The real cache. A failed read is a MISS, never an error: the artefacts
 * re-fetch from our own origin and re-verify, so a broken IndexedDB costs
 * bandwidth, not correctness. A failed write rejects, with the browser's
 * reason, once the write's transaction has failed (a full quota surfaces only
 * there), so the provider can report that nothing was kept. */
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
    const db = await keysDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(KEYS_STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('the browser ended the write'));
      transaction.onerror = () => reject(transaction.error ?? new Error('the browser refused the write'));
      transaction.objectStore(KEYS_STORE).put(bytes, path);
    });
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
  /** The company account's circuits this provider may serve, by name. None
   * unless named: a provider made for a transfer proves no contract call. */
  readonly accountCircuits?: readonly string[];
  /** The hash of each account circuit's verifier key as this build compiled it.
   * A key is served only when the file the wallet holds hashes to it, so every
   * proof uses keys from the same compile as the calls it proves. */
  readonly compiledVerifierKeys?: Readonly<Record<string, string>>;
  /** The vault's circuits this provider may serve proving keys for, by name, and with each the company
   * account's circuits it calls in the same transaction. None unless named. */
  readonly vaultCircuits?: readonly string[];
  /** The vault's circuits whose verifier key alone this provider may serve: what a vault's deploy is built with. */
  readonly vaultVerifiers?: readonly string[];
  /** The hash of each vault circuit's verifier key as this build compiled the vault, checked as the account's are. */
  readonly compiledVaultVerifierKeys?: Readonly<Record<string, string>>;
  /** Told each time verified bytes could not be kept on this device, with the
   * file and the browser's reason. Proving goes on: the bytes are verified,
   * only the next action downloads them again. */
  readonly onNotKept?: (path: string, why: string) => void;
}

/**
 * The SDK's two-method provider, and one more ask: the verifier key of one of
 * the account circuits this provider serves, pinned like every other file. A
 * contract call is built against it, so the location the SDK then asks the
 * prover for names the same key.
 */
export interface PinnedKeyMaterial extends KeyMaterialProvider {
  accountVerifierKey(circuit: string): Promise<Uint8Array>;
  /** The verifier key of one of the vault's circuits this provider serves, pinned and checked against this build's vault. */
  vaultVerifierKey(circuit: string): Promise<Uint8Array>;
}

/** The folder under `/keys/` the account circuits' files are vendored into. */
export const ACCOUNT_KEYS_FOLDER = 'account';

/** The folder under `/keys/` the vault circuits' files are vendored into. */
export const VAULT_KEYS_FOLDER = 'vault';

/** What a refused artefact says — one shape, so every failure names the
 * file, the reason, and the remedy in the same breath. */
class KeyMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyMaterialError';
  }
}

/**
 * The provider. Its IndexedDB means a new session re-downloads nothing, and
 * its pins mean that convenience is never trusted. It keeps nothing in
 * memory: every ask is read from the cache or the origin and verified again.
 */
export function makePinnedKeyMaterialProvider(
  options: PinnedKeyMaterialOptions = {},
): PinnedKeyMaterial {
  const base = options.baseUrl ?? '/keys';
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  const cache = options.cache ?? idbArtefactCache();
  const accountCircuits = new Set(options.accountCircuits ?? []);
  const compiled = options.compiledVerifierKeys ?? {};
  const vaultCircuits = new Set(options.vaultCircuits ?? []);
  const vaultVerifiers = new Set([...(options.vaultVerifiers ?? []), ...vaultCircuits]);
  const calledByTheVault = new Set([...vaultCircuits].flatMap((c) => (
    Object.hasOwn(ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS, c) ? ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS[c]! : [])));
  const compiledVault = options.compiledVaultVerifierKeys ?? {};

  /** Refuses an account verifier key that is not the one this build compiled. */
  const thisBuildsIn = (of: Readonly<Record<string, string>>, contract: string) => async (circuit: string, verifierKey: Uint8Array): Promise<void> => {
    const wanted = Object.hasOwn(of, circuit) ? of[circuit] : undefined;
    const held = await sha256Hex(verifierKey);
    if (typeof wanted !== 'string' || held !== wanted.toLowerCase()) {
      throw new KeyMaterialError(`REFUSING TO PROVE: the verifier key this wallet holds for "${circuit}" hashes to ${held}, `
        + `and this build's ${contract} was compiled with ${wanted ?? 'no key for it'}. The keys and the wallet come `
        + `from different compiles, so nothing was proved. Re-vendor the ${contract}'s keys from the same compile.`);
    }
  };
  const thisBuilds = thisBuildsIn(compiled, 'company account');
  const thisBuildsVault = thisBuildsIn(compiledVault, 'vault');

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
    const remedy = path.startsWith(`${ACCOUNT_KEYS_FOLDER}/`) || path.startsWith(`${VAULT_KEYS_FOLDER}/`)
      ? '`npm run compact` then `npm run vendor-keys:account`' : '`npm run vendor-keys`';
    if (!pin) {
      throw new KeyMaterialError(`"${path}" is not in the vendored key material — `
        + `the manifest (made ${pins.generatedAt}) has no pin for it, and an unpinned `
        + `file must not be trusted to ${wanted}. If the SDK now asks for artefacts `
        + 'the vendoring did not cover (a new circuit, a new parameter size, a new '
        + `circuit version), run ${remedy} and read its report.`);
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
        + `own origin (${response.status}) though the manifest pins it. Run `
        + `${remedy}; this wallet never falls back to the bucket.`);
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
    try {
      await cache.put(path, bytes);
    } catch (e) {
      options.onNotKept?.(path, describeFailure(e));
    }
    return bytes;
  };

  /** A circuit's three files, each verified against its pin. */
  const circuitFiles = async (path: string, keyLocation: string) => {
    const [proverKey, verifierKey, ir] = await Promise.all([
      artefact(`${path}.prover`, `prove ${keyLocation}`),
      artefact(`${path}.verifier`, `verify ${keyLocation}`),
      artefact(`${path}.bzkir`, `run ${keyLocation}'s circuit`),
    ]);
    return { proverKey, verifierKey, ir };
  };

  return {
    lookupKey: async (keyLocation: string) => {
      const path = CIRCUIT_PATHS[keyLocation];
      if (path !== undefined) return circuitFiles(path, keyLocation);
      const located = parseContractKeyLocation(keyLocation);
      /* Neither a network circuit nor a contract's: undefined, exactly as the
       * SDK's own provider answers it - the prover owns that error. */
      if (located === undefined) return undefined;
      const ofTheAccount = accountCircuits.has(located.circuitId) || calledByTheVault.has(located.circuitId);
      const ofTheVault = !ofTheAccount && vaultCircuits.has(located.circuitId);
      if (!ofTheAccount && !ofTheVault) {
        throw new KeyMaterialError(`REFUSING TO PROVE: "${located.circuitId}" is not a circuit of the company `
          + 'account or the vault this wallet proves, so no key is served for it and nothing was proved.');
      }
      const material = await circuitFiles(`${ofTheVault ? VAULT_KEYS_FOLDER : ACCOUNT_KEYS_FOLDER}/${located.circuitId}`, keyLocation);
      await (ofTheVault ? thisBuildsVault : thisBuilds)(located.circuitId, material.verifierKey);
      const served = await sha256Hex(material.verifierKey);
      if (served !== located.verifierKeyHash) {
        throw new KeyMaterialError(`REFUSING TO PROVE: the call asks for "${located.circuitId}" with the verifier `
          + `key ${located.verifierKeyHash}, and the key this wallet holds for it hashes to ${served}. A proof `
          + 'made with another key would not be the call that was built, so nothing was proved. The wallet '
          + 'and the contract it was built for disagree: re-vendor its keys from the same compile.');
      }
      return material;
    },
    getParams: async (k: number) => artefact(`bls_midnight_2p${k}`, `prove with parameter size 2^${k}`),
    accountVerifierKey: async (circuit: string) => {
      if (!accountCircuits.has(circuit)) {
        throw new KeyMaterialError(`"${circuit}" is not a circuit of the company account this wallet proves, `
          + 'so no call to it is built here.');
      }
      const key = await artefact(`${ACCOUNT_KEYS_FOLDER}/${circuit}.verifier`, `build a call to ${circuit}`);
      await thisBuilds(circuit, key);
      return key;
    },
    vaultVerifierKey: async (circuit: string) => {
      if (!vaultVerifiers.has(circuit)) {
        throw new KeyMaterialError(`"${circuit}" is not a circuit of the vault this wallet builds, so no key for it is served.`);
      }
      const key = await artefact(`${VAULT_KEYS_FOLDER}/${circuit}.verifier`, `build the vault's ${circuit}`);
      await thisBuildsVault(circuit, key);
      return key;
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
