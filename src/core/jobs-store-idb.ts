/**
 * IndexedDB, which is the store the browser actually gets. Decision 0008, M-79.
 *
 * `WebStorageKeyValue` exists in `jobs-store.ts` and is deliberately labelled as
 * NOT the recommended browser backend: `localStorage` is capped at a few
 * megabytes and every call is synchronous on the main thread, which is precisely
 * the freeze the job model exists to avoid. IndexedDB is asynchronous, is
 * measured in hundreds of megabytes, and is available inside a Worker — where
 * the queue actually lives.
 *
 * It implements the same three-method `KeyValue` seam as the others, so the
 * ordering rule, the corrupt-record tolerance and the prefix isolation are all
 * inherited from `KeyValueJobStore` rather than written again here. This file
 * knows about IndexedDB and nothing about jobs.
 *
 * ONE STORE, KEY-VALUE, NO INDEXES. IndexedDB can do far more than this and the
 * temptation is to use it: an index on `state`, a cursor for `pending()`. That
 * would make this the only backend that could answer those questions, and the
 * memory, file and `localStorage` stores would each need their own version of
 * the same logic — which is the failure this project has recorded nine times.
 */
import type { KeyValue } from './jobs-store.js';

/**
 * The slice of the IndexedDB API this needs, declared structurally.
 *
 * Not `lib.dom` types, because this module is imported by code that also runs in
 * Node and in the tests, and a DOM lib reference would make it un-typecheckable
 * there. The shape is small enough to state.
 */
export interface IDBFactoryLike {
  open(name: string, version?: number): any;
}

const STORE = 'kv';

/**
 * Opens the database, creating the object store on first use.
 *
 * Held as a promise rather than a connection so that concurrent callers share
 * one open rather than racing several. A second `open()` while the first is
 * still upgrading is a classic source of `VersionError`, and the queue calls
 * `list()` and `put()` in quick succession by design.
 */
const openOnce = (factory: IDBFactoryLike, name: string): Promise<any> =>
  new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`could not open the database "${name}"`));
    /*
     * `blocked` fires when another tab holds an older version open. Reported
     * rather than left hanging: silence here is a spinner that never stops, and
     * the person can act on "another tab" in a way they cannot act on nothing.
     */
    request.onblocked = () =>
      reject(new Error(`the database "${name}" is open in another tab and is blocking this one`));
  });

const run = <T>(db: any, mode: 'readonly' | 'readwrite', fn: (store: any) => any): Promise<T> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    /*
     * Resolve on the REQUEST, reject on the TRANSACTION.
     *
     * A write can look successful on its request and still be rolled back when
     * the transaction aborts — a quota exception is the common one. Taking the
     * request's word for it is how a job appears saved and is not there after a
     * reload, which is the exact failure this store exists to prevent.
     */
    let value: T;
    request.onsuccess = () => { value = request.result; };
    request.onerror = () => reject(request.error ?? new Error('the database request failed'));
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error('the database transaction was rolled back'));
    tx.onerror = () => reject(tx.error ?? new Error('the database transaction failed'));
  });

/**
 * Reads one key and writes it back inside ONE transaction.
 *
 * **THIS IS THE ONLY PLACE IN THIS PRODUCT THAT MAKES A CLAIM ABOUT ANOTHER
 * TAB, SO IT IS WRITTEN OUT RATHER THAN LEFT TO THE SHAPE OF THE CODE.**
 * IndexedDB transactions over the same object store are serialised by the
 * browser across every connection to that database, including connections from
 * other tabs and other workers. So the read below and the write that follows it
 * cannot have another tab's read and write threaded between them: the second
 * tab's transaction begins after this one has committed and sees what it wrote.
 * That is what turns a lease from a convention into a lock.
 *
 * The whole decision therefore has to happen INSIDE the transaction, with no
 * `await` on anything else. Awaiting something outside lets the transaction go
 * inactive, and the write then fails with a message about the transaction
 * rather than about the lease - which is why `decide` is synchronous in the
 * interface.
 */
const swapInOneTransaction = (
  db: any,
  key: string,
  decide: (current: string | null) => string | null,
): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const read = store.get(key);
    let written: string | null = null;
    read.onsuccess = () => {
      const current = read.result === undefined ? null : String(read.result);
      let next: string | null;
      try {
        next = decide(current);
      } catch (e) {
        // Abort rather than leave a half-decided transaction open: an
        // exception thrown here would otherwise commit the read and nothing
        // else, and the caller would never hear why.
        tx.abort?.();
        return reject(e);
      }
      if (next === null) return;
      written = next;
      store.put(next, key);
    };
    read.onerror = () => reject(read.error ?? new Error('the database request failed'));
    tx.oncomplete = () => resolve(written);
    tx.onabort = () => reject(tx.error ?? new Error('the database transaction was rolled back'));
    tx.onerror = () => reject(tx.error ?? new Error('the database transaction failed'));
  });

export class IndexedDbKeyValue implements KeyValue {
  private db: Promise<any> | null = null;

  /**
   * `factory` is injected rather than reached for, so this can be driven by a
   * fake in a test and by `self.indexedDB` inside a Worker — where `window`
   * does not exist and reaching for it would throw.
   */
  constructor(
    private factory: IDBFactoryLike,
    private name = 'confidential-accounts-jobs',
  ) {}

  private open(): Promise<any> {
    if (!this.db) this.db = openOnce(this.factory, this.name);
    return this.db;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.open();
    const value = await run<unknown>(db, 'readonly', (s) => s.get(key));
    return value === undefined ? null : String(value);
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.open();
    await run<void>(db, 'readwrite', (s) => s.put(value, key));
  }

  async keys(prefix: string): Promise<string[]> {
    const db = await this.open();
    /*
     * `getAllKeys()` and then filter, rather than a bounded key range.
     *
     * A range would be faster and would also be the only backend doing
     * something different from the others for the same question. Jobs are per
     * account and finish quickly — tens of them, not millions — so the
     * difference is unmeasurable and the consistency is worth more.
     */
    const all = await run<unknown[]>(db, 'readonly', (s) => s.getAllKeys());
    return (all ?? []).map(String).filter((k) => k.startsWith(prefix));
  }

  async swap(key: string, decide: (current: string | null) => string | null): Promise<string | null> {
    const db = await this.open();
    return swapInOneTransaction(db, key, decide);
  }

  /** Lets a Worker shut down without leaving a connection blocking the next one. */
  async close(): Promise<void> {
    if (!this.db) return;
    const db = await this.db;
    this.db = null;
    db.close?.();
  }
}
