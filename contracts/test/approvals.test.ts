/**
 * Raising a proposal counts as its raiser's approval, once, when the raiser may approve it; the
 * words a raiser is shown say which.
 */
import { describe, it, expect } from 'vitest';
import {
  isApproved, stillNeeded, describeApprovals, proposerReminder,
} from '../../src/midnight/approvals.js';
import { AccountSimulator, privateStateFor, change, type Change, payoutTreeOf } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const PAYROLL = new Uint8Array(32).fill(0xa1);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);
const nullifiers = (sim: AccountSimulator): string[] =>
  [...(sim.ledger.approvals as unknown as Iterable<Uint8Array>)].map((n) => toHex(n));

describe("a raise counts as its raiser's approval", () => {
  it("THE CHAIN AGREES: raising a run or a governance proposal counts its raiser's approval, once", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const c: Change = change(0n, 91);
    const tree = payoutTreeOf([{ details: toHex(new Uint8Array(32).fill(3)), nonce: toHex(new Uint8Array(32).fill(4)) }]);
    const from = 1_799_996_400n;
    const until = 1_800_003_600n;

    const before = nullifiers(sim);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from, until, vault: PAYROLL,
    });
    const id = sim.proposalId(
      pureCircuits.runPayload(fromHex(tree.root), tree.payees, from, until, 0n), c.salt, PAYROLL);
    /* RED WHEN `propose` writes a count of nought for a raiser who may approve. */
    expect(sim.approvalsFor(id)).toBe(1n);
    /* RED WHEN the raise counts its raiser without burning the raiser's approval: A could then approve again. */
    expect(nullifiers(sim).filter((n) => !before.includes(n))).toHaveLength(1);
    await expect(sim.as(carrying(sim, A, c)).approve(id)).rejects.toThrow(/you have already approved this proposal/);
    expect(sim.approvalsFor(id)).toBe(1n);
    await sim.as(carrying(sim, B, c)).approve(id);
    expect(sim.approvalsFor(id)).toBe(2n);

    const g = change(0n, 92);
    const payload = new Uint8Array(32).fill(5);
    await sim.as(carrying(sim, B, g)).propose(payload);
    expect(sim.approvalsFor(sim.proposalId(payload, g.salt))).toBe(1n);
  });

  it('AT A THRESHOLD OF ONE A RAISE IS CARRIED OUT WITH NO APPROVE', async () => {
    const sim = await AccountSimulator.liveAccount([A], 1n);
    const c = change(0n, 93);
    const payload = pureCircuits.adoptVaultPayload(PAYROLL);
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    /* RED WHEN a governance raise is not counted: the adoption is then one approval short. */
    await sim.as(carrying(sim, A, c)).adopt(PAYROLL, id);
    expect(sim.adopted(PAYROLL)).toBe(true);
  });

  it('AT A THRESHOLD OF TWO THE RAISE ALONE IS SHORT, AND ONE MORE SIGNER CARRIES IT', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const c = change(0n, 94);
    const payload = pureCircuits.adoptVaultPayload(PAYROLL);
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    await expect(sim.as(carrying(sim, A, c)).adopt(PAYROLL, id)).rejects.toThrow(/not enough approvals yet/);
    await sim.as(carrying(sim, B, c)).approve(id);
    await sim.as(carrying(sim, A, c)).adopt(PAYROLL, id);
    expect(sim.adopted(PAYROLL)).toBe(true);
  });

  it('A WITHDRAWN PROPOSAL WITH A FIXED SALT IS RAISED AGAIN BY ITS RAISER, AND COUNTS THEM ONCE MORE', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const c = change(0n, 95);
    const payload = pureCircuits.adoptVaultPayload(PAYROLL);
    const id = sim.proposalId(payload, c.salt);
    await sim.as(carrying(sim, A, c)).propose(payload);
    await sim.as(carrying(sim, B, c)).approve(id);
    await sim.as(carrying(sim, A, c)).cancel(id);
    expect(sim.isOpen(id)).toBe(false);
    /* The same payload under the same salt is the same id, and A's approval nullifier is already in the set. */
    /* RED WHEN the raise refuses a raiser whose nullifier is already there. */
    await sim.as(carrying(sim, A, c)).propose(payload);
    expect(sim.isOpen(id)).toBe(true);
    expect(sim.approvalsFor(id)).toBe(1n);
    /* B approved the first time; that approval is burned too, so a signer who has not approved carries it. */
    await expect(sim.as(carrying(sim, B, c)).approve(id)).rejects.toThrow(/you have already approved this proposal/);
    await expect(sim.as(carrying(sim, A, c)).adopt(PAYROLL, id)).rejects.toThrow(/not enough approvals yet/);
  });

  it('never renders a count without its threshold', () => {
    expect(describeApprovals({ approvals: 0, threshold: 3 }))
      .toBe('0 of 3 — 3 more approvals needed');
    expect(describeApprovals({ approvals: 2, threshold: 3 }))
      .toBe('2 of 3 — 1 more approval needed');
    expect(describeApprovals({ approvals: 3, threshold: 3 })).toBe('approved — 3 of 3');
  });

  it('tells a raiser, in words, whether their approval was counted', () => {
    expect(proposerReminder({ approvals: 1, threshold: 3 }))
      .toBe('Raised, and your approval is counted. 1 of 3 — 2 more approvals needed.');
    expect(proposerReminder({ approvals: 0, threshold: 3 }))
      .toBe('Raised, and not yet approved: your seat may not approve here. 0 of 3 — 3 more approvals needed.');
  });

  it('answers the only question that matters, and never a negative shortfall', () => {
    expect(isApproved({ approvals: 3, threshold: 3 })).toBe(true);
    expect(isApproved({ approvals: 2, threshold: 3 })).toBe(false);
    expect(stillNeeded({ approvals: 5, threshold: 3 })).toBe(0);
  });

  it('refuses a threshold of zero, which would authorise anything', () => {
    expect(() => describeApprovals({ approvals: 0, threshold: 0 })).toThrow(/authorise anything/i);
  });
});
