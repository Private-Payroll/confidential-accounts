import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountSimulator, privateStateFor, change,
} from './simulator.js';
import type { AccountPrivateState } from '../src/witnesses.js';

/**
 * Contract tests.
 *
 * These exist because compiling proves nothing. The first version of this
 * contract compiled cleanly with three mutually incompatible commitment
 * schemes for one field, which would have been discovered on a deployed
 * testnet contract after the proof server, the sponsor and the node wiring
 * were all built on top of it.
 *
 * The cases below are chosen for what they would cost to get wrong, not for
 * coverage. Anything that could silently turn this into a Safe clone, or let a
 * balance escape, is here.
 */

const ADA = 1, BLAKE = 2, CLEO = 3, MALLORY = 9;

describe('confidential account contract', () => {
  let ada: AccountPrivateState;
  let blake: AccountPrivateState;
  let cleo: AccountPrivateState;
  let mallory: AccountPrivateState;
  let sim: AccountSimulator;
  /** Who is seated, in seating order — `addSigners` is cumulative. */
  let seated: AccountPrivateState[] = [];
  /** A fresh salt per governed round, so two fixture rounds never collide. */
  let roundSeed = 310;
  /*
   * `funded` STOOD HERE — a zero `ShieldedView` passed into every `applying`.
   * The account keeps no balance, so a device holds no view of
   * one and `applying` takes only the change.
   */

  /**
   * Ada deploys. The account holds nothing and cannot.
   *
   * **THE `threshold` ARGUMENT WENT WITH THE CONSTRUCTOR'S.**
   * Every account is founded one seat at one approval; `addSigners`
   * below seats the rest through approved rounds and takes the threshold up
   * afterwards, which is what a founder now does on chain.
   */
  const deploy = async () => {
    ada = privateStateFor(ADA);
    blake = privateStateFor(BLAKE);
    cleo = privateStateFor(CLEO);
    mallory = privateStateFor(MALLORY);
    sim = await AccountSimulator.create(ada);
    seated = [ada];
    roundSeed = 310;
    return sim;
  };

  /**
   * Seats `people` through the approved path and leaves the threshold at the
   * seat count — which is the state `create(ada, 2n)` plus a bootstrap seating
   * used to produce, reached the way the chain now requires.
   *
   * **IT IS CUMULATIVE, AND IT HAS TO BE.** A second call has to know who is
   * already seated, because the rounds it raises need approvals from all of
   * them: the threshold went up when the first call ran. `deploy()` resets the
   * roster, and every `it` gets a fresh one through `beforeEach`.
   */
  const addSigners = async (...people: AccountPrivateState[]) => {
    for (const p of people) {
      await sim.seatSigner(p, [...seated], roundSeed++);
      seated.push(p);
    }
    await sim.raiseThreshold(BigInt(seated.length), seated, roundSeed++);
    sim.as(ada);
  };

  /** Propose, and hand back the id the chain knows it by. */
  const propose = async (payload: Uint8Array, c = change(0n, 41)) => {
    await sim.as(sim.applying(ada, c)).propose(payload);
    return sim.proposalId(payload, c.salt);
  };

  beforeEach(async () => { await deploy(); });

  /* ---------------- deployment ---------------- */

  it('deploys with the founding signer as its only seat and keeping no books', async () => {
    /*
     * **THE TITLE SAID "THE DEPLOYER" AND IT WAS ACCURATE THEN.** The
     * constructor derived its one seat from the DEPLOYING device's witnesses.
     * It takes the founder's leaf as a public argument now and calls none of
     * them, so the count below is unchanged and what it counts is not: this is
     * a seat that belongs to a person, not to a process.
     *
     * Whose seat it is, and that the deploying device does not get one, is
     * `what-a-signer-is.test.ts`'s founding-seat block — it needs two
     * different devices, and `deploy()` here is a founder deploying for
     * themselves.
     */
    /*
     * **ONE SEAT AND A THRESHOLD OF ONE, AND THE SECOND NUMBER IS NO LONGER A
     * CHOICE.** The constructor took the threshold as an argument and this
     * line read `2n` because `deploy()` asked for two. Every account is now
     * founded one-signer, one-approval, so the pair below is the ONLY state a
     * constructor can produce — which is what makes a founding threshold of
     * zero, and a founding threshold above the seat count, unrepresentable
     * rather than refused.
     */
    expect(sim.ledger.threshold).toBe(1n);
    expect(sim.ledger.signerLeaves.size()).toBe(1n);
    expect(sim.ledger.openProposals.size()).toBe(0n);
    /*
     * THERE IS NO BALANCE FIELD AT ALL, and that is a stronger assertion than
     * the one it replaces.
     *
     * This checked `assetBalances.size() === 0` — an empty map, on a contract
     * that still had one. An empty map is a claim about today; a missing field
     * is a claim about what this contract can ever do. The account is an
     * authority over a vault, not a holder of money, and the shape of its
     * public state is where that is either true or not.
     *
     * `settled` goes with it: the tree of executed proposals existed only for
     * the circuit that spent from the balance.
     */
    const fields = Object.keys(sim.ledger);
    /*
     * THE POSITIVE CONTROL COMES FIRST, and without it the three assertions
     * below all pass on an empty array — which is what a compiler emitting
     * prototype getters instead of an object literal would hand back. Three
     * absences proved by reading nothing is not a proof of absence.
     */
    expect(fields).toContain('movements');
    expect(fields).not.toContain('assetBalances');
    expect(fields).not.toContain('settled');
    // And nothing else grew a balance in their place.
    expect(fields.filter(f => /balance/i.test(f))).toEqual([]);
  });

  /* ---------------- membership ---------------- */

  it('refuses anyone who is not in the signer tree', async () => {
    // Mallory holds a perfectly good key. It is simply not one of ours.
    await expect(sim.as(mallory).propose(new Uint8Array(32))).rejects.toThrow(/not a signer/i);
  });

  it('does not publish who the signers are', async () => {
    // Two more signers, seated through approved rounds — there is no
    // bootstrap window and no other way. This test is about what the ledger
    // reveals, not about how signers are authorised; the governance path has
    // its own tests in signer-governance.test.ts.
    await deploy();
    await addSigners(blake, cleo);
    // The tree exposes a root and a size. It does not enumerate members, and
    // there is no ledger field naming anyone. If this ever fails, someone has
    // replaced the Merkle tree with a Set and the product is gone.
    const keys = Object.keys(sim.ledger);
    expect(keys).not.toContain('signerList');
    expect(sim.ledger.signers.root()).toBeDefined();
    expect(typeof (sim.ledger.signers as any)[Symbol.iterator]).toBe('undefined');
  });

  /*
   * Leaves are blinded commitments rather than public key hashes.
   *
   * Before this, addSigner published signerPublicKey(sk) directly, so anyone
   * reading transaction history had the whole signer set, and anyone with a
   * guess could confirm it. Authentication was still sound. The privacy claim
   * was not.
   */
  it('does not let an observer locate a signer from their public identity', async () => {
    await deploy();
    await addSigners(blake, cleo);
    // An observer who has somehow learned Blake's public identity still cannot
    // find him in the tree, because the leaf is a commitment under a blinding
    // factor that never left his device.
    expect(sim.ledger.signers.findPathForLeaf(sim.publicKeyOf(blake))).toBeUndefined();
    expect(sim.leafOf(blake)).not.toEqual(sim.publicKeyOf(blake));
  });

  it('does not let an observer confirm a guessed signer', async () => {
    await addSigners(blake);
    // The attacker guesses correctly that Blake is a signer, and even guesses
    // his secret key. Without the blinding factor the guess is unconfirmable.
    const guess = { ...blake, blinding: new Uint8Array(32) };
    expect(sim.leafOf(guess as any)).not.toEqual(sim.leafOf(blake));
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(guess as any))).toBeUndefined();
  });

  it('refuses a signer who has lost their blinding factor', async () => {
    await addSigners(blake);
    const id = await propose(new Uint8Array(32));
    // The blinding factor is as precious as the key. Without it Blake cannot
    // reproduce his own leaf, so he cannot prove membership. Recovery has to
    // cover this too, not just the signing key.
    const amnesiac = { ...blake, blinding: new Uint8Array(32).fill(9) };
    await expect(sim.as(amnesiac as any).approve(id)).rejects.toThrow();
  });

  it('gives two signers with the same blinding factor different leaves', async () => {
    // Blinding hides identity; it must not collapse it. Distinct keys have to
    // produce distinct leaves even if the randomness were somehow reused.
    const b = { ...blake, blinding: ada.blinding };
    expect(sim.leafOf(b as any)).not.toEqual(sim.leafOf(ada));
  });

  /* ---------------- approval ---------------- */

  it('refuses a second approval from the same signer', async () => {
    await addSigners(blake);
    const c = change(0n, 41);
    const id = await propose(new Uint8Array(32), c);
    await sim.as(sim.applying(ada, c)).approve(id);
    // The nullifier is already burned. Without this, one signer reaches any
    // threshold alone and M of N means nothing.
    await expect(sim.as(sim.applying(ada, c)).approve(id))
      .rejects.toThrow(/already approved/i);
    expect(sim.approvalsFor(id)).toBe(1n);
  });

  it('COUNTS EVERY APPROVAL, AND COUNTS EACH ONE ONCE — the number the threshold is read against', async () => {
    /*
     * THE COUNTER ITSELF, WHICH NOTHING WAS TESTING ON PURPOSE.
     *
     * The mutation `approving a proposal does not count` deletes the one
     * increment in `approve`. It scored WRONG TEST: its named expectation was
     * *one approval short is refused*, which approves once against a threshold
     * of two and asserts a REFUSAL — and a counter stuck at zero refuses too,
     * with the same message. The mutation made refusals strictly more likely
     * and the test that was supposed to pin the line passed.
     *
     * **AND 110 OTHER TESTS WENT RED, ACROSS FOURTEEN FILES**, none of them
     * about the counter — read off the mutation run's own output, which prints
     * `Tests 110 failed | 122 passed (232)`. It had been recorded elsewhere as
     * *ten*; the instrument's own output says otherwise.
     *
     * The correction cuts against this test rather than for it: the line was
     * guarded by accident far more heavily than anybody thought. That does not
     * make the accident a guard. Not one of the 110 asserts the counter, so any
     * of them can be rewritten by a round that does not know it is holding this
     * line — and a `WRONG TEST` score says nothing about which.
     *
     * This test counts UP and asserts the number, which is the only shape that
     * fails when the increment goes. It asserts nothing else, so a failure here
     * names the counter and not a policy it happens to be feeding.
     */
    await addSigners(blake);
    const c = change(0n, 43);
    const id = await propose(new Uint8Array(32), c);

    // Zero before anybody approves — a proposal starts at nothing rather than
    // at whatever the map happened to hold for a previous id.
    expect(sim.approvalsFor(id)).toBe(0n);

    await sim.as(sim.applying(ada, c)).approve(id);
    expect(sim.approvalsFor(id)).toBe(1n);

    await sim.as(sim.applying(blake, c)).approve(id);
    expect(sim.approvalsFor(id)).toBe(2n);
  });

  it('does not let a non-signer approve', async () => {
    await addSigners(blake);
    const id = await propose(new Uint8Array(32));
    await expect(sim.as(mallory).approve(id)).rejects.toThrow(/not a signer/i);
  });

  it('refuses to approve a proposal that does not exist', async () => {
    await expect(sim.as(ada).approve(new Uint8Array(32).fill(9)))
      .rejects.toThrow(/no open proposal/i);
  });

  it('holds a second proposal open alongside the first', async () => {
    /*
     * THE OPPOSITE OF WHAT THIS FILE USED TO ASSERT.
     *
     * The test here was `refuses a second proposal while one is open`, checking
     * `assert(!proposalOpen, "a proposal is already open")` — the line that
     * stopped an admin raising a vendor invoice while payroll collected
     * signatures. It was never a requirement: the nullifier was bound to a
     * global round counter, and the round was standing in for "which proposal
     * this approval is for". Binding to the proposal itself answers the same
     * question and removes the queue.
     *
     * Kept in the same place in the file, inverted, so that anyone reinstating
     * the limit fails a test that says why it went.
     */
    const a = await propose(new Uint8Array(32), change(0n, 41));
    const b = await propose(new Uint8Array(32).fill(1), change(0n, 42));
    expect(a).not.toEqual(b);
    expect(sim.isOpen(a)).toBe(true);
    expect(sim.isOpen(b)).toBe(true);
    expect(sim.ledger.openProposals.size()).toBe(2n);
  });

  it('refuses the identical proposal twice', async () => {
    /*
     * The one thing that IS still refused, and it has to be: two proposals with
     * the same id are one entry in the map, so the second would silently adopt
     * the first's approvals. It cannot arise honestly — the salt is fresh on
     * every proposal — so this is against a caller replaying one deliberately.
     */
    const c = change(0n, 41);
    const payload = new Uint8Array(32);
    await propose(payload, c);
    await expect(sim.as(sim.applying(ada, c)).propose(payload))
      .rejects.toThrow(/already open/i);
  });

  /* ---------------- one proposal does not disturb another ---------------- */

  it('lets the same signer approve again after a cancellation', async () => {
    await addSigners(blake);
    const first = change(0n, 41);
    const id = await propose(new Uint8Array(32), first);
    await sim.as(sim.applying(ada, first)).approve(id);
    await sim.as(ada).cancel(id);

    const second = change(0n, 43);
    const next = await propose(new Uint8Array(32).fill(3), second);
    await expect(sim.as(sim.applying(ada, second)).approve(next))
      .resolves.not.toThrow();
  });

  it('carries no approvals from a cancelled proposal to a new one', async () => {
    await addSigners(blake);
    const first = change(0n, 41);
    const id = await propose(new Uint8Array(32), first);
    await sim.as(sim.applying(ada, first)).approve(id);
    await sim.as(sim.applying(blake, first)).approve(id);
    expect(sim.approvalsFor(id)).toBe(2n);

    await sim.as(ada).cancel(id);
    expect(sim.isOpen(id)).toBe(false);

    const second = change(0n, 43);
    const next = await propose(new Uint8Array(32).fill(4), second);
    /*
     * Approvals inheriting across proposals would let a withdrawn one be
     * replaced by a different one carrying its signatures. It cannot happen by
     * construction now rather than by a reset: a count is per proposal, and a
     * new proposal is a new entry starting at zero.
     */
    expect(sim.approvalsFor(next)).toBe(0n);
    /*
     * PROBED THROUGH `setThreshold` RATHER THAN `execute`.
     *
     * This called `execute`, not because the test is about spending — it never
     * was — but because `execute` was the cheapest circuit that went through
     * `requireApproved`. That circuit is gone with the balance ledger, so the
     * probe moved to a governance circuit that goes through the SAME
     * `requireApproved` and refuses for the same reason.
     *
     * The proposal above is not a threshold payload, so this would also be
     * refused for naming the wrong payload — `requireApproved` runs FIRST
     * (`ConfidentialAccount.compact`, `setThreshold`), which is why the message
     * asserted below is the approval one and is the one that fires.
     */
    await expect(sim.as(sim.applying(ada, second)).setThreshold(2n, next))
      .rejects.toThrow(/not enough approvals/i);
  });

  it('cancels one proposal without touching another', async () => {
    /*
     * Impossible while an account had one proposal. `cancel` rotated the
     * round, which burned every approval on the account — so withdrawing a bad
     * proposal cost the signatures already collected on a good one.
     */
    await addSigners(blake);
    const first = change(0n, 41);
    const second = change(0n, 43);
    const a = await propose(new Uint8Array(32), first);
    const b = await propose(new Uint8Array(32).fill(1), second);
    await sim.as(sim.applying(ada, second)).approve(b);

    await sim.as(ada).cancel(a);

    expect(sim.isOpen(a)).toBe(false);
    expect(sim.isOpen(b)).toBe(true);
    expect(sim.approvalsFor(b)).toBe(1n);
  });

  /* ---------------- the tree is plain, not historic ---------------- */

  /*
   * THIS USED TO BE ASSERTED THE OTHER WAY UP, and the reason it flipped is
   * worth keeping attached to the test rather than only in a decision doc.
   *
   * `signers` was a HistoricMerkleTree, which accepts any root it has ever
   * held, and this test asserted that a membership proof taken before other
   * signers joined still verified afterwards. That property is also exactly
   * what made a removed signer unremovable: they could always point at a tree
   * that still contained them. The tree is plain now, so only its current
   * root is accepted — and the cost is this: a cached proof stops verifying
   * once the membership changes.
   *
   * IT COSTS LESS THAN IT LOOKS. The client re-derives a path from public data,
   * so nothing is lost but a cached value, and the case that genuinely changes
   * is a call being proven while a membership change settles — refused rather
   * than mis-applied, and retried by the durable-job layer.
   */
  it('refuses a membership proof taken before the signer set changed', async () => {
    await deploy();
    await addSigners(blake);
    /*
     * Blake's device caches its path now.
     *
     * **HELD IN A LOCAL AND NOT WRITTEN ONTO `blake`, AND THAT IS LOAD-BEARING
     * NOW.** Every line below passes the pin in explicitly, so the
     * assignment onto the shared device object was only storage — and it is now
     * storage with a side effect. Seating Cleo is an approved round, and that
     * round's approvals are made AS blake by the fixture; with a stale pin on
     * the device, `requireSigner` would refuse inside `addSigners(cleo)` and
     * this test would die in its own setup, before the assertion it is named
     * for. Nothing about what it proves changes: the pin is still taken before
     * the tree moves and still presented after.
     */
    const pinned = sim.pathFor(blake);

    // Still good against the tree it was taken from.
    const c = change(0n, 41);
    const id = await propose(new Uint8Array(32), c);
    await expect(sim.as({ ...sim.applying(blake, c), pinnedPath: pinned })
      .approve(id)).resolves.not.toThrow();
    await sim.as(ada).cancel(id);

    // The tree moves on, so the root moves, so the cached proof is stale.
    await addSigners(cleo);

    const c2 = change(0n, 43);
    const id2 = await propose(new Uint8Array(32).fill(2), c2);
    await expect(sim.as({ ...sim.applying(blake, c2), pinnedPath: pinned })
      .approve(id2)).rejects.toThrow(/not a signer/);

    // And Blake is not locked out — he is one re-derived path away.
    await expect(sim.as({ ...sim.applying(blake, c2), pinnedPath: null })
      .approve(id2)).resolves.not.toThrow();
  });

  it('rejects a forged membership path', async () => {
    await addSigners(blake);
    // Mallory replays Blake's path with her own key. The leaf in the path does
    // not match the public key her secret derives, so the root will not check.
    mallory.pinnedPath = sim.pathFor(blake);
    const id = await propose(new Uint8Array(32));
    await expect(sim.as(mallory).approve(id)).rejects.toThrow();
  });

});
