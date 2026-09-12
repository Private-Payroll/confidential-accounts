/**
 * **A PERSON WHOSE PAYROLL RAISE FAILED CANNOT PAY ANYBODY TWICE BY STARTING IT
 * AGAIN, WHICHEVER WAY THEY START IT AGAIN.**
 *
 * Raising a leg of a payroll run writes the round down and then calls the chain.
 * The call can throw after the network already holds the transaction, and from
 * that moment nothing on this machine knows whether the round is open. What the
 * person gets is an error, and what a person holding an error does is try again.
 *
 * **THE ACCOUNT RECORDS A COMPLETED PAYMENT BY ITS LEAF AND BY NOTHING ELSE.**
 * A payee's leaf is derived from the run's identifier, so a second attempt
 * carrying a NEW identifier derives a leaf the account has never seen: it is a
 * different payment, it is refused by nothing, and both settle. Fifty people are
 * paid twice and the vault is short. That is measured here first, before
 * anything is held to anything, because a guard whose failure nobody has watched
 * is a guard nobody can trust.
 *
 * **SO EVERY WAY BACK IN HAS TO REUSE THE IDENTIFIER THE LEG WAS RAISED UNDER,
 * OR BE REFUSED.** There are four ways in and this file walks all four:
 *
 *   - drawing the payroll up again from the roster
 *   - drawing it up again through the ad hoc door
 *   - raising the same leg again
 *   - raising a retry on the leg, for the people it did not reach
 *
 * The first two are refused and say what to do instead. The last two rebuild
 * from what the leg was raised under, and this file pins that the leaves they
 * produce are the SAME BYTES - which is the only reason the account can see that
 * the payment has already been made.
 *
 * **AND IT IS PINNED AGAINST THE COMPILED CIRCUITS AT THE END**, because the
 * claim is about what the chain refuses and a simulated ledger cannot answer
 * that. The same file shows the refusal firing when the bytes match and NOT
 * firing when they do not, so neither half is taken on trust.
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
import { buildRun } from '../../src/midnight/payout-tree.js';
import { runMaterialFor, retryMaterialFor } from '../../src/midnight/run-material.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../../src/testing/assets.js';
import { FileStore } from '../../src/core/store-file.js';
import { assetIdBytes } from '../../src/core/assets.js';
import { fromHex, toHex, unseal, parseCanonical, type Hex, type Sealed } from '../../src/core/crypto.js';

const PAYROLL_VAULT = new Uint8Array(32).fill(0xa1);

/* A fixed clock in seconds, so every window below is this file's and not the machine's. */
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const PERIOD = '2026-08';

/**
 * The services, over a chain whose next raise can be made to throw AFTER the
 * network already has the transaction. That is the state this whole file is
 * about: the round is open and nothing local knows it.
 */
const services = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-twice-')), 'db.json'));
  const inner = new SimulatedLedger(MidnightCommitments);
  const control = { landThenThrow: false, raises: 0 };
  const ledger = new Proxy(inner, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop === 'proposeRun') {
        return async (...args: unknown[]) => {
          const throwing = control.landThenThrow;
          control.landThenThrow = false;
          control.raises++;
          const raised = await value.apply(target, args);
          if (throwing) throw new Error('the socket closed after sending');
          return raised;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  return { store, accounts, payroll, inner, control };
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

/** A company of `people`, with one payroll run drawn from the roster for the period. */
async function aCompanyWithADraftedRun(people: number) {
  const s = services();
  const created = await s.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;
  for (let i = 0; i < people; i++) {
    s.payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const account = created.account.id;
  const { run } = await s.payroll.createRunFromRoster(account, PERIOD, viewingKey);
  const by = created.secrets[0]!.signerId;

  /** Material the way a product route builds it: from whatever the run's own record says. */
  const materialFor = async (runId: string, vk: Hex = viewingKey) => {
    const i = await s.payroll.runMaterialInputs(runId, vk);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
      ...(i.epoch !== undefined ? { epoch: i.epoch } : {}),
    });
  };
  const openRounds = async () => (await s.inner.status(account))!.openProposals.length;
  const roundsOf = (runId: string) =>
    s.accounts.payrollRoundsOf(account, viewingKey).filter(r => r.runId === runId);
  return { ...s, created, viewingKey, account, run, by, materialFor, openRounds, roundsOf };
}

/** The same company, whose one raise threw after the network already had it. */
async function aRaiseThatThrewAfterTheNetworkHadIt(people = 3) {
  const c = await aCompanyWithADraftedRun(people);
  const first = await c.materialFor(c.run.id);
  c.control.landThenThrow = true;
  await expect(c.payroll.proposeRun(c.run.id, c.viewingKey, c.by, first))
    .rejects.toThrow(/after sending/);
  /* The state that makes every case below reachable: a draft, and a round on chain. */
  expect(c.payroll.requireRun(c.run.id, c.viewingKey).status).toBe('draft');
  expect(await c.openRounds()).toBe(1);
  return { ...c, first };
}

describe('the hazard: a run identifier is what tells two payments apart', () => {
  it('the same people, amounts and account under a minted identifier are DIFFERENT payments, '
    + 'and the paid-once record cannot connect them', async () => {
    const r = await aRaiseThatThrewAfterTheNetworkHadIt(3);
    const recorded = (await r.payroll.payoutRebuildOf(r.run.id, r.viewingKey))!;

    /* Everything held equal except the identifier - the same facts object, window and vault. */
    const minted = await runMaterialFor({
      accountId: recorded.identity.accountId, runId: 'run_startedagainbyhand:GBP',
      seeds: recorded.seeds, facts: recorded.facts, epoch: recorded.identity.epoch,
      opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
    });

    /* The loop below is only worth anything if it runs, and over more than one person.
       RED WHEN this fixture stops raising a run for three people. */
    expect(r.first.leaves).toHaveLength(3);
    expect(minted.leaves).toHaveLength(r.first.leaves.length);
    for (let i = 0; i < r.first.leaves.length; i++) {
      /* RED WHEN a run's per-payee secrets stop depending on its identifier, which is
         what makes a second attempt under a new one a second set of payments that the
         account records separately and refuses neither of. */
      expect(minted.leaves[i]).not.toBe(r.first.leaves[i]);
    }
  });
});

describe('every way a person can start a failed run again', () => {
  it('1 - the roster door will not draw the payroll up again, and says what to do instead', async () => {
    const r = await aRaiseThatThrewAfterTheNetworkHadIt();
    /* RED WHEN the roster door reads the draft's own status instead of asking whether a
       round has been raised for it. A raise that threw leaves the run a draft. */
    await expect(r.payroll.createRunFromRoster(r.account, PERIOD, r.viewingKey))
      .rejects.toThrow(/a round has been raised for it/);
    /* RED WHEN the refusal does not tell the person the two things that are safe. */
    await expect(r.payroll.createRunFromRoster(r.account, PERIOD, r.viewingKey))
      .rejects.toThrow(/Raise that run again unchanged/);
    await expect(r.payroll.createRunFromRoster(r.account, PERIOD, r.viewingKey))
      .rejects.toThrow(/raise a retry on it for them/);
  });

  it('2 - the ad hoc door will not draw the same people up again, and names the run to name back',
    async () => {
      const r = await aRaiseThatThrewAfterTheNetworkHadIt();
      const specs = r.payroll.listPeople(r.account, r.viewingKey)
        .map(e => ({ name: e.name, asset: e.asset, amount: e.baseAmount }));
      /* Called exactly as the ad hoc route calls it: no roster, and no confirmation. */
      /* RED WHEN the ad hoc door does not ask whether these people are already on a run
         for this period. It is the one door that mints a fresh identifier. */
      await expect(r.payroll.createRun(r.account, PERIOD, specs, r.viewingKey))
        .rejects.toThrow(new RegExp(r.run.id));
    });

  it('2b - and a draft that reached the store some other way is refused AT THE RAISE, for as long '
    + 'as it carries the same period string', async () => {
    const r = await aRaiseThatThrewAfterTheNetworkHadIt();
    /* A run drawn for another period, moved onto this one - so no door refused it at draw. */
    const other = await r.payroll.createRunFromRoster(r.account, '2026-09', r.viewingKey);
    r.store.putRun({ ...r.store.getRun(other.run.id)!, period: PERIOD });
    await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));

    /*
     * RED WHEN raising a run does not ask whether another run for the period has already
     * been raised over any of its people.
     *
     * **AND IT IS THE PERIOD STRING THAT SCOPES IT, WHICH IS A REAL BOUND AND NOT A
     * DETAIL.** This guard, and both draw-time guards above, select the runs they compare
     * against by string equality on the period. Two runs whose periods are spelled
     * differently are two payrolls to all three of them, and this file does not pin
     * anything about that case.
     */
    await expect(r.payroll.proposeRun(
      other.run.id, r.viewingKey, r.by, await r.materialFor(other.run.id)))
      .rejects.toThrow(new RegExp(`run ${r.run.id} has already been raised for ${PERIOD}`));
    /* RED WHEN the refusal leaves a second round open anyway. */
    expect(await r.openRounds()).toBe(1);
  });

  it('3 - raising the SAME LEG again reuses the identity: byte-identical leaves, one round, one fee',
    async () => {
      const r = await aRaiseThatThrewAfterTheNetworkHadIt();
      const [written] = r.roundsOf(r.run.id);

      /*
       * **THE ACCOUNT MOVES ON WHILE THE PERSON IS DECIDING WHAT TO DO, AND THAT IS
       * WHAT MAKES THE ASSERTIONS BELOW CAPABLE OF FAILING AT ALL.** A signer is
       * removed, so the account's payout seed rotates and a new generation becomes
       * the current one. Everything that composes a run's identity from whatever is
       * live NOW therefore composes a DIFFERENT one from the recorded one - which
       * derives different leaves, which are different payments. Without a mover here
       * both the recorded value and a recomposed one are identical and neither
       * assertion can tell a reused identity from a rebuilt one.
       */
      const rotated = await r.accounts.rotate(r.account, r.viewingKey);
      const again = await r.materialFor(r.run.id, rotated.viewingKey);

      /* RED WHEN the identity is composed from what is live now rather than read off
         the leg's own record. */
      expect(again.identity).toEqual(r.first.identity);
      /* RED WHEN material for a raise again is built under anything but the recorded
         identity. This is the assertion the whole file exists for. */
      expect(again.leaves).toEqual(r.first.leaves);

      const raised = await r.payroll.proposeRun(r.run.id, rotated.viewingKey, r.by, again);
      /* RED WHEN a raise again mints a second round rather than re-raising the one written down. */
      expect(raised.id).toBe(written!.id);
      expect(await r.openRounds()).toBe(1);
      /* RED WHEN the chain is asked to open a round it is already holding. */
      expect(r.control.raises).toBe(1);
    });

  it('4 - a RETRY reuses the identity too: the leg\'s own leaves for the people it pays', async () => {
    const r = await aRaiseThatThrewAfterTheNetworkHadIt();
    await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));

    /* THE MOVER, FOR THE REASON THE RAISE-AGAIN CASE ABOVE NEEDS ONE: without it an
       identity RECOMPOSED from what is live now is byte-identical to the recorded one,
       and nothing below could tell a value that was read back from one that was rebuilt. */
    const rotated = await r.accounts.rotate(r.account, r.viewingKey);
    const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, rotated.viewingKey))!;
    /* RED WHEN the record stops carrying the identity a failed leg was raised under, so
       that there is nothing to reuse and a retry has to compose one. */
    expect(rebuild.identity).toEqual(r.first.identity);

    const retry = await retryMaterialFor({
      rebuild, indices: [0, 2], opensAt: OPENS, closesAt: CLOSES + 7_200n,
      vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
    });
    /* RED WHEN a retry derives its own leaves instead of carrying the leg's for those people. */
    expect(retry.leaves).toEqual([r.first.leaves[0], r.first.leaves[2]]);
    expect(retry.originalIndices).toEqual([0, 2]);
  });

  it('5 - and material built under any other identity is refused at BOTH doors, with the reason',
    async () => {
      const r = await aRaiseThatThrewAfterTheNetworkHadIt();
      const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, r.viewingKey))!;
      const foreign = { ...rebuild.identity, runId: 'run_startedagainbyhand:GBP' };

      const mintedLeg = await runMaterialFor({
        accountId: foreign.accountId, runId: foreign.runId, seeds: rebuild.seeds,
        facts: rebuild.facts, epoch: foreign.epoch, opensAt: OPENS, closesAt: CLOSES,
        vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
      });
      /* The control: this is not a relabelling of the same payments. */
      expect(mintedLeg.leaves[0]).not.toBe(r.first.leaves[0]);
      /* RED WHEN the raise door stops comparing the material's identity with the leg's own. */
      await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, mintedLeg))
        .rejects.toThrow(/run_startedagainbyhand:GBP/);

      await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
      const mintedRetry = await retryMaterialFor({
        rebuild: { ...rebuild, identity: foreign }, indices: [1],
        opensAt: OPENS, closesAt: CLOSES + 7_200n,
        vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
      });
      expect(mintedRetry.leaves[0]).not.toBe(r.first.leaves[1]);
      /* RED WHEN the retry door stops comparing them. */
      await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, mintedRetry))
        .rejects.toThrow(/run_startedagainbyhand:GBP/);
    });
});

describe('against the compiled circuits: what the chain refuses, and what it does not', () => {
  it('refuses a second payment to a person the leg already paid, BECAUSE the bytes are the same - '
    + 'and does not refuse one derived under a minted identifier', async () => {
    const r = await aCompanyWithADraftedRun(3);
    const first = await r.materialFor(r.run.id);
    const leg = await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, first);
    const legChange = changeOf(leg.sealedPayload, r.viewingKey);

    const sim = await AccountSimulator.create(privateStateFor(9));
    await sim.seatLeaf(
      fromHex(r.created.account.signers[0]!.leafCommitment!), [privateStateFor(9)], 61);
    sim.at(NOW);
    const legDevice = deviceCarrying(r.created.secrets[0]!, legChange);
    await sim.as(legDevice).proposeRun({
      root: fromHex(first.run.root), payees: first.run.payees,
      from: OPENS, until: CLOSES, vault: PAYROLL_VAULT,
    });
    const legId = fromHex(leg.chainId);
    await sim.as(legDevice).approve(legId);

    /* The same mover as above: the account's seed generation moves on between the raise and
       the payment, so a rebuild that reads the record and one that recomposes from what is
       live now derive DIFFERENT leaves, and the assertions below can tell them apart. */
    const rotated = await r.accounts.rotate(r.account, r.viewingKey);
    const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, rotated.viewingKey))!;
    /* Rebuilt from the record the way a paying device rebuilds it, on another machine. */
    const whole = buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails);
    const payUnderTheLeg = (at: number) => {
      const args = whole.payeeArgs(at);
      return sim.as(legDevice).recordPayment({
        proposal: legId, vault: PAYROLL_VAULT, root: fromHex(first.run.root),
        payees: first.run.payees, from: OPENS, until: CLOSES,
        salt: fromHex(legChange.salt), details: fromHex(args.details),
        nonce: fromHex(args.nonce), path: args.path,
      });
    };

    await payUnderTheLeg(0);
    /* RED WHEN the account stops recording a completed payment, or records it under
       something other than the leaf the payment derived. */
    expect(sim.ledger.movements.member(
      pureCircuits.paidMovementOf(fromHex(first.leaves[0]!)))).toBe(true);
    /* The chain's own refusal, and the hinge every restart rule above leans on: it is
       keyed on the leaf ALONE, so it can only see a second payment whose bytes match.
       Its control is the assertion below, which shows what it cannot see. */
    await expect(payUnderTheLeg(0)).rejects.toThrow(/already been made/i);

    /* AND THE OTHER HALF, SO NEITHER IS TAKEN ON TRUST: the same person, the same amount,
       derived under a minted identifier, is a movement the account has never seen - so
       nothing above refuses it, and that is why the product must. */
    const minted = await runMaterialFor({
      accountId: rebuild.identity.accountId, runId: 'run_startedagainbyhand:GBP',
      seeds: rebuild.seeds, facts: rebuild.facts, epoch: rebuild.identity.epoch,
      opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
    });
    /* RED WHEN a minted identifier derives the leaf the leg already paid, which would make
       every refusal in this file unnecessary. */
    expect(sim.ledger.movements.member(
      pureCircuits.paidMovementOf(fromHex(minted.leaves[0]!)))).toBe(false);
  });
});
