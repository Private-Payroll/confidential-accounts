import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedCommitments, type Ledger } from './ledger.js';
import { AccountService } from './account.js';
import {
  SEED_ASSETS, StaticAssetRegistry, assetIdBytes, assets as productAssets,
  type AssetRegistry, type LedgerForm,
} from './assets.js';
import { toHex, type Hex } from './crypto.js';
import {
  VaultCannotPayThisProposal, type FitAnswer, type HoldingAnswer, type VaultHoldings,
} from './vault-holdings.js';
import { registryWithTestPrivateForms, testPrivateToken } from '../testing/assets.js';

/**
 * **A PROPOSAL THAT MOVES MONEY IS RAISED ONLY WHEN ITS VAULT HOLDS WHAT IT PAYS,
 * AS THE CHAIN SAYS NOW, AND A REFUSAL COSTS NOTHING.**
 *
 * Every test here watches two things beside the refusal: that the ledger was
 * never asked to raise the proposal, which is where the fee is spent, and that
 * nothing was written down, so there is no record of a proposal that does not
 * exist.
 */

const VAULT: Hex = 'c4'.repeat(32);
const OPENS = 1_900_000_000n;
const CLOSES = 1_900_086_400n;

let rootNonce = 0;
const aRun = (payees: bigint) => ({
  root: ((rootNonce = (rootNonce % 250) + 1)).toString(16).padStart(2, '0').repeat(32),
  payees, opensAt: OPENS, closesAt: CLOSES, vault: VAULT,
});

/**
 * A vault the test says holds these amounts, keyed `form:token`, whose notes fit
 * unless the test says otherwise, and every question it was asked.
 */
const aVault = (
  holds: Record<string, bigint> | (() => Promise<HoldingAnswer>),
  fits: () => Promise<FitAnswer> = async () => ({ of: 'fits' }),
) => {
  const reads: Array<{ vault: string; form: LedgerForm; token: string }> = [];
  const fitsAsked: Array<{ vault: string; payments: number }> = [];
  const reader: VaultHoldings = {
    held: async (vault, form, token) => {
      reads.push({ vault, form, token });
      if (typeof holds === 'function') return holds();
      return { of: 'held', amount: holds[`${form}:${token}`] ?? 0n };
    },
    fits: async (vault, payments) => { fitsAsked.push({ vault, payments: payments.length }); return fits(); },
  };
  return { reader, reads, fitsAsked };
};

async function harness(opts: { registry?: AssetRegistry; reader?: VaultHoldings | 'none' } = {}) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s114-')), 'db.json'));
  const inner = new SimulatedLedger(SimulatedCommitments);
  const raised = { count: 0 };
  const ledger = new Proxy(inner, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop === 'proposeRun' || prop === 'propose') {
        return async (...args: unknown[]) => { raised.count++; return value.apply(target, args); };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Ledger;
  const registry = opts.registry ?? registryWithTestPrivateForms();
  const accounts = opts.reader === 'none'
    ? new AccountService(store, ledger, SimulatedCommitments, registry)
    : new AccountService(store, ledger, SimulatedCommitments, registry, opts.reader);
  const created = await accounts.create(
    'Northwind Ltd', [{ name: 'Ada', role: 'admin' }, { name: 'Blake', role: 'approver' }], 1);
  const viewingKey = created.viewingKey;
  const by = created.secrets[0]!.signerId;
  const account = created.account.id;
  const recorded = () => accounts.listProposals(account, viewingKey);
  const raise = (asset: string, payments: Array<{ kind: LedgerForm; token: string; amount: bigint }>,
    entries = payments.map(p => p.amount)) =>
    accounts.proposeRun({
      accountId: account, viewingKey, summary: 'a proposal',
      payload: { entries: entries.map((amount, i) => ({
        id: `ent_${i}`, kind: 'payroll', asset, amount, counterparty: `person ${i}`, memo: '', at: '',
      })) },
      asset,
      run: aRun(BigInt(payments.length)),
      payments: payments.map(p => ({ payee: { kind: p.kind }, token: p.token, amount: p.amount })),
      proposedBy: by,
    });
  return { accounts, raised, recorded, raise, viewingKey, by, account };
}

const GBP_PRIVATE = testPrivateToken('GBP');

const refusal = (p: Promise<unknown>) => p.then(
  () => { throw new Error('the proposal was raised'); },
  (e: unknown) => e as VaultCannotPayThisProposal);

describe('§1 a vault that does not hold enough is refused at raise, before a fee', () => {
  it('REFUSES a proposal when the vault holds less than it pays, naming the asset, the form, what is held and what was asked', async () => {
    const vault = aVault({ [`shielded:${GBP_PRIVATE}`]: 30_00n });
    const h = await harness({ reader: vault.reader });
    const failed = await refusal(h.raise('GBP', [
      { kind: 'shielded', token: GBP_PRIVATE, amount: 25_00n },
      { kind: 'shielded', token: GBP_PRIVATE, amount: 10_00n },
    ]));
    /* RED WHEN the check is removed, or compares one payment rather than what the proposal asks in all. */
    expect(failed).toBeInstanceOf(VaultCannotPayThisProposal);
    expect(failed.message).toMatch(
      /the vault holds 30\.00 GBP privately and this proposal asks it to pay 35\.00\. Deposit at least 5\.00 GBP into the vault privately, through the vault's own deposit, then raise the proposal again/);
    expect(failed.message).toMatch(/Nothing was raised and no fee was spent\./);
    expect([failed.asset, failed.form, failed.held, failed.asked, failed.why]).toEqual(['GBP', 'shielded', 30_00n, 35_00n, 'short']);
    /* RED WHEN the refusal comes after the chain is called, which is where the fee is. */
    expect(h.raised.count).toBe(0);
    /* RED WHEN the record is written before the refusal. */
    expect(h.recorded()).toHaveLength(0);
    /* The vault was asked once, about this vault, in this form and token. */
    expect(vault.reads).toEqual([{ vault: VAULT, form: 'shielded', token: GBP_PRIVATE }]);
    /* A message is a screen: the vault's address is a property, not a sentence. */
    expect(failed.message).not.toContain(VAULT.slice(0, 8));
    expect(failed.vault).toBe(VAULT);
  });

  it('REFUSES a proposal when the vault holds none of it', async () => {
    const vault = aVault({});
    const h = await harness({ reader: vault.reader });
    const failed = await refusal(h.raise('GBP', [{ kind: 'shielded', token: GBP_PRIVATE, amount: 1n }]));
    expect(failed.message).toMatch(/the vault holds 0\.00 GBP privately and this proposal asks it to pay 0\.01/);
    expect(h.raised.count).toBe(0);
    expect(h.recorded()).toHaveLength(0);
  });

  it('RAISES a proposal when the vault holds exactly what it pays, so a payable round is never stopped', async () => {
    const vault = aVault({ [`shielded:${GBP_PRIVATE}`]: 35_00n });
    const h = await harness({ reader: vault.reader });
    const p = await h.raise('GBP', [
      { kind: 'shielded', token: GBP_PRIVATE, amount: 25_00n },
      { kind: 'shielded', token: GBP_PRIVATE, amount: 10_00n },
    ]);
    /* RED WHEN held must exceed asked rather than meet it. */
    expect(p.status).toBe('open');
    expect(p.raisedAt).toBeDefined();
    expect(h.raised.count).toBe(1);
    expect(h.recorded()).toHaveLength(1);
  });

  it('REFUSES when the chain does not answer, says to try again, and never reads that as holding nothing or enough', async () => {
    const vault = aVault(async () => ({ of: 'unreadable', why: 'the indexer did not answer' }));
    const h = await harness({ reader: vault.reader });
    const failed = await refusal(h.raise('GBP', [{ kind: 'shielded', token: GBP_PRIVATE, amount: 5n }]));
    expect(failed.message).toMatch(/the chain did not answer what the vault holds of GBP privately \(the indexer did not answer\)/);
    expect(failed.message).toMatch(/Try again when the chain answers/);
    expect([failed.why, failed.held]).toEqual(['unreadable', null]);
    expect(h.raised.count).toBe(0);
    expect(h.recorded()).toHaveLength(0);
  });

  it('REFUSES a record the chain contradicts, and does NOT say to try again, which would never help', async () => {
    const vault = aVault(async () => ({ of: 'contradicted', why: '1 of 2 notes are not on chain' }));
    const h = await harness({ reader: vault.reader });
    const failed = await refusal(h.raise('GBP', [{ kind: 'shielded', token: GBP_PRIVATE, amount: 5n }]));
    /* RED WHEN a contradiction is reported as the chain not answering. */
    expect(failed.why).toBe('contradicted');
    expect(failed.message).toMatch(/record of the vault's private notes disagrees with the chain \(1 of 2 notes are not on chain\)/);
    expect(failed.message).toMatch(/trying again does not change that: the record is rebuilt from the chain/);
    expect(failed.message).not.toMatch(/Try again when/);
    expect(h.raised.count).toBe(0);
  });

  it('REFUSES when the reader throws, or answers with something that is not an answer', async () => {
    for (const holds of [
      async () => { throw new Error('the pool file could not be opened'); },
      async () => 5 as unknown as HoldingAnswer,
      async () => ({ of: 'held', amount: -1n }) as HoldingAnswer,
    ]) {
      const h = await harness({ reader: aVault(holds).reader });
      const failed = await refusal(h.raise('GBP', [{ kind: 'shielded', token: GBP_PRIVATE, amount: 5n }]));
      expect(failed.why).toBe('failed');
      expect(failed.message).not.toMatch(/Try again/);
      expect(h.raised.count).toBe(0);
    }
  });

  it('REFUSES a proposal whose total the vault holds when no single note can make a payment', async () => {
    const vault = aVault(
      { [`shielded:${GBP_PRIVATE}`]: 120n },
      async () => ({ of: 'does-not-fit', why: 'no single note covers 100: the largest is 60' }));
    const h = await harness({ reader: vault.reader });
    const failed = await refusal(h.raise('GBP', [{ kind: 'shielded', token: GBP_PRIVATE, amount: 100n }]));
    /* RED WHEN a total is taken as the answer for private money. */
    expect(failed.why).toBe('does-not-fit');
    expect(failed.message).toMatch(/holds enough GBP in total, but its notes cannot make each payment in turn \(no single note covers 100: the largest is 60\)\. /);
    /* RED WHEN the advice says one covering deposit is enough, which it is not for two payments. */
    expect(failed.message).toMatch(/every payment the present notes cannot cover needs a note of its own\. Deposit those through the vault's own deposit/);
    expect(failed.message).not.toMatch(/\.\./);
    expect(vault.fitsAsked).toEqual([{ vault: VAULT, payments: 1 }]);
    expect(h.raised.count).toBe(0);
    expect(h.recorded()).toHaveLength(0);
  });

  it('asks whether the payments fit only once every total is covered, and with every payment', async () => {
    const short = aVault({ [`shielded:${GBP_PRIVATE}`]: 1n });
    const h = await harness({ reader: short.reader });
    await refusal(h.raise('GBP', [{ kind: 'shielded', token: GBP_PRIVATE, amount: 5n }]));
    expect(short.fitsAsked).toEqual([]);
    const enough = aVault({ [`shielded:${GBP_PRIVATE}`]: 10n });
    const h2 = await harness({ reader: enough.reader });
    await h2.raise('GBP', [
      { kind: 'shielded', token: GBP_PRIVATE, amount: 5n }, { kind: 'shielded', token: GBP_PRIVATE, amount: 5n }]);
    /* RED WHEN the fit is never asked, or asked about part of the proposal. */
    expect(enough.fitsAsked).toEqual([{ vault: VAULT, payments: 2 }]);
    expect(h2.raised.count).toBe(1);
  });

  it('REFUSES every money round in a service that was given no reader, and says that is what is missing', async () => {
    const h = await harness({ reader: 'none' });
    const failed = await refusal(h.raise('GBP', [{ kind: 'shielded', token: GBP_PRIVATE, amount: 5n }]));
    expect(failed.message).toMatch(/this service cannot read what a vault holds/);
    expect(failed.message).toMatch(/given the chain's reader of vault balances/);
    expect(failed.message).not.toMatch(/Try again/);
    expect(h.raised.count).toBe(0);
    expect(h.recorded()).toHaveLength(0);
  });
});

describe('§2 a payment that names its money differently from the asset\'s row is refused before the vault is asked', () => {
  it('REFUSES a payment that names GBP by the account\'s name for it, which is the name a vault never holds', async () => {
    const vault = aVault({ [`shielded:${GBP_PRIVATE}`]: 1n << 64n });
    const h = await harness({ reader: vault.reader });
    const accountName = toHex(assetIdBytes('GBP'));
    const failed = await refusal(h.raise('GBP', [{ kind: 'shielded', token: accountName, amount: 5n }]));
    /* RED WHEN the token is not compared with the row, so the vault is asked about a name it never holds. */
    expect(failed.message).toContain(`names its money as ${accountName}`);
    expect(failed.message).toContain(`GBP paid privately is ${GBP_PRIVATE} on the ledger`);
    expect(vault.reads).toHaveLength(0);
    expect(h.raised.count).toBe(0);
    expect(h.recorded()).toHaveLength(0);
  });

  it('REFUSES a proposal in an asset with no form of the payee\'s kind, from the product\'s own registry', async () => {
    const vault = aVault({});
    const h = await harness({ registry: productAssets, reader: vault.reader });
    const failed = await refusal(h.raise('NIGHT', [{ kind: 'shielded', token: '00'.repeat(32), amount: 5n }]));
    expect(failed.message).toMatch(/NIGHT has no private form on Midnight/);
    expect(failed.form).toBe('shielded');
    expect(vault.reads).toHaveLength(0);
    expect(h.raised.count).toBe(0);
  });

  it('REFUSES payments that are not the proposal the signers approve: a different count, or a different total', async () => {
    const vault = aVault({ [`shielded:${GBP_PRIVATE}`]: 1n << 64n });
    const h = await harness({ reader: vault.reader });
    const short = await refusal(h.accounts.proposeRun({
      accountId: h.account, viewingKey: h.viewingKey, summary: 'a proposal',
      payload: { entries: [{ id: 'e', kind: 'payroll', asset: 'GBP', amount: 5n, counterparty: 'x', memo: '', at: '' }] },
      asset: 'GBP', run: aRun(2n),
      payments: [{ payee: { kind: 'shielded' }, token: GBP_PRIVATE, amount: 5n }],
      proposedBy: h.by,
    }));
    expect(short.message).toMatch(/raised over 2 payments and 1 were handed in/);
    const wrongTotal = await refusal(h.raise('GBP',
      [{ kind: 'shielded', token: GBP_PRIVATE, amount: 5n }], [6n]));
    expect(wrongTotal.message).toMatch(/payments add up to 0\.05 GBP and the signers would approve 0\.06 GBP/);
    expect(vault.reads).toHaveLength(0);
    expect(h.raised.count).toBe(0);
  });
});

describe('§3 an asset in both forms is asked about in each form separately', () => {
  const BOTH = 'a1'.repeat(32);
  const BOTH_PUBLIC = 'b2'.repeat(32);
  const both = new StaticAssetRegistry([
    ...SEED_ASSETS,
    { code: 'ZQ1', name: 'both forms', kind: 'token', decimals: 0, chain: 'midnight',
      ledger: { shielded: BOTH, unshielded: BOTH_PUBLIC }, enabled: true, sortOrder: 99 },
  ]);

  it('REFUSES naming the one form that is short, and raises when both are covered', async () => {
    const short = aVault({ [`shielded:${BOTH}`]: 7n, [`unshielded:${BOTH_PUBLIC}`]: 2n });
    const h = await harness({ registry: both, reader: short.reader });
    const payments = [
      { kind: 'shielded' as const, token: BOTH, amount: 4n },
      { kind: 'unshielded' as const, token: BOTH_PUBLIC, amount: 3n },
      { kind: 'shielded' as const, token: BOTH, amount: 3n },
    ];
    const failed = await refusal(h.raise('ZQ1', payments));
    /* RED WHEN the two forms are summed together, which would call 9 held against 10 asked a shortfall in neither. */
    expect(failed.message).toMatch(/holds 2 ZQ1 publicly and this proposal asks it to pay 3/);
    expect(failed.form).toBe('unshielded');
    expect(h.raised.count).toBe(0);

    const enough = aVault({ [`shielded:${BOTH}`]: 7n, [`unshielded:${BOTH_PUBLIC}`]: 3n });
    const h2 = await harness({ registry: both, reader: enough.reader });
    await h2.raise('ZQ1', payments);
    expect(h2.raised.count).toBe(1);
    expect(enough.reads.map(r => `${r.form}:${r.token}`).sort())
      .toEqual([`shielded:${BOTH}`, `unshielded:${BOTH_PUBLIC}`]);
  });
});

describe('§4 a proposal that moves no money is not asked about a vault', () => {
  it('raises a governance round in a service with no reader at all', async () => {
    const h = await harness({ reader: 'none' });
    const p = await h.accounts.proposeThresholdChange(h.account, h.viewingKey, 2, h.by);
    expect(p.raisedAt).toBeDefined();
    expect(h.raised.count).toBe(1);
  });
});
