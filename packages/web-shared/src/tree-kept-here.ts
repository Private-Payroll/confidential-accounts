/**
 * **WHAT THIS DEVICE KEEPS OF A COMPANY'S RECORD TREE, IN ITS OWN DATABASE**:
 * every head it checked on the chain's line, the last one, and the last one
 * checked from the company's first batch (`checked`); and headers - every header this device
 * signed, with the entries its changes name and the older leaves its records'
 * chains need, and the last header it checked, with the same (`headers`).
 *
 * Kept in the browser's own database, never the service's, so the service can
 * neither serve it back older nor lose it: a device that kept a header the
 * service no longer gives files it again (`recordsHeldHere`). Each write is one
 * transaction, writing only what changed, so a write that fails leaves everything
 * kept before it as it was; and heads are kept a chunk to a row, so how many a
 * device keeps is bounded by the browser's database, not by one value's size.
 * A database this browser will not open keeps nothing: every read then checks
 * from the company's first header, which costs time and believes nothing it
 * should not.
 *
 * Replays of a company's directory are kept too, in this page's memory only and
 * never in the database (`directoryReplaysInMemory`).
 *
 * Also kept here: the heads of batches before a start this device found
 * (`before`, so a later read does not read those headers again), the recovery
 * window the wallet read, the signed directory changes this device filed, and
 * the chain notes no record named (`TreeKept`).
 */
import type { Hex } from '../../../src/core/crypto.js';
import { manifestEntryRefusal, type ManifestEntry } from '../../../src/midnight/record-manifest.js';
import type { DirectoryReplayKept, SignedChange } from '../../../src/midnight/seat-directory.js';
import {
  leafHashOf, treeHeaderReadable, treeLeafRefusal, ZERO, type CheckedHead, type TreeHeader, type TreeLeaf,
} from '../../../src/midnight/record-tree.js';

/** What a head is written as: 64 lowercase hex digits. */
const HEAD_HEX = /^[0-9a-f]{64}$/u;

/**
 * **THE HEADS THIS DEVICE CHECKED OF A COMPANY'S RECORD TREE**: every one on
 * the chain's line, the last, the last checked from the company's first batch, the last few whole
 * (`recent`), where it started when not from the first batch, and the heads
 * it found before that start (`before`). Kept in this device's own storage,
 * never the service's, so the service cannot serve it back older.
 */
export interface CheckedHeads {
  readonly latest: CheckedHead;
  /** The last head this device checked forward from the company's first batch; null until it has. */
  readonly fromZero: CheckedHead | null;
  /** Every head this device checked on the chain's line, in seq order from `base`: none a recovery gave up. */
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
  /**
   * The heads of batches before `base` this device found, each run as one walk through the headers tied it to a head:
   * kept so a later read believes them without reading those headers again, while the head each run is tied to is
   * still one the account's history shows or the head this device started from (`headsHere`). None for a device that
   * found none, which reads as every device did before any was kept.
   */
  readonly before?: readonly HeadsBeforeStart[];
  /** In a write only, never kept or read back: the latest a recovery moved this device back from (`keptAfter`). */
  readonly gaveUp?: CheckedHead;
}

/**
 * **HEADS OF BATCHES BEFORE A DEVICE'S START, AS ONE WALK FOUND THEM**: the head each batch from `from` on left, in
 * order, followed through the headers to `tied`, the first head on the way that the account's history showed or that
 * this device started from.
 */
export interface HeadsBeforeStart {
  readonly from: number;
  readonly heads: readonly Hex[];
  readonly tied: { readonly seq: number; readonly head: Hex };
}

/** How many runs of heads before its start a device keeps for one company: the newest, past that. */
export const BEFORE_KEPT = 256;

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
 * quorum's retirement - by the version its signatures were made
 * for: kept from before it is first filed until a version carrying it is
 * anchored, so a change the service passes over, or no longer serves, is filed
 * again by this device rather than lost. A change of the company's key is
 * never kept, and none is read back.
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

/**
 * **THE RECOVERY WINDOW THIS WALLET READ, AS OF THE LAST RECORDS IT CHECKED** (`head`, `seq`): the length in force
 * (`seconds`), null when none is in force, or why a version the records name does not open here for want of the company's key (`unread`). Written by the
 * upkeep each time it reads the window; a recovery, which asks the service nothing, holds the window kept for the very
 * batch it resumes from.
 */
export interface KeptRecoveryWindow {
  readonly head: Hex;
  readonly seq: number;
  readonly seconds: number | null;
  readonly unread?: string;
}

/** Where a device keeps the recovery window it read, one company at a time. */
export interface RecoveryWindowsKeptStore {
  read(company: string): Promise<KeptRecoveryWindow | null>;
  write(company: string, kept: KeptRecoveryWindow): Promise<void>;
}

/**
 * **THE CHAIN NOTES OF A VAULT THAT NO RECORD THIS DEVICE COULD READ NAMED**, one row for each note (named by its
 * reader, the vault and the note) holding what it was last looked for in, as its reader writes it (the signer and the
 * newest versions of the vault's pool, journals and nonce secrets), so the same note is not looked for again in the same
 * records: a new filing, a newly given secret or another signer differs from what is kept, and it is looked for again,
 * and the row is overwritten. Kept only to spare work: a note kept here is still named the moment a record names it.
 * Each call reads or writes every note given in one go.
 */
export interface UnnamedNotesKeptStore {
  /** What each of `notes` was last looked for in, or null for a note not kept. */
  lookedIn(company: string, notes: readonly string[]): Promise<readonly (string | null)[]>;
  keep(company: string, notes: readonly string[], lookedIn: string): Promise<void>;
}

/** A kept window as read back: believed in its shape only, else read as nothing kept. */
const keptWindowOf = (x: unknown): KeptRecoveryWindow | null => {
  const k = x as Partial<KeptRecoveryWindow> | null;
  if (k === null || typeof k !== 'object' || typeof k.head !== 'string' || !HEAD_HEX.test(k.head) || !Number.isSafeInteger(k.seq)) return null;
  if (k.unread !== undefined) return typeof k.unread === 'string' ? { head: k.head, seq: k.seq as number, seconds: null, unread: k.unread } : null;
  return k.seconds === null || (typeof k.seconds === 'number' && Number.isSafeInteger(k.seconds) && k.seconds > 0)
    ? { head: k.head, seq: k.seq as number, seconds: k.seconds } : null;
};

/**
 * A kept change as read back: believed in its shape only, and judged like any filing when it is filed again. Only a
 * quorum's retirement is read back: a change of the company's key is never kept or filed again.
 */
const keptChangeOf = (x: unknown): KeptDirectoryChange | null => {
  const k = x as Partial<KeptDirectoryChange> | null;
  return k !== null && typeof k === 'object' && Number.isSafeInteger(k.signedAt) && (k.signedAt as number) >= 1
    && typeof k.change === 'object' && k.change !== null && k.change.kind === 'retire'
    ? { signedAt: k.signedAt as number, change: k.change } : null;
};
const inOrder = (all: readonly KeptDirectoryChange[]) => [...all].sort((a, b) => a.signedAt - b.signedAt);

/** A run of heads before a device's start, whole: a first batch, at least one head, and the head it is tied to at or after its last. */
const isHeadsBeforeStart = (x: unknown): x is HeadsBeforeStart => {
  const r = x as Partial<HeadsBeforeStart> | null;
  return r !== null && typeof r === 'object' && Number.isSafeInteger(r.from) && (r.from as number) >= 0
    && Array.isArray(r.heads) && r.heads.length > 0 && r.heads.every((h) => typeof h === 'string' && HEAD_HEX.test(h))
    && r.tied !== null && typeof r.tied === 'object' && Number.isSafeInteger(r.tied.seq) && typeof r.tied.head === 'string'
    && HEAD_HEX.test(r.tied.head) && r.tied.seq >= (r.from as number) + r.heads.length - 1;
};

/** What a write is weighed against: the store as it stands, without its heads. */
type KeptNow = Pick<CheckedHeads, 'latest' | 'fromZero' | 'base' | 'from' | 'before'>;
/** Where a store's heads start: the seq of its first head and the start it names. */
const startOf = (h: Pick<CheckedHeads, 'base' | 'from'>): string => JSON.stringify([h.base ?? 0, h.from ?? null]);
/** The runs `was` kept for batches `now` has no run starting at, followed by every run `now` names; at most the newest `BEFORE_KEPT`. */
const runsMerged = (was: KeptNow['before'], now: KeptNow['before']): readonly HeadsBeforeStart[] | undefined => {
  const all = [...(was ?? []).filter((r) => !(now ?? []).some((n) => n.from === r.from)), ...(now ?? [])];
  return all.length === 0 ? undefined : all.slice(-BEFORE_KEPT);
};
/** `h` holding `before` as its heads before the start, or none. */
const withRuns = <T extends object>(h: T, before: KeptNow['before']): T => {
  const { before: _left, ...rest } = h as T & Pick<CheckedHeads, 'before'>;
  return (before === undefined ? rest : { ...rest, before }) as T;
};

/**
 * **WHAT A WRITE OF CHECKED HEADS LEAVES KEPT**, weighed against the store as it stands in the same write: never a start
 * in place of a check from the company's first batch (`'nothing'`), and for the same start never an older latest head
 * than the one kept, which another read on this device checked meanwhile - then only the heads before the start the
 * write found are added (`runs`) - unless a recovery moved the write back from that very head (`gaveUp`).
 * Otherwise the write is kept whole, with the heads before the start both kept for the same start (`whole`); what
 * it gave up is never kept.
 */
const keptOver = (was: KeptNow | null, given: CheckedHeads):
  'nothing' | { readonly runs: readonly HeadsBeforeStart[] | undefined } | { readonly whole: CheckedHeads } => {
  const { gaveUp, ...h } = given;
  if (was === null) return { whole: h };
  const fromTheFirst = (x: Pick<CheckedHeads, 'base' | 'from'>) => x.from === undefined && (x.base ?? 0) === 0;
  if (fromTheFirst(was) && was.fromZero !== null && !fromTheFirst(h)) return 'nothing';
  if (startOf(was) !== startOf(h)) return { whole: h };
  const runs = runsMerged(was.before, h.before);
  const movedBack = gaveUp !== undefined && gaveUp.head === was.latest.head;
  /* A write whose heads do not hold the kept latest came from a read that never checked it: an older one, or one begun before a recovery. */
  const checkedIt = h.heads.includes(was.latest.head);
  return !movedBack && (was.latest.seq > h.latest.seq || !checkedIt) ? { runs } : { whole: withRuns(h, runs) };
};
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
  const windows = new Map<string, KeptRecoveryWindow>();
  const unnamed = new Map<string, string>();
  return {
    unnamed: {
      lookedIn: async (company, notes) => notes.map((note) => unnamed.get(`${company}|${note}`) ?? null),
      keep: async (company, notes, lookedIn) => { for (const note of notes) unnamed.set(`${company}|${note}`, lookedIn); },
    },
    windows: {
      read: async (company) => windows.get(company) ?? null,
      write: async (company, k) => { windows.set(company, k); },
    },
    changes: {
      keep: async (company, k) => { changes.set(company, inOrder([...(changes.get(company) ?? []).filter((x) => x.signedAt !== k.signedAt), k])); },
      all: async (company) => changes.get(company) ?? [],
      letGo: async (company, v) => { changes.set(company, (changes.get(company) ?? []).filter((x) => x.signedAt !== v)); },
    },
    checked: {
      read: async (company) => heads.get(company) ?? null,
      write: async (company, h) => {
        const was = heads.get(company) ?? null;
        const kept = keptOver(was, h);
        if (kept !== 'nothing') heads.set(company, 'whole' in kept ? kept.whole : withRuns(was!, kept.runs));
      },
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
  readonly windows: RecoveryWindowsKeptStore;
  readonly unnamed: UnnamedNotesKeptStore;
}

const DATABASE = 'record-tree-kept';
const HEADS = 'checked-heads';
const LATEST = 'checked-latest';
const HEADERS = 'kept-headers';
const CHANGES = 'kept-directory-changes';
const WINDOWS = 'kept-recovery-windows';
const UNNAMED = 'kept-unnamed-notes';
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
    const req = f.open(DATABASE, 4);
    req.onupgradeneeded = () => {
      for (const s of [HEADS, LATEST, HEADERS, CHANGES, WINDOWS, UNNAMED]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
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
  /** Heads are kept a chunk to a row, so a row's size is bounded and only the chunks holding new heads are written again. */
  const CHUNK = 1024;
  const chunkKey = (company: string, i: number) => `${company}|${pad(i)}`;
  const checked: CheckedHeadsStore = {
    read: async (company) => {
      try {
        return await step<CheckedHeads | null>([HEADS, LATEST], 'readonly', (tx, done) => {
          const latest = tx.objectStore(LATEST).get(company);
          latest.onsuccess = () => {
            const l = latest.result as { latest?: unknown; fromZero?: unknown; count?: unknown; base?: unknown; from?: unknown; recent?: unknown; before?: unknown } | undefined;
            if (l === undefined || !isCheckedHead(l.latest) || !(l.fromZero === null || isCheckedHead(l.fromZero)) || !Number.isSafeInteger(l.count)
              || !(l.base === undefined || (Number.isSafeInteger(l.base) && (l.base as number) >= 0)) || !(l.from === undefined || isStartedFrom(l.from))) {
              done(null);
              return;
            }
            /* Heads kept whole that are not each a head checked are dropped, never believed: the read then follows no recovery from them. */
            const recent = Array.isArray(l.recent) && l.recent.length <= RECENT_KEPT && l.recent.every(isCheckedHead) ? l.recent as CheckedHead[] : undefined;
            /* Heads before the start kept otherwise than whole are dropped, never believed: the read then finds them again. */
            const before = Array.isArray(l.before) && l.before.length <= BEFORE_KEPT && l.before.every(isHeadsBeforeStart) ? l.before as HeadsBeforeStart[] : undefined;
            const started = {
              ...(l.base === undefined ? {} : { base: l.base as number }), ...(l.from === undefined ? {} : { from: l.from as StartedFrom }),
              ...(recent === undefined ? {} : { recent }), ...(before === undefined ? {} : { before }),
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
    write: async (company, given) => {
      try {
        await step<void>([HEADS, LATEST], 'readwrite', (tx, done) => {
          const was = tx.objectStore(LATEST).get(company);
          was.onsuccess = () => {
            /* Weighed against the store as it stands in this transaction, so a read that began before another wrote cannot write it back. */
            const row = was.result as (Partial<KeptNow> & { count?: unknown }) | undefined;
            const now: KeptNow | null = row === undefined || !isCheckedHead(row.latest) ? null : {
              latest: row.latest, fromZero: isCheckedHead(row.fromZero) ? row.fromZero : null,
              ...(Number.isSafeInteger(row.base) ? { base: row.base as number } : {}), ...(row.from === undefined ? {} : { from: row.from }),
              ...(Array.isArray(row.before) && row.before.every(isHeadsBeforeStart) ? { before: row.before } : {}),
            };
            const kept = keptOver(now, given);
            if (kept === 'nothing') { done(undefined); return; }
            if (!('whole' in kept)) { tx.objectStore(LATEST).put(withRuns(row!, kept.runs), company); done(undefined); return; }
            const h = kept.whole;
            const count = Number.isSafeInteger(row?.count) ? row!.count as number : 0;
            /*
             * Only the chunks from the one holding the first head not kept yet are written, or from the one holding the
             * last head where a recovery moved the heads back and that head took the place of one kept; every chunk before
             * them is kept as it is - unless the heads now start from another seq (a check from the first batch in place of
             * one from a later head), when all are. Rows past the heads' count are never read back.
             */
            const sameStart = (Number.isSafeInteger(row?.base) ? row!.base as number : 0) === (h.base ?? 0);
            for (let i = sameStart ? Math.floor(Math.max(0, Math.min(count, h.heads.length - 1)) / CHUNK) : 0; i * CHUNK < h.heads.length; i += 1) {
              tx.objectStore(HEADS).put(h.heads.slice(i * CHUNK, (i + 1) * CHUNK), chunkKey(company, i));
            }
            tx.objectStore(LATEST).put({
              latest: h.latest, fromZero: h.fromZero, count: h.heads.length,
              ...(h.base === undefined ? {} : { base: h.base }), ...(h.from === undefined ? {} : { from: h.from }),
              ...(h.recent === undefined ? {} : { recent: h.recent }), ...(h.before === undefined ? {} : { before: h.before }),
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
  const windows: RecoveryWindowsKeptStore = {
    read: async (company) => {
      try {
        return keptWindowOf(await step<unknown>([WINDOWS], 'readonly', (tx, done) => {
          const r = tx.objectStore(WINDOWS).get(company);
          r.onsuccess = () => done(r.result);
        }));
      } catch { return null; /* nothing read is nothing kept: a recovery then holds the longest window the range allows */ }
    },
    write: async (company, k) => {
      try {
        await step<void>([WINDOWS], 'readwrite', (tx, done) => { tx.objectStore(WINDOWS).put(structuredClone(k), company); done(undefined); });
      } catch { /* not kept: the window kept before stays, and a recovery from another head holds the longest window the range allows */ }
    },
  };
  const unnamed: UnnamedNotesKeptStore = {
    lookedIn: async (company, notes) => {
      try {
        return await step<readonly (string | null)[]>([UNNAMED], 'readonly', (tx, done) => {
          const found: (string | null)[] = notes.map(() => null);
          notes.forEach((note, i) => {
            const r = tx.objectStore(UNNAMED).get(`${company}|${note}`);
            r.onsuccess = () => { found[i] = typeof r.result === 'string' ? r.result : null; };
          });
          done(found);
        });
      } catch { return notes.map(() => null); /* nothing read is nothing kept: every note is looked for again */ }
    },
    keep: async (company, notes, lookedIn) => {
      try {
        await step<void>([UNNAMED], 'readwrite', (tx, done) => {
          for (const note of notes) tx.objectStore(UNNAMED).put(lookedIn, `${company}|${note}`);
          done(undefined);
        });
      } catch { /* not kept: the notes are looked for again at the next read */ }
    },
  };
  return { checked, headers, changes, windows, unnamed };
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

/**
 * **A REPLAY OF A COMPANY'S DIRECTORY KEPT IN MEMORY**, under what it was replayed
 * from: `judged`, a digest of the judge's inputs (the company, its label and
 * account, its founding seat and every key this device opened entries with);
 * and `marks`, one per version replayed, naming that filing's digest, who held
 * the account as it was judged, and the leaf this device worked out for an
 * entry's opening. A replay that differs in any of them is never answered
 * from it.
 */
export interface KeptReplay {
  readonly judged: string;
  readonly marks: readonly string[];
  readonly state: DirectoryReplayKept;
}

/** Where a page keeps replays of each company's directory, a few per company, the most recently used first. */
export interface DirectoryReplaysKept {
  /** The kept replay going furthest whose `judged` is this one and whose marks begin `marks`, or null. */
  longest(company: string, judged: string, marks: readonly string[]): KeptReplay | null;
  /** Keeps a replay, in place of one kept under the same judge's inputs and marks. */
  keep(company: string, kept: KeptReplay): void;
}

/** How many replays a page keeps of one company's directory: each reader of it, before and after its records are read. */
const REPLAYS_KEPT = 4;

/**
 * **REPLAYS OF EACH COMPANY'S DIRECTORY KEPT IN THIS PAGE'S MEMORY**, never on
 * disk: a page loaded again replays the whole directory once. At most
 * `REPLAYS_KEPT` per company; the one used least recently goes first.
 */
export const directoryReplaysInMemory = (): DirectoryReplaysKept => {
  const kept = new Map<string, KeptReplay[]>();
  const begins = (marks: readonly string[], k: KeptReplay): boolean =>
    k.marks.length <= marks.length && k.marks.every((m, i) => m === marks[i]);
  return {
    longest: (company, judged, marks) => {
      const all = kept.get(company) ?? [];
      let best: KeptReplay | null = null;
      for (const k of all) if (k.judged === judged && begins(marks, k) && (best === null || k.marks.length > best.marks.length)) best = k;
      if (best !== null) kept.set(company, [best, ...all.filter((k) => k !== best)]);
      return best;
    },
    keep: (company, k) => {
      const others = (kept.get(company) ?? []).filter((x) => x.judged !== k.judged || x.marks.length !== k.marks.length || !begins(k.marks, x));
      kept.set(company, [k, ...others].slice(0, REPLAYS_KEPT));
    },
  };
};
