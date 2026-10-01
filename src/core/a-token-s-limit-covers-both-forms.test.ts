/**
 * **A SPENDING LIMIT SET FOR A TOKEN COVERS BOTH OF ITS FORMS, IN ONE ACTION,
 * AND IS ENFORCED FOR A PRIVATE RUN AND FOR A PUBLIC RUN.**
 *
 * The ledger names a token's private notes and its public balance by one token
 * type, so a token is one identity in both forms and a limit set for it is one
 * entry. The layer that checks it before the chain is this service's own
 * policy, `evaluatePolicy` in `account.ts`, asked when a run is raised: a run
 * over the limit is written down as blocked and never relayed. A payroll with
 * private and public payees is two runs, and each is checked against the same
 * entry.
 */
import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService, openAccount, sealAccount } from './account.js';
import { PayrollService, RecordingInviteDelivery, runLegOf } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding, TEST_TOKEN } from '../testing/assets.js';
import { unshieldedPayeeFor } from '../testing/payees.js';
import { sealHandover } from './invite-handover.js';
import { FileStore } from './store-file.js';
import { newWrappingKeypair, toHex } from './crypto.js';
import type { Account, User } from './types.js';

const NETWORK = 'undeployed' as const;
const VAULT = toHex(new Uint8Array(32).fill(0xa5));
const NOW = Math.floor(Date.now() / 1000);
const ROBIN = unshieldedPayeeFor('e6'.repeat(32), NETWORK);
const PRIVATELY = runLegOf(TEST_TOKEN, 'shielded');
const PUBLICLY = runLegOf(TEST_TOKEN, 'unshielded');

/** A company paying Robin publicly and Dana privately, both in the fixture token, with an approver's limit set for it. */
const aCompany = async (perTransaction: bigint) => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-limit-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
  const invites = new RecordingInviteDelivery();
  const ledger = new SimulatedLedger(MidnightCommitments);
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry, NETWORK, invites);
  store.putUser({
    id: 'usr_founder', email: 'founder@acme.example', name: 'founder', keyBundle: null,
    keyBundleVersion: 0, identityPublicKey: null, walletKey: null, createdAt: '2026-10-01T00:00:00.000Z',
  } as unknown as User);
  const created = await accounts.create('Acme', [
    { name: 'Ada', role: 'admin', userId: 'usr_founder' }, { name: 'Blake', role: 'approver' },
  ], 1, undefined, drawCompanyLabel());
  const { viewingKey } = created;
  const account = created.account.id;
  const blake = created.secrets[1]!.signerId;

  /* ONE ACTION: one entry for the token, which is the limit for both of its forms. */
  const rec = accounts.require(account);
  const opened: Account = openAccount(rec, viewingKey);
  opened.policy.limitsByRole = { approver: { [TEST_TOKEN]: { perTransaction, perPeriod: null, periodDays: 30 } } };
  store.putAccount(sealAccount(opened, viewingKey, rec.pendingSigners, rec.keyEpoch));

  /* Robin hands over a public address through the ordinary invitation; Dana is paid privately. */
  const { sentTo } = payroll.invite(account, {
    name: 'Robin', email: 'robin@acme.example', title: 'Contractor', asset: TEST_TOKEN, baseAmount: 5_000_00n,
  }, viewingKey, 'usr_founder');
  const token = invites.tokenFor(sentTo!);
  store.putUser({
    id: 'usr_robin', email: sentTo, name: 'robin', keyBundle: null, keyBundleVersion: 0, identityPublicKey: null,
    walletKey: null, createdAt: '2026-10-01T00:00:00.000Z',
  } as unknown as User);
  payroll.acceptInvite(token, sealHandover({
    wrappingPublicKey: newWrappingKeypair().publicKey, address: ROBIN.bech32, confirmation: null,
  }, store.getAccount(account)!.inboxPublicKey), 'usr_robin');
  const pending = store.listEmployees(account).find(e => payroll.person(e.id, viewingKey)!.name === 'Robin')!;
  payroll.admit(pending.id, viewingKey, 'usr_founder');
  payroll.hireDirect(account, {
    name: 'Dana', email: 'dana@acme.example', title: 'Eng', asset: TEST_TOKEN, baseAmount: 5_000_00n,
  }, viewingKey);

  const { run } = await payroll.createRunFromRoster(account, '2026-10', viewingKey);
  const raise = async (leg: string) => {
    const i = await payroll.runMaterialInputs(run.id, viewingKey, leg);
    const material = await runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts, pay: i.pay, asset: i.asset,
      opensAt: BigInt(NOW - 60), closesAt: BigInt(NOW + 3_600), vault: VAULT, detailsOf: vaultDetails,
    });
    return payroll.proposeRun(run.id, viewingKey, blake, material, leg);
  };
  return { accounts, viewingKey, account, raise };
};

describe('A SPENDING LIMIT SET FOR A TOKEN', () => {
  it('IS ONE ENTRY FOR BOTH FORMS, AND A PRIVATE RUN OVER IT IS BLOCKED BEFORE THE CHAIN', async () => {
    const c = await aCompany(1_000_00n);
    expect(Object.keys(openAccount(c.accounts.require(c.account), c.viewingKey).policy.limitsByRole.approver!))
      .toEqual([TEST_TOKEN]);
    const privateRun = await c.raise(PRIVATELY);
    /* RED WHEN a private run is not checked against the limit set for its token. */
    expect(privateRun.status).toBe('blocked');
    expect(privateRun.blockedReason).toMatch(/per-transaction tPAY limit for role "approver"/);
    expect(privateRun.raisedAt).toBeUndefined();
  });

  it('AND A PUBLIC RUN OVER THE SAME ENTRY IS BLOCKED BEFORE THE CHAIN TOO', async () => {
    const c = await aCompany(1_000_00n);
    const publicRun = await c.raise(PUBLICLY);
    /* RED WHEN a public run is checked against another key than its token's, so the token's limit does not reach it. */
    expect(publicRun.status).toBe('blocked');
    expect(publicRun.blockedReason).toMatch(/per-transaction tPAY limit for role "approver"/);
    expect(publicRun.raisedAt).toBeUndefined();
  });

  it('LETS BOTH RUNS THROUGH WHEN EACH IS WITHIN IT, SO IT IS THE LIMIT AND NOT THE FORM THAT BLOCKS', async () => {
    const c = await aCompany(10_000_00n);
    expect((await c.raise(PRIVATELY)).status).toBe('open');
    expect((await c.raise(PUBLICLY)).status).toBe('open');
  });
});
