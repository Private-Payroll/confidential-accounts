/**
 * The two contract bugs an external audit found, as regression tests.
 *
 *   THE SEATING HOLE  one compromised signer could add signers freely, which
 *         made the threshold decorative: seat your own signers, then approve
 *         alone.
 *   THE LINKING LEAK  approval nullifiers were a pure function of (secret key,
 *         round), so the same person approving the same round on two accounts
 *         emitted the same bytes on both, and the accounts could be linked.
 *         The second half of that pair is the PROPOSAL ID rather than a round
 *         now, and the leak — and its fix, `kernel.self()` — is unchanged by
 *         that.
 *
 * These run the real compiled circuits in process — every assert, nullifier and
 * Merkle check behaves exactly as it will on chain. No proof server, no node.
 *
 * Written against the ACTUAL failure, not the fix, because a test written
 * from the same mental model as the fix cannot catch the model being wrong.
 * So each test states the attack and asserts it is refused.
 */
import { describe, it, expect } from 'vitest';
import {
  AccountSimulator, privateStateFor, change, ZERO_32, invitePayloadFor, invitedAddressFor, type Change,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);

/** One signer's device. */
type Device = ReturnType<typeof privateStateFor>;

const payload = (n: number) => new Uint8Array(32).fill(n);

/**
 * The change a GOVERNANCE proposal carries.
 *
 * Seating a signer, dropping one or moving the threshold moves no money, so the
 * asset and the amount are beside the point — but every proposal commits to a
 * change, and its SALT became load-bearing in a way it never was under the
 * round design. The id the chain files a proposal under is
 * `proposalIdOf(payload, salt)`, so the device that proposes and the device
 * that later spends the proposal must both carry this salt or the governance
 * circuit will not recognise its own proposal.
 */
const govChange = (seed: number): Change => change(0n, seed);

/** A device carrying `c`'s salt, which is what a governance circuit checks. */
const carrying = (sim: AccountSimulator, d: Device, c: Change) =>
  sim.applying(d, c);

/** Opens a proposal over `p` and answers the id the chain files it under. */
const proposeGov = async (
  sim: AccountSimulator, d: Device, c: Change, p: Uint8Array,
): Promise<Uint8Array> => {
  await sim.as(carrying(sim, d, c)).propose(p);
  return sim.proposalId(p, c.salt);
};

/**
 * A deployed account whose signer set is already at the threshold, reached the
 * way the chain requires — an invitation raised, approved and taken by each
 * invitee with `seatInvited`, then `setThreshold` — every step through the
 * compiled circuit.
 */
const liveAccount = async (threshold = 2n) =>
  AccountSimulator.liveAccount([A, B], threshold);

describe('a signer is seated only by an approved invitation the invitee takes', () => {
  it('there is no unapproved seating, from the first seat onward', async () => {
    /*
     * The account is founded at one seat and one approval, and no seat is ever
     * taken without an approved invitation behind it: naming no proposal is
     * refused, at one seat and one seat later.
     */
    const sim = await AccountSimulator.create(A);
    expect(sim.ledger.signerLeaves.size()).toBe(1n);
    expect(sim.ledger.threshold).toBe(1n);

    await expect(sim.seatInvited(ZERO_32, sim.invited(B, govChange(40)))).rejects.toThrow(
      /does not invite this wallet/i,
    );
    expect(sim.ledger.signerLeaves.size()).toBe(1n);

    await sim.seatSigner(B, [A], 201);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    await expect(sim.seatInvited(ZERO_32, sim.invited(C, govChange(40)))).rejects.toThrow(
      /does not invite this wallet/i,
    );
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('an approved invitation is taken by the invitee, and only once', async () => {
    const sim = await liveAccount();

    // A raises the invitation and B approves it. The proposal commits to the
    // invitee's address and rights, which binds the approvals to this seat.
    const seat = govChange(41);
    const id = await proposeGov(sim, A, seat, invitePayloadFor(C));
    await sim.as(B).approve(id);
    expect(sim.approvalsFor(id)).toBe(2n);

    await sim.seatInvited(id, sim.invited(C, seat));

    expect(sim.ledger.signerLeaves.size()).toBe(3n);
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(C))).toBeTruthy();
    // Consumed, so one approved invitation cannot seat a second leaf.
    expect(sim.isOpen(id)).toBe(false);
    expect(sim.approvalsFor(id)).toBe(-1n);
    const another = { ...privateStateFor(98), invite: invitedAddressFor(C), proposalSalt: seat.salt };
    await expect(sim.seatInvited(id, another)).rejects.toThrow(/no open proposal with that id/i);
  });

  it('one approval short is refused', async () => {
    const sim = await liveAccount();
    const seat = govChange(42);

    const id = await proposeGov(sim, A, seat, invitePayloadFor(C));

    await expect(sim.seatInvited(id, sim.invited(C, seat)))
      .rejects.toThrow(/not enough approvals/);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('a fully approved PAYROLL proposal does not authorise seating anyone', async () => {
    // Without the invitation's own domain, any proposal the signers approved
    // would seat whoever named it — approve a salary run, get a new signer.
    const sim = await liveAccount();
    const spend = govChange(43);

    const id = await proposeGov(sim, A, spend, payload(9));
    await sim.as(B).approve(id);
    expect(sim.approvalsFor(id)).toBe(2n);

    await expect(sim.seatInvited(id, sim.invited(C, spend))).rejects.toThrow(
      /does not invite this wallet/,
    );
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('an approved invitation of C cannot be taken by a different wallet', async () => {
    const sim = await liveAccount();
    const impostor = privateStateFor(99);
    const seat = govChange(44);

    const id = await proposeGov(sim, A, seat, invitePayloadFor(C));
    await sim.as(B).approve(id);

    await expect(sim.seatInvited(id, sim.invited(impostor, seat)))
      .rejects.toThrow(/does not invite this wallet/);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });
});

describe('the same signer approving the same proposal on two accounts', () => {
  /** Every nullifier this account has ever burned, as they appear on chain. */
  const nullifiersOf = (sim: AccountSimulator): string[] =>
    [...(sim.ledger.approvals as any)].map((n: Uint8Array) => Buffer.from(n).toString('hex'));

  /**
   * The nullifier ONE approval burned, isolated from the fixture's.
   *
   * **`approvals` IS APPEND-ONLY AND THE FIXTURE NOW WRITES TO IT.**
   * `liveAccount` seats the second signer and raises the threshold through
   * approved rounds, so three nullifiers are already there before a test acts.
   * `closeProposal` never removes from this set. Reading `[0]` would therefore
   * read a FIXTURE approval and the test would be measuring something it did
   * not perform — still red under the linking mutation, by luck, and green for
   * the wrong reason ever after.
   */
  const nullifierAdded = async (sim: AccountSimulator, act: () => Promise<unknown>) => {
    const before = new Set(nullifiersOf(sim));
    await act();
    const added = nullifiersOf(sim).filter((n) => !before.has(n));
    expect(added).toHaveLength(1);
    return added[0]!;
  };

  it('emits unrelated nullifiers, so the accounts cannot be linked', async () => {
    // Two accounts. Same person, same secret key, same proposal, same everything
    // except which account it is — the situation a company with a payroll
    // account and a treasury account is in on day one.
    const payrollAccount = await liveAccount();
    const treasury = await liveAccount();

    const p = payload(4);
    const c = govChange(51);
    const onPayroll = await proposeGov(payrollAccount, A, c, p);
    const onTreasury = await proposeGov(treasury, A, c, p);

    /*
     * The two accounts genuinely hold the SAME proposal, which is what makes
     * this a fair test of the leak rather than two unrelated approvals.
     *
     * `round` used to carry that point — both accounts sat at round 0 — and
     * there is no round any more. A proposal id is `commit(payload,
     * salt)` and says nothing about which account it is on, so proposing the
     * same payload under the same salt reproduces the id exactly. The nullifier
     * therefore differs on the two accounts for one reason only, which is the
     * fix being tested.
     */
    expect(onPayroll).toEqual(onTreasury);

    const one = await nullifierAdded(payrollAccount,
      () => payrollAccount.as(B).approve(onPayroll));
    const two = await nullifierAdded(treasury,
      () => treasury.as(B).approve(onTreasury));
    expect(one).toBeTruthy();
    expect(two).toBeTruthy();

    // THE LEAK. Equal here means anyone reading the chain can say "the same
    // signer approved on both of those accounts" and, repeated across accounts
    // and proposals, rebuild the membership graph this contract exists to hide —
    // without breaking a commitment or a proof.
    expect(one).not.toBe(two);
  });

  it('still stops the same signer approving the same proposal twice', async () => {
    // The fix must not weaken what the nullifier was for.
    const sim = await liveAccount();
    const id = await proposeGov(sim, A, govChange(52), payload(5));
    await sim.as(B).approve(id);
    /* RED WHEN `approve` stops refusing a nullifier already in `approvals`: B's second approval then counts. */
    await expect(sim.as(B).approve(id)).rejects.toThrow(/already approved/);
    expect(sim.approvalsFor(id)).toBe(2n);
  });

  it('still lets the same signer approve a LATER proposal', async () => {
    /*
     * This used to be "the next round", and the mechanism moved underneath it.
     *
     * Cancelling rotated the round and burned every approval on the account,
     * and the property was that the same signer could then approve again. The
     * round is gone: a nullifier binds to the proposal id, cancelling burns
     * nothing at all, and a second proposal is simply a second, unrelated
     * nullifier. Same property — a signer is not spent by having approved once
     * — asserted against the mechanism that carries it now.
     */
    const sim = await liveAccount();
    const one = await proposeGov(sim, A, govChange(53), payload(6));
    await sim.as(B).approve(one);
    await sim.as(A).cancel(one);

    const two = await proposeGov(sim, A, govChange(54), payload(7));
    await expect(sim.as(B).approve(two)).resolves.not.toThrow();
    expect(sim.approvalsFor(two)).toBe(2n);
  });
});

describe('the same signer cannot be added twice', () => {
  /*
   * Carrying out a proposal closes it, so one approved invitation cannot be
   * replayed; it does not stop TWO different approved invitations seating the
   * same leaf. The leaf-new guard in `seatInvited` refuses that, and the tests
   * below state what one button pressed twice would have done.
   */

  it('THE ACCOUNT-KILLER: two people cannot fill a signer set', async () => {
    /*
     * The consequence, stated as the damage rather than as the rule.
     *
     * Approvals are nullified per SECRET KEY, not per leaf, so B holding two
     * leaves still approves once. Seating A + B + B would reach a seat count of
     * three with two people in it, and a threshold raised to match those seats
     * could then never be met: adding anyone else needs three approvals and
     * three approvals can never be gathered. The account never executes again,
     * with the balance inside it.
     *
     * **THE TITLE SAID *"a 3 of N signer set"* AND THE FIXTURE IS NOT ONE.**
     * The account here lives at a threshold of one for its whole life,
     * because `create` no longer takes a threshold and this test never raises
     * it. The damage above is what a duplicate WOULD cost once the threshold
     * was raised to the seat count, which is what `setThreshold`'s ceiling
     * permits and what the product does. What this test asserts is the slot
     * layout below, and that is true at any threshold — so the fixture is right
     * and the title was the thing that had to change.
     *
     * No attacker. One button pressed twice.
     *
     * ── AND THAT DAMAGE MODEL IS THE COUNTER'S, AND THE COUNTER IS GONE ────
     *
     * The killer above ran through `signerCount`: a duplicate INFLATED it, so
     * bootstrapping ended early at a number larger than the people behind it.
     * The seat count is `signerLeaves.size()` now, and a `Set` insert of a
     * value already present is IDEMPOTENT — so with the guard removed the
     * count would stay at two, bootstrapping would stay open, and every count
     * assertion below would still pass. **Operation (c) closed that killer by
     * construction and left this test asserting a weaker thing than its
     * name.**
     *
     * WHAT THE GUARD STILL PREVENTS: the TREE holding one person in two slots
     * while the set holds them once — which is what would let a removal clear
     * one of B's slots and leave B approving from the other while
     * `signerLeaves` says B is gone.
     *
     * AND THE ONLY THING THAT CAN SEE IT FROM HERE IS WHERE THE NEXT SIGNER
     * LANDS, WHICH IS WHY THAT IS THE LINE ADDED. `findPathForLeaf` answers ONE
     * path, so `slotOf(B)` reads the same either way and asserting it would be
     * an assertion that cannot fail. A duplicate is an APPEND, so it moves the
     * tree's high-water mark: seat the duplicate and C lands in slot 3, refuse
     * it and C lands in slot 2. The counts below no longer distinguish anything
     * — that is operation (c)'s doing and it is stated rather than hidden.
     */
    /*
     * B and C arrive through an invitation each. The duplicate attempt is
     * spelled out rather than folded into a helper: a SECOND, independently
     * approved invitation of B reaches the leaf-new guard with `closeProposal`
     * having no say, which is exactly the case the guard exists for.
     */
    const sim = await AccountSimulator.create(A);
    await sim.seatSigner(B, [A], 210);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);

    const dup = govChange(211);
    const dupId = await proposeGov(sim, A, dup, invitePayloadFor(B));
    await expect(sim.seatInvited(dupId, sim.invited(B, dup))).rejects.toThrow();

    // The account is unharmed and still rescuable by adding a third PERSON.
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    await sim.seatSigner(C, [A, B], 212);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);

    /*
     * THREE PEOPLE IN THREE CONSECUTIVE SLOTS, AND NOTHING VACATED. This is the
     * assertion the guard's removal breaks: a seated duplicate would have taken
     * slot 2 and put C in slot 3, with the tree holding B twice and this
     * account's seat count still reading three.
     */
    expect([sim.slotOf(A), sim.slotOf(B), sim.slotOf(C)]).toEqual([0n, 1n, 2n]);
    expect(sim.vacatedSlots()).toEqual([]);
  });

  it('refuses a second invitation that would seat a leaf already seated', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);

    const seat = govChange(61);
    const id = await proposeGov(sim, A, seat, invitePayloadFor(B));
    await sim.as(B).approve(id);

    /* RED WHEN: seatInvited stops refusing a leaf that is already seated. */
    await expect(sim.seatInvited(id, sim.invited(B, seat)))
      .rejects.toThrow(/already on this account/);
  });

  it('still lets a genuinely new signer in', async () => {
    // The fix must not break the thing it guards.
    const sim = await AccountSimulator.liveAccount([A, B], 2n);

    const seat = govChange(62);
    const id = await proposeGov(sim, A, seat, invitePayloadFor(C));
    await sim.as(B).approve(id);

    await expect(sim.seatInvited(id, sim.invited(C, seat))).resolves.not.toThrow();
    expect(sim.ledger.signerLeaves.size()).toBe(3n);
  });
});

describe('what the contract does when a signer is removed off chain', () => {
  /*
   * NOT a regression test. This one records something the contract CANNOT do,
   * measured against the real compiled circuits, because the alternative was to
   * assume it from reading `signers: HistoricMerkleTree` and be wrong about the
   * most important claim in the product.
   *
   * Removing a signer off chain changes the locks: new viewing key, everything
   * re-sealed, the departing signer's wrapped copy dropped. That is genuinely
   * all it can do off chain, because nobody can be un-taught a key they
   * already hold.
   *
   * What it does NOT do is take their AUTHORITY away. Every circuit begins
   * with `requireSigner()`, which proves a Merkle path into `signers` — an
   * append-only tree with no removal circuit, whose `checkRoot` accepts any
   * historic root on purpose, because a path taken before other signers joined
   * has to stay valid. So a removed signer keeps every power they had.
   */

  /*
   * A live 2-of-2 account. Both devices are seeded from the same view seed,
   * because the account's ASSET BLINDING is derived from it — every signer must
   * compute the same asset key, or the change commitment one of them approves
   * is not the one another recomputes, and the approval is of nothing.
   *
   * NO BALANCE IS SEEDED because there is none to seed. The
   * account keeps no books, and none of the tests below spends.
   */
  const FA = privateStateFor(1);
  const FB = privateStateFor(2);

  /** B is the one the product will show as removed. */
  const removedSignerAccount = async () => {
    const sim = await AccountSimulator.liveAccount([FA, FB], 2n);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    return sim;
  };

  it('a removed signer can still approve, and their approval still counts', async () => {
    const sim = await removedSignerAccount();
    const id = await proposeGov(
      sim, FA, govChange(71), invitePayloadFor(C),
    );
    expect(sim.approvalsFor(id)).toBe(1n);

    // THE POINT. B, whom the product now shows as removed and whose copy of the
    // viewing key we have just invalidated, approves anyway — and it counts
    // towards the threshold exactly as it did the day they joined.
    await expect(sim.as(FB).approve(id)).resolves.not.toThrow();
    expect(sim.approvalsFor(id)).toBe(2n);
  });

  it('an approval publishes nothing that identifies which signer made it', async () => {
    /*
     * THE GUARD RAIL FOR THE ANONYMITY OF AN APPROVAL, and the reason the
     * obvious revocation design is wrong.
     *
     * The tempting fix is a `revoked` set of leaves checked inside
     * `requireSigner()`. Membership in a Compact `Set` requires disclosing the
     * element — so every circuit would publish the CALLER'S LEAF, and every
     * leaf is already public in `signerLeaves`. Approvals would name the
     * approver — the linking leak again, by a different route, and it would
     * trade the property this whole contract exists for in exchange for
     * revocation.
     *
     * This test fails the moment anything starts disclosing the acting leaf.
     */
    const sim = await removedSignerAccount();
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const leaves = [hex(sim.leafOf(FA)), hex(sim.leafOf(FB))];
    const keys = [hex(sim.publicKeyOf(FA)), hex(sim.publicKeyOf(FB))];

    /*
     * Counted before and after, not merely absent afterwards.
     *
     * `signerLeaves` is a public Set that legitimately holds every leaf, so
     * "the leaf does not appear in the public state" is false already and a
     * test asserting it could only ever fail. What must not happen is that an
     * ACTION adds an occurrence — that is what disclosure looks like on chain.
     */
    const publicState = () => JSON.stringify(sim.ledger, (_k, v) =>
      (v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? String(v) : v));
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    const id = await proposeGov(sim, FA, govChange(72), payload(3));
    const before = publicState();
    const nullifiersBefore = [...(sim.ledger.approvals as any)]
      .map((n: Uint8Array) => hex(n));

    await sim.as(FB).approve(id);
    const after = publicState();

    for (const identifying of [...leaves, ...keys]) {
      expect(occurrences(after, identifying)).toBe(occurrences(before, identifying));
    }

    /*
     * And the nullifier the approval did publish is none of those things.
     *
     * **THE DIFFERENCE, NOT THE TOTAL, AND THE FIXTURE IS WHY.** `approvals`
     * is append-only — `closeProposal` clears `openProposals`,
     * `approvalCounts` and `runWindow` and never this set — so it holds every
     * nullifier the account has ever burned. That was one until the fixture
     * stopped using the bootstrap window: `liveAccount` now seats `FB` and
     * raises the threshold through approved rounds, and each of those
     * approvals burns a nullifier before this test starts. **A test that
     * counts the whole set is a test whose fixture can silently change what it
     * asserts**, which is what happened here — so it counts what THIS approval
     * added.
     */
    const nullifiers = () => [...(sim.ledger.approvals as any)].map((n: Uint8Array) => hex(n));
    const publishedBefore = new Set(nullifiersBefore);
    const published = nullifiers().filter((n) => !publishedBefore.has(n));
    expect(published).toHaveLength(1);
    for (const identifying of [...leaves, ...keys]) {
      expect(published).not.toContain(identifying);
    }
  });

  it('and that is exactly what removeSigner fixes — it exists now', async () => {
    /*
     * This test used to assert `removeSigner` was ABSENT, which is how the gap
     * was recorded before there was a fix. It is inverted rather than deleted
     * so the two facts stay attached: the behaviour above is what the contract
     * does when a signer is dropped off chain only, and the circuit below is
     * the thing that makes dropping them mean something. The circuit is
     * `amendSigner`, which only removes.
     */
    const sim = await removedSignerAccount();
    expect(Object.keys(sim.contract.impureCircuits)).toContain('amendSigner');
  });
});

describe('slotOf: reading a signer\'s slot back out of their membership path', () => {
  /*
   * `slotOf` reconstructs a signer's position from the left/right flags in
   * their membership path. The probe proved that COMPILES. Nothing had ever run
   * it, and the failure mode if the bit order or the polarity is wrong is the
   * worst one available: a removal clears somebody else's slot, the contract
   * removes a signer nobody voted to remove, and it looks like a clean success.
   *
   * So it is pinned against the runtime's own indexing before anything trusts
   * it. This is not a second implementation of the rule — `pathForLeaf(i, …)`
   * is the runtime saying "here is the path to index i", and the assertion is
   * that the circuit reads the same number back out.
   */
  const A2 = privateStateFor(1);

  /**
   * A membership path with nothing real in it but the left/right flags.
   *
   * `slotOf` reads only those, so this exercises the ARITHMETIC — bit order and
   * the weight of each level — at indices a real account would take years to
   * reach. It cannot check the CONVENTION, because it encodes the same
   * convention it is testing; the test below does that against the runtime.
   */
  const syntheticPath = (index: bigint) => ({
    leaf: new Uint8Array(32),
    path: Array.from({ length: 10 }, (_, level) => ({
      sibling: { field: 0n },
      goes_left: ((index >> BigInt(level)) & 1n) === 0n,
    })),
  });

  it('reads a slot number out of the path flags, at every bit of the depth', () => {
    /*
     * Every power of two, so a transposed or reversed bit shows up rather than
     * hiding in the low bits — plus 1023, where every flag is set, and 0, where
     * none is. A derivation that is right for 0 and 1 and wrong for 512 is
     * exactly the bug this catches.
     */
    for (const i of [0n, 1n, 2n, 3n, 4n, 8n, 16n, 32n, 64n, 128n, 256n, 512n, 513n, 1023n]) {
      expect(pureCircuits.slotOf(syntheticPath(i) as never)).toBe(i);
    }
  });

  it('AND AGREES WITH THE RUNTIME on the slots a real account actually uses', async () => {
    /*
     * The other half, and the one that catches a wrong convention rather than
     * wrong arithmetic: if `goes_left` means the opposite of what the test
     * above assumes, that test still passes and this one does not.
     *
     * The expected slots come from the runtime's own append order, not from
     * anything this file computes. Note what CANNOT be tested this way — the
     * tree is sparse, so there is no path to an index nobody has written, and
     * reaching bit 9 honestly would mean seating 513 signers.
     */
    const sim = await AccountSimulator.create(A2);
    const people = [privateStateFor(2), privateStateFor(3), privateStateFor(4)];
    expect(sim.slotOf(A2)).toBe(0n);
    /* Seated through approved rounds; the APPEND ORDER is what this test
     * reads and it is unchanged by how the seating is authorised. */
    const seated = [A2];
    for (const [i, p] of people.entries()) {
      await sim.seatSigner(p, [...seated], 220 + i);
      seated.push(p);
      expect(sim.slotOf(p)).toBe(BigInt(i + 1));
    }
  });
});

describe('removing a signer by clearing one slot', () => {
  const FA = privateStateFor(1);
  const FB = privateStateFor(2);
  const FC = privateStateFor(3);
  const FD = privateStateFor(4);
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

  /** A live 2-of-3, which is the smallest account that can lose somebody. */
  const threeSigners = async () => {
    const sim = await AccountSimulator.liveAccount([FA, FB], 2n);
    const seat = govChange(81);
    const id = await proposeGov(sim, FA, seat, invitePayloadFor(FC));
    await sim.as(FB).approve(id);
    await sim.seatInvited(id, sim.invited(FC, seat));
    expect(sim.ledger.signerLeaves.size()).toBe(3n);
    return sim;
  };

  /**
   * Gets a removal approved, and answers what the caller needs to spend it: the
   * proposal's id, and the change whose salt the removing device must carry.
   */
  const removalApproved = async (sim: AccountSimulator, leaf: Uint8Array, seed = 82) => {
    const c = govChange(seed);
    const id = await proposeGov(sim, FA, c, pureCircuits.removeSignerPayload(leaf));
    await sim.as(FB).approve(id);
    return { id, c };
  };

  it('a removed signer can no longer approve — what off-chain removal cannot do', async () => {
    const sim = await threeSigners();

    // C approves first, so a refusal afterwards cannot be "C never could".
    const probe = await proposeGov(sim, FA, govChange(83), payload(1));
    await expect(sim.as(FC).approve(probe)).resolves.not.toThrow();
    await sim.as(FA).cancel(probe);

    const leafC = sim.leafOf(FC);
    const { id, c } = await removalApproved(sim, leafC);
    await sim.as(carrying(sim, FA, c)).removeSigner(leafC, id);

    expect(sim.ledger.signerLeaves.size()).toBe(2n);

    // THE POINT. C still holds their key and their blinding — the leaf they can
    // compute is the same value it always was. It is simply not in the tree any
    // more, and nothing on chain named which signer they are.
    const after = await proposeGov(sim, FA, govChange(84), payload(9));
    await expect(sim.as(FC).approve(after)).rejects.toThrow(/not a signer/);
  });

  it('NOBODY ELSE IS TOUCHED — the survivors keep their slots and their leaves', async () => {
    /*
     * The whole of the slot design in one assertion. The design it replaces
     * advanced a generation stamped on every leaf and re-seated every
     * survivor, so a removal rewrote the entire signer set and any mistake in
     * the list was unrecoverable. Here the survivors are expected to be
     * bit-for-bit where they were.
     */
    const sim = await threeSigners();
    const before = {
      a: { slot: sim.slotOf(FA), leaf: hex(sim.leafOf(FA)) },
      b: { slot: sim.slotOf(FB), leaf: hex(sim.leafOf(FB)) },
    };

    const leafC = sim.leafOf(FC);
    const { id, c } = await removalApproved(sim, leafC);
    await sim.as(carrying(sim, FA, c)).removeSigner(leafC, id);

    expect({ slot: sim.slotOf(FA), leaf: hex(sim.leafOf(FA)) }).toEqual(before.a);
    expect({ slot: sim.slotOf(FB), leaf: hex(sim.leafOf(FB)) }).toEqual(before.b);

    // And they can still act, without being re-added by hand.
    const later = await proposeGov(sim, FA, govChange(85), payload(4));
    await expect(sim.as(FB).approve(later)).resolves.not.toThrow();
    expect(sim.approvalsFor(later)).toBe(2n);
  });

  it('clears the RIGHT slot when the person leaving is not the last one seated', async () => {
    /*
     * The failure this is written against: `slotOf` derives the position from
     * the path's flags, and a derivation that is subtly wrong would clear a
     * different slot. Removing the last signer added would hide that — the
     * wrong answer and the right answer are too close together. So this removes
     * the one in the MIDDLE of a four-signer account and checks the two either
     * side of them are untouched.
     */
    const sim = await AccountSimulator.liveAccount([FA, FB], 2n);
    for (const [i, d] of [FC, FD].entries()) {
      const seat = govChange(86 + i);
      const id = await proposeGov(sim, FA, seat, invitePayloadFor(d));
      await sim.as(FB).approve(id);
      await sim.seatInvited(id, sim.invited(d, seat));
    }
    expect(sim.ledger.signerLeaves.size()).toBe(4n);
    expect([sim.slotOf(FA), sim.slotOf(FB), sim.slotOf(FC), sim.slotOf(FD)])
      .toEqual([0n, 1n, 2n, 3n]);

    const leafC = sim.leafOf(FC);
    const { id, c } = await removalApproved(sim, leafC);
    await sim.as(carrying(sim, FA, c)).removeSigner(leafC, id);

    // Slot 2 is empty, and 0, 1 and 3 are exactly as they were.
    expect(sim.ledger.signers.findPathForLeaf(leafC)).toBeUndefined();
    expect([sim.slotOf(FA), sim.slotOf(FB), sim.slotOf(FD)]).toEqual([0n, 1n, 3n]);

    // D, seated AFTER the person removed, is the one a wrong derivation would
    // most plausibly have hit. They can still approve.
    const later = await proposeGov(sim, FA, govChange(88), payload(6));
    await expect(sim.as(FD).approve(later)).resolves.not.toThrow();
    await expect(sim.as(FC).approve(later)).rejects.toThrow(/not a signer/);
  });

  it('a vacated slot is REUSED, so the tree does not bound how many additions an account can make',
    async () => {
      /*
       * Without reuse, the tree would limit the number of ADDITIONS over an
       * account's life rather than the number of signers it holds — the same
       * trap as the tree-exhaustion defect the re-seating design had, in a new
       * place. Reuse needs no free-list: taking a slot is proving it is empty,
       * which is the same proof a removal makes about its own slot.
       */
      const sim = await threeSigners();
      const vacated = sim.slotOf(FC);
      const leafC = sim.leafOf(FC);
      const { id, c } = await removalApproved(sim, leafC);
      await sim.as(carrying(sim, FA, c)).removeSigner(leafC, id);

      // The removal left the slot marked vacant, which is what makes it findable
      // at all — a blanked slot would be indistinguishable from one never used,
      // and the sparse tree has no path to those.
      expect(sim.vacatedSlots()).toEqual([vacated]);

      const seat = govChange(89);
      const seatId = await proposeGov(sim, FA, seat, invitePayloadFor(FD));
      await sim.as(FB).approve(seatId);
      await sim.seatInvited(seatId, sim.invited(FD, seat), true);

      // The new signer took the slot the old one left, rather than a fresh one.
      expect(sim.slotOf(FD)).toBe(vacated);
      expect(sim.vacatedSlots()).toEqual([]);
      expect(sim.ledger.signerLeaves.size()).toBe(3n);

      const later = await proposeGov(sim, FA, govChange(90), payload(8));
      await expect(sim.as(FD).approve(later)).resolves.not.toThrow();
    });

  it('refuses a removal with no approved proposal behind it', async () => {
    const sim = await threeSigners();
    // `ZERO_32` names no proposal on any account, which is what "there is no
    // approved round behind this" looks like now the account can hold several.
    await expect(sim.as(FA).removeSigner(sim.leafOf(FC), ZERO_32))
      .rejects.toThrow(/no open proposal with that id/i);
  });

  it('refuses a removal one approval short', async () => {
    const sim = await threeSigners();
    const leafC = sim.leafOf(FC);
    const c = govChange(91);
    const id = await proposeGov(sim, FA, c, pureCircuits.removeSignerPayload(leafC));
    await expect(sim.as(carrying(sim, FA, c)).removeSigner(leafC, id))
      .rejects.toThrow(/not enough approvals/);
  });

  it('refuses to remove somebody the signers did not approve removing', async () => {
    // The approved proposal names one leaf. Swapping it at the last moment would
    // remove a different person with the same approvals behind it. That
    // lesson: the thing being approved has to be part of what is approved.
    const sim = await threeSigners();
    const { id, c } = await removalApproved(sim, sim.leafOf(FC));
    await expect(sim.as(carrying(sim, FA, c)).removeSigner(sim.leafOf(FB), id))
      .rejects.toThrow(/not for this removal/);
  });

  it('a fully approved PAYROLL proposal does not authorise a removal', async () => {
    const sim = await threeSigners();
    const spend = govChange(92);
    const id = await proposeGov(sim, FA, spend, payload(9));
    await sim.as(FB).approve(id);
    await expect(sim.as(carrying(sim, FA, spend)).removeSigner(sim.leafOf(FC), id))
      .rejects.toThrow(/not for this removal/);
  });

  it('refuses to remove somebody who is not on the account', async () => {
    const sim = await threeSigners();
    const stranger = privateStateFor(99);
    const leaf = sim.leafOf(stranger);
    const { id, c } = await removalApproved(sim, leaf);
    await expect(sim.as(carrying(sim, FA, c)).removeSigner(leaf, id)).rejects.toThrow();
  });

  it('refuses to strand the account below its own threshold', async () => {
    // Removing from a 2-of-2 leaves one signer against a threshold of two: the
    // account could never approve anything again, with the balance inside it.
    const sim = await AccountSimulator.liveAccount([FA, FB], 2n);
    const leafB = sim.leafOf(FB);
    const { id, c } = await removalApproved(sim, leafB);
    await expect(sim.as(carrying(sim, FA, c)).removeSigner(leafB, id))
      .rejects.toThrow(/fewer signers than the threshold/);
  });

  it('AND THEREFORE a removal never leaves the account below its threshold or seating without approvals', async () => {
    /*
     * A removal that dropped the seats below the threshold would leave an
     * account that can never approve again. The refusal above is that floor;
     * this asserts the consequence at three of three, and that nobody can be
     * seated without an approved invitation either side of the attempt. Invert
     * the removal floor and the removal below succeeds and the count after it
     * fails.
     */
    const sim = await AccountSimulator.liveAccount([FA, FB, FC], 3n);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);

    // No unapproved seating, at any seat count: D cannot take a seat nobody approved.
    await expect(sim.seatInvited(ZERO_32, sim.invited(FD, govChange(92))))
      .rejects.toThrow(/does not invite this wallet/i);

    // A and B approve removing C. At 3 of 3 they cannot reach the threshold, so
    // this is refused for want of approvals — and even with C's own approval it
    // would be refused for stranding the account. Either way the count holds.
    const c = govChange(93);
    const id = await proposeGov(sim, FA, c, pureCircuits.removeSignerPayload(sim.leafOf(FC)));
    await sim.as(FB).approve(id);
    await sim.as(FC).approve(id);
    await expect(sim.as(carrying(sim, FA, c)).removeSigner(sim.leafOf(FC), id))
      .rejects.toThrow(/fewer signers than the threshold/);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);

    // And still nobody is seated without an approved invitation.
    await expect(sim.seatInvited(ZERO_32, sim.invited(FD, govChange(92)))).rejects.toThrow();
  });

  it('refuses to reuse a slot when nothing has been vacated', async () => {
    /*
     * Asking for a vacated slot on an account that has never lost anybody must
     * fail rather than land somewhere. The sparse tree is why the two seating
     * paths exist at all, so the wrong one has to be refused rather than
     * silently corrected.
     */
    const sim = await threeSigners();
    const seat = govChange(96);
    const id = await proposeGov(sim, FA, seat, invitePayloadFor(FD));
    await sim.as(FB).approve(id);
    await expect(sim.seatInvited(id, sim.invited(FD, seat), true)).rejects.toThrow();
  });

  it('THE ONE THAT WOULD REMOVE THE WRONG PERSON: a path must be for the leaf it claims',
    async () => {
      /*
       * The most dangerous failure available in this design, written as the
       * attack rather than as the rule.
       *
       * `removeSigner` derives the slot to clear from the path it is handed. The
       * approved proposal names WHO is leaving, and `slotOf` names WHERE — so if
       * nothing bound the path to that leaf, a caller with an approved removal
       * of C could hand over B's path and clear B's slot instead. The removal
       * would settle, the chain would look correct, and the account would have
       * removed a signer nobody voted to remove.
       *
       * The attacker is B, a REAL signer, and that is what makes it live: B
       * proves membership honestly with their own path, then offers that same
       * path as the one for the leaf being removed. Every check but this one is
       * satisfied — B really is a signer, the proposal really did approve
       * removing C, and the path really is in the tree.
       */
      const sim = await threeSigners();
      const leafC = sim.leafOf(FC);
      const blakesSlot = sim.slotOf(FB);
      const { id, c } = await removalApproved(sim, leafC);

      /*
       * B carries the PROPOSER'S salt as well as their own path. That is not a
       * contrivance — the proposal salt travels between signers inside the
       * sealed payload (decision 0002), so every approver legitimately holds
       * it, and it is also what derives the proposal's public id.
       * Without it this test would stop at the proposal-commitment check and
       * never reach the line it exists to exercise.
       */
      const liar = sim.dishonest(carrying(sim, FB, c), sim.pathFor(FB));
      await expect(sim.as(liar).removeSigner(leafC, id))
        .rejects.toThrow(/not for the leaf being removed/);

      // And B is untouched: still seated, still in the same slot, still able to act.
      expect(sim.slotOf(FB)).toBe(blakesSlot);
      expect(sim.ledger.signerLeaves.size()).toBe(3n);
    });

  it('THE ONE THAT WOULD SEAT SOMEBODY ON TOP OF A LIVE SIGNER: a reused slot must be vacant',
    async () => {
      /*
       * The same shape on the other side. `seatInvited`'s reuse path takes the
       * slot the supplied path leads to. If nothing checked that the slot holds
       * the vacancy marker, an invitee could hand over a LIVE signer's path and
       * overwrite them — a removal with no proposal, no approvals and no record.
       *
       * Note it is the leaf check that catches this and not `checkRoot`: the
       * path is genuine, so the root verifies. That is the whole reason the
       * check is a separate line.
       */
      const sim = await threeSigners();
      const seat = govChange(97);
      const id = await proposeGov(sim, FA, seat, invitePayloadFor(FD));
      await sim.as(FB).approve(id);

      const liar = sim.dishonest(sim.invited(FD, seat), sim.pathFor(FB));
      await expect(sim.seatInvited(id, liar, true))
        .rejects.toThrow(/has not been vacated/);

      // B is still seated, in the same slot, with the same leaf.
      expect(sim.ledger.signerLeaves.size()).toBe(3n);
      expect(sim.slotOf(FB)).toBe(1n);
      expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(FB))).toBeTruthy();
    });

  it('a removal publishes nothing that identifies who performed it', async () => {
    /*
     * The guard rail applied to the new circuit. A removal names the leaf being
     * REMOVED — it must, that is what was agreed — but it must not name the
     * signer doing the removing, any more than an approval does.
     */
    const sim = await threeSigners();
    const leafC = sim.leafOf(FC);
    const { id, c } = await removalApproved(sim, leafC);

    const publicState = () => JSON.stringify(sim.ledger, (_k, v) =>
      (v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? String(v) : v));
    const occurrences = (h: string, n: string) => h.split(n).length - 1;
    const before = publicState();

    await sim.as(carrying(sim, FA, c)).removeSigner(leafC, id);
    const after = publicState();

    // A performed it. Nothing about A appeared that was not there already.
    for (const identifying of [hex(sim.leafOf(FA)), hex(sim.publicKeyOf(FA)),
                               hex(sim.publicKeyOf(FB))]) {
      expect(occurrences(after, identifying)).toBe(occurrences(before, identifying));
    }
    // And no public key is on chain at all — only blinded leaves ever are.
    expect(after).not.toContain(hex(sim.publicKeyOf(FA)));
  });
});

describe('changing the threshold, against the compiled circuits', () => {
  /*
   * The threshold used to be a `sealed` ledger field — writable once, in the
   * constructor — so the product's `setThreshold` moved our own copy and
   * nothing else, and an account could be told it needed three approvals while
   * the chain settled at two. It is unsealed now, and moved by an approved
   * proposal like everything else.
   */
  const TA = privateStateFor(1);
  const TB = privateStateFor(2);
  const TC = privateStateFor(3);
  const TD = privateStateFor(4);

  /** A live 2-of-3. */
  const threeSigners = async () => {
    const sim = await AccountSimulator.liveAccount([TA, TB], 2n);
    const seat = govChange(101);
    const id = await proposeGov(sim, TA, seat, invitePayloadFor(TC));
    await sim.as(TB).approve(id);
    await sim.seatInvited(id, sim.invited(TC, seat));
    expect(sim.ledger.threshold).toBe(2n);
    return sim;
  };

  /**
   * Gets a threshold change approved, and answers the id plus the change whose
   * salt the device calling `setThreshold` has to carry.
   */
  const changeApproved = async (
    sim: AccountSimulator, to: bigint, who: Device[], seed = 102,
  ) => {
    const c = govChange(seed);
    const id = await proposeGov(sim, TA, c, pureCircuits.setThresholdPayload(to));
    for (const d of who.filter((a) => a !== TA)) await sim.as(d).approve(id);
    return { id, c };
  };

  it('raises the threshold, and the chain enforces the new one immediately', async () => {
    const sim = await threeSigners();
    const { id, c } = await changeApproved(sim, 3n, [TA, TB]);
    await sim.as(carrying(sim, TA, c)).setThreshold(3n, id);
    expect(sim.ledger.threshold).toBe(3n);

    // The very next proposal needs three, not two. This is the assertion that
    // the old design could not make: our copy moved and the chain's did not.
    const next = await proposeGov(sim, TA, govChange(103), payload(1));
    await sim.as(TB).approve(next);
    /*
     * PROBED THROUGH `setThreshold` RATHER THAN `execute`.
     *
     * `execute` was the cheapest circuit that went through `requireApproved`,
     * and it is gone with the account's balance ledger.
     *
     * **AND IT MUST BE `setThreshold` RATHER THAN `adopt`, WHICH IS WHAT THIS
     * WAS FIRST POINTED AT.** The order of the asserts inside the substitute
     * decides which message comes back. `adopt` checks its payload FIRST and
     * calls `requireApproved` second, so a proposal that is not an adopt
     * payload — and `next` is not — refuses with "that proposal does not
     * authorise adopting this vault" and never reaches the approval count.
     * `setThreshold` calls `requireApproved` first, so the approval bar is what
     * answers. A substitute is checked against the circuit, not assumed from
     * the fact that both call the same helper somewhere.
     */
    await expect(sim.as(TA).setThreshold(3n, next))
      .rejects.toThrow(/not enough approvals/);
    await sim.as(TC).approve(next);
    expect(sim.approvalsFor(next)).toBe(3n);
  });

  it('THE HOLE THIS FEATURE OPENS: the threshold may not exceed the signers', async () => {
    /*
     * A threshold above the seats would leave an account that can never
     * approve anything again, so an approved change to more than the seats is
     * refused and the threshold stays where it was.
     */
    const sim = await threeSigners();
    const { id, c } = await changeApproved(sim, 4n, [TA, TB]);
    await expect(sim.as(carrying(sim, TA, c)).setThreshold(4n, id))
      .rejects.toThrow(/cannot exceed the number of signers/);
    expect(sim.ledger.threshold).toBe(2n);

    /*
     * And the approved threshold proposal, still open, seats nobody: its
     * payload is not an invitation. Then it is cancelled and there is nothing
     * to name at all.
     */
    await expect(sim.seatInvited(id, sim.invited(TD, c)))
      .rejects.toThrow(/does not invite this wallet/);
    await sim.as(TA).cancel(id);
    await expect(sim.seatInvited(ZERO_32, sim.invited(TD, c)))
      .rejects.toThrow(/does not invite this wallet/i);
  });

  it('refuses a threshold of zero, which would be an account with no rule', async () => {
    const sim = await threeSigners();
    const { id, c } = await changeApproved(sim, 0n, [TA, TB]);
    await expect(sim.as(carrying(sim, TA, c)).setThreshold(0n, id))
      .rejects.toThrow(/at least one/);
    expect(sim.ledger.threshold).toBe(2n);
  });

  it('refuses a change with no approved proposal behind it', async () => {
    const sim = await threeSigners();
    await expect(sim.as(TA).setThreshold(3n, ZERO_32))
      .rejects.toThrow(/no open proposal with that id/i);
  });

  it('refuses a change one approval short', async () => {
    const sim = await threeSigners();
    const { id, c } = await changeApproved(sim, 3n, [TA]);
    await expect(sim.as(carrying(sim, TA, c)).setThreshold(3n, id))
      .rejects.toThrow(/not enough approvals/);
    expect(sim.ledger.threshold).toBe(2n);
  });

  it('a fully approved PAYROLL proposal does not authorise a threshold change', async () => {
    // The domain separator earning its place: an approval to pay must not be
    // spendable as an approval to change the rule that governs paying.
    const sim = await threeSigners();
    const spend = govChange(104);
    const id = await proposeGov(sim, TA, spend, payload(7));
    await sim.as(TB).approve(id);
    await expect(sim.as(carrying(sim, TA, spend)).setThreshold(3n, id))
      .rejects.toThrow(/not for this threshold/);
    expect(sim.ledger.threshold).toBe(2n);
  });

  it('an approved change to 3 cannot be swapped for a different number', async () => {
    const sim = await threeSigners();
    const { id, c } = await changeApproved(sim, 3n, [TA, TB]);
    await expect(sim.as(carrying(sim, TA, c)).setThreshold(1n, id))
      .rejects.toThrow(/not for this threshold/);
    expect(sim.ledger.threshold).toBe(2n);
  });

  it('consumes the proposal, so one approved change cannot be replayed', async () => {
    const sim = await threeSigners();
    const { id, c } = await changeApproved(sim, 3n, [TA, TB]);
    await sim.as(carrying(sim, TA, c)).setThreshold(3n, id);

    /*
     * The round counter this used to assert on is gone.
     *
     * It stood for "something consumed the account's one proposal" — `propose`
     * reset the approvals without bumping it, and only an operation that
     * SETTLED moved it on. With several proposals open at once a single global
     * counter cannot say which one was consumed, so consumption is now exactly
     * what it always meant: both of that proposal's map entries are gone. The
     * replay below is the property the round assertion existed to protect, and
     * it is asserted directly rather than through a counter.
     */
    expect(sim.isOpen(id)).toBe(false);
    expect(sim.approvalsFor(id)).toBe(-1n);
    await expect(sim.as(carrying(sim, TA, c)).setThreshold(3n, id))
      .rejects.toThrow(/no open proposal with that id/i);
  });
});
