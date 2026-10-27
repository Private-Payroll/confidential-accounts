/**
 * **TWO OF A COMPANY'S FIVE SEATS RAISE, APPROVE AND PAY A PAYROLL RUN ON THE CONTRACT ITSELF, AND THE OTHER THREE DO
 * NOTHING**, by both routes the contract has to a bar of two: the account's threshold of two with the run raised
 * needing nothing more, and an account threshold of one with the run raised needing two (`required`, what a spending
 * policy's band sets). The compiled account's own circuits run: the raise counts as its raiser's approval, one more
 * seat carries it, and the vault's payments are recorded; three seated signers never sign or send anything. The
 * signers' devices over the service's routes, with two from a spending policy's band, are
 * src/server/payroll-is-raised-and-approved-by-two-of-five-signers.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, sumArgsOf } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import type { PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const [A, B, C, D, E] = [1, 2, 3, 4, 5].map((n) => privateStateFor(n));
const PAYROLL = new Uint8Array(32).fill(0xa1);
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) => sim.applying(d, c);
const payments: PayoutLeafInput[] = [1, 2, 3].map((i) => ({ details: toHex(new Uint8Array(32).fill(i)), nonce: toHex(new Uint8Array(32).fill(i + 100)) }));

describe('two of five seats run the payroll on the contract, at a bar of two', () => {
  it('at an account threshold of two, a run raised by one seat and approved by one more is paid, and the other three seats are never asked to sign', async () => {
    const sim = await AccountSimulator.liveAccount([A!, B!, C!, D!, E!], 2n);
    sim.at(NOW);
    await sim.adoptVault(PAYROLL, [A!, B!]);
    const c = change(0n, 51);
    const tree = payoutTreeOf(payments);
    const claim = (i: number) => ({
      proposal: id, vault: PAYROLL, root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, salt: c.salt,
      details: fromHex(payments[i]!.details), nonce: fromHex(payments[i]!.nonce), ...sumArgsOf(tree, i),
    });
    await sim.as(carrying(sim, A!, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault: PAYROLL });
    const id = sim.proposalId(pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n), c.salt, PAYROLL);
    /* RED WHEN: a raise by one of five seats pays at a threshold of two before a second seat approves. */
    expect(sim.approvalsFor(id)).toBe(1n);
    await expect(sim.as(carrying(sim, A!, c)).recordPaymentFromVault(claim(0))).rejects.toThrow(/not enough approvals/u);
    await sim.as(carrying(sim, B!, c)).approve(id);
    /* RED WHEN: two of five seats cannot carry a run at a threshold of two without the other three. */
    expect(sim.approvalsFor(id)).toBe(2n);
    for (const i of [0, 1, 2]) await sim.as(carrying(sim, i === 1 ? B! : A!, c)).recordPaymentFromVault(claim(i));
    for (const i of [0, 1, 2]) {
      await expect(sim.as(carrying(sim, A!, c)).recordPaymentFromVault(claim(i))).rejects.toThrow(/that payment has already been made/);
    }
  });

  it('at an account threshold of one, a run raised needing two approvals is paid only once a second of the five seats approves it', async () => {
    const sim = await AccountSimulator.liveAccount([A!, B!, C!, D!, E!], 1n);
    sim.at(NOW);
    await sim.adoptVault(PAYROLL, [A!]);
    const c = change(0n, 52);
    const tree = payoutTreeOf(payments);
    const claim = (i: number) => ({
      proposal: id, vault: PAYROLL, root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, required: 2n, salt: c.salt,
      details: fromHex(payments[i]!.details), nonce: fromHex(payments[i]!.nonce), ...sumArgsOf(tree, i),
    });
    await sim.as(carrying(sim, A!, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault: PAYROLL, required: 2n });
    const id = sim.proposalId(pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 2n), c.salt, PAYROLL);
    expect(sim.approvalsFor(id)).toBe(1n);
    /* RED WHEN: a run raised needing two approvals pays on its raiser's alone because the account's threshold is one. */
    await expect(sim.as(carrying(sim, A!, c)).recordPaymentFromVault(claim(0))).rejects.toThrow(/not enough approvals/u);
    await sim.as(carrying(sim, B!, c)).approve(id);
    expect(sim.approvalsFor(id)).toBe(2n);
    for (const i of [0, 1, 2]) await sim.as(carrying(sim, A!, c)).recordPaymentFromVault(claim(i));
  });
});
