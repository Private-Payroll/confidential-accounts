/**
 * **A RETRY HAS SOMEWHERE TO LIVE, AND IT PAYS NOBODY TWICE.**
 *
 * A leg of a payroll run is approved once, over a tree of every person on it.
 * When that round does not reach everybody, the people it missed are paid from
 * a second, smaller approval - and the only thing that makes that safe is that
 * each of them has the same leaf in the smaller tree as in the first, because
 * the account records a completed payment by its leaf.
 *
 * **WHAT THIS FILE HOLDS THE PRODUCT TO, AGAINST THE COMPILED CIRCUITS:**
 *
 *   - a retry is raised through the product's own door and kept on the leg it
 *     retries, beside the leg's own material, without disturbing it
 *   - its leaves are the leg's own leaves, so a person the first round already
 *     paid is refused by the chain under the retry, and a person it did not
 *     reach is paid by it
 *   - material derived under any other identity is refused before anybody signs,
 *     and the refusal is not vacuous: such material really does carry different
 *     leaves, which the chain would really pay
 *   - the payment view does not call a person beyond reach while a retry that
 *     still covers them is open
 *
 * **THE SIMULATED LEDGER CANNOT ANSWER THE CHAIN HALF**, which is why this file
 * drives `AccountSimulator` - the compiled account contract with every assert
 * live - with the values the product wrote down.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountSimulator, privateStateFor } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountService, openAccount, sealAccount } from '../../src/core/account.js';
import { PayrollService } from '../../src/core/payroll.js';
import {
  SimulatedLedger, SimulatedProofSystem, type StateChange,
} from '../../src/core/ledger.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { buildRun, buildRetryRun } from '../../src/midnight/payout-tree.js';
import { runMaterialFor, retryMaterialFor } from '../../src/midnight/run-material.js';
import { runStatus } from '../../src/midnight/run-status.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../../src/testing/assets.js';
import { FileStore } from '../../src/core/store-file.js';
import { assetIdBytes } from '../../src/core/assets.js';
import { fromHex, toHex, unseal, parseCanonical, type Hex, type Sealed } from '../../src/core/crypto.js';

const PAYROLL_VAULT = new Uint8Array(32).fill(0xa1);

/* A fixed clock, in seconds, so the windows below are the test's and not the machine's. */
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
/* The retry's own window, which starts later and ends later than the leg's. */
const RETRY_OPENS = BigInt(NOW - 60);
const RETRY_CLOSES = BigInt(NOW + 86_400);

const services = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-retry-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(
    store, new SimulatedLedger(MidnightCommitments), MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  return { store, accounts, payroll };
};

const changeOf = (sealedPayload: Sealed, viewingKey: Hex): StateChange =>
  parseCanonical<{ __change: StateChange }>(unseal(sealedPayload, viewingKey)).__change;

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

/** A company paying three people, whose one leg the PRODUCT has raised. */
async function aRaisedLeg() {
  const { store, accounts, payroll } = services();
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;
  for (let i = 0; i < 3; i++) {
    payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const { run } = await payroll.createRunFromRoster(created.account.id, '2026-08', viewingKey);
  const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
  const material = await runMaterialFor({
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
    opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
  });
  const by = created.secrets[0]!.signerId;
  const proposal = await payroll.proposeRun(run.id, viewingKey, by, material);
  return { store, accounts, payroll, created, viewingKey, run, material, proposal, by };
}

/** Retry material built the way the product's route builds it: from the leg's own record. */
async function retryFromTheRecord(
  payroll: PayrollService, runId: string, viewingKey: Hex, indices: number[],
) {
  const rebuild = (await payroll.payoutRebuildOf(runId, viewingKey))!;
  return retryMaterialFor({
    rebuild, indices, opensAt: RETRY_OPENS, closesAt: RETRY_CLOSES,
    vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
  });
}

describe('a retry lives on the leg it retries', () => {
  it('is kept beside the leg\'s own material, which it leaves exactly as it was', async () => {
    const r = await aRaisedLeg();
    const before = r.payroll.requireRun(r.run.id, r.viewingKey);

    const retry = await retryFromTheRecord(r.payroll, r.run.id, r.viewingKey, [0, 2]);
    const raised = await r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry);

    const after = r.payroll.requireRun(r.run.id, r.viewingKey);
    /* RED WHEN the door writes the retry into the leg's own slot instead of beside it. */
    expect(after.payout!.GBP!.root).toBe(before.payout!.GBP!.root);
    expect(after.payout!.GBP!.leaves).toEqual(before.payout!.GBP!.leaves);
    /* RED WHEN the retry's proposal replaces the leg's own in the per-leg map. */
    expect(after.proposalIds.GBP).toBe(r.proposal.id);
    /* RED WHEN the retry is not written down, or its proposal is not recorded against it. */
    expect(after.payout!.GBP!.retries).toEqual([expect.objectContaining({
      originalIndices: [0, 2], root: retry.run.root, payees: 2n,
      opensAt: RETRY_OPENS, closesAt: RETRY_CLOSES, proposalId: raised.id,
    })]);
    /* RED WHEN a run cannot be found by the round its retry was raised as. */
    expect(r.store.getRun(r.run.id)!.proposalIds).toContain(raised.id);
    /* RED WHEN the retry is written outside the sealed envelope, where the store can read it. */
    expect(JSON.stringify(r.store.getRun(r.run.id))).not.toContain(retry.run.root);
  });

  it('uses the leg\'s own leaves, so the chain refuses whoever the leg already paid and pays the rest',
    async () => {
      const r = await aRaisedLeg();
      const legChange = changeOf(r.proposal.sealedPayload, r.viewingKey);

      const sim = await AccountSimulator.create(privateStateFor(9));
      await sim.seatLeaf(
        fromHex(r.created.account.signers[0]!.leafCommitment!), [privateStateFor(9)], 61);
      sim.at(NOW);
      const legDevice = deviceCarrying(r.created.secrets[0]!, legChange);
      await sim.as(legDevice).proposeRun({
        root: fromHex(r.material.run.root), payees: r.material.run.payees,
        from: OPENS, until: CLOSES, vault: PAYROLL_VAULT,
      });
      const legId = fromHex(r.proposal.chainId);
      await sim.as(legDevice).approve(legId);

      /* The leg pays person 0, from a rebuild of what the product wrote down. */
      const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, r.viewingKey))!;
      const whole = buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails);
      const first = whole.payeeArgs(0);
      await sim.as(legDevice).recordPayment({
        proposal: legId, vault: PAYROLL_VAULT, root: fromHex(r.material.run.root),
        payees: r.material.run.payees, from: OPENS, until: CLOSES,
        salt: fromHex(legChange.salt), details: fromHex(first.details),
        nonce: fromHex(first.nonce), path: first.path,
      });

      /* A retry over persons 0 and 2, raised through the product. */
      const retry = await retryFromTheRecord(r.payroll, r.run.id, r.viewingKey, [0, 2]);
      /* RED WHEN the retry's leaves stop being the leg's own leaves for those people. */
      expect(retry.leaves).toEqual([r.material.leaves[0], r.material.leaves[2]]);
      const raised = await r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry);
      const retryChange = changeOf(raised.sealedPayload, r.viewingKey);
      const retryDevice = deviceCarrying(r.created.secrets[0]!, retryChange);
      await sim.as(retryDevice).proposeRun({
        root: fromHex(retry.run.root), payees: retry.run.payees,
        from: RETRY_OPENS, until: RETRY_CLOSES, vault: PAYROLL_VAULT,
      });
      const retryId = fromHex(raised.chainId);
      /* The chain opened the id the product wrote down for the retry. */
      expect(sim.isOpen(retryId)).toBe(true);
      await sim.as(retryDevice).approve(retryId);

      const smaller = buildRetryRun(whole, [0, 2]);
      const present = (at: number) => {
        const a = smaller.payeeArgs(at);
        return sim.as(retryDevice).recordPayment({
          proposal: retryId, vault: PAYROLL_VAULT, root: fromHex(retry.run.root),
          payees: retry.run.payees, from: RETRY_OPENS, until: RETRY_CLOSES,
          salt: fromHex(retryChange.salt), details: fromHex(a.details),
          nonce: fromHex(a.nonce), path: a.path,
        });
      };

      /* RED WHEN a retry can pay somebody the leg already paid. */
      await expect(present(0)).rejects.toThrow(/already been made/i);
      await present(1);
      /* RED WHEN the person the leg did not reach is not paid by the retry. */
      expect(sim.ledger.movements.member(
        pureCircuits.paidMovementOf(fromHex(r.material.leaves[2]!)))).toBe(true);
    });

  it('refuses retry material derived under any identity but the leg\'s own - and such material really pays twice',
    async () => {
      const r = await aRaisedLeg();
      const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, r.viewingKey))!;

      const minted = await retryMaterialFor({
        rebuild: { ...rebuild, identity: { ...rebuild.identity, runId: 'run_mintedafresh:GBP' } },
        indices: [0, 2], opensAt: RETRY_OPENS, closesAt: RETRY_CLOSES,
        vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
      });
      /* The control: a fresh identity is not a relabelling, it is different leaves. */
      expect(minted.leaves[0]).not.toBe(r.material.leaves[0]);
      /* RED WHEN the door stops comparing the material's identity with the leg's. */
      await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, minted))
        .rejects.toThrow(/was built under run run_mintedafresh:GBP/);

      const otherGeneration = await retryMaterialFor({
        rebuild: { ...rebuild, identity: { ...rebuild.identity, epoch: rebuild.identity.epoch + 1 },
          seeds: [...rebuild.seeds, { ...rebuild.seeds[0]!, epoch: rebuild.identity.epoch + 1,
            seed: 'ab'.repeat(32) as Hex }] },
        indices: [1], opensAt: RETRY_OPENS, closesAt: RETRY_CLOSES,
        vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
      });
      expect(otherGeneration.leaves[0]).not.toBe(r.material.leaves[1]);
      /* RED WHEN the seed generation is not compared. */
      await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, otherGeneration))
        .rejects.toThrow(/at seed generation 1 .* at generation 0/);

      /* And nothing was written onto the leg by either refusal. */
      expect(r.payroll.requireRun(r.run.id, r.viewingKey).payout!.GBP!.retries).toBeUndefined();
    });

  it('refuses leaves that are not the leg\'s own for the people named, whatever the material claims',
    async () => {
      const r = await aRaisedLeg();
      const honest = await retryFromTheRecord(r.payroll, r.run.id, r.viewingKey, [0, 2]);

      /* The same leaves under the wrong names: person 1's leaf filed as person 0's. */
      const relabelled = { ...honest, originalIndices: [1, 2] };
      /* RED WHEN each leaf is not compared with the leg's leaf at the position it names. */
      await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, relabelled as never))
        .rejects.toThrow(/not the leaves the leg already holds/);

      const outOfRange = { ...honest, originalIndices: [0, 3] };
      /* RED WHEN a position past the end of the leg is accepted. */
      await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, outOfRange as never))
        .rejects.toThrow(/there is no person 3 on it/);

      const twice = { ...honest, originalIndices: [0, 0] };
      /* RED WHEN the same person may be named twice. */
      await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, twice as never))
        .rejects.toThrow(/named twice/);
    });

  it('refuses a retry on a leg that has not been raised', async () => {
    const { accounts, payroll } = services();
    const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    payroll.hireDirect(created.account.id, {
      name: 'Payee 0', email: 'p0@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, created.viewingKey);
    const { run } = await payroll.createRunFromRoster(
      created.account.id, '2026-08', created.viewingKey);
    /* RED WHEN a retry can be raised against a leg with no approved round to retry. */
    await expect(payroll.proposeRetry(
      run.id, created.viewingKey, created.secrets[0]!.signerId, null))
      .rejects.toThrow(/has not been raised, so there is nobody on it to retry/);
  });

  it('does not report a person as beyond reach while a raised retry still covers them', async () => {
    const r = await aRaisedLeg();
    const retry = await retryFromTheRecord(r.payroll, r.run.id, r.viewingKey, [2]);
    await r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry);

    const inputs = r.payroll.payoutMaterialOf(r.run.id, r.viewingKey)!;
    /* RED WHEN the payment view is not told about the leg's raised retries. */
    expect(inputs.retries).toEqual([{ indices: [2], window: { from: RETRY_OPENS, until: RETRY_CLOSES } }]);

    const nobodyPaid = { movements: { member: () => false } };
    const afterTheLegClosed = Number(CLOSES) + 10;
    const status = runStatus(inputs, nobodyPaid, (leaf) => leaf, afterTheLegClosed);
    expect(status.phase).toBe('closed');
    /* RED WHEN a person the open retry covers is still reported stranded. */
    expect(status.stranded.map(p => p.index)).toEqual([0, 1]);

    const afterTheRetryClosed = Number(RETRY_CLOSES);
    /* RED WHEN a retry whose own window has closed still hides somebody. */
    expect(runStatus(inputs, nobodyPaid, (leaf) => leaf, afterTheRetryClosed)
      .stranded.map(p => p.index)).toEqual([0, 1, 2]);
  });

  it('does not count a withdrawn retry as one that can still pay anybody', async () => {
    const r = await aRaisedLeg();
    const retry = await retryFromTheRecord(r.payroll, r.run.id, r.viewingKey, [2]);
    const raised = await r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry);
    expect(r.payroll.payoutMaterialOf(r.run.id, r.viewingKey)!.retries).toHaveLength(1);

    await r.accounts.cancel(raised.id, r.viewingKey);
    /* RED WHEN a retry that was withdrawn still hides its people from the stranded list. */
    expect(r.payroll.payoutMaterialOf(r.run.id, r.viewingKey)!.retries).toBeUndefined();
  });

  it('refuses a retry on a leg this company\'s own policy stopped', async () => {
    const { store, accounts, payroll } = services();
    const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    const vk = created.viewingKey;
    for (let i = 0; i < 2; i++) {
      payroll.hireDirect(created.account.id, {
        name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
      }, vk);
    }
    const rec = accounts.require(created.account.id);
    const account = openAccount(rec, vk);
    account.policy.limitsByRole = {
      admin: { GBP: { perTransaction: 150_00n, perPeriod: null, periodDays: 30 } },
    };
    store.putAccount(sealAccount(account, vk, rec.pendingSigners, rec.keyEpoch));

    const { run } = await payroll.createRunFromRoster(created.account.id, '2026-08', vk);
    const inputs = await payroll.runMaterialInputs(run.id, vk);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
      opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
    });
    const by = created.secrets[0]!.signerId;
    const stopped = await payroll.proposeRun(run.id, vk, by, material);
    expect(stopped.status).toBe('blocked');

    const retry = await retryFromTheRecord(payroll, run.id, vk, [1]);
    /* RED WHEN a payroll the policy stopped can be split into retries under the ceiling. */
    await expect(payroll.proposeRetry(run.id, vk, by, retry))
      .rejects.toThrow(/was stopped by this company's own policy, so there is no round on it to retry/);
  });
});
