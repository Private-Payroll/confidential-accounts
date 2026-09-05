/**
 * V-32 and V-33: a proposal belongs to a vault, and a payout completes it.
 *
 * These are the properties the vault design rests on, and none of them existed
 * before this change. Each states the thing that must be true and, where there
 * is an attack, plays it and asserts the refusal — the same shape as the M-70
 * tests, which were written as exploits that used to pass.
 *
 * The one to read first is "a proposal for one vault is meaningless at
 * another". It is what lets a vault ask this account whether a payment was
 * approved WITHOUT the account knowing who is asking — and that matters because
 * a contract on Midnight cannot see its caller. The scoping had to live in the
 * proposal's identity because it could not live in an access check.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountSimulator, privateStateFor, change, type Change,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { buildPayoutTree } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';
import { readFileSync } from 'node:fs';

const A = privateStateFor(1);
const B = privateStateFor(2);

type Device = ReturnType<typeof privateStateFor>;

const payload = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Two vault addresses. Any 32 bytes will do — the contract never dereferences them. */
const PAYROLL = new Uint8Array(32).fill(0xa1);
const TREASURY = new Uint8Array(32).fill(0xb2);
const NO_VAULT = pureCircuits.noVault();

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: Device, c: Change) =>
  sim.applying(d, c);

/** A live two-signer account. */
const liveAccount = async (threshold = 2n) => {
  const sim = await AccountSimulator.liveAccount([A, B], threshold);
  sim.at(RUN_NOW);
  return sim;
};

/**
 * Raises a ONE-PAYEE run for `vault` and takes it to the threshold.
 *
 * A run of one, because these tests are about THRESHOLDS rather than about
 * runs — the interesting number here is how many approvals a vault demands, and
 * a single payee is the shortest path to spending one. Runs of many are
 * `payout-runs.test.ts`.
 */
/* The window every run in this file is approved for. V-67; these tests are
 * about thresholds, so the clock is pinned and stays out of the way. */
const RUN_NOW = 1_800_000_000;
const RUN_OPENS = BigInt(RUN_NOW - 3_600);
const RUN_CLOSES = BigInt(RUN_NOW + 3_600);

const approvedFor = async (
  sim: AccountSimulator, vault: Uint8Array, p: Uint8Array, c: Change,
) => {
  const payee = { details: toHex(p), nonce: toHex(payload(0x5a)) };
  const tree = buildPayoutTree([payee]);
  const runPayload = pureCircuits.runPayload(
    fromHex(tree.root), tree.payees, RUN_OPENS, RUN_CLOSES);
  await sim.as(carrying(sim, A, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees,
    from: RUN_OPENS, until: RUN_CLOSES, vault,
  });
  const id = sim.proposalId(runPayload, c.salt, vault);
  await sim.as(carrying(sim, A, c)).approve(id);
  await sim.as(carrying(sim, B, c)).approve(id);
  return {
    id,
    claim: {
      proposal: id, vault, root: fromHex(tree.root), payees: tree.payees,
      from: RUN_OPENS, until: RUN_CLOSES, salt: c.salt,
      details: fromHex(payee.details), nonce: fromHex(payee.nonce), path: tree.pathFor(0),
    },
  };
};

/*
 * "V-32: a proposal belongs to exactly one vault" USED TO BE HERE, and its
 * eight tests moved to `payout-runs.test.ts` rather than being deleted.
 *
 * V-41 replaced `claimApproval` — one claim, one proposal — with `recordPayment`,
 * which pays ONE PAYEE of a run and finishes the proposal on the last of them.
 * Every property those tests pinned still holds and is still tested: a run for
 * one vault is meaningless at another, a claim without the salt is refused, a
 * claim below the threshold is refused, a claimant need not be a signer, and
 * the circuit reads nothing from the account's private state.
 *
 * They live beside the new ones because the run is now the unit, and splitting
 * "the same rule, one payee at a time" across two files would be two places to
 * look for one answer.
 */

describe('V-33: a threshold per vault', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await liveAccount(2n); });

  it('a vault with no rule of its own inherits the account threshold', async () => {
    const c = govChange(21);
    const run = await approvedFor(sim, PAYROLL, payload(7), c);
    // Two approvals against an account threshold of two: payable.
    await sim.as(carrying(sim, A, c)).recordPayment(run.claim);
    // Open until its window shuts — V-67; the payment is what proves it went through.
    expect(sim.ledger.movements.member(
      pureCircuits.paidMovementOf(pureCircuits.payoutLeaf(
        run.claim.details, run.claim.nonce)))).toBe(true);
  });

  it('a vault given a higher threshold demands it, and the account is unaffected', async () => {
    // Raise the treasury to 3 through governance.
    const g = govChange(22);
    const raisePayload = pureCircuits.setVaultThresholdPayload(TREASURY, 3n);
    await sim.as(carrying(sim, A, g)).propose(raisePayload, NO_VAULT);
    const gid = sim.proposalId(raisePayload, g.salt, NO_VAULT);
    await sim.as(carrying(sim, A, g)).approve(gid);
    await sim.as(carrying(sim, B, g)).approve(gid);
    await sim.as(carrying(sim, A, g)).setVaultThreshold(TREASURY, 3n, gid);

    // Two approvals is no longer enough for the treasury…
    const c = govChange(23);
    const run = await approvedFor(sim, TREASURY, payload(8), c);
    await expect(sim.as(carrying(sim, A, c)).recordPayment(run.claim))
      .rejects.toThrow(/not enough approvals/i);

    // …while payroll, which has no rule of its own, still needs only two.
    const c2 = govChange(24);
    const run2 = await approvedFor(sim, PAYROLL, payload(9), c2);
    await sim.as(carrying(sim, A, c2)).recordPayment(run2.claim);
    expect(sim.ledger.movements.member(
      pureCircuits.paidMovementOf(pureCircuits.payoutLeaf(
        run2.claim.details, run2.claim.nonce)))).toBe(true);
  });

  it('refuses a vault threshold of zero, which would authorise anything', async () => {
    const g = govChange(25);
    const p = pureCircuits.setVaultThresholdPayload(PAYROLL, 0n);
    await sim.as(carrying(sim, A, g)).propose(p, NO_VAULT);
    const gid = sim.proposalId(p, g.salt, NO_VAULT);
    await sim.as(carrying(sim, A, g)).approve(gid);
    await sim.as(carrying(sim, B, g)).approve(gid);

    await expect(sim.as(carrying(sim, A, g)).setVaultThreshold(PAYROLL, 0n, gid))
      .rejects.toThrow(/zero would authorise anything/i);
  });

  it('refuses a vault threshold change bound to a DIFFERENT proposal', async () => {
    /*
     * The same defect M-102 pinned for `setThreshold`, in the new circuit: an
     * approved proposal is authority for ONE change, not for the circuit that
     * change happens to live in. Without the binding assert, signers approving
     * "raise payroll to three" would be authority for "raise the treasury to
     * anything", and the approval record would say they had agreed to it.
     *
     * Both halves of the payload are checked, because the payload commits to
     * the vault AND the number and either one drifting is the same hole.
     */
    const g = govChange(28);
    const p = pureCircuits.setVaultThresholdPayload(PAYROLL, 3n);
    await sim.as(carrying(sim, A, g)).propose(p, NO_VAULT);
    const gid = sim.proposalId(p, g.salt, NO_VAULT);
    await sim.as(carrying(sim, A, g)).approve(gid);
    await sim.as(carrying(sim, B, g)).approve(gid);

    // Same number, different vault.
    await expect(sim.as(carrying(sim, A, g)).setVaultThreshold(TREASURY, 3n, gid))
      .rejects.toThrow(/does not authorise this vault threshold/i);
    // Same vault, different number.
    await expect(sim.as(carrying(sim, A, g)).setVaultThreshold(PAYROLL, 9n, gid))
      .rejects.toThrow(/does not authorise this vault threshold/i);

    // And the proposal it really authorises still goes through.
    await sim.as(carrying(sim, A, g)).setVaultThreshold(PAYROLL, 3n, gid);
    expect(sim.isOpen(gid)).toBe(false);
  });

  it('refuses a vault threshold change before the account threshold is met', async () => {
    /*
     * A vault rule is governance, and one signer must not be able to set it
     * alone — lowering a vault's threshold to one is exactly how a single
     * signer would give themselves the account.
     */
    const g = govChange(30);
    const p = pureCircuits.setVaultThresholdPayload(PAYROLL, 1n);
    await sim.as(carrying(sim, A, g)).propose(p, NO_VAULT);
    const gid = sim.proposalId(p, g.salt, NO_VAULT);
    await sim.as(carrying(sim, A, g)).approve(gid);   // one of two

    await expect(sim.as(carrying(sim, A, g)).setVaultThreshold(PAYROLL, 1n, gid))
      .rejects.toThrow(/not enough approvals/i);
    expect(sim.isOpen(gid)).toBe(true);
  });

  it('refuses a vault threshold change from someone who is not a signer', async () => {
    /*
     * `recordPayment` deliberately has no `requireSigner` — a vault is not a
     * signer. This circuit is the opposite case and must keep one: it is
     * governance, and the salt alone must not be enough to change a rule.
     *
     * `mallory` is nobody, and carries the correct salt precisely so that the
     * salt is not what refuses her.
     */
    const g = govChange(29);
    const p = pureCircuits.setVaultThresholdPayload(PAYROLL, 3n);
    await sim.as(carrying(sim, A, g)).propose(p, NO_VAULT);
    const gid = sim.proposalId(p, g.salt, NO_VAULT);
    await sim.as(carrying(sim, A, g)).approve(gid);
    await sim.as(carrying(sim, B, g)).approve(gid);

    const mallory = privateStateFor(99);
    await expect(sim.as(sim.applying(mallory, g))
      .setVaultThreshold(PAYROLL, 3n, gid)).rejects.toThrow(/not a signer on this account/i);
    expect(sim.isOpen(gid)).toBe(true);
  });

  it('governance still answers to the ACCOUNT threshold, not to any vault rule', async () => {
    /*
     * Governance proposals name `noVault()`, which no vault address can equal,
     * so they can never pick up a vault's rule. That is also what let
     * `requireApproved` drop the lookup entirely and recover the 8% of proving
     * cost the first version of this change had added.
     */
    const g = govChange(26);
    const raise = pureCircuits.setVaultThresholdPayload(PAYROLL, 3n);
    await sim.as(carrying(sim, A, g)).propose(raise, NO_VAULT);
    const gid = sim.proposalId(raise, g.salt, NO_VAULT);
    await sim.as(carrying(sim, A, g)).approve(gid);
    await sim.as(carrying(sim, B, g)).approve(gid);
    await sim.as(carrying(sim, A, g)).setVaultThreshold(PAYROLL, 3n, gid);

    // A later governance action still needs two, not three.
    const g2 = govChange(27);
    const p2 = pureCircuits.setVaultThresholdPayload(TREASURY, 2n);
    await sim.as(carrying(sim, A, g2)).propose(p2, NO_VAULT);
    const gid2 = sim.proposalId(p2, g2.salt, NO_VAULT);
    await sim.as(carrying(sim, A, g2)).approve(gid2);
    await sim.as(carrying(sim, B, g2)).approve(gid2);
    await sim.as(carrying(sim, A, g2)).setVaultThreshold(TREASURY, 2n, gid2);
    expect(sim.isOpen(gid2)).toBe(false);
  });
});

describe('V-33: the reserved signer scope', () => {
  it('every signer is seated with the all-vaults sentinel, and nothing branches on it', async () => {
    /*
     * The field exists so the leaf's SHAPE is settled while that is free.
     * Changing it later would mean removing and re-seating every signer on a
     * live account — the one operation that must never be forced.
     *
     * This test pins that the sentinel is what seating uses. When per-vault
     * scopes become real, this test is what says so out loud.
     */
    const sim = await liveAccount();
    expect(hex(A.scope)).toBe(hex(pureCircuits.allVaults()));
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(A))).toBeDefined();
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(B))).toBeDefined();
  });

  /**
   * **THE INERTNESS, CHECKED RATHER THAN CLAIMED.** §3.7 of
   * `docs/scope-the-vault-system.md`, scheduled with `S6` and written in `S6c`.
   *
   * The test above is named *"and nothing branches on it"* and its body asserts
   * only the first half of that sentence. **A name that promises more than the
   * body checks is worse than no test**: it is what a reviewer greps for, finds,
   * and moves on from. This is the missing half, and the review that asked for
   * it called it the cheapest test in that document.
   *
   * **WHY IT CANNOT BE A SIMULATION.** Inertness is the absence of a branch. A
   * simulator can show that today's calls behave the same whatever the scope
   * is — which is what would be true anyway while every signer carries the same
   * sentinel. The property is about the SOURCE: `signerScope()` is read, put
   * into the leaf, and never compared with anything. So the source is what is
   * read.
   *
   * **WHAT BREAKS IF IT EVER DOES BRANCH, AND IT IS NOT A STYLE POINT.** Every
   * signer on a live account is seated with `allVaults()`. A circuit that
   * started comparing a scope against a vault would refuse those signers at the
   * only moment the refusal matters — the account's own governance — and the
   * repair is to re-seat every signer, which
   * `ConfidentialAccount.compact:625-629` names as *"the one operation on a
   * live account holding money that must never be forced"*. The whole point of
   * reserving the field was that turning it on later costs no migration; a
   * branch added by accident spends that.
   *
   * The check is deliberately narrow: `signerScope()` may appear as an argument
   * to `signerLeaf(...)` and in the witness declaration, and nowhere else. It
   * is not a ban on the identifier — a widened check that also matched comments
   * would fail the day somebody explained the rule.
   */
  it('V-33: no circuit BRANCHES on signerScope — it only ever feeds the leaf', () => {
    const source = readFileSync(
      new URL('../src/ConfidentialAccount.compact', import.meta.url), 'utf8');

    /*
     * Comments stripped first. The contract explains this reservation at
     * length, and a check that read prose as code would be a check nobody could
     * keep green while documenting the thing it protects.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    const lines = code.split('\n')
      .map((line, i) => ({ line, at: i + 1 }))
      .filter(({ line }) => line.includes('signerScope'));

    /*
     * ONE call site and one declaration, and the COUNT is asserted: a SECOND
     * call site appearing is exactly the event this test exists to notice, and
     * a check that only looked at the lines it found would pass for a new one
     * that happened to be shaped right.
     *
     * **IT SAID THREE AND IT SAYS TWO, AND THAT IS A TIGHTENING. DO NOT PUT
     * THE THREE BACK.** `C334`, `S35`, and the deleted site is the reason.
     *
     * The third reader was the CONSTRUCTOR, which derived the DEPLOYING
     * PROCESS'S OWN SEAT from `localSecretKey()`, `signerBlinding()` and
     * `signerScope()` and seated the leaf it built. On the only deploy path
     * that ever existed those secrets were `seededBytes(1)` and
     * `seededBytes(401)` — a published formula in a repository that is going
     * public — so every account this project deployed carried a signer ANY
     * READER COULD BE, holding one permanent approval toward every threshold,
     * including every `recordPayment` that moves a vault's money. `S35`
     * deleted it and the founding leaf now ARRIVES as a public argument;
     * `ConfidentialAccount.compact:1441-1479` is that decision written where
     * the line used to be.
     *
     * So a `signerScope()` reader reappearing outside `signerLeaf(...)` is no
     * longer only the branching question below — it is a circuit deriving a
     * seat again, which is the `P0` `C334` closed. This count going back UP is
     * a regression to refuse, not a stale pin to re-point.
     */
    expect(lines.map(l => l.at)).toHaveLength(2);

    /*
     * **AND THE OCCURRENCES, NOT ONLY THE LINES.** `S40`, found by this round's
     * `money-safety-auditor` against this round's own comment.
     *
     * `lines` is a per-LINE filter, so a SECOND reader written onto line 246
     * beside the first raises no count — and the shape check below tests the
     * whole line against `signerLeaf(...signerScope()...)`, which a line
     * holding two statements still satisfies. The paragraph above claims a
     * second reader is noticed. **This is the line that makes that claim
     * true**, and without it the comment described a stricter check than the
     * body performed (rule 14).
     *
     * One file over, `scripts/disclose-scan.test.ts` carries the same lesson
     * pointing the other way: it counts SITES rather than lines because
     * `grep -c` counts lines and misses four sites written on one.
     */
    expect(code.match(/signerScope/g) ?? []).toHaveLength(2);

    for (const { line, at } of lines) {
      const ok =
        /^\s*witness signerScope\(\)\s*:\s*Bytes<32>;\s*$/.test(line)
        || /signerLeaf\([^;]*signerScope\(\)[^;]*\)/.test(line);
      expect(ok, `ConfidentialAccount.compact:${at} reads signerScope() somewhere other than `
        + `signerLeaf(...):\n  ${line.trim()}\n`
        + 'The scope is RESERVED AND INERT. Every signer on a live account is seated with '
        + 'allVaults(), so a circuit that branches on the scope refuses all of them, and the '
        + 'repair is to re-seat every signer on an account holding money — the one operation '
        + 'the contract itself says must never be forced. If per-vault scopes are being turned '
        + 'on deliberately, this test is where that decision gets written down.').toBe(true);
    }

    /*
     * And no comparison of the value anywhere, in any spelling. `signerLeaf`'s
     * argument list cannot contain one, so this is belt and braces against a
     * future line that satisfies the shape above and also compares.
     */
    expect(code).not.toMatch(/signerScope\(\)\s*(==|!=|<|>)/);
    expect(code).not.toMatch(/(==|!=|<|>)\s*signerScope\(\)/);
  });

  it('a signer whose scope differs has a DIFFERENT leaf, and is not on the account', async () => {
    /*
     * The proof that the scope is genuinely inside the identity rather than
     * beside it. Same key, same blinding, different scope — a different leaf,
     * and the tree does not know it.
     */
    const sim = await liveAccount();
    const odd = { ...A, scope: new Uint8Array(32).fill(0x77) };
    expect(hex(sim.leafOf(odd))).not.toBe(hex(sim.leafOf(A)));
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(odd))).toBeUndefined();
  });
});
