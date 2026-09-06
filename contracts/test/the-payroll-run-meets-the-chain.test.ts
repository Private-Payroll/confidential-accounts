/**
 * **THE PRODUCT'S OWN PAYROLL RUN, DRIVEN INTO THE REAL CIRCUITS.** `C375`,
 * `T-213`, board row `2y7d4`.
 *
 * **WHAT THIS FILE EXISTS TO CATCH, AND IT WAS LIVE UNTIL THIS ROUND.**
 * `PayrollService.proposeRun` raised every payroll round through
 * `AccountService.propose({kind: 'payroll'})`, whose payload hash is an
 * APPLICATION digest — `commit(canonical({accountId, kind, sealedPayload,
 * proposedBy}), '')` — while `recordPayment` recomputes
 * `proposalIdOf(runPayload(root, payees, opensAt, closesAt), forVault, salt)`
 * and matches only a `runPayload`. **The two can never be equal.** So a run was
 * raised, approved by real signers, paid for, and unpayable by any vault for
 * ever; and because the governance branch writes no `runWindow` row, nothing
 * could close it either.
 *
 * **IT IS `S43`'s AND `S44`'s SHAPE AND NOT A UNIT TEST, AND THAT IS THE WHOLE
 * POINT.** `C371` existed precisely because no propose path had ever carried the
 * SERVICE's own value to a REAL binding: everything either compared a value with
 * a second computation of itself, or drove the contract with values the test
 * file wrote. **Not one value under test here is written by this file.** The
 * root and the window are handed to the product through its public door; the
 * proposal id, the digest, the vault and the change salt come back off the
 * SERVICE's own record; and the contract is then asked whether it agrees.
 *
 * **THE SIMULATED LEDGER CANNOT ANSWER THIS QUESTION AND A GREEN RUN THROUGH IT
 * IS NOT EVIDENCE.** It has no `recordPayment`, no block time and its own
 * deliberately-different commitment scheme. That is why this file is in
 * `contracts/test/` and drives `AccountSimulator` — the compiled circuits, every
 * assert live.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountSimulator, privateStateFor } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountService } from '../../src/core/account.js';
import { PayrollService } from '../../src/core/payroll.js';
import {
  SimulatedLedger, SimulatedProofSystem, type StateChange,
} from '../../src/core/ledger.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { FileStore } from '../../src/core/store-file.js';
import { assetIdBytes } from '../../src/core/assets.js';
import { fromHex, toHex, unseal, parseCanonical, type Hex } from '../../src/core/crypto.js';

/** A vault is any 32 bytes as far as the account is concerned; it never dereferences one. */
const PAYROLL_VAULT = new Uint8Array(32).fill(0xa1);

/*
 * A FIXED CLOCK. `recordPayment` asserts the payment falls inside the approved
 * window, so this test controls time rather than inheriting it. Seconds since
 * the Unix epoch — milliseconds would put every window tens of thousands of
 * years out and every assert would fail for the wrong reason.
 */
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);

const bytes = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff);

/**
 * The payee leaves of a run. Opaque bytes on purpose: the account cannot tell a
 * payee from a hash and neither can this test — what the VAULT puts inside them
 * is the vault's business and is tested against the vault.
 */
const payeesOf = (n: number): PayoutLeafInput[] =>
  Array.from({ length: n }, (_, i) => ({
    details: toHex(bytes(i + 1)), nonce: toHex(bytes(i + 101)),
  }));

/** The MIDNIGHT scheme, against a simulated ledger. `the-service-layer-meets-the-chain.test.ts:87`. */
const services = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s47-')), 'db.json'));
  const accounts = new AccountService(
    store, new SimulatedLedger(MidnightCommitments), MidnightCommitments);
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem());
  return { store, accounts, payroll };
};

/**
 * **THE PRODUCT RAISES A ONE-PAYEE RUN THROUGH ITS OWN PUBLIC DOOR.**
 *
 * Everything returned is the SERVICE's: the proposal record it wrote, and the
 * `StateChange` it sealed inside its own payload. The only things this file
 * chose are the payee's opaque leaf bytes, the window and the vault — the three
 * a caller supplies, and the three nothing in `src/` can supply yet, which is
 * this round's declared finding.
 */
async function aRunTheProductRaised(payees = 1) {
  const { accounts, payroll } = services();
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;

  for (let i = 0; i < payees; i++) {
    payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const { run } = await payroll.createRunFromRoster(created.account.id, '2026-08', viewingKey);

  const leaves = payeesOf(payees);
  const tree = buildPayoutTree(leaves);

  const proposal = await payroll.proposeRun(run.id, viewingKey, created.secrets[0]!.signerId, {
    root: tree.root,
    payees: tree.payees,
    opensAt: OPENS,
    closesAt: CLOSES,
    vault: toHex(PAYROLL_VAULT),
  });

  const change = parseCanonical<{ __change: StateChange }>(
    unseal(proposal.sealedPayload, viewingKey)).__change;

  return { accounts, payroll, created, viewingKey, run, tree, leaves, proposal, change };
}

/**
 * The proposer's device, carrying the SERVICE's material and the SERVICE's
 * change. `proposalSalt` is the field the circuit reads to build the id, and it
 * is the service's — `the-service-layer-meets-the-chain.test.ts:518-530`.
 */
const deviceCarrying = (
  secrets: { signingSecret: Hex; blinding: Hex; scope: Hex }, change: StateChange,
) => ({
  ...privateStateFor(9),
  secretKey: fromHex(secrets.signingSecret),
  blinding: fromHex(secrets.blinding),
  scope: fromHex(secrets.scope),
  assetId: assetIdBytes(change.asset),
  changeAmount: change.amount,
  changeBatchDigest: fromHex(change.batchDigest),
  proposalSalt: fromHex(change.salt),
});

describe('C375: a payroll run the PRODUCT raised is one a VAULT can pay', () => {
  it('THE HEADLINE: the service\'s own id opens a RUN on chain, and recordPayment accepts it',
    async () => {
      const r = await aRunTheProductRaised();

      /*
       * HALF ZERO, AND IT IS THE CHEAPEST OF THE THREE. The id the service
       * stored is the one the contract's own circuits derive from the four run
       * parts. Under `C375` this was `proposalIdOf(applicationDigest, …)` and
       * could not equal it for any input.
       */
      const payload = pureCircuits.runPayload(
        fromHex(r.tree.root), r.tree.payees, OPENS, CLOSES);
      expect(r.proposal.digest).toBe(toHex(payload));
      expect(r.proposal.chainId)
        .toBe(toHex(pureCircuits.proposalIdOf(payload, PAYROLL_VAULT, fromHex(r.change.salt))));

      const sim = await AccountSimulator.create(privateStateFor(9));
      await sim.seatLeaf(
        fromHex(r.created.account.signers[0]!.leafCommitment!), [privateStateFor(9)], 47);
      sim.at(NOW);

      const device = deviceCarrying(r.created.secrets[0]!, r.change);

      /* The run branch of the merged `propose`, with the SERVICE's four parts. */
      await sim.as(device).proposeRun({
        root: fromHex(r.tree.root), payees: r.tree.payees,
        from: OPENS, until: CLOSES, vault: PAYROLL_VAULT,
      });

      /*
       * **HALF ONE: THE CHAIN OPENED THE ID THE SERVICE WROTE DOWN.** Under
       * `C375` the service's id named nothing on chain, and every approval
       * gathered against it was unusable.
       */
      const id = fromHex(r.proposal.chainId);
      expect(sim.isOpen(id)).toBe(true);

      /*
       * **AND IT IS A RUN RATHER THAN A GOVERNANCE ROUND, WHICH IS THE HALF NO
       * ID COMPARISON CAN SHOW.** `runWindow` has a row only on the run branch
       * (`compact:2156`); a governance round has none at all, which is what
       * `cancel` and `closeExpiredRun` rest on.
       */
      expect(sim.runWindow(id)).toEqual({ from: OPENS, until: CLOSES });

      await sim.as(device).approve(id);
      expect(sim.approvalsFor(id)).toBe(1n);

      /*
       * **HALF TWO: THE CIRCUIT THAT CONSUMES THE PAYLOAD.** `recordPayment`
       * recomputes the id from the run's four parts and the vault and compares
       * it — so a refusal here is about WHAT WAS APPROVED and nothing else.
       * This is the call a vault makes on payday, and it is the one `C375`
       * would have failed after every signature was collected and every fee
       * spent.
       */
      await sim.as(device).recordPayment({
        proposal: id,
        vault: PAYROLL_VAULT,
        root: fromHex(r.tree.root),
        payees: r.tree.payees,
        from: OPENS,
        until: CLOSES,
        salt: fromHex(r.change.salt),
        details: fromHex(r.leaves[0]!.details),
        nonce: fromHex(r.leaves[0]!.nonce),
        path: r.tree.pathFor(0),
      });

      /* The chain MOVED, so the payment settled rather than merely not throwing. */
      expect(sim.ledger.movements.member(
        pureCircuits.paidMovementOf(fromHex(r.tree.leaves[0]!)))).toBe(true);
    });

  /**
   * **THE DEFECT ITSELF, AS A REGRESSION TEST.**
   *
   * The old door is still on `AccountService` and is still correct for the four
   * governance rounds, so it cannot be deleted — which means the thing that
   * stops payroll going back through it has to be a test rather than the type.
   * This drives the round the product used to raise and shows the two failures
   * that would have surfaced at a vault: the id is not one the run branch
   * derives, and there is no window row anywhere.
   */
  it('the GOVERNANCE door raises an id no run derives and no window at all', async () => {
    const { accounts, payroll } = services();
    const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    payroll.hireDirect(created.account.id, {
      name: 'Payee 0', email: 'p0@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, created.viewingKey);

    const proposal = await accounts.propose({
      accountId: created.account.id,
      viewingKey: created.viewingKey,
      kind: 'payroll',
      summary: 'Payroll 2026-08, 1 recipients',
      payload: { entries: [] },
      proposedBy: created.secrets[0]!.signerId,
    });
    const change = parseCanonical<{ __change: StateChange }>(
      unseal(proposal.sealedPayload, created.viewingKey)).__change;

    const tree = buildPayoutTree(payeesOf(1));
    const asARun = toHex(pureCircuits.proposalIdOf(
      pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES),
      PAYROLL_VAULT, fromHex(change.salt)));

    /* The two ids are computed over the same salt and cannot be made to meet. */
    expect(proposal.chainId).not.toBe(asARun);

    const sim = await AccountSimulator.create(privateStateFor(9));
    await sim.seatLeaf(
      fromHex(created.account.signers[0]!.leafCommitment!), [privateStateFor(9)], 48);
    sim.at(NOW);
    const device = deviceCarrying(created.secrets[0]!, change);

    await sim.as(device).propose(fromHex(proposal.digest), fromHex(proposal.vault));

    /*
     * It opens — which is exactly why `C375` survived four audits. The round is
     * live, approvable and billable. What it has NOT got is a window, so it is
     * not a run to `cancel`, not a run to `closeExpiredRun`, and its id is one
     * `recordPayment` can never recompute.
     */
    expect(sim.isOpen(fromHex(proposal.chainId))).toBe(true);
    expect(sim.runWindow(fromHex(proposal.chainId))).toBeUndefined();
  });

  /**
   * **THE PRODUCT'S DOOR REFUSES RATHER THAN RAISING THE WRONG THING.**
   *
   * Nothing in `src/` builds a payout root, a payment window or a vault today —
   * measured: `buildRun` and `buildPayoutTree` have no caller in `src/` at all,
   * and `PayrollRun` carries none of the three. So every product caller passes
   * `null` and gets this. A door that raises an unpayable run costs an approval
   * round from every signer and is discovered by the people who were meant to
   * be paid; a door that refuses costs a sentence.
   */
  it('refuses a run with no material instead of raising a governance round', async () => {
    const { accounts, payroll } = services();
    const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    payroll.hireDirect(created.account.id, {
      name: 'Payee 0', email: 'p0@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, created.viewingKey);
    const { run } = await payroll.createRunFromRoster(
      created.account.id, '2026-08', created.viewingKey);

    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, null))
      .rejects.toThrow(/no payout root, no payment window and no vault/);
  });

  /**
   * **THE PAYEE COUNT IS BOUND INTO WHAT THE SIGNERS APPROVE, SO IT MUST MATCH
   * THE ROSTER.** `compact:2606-2609` — a run cannot be declared finished early
   * or made never to finish. A count that disagrees with the leg being proposed
   * is one of those two, and the door refuses before anybody signs.
   */
  it('refuses run material whose payee count disagrees with the leg', async () => {
    const { accounts, payroll } = services();
    const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    payroll.hireDirect(created.account.id, {
      name: 'Payee 0', email: 'p0@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, created.viewingKey);
    const { run } = await payroll.createRunFromRoster(
      created.account.id, '2026-08', created.viewingKey);
    const tree = buildPayoutTree(payeesOf(3));

    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, {
        root: tree.root, payees: tree.payees, opensAt: OPENS, closesAt: CLOSES,
        vault: toHex(PAYROLL_VAULT),
      })).rejects.toThrow(/pays 1 people in GBP and the run material names 3/);
  });

  /**
   * **A RUN AT THE NO-VAULT SENTINEL IS ONE NO VAULT CAN PRESENT.** The vault is
   * folded into the id and `recordPayment` recomputes the id from the vault it
   * is handed, so `noVault()` builds an id nothing can match — `C375`'s own
   * failure shape one argument along, and refused before a fee.
   */
  it('refuses a run raised at the no-vault sentinel', async () => {
    const { accounts, payroll } = services();
    const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    payroll.hireDirect(created.account.id, {
      name: 'Payee 0', email: 'p0@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, created.viewingKey);
    const { run } = await payroll.createRunFromRoster(
      created.account.id, '2026-08', created.viewingKey);
    const tree = buildPayoutTree(payeesOf(1));

    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, {
        root: tree.root, payees: tree.payees, opensAt: OPENS, closesAt: CLOSES,
        vault: MidnightCommitments.noVault(),
      })).rejects.toThrow(/must name the vault that will pay it/);
  });
});
