/**
 * **A CHANGE TO THE COMPANY RAISED THROUGH `proposeCompanyChange` OPENS THE PROPOSAL `propose` OPENS FOR IT.**
 *
 * The circuit takes a payload and a deadline and nothing about a run. It opens the same proposal id `propose` gives
 * the payload with no vault, writes no run window, stores a fixed mark where a run stores its change, counts the
 * raiser's approval, and writes the same hold: the account's threshold, the raiser's withdraw key and the removals
 * so far. What it opens is then approved, withdrawn and carried out by the circuits that already exist.
 */
import { describe, it, expect } from 'vitest';
import { AccountSimulator, privateStateFor, change, removalPayloadFor } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { toHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);
const NOW = 1_800_000_000;
const LOWER_TO_ONE = pureCircuits.setThresholdPayload(1n);
const REFUSED_LATE = /the time to send this proposal to the chain has passed/;

/** An account of `devices` at `threshold`, at a fixed block time. */
const live = async (devices = [A, B], threshold = 2n) => {
  const sim = await AccountSimulator.liveAccount(devices, threshold);
  sim.at(NOW);
  return sim;
};

/** Raises `payload` through the company-change circuit from A with `seed`'s salt, and returns its id and salt. */
const raise = async (sim: AccountSimulator, seed: number, payload = LOWER_TO_ONE, deadline?: bigint) => {
  const c = change(0n, seed);
  await sim.as(sim.applying(A, c)).proposeCompanyChange(payload, deadline);
  return { id: sim.proposalId(payload, c.salt), c };
};

describe('the company-change mark', () => {
  it("RED WHEN: the mark stored beside a company change equals a value a circuit reads as a run's state, or zero", () => {
    const mark = toHex(pureCircuits.companyChangeMark());
    for (const other of [
      pureCircuits.clearedMark(),
      pureCircuits.chargedMark(),
      pureCircuits.paidFromMark(),
      pureCircuits.releasedMark(),
      pureCircuits.policyOnMark(),
      new Uint8Array(32)
    ])
      expect(mark).not.toBe(toHex(other));
  });
});

describe('a change to the company raised through its own circuit', () => {
  it('RED WHEN: a company change names a vault, writes a run window, or stores anything but the mark', async () => {
    const sim = await live();
    const { id, c } = await raise(sim, 11);
    /* The id is the payload's with no vault: the one `propose` gives it, and no other. */
    expect(sim.isOpen(id)).toBe(true);
    expect(sim.isOpen(sim.proposalId(LOWER_TO_ONE, c.salt, pureCircuits.allVaults()))).toBe(false);
    expect(sim.runWindow(id)).toBeUndefined();
    expect(toHex(sim.ledger.openProposals.lookup(id))).toBe(toHex(pureCircuits.companyChangeMark()));
  });

  it("RED WHEN: the raiser's approval is not counted, or the raiser can approve again", async () => {
    const sim = await live();
    const { id } = await raise(sim, 12);
    expect(sim.approvalsFor(id)).toBe(1n);
    await expect(sim.as(A).approve(id)).rejects.toThrow(/you have already approved this proposal/);
    await sim.as(B).approve(id);
    expect(sim.approvalsFor(id)).toBe(2n);
  });

  it("RED WHEN: the hold is not the account threshold, the removals so far and the raiser's withdraw key", async () => {
    const sim = await live([A, B, C], 2n);
    /* One removal first, so the removals so far are not the zero a fresh account starts at. */
    const r = change(0n, 13);
    const removal = removalPayloadFor(sim.leafOf(C));
    await sim.as(sim.applying(A, r)).propose(removal);
    const rid = sim.proposalId(removal, r.salt);
    await sim.as(B).approve(rid);
    await sim.as(sim.applying(A, r)).removeSignerAndSetThreshold(sim.leafOf(C), 0n, rid);
    expect(sim.removals()).toBe(1n);

    const { id } = await raise(sim, 14);
    const hold = sim.holdOf(id)!;
    expect(hold.needed).toBe(sim.ledger.threshold);
    expect(hold.removals).toBe(sim.removals());
    /* Only the raiser can withdraw it. */
    await expect(sim.as(B).cancel(id)).rejects.toThrow(/only the signer who raised this proposal can withdraw it/);
    expect(sim.isOpen(id)).toBe(true);
    await sim.as(A).cancel(id);
    expect(sim.isOpen(id)).toBe(false);
    expect(sim.holdOf(id)).toBeUndefined();
  });

  it('RED WHEN: a company change is raised at or past its deadline', async () => {
    const sim = await live();
    const deadline = BigInt(NOW + 600);
    const c = change(0n, 15);
    const id = sim.proposalId(LOWER_TO_ONE, c.salt);
    await expect(sim.at(deadline).as(sim.applying(A, c)).proposeCompanyChange(LOWER_TO_ONE, deadline)).rejects.toThrow(
      REFUSED_LATE
    );
    expect(sim.isOpen(id)).toBe(false);
    await sim
      .at(deadline - 1n)
      .as(sim.applying(A, c))
      .proposeCompanyChange(LOWER_TO_ONE, deadline);
    expect(sim.isOpen(id)).toBe(true);
  });

  it('RED WHEN: a company change already open is raised again', async () => {
    const sim = await live();
    const { id } = await raise(sim, 16);
    await sim.as(B).approve(id);
    await expect(raise(sim, 16)).rejects.toThrow(/that proposal is already open/);
    /* The refusal left the approvals it had. */
    expect(sim.approvalsFor(id)).toBe(2n);
  });

  it('a company change raised through it is approved, withdrawn, raised again and carried out by the existing circuits', async () => {
    const sim = await live([A, B, C], 2n);
    const { id, c } = await raise(sim, 17);
    await sim.as(B).approve(id);
    await sim.as(A).cancel(id);
    expect(sim.isOpen(id)).toBe(false);
    /* The same salt raises the same id again once it is closed, and counts its raiser once more. B's approval of
     * the withdrawn one is spent, as it is for a proposal `propose` raised, so C gives the second. */
    expect(toHex((await raise(sim, 17)).id)).toBe(toHex(id));
    expect(sim.approvalsFor(id)).toBe(1n);
    await sim.as(C).approve(id);
    await sim.as(sim.applying(A, c)).setThreshold(1n, id);
    expect(sim.ledger.threshold).toBe(1n);
    expect(sim.isOpen(id)).toBe(false);
  });
});
