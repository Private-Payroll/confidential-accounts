/**
 * The job store. Decision 0008.
 *
 * These tests are about the things that go wrong once jobs outlive the process:
 * order that stops being fair, one bad record taking every other job with it,
 * and a store that quietly reads somebody else's keys.
 *
 * The `KeyValue` seam is the point — the same JSON path runs in memory, in
 * `localStorage`, and eventually in IndexedDB, so a bug found here is a bug
 * found everywhere.
 */
import { describe, it, expect } from 'vitest';
import { JobQueue, type Job, type JobRunner } from './jobs.js';
import {
  KeyValueJobStore,
  MemoryKeyValue,
  WebStorageKeyValue,
  type KeyValue,
  type WebStorageLike,
} from './jobs-store.js';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job_1',
  accountId: 'acc_1',
  kind: 'approve',
  state: 'queued',
  signerId: 'sgn_1',
  payload: {},
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** A `localStorage` stand-in. Same shape, no browser. */
class FakeWebStorage implements WebStorageLike {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
}

const backends: Array<[string, () => KeyValue]> = [
  ['MemoryKeyValue', () => new MemoryKeyValue()],
  ['WebStorageKeyValue', () => new WebStorageKeyValue(new FakeWebStorage())],
];

describe.each(backends)('KeyValueJobStore over %s', (_name, make) => {
  it('a job written survives being read back whole', async () => {
    // Not "it round-trips": every field matters. `txRef` is what recovery asks
    // the chain about, and `error` is what a person reads.
    const store = new KeyValueJobStore(make());
    const original = job({
      state: 'submitting',
      txRef: 'tx_abc',
      error: 'no DUST to pay the fee',
      attempts: 3,
      payload: { amount: 235_000, memo: 'august payroll' },
    });
    await store.put(original);
    expect((await store.list())[0]).toEqual(original);
  });

  it('writing the same id twice updates rather than duplicating', async () => {
    // A job is saved on every transition. If each save appended, one approval
    // would appear five times in the list and `pending()` would work it five
    // times over.
    const store = new KeyValueJobStore(make());
    await store.put(job({ state: 'queued' }));
    await store.put(job({ state: 'settled', txRef: 'tx_1' }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe('settled');
  });

  it('returns jobs oldest first, whatever order they were written in', async () => {
    /*
     * The queue takes the first pending job. If ordering came from the key —
     * and ids are opaque random strings — the order would be arbitrary, and an
     * approval could sit behind newer ones indefinitely without anyone seeing
     * why.
     */
    const store = new KeyValueJobStore(make());
    await store.put(job({ id: 'zzz', createdAt: '2026-01-01T00:00:03.000Z' }));
    await store.put(job({ id: 'aaa', createdAt: '2026-01-01T00:00:01.000Z' }));
    await store.put(job({ id: 'mmm', createdAt: '2026-01-01T00:00:02.000Z' }));
    expect((await store.list()).map((j) => j.id)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('one corrupt record does not hide the others', async () => {
    /*
     * A half-written record — a tab killed mid-write, a storage quota hit — must
     * cost one job, not every pending approval on the device. Throwing here
     * would make the whole queue unreadable.
     */
    const kv = make();
    const store = new KeyValueJobStore(kv);
    await store.put(job({ id: 'good_1', createdAt: '2026-01-01T00:00:01.000Z' }));
    await kv.set('job:broken', '{"id":"broken",');
    await store.put(job({ id: 'good_2', createdAt: '2026-01-01T00:00:02.000Z' }));

    const all = await store.list();
    expect(all.map((j) => j.id)).toEqual(['good_1', 'good_2']);
  });

  it('leaves the corrupt record on disk rather than deleting it', async () => {
    // It may be the only trace of what someone was trying to do.
    const kv = make();
    const store = new KeyValueJobStore(kv);
    await kv.set('job:broken', 'not json');
    await store.list();
    expect(await kv.get('job:broken')).toBe('not json');
  });

  it('ignores keys that are not jobs', async () => {
    /*
     * The browser's storage is shared with everything else the application
     * keeps there — session state, a viewing key, a feature flag. Reading those
     * as jobs would be a crash at best.
     */
    const kv = make();
    const store = new KeyValueJobStore(kv);
    await kv.set('viewing-key', 'deadbeef');
    await kv.set('account:acc_1', '{"balance":1}');
    await store.put(job({ id: 'job_1' }));

    const all = await store.list();
    expect(all.map((j) => j.id)).toEqual(['job_1']);
  });

  it('is empty rather than broken when nothing has been written', async () => {
    expect(await new KeyValueJobStore(make()).list()).toEqual([]);
  });

  it('hands back copies, so a caller cannot mutate the store by accident', async () => {
    /*
     * `MemoryJobStore` clones for this reason and the two stores must not
     * disagree — otherwise a bug appears only on the backend the tests do not
     * happen to be using.
     */
    const store = new KeyValueJobStore(make());
    await store.put(job({ id: 'job_1', state: 'queued' }));
    const first = (await store.list())[0];
    first.state = 'settled';
    (first.payload as any).injected = true;

    const second = (await store.list())[0];
    expect(second.state).toBe('queued');
    expect(second.payload).toEqual({});
  });
});

describe('the whole queue over persisted storage', () => {
  const runner: JobRunner = {
    prove: async () => ({ proof: 'PROOF' }),
    submit: async () => ({ txRef: 'tx_1' }),
  };

  it('a reopened tab picks up work left behind by the last one', async () => {
    /*
     * THE POINT OF THE FILE. Two queues, two processes, one storage — the
     * second must find what the first left and finish it, with no handover
     * beyond what is on disk.
     */
    const kv = new MemoryKeyValue();

    let seq = 0;
    const opts = () => ({
      store: new KeyValueJobStore(kv),
      now: () => new Date(1_700_000_000_000 + seq++ * 1000),
      newId: () => `job_${seq++}`,
    });

    const before = new JobQueue(runner, opts());
    const a = await before.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    const b = await before.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    // Tab closes here. Nothing was drained.

    const after = new JobQueue(runner, opts());
    expect((await after.pending()).map((j) => j.id)).toEqual([a.id, b.id]);

    await after.drain();
    expect((await after.get(a.id))!.state).toBe('settled');
    expect((await after.get(b.id))!.state).toBe('settled');
    expect(await after.pending()).toHaveLength(0);
  });

  it('the interrupted-submission rule still holds across a restart', async () => {
    /*
     * The dangerous state has to survive serialisation too — `submitting` read
     * back from storage must be treated exactly like `submitting` held in
     * memory, or persistence would quietly reintroduce the double-spend.
     */
    const kv = new MemoryKeyValue();
    const store = new KeyValueJobStore(kv);
    await store.put(job({ id: 'job_flight', kind: 'approve', state: 'submitting', txRef: 'tx_maybe' }));

    const q = new JobQueue(runner, { store });
    await q.drain();

    const done = await q.get('job_flight');
    expect(done!.state).toBe('failed');
    expect(done!.error).toMatch(/may have settled/i);
  });
});
