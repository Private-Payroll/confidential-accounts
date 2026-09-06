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
  runStatus, stillToPay, describeRun, type PayeeAttempts,
} from '../../src/midnight/run-status.js';
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
