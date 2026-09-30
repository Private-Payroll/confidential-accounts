/**
 * A RUN BELONGS TO THE ACCOUNT, NOT TO THE LAPTOP THAT RAISED IT.
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
  runKeyOf, payeeBlindingOf, payRecordNonceOf, runSecrets, currentPayoutSeed, payoutSeedAt,
  type PayoutSeed, type RunIdentity,
} from '../../src/midnight/run-keys.js';
import { payFor, TEST_PAY_KEY } from '../../src/testing/payees.js';
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
 * `DetailsOf` — and BOTH of them are passed, because `buildRun` derives a
 * leaf by the payee's own kind rather than by the caller's single choice
 *. Every payee in this file is shielded, so only that half is
 * exercised; the pair is required by the type, which is the point.
 */
const detailsOf = vaultDetails;

describe('a run is derived, not generated', () => {
  it('THE ONE THAT MATTERS: a second admin rebuilds a run byte for byte, with no contact with the first', () => {
    /*
     * Two calls standing in for two machines. Nothing is passed between them
     * but the account's sealed seeds and the run's identity — both of which
     * every signer already holds.
     */
    const byA = buildRun(seeds, ID, staff(50), detailsOf, payFor(staff(50)), 'GBP');
    const byB = buildRun(seeds, ID, staff(50), detailsOf, payFor(staff(50)), 'GBP');

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

  it('a different run on the same account derives different blindings and THE SAME NONCES, so the account refuses paying one person twice for one month', () => {
    const one = buildRun(seeds, ID, staff(3), detailsOf, payFor(staff(3)), 'GBP');
    const two = buildRun(seeds, { ...ID, runId: 'payroll-2026-10' }, staff(3), detailsOf, payFor(staff(3)), 'GBP');
    expect(two.tree.root).not.toBe(one.tree.root);
    expect(two.payeeArgs(0).blinding).not.toBe(one.payeeArgs(0).blinding);
    expect(two.payeeArgs(0).nonce).toBe(one.payeeArgs(0).nonce);
  });

  it('a different ACCOUNT derives different blindings from the same seed and run id', () => {
    const one = buildRun(seeds, ID, staff(3), detailsOf, payFor(staff(3)), 'GBP');
    const two = buildRun(seeds, { ...ID, accountId: 'acct-2' }, staff(3), detailsOf, payFor(staff(3)), 'GBP');
    expect(two.payeeArgs(0).blinding).not.toBe(one.payeeArgs(0).blinding);
  });

  it('a different EPOCH derives different blindings and keeps every nonce, so a month paid before a removal stays paid after it', () => {
    const one = buildRun(seeds, ID, staff(3), detailsOf, payFor(staff(3)), 'GBP');
    const two = buildRun(seeds, { ...ID, epoch: 1 }, staff(3), detailsOf, payFor(staff(3)), 'GBP');
    expect(two.payeeArgs(0).blinding).not.toBe(one.payeeArgs(0).blinding);
    expect(two.payeeArgs(0).nonce).toBe(one.payeeArgs(0).nonce);
  });

  it('a nonce is one person, one month, one kind, one occurrence: change any one and it changes', () => {
    const base = { person: 'emp_a', month: '2026-09', kind: 'salary', occurrence: 0 };
    const n = payRecordNonceOf(TEST_PAY_KEY, base);
    expect(payRecordNonceOf(TEST_PAY_KEY, { ...base })).toBe(n);
    expect(payRecordNonceOf(TEST_PAY_KEY, { ...base, person: 'emp_b' })).not.toBe(n);
    expect(payRecordNonceOf(TEST_PAY_KEY, { ...base, month: '2026-10' })).not.toBe(n);
    expect(payRecordNonceOf(TEST_PAY_KEY, { ...base, kind: 'bonus' })).not.toBe(n);
    expect(payRecordNonceOf(TEST_PAY_KEY, { ...base, occurrence: 1 })).not.toBe(n);
    expect(payRecordNonceOf('6b'.repeat(32), base)).not.toBe(n);
  });

  it('refuses a month in any spelling but YYYY-MM, which would give one month two nonces', () => {
    const base = { person: 'emp_a', month: '2026-09', kind: 'salary', occurrence: 0 };
    for (const month of ['2026-9', '2026-09 ', '2026/09', '2026-13', '2026-00', 'Sep 2026']) {
      expect(() => payRecordNonceOf(TEST_PAY_KEY, { ...base, month })).toThrow(/YYYY-MM/);
    }
    expect(() => payRecordNonceOf(TEST_PAY_KEY, { ...base, occurrence: -1 })).toThrow(/occurrence/);
    expect(() => payRecordNonceOf(TEST_PAY_KEY, { ...base, occurrence: 1.5 })).toThrow(/occurrence/);
    expect(() => payRecordNonceOf(TEST_PAY_KEY, { ...base, person: ' ' })).toThrow(/person/);
    expect(() => payRecordNonceOf(TEST_PAY_KEY, { ...base, kind: '' })).toThrow(/kind/);
    expect(() => payRecordNonceOf('5a'.repeat(31), base)).toThrow(/32 bytes/);
  });

  it('refuses a run whose records do not name every payment', () => {
    expect(() => buildRun(seeds, ID, staff(3), detailsOf, payFor(staff(2)), 'GBP'))
      .toThrow(/3 payments and says what 2 of them are for/);
    /* And one record too many: a record that names nobody's payment is a record nobody checked. */
    expect(() => buildRun(seeds, ID, staff(3), detailsOf, payFor(staff(4)), 'GBP'))
      .toThrow(/3 payments and says what 4 of them are for/);
  });

  it('a run raised BEFORE a rotation is still rebuildable AFTER it', () => {
    /*
     * The failure this prevents: removing a signer strands every approved run.
     * That would be a new way to lose access to money, introduced by the fix
     * for a way to lose access to money.
     */
    const before = buildRun(seeds.slice(0, 1), ID, staff(4), detailsOf, payFor(staff(4)), 'GBP');
    const afterRotation: PayoutSeed[] = [...seeds, { epoch: 2, seed: 'c'.repeat(64) }];
    const rebuilt = buildRun(afterRotation, ID, staff(4), detailsOf, payFor(staff(4)), 'GBP');
    expect(rebuilt.tree.root).toBe(before.tree.root);
  });

  it('refuses to guess when the run\'s epoch is not in the account\'s seeds', () => {
    /*
     * Falling back to the current seed would derive different leaves for a run
     * that already has approvals against the old ones — every payment refused,
     * with nothing to say why.
     */
    expect(() => buildRun(seeds, { ...ID, epoch: 7 }, staff(2), detailsOf, payFor(staff(2)), 'GBP'))
      .toThrow(/no payout seed for epoch 7/i);
  });

  it('every payee gets a different nonce, and a nonce is never a blinding', () => {
    const run = buildRun(seeds, ID, staff(20), detailsOf, payFor(staff(20)), 'GBP');
    const all = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const a = run.payeeArgs(i);
      all.add(a.nonce);
      all.add(a.blinding);
    }
    expect(all.size).toBe(40);
  });

  it('KNOWING PAID PAYEES\' NONCES GIVES NOTHING AWAY, which is what stops a watcher claiming the next payee', () => {
    /*
     * A payment publishes its payee's nonce. If the schedule leaked, one paid
     * employee would hand a watcher the rest of the payroll's secrets — and a
     * watcher who can quote a leaf can mark somebody paid who has not been.
     *
     * This cannot prove HKDF is one-way. What it pins is that the construction
     * does not hand the answer over by accident — no shared prefix, no
     * arithmetic relation, nothing derived from a neighbour.
     */
    const nonceOf = (i: number) =>
      payRecordNonceOf(TEST_PAY_KEY, { person: `emp_${i}`, month: '2026-09', kind: 'salary', occurrence: 0 });
    const known = Array.from({ length: 40 }, (_, i) => nonceOf(i));
    const next = nonceOf(40);

    expect(known).not.toContain(next);
    for (const n of known) {
      expect(next.slice(0, 8)).not.toBe(n.slice(0, 8));
      expect(BigInt(`0x${next}`) - BigInt(`0x${n}`)).not.toBe(0n);
    }
    // And the pay-record key itself is not recoverable by concatenating what leaked.
    expect(known.join('')).not.toContain(TEST_PAY_KEY);
  });

  it('a retry run reuses the original secrets, so the same person cannot be paid twice', () => {
    const run = buildRun(seeds, ID, staff(10), detailsOf, payFor(staff(10)), 'GBP');
    const retry = buildRetryRun(run, [7, 9]);

    // The same tree - a retry is raised over the run's own, so a spending policy charges it once -
    // and each person paid with the leaf and path they already had.
    expect(retry.tree.root).toBe(run.tree.root);
    expect([retry.payeeArgs(0).leaf, retry.payeeArgs(1).leaf]).toEqual([run.tree.leaves[7], run.tree.leaves[9]]);

    const first = retry.payeeArgs(0);
    expect(first.originalIndex).toBe(7);
    expect(first.path).toEqual(run.payeeArgs(7).path);
    expect(first.nonce).toBe(run.payeeArgs(7).nonce);
    expect(first.blinding).toBe(run.payeeArgs(7).blinding);
    expect(first.amount).toBe(run.payeeArgs(7).amount);
  });

  it('refuses a retry that names somebody twice, or somebody who is not in the run', () => {
    const run = buildRun(seeds, ID, staff(4), detailsOf, payFor(staff(4)), 'GBP');
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

    expect(payeeBlindingOf(key, 0)).toBe('390df3a4b2e5cf2621af1058a401f2b48b1de6e8c4472e143af92762935bf672');
    expect(payeeBlindingOf(key, 1)).toBe('f8c7a9ba9166289eb5ef4c95cef2a221ce937d4a53ec9f2ba4ba6f2ce7aad0c9');
    /* Two digits, so an index is not being truncated or read as one character. */
    expect(payeeBlindingOf(key, 41)).toBe('6dc3c7292fb9ccdfe3964b72e5a7b3646cbb2d226123e215c1c9d5ee578e3688');

    /*
     * **AND THE NONCE, WHICH IS A PERSON AND A MONTH RATHER THAN A POSITION.**
     * Every payment ever recorded on an account is refused a second time by
     * these exact bytes, so a change to the derivation would let every month
     * already paid be paid again.
     */
    const payKey = '11'.repeat(32);
    const record = { person: 'emp_vector', month: '2026-09', kind: 'salary', occurrence: 0 };
    expect(payRecordNonceOf(payKey, record))
      .toBe('686847efc17a04ee4227fec5dee53433f5fc355bd5bc728c3718b09d496028d4');
    expect(payRecordNonceOf(payKey, { ...record, occurrence: 1 }))
      .toBe('61762ebda1b077598fe0be4dc06703a118e806cbab6bc7394fabdd15c7dea677');
    /* Two digits, so an occurrence is not being truncated or read as one character. */
    expect(payRecordNonceOf(payKey, { ...record, month: '2026-10', occurrence: 12 }))
      .toBe('94313ee91c2b6c4d65e6d68f813c3316ce485a7f305d6d8cf6bb78e83d8da67a');
  });

  it('refuses a run with nobody in it, and a negative payee index', () => {
    expect(() => runSecrets(seeds, ID, payFor([]))).toThrow(/at least one payee/i);
    expect(() => payeeBlindingOf('a'.repeat(64), -1)).toThrow(/non-negative/i);
  });
});
