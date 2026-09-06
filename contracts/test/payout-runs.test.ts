/**
 * V-41 and V-43: a payroll run, paid one payee at a time.
 *
 * The design chosen: signers approve ONE proposal covering a whole run, and
 * the vault pays each person by proving that person belongs to it. Five
 * employees cost five payments; two hundred cost two hundred.
 *
 * The one to read first is "reading one payment off the chain does not let you
 * claim the next payee". That is the attack this design creates and then
 * closes, and it is why a leaf commits to a per-payee secret rather than simply
 * to the payment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountSimulator, privateStateFor, change, type Change,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { buildPayoutTree, payoutLeafOf, rootOfLeaves, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** A vault is any 32 bytes as far as the account is concerned; it never dereferences one. */
const PAYROLL = new Uint8Array(32).fill(0xa1);
const TREASURY = new Uint8Array(32).fill(0xb2);

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

/**
 * A run of `n` payees.
 *
 * The details are opaque bytes here on purpose: the account cannot tell a payee
 * from a hash, and neither can this test. What the vault puts inside them is
 * the vault's business and is tested against the vault.
 */
const runOf = (n: number, seed = 0): PayoutLeafInput[] =>
  Array.from({ length: n }, (_, i) => ({
    details: toHex(bytes(seed + i + 1)),
    nonce: toHex(bytes(seed + i + 101)),
  }));

/*
 * A FIXED CLOCK, AND EVERY TEST RUNS ON IT. V-67.
 *
 * A run's payments assert they fall inside an approved window, so these tests
 * have to control the time rather than inherit it. Seconds since the Unix
 * epoch, matching `secondsSinceEpoch` in the runtime — milliseconds here would
 * put every test tens of thousands of years past every window and each assert
 * would pass for the wrong reason.
 */
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);

const liveAccount = async (threshold = 2n) => {
  const sim = await AccountSimulator.liveAccount([A, B], threshold);
  sim.at(NOW);
  return sim;
};

/** Raises and approves a run for `vault`, and hands back everything a payer needs. */
const approvedRun = async (
  sim: AccountSimulator, vault: Uint8Array, payments: PayoutLeafInput[], c: Change,
  window: { from: bigint; until: bigint } = { from: OPENS, until: CLOSES },
) => {
  const tree = buildPayoutTree(payments);
  const payload = pureCircuits.runPayload(
    fromHex(tree.root), tree.payees, window.from, window.until);
  await sim.as(carrying(sim, A, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees,
    from: window.from, until: window.until, vault,
  });
  const id = sim.proposalId(payload, c.salt, vault);
  await sim.as(carrying(sim, A, c)).approve(id);
  await sim.as(carrying(sim, B, c)).approve(id);
  return { tree, id, payload, window };
};

/** The arguments for paying payee `i` of a run. */
const claimFor = (
  run: {
    tree: ReturnType<typeof buildPayoutTree>;
    id: Uint8Array;
    window?: { from: bigint; until: bigint };
  },
  payments: PayoutLeafInput[], vault: Uint8Array, c: Change, i: number,
) => ({
  proposal: run.id,
  vault,
  root: fromHex(run.tree.root),
  payees: run.tree.payees,
  from: run.window?.from ?? OPENS,
  until: run.window?.until ?? CLOSES,
  salt: c.salt,
  details: fromHex(payments[i].details),
  nonce: fromHex(payments[i].nonce),
  path: run.tree.pathFor(i),
});

describe('V-41: a run is paid one payee at a time', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await liveAccount(); });

  it('THE HEADLINE: a five-payee run takes five payments, and nothing ends it but time', async () => {
    const c = govChange(11);
    const payments = runOf(5);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    for (let i = 0; i < 5; i++) {
      expect(sim.isOpen(run.id)).toBe(true);
      await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, i));
    }

    /*
     * V-61/V-67. THE PROPOSAL IS STILL OPEN, AND THAT IS THE CHANGE.
     *
     * It used to close on the fifth payment, by decrementing a per-run counter
     * — which is a read-modify-write of one map entry done by every payment of
     * the run, so the second payment in a block was rejected and payroll
     * serialised. There is no counter now. A run stops being payable when its
     * window shuts, and whether it FINISHED is derived from the payments, not
     * asserted by the chain.
     */
    expect(sim.isOpen(run.id)).toBe(true);
    expect(sim.runWindow(run.id)).toEqual({ from: OPENS, until: CLOSES });

    // Every payment is on chain, which is where "who is still outstanding" is read.
    for (const leaf of run.tree.leaves) {
      expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(leaf)))).toBe(true);
    }

    // And the row is swept once the window has passed — by anyone, signer or not.
    await expect(sim.at(NOW).as(carrying(sim, A, c)).closeExpiredRun(run.id))
      .rejects.toThrow(/window for this run has not closed yet/i);
    await sim.at(Number(CLOSES)).as(carrying(sim, A, c)).closeExpiredRun(run.id);
    expect(sim.isOpen(run.id)).toBe(false);
    expect(sim.runWindow(run.id)).toBeUndefined();
    sim.at(NOW);
  });

  it('a payment before the window opens is refused, and works once it does', async () => {
    /*
     * V-67. This is what makes a scheduled payroll possible: six months
     * approved in one sitting, and month four cannot be paid in month one.
     */
    const c = govChange(31);
    const payments = runOf(1);
    const future = { from: BigInt(NOW + 86_400), until: BigInt(NOW + 172_800) };
    const run = await approvedRun(sim, PAYROLL, payments, c, future);

    await expect(sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 0)))
      .rejects.toThrow(/has not started/i);

    await sim.at(NOW + 86_400).as(carrying(sim, A, c))
      .recordPayment(claimFor(run, payments, PAYROLL, c, 0));
    sim.at(NOW);
  });

  it('a payment after the window closes is refused, and the unpaid are stranded', async () => {
    /*
     * The honest cost of the window, tested rather than described. Three of
     * four paid, the window shuts, and the last one needs a new proposal.
     */
    const c = govChange(32);
    const payments = runOf(4);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    for (let i = 0; i < 3; i++) {
      await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, i));
    }

    sim.at(Number(CLOSES));
    await expect(sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 3)))
      .rejects.toThrow(/window for this run has closed/i);

    // The three that landed stay landed. Nothing is unwound by expiry.
    for (let i = 0; i < 3; i++) {
      expect(sim.ledger.movements.member(
        pureCircuits.paidMovementOf(fromHex(run.tree.leaves[i])))).toBe(true);
    }
    sim.at(NOW);
  });

  it('A RETRY RUN CAN PAY A STRAGGLER WHILE THE ORIGINAL IS STILL OPEN, AND CANNOT DOUBLE-PAY',
    async () => {
    /*
     * V-64, and the reason a payment's record is its leaf rather than the leaf
     * and the proposal together. Without this, the same person exists twice —
     * once under each run — and both can settle.
     */
    const c = govChange(33);
    const payments = runOf(4);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 0));
    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 1));

    // The operator retries the two that were missed, REUSING their leaves.
    const c2 = govChange(34);
    const outstanding = [payments[2], payments[3]];
    const retry = await approvedRun(sim, PAYROLL, outstanding, c2);

    await sim.as(carrying(sim, A, c2)).recordPayment(claimFor(retry, outstanding, PAYROLL, c2, 0));

    // Now the ORIGINAL run tries the same person. Both proposals are open.
    expect(sim.isOpen(run.id)).toBe(true);
    expect(sim.isOpen(retry.id)).toBe(true);
    await expect(sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 2)))
      .rejects.toThrow(/already been made/i);

    // And the one nobody has paid yet still goes through, from either run.
    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 3));
    await expect(sim.as(carrying(sim, A, c2)).recordPayment(claimFor(retry, outstanding, PAYROLL, c2, 1)))
      .rejects.toThrow(/already been made/i);
  });

  it('a one-payee run is the same mechanism, not a special case', async () => {
    const c = govChange(12);
    const payments = runOf(1);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 0));
    // Open until its window shuts, exactly like a run of five hundred.
    expect(sim.isOpen(run.id)).toBe(true);
  });

  it('the same payee cannot be paid twice from one run', async () => {
    const c = govChange(13);
    const payments = runOf(3);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 1));
    await expect(sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 1)))
      .rejects.toThrow(/already been made/i);

    // And the run is still payable for everybody else.
    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 0));
    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 2));
  });

  it('RETRYING A HALF-FINISHED RUN IS SAFE, which is what X-9 depends on', async () => {
    /*
     * The operator's laptop closes after two of four payments. Somebody resumes
     * from another device and, not knowing where it got to, retries all four.
     * The two already paid are refused; the two outstanding go through.
     */
    const c = govChange(14);
    const payments = runOf(4);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 0));
    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 1));

    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      try {
        await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, i));
        outcomes.push('paid');
      } catch { outcomes.push('refused'); }
    }
    expect(outcomes).toEqual(['refused', 'refused', 'paid', 'paid']);
    expect(sim.isOpen(run.id)).toBe(true);
  });

  it('a payee who is not in the run cannot be paid from it', async () => {
    const c = govChange(15);
    const payments = runOf(3);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    // Somebody who was never in this payroll, with a well-formed path of their own.
    const stranger = runOf(1, 900);
    const strangerTree = buildPayoutTree(stranger);

    await expect(sim.as(carrying(sim, A, c)).recordPayment({
      ...claimFor(run, payments, PAYROLL, c, 0),
      details: fromHex(stranger[0].details),
      nonce: fromHex(stranger[0].nonce),
      path: strangerTree.pathFor(0),
    })).rejects.toThrow(/not for this payee|not in the approved run/i);
  });

  it('a started run cannot be cancelled, so nobody strands the unpaid', async () => {
    /*
     * V-52, closed by V-67. A signer cancelling a half-paid run leaves the
     * remaining payees unable to be paid from it — no money lost, and a payroll
     * that half happened. The boundary is the WINDOW OPENING rather than the
     * approval threshold, so a run approved for next month stays changeable.
     */
    const c = govChange(35);
    const payments = runOf(3);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 0));
    await expect(sim.as(carrying(sim, A, c)).cancel(run.id))
      .rejects.toThrow(/already started/i);
    expect(sim.isOpen(run.id)).toBe(true);

    // The other two are still payable, which is the whole point.
    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 1));
  });

  it('a run whose window has NOT opened can still be cancelled, which is what makes a schedule changeable',
    async () => {
    /*
     * Six months approved in one sitting; two people leave; month four has to be
     * stoppable right up to the moment it could start paying.
     */
    const c = govChange(36);
    const payments = runOf(3);
    const future = { from: BigInt(NOW + 86_400), until: BigInt(NOW + 172_800) };
    const run = await approvedRun(sim, PAYROLL, payments, c, future);

    await sim.as(carrying(sim, A, c)).cancel(run.id);
    expect(sim.isOpen(run.id)).toBe(false);
    expect(sim.runWindow(run.id)).toBeUndefined();
  });

  it('A GOVERNANCE PROPOSAL IS NOT A RUN AND NO STRANGER MAY SWEEP IT', async () => {
    /*
     * `C359`, AND IT IS THE PROPERTY S35c's MERGE OF `runStart` AND `runEnd`
     * TURNS ON. Nothing tested it before S35c, which is exactly why it is here:
     * the guard was an absence in a field that no longer exists on its own, and
     * an untested absence is one refactor away from being a number.
     *
     * `closeExpiredRun` is DELIBERATELY PERMISSIONLESS — the only circuit in the
     * contract any stranger may call — and what makes that safe is that a
     * governance proposal has NO ROW in `runWindow` at all, so
     * `runWindow.member(id)` refuses it. Written instead as a sentinel
     * `closesAt == 0`, `blockTimeGte(0)` is ALWAYS TRUE, and any stranger could
     * close a signer removal sitting one approval short, at one transaction
     * each. Governance proposals are the only way an account's signers are ever
     * amended, so an account that could lose them at a stranger's whim is an
     * account whose signer set can never be changed.
     */
    const c = govChange(41);
    const payload = pureCircuits.setThresholdPayload(2n);
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);

    // It is open, and it has no window — which is the whole of the guard.
    expect(sim.isOpen(id)).toBe(true);
    expect(sim.runWindow(id)).toBeUndefined();

    // Now, and long after any run's window could have closed. Neither is a run.
    await expect(sim.as(carrying(sim, A, c)).closeExpiredRun(id))
      .rejects.toThrow(/that is not a run/i);
    await expect(sim.at(NOW + 10_000_000).as(carrying(sim, A, c)).closeExpiredRun(id))
      .rejects.toThrow(/that is not a run/i);
    sim.at(NOW);

    // Still there to be approved, which is the thing that had to survive.
    expect(sim.isOpen(id)).toBe(true);
  });

  it('refuses a run whose window ends before it opens', async () => {
    const c = govChange(37);
    const tree = buildPayoutTree(runOf(2));
    await expect(sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: CLOSES, until: OPENS, vault: PAYROLL,
    })).rejects.toThrow(/ends before it opens/i);
  });

  it('refuses a run with nobody in it, on chain as well as in the client', async () => {
    const c = govChange(38);
    const tree = buildPayoutTree(runOf(1));
    await expect(sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: 0n,
      from: OPENS, until: CLOSES, vault: PAYROLL,
    })).rejects.toThrow(/no payees/i);
  });

  it('refuses a claim before the run has enough approvals', async () => {
    const c = govChange(16);
    const payments = runOf(2);
    const tree = buildPayoutTree(payments);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: OPENS, until: CLOSES, vault: PAYROLL });
    const id = sim.proposalId(payload, c.salt, PAYROLL);
    await sim.as(carrying(sim, A, c)).approve(id);   // one of two

    await expect(sim.as(carrying(sim, A, c)).recordPayment({
      proposal: id, vault: PAYROLL, root: fromHex(tree.root), payees: tree.payees,
      from: OPENS, until: CLOSES,
      salt: c.salt, details: fromHex(payments[0].details),
      nonce: fromHex(payments[0].nonce), path: tree.pathFor(0),
    })).rejects.toThrow(/not enough approvals/i);
  });

  it('a run approved for payroll is MEANINGLESS at the treasury', async () => {
    const c = govChange(17);
    const payments = runOf(2);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await expect(sim.as(carrying(sim, A, c))
      .recordPayment(claimFor(run, payments, TREASURY, c, 0)))
      .rejects.toThrow(/not this proposal|were not given it/i);
  });
});

describe('V-43: what a watcher learns from one payment', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await liveAccount(); });

  it('THE ATTACK: reading one payment off the chain does not let you claim the next payee', async () => {
    /*
     * Everything the first payment discloses is public: the proposal id, the
     * root, the payee count, the salt, that payee's details and nonce, and the
     * merkle path. **A path's level-0 sibling IS the neighbouring leaf's hash**,
     * so a watcher genuinely holds payee 1's LEAF once payee 0 has been paid.
     *
     * If quoting a leaf were enough, they could mark the rest of the payroll
     * paid and the account could not refuse them, because a contract cannot see
     * its caller. This plays exactly that and expects a refusal.
     */
    const c = govChange(21);
    const payments = runOf(2);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 0));

    // What the watcher can see: payee 1's leaf, from the path they just read.
    const leafTheyCanSee = payoutLeafOf(payments[1]);
    expect(run.tree.leaves[1]).toBe(leafTheyCanSee);

    /*
     * And what they cannot do with it. They know the leaf; they do not know the
     * (details, nonce) pair behind it, so every claim they can construct is a
     * claim for a leaf that is not in the run.
     */
    await expect(sim.as(carrying(sim, A, c)).recordPayment({
      ...claimFor(run, payments, PAYROLL, c, 1),
      details: bytes(200),
      nonce: bytes(201),
    })).rejects.toThrow(/not for this payee/i);

    // The real payee is still payable, which is the point: no denial of service.
    await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, payments, PAYROLL, c, 1));
    expect(sim.isOpen(run.id)).toBe(true);
  });

  it('the right details with the wrong nonce is not a claim', async () => {
    const c = govChange(22);
    const payments = runOf(2);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await expect(sim.as(carrying(sim, A, c)).recordPayment({
      ...claimFor(run, payments, PAYROLL, c, 0),
      nonce: bytes(250),
    })).rejects.toThrow(/not for this payee/i);
  });

  it('the run root cannot be swapped for one the claimant prefers', async () => {
    const c = govChange(23);
    const payments = runOf(2);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    const mine = runOf(1, 700);
    const myTree = buildPayoutTree(mine);

    await expect(sim.as(carrying(sim, A, c)).recordPayment({
      ...claimFor(run, payments, PAYROLL, c, 0),
      root: fromHex(myTree.root),
      payees: myTree.payees,
      details: fromHex(mine[0].details),
      nonce: fromHex(mine[0].nonce),
      path: myTree.pathFor(0),
    })).rejects.toThrow(/not this proposal|were not given it/i);
  });

  it('the payee COUNT cannot be swapped either, so a run cannot be misreported', async () => {
    /*
     * The count is inside the payload the proposal id is computed from. Nothing
     * counts down against it any more (V-67), but it is still what tells a
     * client how many leaves a run has — so a run approved at one size and
     * reported at another would be a dashboard lying about who is owed.
     */
    const c = govChange(24);
    const payments = runOf(4);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await expect(sim.as(carrying(sim, A, c)).recordPayment({
      ...claimFor(run, payments, PAYROLL, c, 0),
      payees: 1n,
    })).rejects.toThrow(/not this proposal|were not given it/i);
  });

  it('refuses a claim from someone who has the id but not the salt', async () => {
    const c = govChange(25);
    const payments = runOf(2);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    await expect(sim.as(carrying(sim, A, c)).recordPayment({
      ...claimFor(run, payments, PAYROLL, c, 0),
      salt: govChange(99).salt,
    })).rejects.toThrow(/not this proposal|were not given it/i);
  });
});

describe('V-41: the tree the client builds', () => {
  it('agrees with the contract about what a leaf is', () => {
    /*
     * The client builds the tree the signers approve; the contract recomputes
     * each leaf when it is claimed. Two derivations of one rule is M-104, so
     * this pins that there is only one.
     */
    const p = runOf(1, 300)[0];
    expect(payoutLeafOf(p)).toBe(
      hex(pureCircuits.payoutLeaf(fromHex(p.details), fromHex(p.nonce))));
  });

  it('refuses a run where two payees share a leaf, which is a reused nonce', () => {
    /*
     * B10. The account cannot tell two identical leaves apart — from where it
     * stands they are the same payment — so it refuses the second as a replay
     * and one person is silently unpayable. Caught before anybody signs.
     */
    const p = runOf(1, 500)[0];
    expect(() => buildPayoutTree([p, p])).toThrow(/same leaf|nonce has been reused/i);
  });

  it('allows two payees who differ only by their nonce', () => {
    /* The legitimate case the check must not break: the same person paid twice
     * in one run, or two people owed identical amounts. */
    const a = runOf(1, 600)[0];
    const b = { details: a.details, nonce: toHex(bytes(0xee)) };
    expect(() => buildPayoutTree([a, b])).not.toThrow();
  });

  it('refuses a run with nobody in it, rather than producing an unfinishable proposal', () => {
    expect(() => buildPayoutTree([])).toThrow(/at least one payee/i);
  });

  it('gives two runs with the same people in a different order different roots', () => {
    const people = runOf(3, 400);
    const a = buildPayoutTree(people);
    const b = buildPayoutTree([people[2], people[1], people[0]]);
    expect(a.root).not.toBe(b.root);
  });
});

/**
 * THE SECOND ROUTE TO A RUN'S PROPOSAL ID, AND THE ONE LINE THAT
 * CLOSES IT.** `P0`, found 2 Sep by `SC5`, closed by `S35d`.
 *
 * ── THE FAILURE, WHICH IS `V-52` REACHED FROM A NEW DIRECTION ────────────
 *
 * `propose` has two branches. The RUN branch builds the payload itself from the
 * parts and writes a `runWindow` row. The GOVERNANCE branch takes an opaque
 * payload hash and a vault VERBATIM and writes no window.
 *
 * `runPayload` is an EXPORTED PURE circuit, so any caller can evaluate it off
 * chain, and both branches take their salt from the same `proposalSalt()`
 * witness. So a signer calling the governance branch with
 * `payloadHash = runPayload(root, payees, opensAt, closesAt)` and a real vault
 * produced an id **bit-identical** to the run branch's, with the same
 * `openProposals` and `approvalCounts` rows — **and no window row at all.**
 *
 * `recordPayment` did not notice and paid: it recomputes the id the same way
 * and reads the run's bounds from its own arguments, not from the ledger.
 * `cancel` did notice and **failed open**: its guard is
 * `runWindow.member(id) ? blockTimeLt(…) : true`, so a missing row cancels
 * unconditionally. Sixty payees paid, the proposal cancelled, **the remaining
 * forty never payable from it** — which is `V-52` verbatim, the failure `B5`
 * closed on 1 Sep, available again to any single signer.
 *
 * ── WHAT PINS IT, AND WHAT THIS BLOCK IS FOR ─────────────────────────────
 *
 * One assert in the governance branch:
 * `assert(disclose(vault) == noVault(), "a governance proposal cannot name a
 * vault")`. **`MUTATE.command` deletes it and the first test below must go
 * red** — that is the whole reason this block exists, and without it the line
 * that closes a live `P0` would be pinned by nothing at all.
 *
 * The other three are not decoration. A refusal that refused everything would
 * satisfy the first test and break the product, so the second proves the
 * governance branch still works at `noVault()`; the third proves the run branch
 * is untouched; and the fourth is the mechanism itself — the difference in
 * `runWindow` that `cancel` and `closeExpiredRun` both read — asserted rather
 * than described, so a future change that gives governance a window row breaks
 * a test instead of a guarantee.
 */
describe('C363: a run cannot be raised through the governance branch', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await liveAccount(); });

  const runPayloadFor = (payments: PayoutLeafInput[]) => {
    const tree = buildPayoutTree(payments);
    return {
      tree,
      payload: pureCircuits.runPayload(
        fromHex(tree.root), tree.payees, OPENS, CLOSES),
    };
  };

  it('THE SECOND ROUTE TO A RUN ID: a governance proposal that names a vault is refused', async () => {
    /*
     * **THIS IS THE MUTATION TARGET'S TEST.** Delete the assert and this call
     * resolves — the id lands, `recordPayment` will pay against it, and
     * `cancel` will strand whoever is left.
     *
     * The payload is a REAL run's, built the same way `approvedRun` builds one,
     * because the attack is not "an odd value in the vault slot" — it is a run
     * arriving through the branch that writes no window.
     */
    const { payload } = runPayloadFor(runOf(3, 40));
    const c = govChange(140);
    await expect(sim.as(carrying(sim, A, c)).propose(payload, PAYROLL))
      .rejects.toThrow(/governance proposal cannot name a vault/);
    expect(sim.ledger.openProposals.size()).toBe(0n);
  });

  it('and it is refused for ANY vault, not only the one a run would name', async () => {
    /* The id is `proposalIdOf(payload, vault, salt)`, so a different vault is a
     * different id and would be a second, equally payable route. */
    const { payload } = runPayloadFor(runOf(3, 50));
    const c = govChange(141);
    await expect(sim.as(carrying(sim, A, c)).propose(payload, TREASURY))
      .rejects.toThrow(/governance proposal cannot name a vault/);
    expect(sim.ledger.openProposals.size()).toBe(0n);
  });

  it('THE POSITIVE CONTROL: governance still works, and still gets no window row', async () => {
    /*
     * A refusal that refused every governance proposal would satisfy the two
     * tests above and take every signer change and threshold change with it.
     * The assertion is on the LEDGER rather than on the call not throwing.
     */
    const c = govChange(142);
    const payload = pureCircuits.signerAddPayload(sim.leafOf(privateStateFor(7)));
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    expect(sim.isOpen(id)).toBe(true);
    /* The absence `cancel` and `closeExpiredRun` both read, asserted. */
    expect(sim.runWindow(id)).toBeUndefined();
  });

  it('THE OTHER POSITIVE CONTROL: the run branch is untouched and still writes its window', async () => {
    const payments = runOf(3, 60);
    const c = govChange(143);
    const run = await approvedRun(sim, PAYROLL, payments, c);
    expect(sim.isOpen(run.id)).toBe(true);
    expect(sim.runWindow(run.id)).toEqual({ from: OPENS, until: CLOSES });
  });
});

/**
 * **A RUN NAMES THE VAULT THAT WILL PAY IT.** Board row `2y7d5`,
 * 3 Sep. The mirror of the block above: `C363` made the governance branch refuse
 * a vault, this makes the run branch refuse the ABSENCE of one.
 *
 * **WHAT THE ASSERT IS FOR.** A run raised at `noVault()` is well formed in every
 * other respect — it takes its `openProposals`, `approvalCounts` and `runWindow`
 * rows, it collects approvals and it costs a fee — **and no vault can ever pay
 * it**, because both of `Vault.compact`'s payout paths hand `recordPayment`
 * `disclose(kernel.self().bytes)` (`:599`, `:772`) and `noVault()` is the hash of
 * a domain string no address can equal.
 *
 * **THIS IS NOT `C375`'s OWN FAILURE AND THE BLOCK SAYS SO SO THAT NOBODY READS
 * IT AS ONE.** `C375`'s round is raised through the GOVERNANCE branch, which
 * writes no window; a run refused here has one, so it is cancellable and
 * sweepable. What this costs is a burnt fee and a wasted approval round —
 * `C367`'s shape. What it is worth is rule 27: three TypeScript sites refused
 * this sequence and NOTHING on chain did.
 */
describe('C375/S48: a run cannot be raised at the no-vault sentinel', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await liveAccount(); });

  const NO_VAULT = pureCircuits.noVault();

  it('A RUN NAMES A VAULT: a run raised at the no-vault sentinel is refused', async () => {
    /*
     * **THIS IS THE MUTATION TARGET'S TEST.** Delete the assert and this call
     * resolves — the run lands, signers approve it, the fee is paid, and it is
     * discovered on payday by a vault that cannot recompute its id.
     */
    const tree = buildPayoutTree(runOf(3, 70));
    const c = govChange(150);
    await expect(sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: OPENS, until: CLOSES, vault: NO_VAULT,
    })).rejects.toThrow(/a run must name the vault that will pay it/);
    expect(sim.ledger.openProposals.size()).toBe(0n);
    expect(sim.runWindow(sim.proposalId(
      pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES),
      c.salt, NO_VAULT))).toBeUndefined();
  });

  it('and the harness default is the same call: an OMITTED vault is refused too', async () => {
    /*
     * `contracts/test/simulator.ts:654` defaults an omitted vault to `NO_VAULT`.
     * No caller in this repository omits one, so that line is a path to exactly
     * the proposal above that has never been walked. It is walked here, because
     * a default nothing exercises is a default nothing notices changing.
     */
    const tree = buildPayoutTree(runOf(2, 80));
    const c = govChange(151);
    await expect(sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES,
    })).rejects.toThrow(/a run must name the vault that will pay it/);
    expect(sim.ledger.openProposals.size()).toBe(0n);
  });

  it('THE POSITIVE CONTROL: a run that names a real vault still lands, and still writes its window', async () => {
    /*
     * An assert that refused EVERY run would satisfy both cases above and take
     * the whole payout path with it. The assertion is on the LEDGER rather than
     * on the call not throwing.
     */
    const c = govChange(152);
    const run = await approvedRun(sim, PAYROLL, runOf(3, 90), c);
    expect(sim.isOpen(run.id)).toBe(true);
    expect(sim.runWindow(run.id)).toEqual({ from: OPENS, until: CLOSES });
  });

  it('THE OTHER POSITIVE CONTROL: the governance branch still takes noVault(), which is the whole point of the mirror', async () => {
    /*
     * The two asserts are opposite comparisons against the same constant in the
     * two branches of one circuit. A reader who muddles them breaks governance
     * rather than runs, and nothing else in this file would go red.
     */
    const c = govChange(153);
    const payload = pureCircuits.signerAddPayload(sim.leafOf(privateStateFor(11)));
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    expect(sim.isOpen(id)).toBe(true);
    expect(sim.runWindow(id)).toBeUndefined();
  });
});

/**
 * **THE ROOT THAT COMES BACK THIRTY-ONE BYTES.** `P1`, found 2 Sep by
 * `MUTATE.command`'s baseline, fixed by `S41`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────
 *
 * `rehash().root()` hands back a FIELD ELEMENT and the runtime encodes one
 * MINIMALLY. A root whose top byte is zero — **about one run in 256** — arrived
 * thirty-one bytes long, and both places in `payout-tree.ts` that turned that
 * value into bytes took it as it came. `MUTATE.command` hit it because `S35d`
 * added the first fixture in this repository that ever produced one.
 *
 * ── AND IT IS LOUD, WHICH IS NOT WHAT THE ROW SAID ───────────────────────
 *
 * **`C369`'s register row and `S41`'s brief both describe a QUIET half** in
 * which a short root reaches `recordPayment`'s
 * `merkleTreePathRoot(path) == root` and is silently read as *"that payee is
 * not in the approved run"*. **It cannot reach it.** Every generated binding
 * checks the length before the circuit runs — `recordPayment`'s at
 * `contracts/managed/contract/index.js:610` — so the run cannot be raised and
 * could not be claimed if it were. The last test below pins that, and
 * `docs/corrections.md` carries the correction.
 *
 * ── SO WHAT IS THIS BLOCK ACTUALLY GUARDING ──────────────────────────────
 *
 * **THE OBVIOUS-LOOKING FIX.** A root padded at the FRONT is thirty-two bytes:
 * every binding accepts it, `proposeRun` writes it, the signers approve it, and
 * **then every payee of a perfectly good run is refused — after the approvals
 * were collected and the fees paid.** That failure is silent where the one the
 * row described is not, and **no assertion about length or agreement reaches
 * it**: only paying a run on chain does. That is why the two chain tests below
 * are not decoration.
 *
 * ── AND WHY THE INPUTS ARE WRITTEN OUT ───────────────────────────────────
 *
 * Every fixture in this repository is deterministic, and none had produced a
 * zero top byte until `S35d` added `runOf(3, 50)`. **A one-in-256 defect over a
 * fixed corpus is invisible until the corpus moves** — so this block does not
 * lean on a corpus. Its inputs are written out by value and it ASSERTS the
 * properties it depends on, because a fixture that quietly stops having one is
 * a test that quietly stops testing.
 */
describe('C369: a run whose root has a zero top byte', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await liveAccount(); });

  /**
   * **PINNED BY VALUE, AND HERE IS HOW IT WAS FOUND**, so the next person can
   * do it again. `S41` enumerated three-payee runs whose details and nonces are
   * a counter written big-endian into the last four bytes of thirty-two —
   * `details = n, n+1, n+2` and `nonce = n+1e6, n+2e6, n+3e6` — over
   * `n = 0…3999`, and collected every `n` whose root came back sixty-two hex
   * characters instead of sixty-four. **The first was `n = 114`, and these are
   * its six values written out.**
   *
   * `runOf` is deliberately not called: a fixture somebody can edit is a
   * fixture that can lose the one property this block exists for, silently.
   */
  const ZERO_TOP_BYTE: PayoutLeafInput[] = [
    {
      details: '0000000000000000000000000000000000000000000000000000000000000072',
      nonce: '00000000000000000000000000000000000000000000000000000000000f42b2',
    },
    {
      details: '0000000000000000000000000000000000000000000000000000000000000073',
      nonce: '00000000000000000000000000000000000000000000000000000000001e84f2',
    },
    {
      details: '0000000000000000000000000000000000000000000000000000000000000074',
      nonce: '00000000000000000000000000000000000000000000000000000000002dc732',
    },
  ];

  /**
   * **THE CONTROL, AND IT IS THE SAME FAMILY AT `n = 115`** — a value that
   * enumeration examined and did NOT collect. It is here because a fix that
   * padded only when short and mangled every other root would satisfy every
   * assertion about the case above it.
   */
  const ORDINARY: PayoutLeafInput[] = [
    {
      details: '0000000000000000000000000000000000000000000000000000000000000073',
      nonce: '00000000000000000000000000000000000000000000000000000000000f42b3',
    },
    {
      details: '0000000000000000000000000000000000000000000000000000000000000074',
      nonce: '00000000000000000000000000000000000000000000000000000000001e84f3',
    },
    {
      details: '0000000000000000000000000000000000000000000000000000000000000075',
      nonce: '00000000000000000000000000000000000000000000000000000000002dc733',
    },
  ];

  it('THE DEFECT: the root is thirty-two bytes, and the input still has a zero top byte', () => {
    const tree = buildPayoutTree(ZERO_TOP_BYTE);
    /*
     * The second assertion is the guard on the first. `endsWith('00')` IS the
     * zero-top-byte property under a little-endian encoding, so an edit that
     * costs this fixture its property turns this test red rather than turning
     * it into a second copy of the ordinary case below.
     */
    expect(tree.root).toHaveLength(64);
    expect(tree.root.endsWith('00')).toBe(true);
  });

  it('AND AT THE OTHER SITE: rootOfLeaves pads it the same way, byte for byte', () => {
    /*
     * V-72. `rootOfLeaves` starts from the hashes and exists to prove a status
     * view describes the run it thinks it does.
     *
     * **THE LENGTH ASSERTION IS THE ONE THAT FAILS, NOT THE EQUALITY**, and
     * they are adjacent for that reason. Under the defect BOTH sites computed
     * short and agreed with each other perfectly — that agreement is what let
     * `C369` live. Dropping the length line as redundant would leave a
     * tautology behind.
     */
    const tree = buildPayoutTree(ZERO_TOP_BYTE);
    expect(rootOfLeaves(tree.leaves)).toHaveLength(64);
    expect(rootOfLeaves(tree.leaves)).toBe(tree.root);
  });

  it('THE ORDINARY CASE IS NOT MANGLED, at both sites, and is still thirty-two bytes', () => {
    const tree = buildPayoutTree(ORDINARY);
    expect(tree.root).toHaveLength(64);
    expect(tree.root.endsWith('00')).toBe(false);
    expect(rootOfLeaves(tree.leaves)).toHaveLength(64);
    expect(rootOfLeaves(tree.leaves)).toBe(tree.root);
  });

  it('THE END THE PADDING GOES ON: the run raises AND every payee is paid from it', async () => {
    /*
     * **THE ASSERTION THAT COULD NOT BE MADE IN THE CLIENT ALONE, and the only
     * one here that catches a front-padded root.** Raising the run exercises
     * the length the bindings check. PAYING exercises what no length check
     * reaches: `recordPayment` recomputes `merkleTreePathRoot(path)` and
     * compares it against the root the proposal was approved for, so thirty-two
     * bytes of the WRONG value gets this far and is refused for every payee of
     * a run that is otherwise perfectly good.
     */
    const c = govChange(150);
    const run = await approvedRun(sim, PAYROLL, ZERO_TOP_BYTE, c);
    expect(run.tree.root).toHaveLength(64);
    expect(run.tree.root.endsWith('00')).toBe(true);
    expect(run.tree.leaves).toHaveLength(ZERO_TOP_BYTE.length);

    for (let i = 0; i < ZERO_TOP_BYTE.length; i++) {
      await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, ZERO_TOP_BYTE, PAYROLL, c, i));
    }
    for (const leaf of run.tree.leaves) {
      expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(leaf)))).toBe(true);
    }
  });

  it('THE CONTROL GOES TO THE CHAIN TOO, so this block does not lean on the rest of the file', async () => {
    /*
     * Without this, a change that mangled full-length roots while leaving short
     * ones alone would be caught only by the `runOf`-built runs elsewhere in
     * this file — which is exactly the corpus coupling the preamble above
     * argues against. Found by this round's test-coverage pass.
     */
    const c = govChange(152);
    const run = await approvedRun(sim, PAYROLL, ORDINARY, c);
    expect(run.tree.root.endsWith('00')).toBe(false);
    for (let i = 0; i < ORDINARY.length; i++) {
      await sim.as(carrying(sim, A, c)).recordPayment(claimFor(run, ORDINARY, PAYROLL, c, i));
    }
    for (const leaf of run.tree.leaves) {
      expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(leaf)))).toBe(true);
    }
  });

  it('THE CORRECTION: a short root is refused at BOTH doors, so no quiet path ever existed', async () => {
    /*
     * **THIS PINS A CLAIM THE REGISTER ROW GOT WRONG.** `C369` and this round's
     * brief both say a thirty-one-byte root reaches
     * `merkleTreePathRoot(path) == root` and is silently misread. Every
     * generated binding checks the length first — so `runPayload` refuses, and
     * `recordPayment` refuses in the same way rather than paying attention to
     * the merkle comparison at all.
     *
     * The run is raised with the CORRECT root and only the claim is shortened,
     * so what is under test is the door and not the proposal.
     */
    const c = govChange(151);
    const run = await approvedRun(sim, PAYROLL, ZERO_TOP_BYTE, c);
    const short = fromHex(run.tree.root).slice(0, 31);
    expect(short).toHaveLength(31);

    expect(() => pureCircuits.runPayload(short, run.tree.payees, OPENS, CLOSES))
      .toThrow(/Bytes<32>/);
    await expect(sim.as(carrying(sim, A, c)).recordPayment(
      { ...claimFor(run, ZERO_TOP_BYTE, PAYROLL, c, 0), root: short },
    )).rejects.toThrow(/Bytes<32>/);
  });
});
