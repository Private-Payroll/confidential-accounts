import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from '../../src/core/account.js';
import { PayrollService } from '../../src/core/payroll.js';
import { SimulatedLedger, SimulatedProofSystem } from '../../src/core/ledger.js';
import { assets as productAssets, type AssetRegistry, type LedgerForm } from '../../src/core/assets.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { runMaterialFor, retryMaterialFor } from '../../src/midnight/run-material.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { registryWithTestPrivateForms, testPrivateToken } from '../../src/testing/assets.js';
import { VaultCannotPayThisProposal, type VaultHoldings } from '../../src/core/vault-holdings.js';
import { FileStore } from '../../src/core/store-file.js';
import { toHex } from '../../src/core/crypto.js';

/**
 * **A PAYROLL RUN THE VAULT CANNOT PAY IS NOT RAISED, THROUGH EVERY DOOR THAT
 * RAISES ONE, AND A PAYROLL IN AN ASSET WITH NO PRIVATE FORM IS NOT EVEN BUILT.**
 *
 * The payroll service hands the account the payments its run material was built
 * from, and the account asks the vault before any fee. Three doors raise a
 * payroll round: the first raise of a leg, the same round raised again after an
 * attempt that never answered, and a retry. Each is watched refusing here with
 * the chain never asked.
 */

const VAULT = toHex(new Uint8Array(32).fill(0xb7));
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

type Fault = 'none' | 'throw-before-sending';

const services = (opts: { registry?: AssetRegistry } = {}) => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s114-payroll-')), 'db.json'));
  const inner = new SimulatedLedger(MidnightCommitments);
  const control = { fault: 'none' as Fault, raises: 0 };
  const ledger = new Proxy(inner, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop === 'proposeRun') {
        return async (...args: unknown[]) => {
          const fault = control.fault;
          control.fault = 'none';
          if (fault === 'throw-before-sending') throw new Error('the socket closed before sending');
          control.raises++;
          return value.apply(target, args);
        };
      }
      /*
       * A DOUBLE, NAMED: the simulated ledger records no payments and answers that it cannot say who
       * was paid, and a retry is refused until that can be said. Here it answers that nobody was.
       */
      if (prop === 'paidAmong') return async () => ({ known: true, paid: [] });
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  /* What the vault holds of anything, settable by the test between steps. */
  const vault = { holds: 1n << 64n, reads: [] as Array<{ form: LedgerForm; token: string }>, fitted: [] as number[] };
  const reader: VaultHoldings = {
    held: async (address, form, token) => {
      expect(address).toBe(VAULT);
      vault.reads.push({ form, token });
      return { of: 'held', amount: vault.holds };
    },
    fits: async (address, payments) => {
      expect(address).toBe(VAULT);
      vault.fitted.push(payments.length);
      return { of: 'fits' };
    },
  };
  const registry = opts.registry ?? registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, reader);
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  return { store, accounts, payroll, control, vault };
};

async function aDraftedRun(people: number, asset = 'GBP', opts: { registry?: AssetRegistry } = {}) {
  const s = services(opts);
  const created = await s.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;
  for (let i = 0; i < people; i++) {
    s.payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset, baseAmount: 100_00n,
    }, viewingKey);
  }
  const { run } = await s.payroll.createRunFromRoster(created.account.id, '2026-10', viewingKey);
  const materialFor = async () => {
    const i = await s.payroll.runMaterialInputs(run.id, viewingKey);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt: OPENS, closesAt: CLOSES, vault: VAULT, detailsOf: vaultDetails,
    });
  };
  const by = created.secrets[0]!.signerId;
  const account = created.account.id;
  const roundsOf = () => s.accounts.payrollRoundsOf(account, viewingKey).filter(r => r.runId === run.id);
  return { ...s, viewingKey, run, materialFor, by, account, roundsOf };
}

describe('the product\'s own registry', () => {
  it('REFUSES to build a payroll in an asset with no private form, before any material or fee', async () => {
    /* The product's registry, where only a test asset has a private form. */
    const s = services({ registry: productAssets });
    const created = await s.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    s.payroll.hireDirect(created.account.id, {
      name: 'Payee GBP', email: 'GBP@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, created.viewingKey);
    const { run } = await s.payroll.createRunFromRoster(created.account.id, '2026-10', created.viewingKey);
    /* RED WHEN a payroll payment's token is anything but the asset's own private form. */
    await expect(s.payroll.runMaterialInputs(run.id, created.viewingKey, 'GBP'))
      .rejects.toThrow(/GBP has no form on Midnight, private or public,/);
    /*
     * RED WHEN the refusal stops naming a way through. Until a test settlement
     * asset existed there was none to name and this read "No asset has a
     * private form yet"; a refusal still saying that would be sending somebody
     * away from a payment they can in fact make.
     */
    await expect(s.payroll.runMaterialInputs(run.id, created.viewingKey, 'GBP'))
      .rejects.toThrow(/Assets that have a private form: TESTUSD\./);
    /*
     * RED WHEN NIGHT is given a private form. `nativeToken()` is unshielded by
     * definition, so there is no private NIGHT on this platform and no test
     * asset changes that. A NIGHT payee handed over with a private address is
     * refused where they are admitted.
     */
    expect(() => s.payroll.hireDirect(created.account.id, {
      name: 'Payee NIGHT', email: 'NIGHT@a.co', title: 'Eng', asset: 'NIGHT', baseAmount: 100_00n,
    }, created.viewingKey)).toThrow(/NIGHT can only be paid to a public address, and the address that arrived is a private one/);
    expect(s.control.raises).toBe(0);
  });
});

describe('a payroll round the vault cannot pay', () => {
  it('REFUSES the first raise of a leg, and leaves no round and a draft', async () => {
    const r = await aDraftedRun(2);
    r.vault.holds = 199_99n;
    const failed = await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor())
      .then(() => null, (e: unknown) => e as VaultCannotPayThisProposal);
    /* RED WHEN the payroll door does not hand the account its run's payments. */
    expect(failed).toBeInstanceOf(VaultCannotPayThisProposal);
    expect(failed!.message).toMatch(/holds 199\.99 GBP privately and this proposal asks it to pay 200\.00/);
    expect(r.control.raises).toBe(0);
    expect(r.roundsOf()).toHaveLength(0);
    const run = r.payroll.requireRun(r.run.id, r.viewingKey);
    expect(run.status).toBe('draft');
    expect(run.proposalIds.GBP).toBeUndefined();
    /* It asked about the token the run's own payments name. */
    expect(r.vault.reads).toEqual([{ form: 'shielded', token: testPrivateToken('GBP') }]);

    /* And once the vault holds it, the same run raises. */
    r.vault.holds = 200_00n;
    await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor());
    expect(r.control.raises).toBe(1);
  });

  it('REFUSES the same round raised again, when the vault no longer holds it', async () => {
    const r = await aDraftedRun(1);
    const material = await r.materialFor();
    r.control.fault = 'throw-before-sending';
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, material)).rejects.toThrow(/before sending/);
    expect(r.roundsOf()).toHaveLength(1);

    r.vault.holds = 0n;
    /* RED WHEN the path that raises a written-down round again skips the vault. */
    await expect(r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor()))
      .rejects.toThrow(VaultCannotPayThisProposal);
    expect(r.control.raises).toBe(0);
  });

  it('REFUSES a retry the vault cannot pay, asking about the retried people only', async () => {
    const r = await aDraftedRun(2);
    await r.payroll.proposeRun(r.run.id, r.viewingKey, r.by, await r.materialFor());
    expect(r.control.raises).toBe(1);
    const rebuild = (await r.payroll.payoutRebuildOf(r.run.id, r.viewingKey))!;
    const retry = await retryMaterialFor({
      rebuild, indices: [1], opensAt: OPENS, closesAt: CLOSES + 7_200n, vault: VAULT,
      detailsOf: vaultDetails,
    });
    afterTheLegsWindow();
    r.vault.holds = 99_99n;
    /* RED WHEN a retry is raised without its payments being checked, or with the whole leg's. */
    await expect(r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry))
      .rejects.toThrow(/holds 99\.99 GBP privately and this proposal asks it to pay 100\.00/);
    expect(r.control.raises).toBe(1);
    r.vault.holds = 100_00n;
    await r.payroll.proposeRetry(r.run.id, r.viewingKey, r.by, retry);
    expect(r.control.raises).toBe(2);
  });
});
