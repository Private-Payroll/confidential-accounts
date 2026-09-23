/**
 * **A RETRY IS REFUSED OVER ANYONE THE RUN MARKED NOT TO BE PAID, AND ITS
 * PEOPLE ARE RELEASED WHEN THE ROUND THAT COVERED THEM CAN NO LONGER PAY.**
 *
 * What runs is the payroll service itself, with the simulated ledger under it.
 * **Two pieces are doubles, and they are named here**: the ledger's answer to
 * *who has been paid*, because the simulated ledger records no payments, and
 * this machine's clock, so a window can close without the test waiting for it.
 *
 * Each company has three people on one private leg, raised and held by the
 * chain, with a window that has closed by the time any retry is asked for.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { FileStore } = await import('../core/store-file.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { SEED_ASSETS, assets: productAssets } = await import('../core/assets.js');
const { runMaterialFor, retryMaterialFor } = await import('../midnight/run-material.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { toHex } = await import('../core/crypto.js');
type Hex = import('../core/crypto.js').Hex;
type PayrollRun = import('../core/types.js').PayrollRun;

const VAULT = toHex(new Uint8Array(32).fill(0xc5));
const PRIVATE = SEED_ASSETS.find((a) => a.ledger.shielded !== null)!;
const HELD = 1n << 100n;
const DATA = join(mkdtempSync(join(tmpdir(), 'mn-retry-cleanly-')), 'db.json');

const ledger = new SimulatedLedger(MidnightCommitments);
/* The simulated ledger records no payments, so this file says nobody has been paid. */
Object.assign(ledger, { paidAmong: async () => ({ known: true, paid: [] }) });

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });
const now = Math.floor(Date.now() / 1000);
const at = (s: number) => vi.setSystemTime((now + s) * 1000);
const LEG = { opensAt: now - 60, closesAt: now + 30 };
/* Retry windows. Each opens after the leg's has closed; the late one has not opened by the time it is withdrawn. */
const EARLY = { opensAt: now + 30, closesAt: now + 600 };
const LATER = { opensAt: now + 30, closesAt: now + 3_600 };
const UNOPENED = { opensAt: now + 5_000, closesAt: now + 9_000 };

const store = new FileStore(DATA);
const accounts = new AccountService(store, ledger, MidnightCommitments, productAssets, aVaultHolding(HELD));
const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), productAssets);

const aCompany = async (name: string) => {
  const created = await accounts.create(name, [{ name: 'Ada', role: 'admin' }], 1);
  const { viewingKey } = created;
  const account = created.account.id;
  for (let i = 0; i < 3; i++) {
    payroll.hireDirect(account, {
      name: `${name} payee ${i}`, email: `p${i}@${name.toLowerCase()}.example`, title: 'Eng', asset: PRIVATE.code,
      baseAmount: BigInt(100 + i) * 1_000_000n,
    }, viewingKey);
  }
  const { run } = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
  const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
  const seat = created.secrets[0]!;
  at(0);
  const leg = await payroll.proposeRun(run.id, viewingKey, seat.signerId, await runMaterialFor({
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
    opensAt: BigInt(LEG.opensAt), closesAt: BigInt(LEG.closesAt), vault: VAULT, detailsOf: vaultDetails,
  }));
  if (!leg.raisedAt) throw new Error(`the ${name} leg did not reach the chain`);
  at(60);
  return { account, viewingKey, runId: run.id, seat };
};
type Company = Awaited<ReturnType<typeof aCompany>>;

const aRetry = async (c: Company, indices: number[], w: { opensAt: number; closesAt: number } = LATER) =>
  payroll.proposeRetry(c.runId, c.viewingKey, c.seat.signerId, await retryMaterialFor({
    rebuild: (await payroll.payoutRebuildOf(c.runId, c.viewingKey))!, indices,
    opensAt: BigInt(w.opensAt), closesAt: BigInt(w.closesAt), vault: VAULT, detailsOf: vaultDetails,
  }));
const retriesOf = (c: Company) => payroll.requireRun(c.runId, c.viewingKey).payout![PRIVATE.code]!.retries ?? [];
const retryRoundsOf = (c: Company) =>
  accounts.payrollRoundsOf(c.account, c.viewingKey).filter((r) => r.retry !== undefined);

/**
 * **THE RUN'S RECORD OF WHO IT LEFT OUT, NAMING SOMEBODY ON THE LEG.** The
 * product writes that record only over people it could not put on the leg, so
 * this state is reached here by writing the run directly: the refusal is for
 * the day the two meet, and a direct request that names such a person.
 */
const markNotToBePaid = (c: Company, legIndex: number, over: Partial<{ proposalId: string; unskip: boolean }> = {}) => {
  const run = payroll.requireRun(c.runId, c.viewingKey) as PayrollRun;
  const person = run.employees.filter((e) => e.asset === PRIVATE.code)[legIndex]!;
  const decided = { index: 0, skip: true, by: c.seat.signerId, at: new Date().toISOString(), reason: 'left in August' };
  run.skips = {
    people: [{ employeeId: person.id, name: person.name, waiting: 'them' }],
    decisions: {
      proposalId: (over.proposalId ?? run.id) as Hex, payees: 1,
      decisions: over.unskip ? [decided, { index: 0, skip: false, by: c.seat.signerId, at: new Date().toISOString() }] : [decided],
    },
  };
  (payroll as unknown as { putRun(r: PayrollRun, k: Hex): void }).putRun(run, c.viewingKey);
};

const seeded = {
  marked: await aCompany('Marked'),
  unmarked: await aCompany('Unmarked'),
  otherRegister: await aCompany('Otherregister'),
  untold: await aCompany('Untold'),
  withdrawn: await aCompany('Withdrawn'),
};

describe('4. A RETRY NAMING A PERSON MARKED NOT TO BE PAID IS REFUSED, AND NOTHING IS WRITTEN DOWN', () => {
  it('refuses the whole retry and writes nothing', async () => {
    const c = seeded.marked;
    markNotToBePaid(c, 1);
    /* RED WHEN: the service never reads the run's record of who it left out - #2 is then raised for payment. */
    await expect(aRetry(c, [1, 2])).rejects.toThrow(/#2 is marked on run .* as not to be paid/u);
    /* RED WHEN: the refusal comes after the retry is written onto the leg or its round is written down. */
    expect(retriesOf(c)).toEqual([]);
    expect(retryRoundsOf(c)).toEqual([]);
    /* The people nobody marked are still retried: the refusal is about #2 and not about the run. */
    const ok = await aRetry(c, [2]);
    expect(ok.raisedAt).toBeTruthy();
  });

  it('reads the decision in force, so a person put back in is retried', async () => {
    const c = seeded.unmarked;
    markNotToBePaid(c, 1, { unskip: true });
    /* RED WHEN: any decision about a person is read as marking them, not the latest one. */
    const ok = await aRetry(c, [1]);
    expect(ok.raisedAt).toBeTruthy();
  });

  it('refuses a record of who was left out that is not this run\'s rather than reading it as nobody', async () => {
    const c = seeded.otherRegister;
    markNotToBePaid(c, 0, { proposalId: 'run_somebody_else' });
    /* RED WHEN: a record from another run is ignored, or applied as though it were this run's. */
    await expect(aRetry(c, [2])).rejects.toThrow(/those skips are for run run_somebody_else/u);
    expect(retriesOf(c)).toEqual([]);
  });
});

describe('5. A CLOSED WINDOW RELEASES ITS PEOPLE, AND A WITHDRAWN RETRY COVERS NOBODY', () => {
  it('a retry whose raise did not answer covers its people until its window closes, then releases them', async () => {
    const c = seeded.untold;
    const propose = ledger.proposeRun.bind(ledger);
    Object.assign(ledger, { proposeRun: async () => { throw new Error('the node refused before it landed'); } });
    try {
      await expect(aRetry(c, [1, 2], EARLY)).rejects.toThrow(/refused before it landed/u);
    } finally {
      Object.assign(ledger, { proposeRun: propose });
    }
    expect(retriesOf(c).map((r) => r.proposalId)).toEqual([undefined]);
    /* While its window is open, #2 is refused on another retry: the round may be on chain. */
    await expect(aRetry(c, [1], LATER)).rejects.toThrow(/whose raise did not answer/u);
    at(EARLY.closesAt - now + 1);
    /* RED WHEN: the untold round counts after its window has closed - its people are then unretryable for ever. */
    const released = await aRetry(c, [1], LATER);
    expect(released.raisedAt).toBeTruthy();
    at(60);
  });

  it('a retry withdrawn before its window opened covers nobody', async () => {
    const c = seeded.withdrawn;
    const first = await aRetry(c, [1, 2], UNOPENED);
    expect(first.raisedAt).toBeTruthy();
    await expect(aRetry(c, [1], LATER)).rejects.toThrow(/already on retry/u);
    await accounts.cancel(first.id, c.viewingKey);
    expect(accounts.requireProposal(first.id, c.viewingKey).status).toBe('cancelled');
    /* RED WHEN: a withdrawn retry is still counted - the people it named can then never be retried. */
    const again = await aRetry(c, [1], LATER);
    expect(again.raisedAt).toBeTruthy();
  });
});
