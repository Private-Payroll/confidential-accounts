/**
 * **EVERY HEADER FROM THE LAST HEAD THIS DEVICE CHECKED TO THE HEAD ON CHAIN,
 * CHECKED HERE** (`checkForward`): each judged by the company's directory as
 * anchored with it, a header the service did not give filed again from what
 * this device kept, and the stop, when there is one, said with who moved the
 * anchor past it.
 */
import type { Hex } from '../../../src/core/crypto.js';
import {
  ENTRIES_AT_ONCE,
  entryIdOf,
  manifestEntryRefusal,
  type ManifestEntry,
  type ManifestEntryBody
} from '../../../src/midnight/record-manifest.js';
import {
  checkForward,
  headStepOf,
  leafHashOf,
  treeHeaderReadable,
  treeLeafRefusal,
  type CheckedHead,
  type HeadStep,
  type TreeHeader,
  type TreeLeaf
} from '../../../src/midnight/record-tree.js';
import type { AnchorLanded } from './governed-call-builder.js';
import type { DirectoryAsAnchoredHere, HeadsHere, HeldDoors, SeatsHere } from './held-heads-here.js';
import type { StartHere } from './records-held-here.js';
import { AnchorNotMade, keptAfter, seatAsAnchoredHere } from './records-as-anchored.js';
import { keptWith, type CheckedHeads } from './tree-kept-here.js';
import type { DirectoryBelieved, HeldAsAnchored } from './vault-page-doors.js';

/** Which seat held a key as anchored, and the first directory version the service served short of what the headers anchor. */
export const seatOfAsAnchored = (
  here: DirectoryBelieved,
  anchored: Pick<DirectoryAsAnchoredHere, 'dirAt' | 'accountHeldOf'>
) => {
  const { dirAt, accountHeldOf } = anchored;
  /** The first directory version a header on the chain's path anchors that the service did not serve, or served as other bytes. */
  let servedShort: { readonly version: number; readonly without: boolean } | undefined;
  /** Which seat held a key, by the directory as anchored at `dirVersion` - each version counted against who held the account as it was anchored. */
  const seatOf = (
    publicKey: Hex,
    entry: ManifestEntryBody | undefined,
    dirVersion: number,
    header: TreeHeader
  ): string | null | undefined => {
    const inHeader = new Map(
      header.changes.filter((c) => c.leaf.store === 'directory').map((c) => [c.leaf.version, c.leaf])
    );
    /* Every version anchored up to `dirVersion` is in `dirAt` or this header; one in neither was passed over, never entered. */
    const digests = new Map<number, Hex>();
    for (let v = 1; v <= dirVersion; v += 1) {
      const d = dirAt.get(v)?.digest ?? inHeader.get(v)?.digest;
      if (d !== undefined) digests.set(v, d);
    }
    const asAnchoredHere: HeldAsAnchored = (v) => {
      const d = dirAt.get(v) ?? (inHeader.has(v) ? { held: header.held, batch: header.seq } : undefined);
      if (d !== undefined) return accountHeldOf(d);
      /* A version the anchor passed over was never entered: its change is not applied. */
      return v <= dirVersion ? null : undefined;
    };
    const then = here.at(dirVersion, asAnchoredHere);
    if (then === null) {
      /* The first version not served: the directory served is replayed to one version per filing, so it is the one after its own. */
      servedShort ??= { version: here.dir.version + 1, without: true };
      return undefined;
    }
    const other = [...digests].find(([v, d]) => then.digests[v - 1] !== d);
    if (other !== undefined) {
      servedShort ??= { version: other[0], without: false };
      return undefined;
    }
    return seatAsAnchoredHere(here, { version: dirVersion, digests }, publicKey, entry, asAnchoredHere);
  };
  return { seatOf, servedShort: () => servedShort };
};

/** What checking forward is given: the read's doors and chain, where it starts from, and what it keeps as it checks. */
interface ForwardFrom {
  readonly doors: HeldDoors;
  readonly landed: readonly AnchorLanded[];
  readonly head: Hex;
  readonly here: DirectoryBelieved;
  readonly kept: CheckedHeads | null;
  readonly chosen: StartHere | null;
  readonly heads: HeadsHere;
  readonly seats: SeatsHere;
  readonly anchored: DirectoryAsAnchoredHere;
  readonly seatOf: ReturnType<typeof seatOfAsAnchored>['seatOf'];
}

/**
 * The head the account's functions make from each header, made for every header of a page in one call as the page is
 * given, and kept for the check that asks for them: the check asks only for a head no page gave.
 */
const headsByPage = (doors: Pick<HeldDoors, 'builder'>) => {
  const kept = new Map<string, Hex>();
  const keyOf = (s: HeadStep): string => `${s.previous.toLowerCase()}${s.batch.toLowerCase()}`;
  const made = async (steps: readonly HeadStep[]): Promise<void> => {
    const asked = [...new Map(steps.filter((s) => !kept.has(keyOf(s))).map((s) => [keyOf(s), s])).values()];
    if (asked.length === 0) return;
    const a = await doors.builder.anchorHeads({ after: asked });
    if (!Array.isArray(a?.after) || a.after.length !== asked.length) {
      throw new AnchorNotMade("this device could not read the anchor's heads. Reload the page");
    }
    if (a.after.some((h) => typeof h !== 'string'))
      throw new AnchorNotMade("the anchor's heads were not read for every batch. Reload the page");
    asked.forEach((s, i) => kept.set(keyOf(s), a.after[i] as Hex));
  };
  return {
    pageGiven: (headers: readonly TreeHeader[]): Promise<void> => made(headers.map(headStepOf)),
    headsOf: async (steps: readonly HeadStep[]): Promise<readonly Hex[]> => {
      await made(steps);
      return steps.map((s) => kept.get(keyOf(s))!);
    }
  };
};

/** The check from any head, and what it gathers as it goes: the first header, the last checked, what the pages gave. */
const forwardFromHere = async (w: ForwardFrom) => {
  const { doors, landed, head, here, chosen, seatOf } = w;
  const { headsBySeq } = w.heads;
  const { readSeats } = w.seats;
  const { dirAt } = w.anchored;
  const company = doors.accountId;
  let kept = w.kept;
  let first: TreeHeader | undefined;
  let fromZero = kept === null;
  /* What the pages gave beside their headers: what the last header checked is kept with. */
  const givenEntries = new Map<Hex, ManifestEntry>();
  const givenLeaves = new Map<Hex, TreeLeaf>();
  let lastChecked: TreeHeader | undefined;
  /*
   * Which seat each tag is, read only when the chain holds a head to map: a
   * seat whose entry this device did not believe leaves its tag unmapped, and
   * the check goes on without it.
   */
  const tagged =
    doors.tagSeats === undefined || landed.length === 0
      ? undefined
      : await doors.tagSeats(here).catch(() => {
          /* Unread: the check goes on with no tag mapped. */
          return undefined;
        });
  /* A head this device checked before the one it checks from, whole: what a recovery the quorum approved may resume from. */
  const earlier = (h: Hex): CheckedHead | undefined => kept?.recent?.find((r) => r.head === h.toLowerCase());
  const made = headsByPage(doors);
  const forwardFrom = (start: CheckedHead) =>
    checkForward({
      company,
      from: start,
      landed: new Set(landed.map((l) => l.head.toLowerCase() as Hex)),
      chainHead: head,
      ...(kept?.recent === undefined || kept.recent.length === 0 ? {} : { earlier, earliestSeq: kept.recent[0]!.seq }),
      ...(tagged === undefined ? {} : { tagSeat: (t: Hex) => tagged.get(t.toLowerCase()) }),
      headersAfter: async (seq, limit) => {
        const page = await doors.tree.headersAfter(company, seq, limit);
        await made.pageGiven((page.headers ?? []).filter((h): h is TreeHeader => treeHeaderReadable(h) && h.seq > seq));
        for (const e of page.entries ?? [])
          if (manifestEntryRefusal(company, e) === null)
            givenEntries.set(entryIdOf(e as ManifestEntry), e as ManifestEntry);
        for (const l of page.leaves ?? [])
          if (treeLeafRefusal(l) === null) givenLeaves.set(leafHashOf(l as TreeLeaf), l as TreeLeaf);
        return page;
      },
      headsOf: made.headsOf,
      seatOf,
      confirmed: async (path) => {
        for (const s of path) headsBySeq.set(s.header.seq, s.head);
        await readSeats(path.map((s) => s.header.held));
      },
      keep: async (c, header) => {
        for (const ch of header.changes) {
          if (ch.leaf.store === 'directory')
            dirAt.set(ch.leaf.version, { digest: ch.leaf.digest, batch: header.seq, held: header.held });
        }
        if (header.seq === 0) first = header;
        for (const ch of header.changes) if (ch.prior !== null) givenLeaves.set(leafHashOf(ch.prior), ch.prior);
        lastChecked = header;
        kept = keptAfter(kept, c, fromZero);
        /* From a start this device chose, nothing is kept until the read holds what it must (below). */
        if (chosen === null) await doors.checked?.write(company, kept);
      }
    });
  return {
    forwardFrom,
    tagged,
    givenEntries,
    givenLeaves,
    read: () => ({ kept, first, lastChecked }),
    fromZeroNoMore: () => {
      fromZero = false;
    }
  };
};

/** **THE CHECK ITSELF**, from `from` to the head on chain, and what it reached, where it stopped, and what it kept. */
export async function checkedForwardHere(w: ForwardFrom, from: CheckedHead) {
  const { doors, landed } = w;
  const company = doors.accountId;
  const f = await forwardFromHere(w);
  const { forwardFrom, tagged, givenEntries, givenLeaves } = f;
  let forward = await forwardFrom(from);
  /*
   * **A HEADER THE SERVICE DID NOT GIVE, FILED AGAIN FROM THIS DEVICE**: where the
   * check stops `not-given` at a batch this device kept a header of - one it
   * signed, or the last it checked - it files that header again with its entries
   * in one request, the header judged by its own signature and each entry by the
   * header naming it - so an entry whose record's bytes the service lost is kept
   * again and that record read as withheld, never a header every device stops
   * at - and checks on from where it stopped. Whether it is the one the chain
   * holds is the check's, as for any header.
   */
  if (forward.stop?.stop === 'not-given' && doors.headers !== undefined) {
    const keptAt = await doors.headers.at(company, forward.stop.seq);
    for (const k of keptAt) {
      /* A repair: through the view it is sent without the check and never ends it; refused, the check says so. */
      if (doors.tree.refileHeader !== undefined)
        await doors.tree.refileHeader(company, k.header, k.entries.slice(0, ENTRIES_AT_ONCE));
      else
        try {
          await doors.tree.fileHeader(company, k.header, k.entries.slice(0, ENTRIES_AT_ONCE));
        } catch {
          /* the service would not keep it: the check says */
        }
    }
    if (keptAt.length > 0) forward = await forwardFrom(forward.reached);
  }
  f.fromZeroNoMore();
  const { reached } = forward;
  /*
   * A head no header was given for is said as the quorum's recovery where one moved the anchor on after the head reached
   * - the batches this device cannot follow were given up, not withheld - and otherwise with the seat that moved the
   * anchor past it, where its tag maps to one: the block's last anchoring seat, said so where the block held several.
   */
  const stop =
    forward.stop?.stop !== 'not-given'
      ? forward.stop
      : (() => {
          const after = landed.slice(landed.findIndex((l) => l.head.toLowerCase() === reached.head) + 1);
          if (after.some((l) => l.recovered === true)) return { ...forward.stop, recovery: true as const };
          const next = after[0];
          const by = next?.tag === undefined ? undefined : tagged?.get(next.tag.toLowerCase());
          if (by === undefined) return forward.stop;
          return {
            ...forward.stop,
            movedBy: by,
            ...((next!.anchorsInBlock ?? 1) > 1 ? { anchorsInBlock: next!.anchorsInBlock } : {})
          };
        })();
  const { kept, first, lastChecked } = f.read();
  /* The last header this device checked, kept with what checking it needs, so this device can file it again. */
  if (lastChecked !== undefined) {
    await doors.headers?.checked(
      company,
      keptWith(
        lastChecked,
        (id) => givenEntries.get(id),
        (h) => givenLeaves.get(h)
      )
    );
  }
  return { forward, reached, stop, kept, first };
}
