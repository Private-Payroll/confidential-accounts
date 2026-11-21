/**
 * **WHAT THE ANCHORED HISTORY SAYS AT EACH BATCH, READ ON THIS DEVICE**: the
 * head each batch left, the seats each header's holders name, and the
 * company's directory as anchored, version by version. One read of the
 * company's records (`recordsHeldHere`) builds each once and asks it as it
 * checks.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { EMPTY_HEAD, type BatchHolders } from '../../../src/midnight/record-manifest.js';
import {
  HEADERS_AT_ONCE, headStepOf, leafHashOf, provenRefusal, treeHeaderReadable, treeLeafRefusal, type TreeHeader, type TreeLeaf,
} from '../../../src/midnight/record-tree.js';
import { DIRECTORY, directoryVersionsOf, type DirectoryVersionHeld } from '../../../src/midnight/records-held.js';
import type { AccountHeld } from '../../../src/midnight/seat-directory.js';
import type { AnchorLanded } from './governed-call-builder.js';
import type { AnchorDoors } from './records-anchored-here.js';
import { AnchorNotMade } from './records-as-anchored.js';
import { BEFORE_KEPT, type CheckedHeads, type HeadsBeforeStart } from './tree-kept-here.js';

/** What reading the company's records asks of this device. */
export type HeldDoors = Pick<AnchorDoors, 'accountId' | 'directory' | 'builder' | 'onChain' | 'tree' | 'checked' | 'headers'> & Partial<Pick<AnchorDoors, 'manifest' | 'vouching' | 'tagSeats' | 'leaving'>>;

/** A holders list as one key, so the seats it names are read once. */
export const heldKey = (h: BatchHolders): string => `${h.approvals}|${h.signerRoot}|${h.signers.join(',')}`;

export const ROOT_NOT_KEPT = 'the service keeps no header that makes the root this device checked, so nothing can be read against it. Reload '
  + 'the page; if it happens again, the service is withholding the company\'s records';
export const NOT_PROVEN = 'the leaves the service gave do not prove into the root the anchor on chain holds, or an older version of one was '
  + 'not given. Reload the page; if it happens again, the service is changing the company\'s records';

/** The older leaves a service gave, by their hash. */
export const olderOf = (given: readonly unknown[]): ((hash: Hex) => TreeLeaf | undefined) => {
  const by = new Map<Hex, TreeLeaf>();
  for (const l of given) if (treeLeafRefusal(l) === null) by.set(leafHashOf(l as TreeLeaf), l as TreeLeaf);
  return (hash) => by.get(hash);
};

/** Who held the account as each batch was anchored: the seats a header's holders name, read once for each holders list. */
export const seatsHere = (doors: Pick<HeldDoors, 'builder'>) => {
  const seatsByHeld = new Map<string, readonly string[] | null>();
  const readSeats = async (helds: readonly BatchHolders[]): Promise<void> => {
    const missing = [...new Map(helds.filter((h) => !seatsByHeld.has(heldKey(h))).map((h) => [heldKey(h), h])).values()];
    if (missing.length === 0) return;
    const a = await doors.builder.anchorHeads({ after: [], holders: missing });
    if (!Array.isArray(a?.holderSeats) || a.holderSeats.length !== missing.length) {
      throw new AnchorNotMade('this device could not read which seats the company\'s headers name. Reload the page');
    }
    missing.forEach((h, i) => seatsByHeld.set(heldKey(h), a.holderSeats[i] ?? null));
  };
  return { seatsByHeld, readSeats };
};

/** The headers read so far before this device's start, each with the head the account's functions make from it, by seq. */
interface HeadersRead {
  readonly bySeq: Map<number, { readonly header: TreeHeader; readonly head: Hex }[]>;
  /** The highest seq read: every header at a lower seq has been given. */
  upTo: number;
  /** Whether the service gave every header there is up to the start. */
  ended: boolean;
}

/** Reads the next page of headers after those read, never past `base`, and makes every one's head in one call. */
const nextPageRead = async (doors: Pick<HeldDoors, 'accountId' | 'tree' | 'builder'>, read: HeadersRead, base: number): Promise<void> => {
  const page = await doors.tree.headersAfter(doors.accountId, read.upTo, Math.min(HEADERS_AT_ONCE, base - read.upTo));
  const given = (page.headers ?? []).filter((h): h is TreeHeader => treeHeaderReadable(h) && h.seq > read.upTo && h.seq <= base);
  if (given.length === 0) { read.ended = true; return; }
  const a = await doors.builder.anchorHeads({ after: given.map(headStepOf) });
  given.forEach((h, i) => {
    const at = read.bySeq.get(h.seq) ?? [];
    read.bySeq.set(h.seq, [...at, { header: h, head: String(a?.after?.[i] ?? '').toLowerCase() as Hex }]);
  });
  read.upTo = Math.max(...given.map((h) => h.seq));
  if (read.upTo >= base) read.ended = true;
};

/**
 * Follows the headers read from batch `b` on: at `b` every header, after it only those whose previous head is one made
 * at the seq before. The first seq where a made head is one the history shows, or the one this device started from,
 * sets the head of every batch from `b` to there, and gives the run of heads set, tied to that head; null when a head
 * on the way was not made, so the run is not whole and is not kept. 'more' when the headers read so far end before
 * that, and 'none' when no header follows on.
 */
const chainFrom = (
  b: number, base: number, read: HeadersRead, landedBy: ReadonlyMap<string, AnchorLanded>, headsBySeq: Map<number, Hex>,
): HeadsBeforeStart | null | 'more' | 'none' => {
  const previousOf = new Map<number, Map<Hex, Hex>>();
  let heads = new Set<Hex>();
  for (let k = b; k <= base; k += 1) {
    const at = (read.bySeq.get(k) ?? []).filter((x) => k === b || heads.has(x.header.previous));
    if (at.length === 0) return k > read.upTo || (k === read.upTo && !read.ended) ? 'more' : 'none';
    const made = new Map<Hex, Hex>(at.map((x) => [x.head, x.header.previous]));
    previousOf.set(k, made);
    const shown = [...made.keys()].find((h) => landedBy.has(h) || h === headsBySeq.get(k));
    if (shown !== undefined) {
      const run: Hex[] = [];
      let h: Hex | undefined = shown;
      for (let j = k; j >= b && h !== undefined; j -= 1) { if (j < base) { headsBySeq.set(j, h); run.unshift(h); } h = previousOf.get(j)?.get(h); }
      /* Whole: one head for each batch from `b` to the tie, or to `base - 1` when the tie is at or past `base`. */
      return run.length === Math.min(k, base - 1) - b + 1 ? { from: b, heads: run, tied: { seq: k, head: shown } } : null;
    }
    if (k === read.upTo && !read.ended) return 'more';
    heads = new Set(made.keys());
  }
  return 'none';
};

/**
 * The runs of heads before the start this device kept that it still believes: a run tied to a head the account's
 * history shows now, or to the head this device started from or one it checked after it, or to a head a run it still
 * believes holds. A run tied to anything else is not believed, and the batches it holds are read again.
 */
const keptRunsStillTied = (
  kept: readonly HeadsBeforeStart[], landedBy: ReadonlyMap<string, AnchorLanded>, headsBySeq: ReadonlyMap<number, Hex>,
): HeadsBeforeStart[] => {
  const held = (r: HeadsBeforeStart, seq: number): Hex | undefined => (seq >= r.from && seq < r.from + r.heads.length ? r.heads[seq - r.from] : undefined);
  const believed: HeadsBeforeStart[] = [];
  for (let left = [...kept], grew = true; grew;) {
    grew = false;
    const tied = left.filter((r) => landedBy.has(r.tied.head) || headsBySeq.get(r.tied.seq) === r.tied.head
      || believed.some((o) => held(o, r.tied.seq) === r.tied.head));
    if (tied.length > 0) { believed.push(...tied); left = left.filter((r) => !tied.includes(r)); grew = true; }
  }
  return kept.filter((r) => believed.includes(r));
};

/** **THE HEAD EACH BATCH LEFT**, as this device checked it from where it started (`kept`), and what each head says. */
export const headsHere = (doors: Pick<HeldDoors, 'accountId' | 'tree' | 'builder'>, landed: readonly AnchorLanded[], kept: CheckedHeads | null) => {
  const landedBy = new Map(landed.map((l) => [l.head.toLowerCase(), l]));
  /* The batch this device started checking from: the heads before it are the ones read from the headers. */
  const base = kept?.base ?? 0;
  /* Every head this device checked, by the seq of the batch that left it. */
  const headsBySeq = new Map<number, Hex>((kept?.heads ?? []).map((h, i) => [base + i, h.toLowerCase() as Hex]));
  /* The runs before the start this device kept and still believes, and the ones found by this read. */
  const keptRuns = keptRunsStillTied(kept?.before ?? [], landedBy, headsBySeq);
  const found: HeadsBeforeStart[] = [];
  /**
   * The first head the account's history shows from the batch on: the block the batch's anchor landed in. Null for a
   * batch whose header no landed head follows, which was never anchored as shown.
   */
  const landedFrom = (batch: number): AnchorLanded | null => {
    for (let k = batch; headsBySeq.has(k); k += 1) {
      const l = landedBy.get(headsBySeq.get(k)!);
      if (l !== undefined) return l;
    }
    return null;
  };
  /*
   * **THE HEAD EACH BATCH BEFORE THIS DEVICE'S START LEFT**, for a directory
   * version one of them anchored: the committee after its block is read from the
   * account's history at that head. A header is taken only as the account's own
   * functions make a head the history shows from it, or the one this device
   * started from, through the headers after it. The headers from the lowest batch
   * asked are read in one pass, by page, with the heads of each page's headers
   * made in one call, until every batch asked is found or can be found no further.
   * A batch a kept run still believed holds is set from that run, from the batch to
   * the run's end, as the walk from it sets them, and its headers are not read.
   */
  const headsBefore = async (batches: readonly number[]): Promise<void> => {
    const asked = [...new Set(batches)].filter((b) => b < base && !headsBySeq.has(b)).sort((x, y) => x - y);
    for (const b of asked) {
      const run = headsBySeq.has(b) ? undefined : keptRuns.find((r) => b >= r.from && b < r.from + r.heads.length);
      if (run !== undefined) run.heads.slice(b - run.from).forEach((h, i) => headsBySeq.set(b + i, h));
    }
    const left = asked.filter((b) => !headsBySeq.has(b));
    if (left.length === 0) return;
    const read: HeadersRead = { bySeq: new Map(), upTo: left[0]! - 1, ended: false };
    for (;;) {
      const open = left.filter((b) => {
        if (headsBySeq.has(b)) return false;
        const walked = chainFrom(b, base, read, landedBy, headsBySeq);
        if (walked !== null && typeof walked === 'object') found.push(walked);
        return walked === 'more';
      });
      if (open.length === 0 || read.ended) return;
      await nextPageRead(doors, read, base);
    }
  };
  return {
    base, headsBySeq, landedFrom, headsBefore,
    /** What the device keeps of the heads before its start after this read: null when this read found none to add. */
    beforeToKeep: (): readonly HeadsBeforeStart[] | null => (found.length === 0 ? null : [...keptRuns, ...found].slice(-BEFORE_KEPT)),
    seqOfHead: (h: string) => {
      const asked = h.toLowerCase();
      if (asked === EMPTY_HEAD) return -1;
      for (const [seq, checked] of headsBySeq) if (checked === asked) return seq;
      return null;
    },
    newestLandedBy: (cutoff: number) => {
      let at = -1;
      for (let i = landed.length - 1; i >= 0 && at < 0; i -= 1) {
        const t = landed[i]!.at;
        if (Number.isSafeInteger(t) && t > 0 && t <= cutoff) at = i;
      }
      if (at < 0) return 'none';
      const wanted = landed[at]!.head.toLowerCase();
      for (const [seq, checked] of headsBySeq) if (checked === wanted) return { seq };
      /*
       * Not checked here. This device checked every head from where it started (`base`) to the one it reached, so a head
       * that landed before the start is older than any head a raise it can judge names; any other is past its check.
       */
      const started = landedFrom(base);
      return started !== null && at < landed.indexOf(started) ? 'none' : 'unread';
    },
  };
};

/** The seats and heads one read keeps: what the directory as anchored is counted against. */
export type SeatsHere = ReturnType<typeof seatsHere>;
export type HeadsHere = ReturnType<typeof headsHere>;

/** **THE COMPANY'S DIRECTORY AS ANCHORED**, version by version, and who held the account as each version was anchored. */
export const directoryAsAnchoredHere = (doors: Pick<HeldDoors, 'accountId' | 'tree'>, seats: SeatsHere, heads: HeadsHere) => {
  const company = doors.accountId;
  const { seatsByHeld, readSeats } = seats;
  const { landedFrom } = heads;
  /* The company's directory as anchored, version by version: what each header's seats are judged by. */
  const dirAt = new Map<number, DirectoryVersionHeld>();
  /*
   * Who held the account as a version was anchored: the approvals and seats its batch's header names, which the anchor
   * call checked, and the seat bar of the state the block that call landed in left. A bar that was not read is refused.
   */
  const accountHeldOf = (d: Pick<DirectoryVersionHeld, 'held' | 'batch'>): AccountHeld | null => {
    const seats = seatsByHeld.get(heldKey(d.held));
    const landedIn = landedFrom(d.batch);
    if (seats === undefined || seats === null || landedIn === null) return null;
    if (!Number.isSafeInteger(landedIn.seatBar) || landedIn.seatBar < 1) {
      throw new AnchorNotMade('this device could not read the approvals a change of who is seated needed as the company\'s records '
        + 'were anchored. Reload the page');
    }
    return { approvals: d.held.approvals, seats, seatBar: landedIn.seatBar };
  };
  const directoryOfLeaf = async (root: Hex): Promise<void> => {
    const given = await doors.tree.proofs(company, { root, records: [DIRECTORY], kinds: [] });
    if (given === null) throw new AnchorNotMade(ROOT_NOT_KEPT);
    const leaf = given.records[0] ?? null;
    if (provenRefusal(root, { records: [{ name: DIRECTORY, leaf }] }, given.proof) !== null) throw new AnchorNotMade(NOT_PROVEN);
    const versions = leaf === null ? new Map<number, DirectoryVersionHeld>() : directoryVersionsOf(leaf, olderOf(given.older));
    if (versions === null) throw new AnchorNotMade(NOT_PROVEN);
    for (const [v, d] of versions) dirAt.set(v, d);
    await readSeats([...versions.values()].map((d) => d.held));
  };
  return { dirAt, accountHeldOf, directoryOfLeaf };
};

export type DirectoryAsAnchoredHere = ReturnType<typeof directoryAsAnchoredHere>;
