/**
 * **WHAT THE SERVICE HANDS THE CHAIN SO IT CAN SAY WHO WAS PAID FOR WHICH
 * MONTH.** Each payment's nonce is derived from the company's pay-record key and
 * the person, the month, the kind of pay and the occurrence; the account
 * records a value made from it and refuses a second. This file holds the
 * service to the four things that makes true:
 *
 *   - the key is generated once and kept when a signer leaves
 *   - a raise carries this run's people, month and kind, and nothing else
 *   - a real second payment is a numbered extra, confirmed, and numbered past
 *     every earlier one
 *   - nobody on the roster is left out of a run without the record saying so
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from './account.js';
import { PayrollService } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor, retryMaterialFor } from '../midnight/run-material.js';
import { payRecordNonceOf } from '../midnight/run-keys.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { FileStore } from './store-file.js';
import { toHex } from './crypto.js';
import type { RosterEmployee } from './types.js';

const PAYROLL_VAULT = toHex(new Uint8Array(32).fill(0xa1));
const NOW = Math.floor(Date.now() / 1000);
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const SEPTEMBER = '2026-09';

afterEach(() => { vi.useRealTimers(); });

async function aCompany(people = 3) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s215-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
  const ledger = new SimulatedLedger(MidnightCommitments);
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const account = created.account.id;
  let viewingKey = created.viewingKey;
  const hired: RosterEmployee[] = [];
  for (let i = 0; i < people; i++) {
    hired.push(payroll.hireDirect(account, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey).employee);
  }
  const by = created.secrets[0]!.signerId;
  const inputs = (runId: string) => payroll.runMaterialInputs(runId, viewingKey);
  const materialFrom = (i: Awaited<ReturnType<typeof inputs>>) => runMaterialFor({
    accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts, pay: i.pay, asset: i.asset,
    opensAt: OPENS, closesAt: CLOSES, vault: PAYROLL_VAULT, detailsOf: vaultDetails,
  });
  const raise = async (runId: string) => payroll.proposeRun(runId, viewingKey, by, await materialFrom(await inputs(runId)));
  return {
    store, ledger, accounts, payroll, account, hired, by, inputs, materialFrom, raise,
    get viewingKey() { return viewingKey; },
    set viewingKey(v) { viewingKey = v; },
  };
}

describe('the pay-record key', () => {
  it('is generated with the company and KEPT when the viewing key rotates, so a month paid before a removal stays paid after it', async () => {
    const c = await aCompany(1);
    const key = await c.accounts.payRecordKeyOf(c.account, c.viewingKey);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const seedsBefore = await c.accounts.payoutSeedsOf(c.account, c.viewingKey);
    const rotated = await c.accounts.rotate(c.account, c.viewingKey);
    /* RED WHEN a rotation regenerates the key: every month already paid would get a new nonce. */
    expect(await c.accounts.payRecordKeyOf(c.account, rotated.viewingKey)).toBe(key);
    /* Its control: the payout seed IS appended at the same rotation. */
    expect((await c.accounts.payoutSeedsOf(c.account, rotated.viewingKey)).length).toBe(seedsBefore.length + 1);
  });

  it('is two companies\' own: two companies never share one', async () => {
    const [a, b] = [await aCompany(1), await aCompany(1)];
    expect(await a.accounts.payRecordKeyOf(a.account, a.viewingKey))
      .not.toBe(await b.accounts.payRecordKeyOf(b.account, b.viewingKey));
  });
});

describe('what a raise says each payment is for', () => {
  it('names each person on the leg by their roster entry, the run\'s month, salary and the first payment', async () => {
    const c = await aCompany(3);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const i = await c.inputs(run.id);
    expect(i.pay.records).toEqual(c.hired.map(e => ({ person: e.id, month: SEPTEMBER, kind: 'salary', occurrence: 0 })));
    await c.raise(run.id);
    /* The leg keeps what it was raised for, and a rebuild reads it back from there. */
    const rebuild = (await c.payroll.payoutRebuildOf(run.id, c.viewingKey))!;
    expect(rebuild.pay.records).toEqual(i.pay.records);
  });

  it('REFUSES material that says it pays another occurrence, or another month, than the run does', async () => {
    const c = await aCompany(2);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const i = await c.inputs(run.id);
    for (const records of [
      i.pay.records.map((r, n) => (n === 1 ? { ...r, occurrence: 1 } : r)),
      i.pay.records.map(r => ({ ...r, month: '2026-10' })),
      i.pay.records.map(r => ({ ...r, kind: 'bonus' })),
    ]) {
      const forged = await c.materialFrom({ ...i, pay: { ...i.pay, records } });
      /* RED WHEN the raise stops comparing what the payments say they are for with the run:
         a later occurrence nobody confirmed would pay somebody a second time for the month. */
      await expect(c.payroll.proposeRun(run.id, c.viewingKey, c.by, forged))
        .rejects.toThrow(/are not this run's payments to its people for 2026-09/);
    }
    /* The control: the run's own records raise. */
    await c.raise(run.id);
  });

  it('REFUSES material whose leaves pay something its records do not say: another key, another occurrence, other leaves', async () => {
    const c = await aCompany(2);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const i = await c.inputs(run.id);
    /* Honest records over leaves built under another key. */
    const otherKey = await c.materialFrom({ ...i, pay: { ...i.pay, key: '77'.repeat(32) } });
    /* Leaves built as the second payment for the month, with the first payment's records laid over them. */
    const extra = await c.materialFrom({ ...i, pay: { ...i.pay, records: i.pay.records.map(r => ({ ...r, occurrence: 1 })) } });
    const relabelled = { ...extra, records: i.pay.records };
    /* The run's own records and payments, over another key's leaves and root. */
    const honest = await c.materialFrom(i);
    const otherLeaves = { ...honest, leaves: otherKey.leaves, run: otherKey.run };
    for (const forged of [otherKey, relabelled, otherLeaves]) {
      /* RED WHEN the raise compares only what the material declares, and not what its leaves pay. */
      await expect(c.payroll.proposeRun(run.id, c.viewingKey, c.by, forged))
        .rejects.toThrow(/are not this run's payments to its people for 2026-09/);
    }
    await c.raise(run.id);
  });
});

describe('a numbered extra: a real second payment for a month', () => {
  it('is paid to the people it names as the next occurrence, and everybody else as the first', async () => {
    const c = await aCompany(3);
    const first = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(first.run.id);
    const [ada] = c.hired;
    const second = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined, {
      runIds: [first.run.id], reason: 'a correction to September', by: 'Ada', extra: [ada!.id],
    });
    /* RED WHEN the extra is not written onto the run, or is written as the first payment. */
    expect(second.run.repeats?.extra).toEqual({ [ada!.id]: 1 });
    const i = await c.inputs(second.run.id);
    expect(i.pay.records.map(r => r.occurrence)).toEqual([1, 0, 0]);
    const key = await c.accounts.payRecordKeyOf(c.account, c.viewingKey);
    const firstNonce = payRecordNonceOf(key, { person: ada!.id, month: SEPTEMBER, kind: 'salary', occurrence: 0 });
    expect(payRecordNonceOf(key, i.pay.records[0]!)).not.toBe(firstNonce);
    expect(payRecordNonceOf(key, i.pay.records[1]!))
      .toBe(payRecordNonceOf(key, { person: c.hired[1]!.id, month: SEPTEMBER, kind: 'salary', occurrence: 0 }));
  });

  it('is numbered past every earlier extra for the month: the second extra is 2', async () => {
    const c = await aCompany(1);
    const [ada] = c.hired;
    const first = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(first.run.id);
    const second = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined, {
      runIds: [first.run.id], reason: 'a correction', by: 'Ada', extra: [ada!.id],
    });
    await c.raise(second.run.id);
    const third = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined, {
      runIds: [first.run.id, second.run.id], reason: 'a second correction', by: 'Ada', extra: [ada!.id],
    });
    /* RED WHEN the occurrence is counted from the first payment only: two extras would share a nonce. */
    expect(third.run.repeats?.extra).toEqual({ [ada!.id]: 2 });
  });

  it('is numbered within its own month: an extra for September ignores October\'s runs', async () => {
    const c = await aCompany(1);
    const [ada] = c.hired;
    const sept = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(sept.run.id);
    const oct = await c.payroll.createRunFromRoster(c.account, '2026-10', c.viewingKey);
    await c.raise(oct.run.id);
    const octExtra = await c.payroll.createRunFromRoster(c.account, '2026-10', c.viewingKey, undefined, undefined, {
      runIds: [oct.run.id], reason: 'an October correction', by: 'Ada', extra: [ada!.id],
    });
    await c.raise(octExtra.run.id);
    const septExtra = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined, {
      runIds: [sept.run.id], reason: 'a September correction', by: 'Ada', extra: [ada!.id],
    });
    /* RED WHEN the numbering counts runs for other months: the September extra would skip to 2. */
    expect(septExtra.run.repeats?.extra).toEqual({ [ada!.id]: 1 });
  });

  it('is refused without a confirmed repeat, and for somebody the run does not pay', async () => {
    const c = await aCompany(2);
    /* RED WHEN an extra is accepted on a run that repeats nothing: it is only ever a second payment. */
    await expect(c.payroll.createRun(c.account, SEPTEMBER, [{ name: 'Payee 0', asset: 'GBP', amount: 100n }],
      c.viewingKey, undefined, undefined, { runIds: [], reason: 'x', by: 'Ada', extra: ['emp_nobody'] }))
      .rejects.toThrow(/numbered extra is a second payment for 2026-09, and this run repeats no run/);
    const first = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(first.run.id);
    /* RED WHEN an extra can name somebody the run does not pay. */
    await expect(c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined, {
      runIds: [first.run.id], reason: 'a correction', by: 'Ada', extra: ['emp_nobody'],
    })).rejects.toThrow(/emp_nobody is named for a numbered extra and not on this run/);
  });
});

describe('nobody on the roster is left out without a record saying who and why', () => {
  it('REFUSES a run over some of the roster unless the rest are named, and records them as not chosen', async () => {
    const c = await aCompany(3);
    const [ada, ben, cy] = c.hired;
    /* RED WHEN choosing some people drops the rest with nothing written down. */
    await expect(c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, [ada!.id]))
      .rejects.toThrow(/Payee 1, Payee 2 are on the roster and not among the people chosen for this run/);
    await expect(c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, [ada!.id],
      { employeeIds: [ben!.id], by: 'Ada', reason: 'paid separately' }))
      .rejects.toThrow(/would also leave out Payee 2/);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, [ada!.id],
      { employeeIds: [ben!.id, cy!.id], by: 'Ada', reason: 'paid separately' });
    expect(run.employees.map(e => e.id)).toEqual([ada!.id]);
    expect(run.skips?.people).toEqual([
      { employeeId: ben!.id, name: 'Payee 1', waiting: 'not chosen' },
      { employeeId: cy!.id, name: 'Payee 2', waiting: 'not chosen' },
    ]);
  });
});

describe('a retry over somebody another payment paid for the month', () => {
  it('REFUSES them, naming them, and retries the rest', async () => {
    const c = await aCompany(3);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(run.id);
    const key = await c.accounts.payRecordKeyOf(c.account, c.viewingKey);
    const first = payRecordNonceOf(key, { person: c.hired[0]!.id, month: SEPTEMBER, kind: 'salary', occurrence: 0 });
    /* A chain that has paid nobody by these leaves, and has recorded the first person's month by another payment. */
    Object.assign(c.ledger, {
      paidAmong: async () => ({ known: true, paid: [] }),
      paidOnceAmong: async (_a: string, nonces: string[]) => ({ known: true, paid: nonces.filter(n => n === first) }),
    });
    const rebuild = (await c.payroll.payoutRebuildOf(run.id, c.viewingKey))!;
    const retryOf = (indices: number[]) => retryMaterialFor({
      rebuild, indices, opensAt: CLOSES + 60n, closesAt: CLOSES + 7_200n, vault: PAYROLL_VAULT, detailsOf: vaultDetails,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((Number(CLOSES) + 60) * 1000);
    /* RED WHEN the retry door reads only the leaves: the first person would be retried, refused on chain, and read as owed. */
    await expect(c.payroll.proposeRetry(run.id, c.viewingKey, c.by, await retryOf([0, 1])))
      .rejects.toThrow(/#1 is recorded on chain as paid for 2026-09 by another payment/);
    await c.payroll.proposeRetry(run.id, c.viewingKey, c.by, await retryOf([1, 2]));
  });
});
