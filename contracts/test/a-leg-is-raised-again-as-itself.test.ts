/**
 * **A RAISE THAT FAILED IS TRIED AGAIN AS THE SAME ROUND, AND NEVER AS A NEW RUN.**
 *
 * Raising a leg of a payroll run writes the round down, then calls the chain.
 * The call can throw after the network already has the transaction, and from
 * that moment nothing local knows whether the round is open. Two ways of trying
 * again were open to a person holding that error, and both were wrong:
 *
 *   - **drawing the payroll up again.** The roster door refused a second run
 *     for a period only when the first was past `draft` - and a run whose raise
 *     threw is still `draft`. A new run is a new run id, so everybody on it gets
 *     new payment secrets and new leaves, and if the first round landed both
 *     can be approved and paid: everybody is paid twice.
 *   - **raising the same run again.** Its leaves are the same, so nobody can be
 *     paid twice - but a fresh salt made it a second round with a second id, so
 *     there were two open rounds over the same people, approvals split between
 *     them, and two fees.
 *
 * **WHAT THIS FILE HOLDS THE PRODUCT TO:** the roster door refuses a draft a
 * round has been raised for; a leg raised again reuses the round already written
 * down, asks the chain first, and so can never open a second round; a request
 * that describes a different round is refused without disturbing the record of
 * the earlier one; a chain that will not answer is not guessed about; and a
 * repeat nobody confirmed is not raised.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from '../../src/core/account.js';
import { PayrollService } from '../../src/core/payroll.js';
import {
  SimulatedLedger, SimulatedProofSystem, type StateChange,
} from '../../src/core/ledger.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { runMaterialFor, retryMaterialFor } from '../../src/midnight/run-material.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../../src/testing/assets.js';
import { FileStore } from '../../src/core/store-file.js';
import { toHex, unseal, parseCanonical, sign, type Hex, type Sealed } from '../../src/core/crypto.js';
import { approvalMessage } from '../../src/core/account.js';

const VAULT = toHex(new Uint8Array(32).fill(0xa1));
const NOW = Math.floor(Date.now() / 1000);
const OPENS = BigInt(NOW + 60);
const CLOSES = BigInt(NOW + 86_400);

/**
 * THIS MACHINE'S CLOCK, MOVED PAST THE LEG'S WINDOW. A retry is raised only once the leg's own
 * proposal can no longer pay anybody, which is when its window has closed. Put back after each test.
 */
const afterTheLegsWindow = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime((Number(CLOSES) + 60) * 1000);
};
afterEach(() => { vi.useRealTimers(); });

type Fault = 'none' | 'land-then-throw' | 'throw-before-sending';

/** A simulated chain whose next raise can fail on either side of the network, and whose status read can go dark. */
const services = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-again-')), 'db.json'));
  const inner = new SimulatedLedger(MidnightCommitments);
  const control = { fault: 'none' as Fault, dark: false, raises: 0 };
  const ledger = new Proxy(inner, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop === 'proposeRun') {
        return async (...args: unknown[]) => {
          const fault = control.fault;
          control.fault = 'none';
          if (fault === 'throw-before-sending') throw new Error('the socket closed before sending');
          control.raises++;
          const raised = await value.apply(target, args);
          if (fault === 'land-then-throw') throw new Error('the socket closed after sending');
          return raised;
        };
      }
      if (prop === 'status' && control.dark) return async () => null;
      /*
       * A DOUBLE, NAMED: the simulated ledger records no payments and answers that it cannot say who
       * was paid, and a retry is refused until that can be said. Here it answers that nobody was.
       */
      if (prop === 'paidAmong') return async () => ({ known: true, paid: [] });
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  return { store, accounts, payroll, inner, control };
};

async function aDraftedRun(people = 2) {
  const s = services();
  const created = await s.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;
  for (let i = 0; i < people; i++) {
    s.payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const { run } = await s.payroll.createRunFromRoster(created.account.id, '2026-10', viewingKey);
  const materialFor = async (runId: string, closesAt = CLOSES) => {
    const i = await s.payroll.runMaterialInputs(runId, viewingKey);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt: OPENS, closesAt, vault: VAULT, detailsOf: vaultDetails,
    });
  };
  const by = created.secrets[0]!.signerId;
  const account = created.account.id;
  const openRounds = async () => (await s.inner.status(account))!.openProposals.length;
  const roundsOf = (runId: string) =>
    s.accounts.payrollRoundsOf(account, viewingKey).filter(r => r.runId === runId);
  return { ...s, created, viewingKey, run, materialFor, by, account, openRounds, roundsOf };
}

const saltOf = (sealedPayload: Sealed, viewingKey: Hex) =>
  parseCanonical<{ __change: StateChange }>(unseal(sealedPayload, viewingKey)).__change.salt;

describe('a raise that threw after the network had it', () => {
  it('leaves a draft the roster door will not draw up again', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'land-then-throw';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow(/after sending/);
    /* The state that made this reachable: still a draft, and the chain holds its round. */
    expect(r.payroll.requireRun(r.run.id, r.viewingKey).status).toBe('draft');
    expect(await r.openRounds()).toBe(1);

    /* RED WHEN the roster door reads a draft's status and not the rounds raised for it. */
    await expect(r.payroll.createRunFromRoster(r.account, '2026-10', r.viewingKey))
      .rejects.toThrow(/a round has been raised for it: .*Raise that run again unchanged/s);
    /* RED WHEN the refusal is only an accident of the check that follows it. */
    await expect(r.payroll.createRunFromRoster(r.account, '2026-10', r.viewingKey))
      .rejects.toThrow(/not the same as it not being there/);
  });

  it('is raised again as the SAME round: no fee, no second round, and the run is told which', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'land-then-throw';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow();
    const [written] = r.roundsOf(r.run.id);
    expect(written!.raisedAt).toBeUndefined();

    const again = await r.payroll.proposeRun(
      r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));

    /* RED WHEN a raise again mints a new record, and so a new salt and a new round. */
    expect(again.id).toBe(written!.id);
    expect(await r.openRounds()).toBe(1);
    /* RED WHEN the chain is asked to raise a round it already holds. */
    expect(r.control.raises).toBe(1);
    const run = r.payroll.requireRun(r.run.id, r.viewingKey);
    /* RED WHEN the run is not told which round its leg is. */
    expect(run.proposalIds.GBP).toBe(written!.id);
    expect(run.status).toBe('proposed');
  });

  it('when the first attempt never reached the chain, raises it again under the same salt and id', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'throw-before-sending';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow(/before sending/);
    const earlier = r.accounts.requireProposal(r.roundsOf(r.run.id)[0]!.id, r.viewingKey);
    expect(await r.openRounds()).toBe(0);

    const again = await r.payroll.proposeRun(
      r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
    /* RED WHEN the salt of the round already written down is not the one raised. */
    expect(saltOf(again.sealedPayload, r.viewingKey)).toBe(saltOf(earlier.sealedPayload, r.viewingKey));
    expect(again.chainId).toBe(earlier.chainId);
    expect(await r.openRounds()).toBe(1);
    expect(r.roundsOf(r.run.id)).toHaveLength(1);
  });

  it('refuses a request that would be a different round, and leaves the earlier one\'s record exactly as it was',
    async () => {
      const r = await aDraftedRun();
      r.control.fault = 'land-then-throw';
      await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
        .rejects.toThrow();
      const before = r.payroll.requireRun(r.run.id, r.viewingKey).payout!.GBP!;

      const later = await r.materialFor(r.run.id, CLOSES + 3_600n);
      /* RED WHEN the refusal does not say which window and vault the earlier round took. */
      await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, later))
        .rejects.toThrow(new RegExp(`raised with the window ${OPENS} to ${CLOSES} at vault ${VAULT}`));

      /* The same window and vault over other leaves: the people in another order. */
      const inputs = await r.payroll.runMaterialInputs(r.run.id, r.viewingKey);
      const reordered = await runMaterialFor({
        accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds,
        facts: [...inputs.facts].reverse(), opensAt: OPENS, closesAt: CLOSES, vault: VAULT,
        detailsOf: vaultDetails, epoch: inputs.epoch,
      });
      /* RED WHEN a raise again is not compared with the round already written down. */
      await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, reordered))
        .rejects.toThrow(/over a different payout root, window or vault/);
      /* RED WHEN the refused request overwrites what the earlier attempt was over. */
      expect(r.payroll.requireRun(r.run.id, r.viewingKey).payout!.GBP!).toEqual(before);
      expect(r.roundsOf(r.run.id)).toHaveLength(1);
      expect(await r.openRounds()).toBe(1);
    });

  it('an earlier round that was since approved is recorded against the run, and not raised again', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'land-then-throw';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow();
    const [written] = r.roundsOf(r.run.id);
    const round = r.accounts.requireProposal(written!.id, r.viewingKey);
    const approved = await r.accounts.approve(round.id, r.by,
      sign(approvalMessage(round), r.created.secrets[0]!.signingSecret), r.viewingKey);
    expect(approved.status).toBe('approved');

    /* RED WHEN only an OPEN round is treated as one that may be on chain. */
    const again = await r.payroll.proposeRun(
      r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
    expect(again.id).toBe(written!.id);
    expect(r.control.raises).toBe(1);
    expect(r.payroll.requireRun(r.run.id, r.viewingKey).proposalIds.GBP).toBe(written!.id);
  });

  it('is raised again from what it was raised over, after the roster has moved on', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'land-then-throw';
    const first = await r.materialFor(r.run.id);
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, first)).rejects.toThrow();
    const [written] = r.roundsOf(r.run.id);

    r.payroll.setStatus(r.run.employees[0]!.id, 'leaver', r.viewingKey);
    /* RED WHEN the material for a raise again is read off the roster instead of the run's record. */
    const again = await r.materialFor(r.run.id);
    expect(again.leaves).toEqual(first.leaves);
    const raised = await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, again);
    expect(raised.id).toBe(written!.id);
    expect(r.control.raises).toBe(1);
  });

  it('is raised again under the seed generation it was raised under, after a rotation', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'land-then-throw';
    const first = await r.materialFor(r.run.id);
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, first)).rejects.toThrow();
    const [written] = r.roundsOf(r.run.id);

    const rotated = await r.accounts.rotate(r.account, r.viewingKey);
    const inputs = await r.payroll.runMaterialInputs(r.run.id, rotated.viewingKey);
    expect(inputs.seeds).toHaveLength(2);
    const again = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
      opensAt: OPENS, closesAt: CLOSES, vault: VAULT, detailsOf: vaultDetails, epoch: inputs.epoch,
    });
    /* RED WHEN material for a raise again is built under the current seed generation. */
    expect(again.leaves).toEqual(first.leaves);
    const raised = await r.payroll.proposeRun(r.run.id, rotated.viewingKey, r.by, again);
    expect(raised.id).toBe(written!.id);
    expect(r.control.raises).toBe(1);
  });

  it('a leg on chain is raised again from its record after a payee became a leaver, and the order check takes the record', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'land-then-throw';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow();
    const [written] = r.roundsOf(r.run.id);
    /* The roster can no longer pay this person; the proposal already on chain still names them. */
    r.payroll.setStatus(r.run.employees[0]!.id, 'leaver', r.viewingKey);
    /*
     * RED WHEN the check that each payment is its own person's accepts only the
     * roster as it is now: the raise again of a round already on chain is then
     * refused for a person the proposal was approved to pay.
     */
    const raised = await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
    expect(raised.id).toBe(written!.id);
  });

  it('a leg whose first raise never reached the chain is built from the roster again, so a leaver is refused', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'throw-before-sending';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow(/before sending/);
    r.payroll.setStatus(r.run.employees[0]!.id, 'leaver', r.viewingKey);
    /* RED WHEN a round the chain does not hold is raised from the record, past the roster's refusal. */
    await expect(r.materialFor(r.run.id)).rejects.toThrow(/is leaver, not active/);
  });

  it('a raise that never landed and whose window closed is withdrawn and raised afresh, and each refusal says so',
    async () => {
      const r = await aDraftedRun();
      const soon = BigInt(NOW + 120);
      r.control.fault = 'throw-before-sending';
      await expect(r.payroll.proposeRun(
        r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id, soon))).rejects.toThrow(/before sending/);
      const [written] = r.roundsOf(r.run.id);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime((NOW + 600) * 1000);
      try {
        /* RED WHEN the closed-window refusal does not say to withdraw the attempt. */
        await expect(r.payroll.proposeRun(
          r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id, soon)))
          .rejects.toThrow(/window closed .*Withdraw that attempt/s);
        const later = await r.materialFor(r.run.id, BigInt(NOW + 90_000));
        /* RED WHEN the different-window refusal does not say to withdraw the round first. */
        await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, later))
          .rejects.toThrow(/withdraw that round first/);

        await r.accounts.cancel(written!.id, r.viewingKey);
        const raised = await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, later);
        expect(raised.id).not.toBe(written!.id);
        expect(await r.openRounds()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

  it('refuses to raise again when the chain will not say whether the first attempt is there', async () => {
    const r = await aDraftedRun();
    r.control.fault = 'land-then-throw';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow();
    r.control.dark = true;
    /* RED WHEN an unanswered question is treated as a round that is not there. */
    await expect(r.payroll.proposeRun(
      r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id)))
      .rejects.toThrow(/did not answer/);
    expect(r.control.raises).toBe(1);
  });

  it('refuses to choose between two rounds written down for one leg', async () => {
    const r = await aDraftedRun(1);
    const material = await r.materialFor(r.run.id);
    for (let i = 0; i < 2; i++) {
      r.control.fault = 'throw-before-sending';
      await r.accounts.proposeRun({
        accountId: r.account, viewingKey: r.viewingKey, summary: 'Payroll 2026-10, 1 recipients',
        /* Entries that add up to the payments, or the raise is refused before anything is written down. */
        payload: { runId: r.run.id, entries: material.facts.map((f, i) => ({
          id: `ent_${i}`, kind: 'payroll', asset: 'GBP', amount: f.amount,
          counterparty: `person ${i}`, memo: '', at: '',
        })) }, asset: 'GBP', run: material.run,
        payments: material.facts, proposedBy: r.by,
      }).catch(() => undefined);
    }
    expect(r.roundsOf(r.run.id)).toHaveLength(2);
    /* RED WHEN the door picks one of several possibly-open rounds by itself. */
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, material))
      .rejects.toThrow(/written down as 2 rounds/);
  });

  it('a retry whose raise threw is raised again as the same round too', async () => {
    const r = await aDraftedRun(2);
    await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
    const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, r.viewingKey))!;
    const retry = await retryMaterialFor({
      rebuild, indices: [1], opensAt: OPENS, closesAt: CLOSES + 7_200n, vault: VAULT,
      detailsOf: vaultDetails,
    });
    afterTheLegsWindow();
    r.control.fault = 'land-then-throw';
    await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry)).rejects.toThrow(/socket closed after sending/);
    const written = r.roundsOf(r.run.id).filter(x => x.retry);
    expect(written).toHaveLength(1);
    /* RED WHEN an attempt whose raise never returned is counted as one that can still pay somebody. */
    expect(r.payroll.payoutMaterialOf(r.run.id, r.viewingKey)!.retries).toBeUndefined();

    const again = await r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry);
    /* RED WHEN a retry raised again mints a second round. */
    expect(again.id).toBe(written[0]!.id);
    expect(await r.openRounds()).toBe(2);
    const retries = r.payroll.requireRun(r.run.id, r.viewingKey).payout!.GBP!.retries!;
    /* RED WHEN a retry raised again is written onto the leg a second time. */
    expect(retries).toHaveLength(1);
    expect(retries[0]!.proposalId).toBe(written[0]!.id);
  });
});

describe('a run is not raised over people another run for the period was raised to pay', () => {
  it('refuses the second of two drafts over overlapping people once the first is raised', async () => {
    const r = await aDraftedRun(2);
    r.payroll.hireDirect(r.account, {
      name: 'Payee 2', email: 'p2@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, r.viewingKey);
    /* A second draft over the whole roster, which now has one more person. */
    const wider = await r.payroll.createRunFromRoster(r.account, '2026-10', r.viewingKey);
    await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));

    /* RED WHEN raising a run looks only for runs that pay exactly the same payroll. */
    await expect(r.payroll.proposeRun(
      wider.run.id, r.viewingKey, r.by, await r.materialFor(wider.run.id)))
      .rejects.toThrow(new RegExp(`run ${r.run.id} has already been raised for 2026-10 to pay some of the same people`));
    expect(await r.openRounds()).toBe(1);

    /* The same people for another period are another payroll. */
    const next = await r.payroll.createRunFromRoster(r.account, '2026-11', r.viewingKey);
    /* RED WHEN runs for other periods are counted as raised over the same payroll. */
    await r.payroll.proposeRun(next.run.id, r.viewingKey, r.by, await r.materialFor(next.run.id));
  });

  it('refuses a retry on a withdrawn run once another run has been raised over its people', async () => {
    const r = await aDraftedRun(2);
    r.payroll.hireDirect(r.account, {
      name: 'Payee 2', email: 'p2@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, r.viewingKey);
    const wider = await r.payroll.createRunFromRoster(r.account, '2026-10', r.viewingKey);
    const raised = await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
    await r.accounts.cancel(raised.id, r.viewingKey);
    await r.payroll.proposeRun(wider.run.id, r.viewingKey, r.by, await r.materialFor(wider.run.id));

    const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, r.viewingKey))!;
    const retry = await retryMaterialFor({
      rebuild, indices: [0, 1], opensAt: OPENS, closesAt: CLOSES, vault: VAULT, detailsOf: vaultDetails,
    });
    /* RED WHEN a retry is raised without asking whether another run was raised over its people. */
    await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry))
      .rejects.toThrow(new RegExp(`run ${wider.run.id} has already been raised for 2026-10`));
    expect(await r.openRounds()).toBe(1);
  });

  it('lets a run be raised once the round of the run it overlapped is withdrawn', async () => {
    const r = await aDraftedRun(1);
    const second = await r.payroll.createRunFromRoster(r.account, '2026-10', r.viewingKey);
    const raised = await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
    await r.accounts.cancel(raised.id, r.viewingKey);
    /* RED WHEN a withdrawn round still counts as one that may pay these people. */
    await r.payroll.proposeRun(second.run.id, r.viewingKey, r.by, await r.materialFor(second.run.id));
  });

  it('raises a confirmed repeat beside the run it repeats, and refuses one nobody confirmed', async () => {
    const aConfirmedPair = async () => {
      const r = await aDraftedRun(1);
      const people = r.payroll.listPeople(r.account, r.viewingKey);
      const confirmed = await r.payroll.createRun(
        r.account, '2026-10', people.map(e => ({ name: e.name, asset: e.asset, amount: e.baseAmount })),
        r.viewingKey, people, undefined,
        { runIds: [r.run.id], reason: 'a second payment, agreed', by: 'Ada' });
      /* RED WHEN a confirmation handed to the roster's own draw is not written down. */
      expect(confirmed.run.repeats?.of).toEqual([r.run.id]);
      return { r, confirmed };
    };
    {
      const { r, confirmed } = await aConfirmedPair();
      await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
      /* RED WHEN the raise does not read the run's own confirmation back. */
      await r.payroll.proposeRun(
        confirmed.run.id, r.viewingKey, r.by, await r.materialFor(confirmed.run.id));
      expect(await r.openRounds()).toBe(2);
    }
    {
      const { r, confirmed } = await aConfirmedPair();
      await r.payroll.proposeRun(
        confirmed.run.id, r.viewingKey, r.by, await r.materialFor(confirmed.run.id));
      /* RED WHEN the confirmation on the OTHER run of the pair is not read. */
      await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor(r.run.id));
      expect(await r.openRounds()).toBe(2);
    }

    /* A repeat that reached the store without a confirmation: a run moved onto the period. */
    const r2 = await aDraftedRun(1);
    const other = await r2.payroll.createRunFromRoster(r2.account, '2026-11', r2.viewingKey);
    r2.store.putRun({ ...r2.store.getRun(other.run.id)!, period: '2026-10' });
    await r2.payroll.proposeRun(r2.run.id, r2.viewingKey, r2.by, await r2.materialFor(r2.run.id));
    /* RED WHEN a run with no confirmation is raised over people another run was raised to pay. */
    await expect(r2.payroll.proposeRun(
      other.run.id, r2.viewingKey, r2.by, await r2.materialFor(other.run.id)))
      .rejects.toThrow(/already been raised for 2026-10 to pay some of the same people/);
  });

  it('a round withdrawn while it was still on its way takes no approvals when it arrives', async () => {
    const s = await aDraftedRun(1);
    /* The raise leaves the machine and has not landed when the answer is lost. */
    let inFlight: unknown[] | undefined;
    const real = (s.inner as any).proposeRun.bind(s.inner);
    (s.inner as any).proposeRun = async (...args: unknown[]) => { inFlight = args; throw new Error('the socket closed with the transaction in flight'); };
    await expect(s.payroll.proposeRun(s.run.id, s.viewingKey, s.by, await s.materialFor(s.run.id)))
      .rejects.toThrow(/in flight/);
    (s.inner as any).proposeRun = real;
    const [written] = s.roundsOf(s.run.id);

    /* Withdrawn on the chain's word that it is not there - and then it lands. */
    await s.accounts.cancel(written!.id, s.viewingKey);
    await real(...inFlight!);
    expect(await s.openRounds()).toBe(1);

    const round = s.accounts.requireProposal(written!.id, s.viewingKey);
    /* RED WHEN a withdrawn round can still collect approvals. */
    await expect(s.accounts.approve(round.id, s.by,
      sign(approvalMessage(round), s.created.secrets[0]!.signingSecret), s.viewingKey))
      .rejects.toThrow(/withdrawn, so it takes no approvals/);
  });
});
