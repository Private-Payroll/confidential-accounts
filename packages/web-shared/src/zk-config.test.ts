/**
 * **THE ADAPTER FETCHES NOTHING THE CACHE ALREADY HOLDS, AND NOTHING IT WAS
 * NOT ASKED FOR.**
 *
 * -- THE TWO WAYS THIS GOES WRONG, AND THEY COST DIFFERENT AMOUNTS ---------
 *
 * A SECOND FETCHER. The artefacts are already fetched, with progress and a
 * cache that survives a reload. Anything that downloaded them again would
 * download the same eighteen megabyte proving key a second time, and it would
 * present as a first approval that takes twice as long rather than as an error
 * anybody could see.
 *
 * ASKING FOR THREE WHEN ONE WAS WANTED. A call is ASSEMBLED from verifying
 * keys, which are small. An adapter that answered each of those by asking for
 * the whole set would pull the proving key before the person has approved
 * anything, on a connection they are already waiting on.
 *
 * -- WHAT IS COUNTED, AND WHY IT IS URLS AND NOT A NUMBER ------------------
 *
 * Every case below counts the URLs that were actually requested, and asserts
 * the list rather than its length. A count says a fetch happened; the list says
 * WHICH, which is the difference between "it fetched once" and "it fetched the
 * eighteen megabyte one instead of the small one".
 */
import { describe, expect, it } from 'vitest';

import { MemoryArtefactCache, httpKeyMaterialSource } from './key-material.js';
import { byCircuitName, zkConfigOver } from './zk-config.js';

const BASE = 'https://artefacts.example';

/**
 * A fetch that records what it was asked for and answers with bytes that say
 * which URL they came from, so a wrong artefact is a wrong VALUE and not only
 * a wrong count.
 */
const countingFetch = () => {
  const asked: string[] = [];
  const impl = (async (url: any) => {
    const named = String(url);
    asked.push(named.replace(BASE, ''));
    const body = new TextEncoder().encode(named);
    return {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === 'content-length' ? String(body.length) : null) },
      arrayBuffer: async () => body.buffer.slice(0, body.length),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { asked, impl };
};

const sourceWithCache = () => {
  const { asked, impl } = countingFetch();
  return {
    asked,
    source: httpKeyMaterialSource(BASE, { cache: new MemoryArtefactCache(), fetchImpl: impl }),
  };
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('the provider a call is assembled with', () => {
  /**
   * **THE ONE THAT MATTERS MOST.** Goes red if a verifying-key request ever
   * pulls the proving key with it, which is the eighteen megabyte download this
   * whole arrangement exists to avoid.
   */
  it('asks for the verifying key and NOTHING else when that is what was asked for', async () => {
    const { asked, source } = sourceWithCache();
    const zk = zkConfigOver(source, byCircuitName);

    const key = await zk.getVerifierKey('approve');

    expect(asked,
      'assembling a call fetched something besides the verifying key. The proving key is '
      + 'eighteen megabytes and nothing is being proved yet')
      .toEqual(['/keys/approve.verifier']);
    expect(text(key as unknown as Uint8Array)).toBe(`${BASE}/keys/approve.verifier`);
  });

  it('asks for the proving key only when the proving key is asked for', async () => {
    const { asked, source } = sourceWithCache();
    const zk = zkConfigOver(source, byCircuitName);

    await zk.getProverKey('approve');
    expect(asked).toEqual(['/keys/approve.prover']);
  });

  /**
   * **NOTHING THE CACHE ALREADY HOLDS.** The prover fetches all three for a
   * location; the adapter over the same source then answers for all three
   * without going near the network.
   */
  it('fetches nothing at all once the prover has already fetched that location', async () => {
    const { asked, source } = sourceWithCache();

    await source.lookupKey('approve');
    expect(asked).toEqual([
      '/keys/approve.prover', '/keys/approve.verifier', '/zkir/approve.bzkir',
    ]);

    const zk = zkConfigOver(source, byCircuitName);
    await zk.get('approve');
    await zk.getVerifierKey('approve');
    await zk.getProverKey('approve');
    await zk.getZKIR('approve');

    expect(asked,
      'the adapter downloaded something the cache already held. There is one fetcher and this '
      + 'is not it')
      .toEqual(['/keys/approve.prover', '/keys/approve.verifier', '/zkir/approve.bzkir']);
  });

  /** And the other direction: the prover asks after the adapter has. */
  it('leaves nothing for the prover to fetch that it has already fetched itself', async () => {
    const { asked, source } = sourceWithCache();
    const zk = zkConfigOver(source, byCircuitName);

    await zk.get('propose');
    expect(asked).toHaveLength(3);

    const material = await source.lookupKey('propose');
    expect(asked).toHaveLength(3);
    expect(text(material!.proverKey)).toBe(`${BASE}/keys/propose.prover`);
  });

  /**
   * **THE SAME KEY ASKED FOR TWICE AT ONCE IS ONE REQUEST.** A cache turns a
   * repeat into a read only after the first has finished, and a transaction is
   * assembled by asking for every circuit's verifying key at the same moment.
   */
  it('does not put the same artefact in the air twice', async () => {
    const { asked, source } = sourceWithCache();
    const zk = zkConfigOver(source, byCircuitName);

    await Promise.all([
      zk.getVerifierKey('approve'), zk.getVerifierKey('approve'), zk.getVerifierKey('approve'),
    ]);

    expect(asked).toEqual(['/keys/approve.verifier']);
  });

  it('asks once per circuit when a set of verifying keys is wanted', async () => {
    const { asked, source } = sourceWithCache();
    const zk = zkConfigOver(source, byCircuitName);

    const pairs = await zk.getVerifierKeys(['approve', 'cancel', 'propose']);

    expect(asked.slice().sort()).toEqual([
      '/keys/approve.verifier', '/keys/cancel.verifier', '/keys/propose.verifier',
    ]);
    expect(pairs.map(([id]) => id)).toEqual(['approve', 'cancel', 'propose']);
  });

  /* ---------------- the negative controls ---------------- */

  /**
   * **THE COUNTER CAN COUNT.** Without this, every case above would also pass
   * against a fetch that was never wired in, an adapter that returned nothing,
   * and a cache that answered everything.
   */
  it('a different location is a different cache entry, so it really does fetch', async () => {
    const { asked, source } = sourceWithCache();
    const zk = zkConfigOver(source, byCircuitName);

    await zk.getVerifierKey('approve');
    await zk.getVerifierKey('cancel');

    expect(asked).toEqual(['/keys/approve.verifier', '/keys/cancel.verifier']);
  });

  /**
   * **AND THE LOCATION IS THE CACHE KEY, NOT THE CIRCUIT.** The prover asks
   * under a location carrying a deployed address and a verifying-key hash; an
   * adapter keyed on the circuit name alone files the same bytes under a second
   * key. This case is that fact, measured, so the cost of `byCircuitName` is a
   * number somebody has seen rather than a paragraph.
   */
  it('the circuit name and the full key location are two entries, and that is the cost', async () => {
    const { asked, source } = sourceWithCache();
    const location = 'contract:90a19bf2/approve?vk=5ac4195f';

    await zkConfigOver(source, byCircuitName).getVerifierKey('approve');
    await source.artefact('verifier', location);

    expect(asked,
      'the same verifying key was fetched twice, under two cache keys, because the interface a '
      + 'call is assembled through names only the circuit')
      .toEqual(['/keys/approve.verifier', '/keys/approve.verifier']);
  });

  /** A caller that CAN name the location pays nothing for the second entry. */
  it('a caller that knows the location shares the entry the prover uses', async () => {
    const { asked, source } = sourceWithCache();
    const location = 'contract:90a19bf2/approve?vk=5ac4195f';

    await source.artefact('verifier', location);
    await zkConfigOver(source, () => location).getVerifierKey('approve');

    expect(asked).toEqual(['/keys/approve.verifier']);
  });

  /**
   * **THE WALLET-FACING VIEW TAKES LOCATIONS, NOT CIRCUIT NAMES, AND IS NOT
   * PUT THROUGH THE MAPPING A SECOND TIME.**
   *
   * What asks for these is a wallet resolving the locations carried in a
   * transaction it was handed. Applying the circuit-to-location mapping to
   * something that is already a location produces a request for an artefact
   * that does not exist - and with the identity mapping in place that mistake
   * is invisible, which is why the case below uses a mapping that is not the
   * identity.
   */
  it('resolves a key location as given, without applying the mapping to it twice', async () => {
    const { asked, source } = sourceWithCache();
    const location = 'contract:90a19bf2/approve?vk=5ac4195f';
    const zk = zkConfigOver(source, (circuitId) => `deployment-9/${circuitId}`);

    /*
     * **THE ENTRY IS WARMED FIRST, AND THAT IS WHAT MAKES THIS ABLE TO FAIL.**
     * Asserting the URL list alone does not: the circuit name is read as the
     * segment after the last separator with the query dropped, so a location
     * and a location with something glued on the front resolve to the SAME URL
     * and differ only in the CACHE KEY. Measured - the first version of this
     * case passed with the defect put back. What a doubled mapping changes is
     * whether the warmed entry is found, so the way to see it is a second
     * fetch that should not happen.
     */
    await source.artefact('verifier', location);
    expect(asked).toEqual(['/keys/approve.verifier']);

    await zk.asKeyMaterialProvider().getVerifierKey(location);

    expect(asked,
      'a key location was put through the circuit-to-location mapping, so it missed the entry '
      + 'the prover had already filled and fetched the same bytes a second time')
      .toEqual(['/keys/approve.verifier']);
  });

  it('and the circuit-named methods DO apply the mapping, which is the control for that', async () => {
    const { asked, source } = sourceWithCache();
    const zk = zkConfigOver(source, (circuitId) => `deployment-9/${circuitId}`);

    await zk.getVerifierKey('approve');

    expect(asked).toEqual(['/keys/approve.verifier']);
    /* Same URL, different cache entry - the mapping is what decides the entry. */
    await source.artefact('verifier', 'approve');
    expect(asked).toEqual(['/keys/approve.verifier', '/keys/approve.verifier']);
  });

  it('reports a failed fetch with the URL and the status, and caches nothing', async () => {
    const asked: string[] = [];
    const impl = (async (url: any) => {
      asked.push(String(url));
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;
    const zk = zkConfigOver(
      httpKeyMaterialSource(BASE, { cache: new MemoryArtefactCache(), fetchImpl: impl }),
      byCircuitName,
    );

    await expect(zk.getVerifierKey('approve')).rejects.toThrow(/404 for .*approve\.verifier/);
    await expect(zk.getVerifierKey('approve')).rejects.toThrow(/404/);
    expect(asked, 'a failure was cached, so the second attempt never happened').toHaveLength(2);
  });
});
