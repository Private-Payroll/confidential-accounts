/**
 * **A DEVICE A RECOVERY MOVED BACK KEEPS THE HEADS OF THE CHAIN'S LINE, IN SEQ ORDER.**
 *
 * A device that checked batches the quorum later gave up follows the recovery back to an earlier head. What it keeps
 * then, in memory and in the browser's own database, holds the heads below the recovery's seq and then the recovery's
 * head, so a head is read at the seq of the batch that left it, and the batch a directory version was anchored with is
 * counted from the anchor the recovery made. A write from a read that never checked the kept latest head never sets it
 * back. The one to read first is "KEEPS THE HEADS BELOW THE RECOVERY'S SEQ".
 */
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Hex } from '../../../src/core/crypto.js';
import type { CheckedHead } from '../../../src/midnight/record-tree.js';
import type { AnchorLanded } from './governed-call-builder.js';
import { headsHere } from './held-heads-here.js';
import { keptAfter } from './records-as-anchored.js';
import { checkedHeadsInMemory, treeKeptHere, type CheckedHeads, type CheckedHeadsStore } from './tree-kept-here.js';

const CO = 'acct_moved_back';
const headOf = (seq: number): Hex => `b${seq.toString(16).padStart(63, '0')}` as Hex;
const at = (seq: number): CheckedHead => ({ seq, head: headOf(seq), root: 'cc'.repeat(32) as Hex, dirVersion: 0 });
/* The quorum's recovery from the second batch, past the third and the fourth: its header has the third's seq. */
const RECOVERED: CheckedHead = { seq: 2, head: 'e2'.repeat(32) as Hex, root: 'cc'.repeat(32) as Hex, dirVersion: 0 };
const AFTER: CheckedHead = { seq: 3, head: 'e3'.repeat(32) as Hex, root: 'cc'.repeat(32) as Hex, dirVersion: 0 };
/* The account's history: the four batches this device checked, then the recovery's anchor, each block's seat bar its own. */
const LANDED: readonly AnchorLanded[] = [...[0, 1, 2, 3].map((s) => headOf(s)), RECOVERED.head].map((head, i) => ({
  head,
  seatBar: i + 1,
  height: i + 1,
  at: 1_000 * (i + 1)
}));
const nothingAsked = { accountId: CO, tree: {}, builder: {} } as unknown as Parameters<typeof headsHere>[0];

/** What a device keeps after checking the batches up to `last`, each kept as the held read keeps it. */
const checkedUpTo = (last: number, from: CheckedHeads | null = null): CheckedHeads => {
  let kept = from;
  for (let s = (from?.latest.seq ?? -1) + 1; s <= last; s += 1) kept = keptAfter(kept, at(s), kept === null);
  return kept!;
};
const checkedFour = async (store: CheckedHeadsStore): Promise<CheckedHeads> => {
  let kept: CheckedHeads | null = null;
  for (let s = 0; s < 4; s += 1) {
    kept = keptAfter(kept, at(s), s === 0);
    await store.write(CO, kept);
  }
  return kept!;
};

const STORES: readonly (readonly [string, () => CheckedHeadsStore])[] = [
  ['in memory', () => checkedHeadsInMemory()],
  ["in the browser's database", () => treeKeptHere(new IDBFactory()).checked]
];

describe.each(STORES)('WHAT A DEVICE KEEPS %s AFTER A RECOVERY MOVED IT BACK', (_where, storeOf) => {
  it("KEEPS THE HEADS BELOW THE RECOVERY'S SEQ AND THEN THE RECOVERY'S HEAD, EACH READ AT ITS OWN SEQ", async () => {
    const store = storeOf();
    const moved = keptAfter(await checkedFour(store), RECOVERED, false);
    /* RED WHEN: the write does not say which latest the recovery gave up, so no store can tell it from an older writer. */
    expect(moved.gaveUp).toEqual(at(3));
    await store.write(CO, moved);
    const kept = (await store.read(CO))!;
    /* RED WHEN: the recovery's head is kept after the heads it gave up, so every seq from it on names the wrong head. */
    expect(kept.heads).toEqual([headOf(0), headOf(1), RECOVERED.head]);
    /* RED WHEN: the store keeps the latest the recovery gave up, so every read follows the recovery again. */
    expect(kept.latest).toEqual(RECOVERED);
    /* RED WHEN: what a recovery gave up is kept, and a later write is weighed against a head no longer the latest. */
    expect(kept).not.toHaveProperty('gaveUp');
    const heads = headsHere(nothingAsked, LANDED, kept);
    /* RED WHEN: the recovered seq is read as a head the recovery gave up. */
    expect(heads.headsBySeq.get(2)).toBe(RECOVERED.head);
    expect(heads.headsBySeq.has(3)).toBe(false);
    /* RED WHEN: the recovery's head is given a seq past its own, or a head given up is still given one. */
    expect(heads.seqOfHead(RECOVERED.head)).toBe(2);
    expect(heads.seqOfHead(headOf(2))).toBeNull();
    /* RED WHEN: a directory version anchored with the recovery is counted against the holders after a batch it gave up. */
    expect(heads.landedFrom(2)).toBe(LANDED[4]);
    /* RED WHEN: the next head checked carries the given-up latest on, or is kept anywhere but at its own seq. */
    const next = keptAfter(moved, AFTER, false);
    expect(next).not.toHaveProperty('gaveUp');
    expect(next.heads).toEqual([headOf(0), headOf(1), RECOVERED.head, AFTER.head]);
  });

  it('A WRITE FROM A READ THAT NEVER CHECKED THE KEPT LATEST CANNOT SET IT BACK, EVEN ONE A RECOVERY MOVED BACK', async () => {
    const store = storeOf();
    const four = await checkedFour(store);
    /* A read that began at the second batch checks the third, after this device kept the fourth. */
    await store.write(CO, checkedUpTo(2, checkedUpTo(1)));
    /* A read that began at the third batch follows the recovery from the second: it gives up the third, never the fourth. */
    const stale = keptAfter(checkedUpTo(2), RECOVERED, false);
    expect(stale.gaveUp).toEqual(at(2));
    await store.write(CO, stale);
    /* RED WHEN: a write moved back from some other head sets back the latest this device checked meanwhile. */
    expect((await store.read(CO))!.latest).toEqual(four.latest);
    expect((await store.read(CO))!.heads).toEqual(four.heads);
  });
  it("A READ BEGUN BEFORE THE RECOVERY, WRITING AFTER IT, LEAVES THE RECOVERY'S HEAD KEPT: IT NEVER CHECKED THAT HEAD", async () => {
    const store = storeOf();
    await checkedFour(store);
    const snapshot = (await store.read(CO))!;
    await store.write(CO, keptAfter(snapshot, RECOVERED, false));
    /* A second read on this device began from the same snapshot and writes what it kept back. */
    await store.write(CO, snapshot);
    const kept = (await store.read(CO))!;
    /* RED WHEN: a write that never checked the kept latest puts the heads the recovery gave up back, higher seq or not. */
    expect(kept.latest).toEqual(RECOVERED);
    expect(kept.heads).toEqual([headOf(0), headOf(1), RECOVERED.head]);
  });
});

describe("THE BROWSER'S DATABASE, AFTER A RECOVERY MOVED A DEVICE BACK", () => {
  it("READS BACK THE SHORTER HEADS WHERE THE RECOVERY'S HEAD ENDS A ROW, AND EVERY HEAD AS THEY GROW AGAIN", async () => {
    const store = treeKeptHere(new IDBFactory()).checked;
    const kept = checkedUpTo(1025);
    expect(kept.heads).toHaveLength(1026);
    await store.write(CO, kept);
    /* A recovery from batch 1022: its head is the 1024th, the last of the first row of heads. */
    const recovered: CheckedHead = {
      seq: 1023,
      head: 'e4'.repeat(32) as Hex,
      root: 'cc'.repeat(32) as Hex,
      dirVersion: 0
    };
    await store.write(CO, keptAfter(kept, recovered, false));
    const back = (await store.read(CO))!;
    /* RED WHEN: only the rows past the heads kept are written, so the row the recovery's head ends is read back as it was. */
    expect(back.heads).toEqual([...kept.heads.slice(0, 1023), recovered.head]);
    /* The batch after the recovery: not the head the given-up batch at that seq left. */
    const grown = keptAfter(back, { ...at(1024), head: 'e5'.repeat(32) as Hex }, false);
    await store.write(CO, grown);
    /* RED WHEN: a row left from before the recovery is read back as heads checked after it. */
    expect((await store.read(CO))!.heads).toEqual(grown.heads);
  });
});
