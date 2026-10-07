/**
 * **THE CHAIN IS THE RECORD OF WHO WAS PAID FOR WHICH MONTH.**
 *
 * Every payment records two values: one made from its payee leaf, as before,
 * and one made from its nonce, which is derived from the person, the month, the
 * kind of pay and the occurrence. The account refuses a second payment carrying
 * either. So the same person cannot be paid twice for one month at another
 * amount, another address or in the other form, from this run or any other. A
 * real second payment is a later occurrence: a numbered extra.
 *
 * The key the nonces are derived from is sealed to each signer on chain, each
 * signer writing only their own copy, beside one commitment to the key written
 * under an approved round.
 *
 * The one to read first is "the same person and month, at another amount, is
 * refused".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, rootOfTestLeaves, TEST_AMOUNT, TEST_TOKEN_BYTES } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { payoutLeafOf, sumTreeOfLeaves, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { payRecordNonceOf, sealPayKeyTo, type PayRecord } from '../../src/midnight/run-keys.js';
import { openSealedPayKey, payKeyCommitmentOf, payKeyPayloadOf } from '../../src/midnight/pay-key-commitment.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { alreadyPaidOf, alreadyPaidSentence } from '../../src/midnight/ledger.js';
import { newWrappingKeypair, toHex, fromHex, type Hex } from '../../src/core/crypto.js';
import { buildRun, type PaymentFacts } from '../../src/midnight/payout-tree.js';
import { payeeFor, payFor } from '../../src/testing/payees.js';
import { TEST_TOKEN, registryWithTestPrivateForms } from '../../src/testing/assets.js';
import { ledgerTokenOf } from '../../src/core/assets.js';
import { refuseWhatThisDeviceDidNotMake, type AccountLedgerView, type RunMadeHere } from '../../packages/web-shared/src/what-this-device-made.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);

const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const PAYROLL = new Uint8Array(32).fill(0xa1);
const TREASURY = new Uint8Array(32).fill(0xb2);
const TOKEN = new Uint8Array(32).fill(0x11);
const KEY: Hex = '3c'.repeat(32);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) => sim.applying(d, c);

const SEPTEMBER: PayRecord = { person: 'emp_ada', month: '2026-09', kind: 'salary', occurrence: 0 };
const nonceOf = (r: PayRecord) => payRecordNonceOf(KEY, r);

/** One payment's leaf input: the vault's own details under a blinding, with the person-month nonce. */
const payment = (
  r: PayRecord,
  p: { recipient?: number; amount?: bigint; blinding?: number; form?: 'shielded' | 'unshielded' } = {},
): PayoutLeafInput => ({
  details: toHex(vaultDetails[p.form ?? 'shielded'](
    bytes(p.recipient ?? 0x21), TOKEN, p.amount ?? 5_000n, bytes(p.blinding ?? 0x31))),
  nonce: nonceOf(r),
});

/** Raises and approves a run of `payments` for `vault`, and hands back what a payer needs. */
const approvedRun = async (sim: AccountSimulator, vault: Uint8Array, payments: PayoutLeafInput[], seed: number) => {
  await sim.adoptVault(vault, [A, B]);
  const c = change(0n, seed);
  const leaves = payments.map(payoutLeafOf);
  const root = rootOfTestLeaves(leaves);
  const payload = pureCircuits.runPayload(fromHex(root), BigInt(leaves.length), OPENS, CLOSES, 0n);
  await sim.as(carrying(sim, A, c)).proposeRun({ root: fromHex(root), payees: BigInt(leaves.length), from: OPENS, until: CLOSES, vault });
  const id = sim.proposalId(payload, c.salt, vault);
  await sim.as(carrying(sim, A, c)).approve(id);
  await sim.as(carrying(sim, B, c)).approve(id);
  return { id, c, leaves, root };
};

/** Pays payee `i` of a run whose tree may be one `buildPayoutTree` would refuse. */
const pay = (sim: AccountSimulator, vault: Uint8Array, run: Awaited<ReturnType<typeof approvedRun>>,
  payments: PayoutLeafInput[], i: number) => {
  /* The path is built over the raw leaves, so a run `buildPayoutTree` would refuse can still be driven at the account. */
  const path = pathFor(run.leaves, i);
  return sim.as(carrying(sim, A, run.c)).recordPaymentFromVault({
    proposal: run.id, vault, root: fromHex(run.root), payees: BigInt(run.leaves.length),
    from: OPENS, until: CLOSES, salt: run.c.salt,
    details: fromHex(payments[i]!.details), nonce: fromHex(payments[i]!.nonce),
    amount: TEST_AMOUNT, asset: TEST_TOKEN_BYTES, path,
  });
};

/* A path over raw leaves, from the product's own sum tree, for runs `buildPayoutTree` refuses. */
const pathFor = (leaves: Hex[], i: number) =>
  sumTreeOfLeaves(leaves, leaves.map(() => TEST_AMOUNT), toHex(TEST_TOKEN_BYTES)).pathFor(i);

const paidOnce = (sim: AccountSimulator, r: PayRecord) =>
  sim.ledger.movements.member(pureCircuits.paidOnceOf(fromHex(nonceOf(r))));

describe('the chain records who was paid for which month', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await AccountSimulator.liveAccount([A, B], 2n); sim.at(NOW); });

  it('B\' BOTH: a payment records its leaf AND its person and month - two values, never one', async () => {
    const payments = [payment(SEPTEMBER)];
    const run = await approvedRun(sim, PAYROLL, payments, 11);
    const before = sim.ledger.movements.size();
    await pay(sim, PAYROLL, run, payments, 0);
    /* RED WHEN recordPayment stops writing the leaf's value (B' alone): the payslip page and the retry check read it. */
    expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(run.leaves[0]!)))).toBe(true);
    /* RED WHEN recordPayment stops writing the nonce's value. */
    expect(paidOnce(sim, SEPTEMBER)).toBe(true);
    /* RED WHEN either value stops being written, or a third is added: the raise guard counts two per payment. */
    expect(sim.ledger.movements.size() - before).toBe(2n);
  });

  it('THE ONE THAT MATTERS: the same person and month, at another AMOUNT, is refused - from another run', async () => {
    const first = [payment(SEPTEMBER, { amount: 5_000n })];
    const run1 = await approvedRun(sim, PAYROLL, first, 11);
    await pay(sim, PAYROLL, run1, first, 0);

    const raise = [payment(SEPTEMBER, { amount: 6_500n, blinding: 0x32 })];
    const run2 = await approvedRun(sim, PAYROLL, raise, 12);
    expect(run2.leaves[0]).not.toBe(run1.leaves[0]);
    const before = sim.ledger.movements.size();
    /* RED WHEN recordPayment stops refusing a recorded nonce: the leaf is new, so nothing else refuses it. */
    await expect(pay(sim, PAYROLL, run2, raise, 0))
      .rejects.toThrow(/a payment is already recorded for this person, kind of pay and month/);
    expect(sim.ledger.movements.size()).toBe(before);
  });

  it('...at another ADDRESS, and from another vault, is refused', async () => {
    const first = [payment(SEPTEMBER, { recipient: 0x21 })];
    const run1 = await approvedRun(sim, PAYROLL, first, 11);
    await pay(sim, PAYROLL, run1, first, 0);

    const moved = [payment(SEPTEMBER, { recipient: 0x22, blinding: 0x33 })];
    const run2 = await approvedRun(sim, TREASURY, moved, 13);
    await expect(pay(sim, TREASURY, run2, moved, 0))
      .rejects.toThrow(/a payment is already recorded for this person, kind of pay and month/);
  });

  it('...in the OTHER FORM, public rather than private, is refused', async () => {
    const first = [payment(SEPTEMBER, { form: 'shielded' })];
    const run1 = await approvedRun(sim, PAYROLL, first, 11);
    await pay(sim, PAYROLL, run1, first, 0);

    const publicly = [payment(SEPTEMBER, { form: 'unshielded', blinding: 0x34 })];
    const run2 = await approvedRun(sim, PAYROLL, publicly, 14);
    expect(run2.leaves[0]).not.toBe(run1.leaves[0]);
    await expect(pay(sim, PAYROLL, run2, publicly, 0))
      .rejects.toThrow(/a payment is already recorded for this person, kind of pay and month/);
  });

  it('...twice on ONE run, when the tree was built past the client that refuses it', async () => {
    const twice = [payment(SEPTEMBER, { amount: 5_000n }), payment(SEPTEMBER, { amount: 5_001n, blinding: 0x35 })];
    const run = await approvedRun(sim, PAYROLL, twice, 15);
    await pay(sim, PAYROLL, run, twice, 0);
    await expect(pay(sim, PAYROLL, run, twice, 1))
      .rejects.toThrow(/a payment is already recorded for this person, kind of pay and month/);
  });

  it('an identical payment is still refused as the payment already made, before the month is asked', async () => {
    const one = [payment(SEPTEMBER)];
    const run = await approvedRun(sim, PAYROLL, one, 11);
    await pay(sim, PAYROLL, run, one, 0);
    await expect(pay(sim, PAYROLL, run, one, 0)).rejects.toThrow(/that payment has already been made/);
  });

  it('A NUMBERED EXTRA IS PAID: occurrence 1 after the first, and then refused a second time', async () => {
    const first = [payment(SEPTEMBER)];
    const run1 = await approvedRun(sim, PAYROLL, first, 11);
    await pay(sim, PAYROLL, run1, first, 0);

    const extra = { ...SEPTEMBER, occurrence: 1 };
    const topUp = [payment(extra, { amount: 750n, blinding: 0x36 })];
    const run2 = await approvedRun(sim, PAYROLL, topUp, 16);
    /* RED WHEN the occurrence stops changing the nonce, or the account refuses more than the one value. */
    await pay(sim, PAYROLL, run2, topUp, 0);
    expect(paidOnce(sim, extra)).toBe(true);

    const again = [payment(extra, { amount: 750n, blinding: 0x37 })];
    const run3 = await approvedRun(sim, PAYROLL, again, 17);
    await expect(pay(sim, PAYROLL, run3, again, 0))
      .rejects.toThrow(/a payment is already recorded for this person, kind of pay and month/);
  });

  it('another month, another person and another kind are other records, and are paid', async () => {
    const first = [payment(SEPTEMBER)];
    await pay(sim, PAYROLL, await approvedRun(sim, PAYROLL, first, 11), first, 0);
    for (const [i, r] of [
      { ...SEPTEMBER, month: '2026-10' }, { ...SEPTEMBER, person: 'emp_bo' }, { ...SEPTEMBER, kind: 'bonus' },
    ].entries()) {
      const p = [payment(r, { blinding: 0x40 + i })];
      await pay(sim, PAYROLL, await approvedRun(sim, PAYROLL, p, 20 + i), p, 0);
      expect(paidOnce(sim, r)).toBe(true);
    }
  });
});

describe('the pay-record key, sealed to each signer on chain', () => {
  let sim: AccountSimulator;
  beforeEach(async () => { sim = await AccountSimulator.liveAccount([A, B], 2n); sim.at(NOW); });

  const commitment = fromHex(payKeyCommitmentOf(KEY));
  const wrapFor = (pub: Hex) => sealPayKeyTo(KEY, pub).map(fromHex);
  const aKeys = newWrappingKeypair();
  const bKeys = newWrappingKeypair();

  /** Raises and approves the round that commits the account to `to`. */
  const approvedCommitment = async (to: Uint8Array, seed = 51, approvers = [A, B]) => {
    const c = change(0n, seed);
    const payload = fromHex(payKeyPayloadOf(toHex(to)));
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    for (const who of approvers) await sim.as(carrying(sim, who, c)).approve(id);
    return { id, c };
  };

  it('NEVER FIRST-COME: the first copy without an approved round is refused, and writes nothing', async () => {
    await expect(sim.as(A).sealPayKey(wrapFor(aKeys.publicKey), commitment))
      .rejects.toThrow(/no open proposal with that id/);
    /* RED WHEN the commitment can be written without a round: one signer could commit to a key only they hold. */
    const half = await approvedCommitment(commitment, 52, [A]);
    await expect(sim.as(carrying(sim, A, half.c)).sealPayKey(wrapFor(aKeys.publicKey), commitment, half.id))
      .rejects.toThrow(/not enough approvals yet/);
    expect(sim.payKeyCommitment()).toBeUndefined();
    expect(sim.sealedPayKeyOf(A)).toBeUndefined();
  });

  it('refuses an approved round for ANOTHER commitment', async () => {
    const other = await approvedCommitment(fromHex(payKeyCommitmentOf('77'.repeat(32))));
    /* RED WHEN the circuit stops checking the round names this commitment. */
    await expect(sim.as(carrying(sim, A, other.c)).sealPayKey(wrapFor(aKeys.publicKey), commitment, other.id))
      .rejects.toThrow(/not for this pay-record key/);
    expect(sim.payKeyCommitment()).toBeUndefined();
  });

  it('refuses a zero commitment even under an approved round', async () => {
    const zero = new Uint8Array(32);
    const round = await approvedCommitment(zero);
    await expect(sim.as(carrying(sim, A, round.c)).sealPayKey(wrapFor(aKeys.publicKey), zero, round.id))
      .rejects.toThrow(/not a usable pay-record key/);
  });

  it('THE FIRST COPY writes the commitment under the approved round, closes it, and seals the caller\'s own copy', async () => {
    const round = await approvedCommitment(commitment);
    const wrapA = wrapFor(aKeys.publicKey);
    const size = sim.signerRolesSize();
    await sim.as(carrying(sim, A, round.c)).sealPayKey(wrapA, commitment, round.id);
    expect(toHex(sim.payKeyCommitment()!)).toBe(toHex(commitment));
    expect(sim.isOpen(round.id)).toBe(false);
    expect(sim.sealedPayKeyOf(A)!.map(toHex)).toEqual(wrapA.map(toHex));
    /* One commitment and four parts, and nothing else, in the shared map. */
    expect(sim.signerRolesSize() - size).toBe(5n);
    /* And the label is untouched. */
    expect(sim.companyLabel()).toBeDefined();
    /* The device opens its own copy and checks it against the commitment on chain. */
    expect(openSealedPayKey(sim.sealedPayKeyOf(A)!.map(toHex), aKeys.secret, toHex(sim.payKeyCommitment()!))).toBe(KEY);
  });

  it('EACH SIGNER WRITES ONLY THEIR OWN COPY: B seals under B\'s entries and A\'s stay A\'s', async () => {
    const round = await approvedCommitment(commitment);
    const wrapA = wrapFor(aKeys.publicKey);
    await sim.as(carrying(sim, A, round.c)).sealPayKey(wrapA, commitment, round.id);

    const wrapB = wrapFor(bKeys.publicKey);
    await sim.as(B).sealPayKey(wrapB, commitment);
    /* RED WHEN the entries are keyed on anything the caller hands in rather than their own secret key. */
    expect(sim.sealedPayKeyOf(A)!.map(toHex)).toEqual(wrapA.map(toHex));
    expect(sim.sealedPayKeyOf(B)!.map(toHex)).toEqual(wrapB.map(toHex));
    expect(openSealedPayKey(sim.sealedPayKeyOf(B)!.map(toHex), bKeys.secret, toHex(commitment))).toBe(KEY);
  });

  it('refuses a second copy from the same signer, a copy against another commitment, and anybody not seated', async () => {
    const round = await approvedCommitment(commitment);
    await sim.as(carrying(sim, A, round.c)).sealPayKey(wrapFor(aKeys.publicKey), commitment, round.id);
    const wrapA = sim.sealedPayKeyOf(A)!.map(toHex);

    /* RED WHEN a signer can overwrite their own copy: a copy that stops opening is a key lost. */
    await expect(sim.as(A).sealPayKey(wrapFor(bKeys.publicKey), commitment))
      .rejects.toThrow(/already sealed the pay-record key to yourself/);
    expect(sim.sealedPayKeyOf(A)!.map(toHex)).toEqual(wrapA);

    /* RED WHEN a later copy stops being checked against the commitment on chain. */
    await expect(sim.as(B).sealPayKey(wrapFor(bKeys.publicKey), fromHex(payKeyCommitmentOf('77'.repeat(32)))))
      .rejects.toThrow(/not the pay-record key this company confirmed/);
    expect(sim.sealedPayKeyOf(B)).toBeUndefined();

    await expect(sim.as(C).sealPayKey(wrapFor(bKeys.publicKey), commitment))
      .rejects.toThrow(/not a signer on this account/);
    expect(sim.sealedPayKeyOf(C)).toBeUndefined();
  });

  it('a device refuses a copy that opens to a key the account did not commit to', () => {
    const wrongKey = sealPayKeyTo('77'.repeat(32), aKeys.publicKey);
    expect(() => openSealedPayKey(wrongKey, aKeys.secret, payKeyCommitmentOf(KEY)))
      .toThrow(/does not open to the key this company confirmed/);
    expect(() => openSealedPayKey(wrongKey.slice(0, 3), aKeys.secret, payKeyCommitmentOf(KEY)))
      .toThrow(/four 32-byte entries/);
  });
});

describe('what the client refuses before anybody signs, and what the approving device can say', () => {
  it('buildPayoutTree refuses two payees sharing a nonce, even when their leaves differ', () => {
    const twice = [payment(SEPTEMBER, { amount: 5_000n }), payment(SEPTEMBER, { amount: 5_001n, blinding: 0x35 })];
    expect(payoutLeafOf(twice[0]!)).not.toBe(payoutLeafOf(twice[1]!));
    /* RED WHEN the tree builder compares only leaves: the run is approved and the second payee is refused on chain. */
    expect(() => payoutTreeOf(twice)).toThrow(/payees 1 and 2 on this run are the same person, paid for the same month/);
    /* Its control: the same two at different occurrences build. */
    expect(() => payoutTreeOf([twice[0]!, payment({ ...SEPTEMBER, occurrence: 1 }, { blinding: 0x35 })])).not.toThrow();
  });

  it('THE DEVICE\'S CHECK: from one read of the account and the key, who is already recorded as paid for the month', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    const first = [payment(SEPTEMBER)];
    await pay(sim, PAYROLL, await approvedRun(sim, PAYROLL, first, 11), first, 0);
    const extra = { ...SEPTEMBER, occurrence: 1 };
    const topUp = [payment(extra, { blinding: 0x36 })];
    await pay(sim, PAYROLL, await approvedRun(sim, PAYROLL, topUp, 16), topUp, 0);

    const has = (nonce: Hex) => sim.ledger.movements.member(pureCircuits.paidOnceOf(fromHex(nonce)));
    const [ada, bo, adaAgain] = alreadyPaidOf(has, KEY, [
      { person: 'emp_ada', month: '2026-09', kind: 'salary', occurrence: 2 },
      { person: 'emp_bo', month: '2026-09', kind: 'salary', occurrence: 0 },
      { person: 'emp_ada', month: '2026-09', kind: 'salary', occurrence: 1 },
    ]);
    /* RED WHEN the check reads another key, month or kind than the payments were derived under. */
    expect(ada!.paid).toEqual([0, 1]);
    expect(ada!.refused).toBe(false);
    expect(bo!.paid).toEqual([]);
    /* RED WHEN the check stops saying the run pays an occurrence the chain already holds. */
    expect(adaAgain!.refused).toBe(true);

    /* The words never say more than the chain can: recorded on chain as paid. */
    expect(alreadyPaidSentence(ada!, 'Ada')).toBe(
      'Ada: salary for September 2026 is recorded on chain as paid (the regular payment and extra 1).');
    expect(alreadyPaidSentence(adaAgain!, 'Ada')).toBe(
      'Ada: salary for September 2026 is recorded on chain as paid (the regular payment and extra 1). '
      + 'This run pays extra 1 again. The chain will refuse that one payment.');
    expect(alreadyPaidSentence(bo!, 'Bo')).toBeNull();
    /* An occurrence at or past how many it asks about is still asked about. RED WHEN the scan stops
       at the default count and never reaches the occurrence this run pays. */
    const [late] = alreadyPaidOf(has, KEY, [{ person: 'emp_ada', month: '2026-09', kind: 'salary', occurrence: 1 }], 1);
    expect(late!.paid).toEqual([0, 1]);
    expect(late!.refused).toBe(true);
    /* A different key sees nothing: the check is only as good as the key it is given. */
    expect(alreadyPaidOf(has, '77'.repeat(32), [{ person: 'emp_ada', month: '2026-09', kind: 'salary' }])[0]!.paid)
      .toEqual([]);
  });

  it('ON THE CHAIN: ONCE A PAYEE OF ONE RUN IS PAID, AN APPROVING DEVICE REFUSES A SECOND RUN PAYING THEM FOR THAT MONTH', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    /* The company's pay-record key, committed on chain under an approved round, as a company's state names it. */
    const payKey = '5d'.repeat(32) as Hex;
    const committed = change(0n, 61);
    const keyPayload = fromHex(payKeyPayloadOf(payKeyCommitmentOf(payKey)));
    await sim.as(carrying(sim, A, committed)).propose(keyPayload);
    const keyRound = sim.proposalId(keyPayload, committed.salt);
    for (const who of [A, B]) await sim.as(carrying(sim, who, committed)).approve(keyRound);
    await sim.as(carrying(sim, A, committed)).sealPayKey(sealPayKeyTo(payKey, newWrappingKeypair().publicKey).map(fromHex), fromHex(payKeyCommitmentOf(payKey)), keyRound);
    await sim.adoptVault(PAYROLL, [A, B]);

    /* Two people paid for September, the way an approving device makes each run again. */
    const facts: PaymentFacts[] = [0, 1].map((i) => ({
      payee: payeeFor(`c${i + 1}`.repeat(32), 'undeployed'),
      token: ledgerTokenOf(TEST_TOKEN, 'shielded', registryWithTestPrivateForms()), amount: BigInt(200 + i),
    }));
    const pay = payFor(facts, { key: payKey, people: ['emp_ada', 'emp_bo'], month: '2026-09' });
    const seeds = [{ epoch: 0, seed: '6f'.repeat(32) as Hex }];
    const runOf = (runId: string, salt: number) => {
      const identity = { accountId: 'acc_1', runId, epoch: 0 };
      const run = buildRun(seeds, identity, facts, vaultDetails, pay, TEST_TOKEN);
      const made: RunMadeHere = {
        kind: 'payroll', seeds, payKey, identity, facts, records: pay.records, asset: TEST_TOKEN,
        opensAt: String(OPENS), closesAt: String(CLOSES), required: '0',
      };
      return { run, made, c: change(0n, salt), payload: pureCircuits.runPayload(fromHex(run.tree.root), run.tree.payees, OPENS, CLOSES, 0n) };
    };
    const raised = async (r: ReturnType<typeof runOf>) => {
      await sim.as(carrying(sim, A, r.c)).proposeRun({ root: fromHex(r.run.tree.root), payees: r.run.tree.payees, from: OPENS, until: CLOSES, vault: PAYROLL });
      return sim.proposalId(r.payload, r.c.salt, PAYROLL);
    };
    const check = (r: ReturnType<typeof runOf>, id: Uint8Array) => () => refuseWhatThisDeviceDidNotMake({
      runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
      payKeyCommitmentKey: pureCircuits.payKeyCommitmentKey,
    }, { chainId: toHex(id), digest: toHex(r.payload), made: r.made }, sim.ledger as unknown as AccountLedgerView, 'approve');

    const first = runOf('run_sep:leg', 62);
    const firstId = await raised(first);
    /* The control: the chain has paid nobody, so the first run is approved as made again. */
    expect(check(first, firstId)).not.toThrow();
    for (const who of [A, B]) await sim.as(carrying(sim, who, first.c)).approve(firstId);
    const second = runOf('run_sep_again:leg', 63);
    const secondId = await raised(second);
    /* Another run, made again with leaves of its own, for the same people and month: nobody is paid yet, so it is not refused. */
    expect(second.run.tree.leaves[0]).not.toBe(first.run.tree.leaves[0]);
    expect(check(second, secondId)).not.toThrow();

    /* The first run pays Ada on the chain. */
    await sim.as(carrying(sim, A, first.c)).recordPaymentFromVault({
      proposal: firstId, vault: PAYROLL, root: fromHex(first.run.tree.root), payees: first.run.tree.payees, from: OPENS, until: CLOSES,
      salt: first.c.salt, details: fromHex(first.run.payments[0]!.details), nonce: fromHex(first.run.payments[0]!.nonce),
      amount: facts[0]!.amount, asset: fromHex(first.run.tree.asset), path: first.run.tree.pathFor(0),
    });
    expect(sim.ledger.movements.member(pureCircuits.paidOnceOf(fromHex(payRecordNonceOf(payKey, pay.records[0]!))))).toBe(true);
    /* RED WHEN: the approving device does not read the chain's record of who was paid for the month, so a second run paying Ada for September is approved. */
    expect(check(second, secondId)).toThrow(/This run pays somebody already recorded as paid for 2026-09/u);
  });
});
