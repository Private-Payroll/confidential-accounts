/**
 * **WHAT THIS DEVICE KEEPS OF A COMPANY'S RECORD TREE, IN ITS OWN DATABASE**:
 * every head it checked, the last one, and the last one checked from the
 * company's first batch (`checked`); and headers - every header this device
 * signed, with the entries its changes name and the older leaves its records'
 * chains need, and the last header it checked, with the same (`headers`).
 *
 * Kept in the browser's own database, never the service's, so the service can
 * neither serve it back older nor lose it: a device that kept a header the
 * service no longer gives files it again (`recordsHeldHere`). Each write is one
 * transaction, adding only what is new, so a write that fails leaves everything
 * kept before it as it was; and each head is a row of its own, so how many a
 * device keeps is bounded by the browser's database, not by one value's size.
 * A database this browser will not open keeps nothing: every read then checks
 * from the company's first header, which costs time and believes nothing it
 * should not.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { manifestEntryRefusal, type ManifestEntry } from '../../../src/midnight/record-manifest.js';
import type { SignedChange } from '../../../src/midnight/seat-directory.js';
import {
  leafHashOf, treeHeaderReadable, treeLeafRefusal, ZERO, type CheckedHead, type TreeHeader, type TreeLeaf,
} from '../../../src/midnight/record-tree.js';

/**
 * **WHAT THIS DEVICE KEEPS OF A COMPANY'S RECORD TREE**: every head it checked,
 * the last one, and the last one checked from the company's first batch. Kept
 * in this device's own storage, never the service's, so the service cannot
 * serve it back older.
 */
export interface CheckedHeads {
  readonly latest: CheckedHead;
  /** The last head this device checked forward from the company's first batch; null until it has. */
  readonly fromZero: CheckedHead | null;
  /** Every head this device checked, in seq order from `base`. */
  readonly heads: readonly Hex[];
  /** The seq of the first of `heads`: 0 from the company's first batch; the head this device started from otherwise. */
  readonly base?: number;
  /** Where this device started checking, when not from the company's first batch (`StartedFrom`). */
  readonly from?: StartedFrom;
  /**
   * The last heads this device checked, each whole - its seq, root and
   * directory version - oldest first, at most `RECENT_KEPT`: what a recovery
   * resuming from a head before the latest is followed from.
   */
  readonly recent?: readonly CheckedHead[];
}

/** How many of the heads it checked last a device keeps whole, for a recovery resuming from one of them. */
export const RECENT_KEPT = 64;

/**
 * **WHERE A DEVICE NEW TO A COMPANY STARTED CHECKING ITS RECORDS**, when not
 * from the first batch: the newest head a payroll run approved by the account's
 * threshold vouched for (`vouched`, with that run's identity on chain and the
 * time of the last block showing it paid or charged - what the records are
 * said to be checked back to, by its approvers), or, for a company one key
 * holds, the header before the latest (`latest`).
 */
export interface StartedFrom {
  readonly by: 'vouched' | 'latest';
  readonly seq: number;
  readonly head: Hex;
  readonly run?: string;
  readonly at?: number;
}

const isStartedFrom = (x: unknown): x is StartedFrom => {
  const f = x as Partial<StartedFrom> | null;
  return f !== null && typeof f === 'object' && (f.by === 'vouched' || f.by === 'latest') && Number.isSafeInteger(f.seq) && (f.seq as number) >= 0
    && typeof f.head === 'string' && HEAD_HEX.test(f.head) && (f.run === undefined || (typeof f.run === 'string' && HEAD_HEX.test(f.run)))
    && (f.at === undefined || Number.isFinite(f.at));
};

/** Where a device keeps what it checked, one company at a time. */
export interface CheckedHeadsStore {
  read(company: string): Promise<CheckedHeads | null>;
  write(company: string, heads: CheckedHeads): Promise<void>;
}

/** **A HEADER KEPT ON THIS DEVICE**, with what any device needs to check it: the entries its changes name and its records' older leaves. */
export interface KeptHeader {
  readonly header: TreeHeader;
  readonly entries: readonly ManifestEntry[];
  readonly leaves: readonly TreeLeaf[];
}

/** Where a device keeps headers, one company at a time. */
export interface HeadersKeptStore {
  /** Keeps a header this device signed, with what checking it needs, before it is filed or sent. */
  signed(company: string, kept: KeptHeader): Promise<void>;
  /** Keeps the last header this device checked, in place of the one before it. */
  checked(company: string, kept: KeptHeader): Promise<void>;
  /** Every header this device kept for the company at `seq`: those it signed, and the last it checked. */
  at(company: string, seq: number): Promise<readonly KeptHeader[]>;
}

/**
 * **A SIGNED CHANGE TO THE COMPANY'S DIRECTORY THIS DEVICE FILED** - a
 * quorum's role or retirement - by the version its signatures were made
 * for: kept from before it is first filed until a version carrying it is
 * anchored, so a change the service passes over, or no longer serves, is filed
 * again by this device rather than lost.
 */
export interface KeptDirectoryChange {
  readonly signedAt: number;
  readonly change: SignedChange;
}

/** Where a device keeps the directory changes it filed again, one company at a time. */
export interface DirectoryChangesKeptStore {
  /** Keeps a change, in place of one kept for the same version. */
  keep(company: string, kept: KeptDirectoryChange): Promise<void>;
  /** Every change kept for the company, oldest version first. */
  all(company: string): Promise<readonly KeptDirectoryChange[]>;
  /** Lets go of the change kept for `signedAt`, once a version carrying it is anchored. */
  letGo(company: string, signedAt: number): Promise<void>;
}

/** A kept change as read back: believed in its shape only, and judged like any filing when it is filed again. */
const keptChangeOf = (x: unknown): KeptDirectoryChange | null => {
  const k = x as Partial<KeptDirectoryChange> | null;
  return k !== null && typeof k === 'object' && Number.isSafeInteger(k.signedAt) && (k.signedAt as number) >= 1
    && typeof k.change === 'object' && k.change !== null && (k.change.kind === 'role' || k.change.kind === 'retire')
    ? { signedAt: k.signedAt as number, change: k.change } : null;
};
const inOrder = (all: readonly KeptDirectoryChange[]) => [...all].sort((a, b) => a.signedAt - b.signedAt);

const HEAD_HEX = /^[0-9a-f]{64}$/u;
const isCheckedHead = (x: unknown): x is CheckedHead => {
  const c = x as Partial<CheckedHead> | null;
  return c !== null && typeof c === 'object' && Number.isSafeInteger(c.seq) && (c.seq as number) >= -1
    && typeof c.head === 'string' && HEAD_HEX.test(c.head) && typeof c.root === 'string' && HEAD_HEX.test(c.root)
    && Number.isSafeInteger(c.dirVersion) && (c.dirVersion as number) >= 0;
};

/** A header kept, as read back: believed in its shape only, and checked like any header given. */
const keptHeaderOf = (company: string, x: unknown): KeptHeader | null => {
  const k = x as Partial<KeptHeader> | null;
  if (k === null || typeof k !== 'object' || !treeHeaderReadable(k.header) || !Array.isArray(k.entries) || !Array.isArray(k.leaves)) return null;
  if (k.entries.some((e) => manifestEntryRefusal(company, e) !== null) || k.leaves.some((l) => treeLeafRefusal(l) !== null)) return null;
  return { header: k.header, entries: k.entries, leaves: k.leaves };
};

/** What a device keeps checked heads in when it has no database of its own: this page, until it is closed. */
export const checkedHeadsInMemory = (): CheckedHeadsStore => treeKeptInMemory().checked;

/** What a device keeps when it has no database of its own: this page, until it is closed. */
export const treeKeptInMemory = (): TreeKept => {
  const heads = new Map<string, CheckedHeads>();
  const signed = new Map<string, KeptHeader[]>();
  const last = new Map<string, KeptHeader>();
  const changes = new Map<string, KeptDirectoryChange[]>();
  return {
    changes: {
      keep: async (company, k) => { changes.set(company, inOrder([...(changes.get(company) ?? []).filter((x) => x.signedAt !== k.signedAt), k])); },
      all: async (company) => changes.get(company) ?? [],
      letGo: async (company, v) => { changes.set(company, (changes.get(company) ?? []).filter((x) => x.signedAt !== v)); },
    },
    checked: {
      read: async (company) => heads.get(company) ?? null,
      write: async (company, h) => { heads.set(company, h); },
    },
    headers: {
      signed: async (company, k) => { signed.set(company, [...(signed.get(company) ?? []), k]); },
      checked: async (company, k) => { last.set(company, k); },
      at: async (company, seq) => [...(signed.get(company) ?? []), ...(last.has(company) ? [last.get(company)!] : [])].filter((k) => k.header.seq === seq),
    },
  };
};

/** Everything a device keeps of a company's record tree. */
export interface TreeKept {
  readonly checked: CheckedHeadsStore;
  readonly headers: HeadersKeptStore;
  readonly changes: DirectoryChangesKeptStore;
}

const DATABASE = 'record-tree-kept';
const HEADS = 'checked-heads';
const LATEST = 'checked-latest';
const HEADERS = 'kept-headers';
const CHANGES = 'kept-directory-changes';
const pad = (n: number) => String(n).padStart(12, '0');

/**
 * **THE RECORD TREE THIS DEVICE KEEPS, IN THE BROWSER'S OWN DATABASE.** See the
 * head of this file. A database that cannot be opened, read or written keeps
 * nothing new and refuses nothing; a write that fails is undone whole, so what
 * was kept before it stays.
 */
export const treeKeptHere = (factory?: IDBFactory): TreeKept => {
  const where = (): IDBFactory | null => {
    try { return factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null; } catch { return null; }
  };
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const f = where();
    if (f === null) { reject(new Error('this browser keeps no database')); return; }
    const req = f.open(DATABASE, 2);
    req.onupgradeneeded = () => {
      for (const s of [HEADS, LATEST, HEADERS, CHANGES]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('this browser would not open its record of the company\'s records'));
  });
  /** One transaction over `stores`: `act` reads and writes in it, and its answer is given once the whole transaction is done. */
  const step = async <T>(stores: readonly string[], mode: IDBTransactionMode, act: (tx: IDBTransaction, done: (v: T) => void) => void): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction([...stores], mode);
        let answer: T;
        act(tx, (v) => { answer = v; });
        tx.oncomplete = () => resolve(answer);
        tx.onerror = () => reject(tx.error ?? new Error('this browser did not keep it'));
        tx.onabort = () => reject(tx.error ?? new Error('this browser did not keep it'));
      });
    } finally {
      db.close();
    }
  };
  /** Heads are kept a chunk to a row, so a row's size is bounded and only the last chunk is ever written again. */
  const CHUNK = 1024;
  const chunkKey = (company: string, i: number) => `${company}|${pad(i)}`;
  const checked: CheckedHeadsStore = {
    read: async (company) => {
      try {
        return await step<CheckedHeads | null>([HEADS, LATEST], 'readonly', (tx, done) => {
          const latest = tx.objectStore(LATEST).get(company);
          latest.onsuccess = () => {
            const l = latest.result as { latest?: unknown; fromZero?: unknown; count?: unknown; base?: unknown; from?: unknown; recent?: unknown } | undefined;
            if (l === undefined || !isCheckedHead(l.latest) || !(l.fromZero === null || isCheckedHead(l.fromZero)) || !Number.isSafeInteger(l.count)
              || !(l.base === undefined || (Number.isSafeInteger(l.base) && (l.base as number) >= 0)) || !(l.from === undefined || isStartedFrom(l.from))) {
              done(null);
              return;
            }
            /* Heads kept whole that are not each a head checked are dropped, never believed: the read then follows no recovery from them. */
            const recent = Array.isArray(l.recent) && l.recent.length <= RECENT_KEPT && l.recent.every(isCheckedHead) ? l.recent as CheckedHead[] : undefined;
            const started = {
              ...(l.base === undefined ? {} : { base: l.base as number }), ...(l.from === undefined ? {} : { from: l.from as StartedFrom }),
              ...(recent === undefined ? {} : { recent }),
            };
            const count = l.count as number;
            const n = Math.ceil(count / CHUNK);
            const whole = (heads: readonly unknown[]) => done(heads.length === count && heads.every((h) => typeof h === 'string' && HEAD_HEX.test(h))
              ? { latest: l.latest as CheckedHead, fromZero: l.fromZero as CheckedHead | null, heads: heads as Hex[], ...started } : null);
            if (n === 0) { whole([]); return; }
            const chunks: (unknown[] | undefined)[] = new Array(n).fill(undefined);
            for (let i = 0; i < n; i += 1) {
              const row = tx.objectStore(HEADS).get(chunkKey(company, i));
              row.onsuccess = () => {
                chunks[i] = Array.isArray(row.result) ? row.result as unknown[] : [];
                if (chunks.every((c) => c !== undefined)) whole((chunks as unknown[][]).flat().slice(0, count));
              };
            }
          };
        });
      } catch { return null; }
    },
    write: async (company, h) => {
      try {
        await step<void>([HEADS, LATEST], 'readwrite', (tx, done) => {
          const was = tx.objectStore(LATEST).get(company);
          was.onsuccess = () => {
            const count = Number.isSafeInteger((was.result as { count?: unknown } | undefined)?.count) ? (was.result as { count: number }).count : 0;
            /*
             * Only the chunks holding heads not kept yet are written; every chunk before them is kept as it is - unless the
             * heads now start from another seq (a check from the first batch in place of one from a later head), when all are.
             */
            const wasBase = (was.result as { base?: unknown } | undefined)?.base;
            const sameStart = (Number.isSafeInteger(wasBase) ? wasBase as number : 0) === (h.base ?? 0);
            for (let i = sameStart ? Math.floor(Math.min(count, h.heads.length) / CHUNK) : 0; i * CHUNK < h.heads.length; i += 1) {
              tx.objectStore(HEADS).put(h.heads.slice(i * CHUNK, (i + 1) * CHUNK), chunkKey(company, i));
            }
            tx.objectStore(LATEST).put({
              latest: h.latest, fromZero: h.fromZero, count: h.heads.length,
              ...(h.base === undefined ? {} : { base: h.base }), ...(h.from === undefined ? {} : { from: h.from }),
              ...(h.recent === undefined ? {} : { recent: h.recent }),
            }, company);
            done(undefined);
          };
        });
      } catch { /* undone whole: what was kept before stays, and the next check carries on from it */ }
    },
  };
  /** One header kept under `key`, beside any kept there before it (`add`) or in their place. */
  const keep = async (key: string, k: KeptHeader, add: boolean): Promise<void> => {
    try {
      await step<void>([HEADERS], 'readwrite', (tx, done) => {
        const was = tx.objectStore(HEADERS).get(key);
        was.onsuccess = () => {
          const before = add && Array.isArray(was.result) ? was.result as unknown[] : [];
          tx.objectStore(HEADERS).put([...before, structuredClone(k)], key);
          done(undefined);
        };
      });
    } catch { /* kept nowhere: a header the service no longer gives is then one this device cannot file again */ }
  };
  const headers: HeadersKeptStore = {
    signed: (company, k) => keep(`${company}|signed|${pad(k.header.seq)}`, k, true),
    checked: (company, k) => keep(`${company}|checked`, k, false),
    at: async (company, seq) => {
      try {
        const rows = await step<unknown[]>([HEADERS], 'readonly', (tx, done) => {
          const got: (unknown[] | undefined)[] = [undefined, undefined];
          [`${company}|signed|${pad(seq)}`, `${company}|checked`].forEach((key, i) => {
            const r = tx.objectStore(HEADERS).get(key);
            r.onsuccess = () => { got[i] = Array.isArray(r.result) ? r.result as unknown[] : []; if (got.every((g) => g !== undefined)) done((got as unknown[][]).flat()); };
          });
        });
        return rows.map((x) => keptHeaderOf(company, x)).filter((k): k is KeptHeader => k !== null && k.header.seq === seq);
      } catch { return []; }
    },
  };
  /** Every change kept for a company, read and replaced in one transaction by `edit`. */
  const editChanges = async (company: string, edit: (was: readonly KeptDirectoryChange[]) => readonly KeptDirectoryChange[]): Promise<void> => {
    try {
      await step<void>([CHANGES], 'readwrite', (tx, done) => {
        const was = tx.objectStore(CHANGES).get(company);
        was.onsuccess = () => {
          const before = (Array.isArray(was.result) ? was.result as unknown[] : []).map(keptChangeOf).filter((k): k is KeptDirectoryChange => k !== null);
          tx.objectStore(CHANGES).put(inOrder(edit(before)).map((k) => structuredClone(k)), company);
          done(undefined);
        };
      });
    } catch { /* kept nowhere: a change the service no longer serves is then one this device cannot file again */ }
  };
  const changes: DirectoryChangesKeptStore = {
    keep: (company, k) => editChanges(company, (was) => [...was.filter((x) => x.signedAt !== k.signedAt), k]),
    all: async (company) => {
      try {
        const row = await step<unknown>([CHANGES], 'readonly', (tx, done) => {
          const r = tx.objectStore(CHANGES).get(company);
          r.onsuccess = () => done(r.result);
        });
        return inOrder((Array.isArray(row) ? row : []).map(keptChangeOf).filter((k): k is KeptDirectoryChange => k !== null));
      } catch { return []; }
    },
    letGo: (company, v) => editChanges(company, (was) => was.filter((x) => x.signedAt !== v)),
  };
  return { checked, headers, changes };
};

/**
 * **WHAT A HEADER NEEDS KEPT WITH IT**, from what was given beside it: the entries
 * its changes name, and every older leaf on its records' prior chains that was
 * given - so a device that files it again gives the service what checking it needs.
 */
export const keptWith = (header: TreeHeader, entries: (id: Hex) => ManifestEntry | undefined, older: (hash: Hex) => TreeLeaf | undefined): KeptHeader => {
  const named = header.changes.map((c) => entries(c.leaf.entryId)).filter((e): e is ManifestEntry => e !== undefined);
  const leaves = new Map<Hex, TreeLeaf>();
  for (const c of header.changes) {
    for (let p = c.prior; p !== null && p.prior !== ZERO;) {
      const o = older(p.prior);
      if (o === undefined || leaves.has(p.prior) || leafHashOf(o) !== p.prior) break;
      leaves.set(p.prior, o);
      p = o;
    }
  }
  return { header, entries: named, leaves: [...leaves.values()] };
};
