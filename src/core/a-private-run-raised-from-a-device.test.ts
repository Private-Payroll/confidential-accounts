/**
 * **A PAYROLL RUN'S PRIVATE MONEY IS ASKED ON THE SIGNER'S DEVICE, AND THIS
 * SERVICE ASKS ONLY WHAT IT CAN READ.**
 *
 * The reader here behaves as the service's own does: it answers public money
 * and refuses every question about private money, because a service holds no
 * note pool it can open. Every run a payroll can raise pays privately.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from './account.js';
import { PayrollService } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { testPrivateToken } from '../testing/assets.js';
import { SEED_ASSETS, StaticAssetRegistry, type LedgerForm } from './assets.js';
import type { PaymentAsked, VaultHoldings } from './vault-holdings.js';
import { FileStore } from './store-file.js';
import { toHex } from './crypto.js';

const VAULT = toHex(new Uint8Array(32).fill(0xa1));
const PUBLIC_GBP = testPrivateToken('public GBP');
const now = () => Math.floor(Date.now() / 1000);

/** The service's reader: public money from the chain, private money refused because no pool is here. */
const theServiceReader = (publicHeld: bigint) => {
  const asked: Array<{ q: 'held'; form: LedgerForm } | { q: 'fits'; kinds: string[] }> = [];
  const reader: VaultHoldings = {
    held: async (_vault, form) => {
      asked.push({ q: 'held', form });
      if (form === 'shielded') throw new Error('a service holds no vault note pool it can open');
      return { of: 'held', amount: publicHeld };
    },
    fits: async (_vault, payments: ReadonlyArray<PaymentAsked>) => {
      asked.push({ q: 'fits', kinds: payments.map((p) => p.payee.kind) });
      if (payments.some((p) => p.payee.kind === 'shielded')) throw new Error('a service holds no vault note pool it can open');
      return { of: 'fits' };
    },
  };
  return { reader, asked };
};

async function aCompany(publicHeld = 0n, opts: { alsoEur?: true } = {}) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-private-run-')), 'db.json'));
  const ledger = new SimulatedLedger(MidnightCommitments);
  Object.assign(ledger, { submitProvenCall: async () => ({ ref: 'tx', at: new Date().toISOString() }) });
  /* GBP given a private token and a public one, so a test can turn some of a run's payments public. */
  const registry = new StaticAssetRegistry(SEED_ASSETS.map((a) => (a.code === 'GBP'
    ? { ...a, ledger: { shielded: testPrivateToken('GBP'), unshielded: PUBLIC_GBP } }
    : a.code === 'EUR' ? { ...a, ledger: { shielded: testPrivateToken('EUR'), unshielded: null } } : a)));
  const { reader, asked } = theServiceReader(publicHeld);
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, reader);
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const { viewingKey } = created;
  for (let i = 0; i < 3; i++) {
    payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  if (opts.alsoEur) {
    payroll.hireDirect(created.account.id, {
      name: 'Payee EUR', email: 'e@a.co', title: 'Eng', asset: 'EUR', baseAmount: 7_00n,
    }, viewingKey);
  }
  const me = created.secrets[0]!;
  const runId = (await payroll.createRunFromRoster(created.account.id, '2026-08', viewingKey)).run.id;
  const material = async () => {
    const i = await payroll.runMaterialInputs(runId, viewingKey);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt: BigInt(now() - 60), closesAt: BigInt(now() + 3_600), vault: VAULT, detailsOf: vaultDetails,
    });
  };
  /** Rewrites the payments on the next raise, as a run carrying other payments would. */
  const rewrite = (change: (p: PaymentAsked, i: number) => PaymentAsked) => {
    const raise = accounts.proposeRun.bind(accounts);
    Object.assign(accounts, {
      proposeRun: (args: Parameters<typeof raise>[0]) => raise({ ...args, payments: args.payments.map(change) }),
    });
  };
  /** Makes the first `n` payments on the next raise public, as a run with public payees would carry them. */
  const makePublic = (n: number) => rewrite((p, i) => (i < n
    ? { ...p, payee: { kind: 'unshielded' as const }, token: PUBLIC_GBP } : p));
  const raise = async (how?: { onDevice: true }) =>
    payroll.proposeRun(runId, viewingKey, me.signerId, await material(), undefined, how);
  return { payroll, accounts, viewingKey, runId, asked, raise, makePublic, rewrite };
}

describe('A PAYROLL RUN WITH PRIVATE PAYEES, RAISED', () => {
  it('3. FROM A DEVICE IS WRITTEN DOWN WITHOUT THIS SERVICE ASKING ITSELF ABOUT PRIVATE MONEY', async () => {
    const c = await aCompany();
    const round = await c.raise({ onDevice: true });
    expect(round.status).toBe('open');
    expect(c.payroll.requireRun(c.runId, c.viewingKey).proposalIds.GBP).toBe(round.id);
    /* RED WHEN: the service asks its own reader about private money on a device's raise - every such run is then refused. */
    expect(c.asked).toEqual([]);
  });

  it('3b. FROM A DEVICE IS STILL CHECKED HERE FOR EVERYTHING THIS SERVICE CAN CHECK WITHOUT THE POOL', async () => {
    const c = await aCompany();
    c.rewrite((p, i) => (i === 0 ? { ...p, token: testPrivateToken('another spelling') } : p));
    const refused = await c.raise({ onDevice: true }).catch((e) => e);
    /* RED WHEN: a device's raise skips the service's check whole - a payment naming money the vault does not pay in is then approved. */
    expect(refused?.why).toBe('misnamed');
    expect(c.payroll.requireRun(c.runId, c.viewingKey).proposalIds.GBP).toBeUndefined();
  });

  it('4. NOT FROM A DEVICE IS STILL REFUSED, BEFORE ANYTHING IS WRITTEN DOWN', async () => {
    const c = await aCompany();
    const refused = await c.raise().catch((e) => e);
    /* RED WHEN: the skip is keyed on anything but a device's raise - a raise nothing asked about privately then goes through. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(String(refused?.message)).toMatch(/no vault note pool/u);
    expect(c.asked).toEqual([{ q: 'held', form: 'shielded' }]);
    expect(c.payroll.requireRun(c.runId, c.viewingKey).proposalIds.GBP).toBeUndefined();
  });

  it('5. FROM A DEVICE IS STILL REFUSED WHEN ITS PUBLIC PAYMENTS ARE MORE THAN THE VAULT HOLDS PUBLICLY', async () => {
    const short = await aCompany(100_00n);
    short.makePublic(2);
    const refused = await short.raise({ onDevice: true }).catch((e) => e);
    /* RED WHEN: a device's raise stops the service asking about public money too. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(refused?.form).toBe('unshielded');
    expect(refused?.asked).toBe(200_00n);
    expect(short.payroll.requireRun(short.runId, short.viewingKey).proposalIds.GBP).toBeUndefined();

    const enough = await aCompany(200_00n);
    enough.makePublic(2);
    await enough.raise({ onDevice: true });
    /* RED WHEN: the public half is asked about the private payment too, or not walked at all. */
    expect(enough.asked).toEqual([{ q: 'held', form: 'unshielded' }, { q: 'fits', kinds: ['unshielded', 'unshielded'] }]);
  });

  it('WHAT A DEVICE IS TOLD A LEG PAYS IS WHAT THE RAISE IS CHECKED AGAINST, AND NAMES NOBODY', async () => {
    const c = await aCompany();
    const told = await c.payroll.legPaymentsAsked(c.runId, c.viewingKey);
    const inputs = await c.payroll.runMaterialInputs(c.runId, c.viewingKey);
    /* RED WHEN: the device is told about other payments than the ones the raise will ask the vault for. */
    expect(told.asset).toBe('GBP');
    expect(told.payments).toEqual(inputs.facts.map((f) => ({ kind: f.payee.kind, token: f.token, amount: f.amount })));
    /* RED WHEN: an address or a seed rides along to a device that only needed a kind, a token and an amount. */
    expect(told.payments.every((p) => Object.keys(p).sort().join() === 'amount,kind,token')).toBe(true);
    expect(Object.keys(told).sort()).toEqual(['asset', 'payments']);

    /* RED WHEN: the leg asked for is not the leg answered - a device then checks one asset's payments and raises another's. */
    const two = await aCompany(0n, { alsoEur: true });
    const eur = await two.payroll.legPaymentsAsked(two.runId, two.viewingKey, 'EUR');
    expect(eur.asset).toBe('EUR');
    expect(eur.payments).toEqual([{ kind: 'shielded', token: testPrivateToken('EUR'), amount: 7_00n }]);
  });
});
