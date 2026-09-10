/**
 * **A RUN THAT PAYS THE SAME PEOPLE THE SAME AMOUNTS FOR THE SAME PERIOD AS
 * ANOTHER IS REFUSED UNLESS SOMEBODY NAMES WHAT IT REPEATS AND SAYS WHY.**
 *
 * Every run derives its own payment secrets from its own id, so two runs over
 * the same people are, to the account, two unrelated sets of payments, and both
 * can be paid. For a bonus that is right. For a person whose first run failed
 * and who does not know whether it reached the chain, it is everybody paid
 * twice. So the door refuses a repeat by default, names the runs it repeats and
 * the ways to try again that pay nobody twice, and lets a person through only by
 * naming that same set of runs back, with a reason, under their own name - which
 * is written onto the run, inside its sealed envelope.
 *
 * **WHAT IT MUST NOT DO IS REFUSE A DIFFERENT PAYMENT.** Different amounts, or a
 * different period, are not a repeat and pass without being asked anything.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import { PayrollService } from './payroll.js';

function harness() {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-repeat-')), 'db.json'));
  const accounts = new AccountService(
    store, new SimulatedLedger(SimulatedCommitments), SimulatedCommitments);
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem());
  return { store, accounts, payroll };
}

async function aCompany() {
  const h = harness();
  const created = await h.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  return { ...h, account: created.account.id, viewingKey: created.viewingKey };
}

const TWO = [
  { name: 'Bea', asset: 'GBP', amount: 250_00n },
  { name: 'Cal', asset: 'GBP', amount: 300_00n },
];

describe('the ad hoc run door refuses a repeat', () => {
  it('refuses a run that repeats another, naming it and the ways to try again that pay nobody twice',
    async () => {
      const c = await aCompany();
      const first = await c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey);
      /* In a different order, which is the same payroll. */
      const attempt = c.payroll.createRun(c.account, '2026-09', [TWO[1]!, TWO[0]!], c.viewingKey);
      /* RED WHEN the door does not look for an earlier run paying the same people the same amounts. */
      await expect(attempt).rejects.toThrow(new RegExp(`as run ${first.run.id} \\(drawn up, not raised\\)`));
      /* RED WHEN the refusal stops naming the ways to try again that cannot pay twice. */
      await expect(c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey))
        .rejects.toThrow(/raise that run again unchanged.*raise a retry on it/is);
      /* RED WHEN the refusal does not say how a real second payment gets through. */
      await expect(c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey))
        .rejects.toThrow(new RegExp(`confirm it by naming ${first.run.id} back with a reason`));
      expect(c.store.listRuns(c.account)).toHaveLength(1);
    });

  it('lets a different payment through without asking: other amounts, other people, another period',
    async () => {
      const c = await aCompany();
      await c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey);
      /* RED WHEN amounts are not part of what makes a repeat. */
      await c.payroll.createRun(c.account, '2026-09',
        [TWO[0]!, { ...TWO[1]!, amount: 301_00n }], c.viewingKey);
      /* RED WHEN the refusal is on the period alone. */
      await c.payroll.createRun(c.account, '2026-09', [TWO[0]!], c.viewingKey);
      /* RED WHEN the period is not part of what makes a repeat. */
      await c.payroll.createRun(c.account, '2026-10', TWO, c.viewingKey);
      expect(c.store.listRuns(c.account)).toHaveLength(4);
    });

  it('lets a confirmed repeat through and writes down who confirmed it, why, and what it repeats, sealed',
    async () => {
      const c = await aCompany();
      const first = await c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey);
      const second = await c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey,
        undefined, undefined,
        { runIds: [first.run.id], reason: 'September bonus, same as salary', by: 'Ada' });

      const opened = c.payroll.requireRun(second.run.id, c.viewingKey);
      /* RED WHEN the confirmation is not recorded on the run. */
      expect(opened.repeats).toEqual({
        of: [first.run.id], reason: 'September bonus, same as salary', by: 'Ada',
        at: expect.any(String),
      });
      /* RED WHEN the record is written where the store can read it. */
      expect(JSON.stringify(c.store.getRun(second.run.id))).not.toContain('September bonus');
      /* A run that repeats nothing carries no record at all. */
      expect(c.payroll.requireRun(first.run.id, c.viewingKey).repeats).toBeUndefined();
    });

  it('compares the confirmation with what the run repeats, in both directions', async () => {
    const c = await aCompany();
    const a = await c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey);
    const b = await c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey,
      undefined, undefined, { runIds: [a.run.id], reason: 'second', by: 'Ada' });

    /* RED WHEN a run the person did not name is covered by their confirmation anyway. */
    await expect(c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey,
      undefined, undefined, { runIds: [a.run.id], reason: 'third', by: 'Ada' }))
      .rejects.toThrow(new RegExp(`also repeats run ${b.run.id}`));

    const other = await c.payroll.createRun(c.account, '2026-10', TWO, c.viewingKey);
    /* RED WHEN a confirmation naming a run this one does not repeat is accepted. */
    await expect(c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey,
      undefined, undefined, { runIds: [a.run.id, b.run.id, other.run.id], reason: 'third', by: 'Ada' }))
      .rejects.toThrow(/is not the list this run would act on/);

    /* RED WHEN a stale confirmation for a run that repeats nothing is accepted in silence. */
    await expect(c.payroll.createRun(c.account, '2026-12', TWO, c.viewingKey,
      undefined, undefined, { runIds: [a.run.id], reason: 'stale', by: 'Ada' }))
      .rejects.toThrow(/this run does not repeat it/);
  });

  it('refuses a confirmation with nobody\'s name or no reason on it', async () => {
    const c = await aCompany();
    const a = await c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey);
    /* RED WHEN a repeat can be confirmed by nobody. */
    await expect(c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey,
      undefined, undefined, { runIds: [a.run.id], reason: 'bonus', by: '  ' }))
      .rejects.toThrow(/attributable to somebody/);
    /* RED WHEN a repeat can be confirmed for no reason. */
    await expect(c.payroll.createRun(c.account, '2026-09', TWO, c.viewingKey,
      undefined, undefined, { runIds: [a.run.id], reason: ' ', by: 'Ada' }))
      .rejects.toThrow(/a blank reason is not a record/);
    expect(c.store.listRuns(c.account)).toHaveLength(1);
  });
});

describe('the roster door', () => {
  it('is not shut out of a period by an ad hoc run over the same names, which can never be raised', async () => {
    const c = await aCompany();
    c.payroll.hireDirect(c.account, {
      name: 'Bea', email: 'bea@a.co', title: 'Eng', asset: 'GBP', baseAmount: 250_00n,
    }, c.viewingKey);
    await c.payroll.createRun(c.account, '2026-09', [TWO[0]!], c.viewingKey);
    /* RED WHEN the roster's own draw is refused as a repeat of a run nobody can raise. */
    await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
    expect(c.store.listRuns(c.account)).toHaveLength(2);
  });
});
