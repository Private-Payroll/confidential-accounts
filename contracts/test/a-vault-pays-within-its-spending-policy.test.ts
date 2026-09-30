/**
 * A VAULT UNDER A SPENDING POLICY PAYS ONLY WHAT ITS POLICY ALLOWS.
 *
 * A run's root is a sum tree: every inner node hashes both children and both
 * children's sums, and the root hashes the top node, the run's total and its
 * one token. So what any set of payments can prove against a root adds up to at
 * most the total the signers approved. A company may give a vault a policy per
 * token - four bands, each a ceiling on a run's total and the approvals such a
 * run needs, and a limit per period - set by governance at the policy's own
 * bar. `clearRun` charges an approved run to its period once, inside its
 * window; a vault under a policy pays only runs charged that way, only its own,
 * and refuses a token it has no policy for. A vault with no policy is paid as
 * before.
 *
 * Every assertion names the change that turns it red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  AccountSimulator, change, privateStateFor, payoutTreeOf, sumArgsOf, GBP, USDC, type Change,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import type { PolicyOpening } from '../src/witnesses.js';
import {
  rootOfLeaves, sumTreeOfLeaves, type PayoutLeafInput, type PayoutTree, type SumStep,
} from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';
import { Transcript } from './transcript.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);

const NOW = 1_800_000_000;
const DAY = 86_400;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);

const PAYROLL = Uint8Array.from({ length: 32 }, (_, i) => (0xa1 + i) & 0xff);
const TREASURY = Uint8Array.from({ length: 32 }, (_, i) => (0xb2 + i) & 0xff);

/** Thirty-two bytes from a seed, different for every seed this file uses. */
const bytes = (seed: number): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => (seed * 37 + i * 11 + 5) & 0xff);

/** Four bands, a limit of 1,500 a period, and thirty-day periods starting ten days ago. */
const POLICY: PolicyOpening = {
  terms: {
    bands: [
      { ceiling: 1_000n, approvals: 2n },
      { ceiling: 5_000n, approvals: 3n },
      { ceiling: 10_000n, approvals: 3n },
      { ceiling: 100_000n, approvals: 3n },
    ],
    periodLimit: 1_500n,
    periodStart: BigInt(NOW - 10 * DAY),
    periodLength: BigInt(30 * DAY),
  },
  blinding: bytes(900),
};

const assetKeyOf = (asset: Uint8Array) => pureCircuits.assetKeyOf(asset, A.assetBlinding);
const policyKeyOf = (vault: Uint8Array, asset: Uint8Array) => pureCircuits.policyKeyOf(vault, assetKeyOf(asset));
const periodKeyOf = (vault: Uint8Array, asset: Uint8Array, policy: PolicyOpening, period = 0n) =>
  pureCircuits.periodKeyOf(policyKeyOf(vault, asset), pureCircuits.policyCommitmentOf(policy), period);
const periodTotalOf = (policy: PolicyOpening, total: bigint, period = 0n) =>
  pureCircuits.periodTotalOf(total, pureCircuits.periodBlindingOf(policy.blinding, period));

const live = async (devices = [A, B, C], threshold = 2n) => {
  const sim = await AccountSimulator.liveAccount(devices, threshold);
  sim.at(NOW);
  await sim.adoptVault(PAYROLL, [A, B]);
  await sim.adoptVault(TREASURY, [A, B], 392);
  return sim;
};

/** Sets `vault`'s policy for `asset` under a round raised by A and approved by `approvers`. */
const setPolicyOn = async (
  sim: AccountSimulator, vault: Uint8Array, policy: PolicyOpening, seed: number,
  asset: Uint8Array = GBP, approvers = [A, B],
) => {
  const c = change(0n, seed, asset);
  const commitment = pureCircuits.policyCommitmentOf(policy);
  const payload = pureCircuits.setPolicyPayload(vault, assetKeyOf(asset), commitment);
  await sim.as(sim.applying(A, c)).propose(payload);
  const id = sim.proposalId(payload, c.salt);
  for (const a of approvers) await sim.as(a).approve(id);
  return { apply: () => sim.as(sim.applying(A, c)).setPolicy(vault, commitment, id), commitment, id };
};

interface Run {
  tree: PayoutTree; id: Uint8Array; c: Change; payments: PayoutLeafInput[];
  required: bigint; from: bigint; until: bigint; vault: Uint8Array;
}

/** Raises a run of `amounts` naming `vault`, and approves it by `approvers`. */
const raise = async (
  sim: AccountSimulator, vault: Uint8Array, amounts: bigint[], seed: number,
  opts: { required?: bigint; from?: bigint; until?: bigint; asset?: Uint8Array; approvers?: typeof A[] } = {},
): Promise<Run> => {
  const { required = 2n, from = OPENS, until = CLOSES, asset = GBP, approvers = [A, B] } = opts;
  const payments = amounts.map((_, i) => ({ details: toHex(bytes(seed + i)), nonce: toHex(bytes(seed + 60 + i)) }));
  const tree = payoutTreeOf(payments, amounts, asset);
  const c = change(0n, seed, asset);
  await sim.as(sim.applying(A, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees, from, until, vault, required,
  });
  const id = sim.proposalId(
    pureCircuits.runPayload(fromHex(tree.root), tree.payees, from, until, required), c.salt, vault);
  for (const a of approvers) await sim.as(sim.applying(a, c)).approve(id);
  return { tree, id, c, payments, required, from, until, vault };
};

/** The same tree raised again as a new round, as a retry is. */
const raiseAgain = async (sim: AccountSimulator, run: Run, seed: number, approvers = [A, B]): Promise<Run> => {
  const c = change(0n, seed, fromHex(run.tree.asset));
  await sim.as(sim.applying(A, c)).proposeRun({
    root: fromHex(run.tree.root), payees: run.tree.payees, from: run.from, until: run.until,
    vault: run.vault, required: run.required,
  });
  const id = sim.proposalId(
    pureCircuits.runPayload(fromHex(run.tree.root), run.tree.payees, run.from, run.until, run.required),
    c.salt, run.vault);
  for (const a of approvers) await sim.as(sim.applying(a, c)).approve(id);
  return { ...run, id, c };
};

/** Charges `run` to `period`, from `device`, holding `policy` and what the period has been charged. */
const clear = (
  sim: AccountSimulator, run: Run,
  opts: { period?: bigint; spent?: bigint; device?: typeof A; policy?: PolicyOpening; total?: bigint; asset?: Uint8Array } = {},
) => {
  const { period = 0n, spent = 0n, device = A, policy = POLICY } = opts;
  const state = { ...sim.applying(device, run.c), policy, periodSpent: spent };
  if (opts.asset) state.assetId = opts.asset;
  return sim.as(state).clearRun({
    proposal: run.id, vault: run.vault, root: fromHex(run.tree.root), payees: run.tree.payees,
    from: run.from, until: run.until, required: run.required, salt: run.c.salt,
    top: run.tree.top, total: opts.total ?? run.tree.total, period,
  });
};

/** Records payee `i` of `run` as paid by `payingVault` (the run's own vault unless named). */
const pay = (sim: AccountSimulator, run: Run, i: number, over: Record<string, unknown> = {}) =>
  sim.as(sim.applying(A, run.c)).recordPaymentFromVault({
    proposal: run.id, vault: run.vault, root: fromHex(run.tree.root), payees: run.tree.payees,
    from: run.from, until: run.until, required: run.required, salt: run.c.salt,
    details: fromHex(run.payments[i]!.details), nonce: fromHex(run.payments[i]!.nonce),
    ...sumArgsOf(run.tree, i), ...over,
  });

const paidLeaf = (sim: AccountSimulator, run: Run, i: number) =>
  sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(run.tree.leaves[i]!)));

/* ------------------------------------------------------------------ */

describe('the sum tree: a root binds what its run can pay in total', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await live(); });

  it('pays each payee at the amount and in the token its leaf carries, and nothing else', async () => {
    const run = await raise(sim, PAYROLL, [300n, 200n], 10);
    /* RED WHEN the path's sum drops the amount: another amount then reaches the root. The leaf node need not hash it, since every parent hashes both children's sums. */
    await expect(pay(sim, run, 0, { amount: 301n }))
      .rejects.toThrow(/that payee is not in the approved run, at that amount and in that currency, from that vault/);
    /* RED WHEN the root stops hashing the token. */
    await expect(pay(sim, run, 0, { asset: USDC }))
      .rejects.toThrow(/that payee is not in the approved run, at that amount and in that currency, from that vault/);
    await pay(sim, run, 0);
    await pay(sim, run, 1);
    expect([paidLeaf(sim, run, 0), paidLeaf(sim, run, 1)]).toEqual([true, true]);
  });

  it("A PARENT THAT CLAIMS LESS THAN ITS CHILDREN: the amounts a root can pay add up to its total, never more", async () => {
    /*
     * A tree built by somebody who wants two leaves of 200 paid under a root that
     * names a total of 200: the parent claims its right child's sum is zero. The
     * first payee is paid; the second cannot reach the root with any sibling sum,
     * because the parent's hash fixes both sums.
     */
    const payments = [0, 1].map((i) => ({ details: toHex(bytes(40 + i)), nonce: toHex(bytes(80 + i)) }));
    const leaves = payments.map((p) => pureCircuits.payoutLeaf(fromHex(p.details), fromHex(p.nonce)));
    const n0 = pureCircuits.sumLeafNode(leaves[0]!, 200n);
    const n1 = pureCircuits.sumLeafNode(leaves[1]!, 200n);
    let top = pureCircuits.sumInnerNode(n0, 200n, n1, 0n);
    const above: SumStep[] = [];
    for (let d = 1; d < 16; d++) {
      top = pureCircuits.sumInnerNode(top, 200n, 0n, 0n);
      above.push({ sibling: 0n, siblingSum: 0n, goesLeft: true });
    }
    const root = pureCircuits.sumRootOf(top, 200n, GBP);
    const c = change(0n, 41);
    await sim.as(sim.applying(A, c)).proposeRun({ root, payees: 2n, from: OPENS, until: CLOSES, vault: PAYROLL });
    const id = sim.proposalId(pureCircuits.runPayload(root, 2n, OPENS, CLOSES, 0n), c.salt, PAYROLL);
    for (const a of [A, B]) await sim.as(sim.applying(a, c)).approve(id);
    const claim = (i: number, path: SumStep[]) => sim.as(sim.applying(A, c)).recordPaymentFromVault({
      proposal: id, vault: PAYROLL, root, payees: 2n, from: OPENS, until: CLOSES, salt: c.salt,
      details: fromHex(payments[i]!.details), nonce: fromHex(payments[i]!.nonce), amount: 200n, asset: GBP, path,
    });

    await claim(0, [{ sibling: n1, siblingSum: 0n, goesLeft: true }, ...above]);
    /* RED WHEN an inner node stops hashing both children's sums: a sibling sum of zero then reaches the root. */
    await expect(claim(1, [{ sibling: n0, siblingSum: 0n, goesLeft: false }, ...above]))
      .rejects.toThrow(/not in the approved run/);
    await expect(claim(1, [{ sibling: n0, siblingSum: 200n, goesLeft: false }, ...above]))
      .rejects.toThrow(/not in the approved run/);
    expect(sim.ledger.movements.size()).toBe(2n);
  });

  it('A SUM PAST 128 BITS IS REFUSED ON THE WAY UP, not wrapped round to a small total', async () => {
    const run = await raise(sim, PAYROLL, [5n, 7n], 12);
    const max = (1n << 128n) - 1n;
    const path = run.tree.pathFor(0).map((s, d) => (d === 0 ? { ...s, siblingSum: max } : s));
    /* RED WHEN the generated step stops refusing a sum outside `Uint<128>`. */
    await expect(pay(sim, run, 0, { path })).rejects.toThrow(/cast from Field or Uint value to smaller Uint value failed/);
    expect(paidLeaf(sim, run, 0)).toBe(false);
  });

  it('THE COMPILED STEP CONSTRAINS EVERY SUM ON THE PATH TO 128 BITS', () => {
    const ir = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', 'managed', 'zkir', 'recordPaymentFromVault.zkir'), 'utf8'));
    const ops: Array<Record<string, unknown>> = ir.instructions;
    const constrained = ops.filter((op, i) => op.op === 'add'
      && ops[i + 1]?.op === 'constrain_bits' && ops[i + 1]?.bits === 128);
    /* RED WHEN the step's sum is no longer cast back to 128 bits in the circuit, for any of the sixteen levels. */
    expect(constrained).toHaveLength(16);
  });

  it("the device's tree and the account's walk agree on every payee's root, and the root names the asset", () => {
    const amounts = [1n, 2n, 3n, 4n, 5n];
    const payments = amounts.map((_, i) => ({ details: toHex(bytes(70 + i)), nonce: toHex(bytes(90 + i)) }));
    const tree = payoutTreeOf(payments, amounts);
    /* RED WHEN the tree builder and the contract compute a node differently. */
    for (let i = 0; i < amounts.length; i++) {
      expect(toHex(pureCircuits.sumPathRoot(fromHex(tree.leaves[i]!), amounts[i]!, tree.pathFor(i) as never, GBP)))
        .toBe(tree.root);
    }
    expect(tree.total).toBe(15n);
    expect(rootOfLeaves(tree.leaves, amounts, toHex(GBP))).toBe(tree.root);
    /* RED WHEN the root stops committing the run's asset. */
    expect(sumTreeOfLeaves(tree.leaves, amounts, toHex(USDC)).root).not.toBe(tree.root);
  });
});

/* ------------------------------------------------------------------ */

describe("setPolicy: a vault's policy for one token, under governance and the policy's own bar", () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await live(); });

  it('writes the commitment under a key derived from the vault and the token, and marks the vault', async () => {
    const set = await setPolicyOn(sim, PAYROLL, POLICY, 501);
    await set.apply();
    /* RED WHEN the key is derived from anything but the vault and the token's blinded key. */
    expect(sim.roleEntry(policyKeyOf(PAYROLL, GBP))).toEqual(set.commitment);
    /* RED WHEN the marker is not written, or under another key. */
    expect(sim.roleEntry(pureCircuits.policyOnKeyOf(PAYROLL))).toEqual(pureCircuits.policyOnMark());
    expect(sim.roleEntry(pureCircuits.policyOnKeyOf(TREASURY))).toBeUndefined();
    expect(sim.openChange(set.id)).toBeUndefined();
  });

  it("REFUSES A CHANGE SHORT OF THE POLICY'S OWN BAR, set above the account's", async () => {
    const tc = change(0n, 502);
    const bar = pureCircuits.setVaultThresholdPayload(pureCircuits.policyBarKey(), 3n);
    await sim.as(sim.applying(A, tc)).propose(bar);
    const bid = sim.proposalId(bar, tc.salt);
    for (const a of [A, B]) await sim.as(a).approve(bid);
    await sim.as(sim.applying(A, tc)).setVaultThreshold(pureCircuits.policyBarKey(), 3n, bid);

    const set = await setPolicyOn(sim, PAYROLL, POLICY, 503);
    /* RED WHEN setPolicy stops comparing its approvals with the policy's own bar. */
    await expect(set.apply()).rejects.toThrow(/needs the approvals the company set for policy changes/);
    await sim.as(C).approve(set.id);
    await set.apply();
    expect(sim.roleEntry(policyKeyOf(PAYROLL, GBP))).toEqual(set.commitment);
  });

  it('refuses one signer, a round for another policy, and the company-wide vault', async () => {
    const lone = await setPolicyOn(sim, PAYROLL, POLICY, 504, GBP, [A]);
    /* RED WHEN setPolicy stops requiring the round to be approved. */
    await expect(lone.apply()).rejects.toThrow(/not enough approvals yet/);

    const set = await setPolicyOn(sim, PAYROLL, POLICY, 505);
    const other = pureCircuits.policyCommitmentOf({ ...POLICY, blinding: bytes(901) });
    /* RED WHEN the round's payload stops binding the commitment written. */
    await expect(sim.as(sim.applying(A, change(0n, 505))).setPolicy(PAYROLL, other, set.id))
      .rejects.toThrow(/does not authorise this policy/);
    /* RED WHEN the round's payload stops binding the vault. */
    await expect(sim.as(sim.applying(A, change(0n, 505))).setPolicy(TREASURY, set.commitment, set.id))
      .rejects.toThrow(/does not authorise this policy/);

    const company = await setPolicyOn(sim, pureCircuits.companyWide(), POLICY, 506);
    /* RED WHEN setPolicy accepts the company-wide marker as a vault. */
    await expect(company.apply()).rejects.toThrow(/set on one vault, not on the company/);
  });
});

/* ------------------------------------------------------------------ */

describe('clearRun: an approved run charged to its period once, inside its window', () => {
  let sim: AccountSimulator;
  beforeEach(async () => {
    sim = await live();
    await (await setPolicyOn(sim, PAYROLL, POLICY, 510)).apply();
  });

  it("charges the run's total to its period and marks the run cleared", async () => {
    const run = await raise(sim, PAYROLL, [600n, 400n], 20, { required: 2n });
    await clear(sim, run);
    /* RED WHEN the period's total is stored under another key, blinding or amount. */
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toEqual(periodTotalOf(POLICY, 1_000n));
    /* RED WHEN clearing stops writing the cleared mark over the run's change. */
    expect(sim.openChange(run.id)).toEqual(pureCircuits.clearedMark());
    /* RED WHEN a run can be charged twice. */
    await expect(clear(sim, run, { spent: 1_000n })).rejects.toThrow(/already been charged to its period/);
  });

  it('ONE SIGNER CANNOT FILL A PERIOD: a run not yet approved is not charged', async () => {
    const run = await raise(sim, PAYROLL, [1_000n], 21, { approvers: [A] });
    /* RED WHEN clearRun stops asking for the run's approvals. */
    await expect(clear(sim, run)).rejects.toThrow(/not enough approvals yet/);
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toBeUndefined();
  });

  it('a run is charged only inside its window: never before it opens, so a run that can still be withdrawn is never charged', async () => {
    const early = await raise(sim, PAYROLL, [100n], 22, { from: OPENS + 7_200n, until: CLOSES + 7_200n });
    /* RED WHEN clearRun stops waiting for the window to open. */
    await expect(clear(sim, early)).rejects.toThrow(/has not started yet/);
    /* And it can still be withdrawn, uncharged. */
    await sim.as(A).cancel(early.id);
    const late = await raise(sim, PAYROLL, [100n], 23, { from: OPENS - 7_200n, until: OPENS - 3_600n });
    /* RED WHEN clearRun charges a run whose window has closed. */
    await expect(clear(sim, late)).rejects.toThrow(/payment window for this run has closed/);
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toBeUndefined();
  });

  it("refuses a total or a token other than the ones the run's root commits to", async () => {
    const run = await raise(sim, PAYROLL, [500n], 24);
    /* RED WHEN clearRun stops checking the total against the root. */
    await expect(clear(sim, run, { total: 499n })).rejects.toThrow(/total or currency is not the one the signers approved for this run/);
    /* RED WHEN the token the policy is looked up by is not the token in the root. */
    await expect(clear(sim, run, { asset: USDC })).rejects.toThrow(/total or currency is not the one the signers approved for this run/);
  });

  it("A VAULT UNDER A POLICY REFUSES A TOKEN ITS POLICY DOES NOT NAME", async () => {
    const run = await raise(sim, PAYROLL, [500n], 25, { asset: USDC });
    /* RED WHEN clearRun stops requiring a policy for the run's own token. */
    await expect(clear(sim, run)).rejects.toThrow(/no spending policy for the currency this run pays in/);
    /* RED WHEN the receipt step pays a vault under a policy without a charge. */
    await expect(pay(sim, run, 0)).rejects.toThrow(/charge this run to its period, then pay it/);
  });

  it("refuses a run raised with fewer approvals than its band needs", async () => {
    const run = await raise(sim, PAYROLL, [1_200n], 26, { required: 2n, approvers: [A, B, C] });
    /* RED WHEN clearRun stops comparing the run's `required` with its band. */
    await expect(clear(sim, run)).rejects.toThrow(/needs more approvals than it was raised with/);
    const ok = await raise(sim, PAYROLL, [1_200n], 27, { required: 3n, approvers: [A, B, C] });
    await clear(sim, ok);
  });

  it("refuses a total above every band", async () => {
    const run = await raise(sim, PAYROLL, [100_001n], 28, { required: 3n, approvers: [A, B, C] });
    /* RED WHEN a total past the last ceiling is read as fitting a band. */
    await expect(clear(sim, run)).rejects.toThrow(/above every band/);
  });

  it("refuses a window that leaves the period it is charged to, at either end", async () => {
    const starts = POLICY.terms.periodStart;
    const ends = starts + POLICY.terms.periodLength;
    sim.at(Number(starts) + 60);
    const across = await raise(sim, PAYROLL, [100n], 29, { from: starts - 60n, until: starts + 3_600n });
    /* RED WHEN clearRun stops refusing a window that starts before its period. */
    await expect(clear(sim, across)).rejects.toThrow(/starts before the period it is charged to/);
    sim.at(Number(ends) - 60);
    const past = await raise(sim, PAYROLL, [100n], 30, { from: ends - 3_600n, until: ends + 60n });
    /* RED WHEN clearRun stops refusing a window that ends after its period. */
    await expect(clear(sim, past)).rejects.toThrow(/ends after the period it is charged to/);
    /* And a window that ends exactly as the period does is inside it. */
    const exact = await raise(sim, PAYROLL, [100n], 31, { from: ends - 3_600n, until: ends });
    await clear(sim, exact);
  });

  it("refuses a run that takes the vault past its limit for the period, whichever signer clears it", async () => {
    const first = await raise(sim, PAYROLL, [1_000n], 32);
    await clear(sim, first);
    const second = await raise(sim, PAYROLL, [600n], 33);
    /* RED WHEN clearRun stops comparing the period's new total with its limit. */
    await expect(clear(sim, second, { spent: 1_000n, device: B })).rejects.toThrow(/past its limit for the period/);
    const third = await raise(sim, PAYROLL, [500n], 34);
    /* Another signer opens the same total: its blinding comes from the policy and the period. */
    await clear(sim, third, { spent: 1_000n, device: B });
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toEqual(periodTotalOf(POLICY, 1_500n));
  });

  it("refuses a device that says the period has been charged less than it has", async () => {
    const first = await raise(sim, PAYROLL, [1_000n], 35);
    /* RED WHEN a fresh period accepts a non-zero opening. */
    await expect(clear(sim, first, { spent: 5n })).rejects.toThrow(/the account has nothing charged to it/);
    await clear(sim, first);
    const second = await raise(sim, PAYROLL, [400n], 36);
    /* RED WHEN clearRun stops checking the stored total against what the device says. */
    await expect(clear(sim, second, { spent: 0n })).rejects.toThrow(/not what this vault has spent in the period/);
  });

  it("A RETRY OVER THE SAME TREE IN THE SAME PERIOD IS NOT CHARGED A SECOND TIME", async () => {
    const run = await raise(sim, PAYROLL, [600n, 400n], 37);
    await clear(sim, run);
    await pay(sim, run, 0);
    const retry = await raiseAgain(sim, run, 38);
    /* RED WHEN the charge stops being kept per tree and period: the retry would take the period to 2,000. */
    await clear(sim, retry, { spent: 1_000n });
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toEqual(periodTotalOf(POLICY, 1_000n));
    expect(sim.openChange(retry.id)).toEqual(pureCircuits.clearedMark());
    /* The payee the first round paid is not paid again through the retry; the other is. */
    await expect(pay(sim, retry, 0)).rejects.toThrow(/already been made/);
    await pay(sim, retry, 1);
    /* A different tree of the same total is a different run, and is charged. */
    const other = await raise(sim, PAYROLL, [600n, 400n], 39);
    await expect(clear(sim, other, { spent: 1_000n })).rejects.toThrow(/past its limit for the period/);
  });

  it("A NEW POLICY STARTS THE PERIOD AFRESH, because the period's key includes the policy", async () => {
    const run = await raise(sim, PAYROLL, [1_000n], 40);
    await clear(sim, run);
    const next: PolicyOpening = { ...POLICY, blinding: bytes(902) };
    await (await setPolicyOn(sim, PAYROLL, next, 511)).apply();
    const again = await raise(sim, PAYROLL, [1_000n], 41);
    /* RED WHEN the period's key stops including the policy's commitment: the old total would be read. */
    await clear(sim, again, { policy: next });
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, next))).toEqual(periodTotalOf(next, 1_000n));
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toEqual(periodTotalOf(POLICY, 1_000n));
  });

  it("REFUSES ARGUMENTS THAT DO NOT REBUILD THE RUN: a cheap tree cannot clear a big run", async () => {
    const run = await raise(sim, PAYROLL, [1_400n], 43);
    const cheap = payoutTreeOf(
      [{ details: toHex(bytes(700)), nonce: toHex(bytes(701)) }], [10n], GBP);
    const state = { ...sim.applying(A, run.c), policy: POLICY, periodSpent: 0n };
    /* RED WHEN clearRun stops rebuilding the run's id from what it is given. */
    await expect(sim.as(state).clearRun({
      proposal: run.id, vault: run.vault, root: fromHex(cheap.root), payees: cheap.payees,
      from: run.from, until: run.until, required: run.required, salt: run.c.salt,
      top: cheap.top, total: cheap.total, period: 0n,
    })).rejects.toThrow(/that is not this run, or you were not given it/);
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toBeUndefined();
    expect(sim.openChange(run.id)).not.toEqual(pureCircuits.clearedMark());
  });

  it("A LATER PERIOD IS ITS OWN: a window in period 0 is refused for period 1, and period 1 is charged apart", async () => {
    const now = await raise(sim, PAYROLL, [1_000n], 44);
    /* RED WHEN a period's start stops being its index times the period's length. */
    await expect(clear(sim, now, { period: 1n })).rejects.toThrow(/starts before the period it is charged to/);
    await clear(sim, now);
    const next = POLICY.terms.periodStart + POLICY.terms.periodLength;
    sim.at(Number(next) + 5 * DAY);
    const later = await raise(sim, PAYROLL, [1_000n], 45, { from: next + 4n * BigInt(DAY), until: next + 6n * BigInt(DAY) });
    /* RED WHEN the period's key leaves out the period: period 0's total would be read here. */
    await clear(sim, later, { period: 1n });
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY, 1n))).toEqual(periodTotalOf(POLICY, 1_000n, 1n));
    /* RED WHEN the period's blinding leaves out the period. */
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY, 1n))).not.toEqual(periodTotalOf(POLICY, 1_000n, 0n));
    expect(sim.roleEntry(periodKeyOf(PAYROLL, GBP, POLICY))).toEqual(periodTotalOf(POLICY, 1_000n));
  });

  it("refuses an opening that is not the vault's policy", async () => {
    const run = await raise(sim, PAYROLL, [100n], 42);
    /* RED WHEN clearRun stops checking the opening against the stored commitment. */
    await expect(clear(sim, run, { policy: { ...POLICY, terms: { ...POLICY.terms, periodLimit: 10n ** 12n } } }))
      .rejects.toThrow(/not this vault's current policy for this currency/);
  });
});

/* ------------------------------------------------------------------ */

describe('the receipt step with a policy: only a cleared run of the vault\'s own, at the approvals it needs', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await live(); });

  it('A VAULT WITH NO POLICY IS PAID AS TODAY, and one with a policy only once a run is cleared', async () => {
    const today = await raise(sim, TREASURY, [100n], 50);
    /* RED WHEN a vault with no marker is asked for a charge. */
    await pay(sim, today, 0);

    await (await setPolicyOn(sim, PAYROLL, POLICY, 512)).apply();
    const run = await raise(sim, PAYROLL, [100n, 200n], 51);
    /* RED WHEN the step stops asking a vault under a policy for a cleared run. */
    await expect(pay(sim, run, 0)).rejects.toThrow(/charge this run to its period, then pay it/);
    await clear(sim, run);
    await pay(sim, run, 0);
    await pay(sim, run, 1);
    expect([paidLeaf(sim, run, 0), paidLeaf(sim, run, 1)]).toEqual([true, true]);
  });

  it("A VAULT UNDER A POLICY DOES NOT PAY A COMPANY-WIDE RUN", async () => {
    await (await setPolicyOn(sim, PAYROLL, POLICY, 513)).apply();
    const inner = bytes(60);
    const payments = [{ details: toHex(pureCircuits.companyWideDetailsOf(inner, PAYROLL)), nonce: toHex(bytes(61)) }];
    const tree = payoutTreeOf(payments, [100n]);
    const c = change(0n, 60);
    const company = pureCircuits.companyWide();
    await sim.as(sim.applying(A, c)).proposeRun({ root: fromHex(tree.root), payees: 1n, from: OPENS, until: CLOSES, vault: company });
    const id = sim.proposalId(pureCircuits.runPayload(fromHex(tree.root), 1n, OPENS, CLOSES, 0n), c.salt, company);
    for (const a of [A, B]) await sim.as(sim.applying(a, c)).approve(id);
    const claim = (payer: Uint8Array) => sim.as(sim.applying(A, c)).recordPaymentFromVault({
      proposal: id, vault: company, payingVault: payer, root: fromHex(tree.root), payees: 1n,
      from: OPENS, until: CLOSES, salt: c.salt, details: inner, nonce: fromHex(payments[0]!.nonce), ...sumArgsOf(tree, 0),
    });
    /* RED WHEN a vault under a policy may pay a run no period was charged for. */
    await expect(claim(PAYROLL)).rejects.toThrow(/has a spending policy, so it pays only its own runs/);
    /* And a company-wide run cannot be cleared: no policy can be set on the company. */
    await expect(clear(sim, {
      tree, id, c, payments, required: 0n, from: OPENS, until: CLOSES, vault: company,
    })).rejects.toThrow(/no spending policy for the currency this run pays in/);
  });

  it("A RUN'S REQUIRED APPROVALS ARE HELD FROM ITS RAISING AND COMPARED AT EVERY PAYMENT", async () => {
    const run = await raise(sim, PAYROLL, [100n], 52, { required: 3n });
    /* RED WHEN propose stops folding the run's `required` into the bar it holds. */
    expect(sim.holdOf(run.id)?.needed).toBe(3n);
    /* RED WHEN the step reads neither the hold nor `required`: two approvals would pay a run raised needing three. */
    await expect(pay(sim, run, 0)).rejects.toThrow(/not enough approvals yet/);
    await sim.as(sim.applying(C, run.c)).approve(run.id);
    /* RED WHEN `required` stops being part of the run's identity: a payment claiming less would be accepted. */
    await expect(pay(sim, run, 0, { required: 2n })).rejects.toThrow(/that is not this proposal/);
    await pay(sim, run, 0);
    expect(paidLeaf(sim, run, 0)).toBe(true);
  });

  it("a run needing fewer approvals than its vault still needs the vault's bar", async () => {
    const run = await raise(sim, PAYROLL, [100n], 53, { required: 1n, approvers: [A] });
    /* RED WHEN `required` below the vault's bar lowers the bar. */
    expect(sim.holdOf(run.id)?.needed).toBe(2n);
    await expect(pay(sim, run, 0)).rejects.toThrow(/not enough approvals yet/);
  });
});

/* ------------------------------------------------------------------ */

describe('what setting a policy and charging a run publish', () => {
  /* Numbers no other field of these calls holds, so a hit names one of them. */
  const PRIVATE_POLICY: PolicyOpening = {
    terms: {
      bands: [
        { ceiling: 5_432_109n, approvals: 2n }, { ceiling: 6_000_001n, approvals: 3n },
        { ceiling: 7_000_003n, approvals: 3n }, { ceiling: 8_000_005n, approvals: 3n },
      ],
      periodLimit: 9_876_543n, periodStart: BigInt(NOW - 10 * DAY), periodLength: BigInt(30 * DAY),
    },
    blinding: bytes(903),
  };
  const TOTAL = 1_111_111n;

  it("setPolicy publishes the vault, where its policy sits, the commitment and the marker, and nothing of the policy or its token", async () => {
    const sim = await live();
    const set = await setPolicyOn(sim, PAYROLL, PRIVATE_POLICY, 520);
    const tape = Transcript.watch(sim.contract).clear();
    await set.apply();
    const t = tape.last;
    tape.stop();
    t.assertNotVacuous();
    /* RED WHEN setPolicy stops writing any of these where the chain can read them. */
    t.assertPublishes({
      "the policy's key": policyKeyOf(PAYROLL, GBP),
      "the policy's commitment": set.commitment,
      "the marker's key": pureCircuits.policyOnKeyOf(PAYROLL),
    });
    /*
     * RED WHEN the token, the token's key, the policy's terms or its blinding reach the transcript.
     * The vault itself is not published either, only keys hashed from it; a vault's address is
     * public, so an observer who hashes it can still tell which vault is under a policy.
     */
    t.assertAbsent({
      'the vault': PAYROLL,
      'the token': GBP,
      "the token's blinded key": assetKeyOf(GBP),
      "the policy's blinding": PRIVATE_POLICY.blinding,
      'the period limit': PRIVATE_POLICY.terms.periodLimit,
      'the first ceiling': PRIVATE_POLICY.terms.bands[0]!.ceiling,
    });
  });

  it("clearRun publishes the run, the vault, the period's key and its new total's commitment, and not the total, the tree or the policy", async () => {
    const sim = await live();
    await (await setPolicyOn(sim, PAYROLL, PRIVATE_POLICY, 521)).apply();
    const run = await raise(sim, PAYROLL, [TOTAL], 522);
    const tape = Transcript.watch(sim.contract).clear();
    await clear(sim, run, { policy: PRIVATE_POLICY });
    const t = tape.last;
    tape.stop();
    t.assertNotVacuous();
    const periodKey = periodKeyOf(PAYROLL, GBP, PRIVATE_POLICY);
    /* RED WHEN clearRun stops writing any of these where the chain can read them. */
    t.assertPublishes({
      'the run': run.id,
      'the vault': PAYROLL,
      "the policy's key": policyKeyOf(PAYROLL, GBP),
      "the period's key": periodKey,
      "the period's new total, committed": periodTotalOf(PRIVATE_POLICY, TOTAL),
      'the record that this tree was charged': pureCircuits.chargedKeyOf(periodKey, fromHex(run.tree.root)),
      'the cleared mark': pureCircuits.clearedMark(),
    });
    /* RED WHEN the run's total, its tree, its salt, its token or the policy's terms reach the transcript. */
    t.assertAbsent({
      "the run's total": TOTAL,
      "the run's root": fromHex(run.tree.root),
      "the run's salt": run.c.salt,
      'the token': GBP,
      "the token's blinded key": assetKeyOf(GBP),
      "the policy's blinding": PRIVATE_POLICY.blinding,
      'the period limit': PRIVATE_POLICY.terms.periodLimit,
      "the payee's leaf": fromHex(run.tree.leaves[0]!),
    });
  });
});
