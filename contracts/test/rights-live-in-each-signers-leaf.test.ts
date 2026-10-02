/**
 * WHAT A SIGNER MAY DO LIVES IN THEIR OWN LEAF.
 *
 * A leaf seated with `allVaults()` may do everything on every vault. Any other
 * leaf's scope is the hash of a rights record: may raise runs, may approve runs,
 * may hold runs, on every vault or on up to four named ones. Through the
 * compiled circuits:
 *
 *   - a governance proposal needs a seat and nothing more, to raise and to
 *     approve, so no set of rights can leave the company unable to change them
 *     back;
 *   - a run is raised, approved and held only by a signer whose rights allow it
 *     on the run's vault;
 *   - a held run is neither charged nor paid until its hold is released, by the
 *     signer who held it or by as many signers seated now as the run needs, never
 *     more than are seated; a run is held only once, and never once it is charged
 *     or a payment from it has landed;
 *   - changing a signer's rights is a re-seat in the same slot, and it counts as
 *     a removal;
 *   - the approvals a policy change needs are changed only at that bar, never
 *     through a vault's threshold, and no removal leaves fewer signers than it;
 *   - seating, removing and re-seating a signer need the higher of the account
 *     threshold and that bar, so signers short of it cannot seat their way to it;
 *   - naming company-wide runs in a rights record covers nothing.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, it, expect } from 'vitest';
import {
  AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, sumArgsOf,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import {
  ALL_VAULTS, NO_VAULT, scopeOfRights, rightsRecordOf, type SignerRights, type AccountPrivateState,
} from '../src/witnesses.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

type Device = AccountPrivateState;

const fill = (n: number) => new Uint8Array(32).fill(n);
const PAYROLL = fill(0xa1);
const TREASURY = fill(0xb2);
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);

const NOTHING: SignerRights = { mayRaise: false, mayApprove: false, mayHold: false, everyVault: false, vaults: [] };

/** A device seated with `rights` instead of every right on every vault. */
const withRights = (seed: number, rights: SignerRights): Device => ({
  ...privateStateFor(seed), rights, scope: scopeOfRights(rights),
});

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** An account of `devices` at `threshold`, both vaults adopted by the first `threshold` of them. */
const live = async (devices: Device[], threshold: bigint) => {
  const sim = await AccountSimulator.liveAccount(devices, threshold);
  sim.at(NOW);
  await sim.adoptVault(PAYROLL, devices.slice(0, Number(threshold)));
  await sim.adoptVault(TREASURY, devices.slice(0, Number(threshold)), 392);
  return sim;
};

/** Raises a governance proposal from `by` and returns its id. */
const raiseGov = async (sim: AccountSimulator, by: Device, c: Change, payload: Uint8Array) => {
  await sim.as(sim.applying(by, c)).propose(payload);
  return sim.proposalId(payload, c.salt);
};

interface Run { id: Uint8Array; c: Change; payload: Uint8Array; vault: Uint8Array; pay: () => Promise<unknown> }

/** Raises a one-payee run on `vault` from `by`. */
const raiseRun = async (
  sim: AccountSimulator, by: Device, vault: Uint8Array, seed: number, required = 0n,
): Promise<Run> => {
  const c = change(0n, seed);
  const tree = payoutTreeOf([{ details: toHex(fill(0x10)), nonce: toHex(fill(seed)) }]);
  await sim.as(sim.applying(by, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault, required,
  });
  const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, required);
  const id = sim.proposalId(payload, c.salt, vault);
  const pay = () => sim.as(sim.applying(A, c)).recordPaymentFromVault({
    proposal: id, vault, root: fromHex(tree.root), payees: tree.payees,
    from: OPENS, until: CLOSES, required, salt: c.salt,
    details: fill(0x10), nonce: fill(seed), ...sumArgsOf(tree, 0),
  });
  return { id, c, payload, vault, pay };
};

/** A device that holds what `run`'s id opens to, as a device given the run's material does. */
const knowing = (d: Device, run: Run, opening: Partial<{ payload: Uint8Array; vault: Uint8Array; salt: Uint8Array }> = {}): Device => ({
  ...d,
  runOpenings: {
    ...(d.runOpenings ?? {}),
    [hex(run.id)]: { payload: run.payload, vault: run.vault, salt: run.c.salt, ...opening },
  },
});

/** Re-seats `from`'s leaf as `to`'s, raised by `by` and approved by `approvers`. */
const reseat = async (
  sim: AccountSimulator, from: Device, to: Device, by: Device, approvers: Device[], seed: number,
) => {
  const c = change(0n, seed);
  const payload = pureCircuits.reseatPayload(sim.leafOf(from), sim.leafOf(to));
  const id = await raiseGov(sim, by, c, payload);
  for (const a of approvers) await sim.as(a).approve(id);
  return { id, apply: () => sim.as(sim.applying(by, c)).reseatSigner(sim.leafOf(from), sim.leafOf(to), id) };
};

/** Re-seats `from`'s leaf as the bytes `newLeaf`, raised by A and approved by `approvers`. */
const reseatTo = async (sim: AccountSimulator, from: Device, newLeaf: Uint8Array, approvers: Device[], seed: number) => {
  const c = change(0n, seed);
  const payload = pureCircuits.reseatPayload(sim.leafOf(from), newLeaf);
  const id = await raiseGov(sim, A, c, payload);
  for (const a of approvers) await sim.as(a).approve(id);
  return () => sim.as(sim.applying(A, c)).reseatSigner(sim.leafOf(from), newLeaf, id);
};

/* ------------------------------------------------------------------ */

describe('a governance proposal needs a seat and nothing more', () => {
  it('SIGNERS WITH NO RIGHTS AT ALL RAISE, APPROVE AND CARRY OUT A GOVERNANCE PROPOSAL', async () => {
    const X = withRights(11, NOTHING);
    const Y = withRights(12, NOTHING);
    const sim = await live([A, X, Y], 2n);
    /*
     * Both of them together re-seat X with every right. If a governance
     * approval were gated by a right the company could never do this, and a
     * company whose signers all lost the approve right would be frozen for good.
     */
    const xWithEveryRight = { ...privateStateFor(11), scope: ALL_VAULTS };
    const { id, apply } = await reseat(sim, X, xWithEveryRight, Y, [X, Y], 501);
    /* RED WHEN `approve` checks the approve right whatever the proposal is: X's approval is refused. */
    expect(sim.approvalsFor(id)).toBe(2n);
    await apply();
    expect(sim.ledger.signerLeaves.member(sim.leafOf(xWithEveryRight))).toBe(true);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(X))).toBe(false);
  });

  it('a signer with no rights raises a governance proposal', async () => {
    const X = withRights(13, NOTHING);
    const sim = await live([A, X], 1n);
    const c = change(0n, 502);
    const payload = pureCircuits.setThresholdPayload(2n);
    /* RED WHEN `propose` checks the raise right for a governance proposal too. */
    await sim.as(sim.applying(X, c)).propose(payload);
    expect(sim.isOpen(sim.proposalId(payload, c.salt))).toBe(true);
  });
});

describe("a run is raised, approved and held only as a signer's rights allow", () => {
  it("RAISE: refused without the raise right, and on a vault outside the signer's set", async () => {
    const approverOnly = withRights(21, { ...NOTHING, mayApprove: true, everyVault: true });
    const payrollOnly = withRights(22, { ...NOTHING, mayRaise: true, vaults: [PAYROLL] });
    const sim = await live([A, approverOnly, payrollOnly], 1n);
    /* RED WHEN `grants` reads the approve flag for the raise right. */
    await expect(raiseRun(sim, approverOnly, PAYROLL, 31))
      .rejects.toThrow(/your seat does not let you raise runs on that vault/);
    /* RED WHEN `coversVault` stops comparing the named vaults. */
    await expect(raiseRun(sim, payrollOnly, TREASURY, 32))
      .rejects.toThrow(/your seat does not let you raise runs on that vault/);
    const run = await raiseRun(sim, payrollOnly, PAYROLL, 33);
    expect(sim.isOpen(run.id)).toBe(true);
  });

  it('APPROVE: refused without the approve right, on another vault, or with an opening of another run', async () => {
    const raiser = withRights(23, { ...NOTHING, mayRaise: true, everyVault: true });
    const treasuryApprover = withRights(24, { ...NOTHING, mayApprove: true, vaults: [TREASURY] });
    const payrollApprover = withRights(25, { ...NOTHING, mayApprove: true, vaults: [TREASURY, PAYROLL] });
    const sim = await live([A, raiser, treasuryApprover, payrollApprover], 1n);
    const run = await raiseRun(sim, A, PAYROLL, 34);
    /* RED WHEN the approve right is taken from the raise flag. */
    await expect(sim.as(knowing(raiser, run)).approve(run.id))
      .rejects.toThrow(/your seat does not let you approve runs on that vault/);
    /* RED WHEN the run's vault is not checked against the set. */
    await expect(sim.as(knowing(treasuryApprover, run)).approve(run.id))
      .rejects.toThrow(/your seat does not let you approve runs on that vault/);
    /* An opening that names a vault the run does not: RED WHEN the opening is not checked against the id. */
    await expect(sim.as(knowing(treasuryApprover, run, { vault: TREASURY })).approve(run.id))
      .rejects.toThrow(/your seat does not let you approve runs on that vault/);
    /* No opening at all: the device proves nothing about the run's vault. */
    await expect(sim.as(payrollApprover).approve(run.id))
      .rejects.toThrow(/your seat does not let you approve runs on that vault/);
    await sim.as(knowing(payrollApprover, run)).approve(run.id);
    expect(sim.approvalsFor(run.id)).toBe(1n);
  });

  it('a signer with rights on every vault approves a run on any vault, and a seat with every right needs no opening', async () => {
    const everywhere = withRights(26, { ...NOTHING, mayApprove: true, everyVault: true });
    const sim = await live([A, everywhere, B], 1n);
    const run = await raiseRun(sim, A, TREASURY, 35);
    /* RED WHEN `coversVault` ignores `everyVault`. */
    await sim.as(knowing(everywhere, run)).approve(run.id);
    await sim.as(B).approve(run.id);
    expect(sim.approvalsFor(run.id)).toBe(2n);
  });

  it("a rights record whose hash is not the leaf's scope grants nothing", async () => {
    const X = withRights(27, { ...NOTHING, mayRaise: true, vaults: [PAYROLL] });
    const sim = await live([A, X], 1n);
    /* The device claims every right while its leaf commits to a raise right on one vault. */
    const lying = { ...X, rights: { ...NOTHING, mayRaise: true, everyVault: true } };
    /* RED WHEN `grants` stops comparing the record's hash with the scope. */
    await expect(raiseRun(sim, lying, TREASURY, 36))
      .rejects.toThrow(/your seat does not let you raise runs on that vault/);
  });

  it('HOLD: refused without the hold right, or on a governance proposal', async () => {
    const noHold = withRights(28, { ...NOTHING, mayApprove: true, everyVault: true });
    const sim = await live([A, noHold, B], 2n);
    const run = await raiseRun(sim, A, PAYROLL, 37);
    /* RED WHEN the hold right is taken from the approve flag. */
    await expect(sim.as(knowing(noHold, run)).holdRun(run.id))
      .rejects.toThrow(/your seat does not let you hold runs on that vault/);
    const gov = await raiseGov(sim, A, change(0n, 503), pureCircuits.setThresholdPayload(1n));
    /* RED WHEN `holdRun` stops refusing a proposal with no window. */
    await expect(sim.as(B).holdRun(gov)).rejects.toThrow(/only a run can be held/);
  });

  it('HOLD BY A SEAT WITH THE HOLD RIGHT: on its own vault, never on another, and never with an opening of another run', async () => {
    const treasuryHolder = withRights(29, { ...NOTHING, mayHold: true, vaults: [TREASURY] });
    const sim = await live([A, treasuryHolder, B], 2n);
    const payroll = await raiseRun(sim, A, PAYROLL, 38);
    /* RED WHEN `holdRun` stops checking the run's vault against the set. */
    await expect(sim.as(knowing(treasuryHolder, payroll)).holdRun(payroll.id))
      .rejects.toThrow(/your seat does not let you hold runs on that vault/);
    /* An opening that names Treasury for a Payroll run. RED WHEN `holdRun` stops checking the opening rebuilds the id. */
    await expect(sim.as(knowing(treasuryHolder, payroll, { vault: TREASURY })).holdRun(payroll.id))
      .rejects.toThrow(/your seat does not let you hold runs on that vault/);
    const treasury = await raiseRun(sim, A, TREASURY, 39);
    /* RED WHEN `grants` stops reading the hold right: a seat that may hold is refused. */
    await sim.as(knowing(treasuryHolder, treasury)).holdRun(treasury.id);
    expect(toHex(sim.runHoldOf(treasury.id)!.placedBy)).not.toBe(toHex(new Uint8Array(32)));
  });
});

describe('a held run is neither charged nor paid until its hold is released', () => {
  it('THE HOLDER RELEASES IT ALONE, AND THE RUN PAYS', async () => {
    const sim = await live([A, B, C], 2n);
    const run = await raiseRun(sim, A, PAYROLL, 41);
    for (const d of [A, B]) await sim.as(d).approve(run.id);
    await sim.as(C).holdRun(run.id);
    /* RED WHEN `requireApprovedForVault` stops checking the hold. */
    await expect(run.pay()).rejects.toThrow(/a signer has held that run, so it cannot be charged or paid/);
    /* RED WHEN `releaseHold`'s holder branch is removed: C's release is then only one agreement of two. */
    await sim.as(C).releaseHold(run.id);
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).toBe(toHex(pureCircuits.releasedMark()));
    await run.pay();
  });

  it("OTHER SIGNERS RELEASE IT AT THE RUN'S OWN BAR, EACH ONCE, AND A RUN IS HELD ONLY ONCE", async () => {
    const sim = await live([A, B, C], 2n);
    const run = await raiseRun(sim, A, PAYROLL, 42);
    for (const d of [A, B]) await sim.as(d).approve(run.id);
    await sim.as(C).holdRun(run.id);
    /* RED WHEN `holdRun` stops refusing a run already held. */
    await expect(sim.as(A).holdRun(run.id)).rejects.toThrow(/that run is already held/);
    await sim.as(A).releaseHold(run.id);
    /* RED WHEN a release's agreement is not a nullifier: A agrees twice and releases alone. */
    await expect(sim.as(A).releaseHold(run.id)).rejects.toThrow(/you have already agreed to release this hold/);
    /* RED WHEN the release needs one agreement: one of two leaves it held. */
    await expect(run.pay()).rejects.toThrow(/a signer has held that run/);
    expect(sim.runHoldOf(run.id)!.releaseApprovals).toBe(1n);
    await sim.as(B).releaseHold(run.id);
    /* RED WHEN a released run may be held again: C holds it a second time. */
    await expect(sim.as(C).holdRun(run.id)).rejects.toThrow(/a run is held only once/);
    await run.pay();
  });

  it('AN AGREEMENT GIVEN BEFORE A REMOVAL NO LONGER COUNTS, AND ITS SIGNER MAY AGREE AGAIN', async () => {
    const D = privateStateFor(4);
    const sim = await live([A, B, C, D], 2n);
    const run = await raiseRun(sim, A, PAYROLL, 43);
    await sim.as(D).holdRun(run.id);
    await sim.as(A).releaseHold(run.id);
    /* D is removed after A agreed. */
    const c = change(0n, 504);
    const payload = pureCircuits.removeSignerPayload(sim.leafOf(D));
    const rid = await raiseGov(sim, A, c, payload);
    for (const d of [A, B]) await sim.as(d).approve(rid);
    await sim.as(sim.applying(A, c)).removeSigner(sim.leafOf(D), rid);
    await sim.as(B).releaseHold(run.id);
    /* RED WHEN agreements given before the latest removal still count: A's and B's would release it. */
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).not.toBe(toHex(pureCircuits.releasedMark()));
    expect(sim.runHoldOf(run.id)!.releaseApprovals).toBe(1n);
    /* RED WHEN the agreement is not tied to the removal count: A could never agree again. */
    await sim.as(A).releaseHold(run.id);
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).toBe(toHex(pureCircuits.releasedMark()));
  });

  it('A SIGNER AGREES ONLY ONCE BETWEEN TWO REMOVALS', async () => {
    const D = privateStateFor(4);
    const sim = await live([A, B, C, D], 2n);
    const run = await raiseRun(sim, A, PAYROLL, 49);
    await sim.as(D).holdRun(run.id);
    /* C is removed before anyone agrees. */
    const c = change(0n, 506);
    const rid = await raiseGov(sim, A, c, pureCircuits.removeSignerPayload(sim.leafOf(C)));
    for (const d of [A, B]) await sim.as(d).approve(rid);
    await sim.as(sim.applying(A, c)).removeSigner(sim.leafOf(C), rid);
    await sim.as(B).releaseHold(run.id);
    /* RED WHEN the agreement is tied to the removal count recorded before it rather than today's: B agrees twice. */
    await expect(sim.as(B).releaseHold(run.id)).rejects.toThrow(/you have already agreed to release this hold/);
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).not.toBe(toHex(pureCircuits.releasedMark()));
  });

  it('A SIGNER CANNOT RELEASE A HOLD ALONE BY RE-SEATING THEMSELF', async () => {
    const D = privateStateFor(4);
    const A2 = privateStateFor(41);
    const sim = await live([A, B, C, D], 2n);
    /* Raised needing three; D holds it. */
    const run = await raiseRun(sim, A, PAYROLL, 48, 3n);
    await sim.as(D).holdRun(run.id);
    await sim.as(A).releaseHold(run.id);
    await sim.as(B).releaseHold(run.id);
    /* A and B re-seat A's leaf as a key A also holds, and A agrees again under it. */
    const r = await reseat(sim, A, A2, A, [A, B], 505);
    await r.apply();
    await sim.as(A2).releaseHold(run.id);
    /* RED WHEN agreements given before the re-seat still count: A, B and A's new key would make three. */
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).not.toBe(toHex(pureCircuits.releasedMark()));
    await sim.as(B).releaseHold(run.id);
    await sim.as(C).releaseHold(run.id);
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).toBe(toHex(pureCircuits.releasedMark()));
  });

  it("A RELEASE BY OTHERS NEEDS THE RUN'S OWN BAR, NOT THE COMPANY'S", async () => {
    const D = privateStateFor(4);
    const sim = await live([A, B, C, D], 2n);
    /* Raised needing three approvals at a company threshold of two. */
    const run = await raiseRun(sim, A, PAYROLL, 47, 3n);
    await sim.as(D).holdRun(run.id);
    await sim.as(A).releaseHold(run.id);
    await sim.as(B).releaseHold(run.id);
    /* RED WHEN the release bar is the company's threshold rather than the run's bar when raised. */
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).not.toBe(toHex(pureCircuits.releasedMark()));
    await sim.as(C).releaseHold(run.id);
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).toBe(toHex(pureCircuits.releasedMark()));
  });

  it('a signer with no rights at all agrees to a release, so a hold can always be released', async () => {
    const X = withRights(44, NOTHING);
    const sim = await live([A, B, X], 2n);
    const run = await raiseRun(sim, A, PAYROLL, 45);
    await sim.as(A).holdRun(run.id);
    await sim.as(B).releaseHold(run.id);
    await sim.as(X).releaseHold(run.id);
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).toBe(toHex(pureCircuits.releasedMark()));
  });

  it('a run that is not held has nothing to release', async () => {
    const sim = await live([A, B], 1n);
    const run = await raiseRun(sim, A, PAYROLL, 46);
    await expect(sim.as(B).releaseHold(run.id)).rejects.toThrow(/that run is not held/);
  });
});

describe("changing a signer's rights is a re-seat, and a re-seat counts as a removal", () => {
  it("THE NEW LEAF TAKES THE OLD ONE'S SLOT, THE OLD ONE CAN DO NOTHING, AND THE REMOVAL COUNT RISES", async () => {
    const sim = await live([A, B, C], 2n);
    const slot = sim.slotOf(C);
    const size = sim.ledger.signerLeaves.size();
    const before = sim.removals();
    const pending = await raiseGov(sim, A, change(0n, 505), pureCircuits.setThresholdPayload(3n));
    const cReseated = withRights(3, { ...NOTHING, mayApprove: true, vaults: [PAYROLL] });
    const { apply } = await reseat(sim, C, cReseated, A, [A, B], 506);
    await apply();
    /* RED WHEN `reseatSigner` stops calling `countRemoval`. */
    expect(sim.removals()).toBe(before + 1n);
    expect(sim.slotOf(cReseated)).toBe(slot);
    expect(sim.ledger.signerLeaves.size()).toBe(size);
    await expect(sim.as(C).approve(pending)).rejects.toThrow(/not a signer on this account/);
    /* A governance proposal raised before the re-seat is void, as after any removal. */
    for (const d of [A, B, cReseated]) await sim.as(d).approve(pending);
    await expect(sim.as(sim.applying(A, change(0n, 505))).setThreshold(3n, pending))
      .rejects.toThrow(/a signer has been removed or replaced since this was raised; raise it again/);
  });

  it('refuses a leaf that is not seated, one already seated, and a proposal for another change', async () => {
    const sim = await live([A, B, C], 2n);
    const stranger = privateStateFor(9);
    const bad = await reseat(sim, stranger, privateStateFor(10), A, [A, B], 507);
    /* RED WHEN `reseatSigner` stops checking the old leaf is seated. */
    await expect(bad.apply()).rejects.toThrow(/that signer is not seated on this account/);
    const taken = await reseat(sim, C, B, A, [A, B], 508);
    /* RED WHEN `reseatSigner` stops refusing a leaf already seated. */
    await expect(taken.apply()).rejects.toThrow(/that signer is already on this account/);
    const c = change(0n, 509);
    const id = await raiseGov(sim, A, c, pureCircuits.removeSignerPayload(sim.leafOf(C)));
    for (const d of [A, B]) await sim.as(d).approve(id);
    /* RED WHEN `reseatSigner` stops asking whether the proposal is approved: one signer then replaces any seat. */
    await expect((await reseatTo(sim, C, sim.leafOf(privateStateFor(12)), [A], 519))())
      .rejects.toThrow(/not enough approvals yet/);
    /* RED WHEN `reseatSigner` stops refusing an empty leaf. */
    await expect((await reseatTo(sim, C, new Uint8Array(32), [A, B], 520))())
      .rejects.toThrow(/that is not a usable signer leaf/);
    /* RED WHEN `reseatSigner` stops refusing the vacancy marker, which would unseat C with no removal's checks. */
    await expect((await reseatTo(sim, C, pureCircuits.vacantSlot(), [A, B], 521))())
      .rejects.toThrow(/that is not a usable signer leaf/);
    /* RED WHEN `reseatSigner` stops binding the proposal to both leaves. */
    await expect(sim.as(sim.applying(A, c)).reseatSigner(sim.leafOf(C), sim.leafOf(privateStateFor(10)), id))
      .rejects.toThrow(/that proposal is not for this change of seat/);
  });
});

describe('the approvals a policy change needs', () => {
  const setBar = async (sim: AccountSimulator, bar: bigint, approvers: Device[], seed: number) => {
    const c = change(0n, seed);
    const id = await raiseGov(sim, A, c, pureCircuits.setPolicyBarPayload(bar));
    for (const d of approvers) await sim.as(d).approve(id);
    return () => sim.as(sim.applying(A, c)).setPolicyBar(bar, id);
  };

  it('A VAULT THRESHOLD CANNOT NAME THE POLICY BAR', async () => {
    const sim = await live([A, B, C], 2n);
    const c = change(0n, 510);
    const id = await raiseGov(sim, A, c, pureCircuits.setVaultThresholdPayload(pureCircuits.policyBarKey(), 1n));
    for (const d of [A, B]) await sim.as(d).approve(id);
    /* RED WHEN `setVaultThreshold` stops refusing `policyBarKey()`. */
    await expect(sim.as(sim.applying(A, c)).setVaultThreshold(pureCircuits.policyBarKey(), 1n, id))
      .rejects.toThrow(/that is not a vault; to change the approvals a policy change needs, raise that change instead/);
  });

  it('IS CHANGED ONLY AT THE BAR IT HOLDS TODAY', async () => {
    const sim = await live([A, B, C], 2n);
    await (await setBar(sim, 3n, [A, B], 511))();
    expect(sim.ledger.thresholds.lookup(pureCircuits.policyBarKey())).toBe(3n);
    const lower = await setBar(sim, 2n, [A, B], 512);
    /* RED WHEN `setPolicyBar` takes the account's threshold alone. */
    await expect(lower()).rejects.toThrow(/this change needs as many approvals as a policy change needs today/);
    await sim.as(C).approve(sim.proposalId(pureCircuits.setPolicyBarPayload(2n), change(0n, 512).salt));
    await lower();
    expect(sim.ledger.thresholds.lookup(pureCircuits.policyBarKey())).toBe(2n);
  });

  it('refuses a proposal raised for another change', async () => {
    const sim = await live([A, B, C], 2n);
    const c = change(0n, 522);
    const id = await raiseGov(sim, A, c, pureCircuits.setThresholdPayload(2n));
    for (const d of [A, B]) await sim.as(d).approve(id);
    /* RED WHEN `setPolicyBar` stops binding the proposal to the bar it sets. */
    await expect(sim.as(sim.applying(A, c)).setPolicyBar(2n, id))
      .rejects.toThrow(/that proposal is not for this number of approvals for policy changes/);
  });

  it('refuses zero and more than the signers', async () => {
    const sim = await live([A, B], 2n);
    /* RED WHEN the zero check goes. */
    await expect((await setBar(sim, 0n, [A, B], 513))()).rejects.toThrow(/a policy change needs at least one approval/);
    /* RED WHEN the signer-count check goes. */
    await expect((await setBar(sim, 3n, [A, B], 514))())
      .rejects.toThrow(/a policy change cannot need more approvals than the company has signers/);
  });

  it('NO REMOVAL LEAVES FEWER SIGNERS THAN A POLICY CHANGE NEEDS', async () => {
    const sim = await live([A, B, C], 2n);
    await (await setBar(sim, 3n, [A, B], 515))();
    const c = change(0n, 516);
    const id = await raiseGov(sim, A, c, pureCircuits.removeSignerPayload(sim.leafOf(C)));
    /* All three, because a removal needs the policy bar's approvals too. */
    for (const d of [A, B, C]) await sim.as(d).approve(id);
    /* RED WHEN `amendSigner`'s removal stops comparing with the policy bar. */
    await expect(sim.as(sim.applying(A, c)).removeSigner(sim.leafOf(C), id))
      .rejects.toThrow(/that would leave fewer signers than a policy change needs/);
    const c2 = change(0n, 517);
    const id2 = await raiseGov(sim, A, c2, pureCircuits.removeAndSetThresholdPayload(sim.leafOf(C), 1n));
    for (const d of [A, B, C]) await sim.as(d).approve(id2);
    /* RED WHEN `removeSignerAndSetThreshold` stops comparing with the policy bar. */
    await expect(sim.as(sim.applying(A, c2)).removeSignerAndSetThreshold(sim.leafOf(C), 1n, id2))
      .rejects.toThrow(/that would leave fewer signers than a policy change needs/);
  });

  it('with no bar set, a removal that lowers the threshold is not refused by it', async () => {
    const sim = await live([A, B, C], 3n);
    const c = change(0n, 518);
    const id = await raiseGov(sim, A, c, pureCircuits.removeAndSetThresholdPayload(sim.leafOf(C), 2n));
    for (const d of [A, B, C]) await sim.as(d).approve(id);
    /* RED WHEN the policy-bar check runs before the new threshold is written: the old threshold, 3, is then compared. */
    await sim.as(sim.applying(A, c)).removeSignerAndSetThreshold(sim.leafOf(C), 2n, id);
    expect(sim.ledger.threshold).toBe(2n);
  });
});

describe('a change of who is seated needs the policy bar, not the threshold alone', () => {
  /** Sets the approvals a policy change needs, raised by A and approved by `approvers`. */
  const setBar = async (sim: AccountSimulator, bar: bigint, approvers: Device[], seed: number) => {
    const c = change(0n, seed);
    const id = await raiseGov(sim, A, c, pureCircuits.setPolicyBarPayload(bar));
    for (const d of approvers) await sim.as(d).approve(id);
    await sim.as(sim.applying(A, c)).setPolicyBar(bar, id);
  };
  /** Seats `leaf`, raised by A and approved by `approvers`. */
  const seatTo = async (sim: AccountSimulator, leaf: Uint8Array, approvers: Device[], seed: number) => {
    const c = change(0n, seed);
    const id = await raiseGov(sim, A, c, pureCircuits.signerAddPayload(leaf));
    for (const d of approvers) await sim.as(d).approve(id);
    return { id, apply: () => sim.as(sim.applying(A, c)).addSigner(leaf, id) };
  };
  const SEAT_BAR = /needs as many approvals as a policy change needs, and at least the threshold/;
  const E = privateStateFor(9);
  const D = privateStateFor(4);

  it('SIGNERS AT THE ACCOUNT THRESHOLD CANNOT RE-SEAT A SIGNER BELOW THE POLICY BAR', async () => {
    const sim = await live([A, B, C], 2n);
    await setBar(sim, 3n, [A, B], 601);
    /* A and B re-seat C's leaf as a device they hold, which would give them the bar of three. */
    const r = await reseat(sim, C, E, A, [A, B], 602);
    /* RED WHEN `reseatSigner` stops calling `requireSeatBar`. */
    await expect(r.apply()).rejects.toThrow(SEAT_BAR);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(C))).toBe(true);
    await sim.as(C).approve(r.id);
    await r.apply();
    expect(sim.ledger.signerLeaves.member(sim.leafOf(E))).toBe(true);
  });

  it('SIGNERS AT THE ACCOUNT THRESHOLD CANNOT SEAT A NEW LEAF BELOW THE POLICY BAR', async () => {
    const sim = await live([A, B, C], 2n);
    await setBar(sim, 3n, [A, B], 603);
    const seat = await seatTo(sim, sim.leafOf(D), [A, B], 604);
    /* RED WHEN `amendSigner`'s seat branch stops calling `requireSeatBar`. */
    await expect(seat.apply()).rejects.toThrow(SEAT_BAR);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(D))).toBe(false);
    await sim.as(C).approve(seat.id);
    await seat.apply();
    expect(sim.ledger.signerLeaves.member(sim.leafOf(D))).toBe(true);
  });

  it('SIGNERS AT THE ACCOUNT THRESHOLD CANNOT REMOVE A SIGNER BELOW THE POLICY BAR, by either removal', async () => {
    const sim = await live([A, B, C, D], 2n);
    await setBar(sim, 3n, [A, B], 605);
    const c = change(0n, 606);
    const id = await raiseGov(sim, A, c, pureCircuits.removeSignerPayload(sim.leafOf(D)));
    for (const d of [A, B]) await sim.as(d).approve(id);
    /* RED WHEN `amendSigner`'s removal stops calling `requireSeatBar`. */
    await expect(sim.as(sim.applying(A, c)).removeSigner(sim.leafOf(D), id)).rejects.toThrow(SEAT_BAR);
    const c2 = change(0n, 607);
    const id2 = await raiseGov(sim, A, c2, pureCircuits.removeAndSetThresholdPayload(sim.leafOf(D), 2n));
    for (const d of [A, B]) await sim.as(d).approve(id2);
    /* RED WHEN `removeSignerAndSetThreshold` stops calling `requireSeatBar`. */
    await expect(sim.as(sim.applying(A, c2)).removeSignerAndSetThreshold(sim.leafOf(D), 2n, id2))
      .rejects.toThrow(SEAT_BAR);
    expect(sim.removals()).toBe(0n);
    /* Down to exactly the bar: three signers left of a bar of three. RED WHEN the count check refuses at the bar. */
    await sim.as(C).approve(id);
    await sim.as(sim.applying(A, c)).removeSigner(sim.leafOf(D), id);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(D))).toBe(false);
  });

  it('with no bar set, the account threshold still rules: two of three re-seat, one cannot', async () => {
    const sim = await live([A, B, C], 2n);
    const r = await reseat(sim, C, E, A, [A], 608);
    await expect(r.apply()).rejects.toThrow(/not enough approvals yet/);
    await sim.as(B).approve(r.id);
    /* RED WHEN the seat bar reads a bar that was never set as more than the account threshold. */
    await r.apply();
    expect(sim.ledger.signerLeaves.member(sim.leafOf(E))).toBe(true);
  });
});

describe('a hold never strands a run', () => {
  /** Raises a two-payee run on PAYROLL from A, approved by A and B. */
  const raiseRunOfTwo = async (sim: AccountSimulator, seed: number) => {
    const c = change(0n, seed);
    const payees = [
      { details: toHex(fill(0x10)), nonce: toHex(fill(seed)) },
      { details: toHex(fill(0x11)), nonce: toHex(fill(seed + 1)) },
    ];
    const tree = payoutTreeOf(payees);
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault: PAYROLL, required: 0n,
    });
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n);
    const id = sim.proposalId(payload, c.salt, PAYROLL);
    for (const d of [A, B]) await sim.as(d).approve(id);
    const pay = (i: number) => sim.as(sim.applying(A, c)).recordPaymentFromVault({
      proposal: id, vault: PAYROLL, root: fromHex(tree.root), payees: tree.payees,
      from: OPENS, until: CLOSES, required: 0n, salt: c.salt,
      details: fill(0x10 + i), nonce: fill(seed + i), ...sumArgsOf(tree, i),
    });
    return { id, pay };
  };

  it('A RUN CANNOT BE HELD ONCE A PAYMENT FROM IT HAS LANDED, AND ITS OTHER PAYEES ARE STILL PAID', async () => {
    const sim = await live([A, B, C], 2n);
    const run = await raiseRunOfTwo(sim, 611);
    await run.pay(0);
    /* RED WHEN the receipt step stops marking the run as paid from: C could then hold the second payee. */
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).toBe(toHex(pureCircuits.paidFromMark()));
    /* RED WHEN `holdRun`'s paid-from refusal goes: it is then refused for the wrong reason, as held and released. */
    await expect(sim.as(C).holdRun(run.id)).rejects.toThrow(/a payment from that run has already been made, so it can no longer be held/);
    /* RED WHEN the paid-from mark is read as a hold: the second payee would be refused. */
    await run.pay(1);
    await expect(sim.as(C).releaseHold(run.id)).rejects.toThrow(/that run is not held/);
  });

  it('a run held before any payment is still held, and pays once released', async () => {
    const sim = await live([A, B, C], 2n);
    const run = await raiseRunOfTwo(sim, 613);
    await sim.as(C).holdRun(run.id);
    await expect(run.pay(0)).rejects.toThrow(/a signer has held that run/);
    await sim.as(C).releaseHold(run.id);
    await run.pay(0);
    await run.pay(1);
  });

  it('A RELEASE NEVER NEEDS MORE AGREEMENTS THAN THE SIGNERS LEFT', async () => {
    const D = privateStateFor(4);
    const sim = await live([A, B, C, D], 2n);
    /* Raised needing four of four, then held by D, who is then removed: three signers are left. */
    const run = await raiseRun(sim, A, PAYROLL, 615, 4n);
    await sim.as(D).holdRun(run.id);
    const c = change(0n, 616);
    const rid = await raiseGov(sim, A, c, pureCircuits.removeSignerPayload(sim.leafOf(D)));
    for (const d of [A, B]) await sim.as(d).approve(rid);
    await sim.as(sim.applying(A, c)).removeSigner(sim.leafOf(D), rid);
    await sim.as(A).releaseHold(run.id);
    await sim.as(B).releaseHold(run.id);
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).not.toBe(toHex(pureCircuits.releasedMark()));
    await sim.as(C).releaseHold(run.id);
    /* RED WHEN the release bar is not capped at the signers seated: the run stays held for ever. */
    expect(toHex(sim.runHoldOf(run.id)!.placedBy)).toBe(toHex(pureCircuits.releasedMark()));
  });
});

describe('a seat without a leaf is not a signer', () => {
  it('a device whose leaf was never seated can neither raise nor approve', async () => {
    const sim = await live([A, B], 1n);
    const outsider = privateStateFor(8);
    const run = await raiseRun(sim, A, PAYROLL, 47);
    await expect(sim.as(knowing(outsider, run)).approve(run.id)).rejects.toThrow(/you are not a signer on this account/);
    await expect(raiseRun(sim, outsider, PAYROLL, 48)).rejects.toThrow(/you are not a signer on this account/);
  });
});

describe('a run needs the approvals its total needs, from its bar when raised', () => {
  it('a run raised needing three at a vault bar of two pays only at three', async () => {
    const sim = await live([A, B, C], 2n);
    const run = await raiseRun(sim, A, PAYROLL, 49, 3n);
    for (const d of [A, B]) await sim.as(d).approve(run.id);
    /* RED WHEN `propose` stops folding the approvals a run's total needs into its bar. */
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);
    await sim.as(C).approve(run.id);
    await run.pay();
  });
});

describe('the rights record', () => {
  it('names at most four vaults', () => {
    /* RED WHEN `rightsRecordOf` stops refusing a fifth vault. */
    expect(() => rightsRecordOf({ ...NOTHING, vaults: [1, 2, 3, 4, 5].map(fill) }))
      .toThrow(/a signer's rights can name at most 4 vaults/);
  });

  it('never hashes to the scope of a seat with every right', () => {
    /* RED WHEN `rightsScopeOf` is given `allVaults()`'s tag, or returns it. */
    expect(toHex(scopeOfRights({ mayRaise: true, mayApprove: true, mayHold: true, everyVault: true, vaults: [] })))
      .not.toBe(toHex(ALL_VAULTS));
  });

  it('NAMING COMPANY-WIDE RUNS IN A PLACE COVERS NOTHING; ONLY A RECORD FOR EVERY VAULT COVERS THEM', () => {
    const named = { mayRaise: true, mayApprove: true, mayHold: true, everyVault: false,
      vaults: [pureCircuits.companyWide(), PAYROLL, new Uint8Array(32), new Uint8Array(32)] };
    /* RED WHEN `coversVault` stops refusing the company-wide marker in a named place. */
    expect(pureCircuits.coversVault(named, pureCircuits.companyWide())).toBe(false);
    expect(pureCircuits.coversVault(named, PAYROLL)).toBe(true);
    /* RED WHEN the narrowing also takes company-wide runs from a record for every vault. */
    expect(pureCircuits.coversVault({ ...named, everyVault: true }, pureCircuits.companyWide())).toBe(true);
  });

  it('a device refuses to build a rights record that names company-wide runs as a vault', () => {
    /* RED WHEN `rightsRecordOf` stops refusing the company-wide marker. */
    expect(() => rightsRecordOf({ ...NOTHING, mayApprove: true, vaults: [pureCircuits.companyWide()] }))
      .toThrow(/cannot name company-wide runs as if they were one vault/);
    expect(rightsRecordOf({ ...NOTHING, mayApprove: true, vaults: [PAYROLL] }).vaults).toHaveLength(4);
  });

  it('a zero vault covers nothing', () => {
    const X = withRights(50, { ...NOTHING, mayRaise: true, vaults: [PAYROLL] });
    /* The record's unused places are zero bytes; a run naming zero bytes would otherwise match them. */
    expect(pureCircuits.coversVault(rightsRecordOf(X.rights!), new Uint8Array(32))).toBe(false);
    expect(pureCircuits.coversVault(rightsRecordOf(X.rights!), PAYROLL)).toBe(true);
    expect(toHex(NO_VAULT)).not.toBe(toHex(new Uint8Array(32)));
  });

  it('a device seated with rights that holds no record is refused before anything is proved', async () => {
    const X = withRights(51, { ...NOTHING, mayRaise: true, everyVault: true });
    const sim = await live([A, X], 1n);
    await expect(raiseRun(sim, { ...X, rights: null }, PAYROLL, 52))
      .rejects.toThrow(/this device does not hold the rights your seat was given/);
  });
});
