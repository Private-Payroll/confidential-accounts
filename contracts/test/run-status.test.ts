/**
 * WHO HAS BEEN PAID, ANSWERED BY THE CHAIN.
 *
 * The standard set for this: pay a hundred people, have three fail, see exactly
 * which three,
 * retrigger only those, finish — as if this was a bank account.
 *
 * The tests below do that at a size a person can check, and the important one is
 * the last: after an interruption, an operator who knows NOTHING but what the
 * chain says can finish the run. No resume file, no status column, no memory of
 * what happened before the crash.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import {
  buildPayoutTree, rootOfLeaves, type PayoutLeafInput,
} from '../../src/midnight/payout-tree.js';
import {
  runStatus, stillToPay, describeRun, runPayments,
  type PayeeAttempts, type RunPayments,
} from '../../src/midnight/run-status.js';
import type { PaymentsAmong } from '../../src/core/ledger.js';
import { emptyRegister, decide, skippedIndices } from '../../src/midnight/run-skips.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const bytes = (n: number) => new Uint8Array(32).fill(n);
const PAYROLL = new Uint8Array(32).fill(0xa1);

const govChange = (seed: number): Change => change(0n, seed);

/* The clock and the run's window. V-67. Seconds since the Unix epoch. */
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

const runOf = (n: number, seed = 0): PayoutLeafInput[] =>
  Array.from({ length: n }, (_, i) => ({
    details: toHex(bytes(seed + i + 1)),
    nonce: toHex(bytes(seed + i + 101)),
  }));

describe('X-9: a run reports its progress from the chain', () => {
  let sim: AccountSimulator;
  let payments: PayoutLeafInput[];
  let tree: ReturnType<typeof buildPayoutTree>;
  let id: Uint8Array;
  let c: Change;

  /*
   * The proposal id, rebuilt the way the CONTRACT builds it. V-72.
   *
   * `runPayload` then `proposalId` — both the contract's own, composed here and
   * passed in rather than reimplemented. Hand `runStatus` a set of leaves that
   * are not this run's and it refuses to report on them at all.
   */
  const idFrom = (leaves: string[], window: { from: bigint; until: bigint }) => {
    return toHex(sim.proposalId(
      pureCircuits.runPayload(
        fromHex(rootOfLeaves(leaves)), BigInt(leaves.length), window.from, window.until),
      c.salt, PAYROLL));
  };

  /** A register skipping the given payees, decided by a named person with a reason. */
  const skipping = (indices: number[]) => indices.reduce(
    (r, i) => decide(r, {
      index: i, skip: true, by: 'kc', at: '2026-09-01T09:00:00Z', reason: 'left the company',
    }),
    emptyRegister(toHex(id), 5));

  const status = (
    skip?: number[],
    now: number = NOW,
    attempts?: Record<number, PayeeAttempts>,
  ) => runStatus(
    {
      leaves: tree.leaves,
      window: { from: OPENS, until: CLOSES },
      skips: skip ? skipping(skip) : undefined,
      attempts,
      proposal: { id: toHex(id), idFrom },
    },
    sim.ledger as never, pureCircuits.paidMovementOf, now);

  /*
   * THE SAME VIEW WITH NOTHING PROVING THE LEAVES ARE THIS RUN'S.
   *
   * A caller who genuinely holds only a leaf list gets this, and every sentence
   * it produces has to say so. The helper above passes a proposal and is
   * therefore always verified, so it cannot reach the branch below.
   */
  const unverifiedStatus = (skip?: number[], now: number = NOW) => runStatus(
    {
      leaves: tree.leaves,
      window: { from: OPENS, until: CLOSES },
      skips: skip ? skipping(skip) : undefined,
    },
    sim.ledger as never, pureCircuits.paidMovementOf, now);

  const payOne = (i: number) => sim.as(carrying(sim, A, c)).recordPayment({
    proposal: id, vault: PAYROLL, root: fromHex(tree.root), payees: tree.payees,
    from: OPENS, until: CLOSES,
    salt: c.salt, details: fromHex(payments[i].details),
    nonce: fromHex(payments[i].nonce), path: tree.pathFor(i),
  });

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    c = govChange(51);
    payments = runOf(5);
    tree = buildPayoutTree(payments);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: OPENS, until: CLOSES, vault: PAYROLL });
    id = sim.proposalId(payload, c.salt, PAYROLL);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
  });

  it('says nobody is paid before anybody is', () => {
    const s = status();
    expect(s.paid).toHaveLength(0);
    expect(s.outstanding).toHaveLength(5);
    expect(s.complete).toBe(false);
    expect(s.phase).toBe('open');
    expect(describeRun(s)).toBe('0 of 5 paid, 5 outstanding');
  });

  it('names exactly who is outstanding, by index, in any order of payment', async () => {
    await payOne(3);
    await payOne(0);

    const s = status();
    expect(s.paid.map((p) => p.index)).toEqual([0, 3]);
    expect(stillToPay(s)).toEqual([1, 2, 4]);
    expect(describeRun(s)).toBe('2 of 5 paid, 3 outstanding');
  });

  it('REFUSES TO REPORT ON LEAVES THAT ARE NOT THIS RUN\'S, rather than answering about another payroll',
    async () => {
    /*
     * V-72, and it replaces a weaker check V-61 removed.
     *
     * The old version cross-checked our count of outstanding payees against the
     * account's own count and shouted when they disagreed. That count is gone.
     * This is stronger: it rebuilds the proposal id from the leaves in hand and
     * requires it to be the run on chain. A count could only say "wrong number
     * of people"; this says "not that run".
     */
    await payOne(0);

    const wrong = buildPayoutTree(runOf(5, 900));
    expect(() => runStatus(
      {
        leaves: wrong.leaves,
        window: { from: OPENS, until: CLOSES },
        proposal: { id: toHex(id), idFrom },
      },
      sim.ledger as never, pureCircuits.paidMovementOf, NOW))
      .toThrow(/not that run's payees/i);
  });

  it('an UNVERIFIED view says so in words, because a caller may genuinely have only leaves', () => {
    const s = runStatus(
      { leaves: tree.leaves, window: { from: OPENS, until: CLOSES } },
      sim.ledger as never, pureCircuits.paidMovementOf, NOW);
    expect(s.verified).toBe(false);
    expect(describeRun(s)).toMatch(/^UNVERIFIED against the proposal — /);
  });

  it('reports the wrong run\'s leaves as simply unpaid when nobody asked for a check', async () => {
    /*
     * A stale payroll, or the wrong run.
     *
     * The unverified path, kept deliberately: hand in the wrong leaves without
     * asking for a check and every one of them reads as unpaid. That is honest
     * and it is not safe on its own, which is why the result carries
     * `verified: false` and `describeRun` leads with it.
     */
    await payOne(0);
    await payOne(1);

    const wrong = buildPayoutTree(runOf(5, 900));
    const s = runStatus(
      { leaves: wrong.leaves, window: { from: OPENS, until: CLOSES } },
      sim.ledger as never, pureCircuits.paidMovementOf, NOW);
    expect(s.verified).toBe(false);
    expect(s.paid).toHaveLength(0);
    expect(s.outstanding).toHaveLength(5);
  });

  it('SKIPPED AND FAILED ARE DIFFERENT THINGS, and the difference is ours to hold', async () => {
    /*
     * V-68. Two people left the company and are deliberately not being paid;
     * one more simply has not gone through. All three are unpaid leaves on
     * chain and the chain cannot tell them apart — so an operator who sees
     * "3 outstanding" assumes it is the two leavers plus one and stops looking.
     */
    await payOne(0);
    await payOne(1);

    const s = status([2, 3]);
    expect(s.skipped.map((p) => p.index)).toEqual([2, 3]);
    expect(s.outstanding.map((p) => p.index)).toEqual([4]);
    expect(s.complete).toBe(false);
    expect(describeRun(s)).toBe('2 of 5 paid, 2 skipped, 1 outstanding');
    expect(s.skipped[0].skipDecision?.by).toBe('kc');
    expect(s.skipped[0].skipDecision?.reason).toBe('left the company');

    // Pay the last one and the run is complete WITH two people skipped.
    await payOne(4);
    const done = status([2, 3]);
    expect(done.complete).toBe(true);
    expect(describeRun(done)).toBe('all 3 paid, 2 skipped');
  });

  it('A FAILED PAYMENT IS NEVER A SKIP, which is how somebody goes unpaid for a month', async () => {
    /*
     * V-68's whole point. Two leavers were skipped on purpose; one employee's
     * payment has been refused four times. All three are unpaid leaves on
     * chain and the chain cannot tell them apart.
     *
     * An operator who reads "3 outstanding" fills the gap themselves — usually
     * with "the two leavers plus one" — and stops looking.
     */
    await payOne(0);
    await payOne(1);

    const s = status([2, 3], NOW, {
      4: { tries: 4, lastError: 'insufficient DUST on the sponsor' },
    });

    expect(s.paid.map((p) => p.index)).toEqual([0, 1]);
    expect(s.skipped.map((p) => p.index)).toEqual([2, 3]);
    expect(s.failed.map((p) => p.index)).toEqual([4]);
    expect(s.failed[0].state).toBe('failed');
    expect(s.failed[0].attempts?.lastError).toMatch(/DUST/);
    expect(describeRun(s)).toBe(
      '2 of 5 paid, 2 skipped, 1 FAILED and needing attention, 1 outstanding');
  });

  it('nobody has tried yet is UNSENT, not failed — the two are different problems', () => {
    const s = status();
    expect(s.failed).toHaveLength(0);
    expect(s.outstanding.every((p) => p.state === 'unsent')).toBe(true);
  });

  it('a skip register raised for a DIFFERENT run is refused, not applied', async () => {
    /*
     * Last month's skips applied to this month's run mark the wrong people as
     * deliberately unpaid — and they are then the people nobody looks at.
     */
    const foreign = decide(emptyRegister('00'.repeat(32), 5), {
      index: 0, skip: true, by: 'kc', at: '2026-09-01T09:00:00Z', reason: 'left',
    });
    expect(() => runStatus(
      {
        leaves: tree.leaves,
        window: { from: OPENS, until: CLOSES },
        skips: foreign,
        proposal: { id: toHex(id), idFrom },
      },
      sim.ledger as never, pureCircuits.paidMovementOf, NOW))
      .toThrow(/those skips are for run/i);
  });

  it('a skip can be reversed, and the latest decision is the one in force', () => {
    let r = emptyRegister(toHex(id), 5);
    r = decide(r, { index: 2, skip: true, by: 'kc', at: '2026-09-01T09:00:00Z', reason: 'leaving' });
    expect(skippedIndices(r)).toEqual([2]);
    r = decide(r, { index: 2, skip: false, by: 'sam', at: '2026-09-02T09:00:00Z' });
    expect(skippedIndices(r)).toEqual([]);
    // And nothing was deleted: the argument is still readable afterwards.
    expect(r.decisions).toHaveLength(2);
  });

  it('refuses an unattributed skip, a blank reason, and a payee who is not in the run', () => {
    const r = emptyRegister(toHex(id), 5);
    expect(() => decide(r, { index: 1, skip: true, by: '', at: '2026-09-01T09:00:00Z', reason: 'x' }))
      .toThrow(/attributable/i);
    expect(() => decide(r, { index: 1, skip: true, by: 'kc', at: '2026-09-01T09:00:00Z' }))
      .toThrow(/say why/i);
    expect(() => decide(r, { index: 9, skip: true, by: 'kc', at: '2026-09-01T09:00:00Z', reason: 'x' }))
      .toThrow(/there is no payee 9/i);
  });

  it('somebody already paid is never reported as skipped, because their money exists', async () => {
    await payOne(2);
    const s = status([2]);
    expect(s.paid.map((p) => p.index)).toEqual([2]);
    expect(s.skipped).toHaveLength(0);
  });

  it('SAYS SO LOUDLY when the window has closed with people still owed', async () => {
    /*
     * V-67's honest cost, and the one state an operator must not miss: nothing
     * can pay these people from this run any more.
     */
    await payOne(0);
    await payOne(1);

    const s = status(undefined, Number(CLOSES));
    expect(s.phase).toBe('closed');
    expect(s.stranded.map((p) => p.index)).toEqual([2, 3, 4]);
    expect(stillToPay(s)).toEqual([]);
    expect(describeRun(s)).toMatch(/window has CLOSED with 3 still owed/);
  });

  it('a run whose window has not opened says so rather than looking stalled', () => {
    const s = status(undefined, Number(OPENS) - 1);
    expect(s.phase).toBe('not started');
    expect(describeRun(s)).toBe('not started — 5 payees, window opens later');
  });

  it('reports complete only when the last payee is paid', async () => {
    for (let i = 0; i < 4; i++) await payOne(i);
    expect(status().complete).toBe(false);
    await payOne(4);

    const s = status();
    expect(s.complete).toBe(true);
    expect(describeRun(s)).toBe('all 5 paid');
    // The proposal stays open until its window shuts. V-67; completion is ours to derive.
    expect(sim.isOpen(id)).toBe(true);
  });

  /*
   * THE REASSURING SENTENCE IS THE ONE THAT HAS TO CARRY THE DISCLAIMER.
   *
   * An unverified view is a list of payments that may belong to a stale run, an
   * edited spreadsheet or last month's file, and every sentence this function
   * produces leads with that. The two COMPLETED ones are where a reader is
   * least likely to go looking for the warning and most likely to stop reading,
   * so they are the two worth pinning separately from the rest.
   *
   * RED WHEN the disclaimer is dropped from the no-skips completed branch:
   * this reads `all 5 paid` and nothing says the five may be somebody else's.
   */
  it('says UNVERIFIED over a run where EVERYBODY has been paid, which is where it matters most',
    async () => {
    for (let i = 0; i < 5; i++) await payOne(i);

    const s = unverifiedStatus();
    expect(s.verified).toBe(false);
    expect(s.complete).toBe(true);
    expect(describeRun(s)).toBe('UNVERIFIED against the proposal — all 5 paid');
  });

  /*
   * THE OTHER COMPLETED BRANCH, WHICH IS A SEPARATE RETURN AND FAILS SEPARATELY.
   *
   * RED WHEN the disclaimer is dropped from the completed-with-skips branch.
   * The assertion above stays green through that change, which is why this one
   * exists rather than being folded into it.
   */
  it('and says it over a run completed with people deliberately skipped', async () => {
    await payOne(0);
    await payOne(1);
    await payOne(4);

    const s = unverifiedStatus([2, 3]);
    expect(s.verified).toBe(false);
    expect(s.complete).toBe(true);
    expect(describeRun(s)).toBe('UNVERIFIED against the proposal — all 3 paid, 2 skipped');
  });

  /*
   * **THE STRANDED SENTENCE, WHICH IS THE ONE THAT TELLS SOMEBODY TO ACT.**
   *
   * The two completed sentences above are the reassuring ones. This is the
   * opposite and it is not safer for being alarming: it says the window has
   * closed and these people need a NEW proposal. Unverified and without the
   * disclaimer, it instructs an operator to raise a fresh payroll for payees
   * taken from a leaf list that may belong to a different run.
   *
   * Nothing on chain refuses that. The account's paid-once guard is keyed on
   * the payout LEAF, which is what makes retrying a run safe — the same leaf
   * twice is refused. Leaves from ANOTHER run are values it has never seen, so
   * it accepts every one of them, and the money goes to recipients this
   * month's payroll never approved.
   *
   * RED WHEN the disclaimer is dropped from the stranded branch.
   */
  it('says UNVERIFIED over the sentence that tells somebody to raise another proposal',
    async () => {
    await payOne(0);
    await payOne(1);

    const s = unverifiedStatus(undefined, Number(CLOSES));
    expect(s.phase).toBe('closed');
    expect(s.stranded.map((p) => p.index)).toEqual([2, 3, 4]);
    expect(describeRun(s)).toBe(
      'UNVERIFIED against the proposal — 2 of 5 paid — the window has CLOSED with 3 still '
      + 'owed. They need a new proposal; nothing can pay them from this run.');
  });

  /*
   * AND THE LAST OF THE FIVE, SO THE DISCLAIMER IS HELD AT EVERY SITE THAT
   * PRODUCES IT RATHER THAN AT THE FOUR SOMEBODY THOUGHT OF.
   *
   * RED WHEN the disclaimer is dropped from the not-started branch.
   */
  it('and over a run whose window has not opened yet', () => {
    const s = unverifiedStatus(undefined, Number(OPENS) - 1);
    expect(s.phase).toBe('not started');
    expect(describeRun(s)).toBe(
      'UNVERIFIED against the proposal — not started — 5 payees, window opens later');
  });

  it('THE ONE THAT MATTERS: a stranger with only the chain can finish an interrupted run', async () => {
    /*
     * The operator's laptop died after two payments and nobody knows which two.
     * Somebody else, on another machine, with no resume file and no status
     * column, asks the chain what is left and pays exactly that.
     */
    await payOne(1);
    await payOne(3);

    const toDo = stillToPay(status());
    expect(toDo).toEqual([0, 2, 4]);

    for (const i of toDo) await payOne(i);

    const s = status();
    expect(s.complete).toBe(true);
  });

  it('and retrying the WHOLE run instead is equally safe, just noisier', async () => {
    /*
     * The operator who does not trust the list and re-runs everything. The
     * already-paid are refused; the rest go through. Same outcome, same money.
     */
    await payOne(0);
    await payOne(1);

    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      try { await payOne(i); outcomes.push('paid'); }
      catch { outcomes.push('refused'); }
    }
    expect(outcomes).toEqual(['refused', 'refused', 'paid', 'paid', 'paid']);
    expect(status().complete).toBe(true);
  });
});

/**
 * THE SAME QUESTION ASKED OF A LEDGER, WHICH IS WHAT A SCREEN ACTUALLY HOLDS.
 *
 * The view above takes the chain's payment set and the contract's own
 * derivation as arguments. A product screen has neither: it has a run, and a
 * ledger that may or may not be able to say who was paid. The door between the
 * two answers a union, and the whole point of the union is that a caller cannot
 * reach a count of paid people without first branching on whether the question
 * was answered at all.
 *
 * **THE FAILURE EVERY ASSERTION BELOW IS ABOUT.** A ledger that cannot answer
 * and a ledger answering that nobody was paid are different facts. Collapsed
 * into one, the second is printed over a run that paid everybody — or "all 0
 * paid" is printed over a payroll nobody has been paid from, which reads as a
 * finished month to the person whose job is to notice it is not.
 *
 * None of this needs a chain, a simulator or a compiled circuit: the door takes
 * plain data on both sides. It lives here because this is the file that owns
 * the module.
 */
describe('a run\'s payments, read from a ledger\'s answer rather than a set somebody assembled', () => {
  const tree = buildPayoutTree(runOf(5, 400));
  const window = { from: OPENS, until: CLOSES };
  const inputs = () => ({ leaves: tree.leaves, window });
  const holding = (paid: string[]): PaymentsAmong => ({ known: true, paid });

  /*
   * NARROWS THE UNION OR THROWS, AND THE THROW IS THE ASSERTION.
   *
   * Three things are deliberate here. The throw says WHAT was answered when
   * nothing should have been, so a red run prints the sentence that would have
   * reached a person rather than `true is not false`. There is no `expect`
   * beside it: once the throw has narrowed the value, an assertion that it is
   * narrowed is an assertion the compiler already knows the answer to, and one
   * that cannot fail is worse than none — it reads as a check and is not one.
   * The assertions that CAN fail are in the tests below, over the fields.
   *
   * And the narrowing goes through a named predicate rather than reading the
   * flag inline. The config these files are checked under does not reduce a
   * union by a boolean discriminant, so `if (v.answered)` narrows nothing and
   * every field access afterwards is an error; a predicate narrows under both.
   */
  type Refusal = Extract<RunPayments, { answered: false }>;
  type Answer = Extract<RunPayments, { answered: true }>;
  const isAnswered = (v: RunPayments): v is Answer => v.answered;
  const refused = (v: RunPayments): Refusal => {
    if (isAnswered(v)) throw new Error(`answered when it could not: "${v.sentence}"`);
    return v;
  };
  const told = (v: RunPayments): Answer => {
    if (!isAnswered(v)) throw new Error(`refused when it could answer: "${v.why}"`);
    return v;
  };

  /*
   * RED WHEN the null input stops being refused. There is then nothing to read
   * a leaf list off, and the reader dereferences it.
   */
  it('refuses a run with no payout material at all', () => {
    const v = refused(runPayments(null, holding([]), NOW));
    expect(v.payees).toBe(0);
    expect(v.why).toMatch(/no payout leaves on record/);
  });

  /*
   * **THE ONE THAT COSTS SOMEBODY THEIR SALARY, AND IT IS THE CHEAPEST MUTATION
   * IN THIS FILE.**
   *
   * RED WHEN the empty-leaf-list clause is dropped. An empty run is internally
   * consistent and externally a lie: no payee is outstanding, so the run is
   * complete, so the sentence is `all 0 paid` — printed over a payroll nobody
   * has been paid from. The failure message below prints that sentence, because
   * a reader of a red run should not have to reconstruct why it is bad.
   */
  it('refuses a run whose leaf list is empty, rather than reporting it complete', () => {
    const v = refused(runPayments({ leaves: [], window }, holding([]), NOW));
    expect(v.payees).toBe(0);
    expect(v.why).toMatch(/no payout leaves on record/);
  });

  /*
   * RED WHEN the no-such-account branch is dropped: the reader then treats a
   * ledger that has never heard of this company as one that has heard of it and
   * recorded nothing, and every payee reads as unpaid.
   */
  it('refuses when the ledger does not hold this account at all', () => {
    const v = refused(runPayments(inputs(), null, NOW));
    expect(v.payees).toBe(5);
    expect(v.why).toMatch(/not on the ledger this service is wired to/);
  });

  /*
   * **THE DISCRIMINANT, AND THE REASON THE RETURN IS A UNION.**
   *
   * RED WHEN the `known` branch is dropped. The refusal becomes a status in
   * which nobody is paid, and the sentence a reader would be handed is
   * `UNVERIFIED against the proposal — 0 of 5 paid, 5 outstanding` over a run
   * the ledger cannot say anything about at all.
   */
  it('refuses when the ledger records no payments, and never says that nobody was paid', () => {
    const v = refused(runPayments(inputs(), { known: false, paid: [] }, NOW));
    expect(v.payees).toBe(5);
    expect(v.why).toMatch(/not a statement that nobody has been/);
  });

  /*
   * **BOTH DIRECTIONS OF THE WRONG ANSWER, PINNED BY ONE ASSERTION.**
   *
   * RED WHEN the set test always answers true — every payee reads paid and the
   * sentence becomes `all 5 paid` over a run that paid two people. RED ALSO
   * WHEN it always answers false — the two who were paid read as outstanding.
   * The first is the direction that costs somebody their salary; the second is
   * the one that sends an operator to pay them twice.
   */
  it('reports exactly the payees the ledger named, and no others', () => {
    const v = told(runPayments(inputs(), holding([tree.leaves[0], tree.leaves[2]]), NOW));
    expect(v.status.paid.map((p) => p.index)).toEqual([0, 2]);
    expect(v.status.outstanding.map((p) => p.index)).toEqual([1, 3, 4]);
    expect(v.status.complete).toBe(false);
    expect(v.sentence).toBe('UNVERIFIED against the proposal — 2 of 5 paid, 3 outstanding');
  });

  /*
   * RED WHEN the check that the answer is about THIS run's payees is dropped.
   * A boundary that started answering with derived values instead of the leaves
   * asked about would still typecheck, and would produce a view in which nobody
   * had ever been paid — every count present and every one of them zero.
   */
  it('refuses an answer naming somebody who is not in this run', () => {
    const stranger = buildPayoutTree(runOf(5, 900));
    expect(() => runPayments(inputs(), holding([stranger.leaves[0]]), NOW))
      .toThrow(/not one of this run's payees/);
  });

  /*
   * RED WHEN the two sides stop being spelled the same way before they are
   * compared. The hex round-trip in this repository produces lower case; a leaf
   * that arrives in any other casing is accepted everywhere else and would
   * match nothing here, reporting every paid person as never attempted. Upper
   * case is used below because it is a spelling the parser genuinely accepts,
   * so there is something for the normalisation to do.
   */
  it('matches a payment however the leaf is spelled, rather than reporting the paid as unpaid', () => {
    const shouted = tree.leaves.map((l) => l.toUpperCase());
    const v = told(runPayments(
      { leaves: shouted, window }, holding([shouted[1], shouted[3]]), NOW));
    expect(v.status.paid.map((p) => p.index)).toEqual([1, 3]);
    expect(v.status.outstanding.map((p) => p.index)).toEqual([0, 2, 4]);
  });
});
