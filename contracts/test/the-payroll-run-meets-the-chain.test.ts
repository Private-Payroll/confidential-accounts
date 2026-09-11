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
import { buildRun, rootOfLeaves } from '../../src/midnight/payout-tree.js';
import { runMaterialFor } from '../../src/midnight/run-material.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../../src/testing/assets.js';
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


/** The MIDNIGHT scheme, against a simulated ledger. `the-service-layer-meets-the-chain.test.ts:87`. */
const services = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s47-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(
    store, new SimulatedLedger(MidnightCommitments), MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  return { store, accounts, payroll };
};

/**
 * **A COMPANY WITH A PAYROLL ON IT, AND NOTHING RAISED YET.**
 *
 * The people are hired through the seeded onboarding, so each of them has a
 * roster entry with an address of their own — which is what makes them payable
 * and is the only source of a payee's address anywhere in this product.
 */
async function aCompanyWithAPayroll(payees = 1) {
  const { accounts, payroll } = services();
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;

  for (let i = 0; i < payees; i++) {
    payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const { run } = await payroll.createRunFromRoster(created.account.id, '2026-08', viewingKey);
  return { accounts, payroll, created, viewingKey, run };
}

/**
 * **THE PRODUCT RAISES A RUN THROUGH ITS OWN PUBLIC DOOR, WITH MATERIAL IT
 * BUILT ITSELF.**
 *
 * **NOT ONE VALUE UNDER TEST IS WRITTEN BY THIS FILE.** The payees come off the
 * roster, their secrets are derived from the account's own payout seed, the
 * leaves are the VAULT's own commitments over those payees, and the root is the
 * runtime's own merkle tree over those leaves. What this file chooses is the
 * window and the vault — the two facts about the world that are not derivable
 * from anything the product holds — and the number of people.
 *
 * The proposal record and the `StateChange` sealed inside its payload come back
 * off the service, and the contract is then asked whether it agrees.
 */
async function aRunTheProductRaised(payees = 1) {
  const base = await aCompanyWithAPayroll(payees);
  const { payroll, created, viewingKey, run } = base;

  const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
  /* Defaulting `detailsOf`, so this drives the pairing the product ships with
   * rather than the fixture. The rebuild below uses the fixture, so the two
   * agreeing is itself under test. */
  const material = await runMaterialFor({
    accountId: inputs.accountId,
    runId: inputs.runId,
    seeds: inputs.seeds,
    facts: inputs.facts,
    opensAt: OPENS,
    closesAt: CLOSES,
    vault: toHex(PAYROLL_VAULT),
  });

  const proposal = await payroll.proposeRun(
    run.id, viewingKey, created.secrets[0]!.signerId, material);

  const change = parseCanonical<{ __change: StateChange }>(
    unseal(proposal.sealedPayload, viewingKey)).__change;

  return { ...base, material, proposal, change };
}

/**
 * **THE RUN REBUILT FROM WHAT THE COMPANY WROTE DOWN, WHICH IS HOW IT GETS
 * PAID.**
 *
 * A leaf is not enough to pay somebody: paying needs their merkle path, their
 * blinding and their nonce, and none of those is stored anywhere. They are
 * derived again, from the account's payout seed and the identity the run was
 * raised under — on any signer's machine, with the machine that raised it at
 * the bottom of a river.
 *
 * **THE GENERATION COMES OFF THE RECORD AND IS NOT ASKED FOR AFRESH.** That is
 * the whole reason the record keeps it.
 */
async function rebuiltFromTheRecord(
  payroll: PayrollService, runId: string, viewingKey: Hex, asset?: string,
) {
  const rebuild = await payroll.payoutRebuildOf(runId, viewingKey, asset);
  if (!rebuild) throw new Error('this leg has no payout material on record');
  return buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails);
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
        fromHex(r.material.run.root), r.material.run.payees, OPENS, CLOSES);
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
        root: fromHex(r.material.run.root), payees: r.material.run.payees,
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
      /*
       * **THE PAYMENT IS MADE FROM A REBUILD, NOT FROM THE OBJECT THAT RAISED
       * THE RUN, AND THAT IS THE POINT OF THE WHOLE ARC.**
       *
       * A vault paying on payday does not have the tree the raise produced — it
       * has the company's record, the account's seed, and the roster. If those
       * three do not derive the same leaves and the same paths, every payment of
       * an approved run is refused as *"that payee is not in the approved run"*,
       * after the signatures are in and the fee is spent. So the arguments below
       * come from a fresh derivation, and the root it produced is asserted equal
       * to the one the signers approved before anything is presented.
       */
      const rebuilt = await rebuiltFromTheRecord(r.payroll, r.run.id, r.viewingKey);
      expect(rebuilt.tree.root).toBe(r.material.run.root);
      expect(rebuilt.tree.leaves).toEqual(r.material.leaves);

      const args = rebuilt.payeeArgs(0);
      await sim.as(device).recordPayment({
        proposal: id,
        vault: PAYROLL_VAULT,
        root: fromHex(r.material.run.root),
        payees: r.material.run.payees,
        from: OPENS,
        until: CLOSES,
        salt: fromHex(r.change.salt),
        details: fromHex(args.details),
        nonce: fromHex(args.nonce),
        path: args.path,
      });

      /* The chain MOVED, so the payment settled rather than merely not throwing. */
      expect(sim.ledger.movements.member(
        pureCircuits.paidMovementOf(fromHex(r.material.leaves[0]!)))).toBe(true);
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
    const { accounts, payroll, created, run } = await aCompanyWithAPayroll(1);

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

    const inputs = await payroll.runMaterialInputs(run.id, created.viewingKey);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds,
      facts: inputs.facts, opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT),
    });
    const asARun = toHex(pureCircuits.proposalIdOf(
      pureCircuits.runPayload(
        fromHex(material.run.root), material.run.payees, OPENS, CLOSES),
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
   * The product builds a run's material now, but a caller that has none — a
   * seeder with no vault, a client that has not been changed yet — still has to
   * say so out loud rather than have a default arrive in the field that decides
   * where the money goes. A door that raises an unpayable run costs an approval
   * round from every signer and is discovered by the people who were meant to
   * be paid; a door that refuses costs a sentence.
   */
  it('refuses a run with no material instead of raising a governance round', async () => {
    const { payroll, created, run } = await aCompanyWithAPayroll(1);

    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, null))
      .rejects.toThrow(/cannot be proposed without its payout material/);
  });

  /**
   * **THE PAYEE COUNT IS BOUND INTO WHAT THE SIGNERS APPROVE, SO IT MUST MATCH
   * THE ROSTER.** `compact:2606-2609` — a run cannot be declared finished early
   * or made never to finish. A count that disagrees with the leg being proposed
   * is one of those two, and the door refuses before anybody signs.
   */
  it('refuses run material whose payee count disagrees with the leg', async () => {
    const { payroll, created, run } = await aCompanyWithAPayroll(1);
    const inputs = await payroll.runMaterialInputs(run.id, created.viewingKey);
    /* A tree over three payees for a payroll that pays one. The three leaves are
     * distinct even from one repeated fact, because each payee's nonce is
     * derived from their INDEX. */
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds,
      facts: [inputs.facts[0]!, inputs.facts[0]!, inputs.facts[0]!],
      opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT),
    });

    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, material))
      .rejects.toThrow(/pays 1 people in GBP and the run material names 3/);
  });

  /**
   * **A RUN AT THE NO-VAULT SENTINEL IS ONE NO VAULT CAN PRESENT.** The vault is
   * folded into the id and `recordPayment` recomputes the id from the vault it
   * is handed, so `noVault()` builds an id nothing can match — `C375`'s own
   * failure shape one argument along, and refused before a fee.
   */
  it('refuses a run raised at the no-vault sentinel', async () => {
    const { payroll, created, run } = await aCompanyWithAPayroll(1);
    const inputs = await payroll.runMaterialInputs(run.id, created.viewingKey);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds,
      facts: inputs.facts, opensAt: OPENS, closesAt: CLOSES,
      vault: MidnightCommitments.noVault(),
    });

    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, material))
      .rejects.toThrow(/must name the vault that will pay it/);
  });
});
