/**
 * Raising a proposal is not approving it, and nothing may say otherwise.
 */
import { describe, it, expect } from 'vitest';
import {
  isApproved, stillNeeded, describeApprovals, proposerReminder,
} from '../../src/midnight/approvals.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { buildPayoutTree } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const PAYROLL = new Uint8Array(32).fill(0xa1);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('a proposal is raised unapproved', () => {
  it('THE CHAIN AGREES: raising a run leaves it at zero approvals, not one', async () => {
    /*
     * The fact the whole entry rests on, taken from the contract rather than
     * from the comment above `propose`. That comment reads as though
     * "A creates, B and C approve" were three of five; it is two.
     */
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const c: Change = change(0n, 91);
    const tree = buildPayoutTree([{ details: toHex(new Uint8Array(32).fill(3)), nonce: toHex(new Uint8Array(32).fill(4)) }]);
    const from = 1_799_996_400n;
    const until = 1_800_003_600n;

    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from, until, vault: PAYROLL,
    });
    const id = sim.proposalId(
      pureCircuits.runPayload(fromHex(tree.root), tree.payees, from, until), c.salt, PAYROLL);

    expect(sim.approvalsFor(id)).toBe(0n);
    await sim.as(carrying(sim, A, c)).approve(id);
    expect(sim.approvalsFor(id)).toBe(1n);
  });

  it('never renders a count without its threshold', () => {
    expect(describeApprovals({ approvals: 0, threshold: 3 }))
      .toBe('0 of 3 — 3 more approvals needed');
    expect(describeApprovals({ approvals: 2, threshold: 3 }))
      .toBe('2 of 3 — 1 more approval needed');
    expect(describeApprovals({ approvals: 3, threshold: 3 })).toBe('approved — 3 of 3');
  });

  it('tells a proposer, in words, that they have not approved it', () => {
    expect(proposerReminder({ approvals: 0, threshold: 3 }))
      .toBe('Raised, and NOT yet approved — including by you. 0 of 3 — 3 more approvals needed.');
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
