/**
 * The IndexedDB store's failure paths.
 *
 * The happy path is tested where it belongs — in an actual browser, driving an
 * actual Worker (`browser-proving/worker-probe.ts`). A fake IndexedDB proving
 * that a fake IndexedDB works would be the vacuous shape this project has now
 * hit three times.
 *
 * What is here is what a browser will not produce on demand: a transaction that
 * aborts after its request succeeded, a database blocked by another tab, and a
 * failed open. Each of those is a silent data-loss bug if handled wrongly.
 */
import { describe, it, expect } from 'vitest';
import { IndexedDbKeyValue } from './jobs-store-idb.js';

/** Just enough IndexedDB to drive the callbacks, with the timing they really have. */
const factory = (behaviour: {
  openFails?: boolean; blocked?: boolean; abortOnWrite?: boolean; requestFails?: boolean;
} = {}) => {
  const data = new Map<string, string>();
  return {
    open() {
      const req: any = { result: null, error: null };
      queueMicrotask(() => {
        if (behaviour.blocked) return req.onblocked?.();
        if (behaviour.openFails) { req.error = new Error('nope'); return req.onerror?.(); }
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          close: () => {},
          transaction() {
            const tx: any = { error: null };
            const store = {
              get: (k: string) => request(data.get(k)),
              put: (v: string, k: string) => { if (!behaviour.abortOnWrite) data.set(k, v); return request(undefined); },
              getAllKeys: () => request([...data.keys()]),
            };
            function request(result: unknown) {
              const r: any = { result, error: null };
              queueMicrotask(() => {
                if (behaviour.requestFails) { r.error = new Error('request failed'); r.onerror?.(); return; }
                r.onsuccess?.();
                // The transaction settles AFTER the request, which is the whole
                // reason the store waits for it rather than for the request.
                queueMicrotask(() => {
                  if (behaviour.abortOnWrite) { tx.error = new Error('QuotaExceededError'); tx.onabort?.(); }
                  else tx.oncomplete?.();
                });
              });
              return r;
            }
            tx.objectStore = () => store;
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
};

describe('IndexedDbKeyValue', () => {
  it('round-trips a value', async () => {
    const kv = new IndexedDbKeyValue(factory());
    await kv.set('job:1', '{"id":"1"}');
    expect(await kv.get('job:1')).toBe('{"id":"1"}');
  });

  it('reports a missing key as null, not undefined', async () => {
    // `KeyValueJobStore.list` skips nulls. Undefined would be stringified to
    // "undefined" and then fail to parse as a corrupt record, which would hide
    // a missing key as a damaged one.
    expect(await new IndexedDbKeyValue(factory()).get('job:nope')).toBeNull();
  });

  it('filters keys by prefix, so other application data is not read as jobs', async () => {
    const kv = new IndexedDbKeyValue(factory());
    await kv.set('job:1', 'a');
    await kv.set('viewing-key', 'b');
    expect(await kv.keys('job:')).toEqual(['job:1']);
  });

  it('FAILS when the transaction aborts, even though the request succeeded', async () => {
    /*
     * THE ONE THAT MATTERS. A write can report success on its request and still
     * be rolled back when the transaction aborts — hitting the storage quota is
     * the common way. Taking the request's word for it is how a job appears
     * saved, is not there after a reload, and the approval silently disappears.
     */
    const kv = new IndexedDbKeyValue(factory({ abortOnWrite: true }));
    await expect(kv.set('job:1', 'x')).rejects.toThrow(/rolled back|Quota/i);
  });

  it('says so when another tab is blocking the database', async () => {
    // Silence here is a spinner that never stops. "Another tab" is something a
    // person can act on; nothing is not.
    await expect(new IndexedDbKeyValue(factory({ blocked: true })).get('job:1'))
      .rejects.toThrow(/another tab/i);
  });

  it('surfaces a failed open rather than hanging', async () => {
    await expect(new IndexedDbKeyValue(factory({ openFails: true })).get('job:1')).rejects.toThrow();
  });

  it('surfaces a failed request', async () => {
    await expect(new IndexedDbKeyValue(factory({ requestFails: true })).get('job:1')).rejects.toThrow();
  });

  it('opens once and shares it, rather than racing several opens', async () => {
    // Concurrent opens while the first is still upgrading is the classic source
    // of VersionError, and the queue calls list() and put() back to back.
    let opens = 0;
    const f = factory();
    const counting = { open: (...a: any[]) => { opens += 1; return (f.open as any)(...a); } };
    const kv = new IndexedDbKeyValue(counting);
    await Promise.all([kv.get('a'), kv.get('b'), kv.set('c', 'd')]);
    expect(opens).toBe(1);
  });
});
