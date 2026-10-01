/**
 * **A RUN PAYS EACH PERSON IN THE FORM THEIR ADDRESS IS: A PRIVATE ADDRESS
 * PRIVATELY, A PUBLIC ONE PUBLICLY, OUT OF THE VAULT'S PUBLIC MONEY.**
 *
 * Somebody paid in money with no private form, such as NIGHT, used to be taken
 * on at hiring and refused on payday. Here they are hired, drawn onto a run and
 * raised to be paid publicly, beside a private payee who is still paid
 * privately; a run whose public payments the vault cannot cover is refused
 * before anything is raised or spent; and the refusals against paying one
 * person twice hold for a public payee exactly as for a private one.
 *
 * The payment itself, out of the vault through its public payout, is made in
 * `contracts/test/a-private-payment-from-the-page.test.ts` against the ledger's
 * own state machine.
 */
import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery, runLegOf } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../testing/assets.js';
import { unshieldedPayeeFor } from '../testing/payees.js';
import { sealHandover } from './invite-handover.js';
import { FileStore } from './store-file.js';
import { NIGHT, type AssetRegistry, type LedgerForm } from './assets.js';
import { newWrappingKeypair, toHex } from './crypto.js';
import type { VaultHoldings } from './vault-holdings.js';
import type { DetailsOfKind } from '../midnight/payout-tree.js';
import type { User } from './types.js';

const NETWORK = 'undeployed' as const;
const VAULT = toHex(new Uint8Array(32).fill(0xa4));
const NOW = Math.floor(Date.now() / 1000);
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const SEPTEMBER = '2026-09';
const ROBIN = unshieldedPayeeFor('e5'.repeat(32), NETWORK);

/** The product's rows, and the fixture tokens with both forms. */
const registryWith = (): AssetRegistry => registryWithTestPrivateForms();

/** A vault holding this much in each form, and a record of every question it was asked. */
const aVaultHoldingEach = (held: Record<LedgerForm, bigint>) => {
  const reads: Array<{ form: LedgerForm; token: string }> = [];
  const holdings: VaultHoldings = {
    held: async (_vault, form, token) => { reads.push({ form, token }); return { of: 'held', amount: held[form] }; },
    fits: async () => ({ of: 'fits' }),
  };
  return { holdings, reads };
};

const aCompany = async (opts: { held?: Record<LedgerForm, bigint> } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'mn-s204-'));
  const file = join(dir, 'db.json');
  const ledger = new SimulatedLedger(MidnightCommitments);
  const vault = aVaultHoldingEach(opts.held ?? { shielded: 1n << 100n, unshielded: 1n << 100n });
  const registry = registryWith();
  const invites = new RecordingInviteDelivery();
  const servicesOver = (f: string) => {
    const store = new FileStore(f);
    const accounts = new AccountService(store, ledger, MidnightCommitments, registry, vault.holdings);
    const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry, NETWORK, invites);
    return { store, accounts, payroll };
  };
  const s = servicesOver(file);
  s.store.putUser({
    id: 'usr_founder', email: 'founder@acme.example', name: 'founder', keyBundle: null,
    keyBundleVersion: 0, identityPublicKey: null, walletKey: null, createdAt: '2026-09-25T00:00:00.000Z',
  } as unknown as User);
  const created = await s.accounts.create('Acme', [{ name: 'Ada', role: 'admin', userId: 'usr_founder' }], 1, undefined, drawCompanyLabel());
  const viewingKey = created.viewingKey;
  const account = created.account.id;
  const by = created.secrets[0]!.signerId;
  const openRounds = async () => (await ledger.status(account))!.openProposals.length;
  const materialFor = async (p: PayrollService, runId: string, asset?: string, detailsOf: DetailsOfKind = vaultDetails) => {
    const i = await p.runMaterialInputs(runId, viewingKey, asset as never);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts, pay: i.pay, asset: i.asset,
      opensAt: OPENS, closesAt: CLOSES, vault: VAULT, detailsOf,
      ...(i.epoch !== undefined ? { epoch: i.epoch } : {}),
    });
  };
  const snapshot = () => {
    const copy = join(dir, `copy-${Math.random().toString(36).slice(2)}.json`);
    copyFileSync(file, copy);
    return () => {
      const restored = join(dir, `restored-${Math.random().toString(36).slice(2)}.json`);
      copyFileSync(copy, restored);
      return servicesOver(restored);
    };
  };
  return { ...s, ledger, vault, invites, viewingKey, account, by, openRounds, materialFor, snapshot };
};

/** Robin, hired through the ordinary invitation (in NIGHT unless said), handing over a public address from their own device. */
const hireRobin = (c: Awaited<ReturnType<typeof aCompany>>, baseAmount = 500_000n, asset: string = NIGHT) => {
  const { sentTo } = c.payroll.invite(c.account, {
    name: 'Robin', email: 'robin@acme.example', title: 'Contractor', asset, baseAmount,
  }, c.viewingKey, 'usr_founder');
  const token = c.invites.tokenFor(sentTo!);
  c.store.putUser({
    id: 'usr_robin', email: sentTo, name: 'robin', keyBundle: null, keyBundleVersion: 0, identityPublicKey: null,
    walletKey: null, createdAt: '2026-09-25T00:00:00.000Z',
  } as unknown as User);
  const invite = c.store.getInvite(token)!;
  const handover = sealHandover({
    wrappingPublicKey: newWrappingKeypair().publicKey, address: ROBIN.bech32, confirmation: null,
  }, c.store.getAccount(invite.accountId)!.inboxPublicKey);
  c.payroll.acceptInvite(token, handover, 'usr_robin');
  const pending = c.store.listEmployees(c.account).find(e => c.payroll.person(e.id, c.viewingKey)!.name === 'Robin')!;
  return c.payroll.admit(pending.id, c.viewingKey, 'usr_founder');
};

const NIGHT_PUBLIC = (r: AssetRegistry) => r.require(NIGHT).ledger.unshielded!;

describe('1. A PUBLIC PAYEE IS HIRED, DRAWN ONTO A RUN AND RAISED TO BE PAID PUBLICLY', () => {
  it('through the ordinary invitation, with the leaf built by the vault\'s public details circuit', async () => {
    const c = await aCompany();
    const robin = hireRobin(c);
    /* RED WHEN: hiring refuses a public address, or a public asset. */
    expect([robin.status, robin.address?.kind, robin.asset]).toEqual(['active', 'unshielded', NIGHT]);

    /* RED WHEN: the draw refuses Robin because the address is public. */
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    expect(run.employees.map(e => [e.name, e.paidTo])).toEqual([['Robin', ROBIN.bech32]]);

    /* RED WHEN: Robin's payment is built as private, at another address, or in the private token. */
    const facts = (await c.payroll.runMaterialInputs(run.id, c.viewingKey)).facts;
    expect(facts.map(f => [f.payee.kind, f.payee.bech32, f.token, f.amount]))
      .toEqual([['unshielded', ROBIN.bech32, NIGHT_PUBLIC(registryWith()), 500_000n]]);

    /* RED WHEN: the leaf is built by the private details circuit - the public payout could not pay it. */
    const refused = (which: string) => (() => { throw new Error(`the ${which} details circuit was asked`); }) as never;
    const material = await c.materialFor(c.payroll, run.id, undefined, { ...vaultDetails, shielded: refused('private') });
    await expect(c.materialFor(c.payroll, run.id, undefined, { ...vaultDetails, unshielded: refused('public') }))
      .rejects.toThrow(/^the public details circuit was asked$/);

    /* And it is raised, asking the vault about its public money and nothing else. */
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, material);
    expect(await c.openRounds()).toBe(1);
    expect(c.vault.reads).toEqual([{ form: 'unshielded', token: NIGHT_PUBLIC(registryWith()) }]);
  });
});

describe('2. A PRIVATE PAYEE ON THE SAME RUN IS STILL PAID PRIVATELY', () => {
  it('in a leg of their own when their money is another asset', async () => {
    const c = await aCompany();
    hireRobin(c);
    c.payroll.hireDirect(c.account, {
      name: 'Dana', email: 'dana@acme.example', title: 'Eng', asset: TEST_TOKEN, baseAmount: 100_00n,
    }, c.viewingKey);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const kinds = async (asset: string) => (await c.payroll.runMaterialInputs(run.id, c.viewingKey, asset as never)).facts
      .map(f => [f.payee.kind, f.token]);
    /* RED WHEN: a private payee is built as public because somebody else on the run is. */
    expect(await kinds(TEST_TOKEN)).toEqual([['shielded', registryWith().require(TEST_TOKEN).ledger.shielded]]);
    expect(await kinds(NIGHT)).toEqual([['unshielded', NIGHT_PUBLIC(registryWith())]]);
  });

  it('A PAYROLL WITH BOTH KINDS OF PAYEE IN ONE TOKEN IS TWO RUNS SIDE BY SIDE, EVERY PERSON ON EXACTLY ONE, EACH RAISED ON ITS OWN', async () => {
    /* One token with both forms: Robin hands over a public address, Dana and Eve are paid privately. */
    const c = await aCompany();
    hireRobin(c, 500_000n, TEST_TOKEN);
    for (const name of ['Dana', 'Eve']) {
      c.payroll.hireDirect(c.account, {
        name, email: `${name.toLowerCase()}@acme.example`, title: 'Eng', asset: TEST_TOKEN, baseAmount: 300_000n,
      }, c.viewingKey);
    }
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const privately = runLegOf(TEST_TOKEN, 'shielded');
    const publicly = runLegOf(TEST_TOKEN, 'unshielded');

    /* RED WHEN: a payroll with both kinds of payee is drawn as one run, which would mix forms in one approval. */
    const legs = c.payroll.legsOf(run.id, c.viewingKey);
    expect(legs.map(l => [l.leg, l.form, l.symbol, l.total])).toEqual([
      [privately, 'shielded', 'tPAY', 600_000n],
      [publicly, 'unshielded', 'tPAY', 500_000n],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    /* RED WHEN: somebody is on both runs, or on neither - paid twice, or never. */
    const onALeg = legs.flatMap(l => l.people);
    expect(onALeg.slice().sort()).toEqual(run.employees.map(e => e.id).sort());
    expect(new Set(onALeg).size).toBe(run.employees.length);
    const robinId = run.employees.find(e => e.name === 'Robin')!.id;
    expect(legs.find(l => l.leg === publicly)!.people).toEqual([robinId]);

    /* RED WHEN: a raise that does not say which run is let through and picks one. */
    await expect(c.payroll.runMaterialInputs(run.id, c.viewingKey))
      .rejects.toThrow(/^This run has two sets of payments: private tPAY and public tPAY\. Each is approved on its own\. Choose which to send for approval\.$/);
    await expect(c.payroll.runMaterialInputs(run.id, c.viewingKey, TEST_TOKEN))
      .rejects.toThrow(/^This run pays tPAY both privately and publicly\. Each is approved on its own\. Say whether you mean the private or the public payments\.$/);

    /* Each run's payments are all of its own form, in the token. */
    const kinds = async (leg: string) => (await c.payroll.runMaterialInputs(run.id, c.viewingKey, leg)).facts
      .map(f => [f.payee.kind, f.token]);
    expect(await kinds(privately)).toEqual([['shielded', TEST_TOKEN], ['shielded', TEST_TOKEN]]);
    expect(await kinds(publicly)).toEqual([['unshielded', TEST_TOKEN]]);

    /* Each is raised on its own, asking the vault about its own form only, and each is its own approval round. */
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, await c.materialFor(c.payroll, run.id, publicly), publicly);
    expect(c.vault.reads.map(r => r.form)).toEqual(['unshielded']);
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, await c.materialFor(c.payroll, run.id, privately), privately);
    expect(c.vault.reads.map(r => r.form)).toEqual(['unshielded', 'shielded']);
    expect(await c.openRounds()).toBe(2);
    const proposed = c.payroll.requireRun(run.id, c.viewingKey).proposalIds;
    expect(Object.keys(proposed).sort()).toEqual([privately, publicly].sort());
    expect(proposed[privately]).not.toBe(proposed[publicly]);
  });
});

describe('3. A RUN WHOSE PUBLIC PAYMENTS THE VAULT CANNOT COVER IS REFUSED BEFORE ANYTHING IS RAISED OR SPENT', () => {
  it('and it says how much is short, in public money', async () => {
    const c = await aCompany({ held: { shielded: 1n << 100n, unshielded: 400_000n } });
    hireRobin(c, 500_000n);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const material = await c.materialFor(c.payroll, run.id);
    /* RED WHEN: the vault's public money is not asked before a run with a public payment is raised. */
    await expect(c.payroll.proposeRun(run.id, c.viewingKey, c.by, material))
      .rejects.toThrow(/the vault holds 0\.400000 NIGHT publicly and this proposal asks it to pay 0\.500000\. Deposit at least 0\.100000 NIGHT into the vault publicly[\s\S]*Nothing was raised and no fee was spent\.$/);
    /*
     * RED WHEN: the refusal comes after a round is raised or reaches the chain. What the leg would be raised over
     * is kept on the run, as it is when a private payment is refused here; the run is still a draft and no round
     * is written against it.
     */
    const after = c.payroll.requireRun(run.id, c.viewingKey);
    expect([after.status, after.proposalIds]).toEqual(['draft', {}]);
    expect(c.store.listProposals(c.account)).toEqual([]);
    expect(await c.openRounds()).toBe(0);
  });
});

describe('4. THE REFUSALS AGAINST PAYING TWICE HOLD FOR A PUBLIC PAYEE', () => {
  it('a second run for the month is refused at the draw while the chain holds a round the records cannot account for', async () => {
    const c = await aCompany();
    hireRobin(c);
    const before = c.snapshot();
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, await c.materialFor(c.payroll, run.id));
    expect(await c.openRounds()).toBe(1);
    const restored = before();
    /* RED WHEN: a public payee's month is drawn again from records that have lost the round the chain holds. */
    await expect(restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey))
      .rejects.toThrow(/the chain holds 1 open round/);
    expect(restored.store.listRuns(c.account)).toHaveLength(0);
  });

  it('and at the raise, for a run drawn before that round reached the chain', async () => {
    const c = await aCompany();
    hireRobin(c);
    const restored = c.snapshot()();
    const theirs = await restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, await c.materialFor(c.payroll, run.id));
    const material = await c.materialFor(restored.payroll, theirs.run.id);
    /* RED WHEN: a raise over a public payee asks only this service's records whether they are paid. */
    await expect(restored.payroll.proposeRun(theirs.run.id, c.viewingKey, c.by, material))
      .rejects.toThrow(/the chain holds 1 open round/);
    expect(await c.openRounds()).toBe(1);
  });
  it('and the records that raised a public payee\'s month refuse drawing it again, by their own check', async () => {
    const c = await aCompany();
    hireRobin(c);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, await c.materialFor(c.payroll, run.id));
    /*
     * RED WHEN: both of these records' own checks for a month already raised are skipped for a public payee's run.
     * Which of the two answers first has been seen to differ between runs, so either is taken.
     */
    await expect(c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey)).rejects.toThrow(/^a run for 2026-09 already exists(\. If that is the run you meant| and a round has been raised for it: )/);
    expect(c.store.listRuns(c.account)).toHaveLength(1);
  });
});
