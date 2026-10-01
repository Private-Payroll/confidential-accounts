/**
 * A CHANGE TO A VAULT THAT MOVES NO MONEY IS APPROVED LIKE A PAYMENT AND RECORDED AS NONE.
 *
 * A vault's nonce secret and a split of one of its notes move no money, but each
 * needs the same approval as a payment from that vault. The account approves one
 * in `approveVaultChange`: at the bar a payment from that vault needs, only for a
 * vault it holds, against that vault's own receipt for a change, and it writes
 * nothing - no payment, no person paid for a month.
 *
 * The runtime simulator runs the contract's asserts and not the network's
 * balancing check, so a change call here succeeds as though the vault had minted
 * its receipt; what the step receives is read from its effects.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';

import {
  AccountSimulator, change, privateStateFor, type Change, payoutTreeOf, sumArgsOf,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { fromHex, toHex } from '../../src/core/crypto.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);

const PAYROLL = bytes(0xa1);
const TREASURY = bytes(0xb2);
const STRANGER = bytes(0xc3);

const live = async (devices = [A, B], threshold = 2n) => {
  const sim = await AccountSimulator.liveAccount(devices, threshold);
  sim.at(NOW);
  return sim;
};

/** A run of change leaves, each carrying no amount, naming `vault`, approved by `approvers`. */
const approvedChanges = async (
  sim: AccountSimulator, vault: Uint8Array, leaves: PayoutLeafInput[], c: Change,
  approvers = [A, B],
) => {
  const tree = payoutTreeOf(leaves, leaves.map(() => 0n));
  await sim.as(sim.applying(approvers[0]!, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault,
  });
  const id = sim.proposalId(
    pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n), c.salt, vault);
  for (const a of approvers) await sim.as(sim.applying(a, c)).approve(id);
  return { tree, id };
};

const ask = (
  run: Awaited<ReturnType<typeof approvedChanges>>, leaves: PayoutLeafInput[],
  vault: Uint8Array, c: Change, i: number, payingVault?: Uint8Array,
) => {
  const { asset, path } = sumArgsOf(run.tree, i);
  return {
    proposal: run.id, vault, payingVault, root: fromHex(run.tree.root), payees: run.tree.payees,
    from: OPENS, until: CLOSES, salt: c.salt,
    details: fromHex(leaves[i]!.details), nonce: fromHex(leaves[i]!.nonce), asset, path,
  };
};

const oneChange = (seed: number): PayoutLeafInput[] =>
  [{ details: toHex(bytes(seed)), nonce: toHex(bytes(seed + 100)) }];

/** Everything the account records as paid, as hex, sorted. */
const paidRecord = (sim: AccountSimulator) => [...sim.ledger.movements].map(hex).sort();

const setBar = async (sim: AccountSimulator, vault: Uint8Array, to: bigint, seed: number) => {
  const tc = change(0n, seed);
  const bar = pureCircuits.setVaultThresholdPayload(vault, to);
  await sim.as(sim.applying(A, tc)).propose(bar);
  const bid = sim.proposalId(bar, tc.salt);
  await sim.as(A).approve(bid);
  await sim.as(B).approve(bid);
  await sim.as(sim.applying(A, tc)).setVaultThreshold(vault, to, bid);
};

const unshielded = (m: Map<any, bigint>) =>
  [...m].map(([t, v]) => [typeof t === 'string' ? t : (t.raw ?? t), v]);

describe('an approved change to a vault records no payment', () => {
  it('THE HEADLINE: a change approved at the vault\'s bar leaves the record of payments exactly as it was', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(5);
    const c = change(0n, 51);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    const before = paidRecord(sim);
    const out: any = await sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0));
    /* RED WHEN the step writes the leaf or the person-month value, as a payment does. */
    expect(paidRecord(sim)).toEqual(before);
    expect(sim.ledger.movements.member(pureCircuits.paidOnceOf(fromHex(leaves[0]!.nonce)))).toBe(false);
    /* RED WHEN the step returns any address but its own, which the vault mints its receipt to. */
    expect(hex(out.bytes)).toBe(String(sim.address));
  });

  it("receives exactly one unit of the vault's CHANGE receipt, never its payment receipt, and moves nothing else", async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(6);
    const c = change(0n, 61);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    await sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0));
    const fx = sim.lastEffects;
    const L: any = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    const changeReceipt = L.rawTokenType(pureCircuits.changeReceiptTag(), hex(PAYROLL));
    /* RED WHEN the step takes the payment receipt's tag, so one mint could stand for both. */
    expect(changeReceipt).not.toBe(L.rawTokenType(pureCircuits.paymentReceiptTag(), hex(PAYROLL)));
    /* RED WHEN the receipt's amount or token changes. */
    expect(unshielded(fx.unshieldedInputs)).toEqual([[changeReceipt, 1n]]);
    /* RED WHEN the step also mints, sends or claims anything. */
    expect([...fx.unshieldedMints]).toEqual([]);
    expect([...fx.unshieldedOutputs]).toEqual([]);
    expect([...fx.claimedUnshieldedSpends]).toEqual([]);
    expect([...fx.claimedShieldedSpends]).toEqual([]);
  });

  it('the same approval is accepted again by the account, which keeps no record of it: the vault refuses the repeat', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(7);
    const c = change(0n, 71);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    await sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0));
    /*
     * Stated rather than hidden: the account records nothing, so it cannot refuse a
     * repeat. Each change's leaf names the one secret it replaces or the one note it
     * splits, and the vault refuses both a second time (`a-new-vault.test.ts`).
     * RED WHEN the step starts recording something, which this test must then follow.
     */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0))).resolves.toBeDefined();
    expect(sim.ledger.movements.size()).toBe(0n);
  });
});

describe('who a change can be approved for, and at what bar', () => {
  it('A VAULT THE ACCOUNT NEVER ADOPTED is refused, even on a run approved naming it', async () => {
    const sim = await live();
    const leaves = oneChange(8);
    const c = change(0n, 81);
    const run = await approvedChanges(sim, STRANGER, leaves, c);
    /* RED WHEN the step stops reading `vaults`. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, STRANGER, c, 0)))
      .rejects.toThrow(/not a vault this company holds/);
  });

  it('A RETIRED VAULT is refused: it holds no money and needs no change', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(9);
    const c = change(0n, 91);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    const rc = change(0n, 92);
    const retire = pureCircuits.retireVaultPayload(PAYROLL);
    await sim.as(sim.applying(A, rc)).propose(retire);
    const rid = sim.proposalId(retire, rc.salt);
    await sim.as(A).approve(rid);
    await sim.as(B).approve(rid);
    await sim.retireVault(rid, PAYROLL, rc.salt);
    /* RED WHEN "holds now" becomes "ever adopted", as a payment's is. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0)))
      .rejects.toThrow(/not a vault this company holds/);
  });

  it('A RUN BELOW THE VAULT\'S OWN THRESHOLD is refused', async () => {
    const sim = await live([A, B, C], 2n);
    await sim.adoptVault(TREASURY, [A, B]);
    await setBar(sim, TREASURY, 3n, 93);
    const leaves = oneChange(10);
    const c = change(0n, 101);
    /* Approved by two, against a vault that needs three. */
    const run = await approvedChanges(sim, TREASURY, leaves, c, [A, B]);
    /* RED WHEN the step stops asking the bar a payment from that vault needs. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, TREASURY, c, 0)))
      .rejects.toThrow(/not enough approvals yet/);
    /* And the third approval is what lets it through. */
    await sim.as(sim.applying(C, c)).approve(run.id);
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, TREASURY, c, 0))).resolves.toBeDefined();
  });

  it('A RUN FOR ANOTHER VAULT cannot change this one', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    await sim.adoptVault(TREASURY, [A, B], 393);
    const leaves = oneChange(11);
    const c = change(0n, 111);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    /* RED WHEN the step stops requiring the changed vault to be the run's vault. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0, TREASURY)))
      .rejects.toThrow(/that run is for another vault/);
  });

  it('A GOVERNANCE PROPOSAL changes no vault', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const NO_VAULT = pureCircuits.noVault();
    const leaves = oneChange(12);
    const c = change(0n, 121);
    const tree = payoutTreeOf(leaves, [0n]);
    /* RED WHEN the step stops refusing `noVault()` before anything else. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange({
      proposal: bytes(1), vault: NO_VAULT, payingVault: PAYROLL, root: fromHex(tree.root), payees: 1n,
      from: OPENS, until: CLOSES, salt: c.salt, details: fromHex(leaves[0]!.details),
      nonce: fromHex(leaves[0]!.nonce), asset: sumArgsOf(tree, 0).asset, path: sumArgsOf(tree, 0).path,
    })).rejects.toThrow(/a governance proposal changes no vault/);
  });

  it('A LEAF NOT IN THE RUN, OR ONE CARRYING AN AMOUNT, is refused', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(13);
    const c = change(0n, 131);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    /* RED WHEN the step stops checking the leaf against the approved root. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange({
      ...ask(run, leaves, PAYROLL, c, 0), details: bytes(99),
    })).rejects.toThrow(/that change is not in the approved run/);
    /* A payment's leaf, at an amount, is not a change: the step checks it at zero. */
    const paying = payoutTreeOf(leaves);
    const pc = change(0n, 132);
    await sim.as(sim.applying(A, pc)).proposeRun({
      root: fromHex(paying.root), payees: paying.payees, from: OPENS, until: CLOSES, vault: PAYROLL,
    });
    const pid = sim.proposalId(pureCircuits.runPayload(fromHex(paying.root), paying.payees, OPENS, CLOSES, 0n), pc.salt, PAYROLL);
    await sim.as(sim.applying(A, pc)).approve(pid);
    await sim.as(sim.applying(B, pc)).approve(pid);
    /* RED WHEN the step reads the leaf's amount from its caller rather than taking zero. */
    await expect(sim.as(sim.applying(A, pc)).approveVaultChange(
      ask({ tree: paying, id: pid }, leaves, PAYROLL, pc, 0))).rejects.toThrow(/that change is not in the approved run/);
  });

  it('A HELD RUN is refused until its hold is released', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(14);
    const c = change(0n, 141);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    await sim.as(sim.applying(B, c)).holdRun(run.id);
    /* RED WHEN the step stops reading the run's hold. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0)))
      .rejects.toThrow(/a signer has held that run/);
  });

  it('A TREE OF ONE\'S OWN CANNOT RIDE ANOTHER RUN\'S APPROVALS: the run is rebuilt from its parts and must be the one approved', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(17);
    const c = change(0n, 171);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    /* Somebody's own one-leaf tree, carrying a change nobody approved, presented under the approved run's id. */
    const forged = oneChange(18);
    const theirs = payoutTreeOf(forged, [0n]);
    /* RED WHEN the step stops rebuilding the proposal's id from the run it is handed: any approved id would then approve any change. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask({ tree: theirs, id: run.id }, forged, PAYROLL, c, 0)))
      .rejects.toThrow(/that is not this run, or you were not given it/);
    /* Nor another window, or another salt, on the same id. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange({ ...ask(run, leaves, PAYROLL, c, 0), until: CLOSES + 1n }))
      .rejects.toThrow(/that is not this run, or you were not given it/);
    await expect(sim.as(sim.applying(A, c)).approveVaultChange({ ...ask(run, leaves, PAYROLL, c, 0), salt: bytes(0x5a) }))
      .rejects.toThrow(/that is not this run, or you were not given it/);
    /* The control: the run as approved is accepted. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0))).resolves.toBeDefined();
  });

  it('BEFORE ITS WINDOW OPENS a run changes nothing', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(19);
    const c = change(0n, 191);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    sim.at(Number(OPENS) - 60);
    /* RED WHEN the step stops reading the window's opening: a change would apply while the signers may still cancel it. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0)))
      .rejects.toThrow(/that run has not started yet, so it can change nothing/);
  });

  it('OUTSIDE ITS WINDOW a run changes nothing', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const leaves = oneChange(15);
    const c = change(0n, 151);
    const run = await approvedChanges(sim, PAYROLL, leaves, c);
    sim.at(NOW + 7_200);
    /* RED WHEN the step stops reading the window's close. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(ask(run, leaves, PAYROLL, c, 0)))
      .rejects.toThrow(/the window for this run has closed/);
  });
});

describe('a company-wide change: each vault its own leaf, never a stricter vault', () => {
  const companyChange = async (sim: AccountSimulator, boundTo: Uint8Array, seed: number) => {
    const inner = bytes(seed);
    const leaves: PayoutLeafInput[] = [{
      details: toHex(pureCircuits.companyWideDetailsOf(inner, boundTo)), nonce: toHex(bytes(seed + 100)),
    }];
    const c = change(0n, seed);
    const run = await approvedChanges(sim, pureCircuits.companyWide(), leaves, c);
    return { args: { ...ask(run, leaves, pureCircuits.companyWide(), c, 0, boundTo), details: inner }, c };
  };

  it('changes a vault with no bar of its own, on the company\'s approvals, on its own leaf only', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    await sim.adoptVault(TREASURY, [A, B], 393);
    const { args, c } = await companyChange(sim, PAYROLL, 16);
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(args)).resolves.toBeDefined();
    /* RED WHEN the account stops binding a company-wide leaf to the vault it changes. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange({ ...args, payingVault: TREASURY }))
      .rejects.toThrow(/that change is not in the approved run/);
    expect(sim.ledger.movements.size()).toBe(0n);
  });

  it('THE STRICTER-VAULT REFUSAL: a vault whose own bar is above the company\'s gets its own run', async () => {
    const sim = await live([A, B, C], 2n);
    await sim.adoptVault(TREASURY, [A, B]);
    await setBar(sim, TREASURY, 3n, 94);
    const { args, c } = await companyChange(sim, TREASURY, 17);
    /* RED WHEN the step stops comparing the vault's own bar with the company's. */
    await expect(sim.as(sim.applying(A, c)).approveVaultChange(args))
      .rejects.toThrow(/change it through a run of its own/);
  });
});
