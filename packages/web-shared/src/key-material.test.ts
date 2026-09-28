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
 */
import { describe, it, expect } from 'vitest';
import {
  httpKeyMaterialSource, cacheKeyFor, circuitOf, MemoryArtefactCache, type FetchProgress,
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
            ? { done: false, value: new Uint8Array(chunks[at++]) }
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
     * RED WHEN: the reader loop is replaced by `res.arrayBuffer()`, which is
     * what the probe version does. One artefact is then one opaque await, and
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
     * **THE EXACT SEQUENCE, NOT *NON-DECREASING*, AND THE FIRST DRAFT HERE HAD
     * IT WRONG.** Written as a sortedness check, this case stayed green when
     * the running total was dropped from the middle artefact: the values became
     * 4, 4, 12, which is still non-decreasing and still ends at 12. It was the
     * mutation that found it, which is the whole argument for running one.
     */
    expect(seen.map((p) => p.received), 'the byte count restarted part way through one wait')
      .toEqual([4, 8, 12]);
  });
});

describe('what a cached artefact is filed under', () => {
  it('the whole key location, so material for one deployment is never served to another', async () => {
    /*
     * **THE MOST EXPENSIVE STALE CACHE AVAILABLE IN THIS SYSTEM.** The location
     * carries the deployed address and a hash of the verifier key, so it moves
     * when the contract is redeployed and when it is recompiled. Keyed on the
     * circuit name alone, a key built for one version would be served to a
     * proof about another - and the failure arrives as a proof the chain
     * rejects, after a fee has been paid.
     *
     * RED WHEN: `cacheKeyFor` is keyed on `circuitOf(keyLocation)`.
     */
    const a = 'contract:AAAA/propose?vk=1111';
    const b = 'contract:BBBB/propose?vk=2222';
    expect(circuitOf(a)).toBe(circuitOf(b));
    expect(cacheKeyFor('prover', a), 'two deployments share a cache entry for the same circuit')
      .not.toBe(cacheKeyFor('prover', b));
  });

  it('a held artefact is not fetched again, and is not reported as progress', async () => {
    /*
     * RED WHEN: the cache is consulted after the fetch rather than before it.
     * Every approval after the first would then re-download tens of megabytes
     * the device already has - which is the difference between the 176.9 second
     * first proof and the 140.3 second one after it.
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
     * RED WHEN: the message names `EXTRACT-PARAMS.command`, a path, or a
     * variable. Nothing internal ships, so a refusal that names one sends a
     * reader to something they do not have.
     */
    const src = httpKeyMaterialSource('/artefacts', {
      fetchImpl: async () => ({ ok: false, status: 404 } as Response),
    });
    await expect(src.getParams(9)).rejects.toThrow(/public parameters/i);
    await expect(src.getParams(9)).rejects.not.toThrow(/\.command|\.ts\b|EXTRACT/);
  });
});
