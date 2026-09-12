/**
 * The artefacts a proof needs, fetched over HTTP, with the one number in this
 * whole operation that is genuinely a fraction.
 *
 * ── WHY THIS FILE EXISTS AND THE PROBE VERSION DOES NOT SUFFICE ──────────
 *
 * A probe already fetches these. It reads each artefact with one
 * `res.arrayBuffer()`, which is right for measuring a total and useless for
 * showing anybody anything: a 19 MB proving key is one opaque await, so the
 * only progress it can report is nought and then done. It also keeps what it
 * fetched in a `Map` that dies with the tab, which is fine for comparing a cold
 * run against a warm one and wrong for a person who closed their laptop.
 *
 * ── THE ONLY HONEST PROGRESS IN A PROOF IS HERE, AND THAT DECIDES THE SHAPE ─
 *
 * A proof is one opaque call into WebAssembly. **The prover emits nothing while
 * it runs and there is nowhere to put a callback**: the package's whole surface
 * is `prove`, `check`, `provingProvider`, `jsonIrToBinary` and a class that
 * reads `k` - no callback parameter, no emitter, no abort signal - and the layer
 * above it accepts only a timeout. So the 140 seconds of proving has no
 * fraction and must never be drawn as one.
 *
 * **The download does.** Every artefact arrives with a `Content-Length`, so
 * bytes-received over bytes-expected is a real ratio about a real thing. That
 * asymmetry is the reason this file reports progress and nothing downstream of
 * it does: a screen that draws a bar for the part that has one, and elapsed time
 * for the part that does not, is telling the truth twice rather than splitting
 * the difference.
 *
 * ── NOTHING HERE IS SECRET ───────────────────────────────────────────────
 *
 * Proving keys, verifier keys, the intermediate representation and the
 * structured reference string are public values. The private input is the
 * transaction, and the transaction never leaves the device. That is why these
 * can be served from anywhere and cached anywhere, and it is the whole reason
 * proving on the customer's own machine costs nothing in convenience.
 */
import type { KeyMaterialSource, ProvingKeyMaterial } from '../midnight/wasm-proving.js';

/**
 * What is being fetched and how far it has got.
 *
 * `total` is nullable and callers must handle the null rather than substituting
 * a guess: a server that does not send a length leaves a real unknown, and a
 * bar drawn against an invented denominator is the fake percentage this whole
 * design is written to avoid.
 */
export interface FetchProgress {
  /** Bytes arrived so far, across everything this fetch still needs. */
  readonly received: number;
  /** Bytes expected, or null where the server did not say. */
  readonly total: number | null;
  /** In the product's own words: what the wait is for. */
  readonly what: string;
}

/**
 * Where fetched artefacts are kept between one approval and the next.
 *
 * A separate store from the one that holds jobs, and deliberately: a job is a
 * few hundred bytes of JSON keyed by an id this product minted, and an artefact
 * is tens of megabytes of binary keyed by a location the SDK composed. One
 * store serving both would have to be binary-capable and would make the job
 * records harder to read for no benefit to either.
 */
export interface ArtefactCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** In memory, for tests and for anywhere with no durable store yet. */
export class MemoryArtefactCache implements ArtefactCache {
  private data = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.data.set(key, bytes);
  }
}

/**
 * The circuit id inside a key location.
 *
 * The prover asks for keys by a structured reference - the deployed address,
 * the circuit, and a hash of the verifier key - and only the middle part names
 * a file. Deliberately the same rule the filesystem source uses.
 */
export const circuitOf = (keyLocation: string): string => {
  const afterPath = keyLocation.includes('/')
    ? keyLocation.slice(keyLocation.lastIndexOf('/') + 1)
    : keyLocation;
  const query = afterPath.indexOf('?');
  return query === -1 ? afterPath : afterPath.slice(0, query);
};

/**
 * What a cached artefact is filed under.
 *
 * **THE WHOLE KEY LOCATION, NOT THE CIRCUIT NAME, AND THIS IS THE PART THAT
 * MATTERS.** The location carries the deployed contract address and a hash of
 * the verifier key, so it changes when the contract is redeployed and when it
 * is recompiled. Keying on the circuit alone would serve a key built for one
 * version of a contract to a proof about another, and the failure would arrive
 * as a proof the chain rejects after a fee has been paid - the most expensive
 * place in this system to discover a stale cache.
 *
 * The `kind` prefix separates the three artefacts one location names, and the
 * SRS is keyed by `k` because it belongs to no contract at all.
 */
export const cacheKeyFor = (kind: string, keyLocation: string): string =>
  `artefact:${kind}:${keyLocation}`;

/**
 * Reads a response body a chunk at a time, reporting as it goes.
 *
 * `Content-Length` is read from the header rather than counted afterwards,
 * because a total that only arrives at the end is not a total anybody can wait
 * against. A response without one reports `null` and keeps reporting bytes: a
 * count with no denominator is still worth showing, and it is honest.
 */
const readStreaming = async (
  res: Response,
  what: string,
  already: number,
  onProgress?: (p: FetchProgress) => void,
): Promise<{ bytes: Uint8Array; expected: number | null }> => {
  const header = res.headers.get('content-length');
  const expected = header === null || Number.isNaN(Number(header)) ? null : Number(header);

  /*
   * A body that cannot be streamed is read whole rather than refused. Some
   * environments hand back a response with no reader; the artefact is still
   * correct, and the only thing lost is the intermediate reporting.
   */
  if (!res.body || typeof (res.body as any).getReader !== 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    onProgress?.({ received: already + bytes.length, total: expected === null ? null : already + expected, what });
    return { bytes, expected };
  }

  const reader = (res.body as any).getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress?.({
      received: already + received,
      total: expected === null ? null : already + expected,
      what,
    });
  }

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return { bytes, expected };
};

export interface HttpKeyMaterialOptions {
  /** Told as bytes arrive. The only fraction in the whole operation. */
  onProgress?: (p: FetchProgress) => void;
  /** Survives a reload when it is a durable one. */
  cache?: ArtefactCache;
  /** Injected so a test can drive this without a network. */
  fetchImpl?: typeof fetch;
}

/**
 * The three artefacts one key location names, separately addressable.
 *
 * The prover wants all three at once and asks by key location. Anything
 * building a call wants ONE of them - the verifying key - and the proving key
 * beside it is eighteen megabytes. So the kinds are named, and both callers go
 * through the same fetch and the same cache rather than through two.
 */
export type ArtefactKind = 'prover' | 'verifier' | 'ir';

/**
 * A `KeyMaterialSource` that will also hand over one artefact on its own.
 *
 * **THE EXTRA METHOD EXISTS SO THAT THERE IS STILL ONE FETCHER.** Something
 * that needs only a verifying key, asking through `lookupKey`, would download
 * a proving key and a circuit to get it - which is a second download of the
 * largest file in this system, arriving as a slow first approval rather than
 * as an error.
 */
export interface ArtefactSource extends KeyMaterialSource {
  /**
   * One artefact, from the cache when it is there and over the network when it
   * is not, filed under the same key `lookupKey` files it under.
   */
  artefact(kind: ArtefactKind, keyLocation: string): Promise<Uint8Array>;
}

/**
 * A `KeyMaterialSource` over HTTP.
 *
 * `wasm-proving.ts` takes its material as an interface for exactly one reason,
 * stated in its own header: on a script the artefacts come off the filesystem
 * and in a browser they arrive over the network, and that is the only
 * difference between the two. This is the browser half.
 */
export const httpKeyMaterialSource = (
  base: string,
  options: HttpKeyMaterialOptions = {},
): ArtefactSource => {
  const doFetch = options.fetchImpl ?? fetch;
  const cache = options.cache;

  const cached = async (
    key: string, url: string, what: string, already: number,
  ): Promise<{ bytes: Uint8Array; fetched: boolean }> => {
    const held = await cache?.get(key);
    if (held) return { bytes: held, fetched: false };

    const res = await doFetch(url);
    // The URL and the status, because "failed to fetch" names nothing a person
    // or a later reader can act on.
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const { bytes } = await readStreaming(res, what, already, options.onProgress);
    await cache?.put(key, bytes);
    return { bytes, fetched: true };
  };

  /**
   * Where each artefact is served from, and what to call the wait for it.
   *
   * A table rather than three literals inside `lookupKey`, so that the method
   * that fetches ONE artefact and the method that fetches all three cannot end
   * up disagreeing about a URL or a cache key. Two spellings of the same path
   * would be two cache entries for the same bytes, which is the second
   * download this file exists to avoid.
   */
  const SERVED: Record<ArtefactKind, { url: (circuit: string) => string; what: string }> = {
    prover: { url: (c) => `${base}/keys/${c}.prover`, what: 'fetching the proving key' },
    verifier: { url: (c) => `${base}/keys/${c}.verifier`, what: 'fetching the verifying key' },
    ir: { url: (c) => `${base}/zkir/${c}.bzkir`, what: 'fetching the circuit' },
  };

  const one = (kind: ArtefactKind, keyLocation: string, already: number) =>
    cached(
      cacheKeyFor(kind, keyLocation),
      SERVED[kind].url(circuitOf(keyLocation)),
      SERVED[kind].what,
      already,
    );

  return {
    async artefact(kind: ArtefactKind, keyLocation: string): Promise<Uint8Array> {
      return (await one(kind, keyLocation, 0)).bytes;
    },

    async lookupKey(keyLocation: string): Promise<ProvingKeyMaterial | undefined> {
      /*
       * ONE AT A TIME, WHICH IS THE OPPOSITE OF WHAT THE PROBE DOES AND IS A
       * DELIBERATE TRADE. Three parallel fetches finish sooner and report
       * progress that jumps about, because three interleaved streams share one
       * counter and no single number describes any of them. Sequential is
       * slightly slower and the number moves the way a person expects it to.
       * The proving key is by far the largest of the three, so most of the wait
       * is one artefact either way.
       */
      const prover = await one('prover', keyLocation, 0);
      const verifier = await one('verifier', keyLocation, prover.bytes.length);
      const ir = await one('ir', keyLocation, prover.bytes.length + verifier.bytes.length);

      return { proverKey: prover.bytes, verifierKey: verifier.bytes, ir: ir.bytes };
    },

    async getParams(k: number): Promise<Uint8Array> {
      /*
       * `bls_midnight_2p{k}`, with the older `bls_filecoin_2p{k}` spelling
       * tried second - the same two names the filesystem source tries, and for
       * the same reason: a machine populated from the older download script has
       * the other one.
       */
      let last: unknown;
      for (const name of [`bls_midnight_2p${k}`, `bls_filecoin_2p${k}`]) {
        try {
          const got = await cached(
            `artefact:params:${name}`, `${base}/params/${name}`,
            'fetching the public parameters', 0,
          );
          return got.bytes;
        } catch (e) { last = e; }
      }
      throw new Error(
        `the public parameters for this circuit are not available where the application serves ` +
          `its proving material (k=${k}): ${String((last as any)?.message ?? last)}`,
      );
    },
  };
};

/**
 * The artefact cache, in IndexedDB.
 *
 * Structural over the API rather than typed against `lib.dom`, for the reason
 * the job store gives: this module is imported by code that is typechecked
 * where there is no DOM, and the shape is small enough to state.
 */
export interface IDBFactoryLike {
  open(name: string, version?: number): any;
}

const STORE = 'artefacts';

const openOnce = (factory: IDBFactoryLike, name: string): Promise<any> =>
  new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`could not open the database "${name}"`));
    request.onblocked = () =>
      reject(new Error(`the database "${name}" is open in another tab and is blocking this one`));
  });

export class IndexedDbArtefactCache implements ArtefactCache {
  private db: Promise<any> | null = null;

  constructor(
    private factory: IDBFactoryLike,
    private name = 'confidential-accounts-artefacts',
  ) {}

  private open(): Promise<any> {
    if (!this.db) this.db = openOnce(this.factory, this.name);
    return this.db;
  }

  /**
   * **A MISS IS ANSWERED, NEVER THROWN, AND THAT IS NOT LAZINESS.** Everything
   * in this cache is public and re-fetchable, so the worst a failure here can
   * cost is a download. Letting a storage error out of this method would turn a
   * full disk into a proof that cannot start, which is a strictly worse outcome
   * than the one the cache exists to improve on.
   */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const db = await this.open();
      const value = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(key);
        let held: unknown;
        request.onsuccess = () => { held = request.result; };
        request.onerror = () => reject(request.error ?? new Error('the database request failed'));
        tx.oncomplete = () => resolve(held);
        tx.onabort = () => reject(tx.error ?? new Error('the database transaction was rolled back'));
      });
      if (value === undefined || value === null) return null;
      return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    } catch {
      return null;
    }
  }

  /** Same reasoning as `get`: a cache that cannot write is slow, not broken. */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(bytes, key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('the database transaction was rolled back'));
        tx.onerror = () => reject(tx.error ?? new Error('the database transaction failed'));
      });
    } catch {
      /* a cache that cannot write costs a download, not a proof */
    }
  }
}
