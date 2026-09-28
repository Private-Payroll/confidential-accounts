/**
 * **EVERY FAILURE TO FETCH OR KEEP A PROVING FILE SAYS WHAT FAILED AND WHERE.**
 *
 * A proof on this device needs files the application serves: proving keys,
 * circuits and the public parameters. When one does not arrive, the person sees
 * one sentence, and that sentence is the only evidence anybody gets. So it
 * names every name that was tried and why each failed, a download that ended
 * early, a server that could not be reached, and the browser's own store
 * refusing to keep what arrived.
 *
 * **AND EVERY FILE FETCHED IS CHECKED WITH THE SERVER, NOT REPLAYED FROM THE
 * BROWSER'S OWN HTTP CACHE.** A refusal a server once allowed a browser to keep was answered from
 * that cache for an hour, after the file was being served, with the request
 * never leaving the browser.
 */
import { describe, it, expect } from 'vitest';
import { httpKeyMaterialSource, IndexedDbArtefactCache, MemoryArtefactCache } from './key-material.js';

type Answer = { status?: number; length?: string | null; encoding?: string; chunks?: number[][]; breaksAfter?: number; whole?: number[] };

/** A response as a browser hands it over: a status, two headers, and a body read a piece at a time. */
const answer = (a: Answer): Response => {
  let at = 0;
  const chunks = a.chunks ?? [];
  const headers: Record<string, string | null> = { 'content-length': a.length ?? null, 'content-encoding': a.encoding ?? null };
  return {
    ok: (a.status ?? 200) >= 200 && (a.status ?? 200) < 300,
    status: a.status ?? 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: a.whole !== undefined ? null : {
      getReader: () => ({
        read: async () => {
          if (a.breaksAfter !== undefined && at === a.breaksAfter) throw new TypeError('network error');
          return at < chunks.length ? { done: false, value: new Uint8Array(chunks[at++]!) } : { done: true, value: undefined };
        },
      }),
    },
    arrayBuffer: async () => new Uint8Array(a.whole ?? chunks.flat()).buffer,
  } as unknown as Response;
};

describe('WHAT A FAILED PROVING FILE SAYS', () => {
  it('A PARAMETER FILE THAT FAILS UNDER ONE NAME AND THEN ANOTHER SAYS WHY FOR BOTH, THE FIRST NAME FIRST', async () => {
    /* RED WHEN: only the last name's reason is kept - the sentence then names only the older spelling's
     * refusal, which is the one that never matters, and hides why the file that should have arrived did not. */
    const src = httpKeyMaterialSource('/a', {
      fetchImpl: (async (url: string) => answer({ status: url.includes('midnight') ? 503 : 404 })) as never,
    });
    const said = await src.getParams(15).then(() => '', (e: Error) => e.message);
    expect(said).toContain('bls_midnight_2p15: 503 for /a/params/bls_midnight_2p15');
    expect(said).toContain('bls_filecoin_2p15: 404 for /a/params/bls_filecoin_2p15');
    expect(said.indexOf('bls_midnight_2p15:')).toBeLessThan(said.indexOf('bls_filecoin_2p15:'));
    expect(said).toContain('(k=15)');
    /* RED WHEN: the sentence stops saying what resolves it. */
    expect(said).toMatch(/the service fetches and checks these when it starts/i);
  });

  it('A DOWNLOAD THAT ENDS BEFORE THE LENGTH THE SERVER GAVE IS A FAILURE THAT SAYS SO, AND NOTHING IS KEPT', async () => {
    /* RED WHEN: the bytes that arrived are taken as the file whatever the server said its length was - four of
     * six bytes are then handed to the prover and kept for every proof after. */
    const cache = new MemoryArtefactCache();
    const src = httpKeyMaterialSource('/a', { cache, fetchImpl: (async () => answer({ length: '6', chunks: [[1, 2, 3], [4]] })) as never });
    await expect(src.artefact('prover', 'x/deposit')).rejects.toThrow('the download of /a/keys/deposit.prover stopped after 4 of 6 bytes');
    expect(await cache.get('artefact:prover:x/deposit')).toBeNull();
  });

  it('THE SAME IS TRUE WHERE THE BODY CAN ONLY BE READ WHOLE', async () => {
    /* RED WHEN: the whole-body path skips the length check the streaming path makes. */
    const src = httpKeyMaterialSource('/a', { fetchImpl: (async () => answer({ length: '6', whole: [1, 2, 3, 4] })) as never });
    await expect(src.artefact('ir', 'x/deposit')).rejects.toThrow('the download of /a/zkir/deposit.bzkir stopped after 4 of 6 bytes');
  });

  it('A BODY SENT AS IT IS, SAID SO BY NAME, IS HELD TO ITS LENGTH', async () => {
    /* RED WHEN: a body whose encoding is named as none is treated as encoded - its length is then never checked. */
    const src = httpKeyMaterialSource('/a', { fetchImpl: (async () => answer({ length: '6', encoding: 'identity', chunks: [[1, 2, 3], [4]] })) as never });
    await expect(src.artefact('prover', 'x/deposit')).rejects.toThrow('the download of /a/keys/deposit.prover stopped after 4 of 6 bytes');
  });

  it('A BODY THAT BREAKS WHILE BEING READ WHOLE SAYS SO, AND DOES NOT GUESS HOW MUCH HAD ARRIVED', async () => {
    /* RED WHEN: the whole-body failure reports a byte count - nothing counted the bytes, so any figure is invented. */
    const broken = { ...answer({ length: '6', whole: [1] }), arrayBuffer: async () => { throw new TypeError('network error'); } } as unknown as Response;
    const src = httpKeyMaterialSource('/a', { fetchImpl: (async () => broken) as never });
    await expect(src.artefact('prover', 'x/deposit')).rejects.toThrow('the download of /a/keys/deposit.prover broke before it could be read: network error');
  });

  it('AN ENCODED BODY THAT BREAKS PART WAY DOES NOT SET WHAT ARRIVED AGAINST THE ENCODED LENGTH', async () => {
    /* RED WHEN: the encoded length is printed beside the decoded count - "4 of 3 bytes" reads as a measurement and is not one. */
    const src = httpKeyMaterialSource('/a', { fetchImpl: (async () => answer({ length: '3', encoding: 'gzip', chunks: [[1, 2, 3, 4], [5]], breaksAfter: 1 })) as never });
    await expect(src.artefact('prover', 'x/deposit')).rejects.toThrow(/^the download of \/a\/keys\/deposit\.prover stopped after 4 bytes: network error$/);
  });

  it('A BODY THAT WAS ENCODED ON THE WAY IS NOT HELD TO THE ENCODED LENGTH', async () => {
    /* RED WHEN: the length check ignores the encoding - the header counts the compressed bytes and the browser
     * hands over the decompressed ones, so every compressed file would be refused. */
    const src = httpKeyMaterialSource('/a', { fetchImpl: (async () => answer({ length: '3', encoding: 'gzip', chunks: [[1, 2, 3], [4, 5, 6]] })) as never });
    expect([...await src.artefact('verifier', 'x/deposit')]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('A DOWNLOAD THAT BREAKS PART WAY SAYS WHICH FILE, HOW FAR IT GOT, AND WHY', async () => {
    /* RED WHEN: the reader's own failure is let through as it is - "network error", naming no file. */
    const src = httpKeyMaterialSource('/a', { fetchImpl: (async () => answer({ length: '6', chunks: [[1, 2, 3], [4, 5, 6]], breaksAfter: 1 })) as never });
    await expect(src.artefact('prover', 'x/deposit')).rejects.toThrow('the download of /a/keys/deposit.prover stopped after 3 of 6 bytes: network error');
  });

  it('A SERVER THAT CANNOT BE REACHED IS NAMED', async () => {
    /* RED WHEN: the fetch's own rejection is let through - "Failed to fetch", naming nothing. */
    const src = httpKeyMaterialSource('/a', { fetchImpl: (async () => { throw new TypeError('Failed to fetch'); }) as never });
    await expect(src.artefact('prover', 'x/deposit')).rejects.toThrow('/a/keys/deposit.prover could not be reached: Failed to fetch');
  });
});

describe('EVERY PROVING FILE THAT IS FETCHED IS CHECKED WITH THE SERVER', () => {
  it('EVERY FETCH TELLS THE BROWSER TO CHECK WITH THE SERVER BEFORE USING ANYTHING IT KEPT', async () => {
    /* RED WHEN: a fetch is made with the browser's default caching - a refusal the browser was once allowed to
     * keep is then replayed without the request leaving the browser, for as long as it was allowed. */
    const asked: Array<{ url: string; cache: unknown }> = [];
    const src = httpKeyMaterialSource('/a', {
      fetchImpl: (async (url: string, init?: RequestInit) => {
        asked.push({ url, cache: init?.cache });
        return url.includes('filecoin') || url.includes('midnight_2p9') ? answer({ status: 404 }) : answer({ length: '1', chunks: [[7]] });
      }) as never,
    });
    await src.lookupKey('x/deposit');
    await src.artefact('verifier', 'x/payout');
    await src.getParams(15);
    await src.getParams(9).catch(() => undefined);
    expect(asked.length).toBe(7);
    expect(asked.filter((a) => a.cache !== 'no-cache')).toEqual([]);
  });
});

/** A browser store that opens and then refuses every read and write, as a full disk makes it do. */
const aStoreThatRefuses = () => ({
  open: () => {
    const request: any = {};
    setTimeout(() => {
      request.result = {
        objectStoreNames: { contains: () => true },
        transaction: () => { const e = new Error('the quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; },
      };
      request.onsuccess?.();
    }, 0);
    return request;
  },
});

describe('THE BROWSER\'S OWN STORE REFUSING A FILE IS SAID, AND COSTS ONLY A DOWNLOAD', () => {
  it('A REFUSAL TO KEEP OR HAND BACK A FILE IS TOLD, NAMING THE FILE AND THE STORE\'S REASON, AND NEVER THROWN', async () => {
    /* RED WHEN: the store's refusal is swallowed without being told - a file that is downloaded again for every
     * proof then looks exactly like one that was never kept. */
    const told: string[] = [];
    const cache = new IndexedDbArtefactCache(aStoreThatRefuses(), 'test', (why) => told.push(why));
    await expect(cache.put('artefact:params:bls_midnight_2p15', new Uint8Array([1]))).resolves.toBeUndefined();
    await expect(cache.get('artefact:params:bls_midnight_2p15')).resolves.toBeNull();
    expect(told).toEqual([
      "this browser's store would not keep artefact:params:bls_midnight_2p15: the quota has been exceeded.",
      "this browser's store would not hand back artefact:params:bls_midnight_2p15: the quota has been exceeded.",
    ]);
  });

  it('WHOEVER IS TOLD CANNOT STOP THE CACHE', async () => {
    /* RED WHEN: a listener that throws is let throw - a failing console would then stop a proof. */
    const cache = new IndexedDbArtefactCache(aStoreThatRefuses(), 'test', () => { throw new Error('nobody listening'); });
    await expect(cache.put('k', new Uint8Array([1]))).resolves.toBeUndefined();
    await expect(cache.get('k')).resolves.toBeNull();
  });
});
