/**
 * V-63: A RUN BELONGS TO THE ACCOUNT, NOT TO THE LAPTOP THAT RAISED IT.
 *
 * The worked example this file exists to make impossible:
 * A raises a fifty-person payroll, B and C approve it, A's laptop dies, and
 * nobody — including the company — can pay anybody. No money is lost and fifty
 * people are unpaid, which is not a distinction an employee appreciates.
 *
 * The one to read first is "a second admin finishes a run the first one
 * started, having never seen the first machine".
 */
import { describe, it, expect } from 'vitest';
import {
  runKeyOf, payeeSecretsOf, runSecrets, currentPayoutSeed, payoutSeedAt,
  type PayoutSeed, type RunIdentity,
} from '../../src/midnight/run-keys.js';
import { buildRun, buildRetryRun, type PaymentFacts } from '../../src/midnight/payout-tree.js';
import { payeeFor } from '../../src/testing/payees.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { toHex } from '../../src/core/crypto.js';

const seeds: PayoutSeed[] = [
  { epoch: 0, seed: 'a'.repeat(64) },
  { epoch: 1, seed: 'b'.repeat(64) },
];

const ID: RunIdentity = { accountId: 'acct-1', runId: 'payroll-2026-09', epoch: 0 };

const GBP = new Uint8Array(32).fill(0x11);
const staff = (n: number): PaymentFacts[] =>
  Array.from({ length: n }, (_, i) => ({
    payee: payeeFor(new Uint8Array(32).fill(i + 1), 'undeployed'),
    token: toHex(GBP),
    amount: BigInt(1_000 + i),
  }));

/*
 * The vault's own circuits, passed in. Never reimplemented here — see
 * `DetailsOf` — and BOTH of them since `S6k`, because `buildRun` now derives a
 * leaf by the payee's own kind rather than by the caller's single choice
 *. Every payee in this file is shielded, so only that half is
 * exercised; the pair is required by the type, which is the point.
 */
const detailsOf = vaultDetails;

describe('V-63: a run is derived, not generated', () => {
  it('THE ONE THAT MATTERS: a second admin rebuilds a run byte for byte, with no contact with the first', () => {
    /*
     * Two calls standing in for two machines. Nothing is passed between them
     * but the account's sealed seeds and the run's identity — both of which
     * every signer already holds.
     */
    const byA = buildRun(seeds, ID, staff(50), detailsOf);
    const byB = buildRun(seeds, ID, staff(50), detailsOf);

    expect(byB.tree.root).toBe(byA.tree.root);
    expect(byB.tree.leaves).toEqual(byA.tree.leaves);
    for (let i = 0; i < 50; i++) {
      const a = byA.payeeArgs(i);
      const b = byB.payeeArgs(i);
      expect(b.nonce).toBe(a.nonce);
      expect(b.blinding).toBe(a.blinding);
      expect(b.details).toBe(a.details);
      expect(b.leaf).toBe(a.leaf);
    }
  });

  it('a different run on the same account derives different secrets', () => {
    const one = buildRun(seeds, ID, staff(3), detailsOf);
    const two = buildRun(seeds, { ...ID, runId: 'payroll-2026-10' }, staff(3), detailsOf);
    expect(two.tree.root).not.toBe(one.tree.root);
    expect(two.payeeArgs(0).nonce).not.toBe(one.payeeArgs(0).nonce);
  });

  it('a different ACCOUNT derives different secrets from the same seed and run id', () => {
    const one = buildRun(seeds, ID, staff(3), detailsOf);
    const two = buildRun(seeds, { ...ID, accountId: 'acct-2' }, staff(3), detailsOf);
    expect(two.payeeArgs(0).nonce).not.toBe(one.payeeArgs(0).nonce);
  });

  it('a different EPOCH derives different secrets, so a rotation does not reuse them', () => {
    const one = buildRun(seeds, ID, staff(3), detailsOf);
    const two = buildRun(seeds, { ...ID, epoch: 1 }, staff(3), detailsOf);
    expect(two.payeeArgs(0).nonce).not.toBe(one.payeeArgs(0).nonce);
  });

  it('a run raised BEFORE a rotation is still rebuildable AFTER it', () => {
    /*
     * The failure this prevents: removing a signer strands every approved run.
     * That would be a new way to lose access to money, introduced by the fix
     * for a way to lose access to money.
     */
    const before = buildRun(seeds.slice(0, 1), ID, staff(4), detailsOf);
    const afterRotation: PayoutSeed[] = [...seeds, { epoch: 2, seed: 'c'.repeat(64) }];
    const rebuilt = buildRun(afterRotation, ID, staff(4), detailsOf);
    expect(rebuilt.tree.root).toBe(before.tree.root);
  });

  it('refuses to guess when the run\'s epoch is not in the account\'s seeds', () => {
    /*
     * Falling back to the current seed would derive different leaves for a run
     * that already has approvals against the old ones — every payment refused,
     * with nothing to say why.
     */
    expect(() => buildRun(seeds, { ...ID, epoch: 7 }, staff(2), detailsOf))
      .toThrow(/no payout seed for epoch 7/i);
  });

  it('every payee gets a different nonce, and a nonce is never a blinding', () => {
    const run = buildRun(seeds, ID, staff(20), detailsOf);
    const all = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const a = run.payeeArgs(i);
      all.add(a.nonce);
      all.add(a.blinding);
    }
    expect(all.size).toBe(40);
  });

  it('KNOWING PAID PAYEES\' NONCES GIVES NOTHING AWAY, which is what V-43 rests on', () => {
    /*
     * A payment publishes its payee's nonce. If the schedule leaked, one paid
     * employee would hand a watcher the rest of the payroll's secrets — and a
     * watcher who can quote a leaf can mark somebody paid who has not been.
     *
     * This cannot prove HKDF is one-way. What it pins is that the construction
     * does not hand the answer over by accident — no shared prefix, no
     * arithmetic relation, nothing derived from a neighbour.
     */
    const key = runKeyOf(seeds[0].seed, ID);
    const known = Array.from({ length: 40 }, (_, i) => payeeSecretsOf(key, i).nonce);
    const next = payeeSecretsOf(key, 40).nonce;

    expect(known).not.toContain(next);
    for (const n of known) {
      expect(next.slice(0, 8)).not.toBe(n.slice(0, 8));
      expect(BigInt(`0x${next}`) - BigInt(`0x${n}`)).not.toBe(0n);
    }
    // And the run key itself is not recoverable by concatenating what leaked.
    expect(known.join('')).not.toContain(key);
  });

  it('a retry run reuses the original secrets, so the same person cannot be paid twice', () => {
    const run = buildRun(seeds, ID, staff(10), detailsOf);
    const retry = buildRetryRun(run, [7, 9]);

    // Different tree — it is a different run — and identical leaves.
    expect(retry.tree.root).not.toBe(run.tree.root);
    expect(retry.tree.leaves).toEqual([run.tree.leaves[7], run.tree.leaves[9]]);

    const first = retry.payeeArgs(0);
    expect(first.originalIndex).toBe(7);
    expect(first.nonce).toBe(run.payeeArgs(7).nonce);
    expect(first.blinding).toBe(run.payeeArgs(7).blinding);
    expect(first.amount).toBe(run.payeeArgs(7).amount);
  });

  it('refuses a retry that names somebody twice, or somebody who is not in the run', () => {
    const run = buildRun(seeds, ID, staff(4), detailsOf);
    expect(() => buildRetryRun(run, [1, 1])).toThrow(/listed twice/i);
    expect(() => buildRetryRun(run, [9])).toThrow(/not in the original run/i);
    expect(() => buildRetryRun(run, [])).toThrow(/nothing outstanding/i);
  });

  it('picks the newest seed by epoch, not by position in the list', () => {
    expect(currentPayoutSeed([{ epoch: 2, seed: 'c'.repeat(64) }, ...seeds]).epoch).toBe(2);
    expect(payoutSeedAt(seeds, 1).seed).toBe('b'.repeat(64));
    expect(() => currentPayoutSeed([])).toThrow(/no payout seed/i);
  });

  it('THE SCHEDULE ITSELF IS PINNED, because changing it strands every run already raised', () => {
    /*
     * A KNOWN-ANSWER TEST, and it earns its keep twice.
     *
     * First: this derivation is not an implementation detail. Every run ever
     * raised has leaves that only these exact bytes reproduce, so a refactor
     * that "tidies" the HKDF parameters makes every approved, unpaid payroll
     * unpayable — by anyone, for good. That is a money-access failure produced
     * by a change nobody would think to test.
     *
     * Second, and the reason this test exists at all: I hand-mutated the
     * schedule to check my own coverage claim, and **swapping the `info`
     * strings of the nonce and the blinding survived every other test in this
     * file.** The values stayed deterministic, stayed distinct, and would have
     * been wrong in a way that only shows up as a payee's blinding being
     * published where their nonce should be. Vectors are what catch that;
     * properties are not.
     */
    const id = { accountId: 'acct-vector', runId: 'run-vector', epoch: 0 };
    const key = runKeyOf('11'.repeat(32), id);
    expect(key).toBe('a85f7927518184074b05f0411ecf589ac2f35e0f3d9237a065e42c58fda05a71');

    expect(payeeSecretsOf(key, 0)).toEqual({
      blinding: '390df3a4b2e5cf2621af1058a401f2b48b1de6e8c4472e143af92762935bf672',
      nonce: 'fe3418c27a588fc6276ca7ba4463c0249296b2e351039112b3caad134d98f45b',
    });
    expect(payeeSecretsOf(key, 1)).toEqual({
      blinding: 'f8c7a9ba9166289eb5ef4c95cef2a221ce937d4a53ec9f2ba4ba6f2ce7aad0c9',
      nonce: 'a59cb11b69171af30a0d6e649a9e56e2b74960a7025b11b0e90474b434bad936',
    });
    /* Two digits, so an index is not being truncated or read as one character. */
    expect(payeeSecretsOf(key, 41)).toEqual({
      blinding: '6dc3c7292fb9ccdfe3964b72e5a7b3646cbb2d226123e215c1c9d5ee578e3688',
      nonce: '522d34bd61949517bb479e150516816ab0588a2f7b5aa784972b592787debc7e',
    });
  });

  it('refuses a run with nobody in it, and a negative payee index', () => {
    expect(() => runSecrets(seeds, ID, 0)).toThrow(/at least one payee/i);
    expect(() => payeeSecretsOf('a'.repeat(64), -1)).toThrow(/non-negative/i);
  });
});
