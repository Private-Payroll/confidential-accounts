/**
 * Where jobs are kept. Decision 0008.
 *
 * `JobQueue` is deliberately storage-agnostic, because the same job model has
 * to run in a browser tab, a Worker, the macOS and iOS apps, and the tests —
 * and each of those keeps data somewhere different. This file is the adapter,
 * and it is written against the smallest interface that all of them can
 * actually provide.
 *
 * WHAT THE SMALLEST INTERFACE IS. Not SQL, not queries, not indexes: get, set,
 * and list-the-keys. IndexedDB, a file, `localStorage`, SQLite and a Map all do
 * that. Anything richer would mean a second implementation for whichever
 * environment could not manage it, and this project has seven recorded
 * instances of one rule written twice.
 *
 * Jobs are per account and finish quickly, so there are tens of them rather
 * than millions. Reading them all to find the pending ones is fine, and staying
 * that simple is what keeps the browser and native stores identical.
 */
import { mayClaim, mayWrite, type Job, type JobLease, type JobStore } from './jobs.js';

/**
 * The least a storage backend has to do.
 *
 * Values are strings rather than objects on purpose: every real backend stores
 * bytes or text, and serialising here rather than in each adapter means the
 * on-disk shape cannot drift between a browser and a phone.
 */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  /**
   * Reads one key and writes it back in one indivisible step.
   *
   * **THE FOURTH METHOD, AND IT IS HERE FOR ONE REASON: A LEASE.** Everything
   * else this seam does is safe to interleave, because a job is only ever
   * written by the worker that is working it. Deciding WHICH worker that is
   * cannot be, and a `get` followed by a `set` from two tabs interleaves in
   * exactly the order that gives them both the same job.
   *
   * `decide` is handed the current value, or `null` where there is none, and
   * returns the value to write - or `null` to write nothing and leave what is
   * there. It may be called more than once if the backend has to retry, so it
   * must not do anything but decide.
   *
   * The three backends satisfy this for three different reasons and each says
   * which: a Map and `localStorage` are synchronous within one process, and
   * IndexedDB serialises transactions across every connection to the database,
   * which is the only one of the three that is a claim about other tabs.
   */
  swap(key: string, decide: (current: string | null) => string | null): Promise<string | null>;
}

const PREFIX = 'job:';

/**
 * A `JobStore` over any key-value backend.
 *
 * Ordering is by `createdAt`, not by key. Keys are ids, and ids are opaque, so
 * key order says nothing. `JobQueue.pending()` takes the first of what this
 * returns, so getting the order wrong quietly makes the queue unfair — an
 * approval could sit behind newer ones indefinitely.
 */
export class KeyValueJobStore implements JobStore {
  constructor(private kv: KeyValue) {}

  async list(): Promise<Job[]> {
    const keys = await this.kv.keys(PREFIX);
    const raw = await Promise.all(keys.map((k) => this.kv.get(k)));

    const jobs: Job[] = [];
    for (const value of raw) {
      if (value === null) continue;
      try {
        jobs.push(JSON.parse(value) as Job);
      } catch {
        /*
         * A corrupt record is skipped rather than thrown.
         *
         * One unreadable job must not make every other job unreachable — that
         * would turn a single bad write into a total loss of a customer's
         * pending approvals. It is left on disk rather than deleted, because
         * a person may still want to know what was in it.
         */
      }
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async put(job: Job): Promise<void> {
    await this.kv.set(PREFIX + job.id, JSON.stringify(job));
  }

  /**
   * The same one indivisible read-and-write `claim` uses, for the same reason.
   * A conditional claim with an unconditional write beside it is not a lock:
   * the write is where a worker that lost its lease takes the job back.
   */
  async writeHeld(job: Job, owner: string, now: Date): Promise<boolean> {
    let kept = false;
    await this.kv.swap(PREFIX + job.id, (current) => {
      kept = false;
      let stored: Job | undefined;
      if (current !== null) {
        try {
          stored = JSON.parse(current) as Job;
        } catch {
          /*
           * A record nobody can parse is left alone, exactly as `claim` leaves
           * it. Overwriting it would destroy whatever it held, and this is the
           * write path rather than a repair.
           */
          return null;
        }
      }
      if (!mayWrite(stored, job, owner, now)) return null;
      kept = true;
      return JSON.stringify(job);
    });
    return kept;
  }

  async claim(id: string, lease: JobLease, now: Date): Promise<Job | null> {
    let taken: Job | null = null;
    await this.kv.swap(PREFIX + id, (current) => {
      taken = null;
      if (current === null) return null;
      let job: Job;
      try {
        job = JSON.parse(current) as Job;
      } catch {
        /*
         * A record nobody can parse is left exactly as it is. `list` already
         * skips it for the same reason - one bad write must not cost a
         * customer every other pending approval - and taking a lease on a job
         * whose contents are unknown would be worse than not working it.
         */
        return null;
      }
      if (!mayClaim(job.lease, lease.owner, now)) return null;
      taken = { ...job, lease };
      return JSON.stringify(taken);
    });
    return taken;
  }
}

/**
 * In memory, for tests and for anything with no storage yet.
 *
 * Not a `JobStore` shortcut: it goes through the same `KeyValue` seam as the
 * real backends, so a test exercises the same serialisation path a browser
 * would. A memory store that skipped JSON would hide exactly the bugs this
 * layer exists to prevent.
 */
export class MemoryKeyValue implements KeyValue {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }

  /** Atomic because a Map is in one process and nothing suspends in between. */
  async swap(key: string, decide: (current: string | null) => string | null): Promise<string | null> {
    const next = decide(this.data.get(key) ?? null);
    if (next !== null) this.data.set(key, next);
    return next;
  }
}

/**
 * `localStorage` or anything with the same shape.
 *
 * Synchronous underneath and wrapped in promises, which is correct rather than
 * lazy: the interface has to be async for IndexedDB and SQLite, and a
 * synchronous backend satisfying an async contract is always safe. The reverse
 * is not.
 *
 * Note this is NOT the recommended browser backend — `localStorage` is capped
 * at a few megabytes and is synchronous on the main thread, which is precisely
 * what decision 0008 is trying to keep clear. It is here because it is useful
 * for a prototype and because having it makes the seam concrete.
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export class WebStorageKeyValue implements KeyValue {
  constructor(private storage: WebStorageLike) {}

  async get(key: string): Promise<string | null> {
    return this.storage.getItem(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);
  }
  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
    return out;
  }

  /**
   * Atomic WITHIN ONE PROCESS ONLY, and that is the honest statement of it.
   *
   * `localStorage` is synchronous, so nothing interleaves between the read and
   * the write on this thread. It is shared with every other tab on the origin
   * and offers no way to lock, so two tabs CAN both pass this. That is not a
   * defect being tolerated: this backend is already labelled above as the one
   * the browser should not use, and IndexedDB is the one that carries the
   * lease for real.
   */
  async swap(key: string, decide: (current: string | null) => string | null): Promise<string | null> {
    const next = decide(this.storage.getItem(key));
    if (next !== null) this.storage.setItem(key, next);
    return next;
  }
}
