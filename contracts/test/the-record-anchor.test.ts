/**
 * **THE COMPANY'S RECORDS ARE ANCHORED BY ONE HEAD ON CHAIN.**
 *
 * The account keeps one value, the head, under its own key in the shared map. Each anchor
 * moves it on by one batch: the digest of the records filed since the last head, in the order
 * they were filed. A device folds every record it reads, from the empty head, and believes a
 * record only when the fold reaches the head the chain holds. So a record served stale, left
 * out or out of order does not fold.
 *
 * Any signer may anchor, and nobody else. The caller names the head they read, and a call
 * naming any other is refused, so two devices anchoring at once never lose a batch. The map
 * holds one entry for the anchor for the life of the account; its history is the chain's.
 *
 * Each call also names who held the account as the anchoring device judged the batch - the
 * approvals it requires and its signer tree's root - and is refused unless they are the account's
 * as the call runs. What the head folds is the batch with those holders, so a device folding the
 * records learns who the batch was judged against from the chain, never from a later state.
 *
 * Each anchor also names the seat that moved it: a tag only the company's members can work out from
 * each seat's leaf opening, written beside the head and folded into it, so a header naming another
 * seat's key never folds to the head on chain, and a head with no header still says which seat moved it.
 *
 * Where a batch can never be checked - its header lost by everyone, or its own message false - a
 * quorum at the bar for changing who is seated approves a recovery from a head their devices checked,
 * to be carried out before a time the approval names, and any signer carries it out from the head the
 * chain holds, under the recovery's own tag. A removal after the approval voids it, and so does
 * another recovery carried out after it: each approval names the head the latest recovery carried
 * out wrote, and each recovery carried out writes its own there.
 *
 * The one to read first is "a device that read an older head is refused".
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, change, privateStateFor, ZERO_32 } from './simulator.js';
import type { AccountPrivateState } from '../src/witnesses.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const OUTSIDER = privateStateFor(3);
const NOW = 1_800_000_000;

const batch = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array | undefined) => (b === undefined ? 'none' : Buffer.from(b).toString('hex'));

type Held = { approvals: bigint; signerRoot: { field: bigint } };
/** The holders of `liveAccount([A, B], 2n)` as every anchor below names them, until a test changes them. */
let held: Held;
let sim: AccountSimulator;

/** One anchor as a device folds it: the batch, and the seat whose tag moved the head. */
type Step = readonly [by: AccountPrivateState, batch: Uint8Array];
/** What every device computes: the head after folding these anchors, in order, from the empty head, each judged against `h`. */
const foldAs = (h: Held, ...steps: Step[]) =>
  steps.reduce((head, [by, b]) => pureCircuits.anchorHeadOf(head, pureCircuits.anchorHeldOf(b, h.approvals, h.signerRoot, sim.anchorTagOf(by))), ZERO_32);
const fold = (...steps: Step[]) => foldAs(held, ...steps);

describe('the record anchor', () => {
  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    held = sim.heldNow();
  });

  it('starts empty, and the first anchor follows the empty head', async () => {
    /* RED WHEN anything writes the anchor's key before the first anchor. */
    expect(sim.anchorHead()).toBeUndefined();
    await sim.as(A).anchor(ZERO_32, batch(1));
    /* RED WHEN the circuit writes anything but anchorHeadOf(previous, anchorHeldOf(batch, approvals, root, tag)) under anchorKey(). */
    expect(hex(sim.anchorHead())).toBe(hex(fold([A, batch(1)])));
  });

  it('any signer moves it on from the head they read, and the head is every batch folded in order', async () => {
    await sim.as(A).anchor(ZERO_32, batch(1));
    await sim.as(B).anchor(fold([A, batch(1)]), batch(2));
    await sim.as(A).anchor(fold([A, batch(1)], [B, batch(2)]), batch(3));
    /* RED WHEN a head stops folding the head before it: then three anchors no longer chain. */
    expect(hex(sim.anchorHead())).toBe(hex(fold([A, batch(1)], [B, batch(2)], [A, batch(3)])));
  });

  it('a device that read an older head is refused, and the head does not move', async () => {
    await sim.as(A).anchor(ZERO_32, batch(1));
    await sim.as(B).anchor(fold([A, batch(1)]), batch(2));
    /* RED WHEN the compare-and-swap is removed: A's batch would overwrite B's and B's records would no longer fold. */
    await expect(sim.as(A).anchor(fold([A, batch(1)]), batch(3)))
      .rejects.toThrow(/another device anchored the company's records first; read the anchor again/);
    expect(hex(sim.anchorHead())).toBe(hex(fold([A, batch(1)], [B, batch(2)])));
  });

  it('the first anchor cannot name a head the chain never held', async () => {
    /* RED WHEN the empty-head check is removed: a signer could start the chain from a head of their choosing. */
    await expect(sim.as(A).anchor(batch(9), batch(1)))
      .rejects.toThrow(/never been anchored, so the first anchor follows the empty head/);
    expect(sim.anchorHead()).toBeUndefined();
  });

  it('a batch that covers nothing is refused', async () => {
    /* RED WHEN the empty-batch check is removed. */
    await expect(sim.as(A).anchor(ZERO_32, ZERO_32))
      .rejects.toThrow(/that batch covers no records; file a record first, then anchor it/);
    expect(sim.anchorHead()).toBeUndefined();
  });

  it('nobody but a signer may anchor', async () => {
    /* RED WHEN requireSigner() is removed from the circuit. */
    await expect(sim.as(OUTSIDER).anchor(ZERO_32, batch(1))).rejects.toThrow(/not a signer on this account/);
    expect(sim.anchorHead()).toBeUndefined();
  });

  it('a batch judged against approvals the account no longer requires is refused, and the head does not move', async () => {
    const judged = sim.heldNow();
    /* Between the device's read and its anchor landing, the account's threshold changes from 2 to 1. */
    await sim.raiseThreshold(1n, [A, B], 390);
    /* RED WHEN the approvals check is removed: a batch judged at 2 approvals would land while the account requires 1. */
    await expect(sim.as(A).anchor(ZERO_32, batch(1), judged))
      .rejects.toThrow(/the approvals the account requires changed after this device judged the batch; read the account again and anchor again/);
    expect(sim.anchorHead()).toBeUndefined();
    /* RED WHEN the check only refuses fewer approvals than the batch named: a batch judged at 1 would land while the account requires 2. */
    const now = sim.heldNow();
    await expect(sim.as(A).anchor(ZERO_32, batch(1), { ...now, approvals: now.approvals + 1n }))
      .rejects.toThrow(/the approvals the account requires changed after this device judged the batch/);
    await sim.raiseThreshold(2n, [A, B], 393);
    await expect(sim.as(A).anchor(ZERO_32, batch(1), now))
      .rejects.toThrow(/the approvals the account requires changed after this device judged the batch/);
    expect(sim.anchorHead()).toBeUndefined();
  });

  it("a batch judged before the account's signers changed is refused; read again and anchored again, it lands", async () => {
    const judged = sim.heldNow();
    /* Between the device's read and its anchor landing, another signer is seated: the signer tree's root moves. */
    await sim.seatSigner(privateStateFor(4), [A, B], 392);
    /* RED WHEN the signer-root check is removed: a batch judged against the old signers would land. */
    await expect(sim.as(A).anchor(ZERO_32, batch(1), judged))
      .rejects.toThrow(/the account's signers changed after this device judged the batch; read the account again and anchor again/);
    expect(sim.anchorHead()).toBeUndefined();
    /* The device reads again and anchors again, naming who holds the account now. */
    const now = sim.heldNow();
    await sim.as(A).anchor(ZERO_32, batch(1), now);
    expect(hex(sim.anchorHead())).toBe(hex(foldAs(now, [A, batch(1)])));
  });

  it('the head folds who the batch was judged against, so other holders reach another head', async () => {
    await sim.as(A).anchor(ZERO_32, batch(1));
    /* RED WHEN the head folds the batch alone: who it was judged against would then be in no head a device folds to. */
    expect(hex(sim.anchorHead())).toBe(hex(foldAs(held, [A, batch(1)])));
    /* RED WHEN anchorHeldOf stops hashing the approvals or the root: a header could then name holders the call never checked. */
    expect(hex(sim.anchorHead())).not.toBe(hex(foldAs({ ...held, approvals: held.approvals + 1n }, [A, batch(1)])));
    expect(hex(sim.anchorHead())).not.toBe(hex(foldAs({ ...held, signerRoot: { field: held.signerRoot.field + 1n } }, [A, batch(1)])));
    /* RED WHEN anchorHeldOf stops hashing the batch. */
    expect(hex(foldAs(held, [A, batch(1)]))).not.toBe(hex(foldAs(held, [A, batch(2)])));
  });

  it('each anchor names the seat that moved it: its tag is written beside the head and folded into it', async () => {
    expect(sim.anchorSeat()).toBeUndefined();
    await sim.as(A).anchor(ZERO_32, batch(1));
    /* RED WHEN the circuit does not write the anchoring seat's tag under anchorSeatKey(): a head with no header could name no seat. */
    expect(hex(sim.anchorSeat())).toBe(hex(sim.anchorTagOf(A)));
    await sim.as(B).anchor(fold([A, batch(1)]), batch(2));
    expect(hex(sim.anchorSeat())).toBe(hex(sim.anchorTagOf(B)));
    /* RED WHEN anchorHeldOf stops hashing the tag: a header naming another seat's key would fold to the head on chain. */
    expect(hex(sim.anchorHead())).not.toBe(hex(fold([A, batch(1)], [A, batch(2)])));
  });

  it('a seat\'s tag is its own in one account, another seat\'s differs, and in another account it is unlinked', async () => {
    /* RED WHEN anchorTagOf stops hashing the seat's key or blinding: two seats could then anchor under one tag. */
    expect(hex(sim.anchorTagOf(A))).not.toBe(hex(sim.anchorTagOf(B)));
    expect(hex(sim.anchorTagOf(A))).not.toBe(hex(sim.anchorTagOf({ ...A, blinding: B.blinding })));
    expect(hex(sim.anchorTagOf(B))).not.toBe(hex(sim.anchorTagOf({ ...B, secretKey: A.secretKey })));
    /* RED WHEN anchorTagOf stops hashing the account: one person's anchors in two companies would link. */
    const other = await AccountSimulator.liveAccount([A, B], 2n);
    expect(sim.address).not.toBe(other.address);
    expect(hex(other.anchorTagOf(A))).not.toBe(hex(sim.anchorTagOf(A)));
  });

  it('holds two entries for the life of the account: the head and the seat that moved it', async () => {
    const before = sim.signerRolesSize();
    await sim.as(A).anchor(ZERO_32, batch(1));
    await sim.as(B).anchor(fold([A, batch(1)]), batch(2));
    /* RED WHEN an anchor writes under a key of its own per batch or per seat instead of overwriting the head and its seat. */
    expect(sim.signerRolesSize()).toBe(before + 2n);
  });
});

describe('a recovery of the record anchor', () => {
  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    held = sim.heldNow();
  });
  /** A then B anchored; the recovery resumes from A's head, past B's batch. */
  const twoAnchors = async () => {
    await sim.as(A).anchor(ZERO_32, batch(1));
    await sim.as(B).anchor(fold([A, batch(1)]), batch(2));
    return { resumes: fold([A, batch(1)]), now: fold([A, batch(1)], [B, batch(2)]) };
  };

  it('approved at the seat bar, any signer carries it out from the head the chain holds, under its own tag, and its proposal closes', async () => {
    const { resumes, now } = await twoAnchors();
    const { id, c, latest } = await sim.approvedRecovery(resumes, [A, B]);
    /* Carried out by A, whose tag is not the one the head was last moved under. */
    await sim.as(sim.applying(A, c)).recoverAnchor(now, batch(9), resumes, latest, id);
    /* RED WHEN the recovery folds anything but anchorRecoveredOf(batch, approvals, root, tag, resumesFrom) on from the head held. */
    expect(hex(sim.anchorHead())).toBe(hex(pureCircuits.anchorHeadOf(now,
      pureCircuits.anchorRecoveredOf(batch(9), held.approvals, held.signerRoot, sim.anchorTagOf(A), resumes))));
    /* RED WHEN anchorRecoveredOf stops hashing the head it resumes from: a recovery from one head would read as from any. */
    expect(hex(sim.anchorHead())).not.toBe(hex(pureCircuits.anchorHeadOf(now,
      pureCircuits.anchorRecoveredOf(batch(9), held.approvals, held.signerRoot, sim.anchorTagOf(A), now))));
    /* RED WHEN the recovery folds under the plain anchor's tag: a plain anchor could then be read as a recovery. */
    expect(hex(sim.anchorHead())).not.toBe(hex(pureCircuits.anchorHeadOf(now,
      pureCircuits.anchorHeldOf(batch(9), held.approvals, held.signerRoot, sim.anchorTagOf(A)))));
    /* RED WHEN the recovery does not name the seat that carried it out. */
    expect(hex(sim.anchorSeat())).toBe(hex(sim.anchorTagOf(A)));
    /* RED WHEN the proposal stays open: one approval could carry out a second recovery. */
    expect(sim.isOpen(id)).toBe(false);
  });

  it('refused short of the seat bar, for another head than the one approved, and from a head the chain does not hold', async () => {
    const { resumes, now } = await twoAnchors();
    const short = await sim.approvedRecovery(resumes, [A], 471);
    /* RED WHEN requireApproved or requireSeatBar is dropped: one seat could give up the company's batches alone. */
    await expect(sim.as(sim.applying(A, short.c)).recoverAnchor(now, batch(9), resumes, short.latest, short.id)).rejects.toThrow(/not enough approvals yet/);
    const { id, c, latest } = await sim.approvedRecovery(resumes, [A, B]);
    /* RED WHEN the approval does not bind the head it resumes from: a carrying-out device could resume from any head. */
    await expect(sim.as(sim.applying(A, c)).recoverAnchor(now, batch(9), now, latest, id))
      .rejects.toThrow(/that proposal is not a recovery of the company's records from that head/);
    /* RED WHEN the recovery skips the compare-and-swap: a carrying-out device could drop an anchor that landed after its read. */
    await expect(sim.as(sim.applying(A, c)).recoverAnchor(resumes, batch(9), resumes, latest, id))
      .rejects.toThrow(/another device anchored the company's records first/);
    expect(hex(sim.anchorHead())).toBe(hex(now));
    expect(sim.isOpen(id)).toBe(true);
  });

  it('refused below the bar for changing who is seated, where that bar is above the threshold', async () => {
    const C = privateStateFor(5);
    sim = await AccountSimulator.liveAccount([A, B, C], 2n);
    sim.at(NOW);
    /* The approvals a policy change needs raised to three: a change of who is seated needs three, the threshold two. */
    const bar = change(0n, 481);
    const payload = pureCircuits.setPolicyBarPayload(3n);
    await sim.as(sim.applying(A, bar)).propose(payload);
    const barId = sim.proposalId(payload, bar.salt);
    for (const d of [B]) await sim.as(d).approve(barId);
    await sim.as(sim.applying(A, bar)).setPolicyBar(3n, barId);
    held = sim.heldNow();
    const { resumes, now } = await twoAnchors();
    const two = await sim.approvedRecovery(resumes, [A, B], 482);
    /* RED WHEN requireSeatBar is dropped: a recovery rewrites who the records say is seated, below the bar for that. */
    await expect(sim.as(sim.applying(A, two.c)).recoverAnchor(now, batch(9), resumes, two.latest, two.id))
      .rejects.toThrow(/needs as many approvals as a policy change needs, and at least the threshold/);
    await sim.as(C).approve(two.id);
    await sim.as(sim.applying(A, two.c)).recoverAnchor(now, batch(9), resumes, two.latest, two.id);
    expect(sim.isOpen(two.id)).toBe(false);
  });

  it('nobody but a signer carries it out', async () => {
    const { resumes, now } = await twoAnchors();
    const { id, c, latest } = await sim.approvedRecovery(resumes, [A, B]);
    /* RED WHEN the recovery proves no seat. */
    await expect(sim.as(sim.applying(OUTSIDER, c)).recoverAnchor(now, batch(9), resumes, latest, id)).rejects.toThrow(/not a signer on this account/);
    expect(hex(sim.anchorHead())).toBe(hex(now));
  });

  it('carried out only before the latest time its approval names; past it, refused until it is raised again', async () => {
    const { resumes, now } = await twoAnchors();
    const { id, c, latest } = await sim.approvedRecovery(resumes, [A, B], 491, BigInt(NOW + 100));
    /* RED WHEN the approval does not bind its latest time: a carrying-out device could name any later one. */
    await expect(sim.as(sim.applying(A, c)).recoverAnchor(now, batch(9), resumes, latest + 1n, id))
      .rejects.toThrow(/that proposal is not a recovery of the company's records from that head before that time/);
    sim.at(NOW + 100);
    /* RED WHEN the recovery is not held to its latest time: one seat could carry out an old approval after the records resumed. */
    await expect(sim.as(sim.applying(A, c)).recoverAnchor(now, batch(9), resumes, latest, id))
      .rejects.toThrow(/the time to carry out this recovery has passed; raise it again/);
    expect(hex(sim.anchorHead())).toBe(hex(now));
    expect(sim.isOpen(id)).toBe(true);
    /* Raised again with a later time, the same quorum carries it out. */
    const again = await sim.approvedRecovery(resumes, [A, B], 492, BigInt(NOW + 200));
    await sim.as(sim.applying(A, again.c)).recoverAnchor(now, batch(9), resumes, again.latest, again.id);
    expect(sim.isOpen(again.id)).toBe(false);
  });

  it('an anchor landing between its approval and its carrying out does not void it: the approval binds no head but the one it resumes from', async () => {
    const { resumes, now } = await twoAnchors();
    const { id, c, latest } = await sim.approvedRecovery(resumes, [A, B], 495);
    /* B anchors again after the approval: the head the approvers saw stopped is no longer the chain's. */
    await sim.as(B).anchor(now, batch(3));
    const moved = foldAs(held, [A, batch(1)], [B, batch(2)], [B, batch(3)]);
    expect(hex(sim.anchorHead())).toBe(hex(moved));
    /* RED WHEN the approval binds the head it was approved against: any seat could void every recovery by anchoring once. */
    await sim.as(sim.applying(A, c)).recoverAnchor(moved, batch(9), resumes, latest, id);
    expect(hex(sim.anchorHead())).toBe(hex(pureCircuits.anchorHeadOf(moved,
      pureCircuits.anchorRecoveredOf(batch(9), held.approvals, held.signerRoot, sim.anchorTagOf(A), resumes))));
    expect(sim.isOpen(id)).toBe(false);
  });

  it('a recovery approved before another was carried out is refused; one raised after it is carried out', async () => {
    const { resumes, now } = await twoAnchors();
    const first = await sim.approvedRecovery(resumes, [A, B], 501);
    const second = await sim.approvedRecovery(resumes, [A, B], 502);
    /* Before any recovery is carried out, each approval names 32 zero bytes as the latest recovery's head. */
    expect(hex(first.lastRecovery)).toBe(hex(ZERO_32));
    await sim.as(sim.applying(A, first.c)).recoverAnchor(now, batch(9), resumes, first.latest, first.id, held, first.lastRecovery);
    const recovered = sim.anchorHead()!;
    /* RED WHEN a recovery carried out does not write the head it moved the anchor to as the latest recovery's head. */
    expect(hex(sim.lastRecovery())).toBe(hex(recovered));
    expect(hex(recovered)).toBe(hex(pureCircuits.anchorHeadOf(now,
      pureCircuits.anchorRecoveredOf(batch(9), held.approvals, held.signerRoot, sim.anchorTagOf(A), resumes))));
    /* RED WHEN recoverAnchor stops checking the latest recovery its approval names against the chain's: one seat could use a second approval to give up batches anchored since the first. */
    await expect(sim.as(sim.applying(B, second.c)).recoverAnchor(recovered, batch(8), resumes, second.latest, second.id, held, second.lastRecovery))
      .rejects.toThrow(/this recovery names a latest recovery that is no longer the latest one carried out, so it is void; raise it again and have it approved/);
    /* RED WHEN the approval does not bind the latest recovery it names: a carrying-out device could name the chain's instead. */
    await expect(sim.as(sim.applying(B, second.c)).recoverAnchor(recovered, batch(8), resumes, second.latest, second.id, held, recovered))
      .rejects.toThrow(/that proposal is not a recovery of the company's records from that head before that time/);
    expect(hex(sim.anchorHead())).toBe(hex(recovered));
    expect(sim.isOpen(second.id)).toBe(true);
    /* A plain anchor after it leaves the latest recovery's head where the recovery wrote it. */
    await sim.as(B).anchor(recovered, batch(3));
    const moved = sim.anchorHead()!;
    /* RED WHEN a plain anchor writes the latest recovery's head: any seat could void every recovery approved by anchoring once. */
    expect(hex(sim.lastRecovery())).toBe(hex(recovered));
    /* Raised again after it, against the head the first recovery wrote, the same quorum carries it out. */
    const again = await sim.approvedRecovery(recovered, [A, B], 503);
    expect(hex(again.lastRecovery)).toBe(hex(recovered));
    await sim.as(sim.applying(A, again.c)).recoverAnchor(moved, batch(8), recovered, again.latest, again.id, held, again.lastRecovery);
    expect(sim.isOpen(again.id)).toBe(false);
    expect(hex(sim.lastRecovery())).toBe(hex(sim.anchorHead()!));
  });

  it('before any recovery is carried out, an approval naming a recovery\'s head is refused', async () => {
    const { resumes, now } = await twoAnchors();
    const named = await sim.approvedRecovery(resumes, [A, B], 504, undefined, now);
    /* RED WHEN the account reads an absent latest recovery as anything but 32 zero bytes: an approval naming a head no recovery wrote would pass. */
    await expect(sim.as(sim.applying(A, named.c)).recoverAnchor(now, batch(9), resumes, named.latest, named.id, held, named.lastRecovery))
      .rejects.toThrow(/this recovery names a latest recovery that is no longer the latest one carried out, so it is void; raise it again and have it approved/);
    expect(hex(sim.anchorHead())).toBe(hex(now));
    expect(sim.isOpen(named.id)).toBe(true);
  });

  it('a removal after it was approved voids it, even once enough others approve', async () => {
    const C = privateStateFor(5);
    const D = privateStateFor(6);
    sim = await AccountSimulator.liveAccount([A, B, C, D], 2n);
    sim.at(NOW);
    held = sim.heldNow();
    const { resumes, now } = await twoAnchors();
    const { id, c, latest } = await sim.approvedRecovery(resumes, [A, B], 493);
    /* D is removed after A and B approved; C then approves, so the approvals cover the threshold and the removal. */
    const r = change(0n, 494);
    const payload = pureCircuits.removeSignerPayload(sim.leafOf(D));
    await sim.as(sim.applying(A, r)).propose(payload);
    const rid = sim.proposalId(payload, r.salt);
    for (const d of [B]) await sim.as(d).approve(rid);
    await sim.as(sim.applying(A, r)).removeSigner(sim.leafOf(D), rid);
    await sim.as(C).approve(id);
    /* RED WHEN a removal only adds one approval to the bar instead of voiding the recovery: the removed seat's approval would still count. */
    await expect(sim.as(sim.applying(A, c)).recoverAnchor(now, batch(9), resumes, latest, id, sim.heldNow()))
      .rejects.toThrow(/a signer has been removed or replaced since this was raised; raise it again/);
    expect(hex(sim.anchorHead())).toBe(hex(now));
    expect(sim.isOpen(id)).toBe(true);
  });
});

describe('the fold a device runs', () => {
  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    held = sim.heldNow();
  });

  it('two batches in the other order reach another head', () => {
    /* RED WHEN anchorHeadOf stops ordering its inputs: a server could then reorder batches unseen. */
    expect(hex(fold([A, batch(1)], [A, batch(2)]))).not.toBe(hex(fold([A, batch(2)], [A, batch(1)])));
  });

  it('leaving a batch out reaches another head', () => {
    /* RED WHEN anchorHeadOf stops hashing the head before it: a withheld batch would go unseen. */
    expect(hex(fold([A, batch(1)], [A, batch(2)], [A, batch(3)]))).not.toBe(hex(fold([A, batch(1)], [A, batch(3)])));
  });
});
