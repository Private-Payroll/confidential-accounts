/**
 * A proposal belongs to a vault, and a payout completes it.
 *
 * These are the properties the vault design rests on, and none of them existed
 * before this change. Each states the thing that must be true and, where there
 * is an attack, plays it and asserts the refusal — the same shape as the
 * earlier exploit tests, which were written as attacks that used to pass.
 *
 * The one to read first is "a proposal for one vault is meaningless at
 * another". It is what lets a vault ask this account whether a payment was
 * approved WITHOUT the account knowing who is asking — and that matters because
 * a contract on Midnight cannot see its caller. The scoping had to live in the
 * proposal's identity because it could not live in an access check.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, sumArgsOf,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
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
/* The window every run in this file is approved for; these tests are
 * about thresholds, so the clock is pinned and stays out of the way. */
const RUN_NOW = 1_800_000_000;
const RUN_OPENS = BigInt(RUN_NOW - 3_600);
const RUN_CLOSES = BigInt(RUN_NOW + 3_600);

const approvedFor = async (
  sim: AccountSimulator, vault: Uint8Array, p: Uint8Array, c: Change,
) => {
  await sim.adoptVault(vault, [A, B]);
  const payee = { details: toHex(p), nonce: toHex(payload(0x5a)) };
  const tree = payoutTreeOf([payee]);
  const runPayload = pureCircuits.runPayload(
    fromHex(tree.root), tree.payees, RUN_OPENS, RUN_CLOSES, 0n);
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
      details: fromHex(payee.details), nonce: fromHex(payee.nonce), ...sumArgsOf(tree, 0),
    },
  };
};

/*
 * "a proposal belongs to exactly one vault" USED TO BE HERE, and its eight
 * tests moved to `payout-runs.test.ts` rather than being deleted.
 *
 * Runs replaced `claimApproval` — one claim, one proposal — with
 * `recordPayment`, which pays ONE PAYEE of a run and finishes the proposal on
 * the last of them. Every property those tests pinned still holds and is still
 * tested: a run for one vault is meaningless at another, a claim without the
 * salt is refused, a claim below the threshold is refused, a claimant need not
 * be a signer, and the circuit reads nothing from the account's private state.
 *
 * They live beside the new ones because the run is now the unit, and splitting
 * "the same rule, one payee at a time" across two files would be two places to
 * look for one answer.
 */

describe('a threshold per vault', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await liveAccount(2n); });

  it('a vault with no rule of its own inherits the account threshold', async () => {
    const c = govChange(21);
    const run = await approvedFor(sim, PAYROLL, payload(7), c);
    // Two approvals against an account threshold of two: payable.
    await sim.as(carrying(sim, A, c)).recordPaymentFromVault(run.claim);
    // Open until its window shuts; the payment is what proves it went through.
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
    await expect(sim.as(carrying(sim, A, c)).recordPaymentFromVault(run.claim))
      .rejects.toThrow(/not enough approvals/i);

    // …while payroll, which has no rule of its own, still needs only two.
    const c2 = govChange(24);
    const run2 = await approvedFor(sim, PAYROLL, payload(9), c2);
    await sim.as(carrying(sim, A, c2)).recordPaymentFromVault(run2.claim);
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
     * The same defect already pinned for `setThreshold`, in the new circuit: an
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

describe('the reserved signer scope', () => {
  it('a signer seated without rights is seated with the all-vaults sentinel', async () => {
    /*
     * The sentinel means every right on every vault, and it is what every seat
     * the product makes today carries. A seat with rights carries the hash of
     * its rights record instead; `rights-live-in-each-signers-leaf.test.ts`
     * covers those.
     */
    const sim = await liveAccount();
    expect(hex(A.scope)).toBe(hex(pureCircuits.allVaults()));
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(A))).toBeDefined();
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(B))).toBeDefined();
  });

  /**
   * **THE SCOPE IS READ ONCE, FEEDS THE LEAF, AND DECIDES RIGHTS FOR RUNS ONLY.**
   *
   * A seat's scope is `allVaults()`, every right on every vault, or the hash of
   * a rights record. It is compared with anything only inside `grants`, and
   * `grants` is asked only when a signer raises, approves or holds a RUN. A
   * governance proposal is never checked against it: if it were, a set of
   * rights that left fewer approvers than the threshold would leave the company
   * unable to pass the re-seat that repairs it. The behaviour is pinned through
   * the compiled circuits in `rights-live-in-each-signers-leaf.test.ts`; this
   * reads the source, so a new reader of the scope is noticed where it appears.
   */
  it('the scope is read once, into the leaf, and compared only where a run asks for a right', () => {
    const source = readFileSync(
      new URL('../src/ConfidentialAccount.compact', import.meta.url), 'utf8');
    /* Comments stripped first, so prose explaining the rule is not read as code. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    /* RED WHEN a second reader of the witness appears: the declaration and the seat's one read. */
    expect(code.match(/signerScope/g) ?? []).toHaveLength(2);
    expect(code).toMatch(/witness signerScope\(\)\s*:\s*Bytes<32>;/);
    expect(code).toContain('const scope = signerScope();');
    /* RED WHEN the seat proves membership of a leaf built from anything but the scope it read. */
    expect(code).toContain('const leaf = signerLeaf(signerPublicKey(sk), signerBlinding(), scope);');

    /* RED WHEN a seat with every right stops being granted everything without a record. */
    expect(code).toMatch(/return scope == allVaults\(\) \|\|/);

    /* The three places a right is asked for: raising a run, approving a run, holding a run. */
    const asks = code.match(/grants\(caller\.scope, [012],/g) ?? [];
    /* RED WHEN a fourth circuit starts asking for a right, which must be a run's and said here. */
    expect(asks).toEqual(['grants(caller.scope, 0,', 'grants(caller.scope, 1,', 'grants(caller.scope, 2,']);
    /* RED WHEN the approve right is asked outside the branch a run's window opens. */
    expect(code).toMatch(/if \(runWindow\.member\(id\)\) \{\s*const opened = runOpening\(id\);\s*assert\(grants\(caller\.scope, 1,/);
    /* RED WHEN the raise right is asked outside `propose`'s run branch. */
    expect(code).toMatch(/if \(disclose\(isRun\)\) \{[^}]*assert\(grants\(caller\.scope, 0,/);
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
