/**
 * A SIGNER BEING REMOVED CAN DO NOTHING AGAINST THE COMPANY.
 *
 * Every refusal the account adds for it, run through the compiled circuits:
 *
 *   - a proposal needs the higher of its bar when it was raised and the bar now,
 *     so a threshold that falls never releases approvals already given, and one
 *     that rises applies to what is waiting;
 *   - a governance proposal is withdrawn only by the signer who raised it, and a
 *     run before its window by any signer, as before;
 *   - a removal voids every governance proposal raised before it, and a run
 *     raised before it needs one approval more than its bar for every removal
 *     since;
 *   - removing a signer and setting the threshold is one proposal, and neither
 *     removal can "remove" a leaf that is not seated;
 *   - the company-wide marker can never be given a vault threshold;
 *   - the account is born holding its company label and a removal count of zero.
 *
 * Offline, against the real compiled contract, exactly as the rest of this
 * directory. It shows what the circuits refuse and permit; it does not show a
 * proof, a node or a screen.
 */
import { describe, it, expect } from 'vitest';
import {
  AccountSimulator, privateStateFor, change, COMPANY_LABEL, type Change,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { buildPayoutTree } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);
const D = privateStateFor(4);
type Device = ReturnType<typeof privateStateFor>;

const bytes = (n: number) => new Uint8Array(32).fill(n);
const VAULT = bytes(0xa1);
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: Device, c: Change) => sim.applying(d, c);

const live = async (devices: Device[], threshold: bigint) => {
  const sim = await AccountSimulator.liveAccount(devices, threshold);
  sim.at(NOW);
  return sim;
};

/** Raises a governance proposal from `by` and returns its id. */
const raise = async (sim: AccountSimulator, by: Device, c: Change, payload: Uint8Array) => {
  await sim.as(carrying(sim, by, c)).propose(payload);
  return sim.proposalId(payload, c.salt);
};

/** Raises a one-payee run on `VAULT` from `by`, and returns its id and a way to pay it. */
const raiseRun = async (sim: AccountSimulator, by: Device, c: Change, nonce: number) => {
  const tree = buildPayoutTree([{ details: toHex(bytes(0x10)), nonce: toHex(bytes(nonce)) }]);
  await sim.as(carrying(sim, by, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault: VAULT,
  });
  const id = sim.proposalId(
    pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES), c.salt, VAULT);
  const pay = () => sim.recordPayment({
    proposal: id, vault: VAULT, root: fromHex(tree.root), payees: tree.payees,
    from: OPENS, until: CLOSES, salt: c.salt,
    details: bytes(0x10), nonce: bytes(nonce), path: tree.pathFor(0),
  });
  return { id, pay };
};

/** Removes `who` and sets the threshold to `to`, raised by `by` and approved by `approvers`. */
const removeAndSet = async (
  sim: AccountSimulator, who: Device, to: bigint, by: Device, approvers: Device[], seed: number,
) => {
  const c = govChange(seed);
  const payload = pureCircuits.removeAndSetThresholdPayload(sim.leafOf(who), to);
  const id = await raise(sim, by, c, payload);
  for (const a of approvers) await sim.as(a).approve(id);
  await sim.as(carrying(sim, by, c)).removeSignerAndSetThreshold(sim.leafOf(who), to, id);
  return id;
};

describe('the account is born holding its label and a removal count of zero', () => {
  it('the constructor writes the label under its own key, and a removal count of zero', async () => {
    const sim = await AccountSimulator.create(A);
    /* RED WHEN: the constructor stops writing the label, or writes it under a key other than companyLabelKey(). */
    expect(toHex(sim.companyLabel())).toBe(toHex(COMPANY_LABEL));
    /* RED WHEN: the constructor stops writing the count entry (lookup throws), or starts it anywhere but zero. */
    expect(sim.removals()).toBe(0n);
  });

  it('refuses a company with no label', async () => {
    /* RED WHEN: the constructor's `companyLabel != default` assert is removed. */
    await expect(AccountSimulator.create(A, undefined, new Uint8Array(32)))
      .rejects.toThrow(/a company needs a label/);
  });
});

describe('every proposal carries its hold from the moment it is raised', () => {
  it('a governance proposal holds the account threshold, the proposer\'s key and the removals so far; closing it removes the hold', async () => {
    const sim = await live([A, B], 2n);
    const c = govChange(11);
    const id = await raise(sim, A, c, pureCircuits.setThresholdPayload(1n));
    const hold = sim.holdOf(id)!;
    /* RED WHEN: propose writes no hold, or records a governance bar other than the account's threshold. */
    expect(hold.needed).toBe(2n);
    /* RED WHEN: propose stores anything but the proposer's withdraw key for this id. */
    expect(toHex(hold.withdrawKey)).toBe(toHex(pureCircuits.withdrawKeyOf(
      pureCircuits.withdrawSecretOf(A.secretKey, fromHex(sim.address), id))));
    /* RED WHEN: propose records a removal count other than the account's. */
    expect(hold.removals).toBe(0n);

    await sim.as(A).approve(id);
    await sim.as(B).approve(id);
    await sim.as(carrying(sim, A, c)).setThreshold(1n, id);
    /* RED WHEN: closeProposal stops removing the hold. */
    expect(sim.holdOf(id)).toBeUndefined();
  });

  it('a run holds its vault\'s threshold, not the account\'s', async () => {
    const sim = await live([A, B, C], 2n);
    const vc = govChange(12);
    const vid = await raise(sim, A, vc, pureCircuits.setVaultThresholdPayload(VAULT, 3n));
    for (const d of [A, B]) await sim.as(d).approve(vid);
    await sim.as(carrying(sim, A, vc)).setVaultThreshold(VAULT, 3n, vid);

    const run = await raiseRun(sim, A, govChange(13), 0x51);
    /* RED WHEN: a run's hold records the account's threshold instead of its vault's. */
    expect(sim.holdOf(run.id)!.needed).toBe(3n);
  });
});

describe('a proposal needs the higher of its bar when raised and the bar now', () => {
  it('X2c: a vault bar that falls does not release a run one signer approved', async () => {
    const sim = await live([A, B, C], 3n);
    const up = govChange(21);
    const vid = await raise(sim, A, up, pureCircuits.setVaultThresholdPayload(VAULT, 3n));
    for (const d of [A, B, C]) await sim.as(d).approve(vid);
    await sim.as(carrying(sim, A, up)).setVaultThreshold(VAULT, 3n, vid);

    const run = await raiseRun(sim, A, govChange(22), 0x52);
    await sim.as(A).approve(run.id);

    const down = govChange(23);
    const lid = await raise(sim, A, down, pureCircuits.setVaultThresholdPayload(VAULT, 1n));
    for (const d of [A, B, C]) await sim.as(d).approve(lid);
    await sim.as(carrying(sim, A, down)).setVaultThreshold(VAULT, 1n, lid);
    expect(sim.ledger.thresholds.lookup(VAULT)).toBe(1n);

    /* RED WHEN: requireApprovedForVault compares against the vault's threshold now alone. */
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);
  });

  it('R: a vault bar that rises applies to the run already waiting', async () => {
    const sim = await live([A, B], 1n);
    const run = await raiseRun(sim, A, govChange(24), 0x53);
    await sim.as(A).approve(run.id);

    const up = govChange(25);
    const vid = await raise(sim, A, up, pureCircuits.setVaultThresholdPayload(VAULT, 2n));
    await sim.as(A).approve(vid);
    await sim.as(carrying(sim, A, up)).setVaultThreshold(VAULT, 2n, vid);

    /* RED WHEN: requireApprovedForVault compares against the hold's bar alone, ignoring a rise. */
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);
    await sim.as(B).approve(run.id);
    await expect(run.pay()).resolves.toBeDefined();
  });

  it('a governance proposal raised at two is not carried out at one after the threshold falls', async () => {
    const sim = await live([A, B, C], 2n);
    const c = govChange(26);
    const seatD = await raise(sim, A, c, pureCircuits.signerAddPayload(sim.leafOf(D)));
    await sim.as(A).approve(seatD);
    await sim.raiseThreshold(1n, [A, B], 27);
    expect(sim.ledger.threshold).toBe(1n);
    /* RED WHEN: requireApproved compares against the account's threshold now alone. */
    await expect(sim.as(carrying(sim, A, c)).addSigner(sim.leafOf(D), seatD))
      .rejects.toThrow(/not enough approvals yet/);
  });
});

describe('a governance proposal is withdrawn only by the signer who raised it', () => {
  it('M1c: the signer being removed cannot cancel their own removal, nor can another signer; its proposer can', async () => {
    const sim = await live([A, B, C], 2n);
    const c = govChange(31);
    const id = await raise(sim, A, c, pureCircuits.removeAndSetThresholdPayload(sim.leafOf(B), 2n));
    /* RED WHEN: cancel lets any signer withdraw a governance proposal (the withdraw-key assert removed). */
    await expect(sim.as(B).cancel(id)).rejects.toThrow(/only the signer who raised this proposal can withdraw it/);
    await expect(sim.as(C).cancel(id)).rejects.toThrow(/only the signer who raised this proposal can withdraw it/);
    expect(sim.isOpen(id)).toBe(true);

    await sim.as(A).cancel(id);
    expect(sim.isOpen(id)).toBe(false);
    expect(sim.holdOf(id)).toBeUndefined();
  });

  it('a run before its window may still be stopped by any signer', async () => {
    const sim = await live([A, B], 2n);
    const later = BigInt(NOW + 7_200);
    const c = govChange(32);
    const tree = buildPayoutTree([{ details: toHex(bytes(0x11)), nonce: toHex(bytes(0x54)) }]);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from: later, until: later + 3_600n, vault: VAULT,
    });
    const id = sim.proposalId(
      pureCircuits.runPayload(fromHex(tree.root), tree.payees, later, later + 3_600n), c.salt, VAULT);
    /* RED WHEN: cancel applies the proposer-only rule to runs as well. */
    await sim.as(B).cancel(id);
    expect(sim.isOpen(id)).toBe(false);
    /* RED WHEN: closing a run keeps its hold. */
    expect(sim.holdOf(id)).toBeUndefined();
  });
});

describe('a removal voids the governance proposals raised before it, and a run raised before it needs one more', () => {
  it('N1: a removed signer\'s governance proposal cannot be completed by one remaining approval', async () => {
    const sim = await live([A, B, C], 2n);
    const c = govChange(41);
    const seatD = await raise(sim, A, c, pureCircuits.signerAddPayload(sim.leafOf(D)));
    await sim.as(A).approve(seatD);

    await removeAndSet(sim, A, 2n, B, [B, C], 42);
    /* RED WHEN: a removal circuit stops calling countRemoval(). */
    expect(sim.removals()).toBe(1n);

    await sim.as(C).approve(seatD);
    expect(sim.approvalsFor(seatD)).toBe(2n);
    /* RED WHEN: requireApproved stops comparing the hold's removal count with the account's. */
    await expect(sim.as(carrying(sim, B, c)).addSigner(sim.leafOf(D), seatD))
      .rejects.toThrow(/a signer has been removed since this was raised; raise it again/);

    /* The control: the same change raised after the removal passes with B and C. */
    const again = govChange(43);
    const fresh = await raise(sim, B, again, pureCircuits.signerAddPayload(sim.leafOf(D)));
    await sim.as(B).approve(fresh);
    await sim.as(C).approve(fresh);
    await sim.as(carrying(sim, B, again)).addSigner(sim.leafOf(D), fresh);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(D))).toBe(true);
  });

  it('N1, runs: a run raised before a removal needs one approval more than its bar', async () => {
    const sim = await live([A, B, C], 2n);
    const run = await raiseRun(sim, A, govChange(44), 0x55);
    await sim.as(A).approve(run.id);
    await sim.as(B).approve(run.id);

    await removeAndSet(sim, A, 2n, B, [B, C], 45);
    /* RED WHEN: requireApprovedForVault stops adding one for a run raised under an earlier removal count. */
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);

    await sim.as(C).approve(run.id);
    await expect(run.pay()).resolves.toBeDefined();
  });

  it('N1, two removals: a run raised before two removals needs two approvals more than its bar', async () => {
    const sim = await live([A, B, C, D], 2n);
    const run = await raiseRun(sim, A, govChange(49), 0x57);
    await sim.as(A).approve(run.id);
    await sim.as(B).approve(run.id);

    await removeAndSet(sim, A, 2n, C, [C, D], 81);
    await removeAndSet(sim, B, 2n, C, [C, D], 82);
    expect(sim.removals()).toBe(2n);

    /* Both removed signers' approvals and one seated signer's: three, against a bar of two plus two. */
    await sim.as(C).approve(run.id);
    /* RED WHEN: requireApprovedForVault adds one however many removals there have been since the run was raised. */
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);

    /* Every seated signer has approved: the two it takes at a bar of two, whatever the removed signers gave. */
    await sim.as(D).approve(run.id);
    await expect(run.pay()).resolves.toBeDefined();
  });

  it('the older removal circuit counts too', async () => {
    const sim = await live([A, B, C], 2n);
    const c = govChange(46);
    const id = await raise(sim, B, c, pureCircuits.removeSignerPayload(sim.leafOf(A)));
    await sim.as(B).approve(id);
    await sim.as(C).approve(id);
    await sim.as(carrying(sim, B, c)).removeSigner(sim.leafOf(A), id);
    /* RED WHEN: amendSigner's removal branch stops calling countRemoval(). */
    expect(sim.removals()).toBe(1n);
  });

  it('X1c: at two of two, a run the leaving signer raised and approved alone is not paid after they leave', async () => {
    const sim = await live([A, B], 2n);
    const run = await raiseRun(sim, B, govChange(47), 0x56);
    await sim.as(B).approve(run.id);

    await removeAndSet(sim, B, 1n, A, [A, B], 48);
    expect(sim.ledger.threshold).toBe(1n);
    /* RED WHEN: both the hold's bar and the removal's extra approval are dropped, so the fall to one ratifies B's lone approval. */
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);
    await sim.as(A).approve(run.id);
    /* Two approvals, one of them the removed signer's, against a bar of two plus one: still refused.
     * RED WHEN: the hold's bar is dropped (the fall to one plus one would then be met). */
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);
  });
});

describe('removing a signer and setting the threshold is one proposal', () => {
  it('M6c: at two of two, one approval is refused; two remove B and set one, and B can then do nothing', async () => {
    const sim = await live([A, B], 2n);
    const c = govChange(51);
    const payload = pureCircuits.removeAndSetThresholdPayload(sim.leafOf(B), 1n);
    const id = await raise(sim, A, c, payload);
    await sim.as(A).approve(id);
    /* RED WHEN: removeSignerAndSetThreshold skips requireApproved. */
    await expect(sim.as(carrying(sim, A, c)).removeSignerAndSetThreshold(sim.leafOf(B), 1n, id))
      .rejects.toThrow(/not enough approvals yet/);

    await sim.as(B).approve(id);
    await sim.as(carrying(sim, A, c)).removeSignerAndSetThreshold(sim.leafOf(B), 1n, id);
    expect(sim.ledger.threshold).toBe(1n);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(B))).toBe(false);
    /* RED WHEN: the combined circuit stops closing its proposal. */
    expect(sim.isOpen(id)).toBe(false);
    expect(sim.holdOf(id)).toBeUndefined();
    await expect(sim.as(carrying(sim, B, govChange(52))).propose(bytes(9)))
      .rejects.toThrow(/not a signer on this account/);
  });

  it('refuses a proposal for another removal or another threshold', async () => {
    const sim = await live([A, B, C], 2n);
    const c = govChange(53);
    const id = await raise(sim, A, c, pureCircuits.removeAndSetThresholdPayload(sim.leafOf(C), 2n));
    await sim.as(A).approve(id);
    await sim.as(B).approve(id);
    /* RED WHEN: the id is no longer rebuilt from removeAndSetThresholdPayload(removedLeaf, newThreshold). */
    await expect(sim.as(carrying(sim, A, c)).removeSignerAndSetThreshold(sim.leafOf(C), 1n, id))
      .rejects.toThrow(/that proposal is not for this removal and threshold/);
    await expect(sim.as(carrying(sim, A, c)).removeSignerAndSetThreshold(sim.leafOf(B), 2n, id))
      .rejects.toThrow(/that proposal is not for this removal and threshold/);
  });

  it('refuses a threshold of zero, or above the signers left', async () => {
    const sim = await live([A, B, C], 2n);
    for (const [to, why, seed] of [
      [0n, /the threshold must be at least one/, 54],
      [3n, /fewer signers than the threshold/, 55],
    ] as const) {
      const c = govChange(seed);
      const id = await raise(sim, A, c, pureCircuits.removeAndSetThresholdPayload(sim.leafOf(C), to));
      await sim.as(A).approve(id);
      await sim.as(B).approve(id);
      /* RED WHEN: the `newThreshold > 0` or the signers-left assert is removed from the combined circuit. */
      await expect(sim.as(carrying(sim, A, c)).removeSignerAndSetThreshold(sim.leafOf(C), to, id))
        .rejects.toThrow(why);
    }
  });

  it('N4: neither removal circuit removes the vacancy marker or a leaf that was never seated', async () => {
    const sim = await live([A, B, C], 2n);
    await removeAndSet(sim, C, 2n, A, [A, B], 56);
    const vacant = pureCircuits.vacantSlot();
    for (const leaf of [vacant, sim.leafOf(D)]) {
      const c1 = govChange(57);
      const combined = await raise(sim, A, c1, pureCircuits.removeAndSetThresholdPayload(leaf, 1n));
      await sim.as(A).approve(combined);
      await sim.as(B).approve(combined);
      /* RED WHEN: removeSignerAndSetThreshold's `signerLeaves.member(removedLeaf)` assert is removed. */
      await expect(sim.as(carrying(sim, A, c1)).removeSignerAndSetThreshold(leaf, 1n, combined))
        .rejects.toThrow(/that signer is not seated on this account/);
      await sim.as(A).cancel(combined);

      const c2 = govChange(58);
      const single = await raise(sim, A, c2, pureCircuits.removeSignerPayload(leaf));
      await sim.as(A).approve(single);
      await sim.as(B).approve(single);
      /* RED WHEN: amendSigner's removal branch loses its `signerLeaves.member(removedLeaf)` assert. */
      await expect(sim.as(carrying(sim, A, c2)).removeSigner(leaf, single))
        .rejects.toThrow(/that signer is not seated on this account/);
      await sim.as(A).cancel(single);
    }
  });
});

describe('the combined removal takes out exactly the leaf it names', () => {
  /** Three signers at two, and an approved combined removal of C that keeps the threshold at two. */
  const approvedRemovalOfC = async () => {
    const sim = await live([A, B, C], 2n);
    const c = govChange(71);
    const id = await raise(sim, A, c, pureCircuits.removeAndSetThresholdPayload(sim.leafOf(C), 2n));
    await sim.as(A).approve(id);
    await sim.as(B).approve(id);
    return { sim, c, id };
  };

  it('the combined removal cannot remove the wrong person: its path must be for the leaf it names', async () => {
    const { sim, c, id } = await approvedRemovalOfC();
    const bSlot = sim.slotOf(B);
    /* B proves membership with their own path and offers the same path as the one for C. */
    const liar = sim.dishonest(carrying(sim, B, c), sim.pathFor(B));
    /* RED WHEN: removeSignerAndSetThreshold's `path.leaf == removedLeaf` assert is removed. */
    await expect(sim.as(liar).removeSignerAndSetThreshold(sim.leafOf(C), 2n, id))
      .rejects.toThrow(/that path is not for the leaf being removed/);
    expect(sim.slotOf(B)).toBe(bSlot);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);
  });

  it('the combined removal refuses a caller who is not a signer, even one holding the approved proposal', async () => {
    const { sim, c, id } = await approvedRemovalOfC();
    const E = privateStateFor(5);
    /* RED WHEN: removeSignerAndSetThreshold stops calling requireSigner(). */
    await expect(sim.as(carrying(sim, E, c)).removeSignerAndSetThreshold(sim.leafOf(C), 2n, id))
      .rejects.toThrow(/not a signer on this account/);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);
  });

  it('the combined removal refuses a path from another tree', async () => {
    const { sim, c, id } = await approvedRemovalOfC();
    const real = sim.pathFor(C);
    const forged = {
      leaf: real.leaf,
      path: real.path.map((step, i) => (i === 0 ? { ...step, sibling: { field: step.sibling.field + 1n } } : step)),
    };
    /* Pinned for C's leaf only, so A's own membership path is still the real one. */
    const withForgedPath = { ...carrying(sim, A, c), pinnedPath: forged, pinAnyLeaf: false };
    /* RED WHEN: removeSignerAndSetThreshold's `signers.checkRoot(...)` assert on the departing path is removed. */
    await expect(sim.as(withForgedPath).removeSignerAndSetThreshold(sim.leafOf(C), 2n, id))
      .rejects.toThrow(/that signer is not on this account/);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);
  });

  it('the combined removal marks the slot vacant, so it is reused, and the seat count falls', async () => {
    const { sim, c, id } = await approvedRemovalOfC();
    const cSlot = sim.slotOf(C);
    await sim.as(carrying(sim, A, c)).removeSignerAndSetThreshold(sim.leafOf(C), 2n, id);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    /* RED WHEN: the combined removal blanks the slot instead of writing the vacancy marker into it. */
    expect(sim.vacatedSlots()).toEqual([cSlot]);

    const seat = govChange(72);
    const seatD = await raise(sim, A, seat, pureCircuits.signerAddPayload(sim.leafOf(D)));
    await sim.as(A).approve(seatD);
    await sim.as(B).approve(seatD);
    await sim.as(carrying(sim, A, seat)).addSigner(sim.leafOf(D), seatD, true);
    expect(sim.slotOf(D)).toBe(cSlot);
  });
});

describe('the company-wide marker never takes a vault threshold', () => {
  it('setVaultThreshold refuses companyWide()', async () => {
    const sim = await live([A, B], 2n);
    const c = govChange(61);
    const id = await raise(sim, A, c, pureCircuits.setVaultThresholdPayload(pureCircuits.companyWide(), 3n));
    await sim.as(A).approve(id);
    await sim.as(B).approve(id);
    /* RED WHEN: setVaultThreshold's `vault != companyWide()` assert is removed. */
    await expect(sim.as(carrying(sim, A, c)).setVaultThreshold(pureCircuits.companyWide(), 3n, id))
      .rejects.toThrow(/the company-wide decision always takes the account's threshold/);
  });
});
