/** Every header from a head this device checked to the head the chain holds, checked one against the one before it. */
import { type Hex } from '../core/crypto.js';
import { entryIdOf, manifestEntryRefusal, type BatchHolders, type ManifestEntry } from './record-manifest.js';
import { HEADERS_AT_ONCE, type TreeLeaf, leafHashOf, treeLeafRefusal } from './record-tree-leaves.js';
import { type CheckedHead, type TransitionInput, type TransitionStop, type TreeHeader, checkedAfter, transitionRefusal, treeBatchOf, treeHeaderReadable } from './record-tree-headers.js';

/* ------------------------------------------------------------------ checked forward */

/** One page of headers the service gives, with the entries their changes name and the older leaves their records' chains need. */
export interface HeadersPage {
  readonly headers: readonly unknown[];
  readonly entries: readonly unknown[];
  readonly leaves: readonly unknown[];
}

/**
 * One step of the account's head: the head before, a header's digest, who held
 * the account as it was judged, the tag of the seat that anchored it, and - for
 * a recovery - the head it resumes from.
 */
export interface HeadStep {
  readonly previous: Hex; readonly batch: Hex; readonly held: BatchHolders; readonly tag: Hex; readonly resumesFrom?: Hex;
}

/** **THE STEP OF THE ACCOUNT'S HEAD A HEADER MAKES**: the one way a header's head is asked of the account's own functions. */
export const headStepOf = (h: TreeHeader): HeadStep => ({
  previous: h.previous, batch: treeBatchOf(h), held: h.held, tag: h.tag,
  ...(h.kind === 'recovery' ? { resumesFrom: h.resumesFrom!.head } : {}),
});

export interface ForwardInput {
  readonly company: string;
  /** The head this device checked last; `GENESIS` to check from the company's first batch. */
  readonly from: CheckedHead;
  /** Every head the account's history shows (the last of each block), at the indexer the person's own wallet names. */
  readonly landed: ReadonlySet<Hex>;
  /** The head the account holds now. */
  readonly chainHead: Hex;
  /** Headers with a seq above `seq`, in seq order, at most about `limit`, with what they need. */
  readonly headersAfter: (seq: number, limit: number) => Promise<HeadersPage>;
  /** The head after each step, by the account's own functions. */
  readonly headsOf: (steps: readonly HeadStep[]) => Promise<readonly Hex[]>;
  readonly seatOf: TransitionInput['seatOf'];
  readonly tagSeat?: TransitionInput['tagSeat'];
  /** Keeps a head this device checked, with the header that made it, before the next is checked, so a check cut short carries on from it. */
  readonly keep: (checked: CheckedHead, header: TreeHeader) => Promise<void>;
  /**
   * A head this device checked before the one it checks from, by its head, or
   * undefined: a recovery resuming from one gives up the batches after it that
   * this device had checked, and the check goes on from it.
   */
  readonly earlier?: (head: Hex) => CheckedHead | undefined;
  /**
   * With `earlier`: the seq of the oldest such head. Where no header past the
   * head checked last is given, the headers after it are read once more, for
   * a recovery resuming from one of them.
   */
  readonly earliestSeq?: number;
  /**
   * Told, before any header of it is checked, each path of headers found to
   * reach a head the chain shows, with the head after each: what `seatOf`
   * needs of a directory version those headers anchor is read then.
   */
  readonly confirmed?: (path: readonly { readonly header: TreeHeader; readonly head: Hex }[]) => Promise<void>;
  readonly pageSize?: number;
}

/** How many headers a device holds unconfirmed - read, but not yet folded to a head the chain shows - before it says they are not the chain's. */
const UNCONFIRMED_AT_MOST = 1024;

/**
 * **EVERY HEADER FROM A HEAD THIS DEVICE CHECKED TO THE HEAD THE CHAIN HOLDS,
 * CHECKED ONE AGAINST THE ONE BEFORE IT, A PAGE AT A TIME.** A header is
 * believed to be the chain's only once it folds, with those before it, to a
 * head the account's history shows; then each is checked (`transitionRefusal`)
 * and kept (`keep`), so nothing of the history is held but the heads. A header
 * that lost a race to the same head is passed over. Headers that never reach
 * a head the chain shows, or none given past a head, stop `not-given`.
 */
export async function checkForward(input: ForwardInput): Promise<{
  readonly reached: CheckedHead; readonly stop: TransitionStop | null;
  /** Where a recovery the check went through resumed from, and the last batch this device had checked that it gave up. */
  readonly recovered?: { readonly resumedFrom: CheckedHead; readonly gaveUpTo: number };
}> {
  const target = input.chainHead.toLowerCase();
  let at = input.from;
  let recovered: { resumedFrom: CheckedHead; gaveUpTo: number } | undefined;
  /* The head a header follows: a recovery's is the one it resumes from. */
  const fromOf = (h: TreeHeader): Hex => (h.kind === 'recovery' ? h.resumesFrom!.head : h.previous);
  /* A head this device checked before the one it checks from, that only a recovery may resume from. */
  const earlierOf = (head: Hex): CheckedHead | undefined => (head === at.head ? undefined : input.earlier?.(head));
  if (at.head === target) return { reached: at, stop: null };
  const landed = new Set([...input.landed].map((h) => h.toLowerCase()));
  landed.add(target);
  /* Where each head sits in the account's history, oldest first, the head it holds now last: a recovery's head lands after the heads it gives up. */
  const landedAt = new Map([...landed].map((h, i) => [h, h === target ? Number.MAX_SAFE_INTEGER : i] as const));
  const limit = Math.max(1, input.pageSize ?? HEADERS_AT_ONCE);
  const entries = new Map<Hex, unknown>();
  const leaves = new Map<Hex, TreeLeaf>();
  const headAfter = new Map<string, Hex>();
  let seen: TreeHeader[] = [];
  let asked = at.seq;
  /* Whether the headers from before the head checked last were read once more, for a recovery resuming from an earlier head. */
  let lookedBack = input.earlier === undefined;
  /* A recovery resuming from a head this device checked before its last: one it may follow from there. */
  const resumesEarlier = (h: TreeHeader) => h.kind === 'recovery' && earlierOf(h.resumesFrom!.head) !== undefined;
  for (;;) {
    const page = await input.headersAfter(asked, limit);
    for (const e of page.entries ?? []) if (manifestEntryRefusal(input.company, e) === null) entries.set(entryIdOf(e as ManifestEntry), e);
    for (const l of page.leaves ?? []) if (treeLeafRefusal(l) === null) leaves.set(leafHashOf(l as TreeLeaf), l as TreeLeaf);
    const given = (page.headers ?? []).filter(treeHeaderReadable);
    const above = given.filter((h) => h.seq > asked);
    if (above.length === 0) {
      if (!lookedBack) {
        lookedBack = true;
        asked = Math.max(-1, (input.earliestSeq ?? 0) - 1);
        continue;
      }
      return { reached: at, stop: { stop: 'not-given', seq: at.seq + 1, what: 'its header' }, ...(recovered === undefined ? {} : { recovered }) };
    }
    asked = Math.max(...above.map((h) => h.seq));
    seen.push(...above.filter((h) => (h.seq > at.seq || resumesEarlier(h)) && !seen.includes(h)));
    /* Every head reachable from the last one checked, through the headers seen, each by the header that made it. */
    const reach = new Map<Hex, { readonly header: TreeHeader; readonly from: Hex }>();
    const seqOf = (head: Hex) => (head === at.head ? at.seq : reach.has(head) ? reach.get(head)!.header.seq : earlierOf(head)!.seq);
    /* Followed from the head checked last, one reached, or - a recovery only - one this device checked before it. */
    const follows = (h: TreeHeader): boolean => {
      const from = fromOf(h);
      if (from === at.head || reach.has(from)) return h.seq === seqOf(from) + 1;
      return h.kind === 'recovery' && earlierOf(from) !== undefined && h.seq === earlierOf(from)!.seq + 1
        && h.resumesFrom!.root === earlierOf(from)!.root;
    };
    for (let grew = true; grew;) {
      grew = false;
      const ready = seen.filter((h) => follows(h) && !headAfter.has(`${h.previous}${treeBatchOf(h)}`));
      if (ready.length > 0) {
        const heads = await input.headsOf(ready.map(headStepOf));
        ready.forEach((h, i) => headAfter.set(`${h.previous}${treeBatchOf(h)}`, String(heads[i] ?? '').toLowerCase()));
      }
      for (const h of seen) {
        if (!follows(h)) continue;
        const head = headAfter.get(`${h.previous}${treeBatchOf(h)}`);
        /* A head this device checked before is no new place: a recovery may resume from it, never reach it again. */
        if (head === undefined || head === at.head || reach.has(head) || earlierOf(head) !== undefined) continue;
        reach.set(head, { header: h, from: fromOf(h) });
        grew = true;
      }
    }
    /* The furthest head the chain shows that these headers reach: the path to it is the chain's. */
    const confirmed = [...reach.keys()].filter((h) => landed.has(h)).sort((a, b) => landedAt.get(b)! - landedAt.get(a)! || seqOf(b) - seqOf(a))[0];
    if (confirmed !== undefined) {
      const path: { header: TreeHeader; head: Hex }[] = [];
      let h = confirmed;
      for (; h !== at.head && reach.has(h); h = reach.get(h)!.from) path.unshift({ header: reach.get(h)!.header, head: h });
      /*
       * The path begins at a head this device checked before the one it checked last: a recovery the company's quorum
       * approved gave up the batches after it, and this device checks on from it.
       */
      if (h !== at.head) {
        const resumed = earlierOf(h)!;
        recovered = { resumedFrom: resumed, gaveUpTo: at.seq };
        at = resumed;
      }
      await input.confirmed?.(path);
      for (const step of path) {
        const stop = transitionRefusal({
          company: input.company, before: at, header: step.header, entry: (id) => entries.get(id), priorChain: (hash) => leaves.get(hash), seatOf: input.seatOf,
          ...(input.tagSeat === undefined ? {} : { tagSeat: input.tagSeat }),
        });
        if (stop !== null) return { reached: at, stop, ...(recovered === undefined ? {} : { recovered }) };
        at = checkedAfter(step.header, step.head);
        await input.keep(at, step.header);
      }
      if (at.head === target) return { reached: at, stop: null, ...(recovered === undefined ? {} : { recovered }) };
      seen = seen.filter((h) => h.seq > at.seq);
      if (seen.length === 0) { entries.clear(); leaves.clear(); headAfter.clear(); }
    }
    /*
     * Let go of every header that can no longer be on the chain's path, so
     * headers that will never land cannot crowd out the chain's own: one that
     * follows no head reachable from the last one checked, and one at a seq the
     * pages have passed whose head the chain does not show and no header seen
     * follows - it lost a race, or was never sent.
     */
    const madeBy = (h: TreeHeader) => headAfter.get(`${h.previous}${treeBatchOf(h)}`);
    const reachable = new Set<Hex>([at.head, ...seen.map(madeBy).filter((x): x is Hex => x !== undefined)]);
    const followed = new Set(seen.map(fromOf));
    seen = seen.filter((h) => {
      if (!reachable.has(fromOf(h)) && !(h.kind === 'recovery' && earlierOf(fromOf(h)) !== undefined)) return false;
      const made = madeBy(h);
      return made === undefined || h.seq >= asked || landed.has(made) || followed.has(made);
    });
    /* Counted only below the last seq paged: what is at it cannot be judged until the page after it is read. */
    if (seen.filter((h) => h.seq < asked).length > UNCONFIRMED_AT_MOST) {
      return { reached: at, stop: { stop: 'not-given', seq: at.seq + 1, what: 'a header that reaches the head on chain' } };
    }
  }
}
