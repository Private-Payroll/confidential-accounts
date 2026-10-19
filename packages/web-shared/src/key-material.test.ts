/**
 * **THE ONE NUMBER IN A PROOF THAT IS REALLY A FRACTION.**
 *
 * A proof is one opaque call into WebAssembly. The prover emits nothing while
 * it runs and there is nowhere to put a callback - `prove`, `check`,
 * `provingProvider`, `jsonIrToBinary` and a class that reads a size is the
 * whole of the package's surface. So the 140 seconds of proving has no progress
 * to report, and anything drawn over it would be invented.
 *
 * The download does have one, and this file is about making it real rather than
 * approximate: bytes as they arrive, against a length the server actually sent,
 * and `null` rather than a guess when it sent none.
 *
 * It is also where a device refuses proving material that is not this build's:
 * a circuit the chain holds in another version, bytes the service changed, a
 * name this build holds nothing for, and a build made without keys.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  cacheKeyFor, contractPins, httpKeyMaterialSource, MemoryArtefactCache, networkPins, ProvingMaterialRefused,
  type ArtefactCache, type FetchProgress, type ProvingMaterialRefusal, type ProvingPins,
} from './key-material.js';

/** A response whose body arrives in pieces, the way a real one does. */
const streaming = (chunks: number[][], headers: Record<string, string> = {}) => {
  let at = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          at < chunks.length
            ? { done: false, value: new Uint8Array(chunks[at++]!) }
            : { done: true, value: undefined },
      }),
    },
    arrayBuffer: async () => new Uint8Array(chunks.flat()).buffer,
  } as unknown as Response;
};

const LOCATION = 'contract:90a19bf2d484/propose?vk=5ac41954f84';

describe('what a fetch can honestly say about itself', () => {
  it('reports bytes as they arrive rather than once at the end', async () => {
    /*
     * RED WHEN: the reader loop is replaced by `res.arrayBuffer()`, which reads
     * the whole file at once. One artefact is then one opaque await, and
     * the only progress reportable is nought and then done - which is a bar
     * that sits still for the whole of a 19 MB download.
     */
    const seen: FetchProgress[] = [];
    const src = httpKeyMaterialSource('/artefacts', {
      onProgress: (p) => seen.push(p),
      fetchImpl: async () => streaming([[1, 2, 3], [4, 5], [6]], { 'content-length': '6' }),
    });
    await src.getParams(16);

    expect(seen.map((p) => p.received), 'the bytes arrived in one lump, so nothing could be shown moving')
      .toEqual([3, 5, 6]);
    expect(seen.every((p) => p.total === 6)).toBe(true);
  });

  it('answers `null` for the total when the server did not say, and keeps counting', async () => {
    /*
     * RED WHEN: the missing header is replaced by a default, a guess, or the
     * bytes so far. Any of those produces a denominator nobody sent, and a bar
     * drawn against it is the fake percentage this whole design refuses.
     */
    const seen: FetchProgress[] = [];
    const src = httpKeyMaterialSource('/artefacts', {
      onProgress: (p) => seen.push(p),
      fetchImpl: async () => streaming([[1, 2], [3]]),
    });
    await src.getParams(16);

    expect(seen.map((p) => p.total), 'a length was reported that no server sent')
      .toEqual([null, null]);
    expect(seen.map((p) => p.received)).toEqual([2, 3]);
  });

  it('says which artefact the wait is for, in the product\'s own words', async () => {
    /*
     * RED WHEN: `what` carries a URL, a file name or a circuit id. Whoever
     * reads this is waiting on an approval, and *fetching the proving key* is
     * something they can make sense of where `propose.prover` is not.
     */
    const seen: FetchProgress[] = [];
    const src = httpKeyMaterialSource('/artefacts', {
      onProgress: (p) => seen.push(p),
      fetchImpl: async () => streaming([[1]], { 'content-length': '1' }),
    });
    await src.lookupKey(LOCATION);

    expect(seen.map((p) => p.what)).toEqual([
      'fetching the proving key', 'fetching the verifying key', 'fetching the circuit',
    ]);
    expect(seen.some((p) => /\/|\.prover|\.bzkir/.test(p.what)),
      'the wait is described with a path rather than with what is being waited for').toBe(false);
  });

  it('counts the three artefacts as one wait rather than restarting at each', async () => {
    /*
     * RED WHEN: `already` is dropped from the three `cached` calls. The count
     * then falls back to zero twice inside one lookup, which reads on screen as
     * progress going backwards.
     */
    const seen: FetchProgress[] = [];
    const src = httpKeyMaterialSource('/artefacts', {
      onProgress: (p) => seen.push(p),
      fetchImpl: async () => streaming([[1, 2, 3, 4]], { 'content-length': '4' }),
    });
    await src.lookupKey(LOCATION);

    /*
     * **THE EXACT SEQUENCE IS ASSERTED, NOT THAT IT NEVER FALLS.** A
     * sortedness check stays green when the running total is dropped from the
     * middle artefact (4, 4, 12 is still non-decreasing and still ends at 12).
     */
    expect(seen.map((p) => p.received), 'the byte count restarted part way through one wait')
      .toEqual([4, 8, 12]);
  });
});

describe('what a cached artefact is filed under', () => {
  it('every vault on one build shares one copy of a circuit\'s files, whatever its address', async () => {
    /*
     * RED WHEN: what a device keeps is filed under the vault's address, so a second vault on the same build
     * downloads the same tens of megabytes again and keeps a second copy for good.
     */
    const b = aBuild();
    const cache = new MemoryArtefactCache();
    await b.vault({ cache }).lookupKey(at('payout', 'aa'));
    b.fetched.length = 0;
    await b.vault({ cache }).lookupKey(at('payout', 'bb'));
    expect(b.fetched, 'a second vault on the same build fetched its files again').toEqual([]);
  });

  it('a held artefact is not fetched again, and is not reported as progress', async () => {
    /*
     * The public parameters are held per device, not per contract, so a
     * second source over the same store finds them.
     */
    const cache = new MemoryArtefactCache();
    let fetches = 0;
    const seen: FetchProgress[] = [];
    const make = () => httpKeyMaterialSource('/artefacts', {
      cache, onProgress: (p) => seen.push(p),
      fetchImpl: async () => { fetches += 1; return streaming([[7, 7]], { 'content-length': '2' }); },
    });

    await make().getParams(16);
    seen.length = 0;
    await make().getParams(16);

    expect(fetches, 'the artefact was fetched again although the device already had it').toBe(1);
    expect(seen, 'a cached artefact was reported as though it were arriving').toEqual([]);
  });

  it('a refusal names what is missing without naming a file to go and edit', async () => {
    /*
     * The public parameters for the size asked are not served. The reason is
     * said in the product's words and names no script or internal file.
     */
    const src = httpKeyMaterialSource('/artefacts', {
      fetchImpl: async () => ({ ok: false, status: 404 } as Response),
    });
    await expect(src.getParams(9)).rejects.toThrow(/public parameters/i);
    await expect(src.getParams(9)).rejects.not.toThrow(/\.command|\.ts\b|EXTRACT/);
  });
});

/*
 * A small build of one vault circuit, the public parameters for one size and
 * one of the network's shielded circuits, served from a pretend service whose
 * files a test can change. Every digest is the SHA-256 of the bytes this build
 * holds, as the compiler writes it.
 */
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const PAYOUT = { prover: new Uint8Array([1, 1, 1]), verifier: new Uint8Array([2, 2]), ir: new Uint8Array([3]) };
const SPEND = { prover: new Uint8Array([4, 4]), verifier: new Uint8Array([5]), ir: new Uint8Array([6, 6, 6]) };
const PARAMS_9 = new Uint8Array([9, 9, 9, 9]);
const VK = sha(PAYOUT.verifier);
const at = (circuit: string, address = 'aa', vk = VK): string => `contract:${address.repeat(32)}/${circuit}?vk=${vk}`;
const flipped = (b: Uint8Array): Uint8Array => { const c = new Uint8Array(b); c[0] = c[0]! ^ 1; return c; };

class KeptStore extends MemoryArtefactCache {
  readonly asked: string[] = [];
  readonly kept: Array<[string, Uint8Array]> = [];
  override async get(key: string) { this.asked.push(key); return super.get(key); }
  override async put(key: string, bytes: Uint8Array) { this.kept.push([key, bytes]); return super.put(key, bytes); }
}

const aBuild = (pins?: { vault?: ProvingPins }) => {
  const served: Record<string, Uint8Array> = {
    '/v/keys/payout.prover': PAYOUT.prover, '/v/keys/payout.verifier': PAYOUT.verifier, '/v/zkir/payout.bzkir': PAYOUT.ir,
    '/v/params/bls_midnight_2p9': PARAMS_9,
    '/n/keys/spend.prover': SPEND.prover, '/n/keys/spend.verifier': SPEND.verifier, '/n/zkir/spend.bzkir': SPEND.ir,
  };
  const fetched: string[] = [];
  let hashed = 0;
  const fetchImpl = (async (url: string) => {
    fetched.push(url);
    const b = served[url];
    return b === undefined ? ({ ok: false, status: 404 } as Response) : streaming([[...b]], { 'content-length': String(b.length) });
  }) as unknown as typeof fetch;
  const digest = async (b: Uint8Array) => { hashed += 1; return sha(b); };
  const vaultPins = pins?.vault ?? contractPins('the vault', { payout: VK }, {
    keys: { 'payout.prover': { hash: sha(PAYOUT.prover) }, 'payout.verifier': { hash: VK } },
    zkir: { 'payout.bzkir': { hash: sha(PAYOUT.ir) } },
  }, (name) => (name === 'bls_midnight_2p9' ? sha(PARAMS_9) : undefined));
  const networkPinned = networkPins('the network\'s shielded transfers', {
    artefacts: {
      'zswap/9/spend.prover': { sha256: sha(SPEND.prover) }, 'zswap/9/spend.verifier': { sha256: sha(SPEND.verifier) },
      'zswap/9/spend.bzkir': { sha256: sha(SPEND.ir) },
    },
  }, 'zswap/9');
  return {
    served, fetched, get hashed() { return hashed; },
    vault: (o: { cache?: ArtefactCache } = {}) => httpKeyMaterialSource('/v', { fetchImpl, digest, pins: vaultPins, ...o }),
    network: (o: { cache?: ArtefactCache } = {}) => httpKeyMaterialSource('/n', { fetchImpl, digest, pins: networkPinned, ...o }),
  };
};

const refusedAs = async (work: Promise<unknown>, kind: ProvingMaterialRefusal): Promise<ProvingMaterialRefused> => {
  const e = await work.then(() => null, (x: unknown) => x);
  expect(e, `the proof went ahead where it should have been refused as ${kind}`).toBeInstanceOf(ProvingMaterialRefused);
  expect((e as ProvingMaterialRefused).kind).toBe(kind);
  return e as ProvingMaterialRefused;
};

describe('A DEVICE PROVES ONLY WITH THIS BUILD\'S KEYS, WHATEVER THE SERVICE SENDS', () => {
  it('a vault circuit whose key is not this build\'s is refused by name before anything is asked of the service', async () => {
    /* RED WHEN: the key hash the contract carries is not compared with this build's, so the device proves for minutes and the chain refuses it. */
    const b = aBuild();
    const store = new KeptStore();
    const e = await refusedAs(b.vault({ cache: store }).lookupKey(at('payout', 'aa', 'ff'.repeat(32))), 'not-this-builds-circuit');
    expect(e.message).toMatch(/^The payout circuit this proof was asked for, for the vault, is not the one this app proves, so no proof was made\./u);
    expect(e.message, 'the refusal says the chain holds it, though the contract it was read from may be the service\'s').not.toMatch(/on the chain/u);
    expect(b.fetched, 'the service was asked for a circuit this device will not prove').toEqual([]);
    expect(store.asked, 'the store was read for a circuit this device will not prove').toEqual([]);
  });

  for (const kind of ['prover', 'verifier', 'ir'] as const) {
    it(`a ${kind} file the service sends with one byte changed is refused by name and never kept`, async () => {
      /* RED WHEN: what the service sends is used or kept without being hashed against this build's digest. */
      const b = aBuild();
      const file = { prover: '/v/keys/payout.prover', verifier: '/v/keys/payout.verifier', ir: '/v/zkir/payout.bzkir' }[kind];
      const bad = flipped(b.served[file]!);
      b.served[file] = bad;
      const store = new KeptStore();
      const e = await refusedAs(b.vault({ cache: store }).lookupKey(at('payout')), 'other-bytes-served');
      expect(e.message).toMatch(/^The service sent a (proving key|verifying key|circuit) for the payout circuit of the vault that is not this app's/u);
      expect(store.kept.filter(([, kept]) => sha(kept) === sha(bad)), 'the changed bytes were kept').toEqual([]);
    });
  }

  it('a deploy\'s verifying keys, asked by the circuit\'s bare name, are checked the same way', async () => {
    /* RED WHEN: a bare circuit name is let through unchecked, so a vault this device deploys carries whatever verifying key the service sent. */
    const b = aBuild();
    expect(await b.vault().artefact('verifier', 'payout')).toEqual(PAYOUT.verifier);
    const c = aBuild();
    c.served['/v/keys/payout.verifier'] = flipped(PAYOUT.verifier);
    await refusedAs(c.vault().artefact('verifier', 'payout'), 'other-bytes-served');
  });

  it('a circuit this build does not have, or a builtin it does not prove, is refused by name and nothing is fetched', async () => {
    /* RED WHEN: a location this build holds no digest for is fetched and used. */
    const b = aBuild();
    await refusedAs(b.vault().lookupKey('notACircuit'), 'no-pin');
    await refusedAs(b.vault().lookupKey('midnight/dust/spend'), 'no-pin');
    await refusedAs(b.network().lookupKey('midnight/dust/spend'), 'no-pin');
    expect(b.fetched).toEqual([]);
  });

  it('a build compiled without proving keys refuses everything by name rather than proving unchecked', async () => {
    /* RED WHEN: a build with no listing of its keys, or no verifying-key digests, is treated as nothing to check. */
    const noKeys = aBuild({ vault: contractPins('the vault', { payout: VK }, { zkir: {} }) });
    const e = await refusedAs(noKeys.vault().lookupKey(at('payout')), 'no-keys-in-this-build');
    expect(e.message).toMatch(/built without the proving keys for the vault/u);
    const noDigests = aBuild({ vault: contractPins('the vault', {}, { keys: {}, zkir: {} }) });
    await refusedAs(noDigests.vault().artefact('verifier', 'payout'), 'no-keys-in-this-build');
    expect([...noKeys.fetched, ...noDigests.fetched]).toEqual([]);
  });

  it('the public parameters are Midnight\'s or they are refused, and no unpublished name is ever asked for', async () => {
    /* RED WHEN: parameters the service sends are used without Midnight's digest, or the older unpublished name is tried. */
    const b = aBuild();
    expect(await b.vault().getParams(9)).toEqual(PARAMS_9);
    b.served['/v/params/bls_midnight_2p9'] = flipped(PARAMS_9);
    await refusedAs(aBuildWith(b).getParams(9), 'other-bytes-served');
    await refusedAs(b.vault().getParams(10), 'no-pin');
    delete b.served['/v/params/bls_midnight_2p9'];
    await expect(aBuildWith(b).getParams(9)).rejects.toThrow(/public parameters for this circuit did not arrive/u);
    expect(b.fetched.filter((u) => u.includes('filecoin'))).toEqual([]);
  });

  it('the network\'s shielded circuits are checked against their own pins', async () => {
    /* RED WHEN: a shielded circuit the service sends is used without its pin. */
    const b = aBuild();
    expect(await b.network().lookupKey('midnight/zswap/spend')).toEqual({ proverKey: SPEND.prover, verifierKey: SPEND.verifier, ir: SPEND.ir });
    b.served['/n/keys/spend.prover'] = flipped(SPEND.prover);
    await refusedAs(b.network({ cache: new MemoryArtefactCache() }).lookupKey('midnight/zswap/spend'), 'other-bytes-served');
  });
});

/* A fresh source over the same pretend service, with nothing remembered. */
const aBuildWith = (b: ReturnType<typeof aBuild>) => b.vault({ cache: new MemoryArtefactCache() });

describe('WHAT A BROWSER ALREADY HOLDS IS CHECKED TOO, AND A BAD COPY NEVER STOPS A PROOF', () => {
  it('a wrong copy held for a circuit, the public parameters or a shielded circuit is fetched again and written over', async () => {
    /* RED WHEN: what the store holds is used without being hashed, or a wrong copy is refused instead of replaced, so that browser can never prove again. */
    const clean = aBuild();
    const learn = new KeptStore();
    await clean.vault({ cache: learn }).lookupKey(at('payout'));
    await clean.vault({ cache: learn }).getParams(9);
    await clean.network({ cache: learn }).lookupKey('midnight/zswap/spend');
    const keys = learn.kept.map(([k]) => k);
    expect(keys).toHaveLength(7);

    const poisoned = new KeptStore();
    for (const k of keys) await poisoned.put(k, new Uint8Array([0xee]));
    poisoned.kept.length = 0;
    const b = aBuild();
    expect(await b.vault({ cache: poisoned }).lookupKey(at('payout'))).toEqual({ proverKey: PAYOUT.prover, verifierKey: PAYOUT.verifier, ir: PAYOUT.ir });
    expect(await b.vault({ cache: poisoned }).getParams(9)).toEqual(PARAMS_9);
    expect(await b.network({ cache: poisoned }).lookupKey('midnight/zswap/spend')).toEqual({ proverKey: SPEND.prover, verifierKey: SPEND.verifier, ir: SPEND.ir });
    expect(poisoned.kept.map(([k]) => k).sort(), 'a wrong copy was not written over').toEqual([...keys].sort());
    for (const [k] of poisoned.kept) expect((await poisoned.get(k))!.length, k).toBeGreaterThan(0);
    expect(poisoned.kept.every(([, kept]) => kept[0] !== 0xee)).toBe(true);
  });

  it('another build\'s proving key, filed beside this one\'s for the same verifying key, is never handed over', async () => {
    /*
     * RED WHEN: what a browser keeps is filed by the verifying key alone, so after another copy of the app
     * with the same verifying key and another proving key writes its file in the same browser, this one hands
     * that file to the prover without hashing it again.
     */
    const store = new MemoryArtefactCache();
    const ours = aBuild();
    const theirProver = new Uint8Array([8, 8, 8]);
    const theirs = aBuild({
      vault: contractPins('the vault', { payout: VK }, {
        keys: { 'payout.prover': { hash: sha(theirProver) }, 'payout.verifier': { hash: VK } },
        zkir: { 'payout.bzkir': { hash: sha(PAYOUT.ir) } },
      }),
    });
    theirs.served['/v/keys/payout.prover'] = theirProver;
    const mine = ours.vault({ cache: store });
    expect((await mine.lookupKey(at('payout')))!.proverKey).toEqual(PAYOUT.prover);
    expect((await theirs.vault({ cache: store }).lookupKey(at('payout')))!.proverKey).toEqual(theirProver);
    expect((await mine.lookupKey(at('payout')))!.proverKey, 'another build\'s proving key was handed over').toEqual(PAYOUT.prover);
    expect((await ours.vault({ cache: store }).lookupKey(at('payout')))!.proverKey).toEqual(PAYOUT.prover);
  });

  it('a copy filed under a vault\'s address by an older build is never read', async () => {
    /* RED WHEN: a copy filed under a vault's address, which no check ever covered, is still read. */
    const store = new KeptStore();
    await store.put(cacheKeyFor('prover', at('payout')), flipped(PAYOUT.prover));
    const b = aBuild();
    await b.vault({ cache: store }).lookupKey(at('payout'));
    expect(store.asked.filter((k) => k.includes('contract:'))).toEqual([]);
  });

  it('a copy this source has already checked is not hashed again, and one fetch on its way is shared', async () => {
    /* RED WHEN: every proof hashes the same tens of megabytes again, or two asks at once download the same file twice. */
    const b = aBuild();
    const src = b.vault({ cache: new MemoryArtefactCache() });
    await src.lookupKey(at('payout'));
    const once = b.hashed;
    await src.lookupKey(at('payout'));
    await src.lookupKey(at('payout', 'bb'));
    expect(b.hashed - once, 'a copy already checked was hashed again').toBe(0);

    const c = aBuild();
    const both = c.vault({ cache: new MemoryArtefactCache() });
    await Promise.all([both.artefact('prover', at('payout')), both.artefact('prover', at('payout', 'bb'))]);
    expect(c.fetched.filter((u) => u.endsWith('payout.prover'))).toHaveLength(1);
  });
});
