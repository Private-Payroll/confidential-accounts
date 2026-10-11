/**
 * **WHAT ONE READ BELIEVES OF A COMPANY'S RECORDS: THE LEAVES THE HEAD ON CHAIN
 * PROVES FOR THE RECORDS AND KINDS IT ASKED, AND NOTHING ELSE.**
 *
 * A read names, before it reads, every record and every kind it will judge
 * (`RecordsAsked`). The device checks every header from the last head it
 * checked up to the head the chain holds (`checkForward`), then asks the
 * service, in one request, for those records' leaves - each with every older
 * version on its prior chain - and those kinds' every leaf, proven against the
 * root that head binds, and for the entries not yet anchored. What it holds is
 * this: per record asked, every version the tree holds, oldest first, with the
 * seat that entered it and the batch that anchored it; the entries newer than
 * those leaves, each signed by a seat that may file it now; and the company's
 * directory as anchored, version by version, with who held the account as each
 * was anchored.
 *
 * A record no read asked for is never believed (`not-asked`): a read cannot
 * believe what it never had proven. Pure: no key, no chain, no request.
 */
import type { Hex } from '../core/crypto.js';
import { FOUNDING_KEY_EPOCH, stateRecordId } from '../core/founding-state.js';
import { ROSTER_ID } from '../core/roster-record.js';
import {
  DIRECTORY_RECORD, recordKeyOf, type BatchHolders, type ManifestEntry, type RecordRead, type RecordStanding, type RecordStandingRead,
} from './record-manifest.js';
import { EVERY_VERSION_KEPT, ZERO, type CheckedHead, type KindAsked, type RecordName, type TransitionStop, type TreeHeader, type TreeLeaf } from './record-tree.js';

/** **WHAT ONE READ WILL JUDGE**, named before it reads: records, kinds asked whole, and whether it asks who founded the company. */
export interface RecordsAsked {
  readonly records?: readonly RecordName[];
  readonly kinds?: readonly KindAsked[];
  /** The company's first header and the records it was founded with (`FOUNDING_RECORDS`). */
  readonly founding?: boolean;
  /** Every entry not yet anchored, of any record: what an anchoring device builds its next header from. */
  readonly everyPending?: boolean;
}

/** The one record a company's directory is. */
export const DIRECTORY: RecordName = Object.freeze({ store: 'directory', kind: DIRECTORY_RECORD, id: DIRECTORY_RECORD });

/** The records a company is founded with: its first state and its roster. */
export const FOUNDING_RECORDS: readonly RecordName[] = Object.freeze([
  { store: 'company', kind: 'state', id: stateRecordId(FOUNDING_KEY_EPOCH) },
  { store: 'company', kind: 'roster', id: ROSTER_ID },
]);

/** The prefix every record of one store and kind shares under `recordKeyOf`. */
export const kindKeyOf = (k: KindAsked): string => recordKeyOf({ store: k.store, kind: k.kind, id: '' });

/** Every record a read asks to be proven: those it named, the directory always, and the founding records when it asks who founded the company. */
export const recordsProvenFor = (asked: RecordsAsked): RecordName[] => {
  const all = [DIRECTORY, ...(asked.records ?? []), ...(asked.founding === true ? FOUNDING_RECORDS : [])];
  return [...new Map(all.map((r) => [recordKeyOf(r), { store: r.store, kind: r.kind, id: r.id }])).values()];
};

/** One version of a record the tree holds: its digest, the key that entered it, the batch that anchored it and the directory then. */
export interface HeldVersion {
  readonly version: number;
  readonly digest: Hex;
  readonly filedBy: Hex;
  readonly batch: number;
  readonly dirVersion: number;
}

/** **ONE VERSION OF THE COMPANY'S DIRECTORY AS ANCHORED**: its digest, the batch that anchored it, and who held the account as that batch was judged. */
export interface DirectoryVersionHeld { readonly digest: Hex; readonly batch: number; readonly held: BatchHolders }

/** **WHAT ONE READ BELIEVES.** See the head of this file. */
export interface RecordsHeld {
  /** The head the chain holds, as the account's history at the wallet's indexer shows it. */
  readonly head: Hex;
  /** The last header this device checked: everything held is proven against its root. */
  readonly reached: CheckedHead;
  /** Null when every header up to the chain's head was checked; why not, otherwise. */
  readonly stopped: TransitionStop | null;
  /** What this read asked, by `recordKeyOf` and by `kindKeyOf`. */
  readonly asked: { readonly records: ReadonlySet<string>; readonly kinds: ReadonlySet<string> };
  /** Per record asked or in a kind asked, every version the tree holds at `reached`, oldest first. */
  readonly history: ReadonlyMap<string, readonly HeldVersion[]>;
  /** Entries of what was asked, newer than its leaf, each signed by a seat that may file it now, naming no older version's bytes, in filing order. */
  readonly notYetAnchored: readonly ManifestEntry[];
  /** Every version of the company's directory the tree holds at `reached`. */
  readonly directory: ReadonlyMap<number, DirectoryVersionHeld>;
  /** The company's first header, checked, when founding was asked and anything is anchored; null when nothing is; absent when not asked. */
  readonly first?: TreeHeader | null;
}

/** A record's versions, oldest first, from its newest leaf and the older leaves given; null when one on its prior chain is missing. */
export const versionsOf = (leaf: TreeLeaf, older: (hash: Hex) => TreeLeaf | undefined): HeldVersion[] | null => {
  const out: HeldVersion[] = [];
  for (let l: TreeLeaf | undefined = leaf; l !== undefined;) {
    out.unshift({ version: l.version, digest: l.digest, filedBy: l.filedBy.toLowerCase(), batch: l.batch, dirVersion: l.dirVersion });
    if (l.prior === ZERO) return out;
    l = older(l.prior);
    if (l === undefined) return null;
  }
  return out;
};

/**
 * **THE VERSIONS OF A RECORD THE ANCHOR PASSED OVER**, oldest first: in a store
 * whose every version is read back, each version below its newest anchored one
 * that no leaf on its prior chain holds. Each was filed and never entered - or
 * entered only after a later version was anchored - so it is never believed,
 * and a list of the record's versions says it is there rather than skipping it.
 * A run's versions only rise, since it is kept whole: it has none to say.
 */
export const neverEnteredIn = (held: Pick<RecordsHeld, 'history'>, r: Pick<RecordRead, 'store' | 'kind' | 'id'>): number[] => {
  if (!EVERY_VERSION_KEPT.has(r.store)) return [];
  const out: number[] = [];
  let next = 1;
  for (const v of held.history.get(recordKeyOf(r)) ?? []) {
    for (let k = next; k < v.version; k += 1) out.push(k);
    next = v.version + 1;
  }
  return out;
};

/** Whether `read` is a record this read asked for, by name or by its kind. */
export const askedFor = (held: Pick<RecordsHeld, 'asked'>, read: Pick<RecordRead, 'store' | 'kind' | 'id'>): boolean =>
  held.asked.records.has(recordKeyOf(read)) || held.asked.kinds.has(kindKeyOf(read));

/** What this read says of a record it did not ask for: nothing is believed. */
export type HeldStanding = RecordStanding | 'not-asked';

/** What one read says of a record read: its standing, the version whose entry names it, and the newest version entered. */
export interface HeldStandingRead extends Omit<RecordStandingRead, 'standing'> { readonly standing: HeldStanding }

/**
 * **THE ONE ANSWER TO "WHICH VERSION OF THIS RECORD IS THIS, AND IS IT
 * BELIEVED"**, against what one read holds. `filer` is the key the record's
 * own signature is under: a version counts for a record only when that same
 * key entered it. Anchored and older than the newest anchored are told apart;
 * bytes no version names at an anchored version are not the anchored bytes; a
 * version past a header this device could not check is past a stop; one newer
 * than every leaf is not yet anchored when a seat that may file it now entered
 * it, and not entered otherwise; one the anchor passed over is never entered,
 * whatever entry of it the service lists now.
 */
export const heldStandingOf = (held: RecordsHeld, read: RecordRead, filer?: Hex): HeldStandingRead => {
  if (!askedFor(held, read)) return { standing: 'not-asked', version: null, newest: 0 };
  const key = recordKeyOf(read);
  const by = filer?.toLowerCase();
  const versions = held.history.get(key) ?? [];
  const anchored = versions.length === 0 ? 0 : versions[versions.length - 1]!.version;
  const waiting = held.notYetAnchored.filter((e) => recordKeyOf(e) === key);
  const newest = Math.max(anchored, ...waiting.map((e) => e.version));
  const answer = (standing: HeldStanding, version: number | null): HeldStandingRead => ({ standing, version, newest });
  const hit = versions.find((x) => x.digest === read.digest && (read.version === undefined || x.version === read.version));
  if (hit !== undefined) {
    if (by !== undefined && hit.filedBy !== by) return answer('not-the-filers-entry', hit.version);
    return answer(hit.version < anchored ? 'older-than-anchored' : 'anchored', hit.version);
  }
  if (read.version !== undefined && neverEnteredIn(held, read).includes(read.version)) return answer('never-entered', null);
  if (anchored > 0 && read.version !== undefined && read.version <= anchored) {
    return answer(read.version < anchored ? 'older-than-anchored' : 'not-the-anchored-bytes', null);
  }
  if (held.stopped !== null) return answer('past-a-stop', null);
  const next = waiting.find((e) => e.digest === read.digest && (read.version === undefined || e.version === read.version));
  if (next === undefined) return answer('not-entered', null);
  if (by !== undefined && next.filedBy.publicKey.toLowerCase() !== by) return answer('not-the-filers-entry', next.version);
  return answer('not-yet-anchored', next.version);
};

/**
 * **EVERY RECORD OF ONE KIND THE COMPANY'S RECORDS NAME**, anchored or entered
 * and not yet anchored, by id. Throws for a kind this read did not ask whole:
 * a list is believed only as its kind's subtree was proven.
 */
export const namedIn = (held: RecordsHeld, kind: KindAsked): readonly string[] => {
  const prefix = kindKeyOf(kind);
  if (!held.asked.kinds.has(prefix)) throw new Error(`this read did not ask for every ${kind.store} record of kind ${kind.kind}, so it cannot list them`);
  const ids = new Set<string>();
  for (const key of held.history.keys()) if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  for (const e of held.notYetAnchored) if (e.store === kind.store && e.kind === kind.kind) ids.add(e.id);
  return [...ids];
};

/**
 * Every version of the company's directory, from its newest leaf and the older
 * leaves given, each with who held the account as the batch that anchored it
 * was judged; null when a leaf on its prior chain is missing or names no holders.
 */
export const directoryVersionsOf = (leaf: TreeLeaf, older: (hash: Hex) => TreeLeaf | undefined): Map<number, DirectoryVersionHeld> | null => {
  const out = new Map<number, DirectoryVersionHeld>();
  for (let l: TreeLeaf | undefined = leaf; l !== undefined;) {
    if (l.held === undefined) return null;
    out.set(l.version, { digest: l.digest, batch: l.batch, held: l.held });
    if (l.prior === ZERO) return out;
    l = older(l.prior);
    if (l === undefined) return null;
  }
  return out;
};

/** The newest version of a record the tree holds, as one read had it proven; 0 for none. */
export const newestAnchored = (held: Pick<RecordsHeld, 'history'>, r: Pick<RecordRead, 'store' | 'kind' | 'id'>): number => {
  const at = held.history.get(recordKeyOf(r));
  return at === undefined || at.length === 0 ? 0 : at[at.length - 1]!.version;
};
