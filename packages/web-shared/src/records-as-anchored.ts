/**
 * **THE COMPANY'S RECORDS AS ANCHORED, IN THE TERMS EVERY READ AND ANCHOR
 * SHARES**: what one read of them gives (`ReadHere`), the head the account
 * holds, which seat signed a batch already anchored, what this device keeps
 * once a header is checked, and the refusal said when nothing was anchored.
 */
import type { Hex } from '../../../src/core/crypto.js';
import {
  boundaryKeyOfEntry,
  EMPTY_HEAD,
  filedKindOfEntry,
  WITNESSED_AS,
  type DirectoryAsAnchored,
  type ManifestEntryBody
} from '../../../src/midnight/record-manifest.js';
import type { CheckedHead } from '../../../src/midnight/record-tree.js';
import { mayFile, mayFileTheRecord } from '../../../src/midnight/seat-directory.js';
import type { AnchorLanded, AnchorsOnChain } from './governed-call-builder.js';
import { RECENT_KEPT, type CheckedHeads } from './tree-kept-here.js';
import type { DirectoryBelieved, HeldAsAnchored, RecordsHeldHere } from './vault-page-doors.js';

/** Thrown when this device anchored nothing; the reason, and what resolves it, are in the message. */
export class AnchorNotMade extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`the company's records were not anchored: ${why}.`, options);
    this.name = 'AnchorNotMade';
  }
}

/**
 * **WHICH SEAT SIGNED A BATCH ALREADY ANCHORED, OR AN ENTRY IN IT, BY THE
 * DIRECTORY AS IT WAS ANCHORED WITH THAT BATCH.** The directory this device
 * was served is replayed up to the version anchored with the batch, and every
 * version of it must be the bytes the anchor holds for that version. The seat
 * holding the key is then judged by the role it held and whether it had
 * retired, at that version: what a seat may file is `mayFileTheRecord`'s. The chain's
 * own check when the batch landed is only that a signer sent the call; nothing
 * on chain ties the header's filing key to that signer. Each version of that
 * directory is counted against who held the account as the batch that first
 * anchored it named them and its call checked them (`held`). Nothing of who
 * holds the account now, or of the seat's role now, enters into it.
 */
export const seatAsAnchoredHere = (
  here: DirectoryBelieved,
  asAnchored: DirectoryAsAnchored,
  publicKey: Hex,
  entry?: ManifestEntryBody,
  held?: HeldAsAnchored
): string | null => {
  const then = here.at(asAnchored.version, held);
  if (then === null) return null;
  for (const [version, digest] of asAnchored.digests) {
    if (version <= asAnchored.version && then.digests[version - 1] !== digest) return null;
  }
  const seat = then.dir.seats.find((x) => x.signingKey === publicKey.toLowerCase());
  if (seat === undefined) return null;
  const may = mayFile(seat);
  if (entry === undefined) return seat.retired === null && may.includes(WITNESSED_AS) ? seat.seat : null;
  if (!mayFileTheRecord(seat, filedKindOfEntry(entry), boundaryKeyOfEntry(entry))) return null;
  if (seat.retired === null) return seat.seat;
  const last = seat.retired[boundaryKeyOfEntry(entry)];
  return last !== undefined && entry.version <= last ? seat.seat : null;
};

/** What one read gave: every anchor call that landed and who holds the account now, and the company's records as the head the last of them left holds them. */
export interface ReadHere {
  readonly landed: readonly AnchorLanded[];
  readonly now: AnchorsOnChain;
  /** The directory this read believed, and who holds the account as the person's own wallet read it. */
  readonly here: DirectoryBelieved;
  readonly records: RecordsHeldHere;
  /** Every entry the service gave as not yet anchored at the root checked, well formed, by id. */
  readonly pending: ReadonlySet<Hex>;
}

/** The head the account holds, as its history read here holds it: the head the last anchor call left, or the empty head. */
export const headOn = (landed: readonly AnchorLanded[]): Hex =>
  landed.length === 0 ? EMPTY_HEAD : (landed[landed.length - 1]!.head.toLowerCase() as Hex);

/**
 * What this device keeps once a header is checked: the head, every head before it from the first when it checked from
 * there, and the heads before its start it found. A head it had not checked, at or below its latest's seq, is where a
 * recovery moved it back to: it carries on from there, its heads become those below that seq and then that head, and
 * the write says the latest it gave up (`gaveUp`). A head it checked before, walked again from the first batch, leaves
 * the latest where it was.
 */
export const keptAfter = (kept: CheckedHeads | null, c: CheckedHead, fromZero: boolean): CheckedHeads => {
  const checkedBefore = kept?.heads.includes(c.head) ?? false;
  const gaveUp = kept !== null && !checkedBefore && c.seq <= kept.latest.seq ? kept.latest : undefined;
  /* Heads stay in seq order from `base` on the chain's line: a recovery's head takes the place of the heads it gave up. */
  const below =
    kept === null ? [] : gaveUp === undefined ? kept.heads : kept.heads.slice(0, Math.max(0, c.seq - (kept.base ?? 0)));
  const heads = kept !== null && checkedBefore ? kept.heads : [...below, c.head];
  /* The heads checked last, whole, oldest first: a recovery resuming from one before the latest gives up what came after it. */
  const recent = [...(kept?.recent ?? []).filter((r) => r.seq < c.seq), c].slice(-RECENT_KEPT);
  return {
    ...(kept?.base === undefined ? {} : { base: kept.base }),
    ...(kept?.from === undefined ? {} : { from: kept.from }),
    ...(kept?.before === undefined ? {} : { before: kept.before }),
    latest: kept !== null && kept.latest.seq > c.seq && checkedBefore ? kept.latest : c,
    fromZero: fromZero ? c : (kept?.fromZero ?? null),
    heads,
    recent,
    ...(gaveUp === undefined ? {} : { gaveUp })
  };
};
