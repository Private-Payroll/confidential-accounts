/**
 * A raise carries the last block time it may land at, sealed in its proof by the raiser's device, and
 * the chain refuses it at that time or later: a raise held back can never open its proposal afterwards.
 */
import { describe, it, expect } from 'vitest';
import { AccountSimulator, privateStateFor, change, payoutTreeOf } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const PAYROLL = new Uint8Array(32).fill(0xa1);
const REFUSED = /the time to send this proposal to the chain has passed, so it can never be raised/u;

describe('a raise lands by its deadline or never', () => {
  it('A GOVERNANCE RAISE AT OR PAST ITS DEADLINE IS REFUSED, AND ONE BEFORE IT OPENS', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const c = change(0n, 301);
    const payload = pureCircuits.adoptVaultPayload(PAYROLL);
    const id = sim.proposalId(payload, c.salt);
    const deadline = BigInt(sim.blockTime + 86_400);
    /* RED WHEN the chain takes a raise once its block time has reached the deadline its raiser sealed. */
    await expect(sim.at(deadline).as(sim.applying(A, c)).propose(payload, undefined, deadline)).rejects.toThrow(REFUSED);
    await expect(sim.at(deadline + 3_600n).as(sim.applying(A, c)).propose(payload, undefined, deadline)).rejects.toThrow(REFUSED);
    expect(sim.isOpen(id)).toBe(false);
    /* RED WHEN a raise one second before its deadline is refused. */
    await sim.at(deadline - 1n).as(sim.applying(A, c)).propose(payload, undefined, deadline);
    expect(sim.isOpen(id)).toBe(true);
  });

  it('A RUN RAISED AT OR PAST ITS DEADLINE IS REFUSED, AND ONE BEFORE IT OPENS', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const c = change(0n, 302);
    const tree = payoutTreeOf([{ details: toHex(new Uint8Array(32).fill(3)), nonce: toHex(new Uint8Array(32).fill(4)) }]);
    const from = 1_800_100_000n;
    const until = 1_800_200_000n;
    const deadline = 1_800_050_000n;
    const run = { root: fromHex(tree.root), payees: tree.payees, from, until, vault: PAYROLL, deadline };
    const id = sim.proposalId(pureCircuits.runPayload(fromHex(tree.root), tree.payees, from, until, 0n), c.salt, PAYROLL);
    /* RED WHEN the run path of the raise does not check the deadline the governance path checks. */
    await expect(sim.at(deadline).as(sim.applying(A, c)).proposeRun(run)).rejects.toThrow(REFUSED);
    expect(sim.isOpen(id)).toBe(false);
    await sim.at(deadline - 1n).as(sim.applying(A, c)).proposeRun(run);
    expect(sim.isOpen(id)).toBe(true);
  });
});
