/**
 * The artefacts a proof needs, fetched over HTTP, with the one number in this
 * whole operation that is genuinely a fraction.
 *
 * ── WHY THIS FILE EXISTS: A FETCH READ WHOLE CANNOT SHOW PROGRESS ────────
 *
 * A fetch that reads each artefact with one
 * `res.arrayBuffer()` is right for measuring a total and useless for
 * showing anybody anything: a 19 MB proving key is one opaque await, so the
 * only progress it can report is nought and then done. And what is kept in a
 * `Map` dies with the tab, which is fine for comparing a cold run against a
 * warm one and wrong for a person who closed their laptop.
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
 * ── NOTHING HERE IS SECRET, AND A PINNED SOURCE TRUSTS NOTHING IT IS SERVED
 *
 * Proving keys, verifier keys, the intermediate representation and the
 * structured reference string are public values. The private input is the
 * transaction, and the transaction never leaves the device. That is why these
 * can be served from anywhere and cached anywhere, and it is the whole reason
 * proving on the customer's own machine costs nothing in convenience. Public is
 * not the same as right: a proof made with another key than the one the chain
 * holds is refused after minutes of proving, so a source given `pins` checks every
 * file against this build's digests first; a source without them trusts it all.
 */
import { parseContractKeyLocation } from '@midnight-ntwrk/compact-js/effect/ContractKeyLocation';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { circuitOf, type KeyMaterialSource, type ProvingKeyMaterial } from '../../../src/midnight/wasm-proving.js';

export { circuitOf };

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
 * What a cached artefact is filed under by a source with no pins to check it
 * against: the whole key location, so material served for one deployment is
 * never handed to a proof about another. A source that checks what it keeps
 * files by the circuit and this build's digest instead (`httpKeyMaterialSource`).
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
  url: string,
  what: string,
  already: number,
  onProgress?: (p: FetchProgress) => void,
): Promise<{ bytes: Uint8Array; expected: number | null }> => {
  const header = res.headers.get('content-length');
  const expected = header === null || Number.isNaN(Number(header)) ? null : Number(header);
  /*
   * **A DOWNLOAD THAT ENDS EARLY IS A FAILURE, AND IT SAYS SO.** The server
   * said how long the file is; fewer bytes than that is a file cut off on the
   * way, and a prover handed one fails later with nothing to say about why.
   */
  /*
   * A length is only comparable with what arrives when nothing was encoded on
   * the way: the browser hands over decoded bytes, and the header counts the
   * encoded ones.
   */
  const encoding = res.headers.get('content-encoding');
  const comparable = expected !== null && (encoding === null || encoding === '' || encoding === 'identity');
  const short = (received: number, cause?: unknown): Error =>
    new Error(`the download of ${url} stopped after ${received}${comparable ? ` of ${expected}` : ''} bytes`
      + (cause === undefined ? '' : `: ${String((cause as any)?.message ?? cause)}`));

  /*
   * A body that cannot be streamed is read whole rather than refused. Some
   * environments hand back a response with no reader; the artefact is still
   * correct, and the only thing lost is the intermediate reporting.
   */
  if (!res.body || typeof (res.body as any).getReader !== 'function') {
    let whole: ArrayBuffer;
    try {
      whole = await res.arrayBuffer();
    } catch (e) {
      /* Read whole, so how much had arrived is not known and is not guessed. */
      throw new Error(`the download of ${url} broke before it could be read: ${String((e as any)?.message ?? e)}`);
    }
    const bytes = new Uint8Array(whole);
    if (comparable && bytes.length !== expected) throw short(bytes.length);
    onProgress?.({ received: already + bytes.length, total: expected === null ? null : already + expected, what });
    return { bytes, expected };
  }

  const reader = (res.body as any).getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let step: { done: boolean; value?: Uint8Array };
    try { step = await reader.read(); } catch (e) { throw short(received, e); }
    const { done, value } = step;
    if (done || value === undefined) break;
    parts.push(value);
    received += value.length;
    onProgress?.({
      received: already + received,
      total: expected === null ? null : already + expected,
      what,
    });
  }

  if (comparable && received !== expected) throw short(received);
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
  /**
   * What every artefact must hash to before it is used or kept. Given, nothing
   * the service sends is trusted: a location this build does not prove is
   * refused before anything is asked of the service, and bytes that are not
   * this build's are refused and never filed. Left out, the source trusts what
   * it is served, which no proof the vault worker makes ever does.
   */
  pins?: ProvingPins;
  /** The SHA-256 of some bytes, as lowercase hex; injected so a test can count the hashing. */
  digest?: (bytes: Uint8Array) => Promise<string>;
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
 * **WHAT A DEVICE CHECKS ITS PROVING MATERIAL AGAINST: THIS BUILD, AND NOTHING
 * THE SERVICE SAYS.** One set per folder the material is fetched from - the
 * vault's, the company account's, the network's - read from what this copy of
 * the app was built with.
 */
export interface ProvingPins {
  /** Whose material this is, in the product's words, for a refusal to name. */
  readonly whose: string;
  /** False when this build was made without proving keys at all, so nothing it serves can be proved with. */
  readonly carriesKeys: boolean;
  /** The circuit a location names, or null when it names nothing this folder holds. */
  circuitIn(keyLocation: string): string | null;
  /** The SHA-256 the artefact must hash to, or undefined when this build holds none for it. */
  digestOf(kind: ArtefactKind, circuit: string): string | undefined;
  /** The SHA-256 a public parameter file must hash to, or undefined when none is published for that name. */
  paramsDigest(name: string): string | undefined;
}

/** The compiler's listing of what it wrote beside a contract: one entry per file, each with its SHA-256. */
export interface CompiledManifest {
  readonly keys?: Readonly<Record<string, unknown>>;
  readonly zkir?: Readonly<Record<string, unknown>>;
}

const hashIn = (section: Readonly<Record<string, unknown>> | undefined, file: string): string | undefined => {
  if (section === undefined || section === null || !Object.hasOwn(section, file)) return undefined;
  const hash = (section[file] as { hash?: unknown } | null)?.hash;
  return typeof hash === 'string' ? hash.toLowerCase() : undefined;
};

/**
 * The pins of one compiled contract: its verifying keys from the digests the
 * compiled contract itself carries, and its proving keys and circuits from the
 * compiler's listing of the files it wrote. A location names a circuit either
 * as the chain composes it - the contract, the circuit and the hash of the key
 * the chain holds - or by the circuit's bare name, which is how a deploy asks
 * for the verifying keys it puts on the chain. A build compiled without proving
 * keys carries no digests, and everything asked of it is refused by name.
 */
export const contractPins = (
  whose: string,
  expectedVk: Readonly<Record<string, string>>,
  manifest: CompiledManifest,
  paramsDigest: (name: string) => string | undefined = () => undefined,
): ProvingPins => ({
  whose,
  carriesKeys: Object.keys(expectedVk).length > 0 && typeof manifest.keys === 'object' && manifest.keys !== null,
  circuitIn: (keyLocation) => {
    const located = parseContractKeyLocation(keyLocation);
    if (located !== undefined) return located.circuitId;
    return /^[A-Za-z0-9_]+$/u.test(keyLocation) ? keyLocation : null;
  },
  digestOf: (kind, circuit) => {
    if (kind === 'verifier') {
      return Object.hasOwn(expectedVk, circuit) && typeof expectedVk[circuit] === 'string' ? expectedVk[circuit]!.toLowerCase() : undefined;
    }
    return kind === 'prover' ? hashIn(manifest.keys, `${circuit}.prover`) : hashIn(manifest.zkir, `${circuit}.bzkir`);
  },
  paramsDigest,
});

/** The pins Midnight's own shielded circuits are checked against: one entry per file, as `<folder>/<circuit>.<kind>`. */
export interface NetworkKeyPins {
  readonly artefacts: Readonly<Record<string, { readonly sha256: string }>>;
}

/**
 * The pins of the network's own shielded circuits, which a private deposit or
 * payment proves beside the vault's. The prover names them
 * `midnight/zswap/<circuit>`; any other location is not one of them.
 */
export const networkPins = (whose: string, pinned: NetworkKeyPins, folder: string): ProvingPins => ({
  whose,
  carriesKeys: true,
  circuitIn: (keyLocation) => /^midnight\/zswap\/([a-z]+)$/u.exec(keyLocation)?.[1] ?? null,
  digestOf: (kind, circuit) => {
    const file = `${folder}/${circuit}.${kind === 'ir' ? 'bzkir' : kind}`;
    const pin = Object.hasOwn(pinned.artefacts, file) ? pinned.artefacts[file]?.sha256 : undefined;
    return typeof pin === 'string' ? pin.toLowerCase() : undefined;
  },
  paramsDigest: () => undefined,
});

/** Why a device would not prove with what it was handed. */
export type ProvingMaterialRefusal =
  /** the contract read for the proof carries a key for this circuit that is not this build's */
  | 'not-this-builds-circuit'
  /** the service sent bytes that do not hash to this build's */
  | 'other-bytes-served'
  /** this build has nothing to check the location or the file against */
  | 'no-pin'
  /** this build was made without proving keys */
  | 'no-keys-in-this-build';

/**
 * **A PROOF THIS DEVICE WOULD NOT MAKE**, with the reason in words a person can
 * act on and the kind for code to tell the reasons apart. Nothing is proved,
 * nothing is filed, and nothing is sent.
 */
export class ProvingMaterialRefused extends Error {
  override readonly name = 'ProvingMaterialRefused';
  constructor(readonly kind: ProvingMaterialRefusal, readonly keyLocation: string, message: string) {
    super(message);
  }
}

const KIND_WORD: Record<ArtefactKind, string> = { prover: 'proving key', verifier: 'verifying key', ir: 'circuit' };

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const subtle = (globalThis as { crypto?: { subtle?: { digest?: unknown } } }).crypto?.subtle;
  if (subtle !== undefined && typeof subtle.digest === 'function') {
    const hashed = await (subtle as { digest(a: string, b: Uint8Array): Promise<ArrayBuffer> }).digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(hashed));
  }
  return bytesToHex(sha256(bytes));
};

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
   * is not, filed under the same key `lookupKey` files it under, and checked
   * the same way.
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
 *
 * **WITH `pins`, EVERY ARTEFACT IS THIS BUILD'S OR IT IS REFUSED.** A location
 * whose verifying-key hash is not this build's is refused before the cache or
 * the service is asked: the chain would refuse a proof made for it, after
 * minutes of proving. Bytes that do not hash to this build's digest are
 * refused and never filed. What is filed is keyed by the circuit, this
 * build's verifying-key digest and the digest of the file itself, not by the
 * contract's address: every vault and every deploy on one build shares one
 * copy of each file, and a file another build keeps for the same verifying key
 * sits under another key and is never handed over in its place.
 */
export const httpKeyMaterialSource = (
  base: string,
  options: HttpKeyMaterialOptions = {},
): ArtefactSource => {
  const doFetch = options.fetchImpl ?? fetch;
  const cache = options.cache;
  const pins = options.pins;
  const digest = options.digest ?? sha256Hex;

  const download = async (url: string, what: string, already: number): Promise<Uint8Array> => {
    /*
     * **ASKED OF THE SERVER EVERY TIME, NEVER ANSWERED FROM THE BROWSER'S OWN
     * HTTP CACHE UNCHECKED.** What this file keeps, it keeps in `cache`, and
     * only after a whole download. The browser's HTTP cache is a second
     * store this file does not control: a refusal a server once marked
     * cacheable is replayed from it for as long as that mark says, without the
     * request reaching the server at all, so a file put in place since is never
     * seen. `no-cache` still lets the browser reuse what it holds, but only
     * after the server has confirmed it is current.
     */
    let res: Response;
    try {
      res = await doFetch(url, { cache: 'no-cache' });
    } catch (e) {
      throw new Error(`${url} could not be reached: ${String((e as any)?.message ?? e)}`);
    }
    // The URL and the status, because "failed to fetch" names nothing a person
    // or a later reader can act on.
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return (await readStreaming(res, url, what, already, options.onProgress)).bytes;
  };

  /** Unchecked: what the cache holds is used, and what is downloaded is kept. */
  const cached = async (key: string, url: string, what: string, already: number): Promise<Uint8Array> => {
    const held = await cache?.get(key);
    if (held) return held;
    const bytes = await download(url, what, already);
    await cache?.put(key, bytes);
    return bytes;
  };

  /*
   * **THE VERDICT IS REMEMBERED, NOT THE BYTES.** Every key a checked source
   * files under names the SHA-256 of the file itself, and is only ever written
   * with bytes that hash to it, by this copy of the app or by any other; so once
   * this source has hashed what it holds under a key, it does not hash it again
   * for as long as it lives; the bytes themselves stay in the
   * durable store, where a long session's tens of megabytes per circuit do not
   * pile up in this worker's memory. A fetch already on its way is shared.
   */
  const checkedKeys = new Set<string>();
  const inFlight = new Map<string, Promise<Uint8Array>>();

  /**
   * Checked: bytes the cache holds are used only when they hash to `want`, and
   * are otherwise fetched again and written over; bytes the service sends are
   * used and kept only when they hash to `want`, and are otherwise refused.
   */
  const checked = (
    key: string, url: string, what: string, already: number, want: string, refused: () => ProvingMaterialRefused,
  ): Promise<Uint8Array> => {
    const going = inFlight.get(key);
    if (going !== undefined) return going;
    const started = (async () => {
      const held = await cache?.get(key);
      if (held) {
        if (checkedKeys.has(key)) return held;
        if (await digest(held) === want) { checkedKeys.add(key); return held; }
      }
      const bytes = await download(url, what, already);
      if (await digest(bytes) !== want) throw refused();
      await cache?.put(key, bytes);
      checkedKeys.add(key);
      return bytes;
    })().finally(() => { inFlight.delete(key); });
    inFlight.set(key, started);
    return started;
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

  const one = async (kind: ArtefactKind, keyLocation: string, already: number): Promise<Uint8Array> => {
    if (pins === undefined) {
      return cached(cacheKeyFor(kind, keyLocation), SERVED[kind].url(circuitOf(keyLocation)), SERVED[kind].what, already);
    }
    const circuit = pins.circuitIn(keyLocation);
    if (circuit === null) {
      throw new ProvingMaterialRefused('no-pin', keyLocation,
        `This app proves nothing at "${keyLocation}" for ${pins.whose}, so no proof was made and nothing was asked of the service.`);
    }
    if (!pins.carriesKeys) {
      throw new ProvingMaterialRefused('no-keys-in-this-build', keyLocation,
        `This copy of the app was built without the proving keys for ${pins.whose}, so it cannot prove anything for it and no proof was made.`);
    }
    const vk = pins.digestOf('verifier', circuit);
    const want = pins.digestOf(kind, circuit);
    if (vk === undefined || want === undefined) {
      throw new ProvingMaterialRefused('no-pin', keyLocation,
        `This app has no ${KIND_WORD[kind]} it can check for the ${circuit} circuit of ${pins.whose}, so no proof was made and nothing was asked of the service.`);
    }
    const located = parseContractKeyLocation(keyLocation);
    if (located !== undefined && located.verifierKeyHash !== vk) {
      throw new ProvingMaterialRefused('not-this-builds-circuit', keyLocation,
        `The ${circuit} circuit this proof was asked for, for ${pins.whose}, is not the one this app proves, so no proof was made. `
          + 'The contract it was read from carries a circuit from another version of the app.');
    }
    return checked(`artefact:${kind}:${circuit}?vk=${vk}&sha256=${want}`, SERVED[kind].url(circuit), SERVED[kind].what, already, want,
      () => new ProvingMaterialRefused('other-bytes-served', keyLocation,
        `The service sent a ${KIND_WORD[kind]} for the ${circuit} circuit of ${pins.whose} that is not this app's, `
          + 'so it was neither used nor kept, and no proof was made.'));
  };

  return {
    async artefact(kind: ArtefactKind, keyLocation: string): Promise<Uint8Array> {
      return one(kind, keyLocation, 0);
    },

    async lookupKey(keyLocation: string): Promise<ProvingKeyMaterial | undefined> {
      /*
       * ONE AT A TIME, RATHER THAN ALL THREE AT ONCE, AND THAT IS A
       * DELIBERATE TRADE. Three parallel fetches finish sooner and report
       * progress that jumps about, because three interleaved streams share one
       * counter and no single number describes any of them. Sequential is
       * slightly slower and the number moves the way a person expects it to.
       * The proving key is by far the largest of the three, so most of the wait
       * is one artefact either way.
       */
      const proverKey = await one('prover', keyLocation, 0);
      const verifierKey = await one('verifier', keyLocation, proverKey.length);
      const ir = await one('ir', keyLocation, proverKey.length + verifierKey.length);

      return { proverKey, verifierKey, ir };
    },

    async getParams(k: number): Promise<Uint8Array> {
      /*
       * Only `bls_midnight_2p{k}`: Midnight publishes a digest for no other
       * name, and the service hands out no other, so a second name would only
       * ever be a second refusal.
       */
      const name = `bls_midnight_2p${k}`;
      const url = `${base}/params/${name}`;
      const what = 'fetching the public parameters';
      let bytes: Promise<Uint8Array>;
      if (pins === undefined) {
        bytes = cached(`artefact:params:${name}`, url, what, 0);
      } else {
        const want = pins.paramsDigest(name);
        if (want === undefined) {
          throw new ProvingMaterialRefused('no-pin', name,
            `Midnight publishes no public parameters this app can check for circuits of this size (k=${k}), so no proof was made.`);
        }
        bytes = checked(`artefact:params:${name}?sha256=${want}`, url, what, 0, want,
          () => new ProvingMaterialRefused('other-bytes-served', name,
            `The service sent public parameters for circuits of this size (k=${k}) that are not the ones Midnight publishes, `
              + 'so they were neither used nor kept, and no proof was made.'));
      }
      try {
        return await bytes;
      } catch (e) {
        if (e instanceof ProvingMaterialRefused) throw e;
        throw new Error(
          `the public parameters for this circuit did not arrive (k=${k}). ${name}: ${String((e as any)?.message ?? e)}. ` +
            'The service fetches and checks these when it starts, and its log says which it could not get; ' +
            'try again in a minute, and if it keeps happening the service needs attention.',
        );
      }
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

  /**
   * `tell` hears every time this browser's store refuses to hand back or keep
   * a file, with the file and the store's own reason. A refusal costs a
   * download and never a proof, so it is said rather than thrown.
   */
  constructor(
    private factory: IDBFactoryLike,
    private name = 'confidential-accounts-artefacts',
    private tell: (why: string) => void = () => {},
  ) {}

  private refused(doing: string, key: string, e: unknown): void {
    try {
      this.tell(`this browser's store would not ${doing} ${key}: ${String((e as any)?.message ?? (e as any)?.name ?? e)}`);
    } catch { /* whoever listens cannot stop the cache */ }
  }

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
    } catch (e) {
      this.refused('hand back', key, e);
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
    } catch (e) {
      /* a cache that cannot write costs a download, not a proof */
      this.refused('keep', key, e);
    }
  }
}
