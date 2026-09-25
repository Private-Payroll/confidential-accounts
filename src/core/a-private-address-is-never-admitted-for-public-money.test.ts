import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { SimulatedLedger } from './ledger.js';
import { SimulatedProofSystem } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { registryWithTestPrivateForms, testPrivateToken } from '../testing/assets.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { sealHandover } from './invite-handover.js';
import { FileStore } from './store-file.js';
import { StaticAssetRegistry, type AssetRegistry } from './assets.js';
import { newWrappingKeypair } from './crypto.js';
import type { User } from './types.js';

/**
 * **THE DOOR THAT WRITES THE ROSTER TAKES ONLY AN ADDRESS THE PERSON'S MONEY
 * CAN REACH.** An invitation in NIGHT asks the invited person's wallet for a
 * public address and the page refuses a private one, but the page is not the
 * door that writes the roster: `admit` is. A private address arriving for
 * money with no private form, or a public one for money with no public form,
 * is refused there and the invitation put back, so accepting again works.
 */

const NETWORK = 'undeployed' as const;
const PRIVATE = payeeFor('d1'.repeat(32), NETWORK);
const PUBLIC = unshieldedPayeeFor('e5'.repeat(32), NETWORK);

const registryWith = (nightBothWays = false): AssetRegistry => {
  const base = registryWithTestPrivateForms();
  if (!nightBothWays) return base;
  return new StaticAssetRegistry(base.all().map(a => (a.code === 'NIGHT'
    ? { ...a, ledger: { ...a.ledger, shielded: testPrivateToken('NIGHT') } } : a)));
};

const aCompany = async (nightBothWays = false) => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s197-')), 'db.json'));
  const registry = registryWith(nightBothWays);
  const invites = new RecordingInviteDelivery();
  const accounts = new AccountService(store, new SimulatedLedger(MidnightCommitments), MidnightCommitments, registry);
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry, NETWORK, invites);
  store.putUser({
    id: 'usr_founder', email: 'founder@acme.example', name: 'founder', keyBundle: null,
    keyBundleVersion: 0, identityPublicKey: null, walletKey: null, createdAt: '2026-09-25T00:00:00.000Z',
  } as unknown as User);
  const created = await accounts.create('Acme', [{ name: 'Ada', role: 'admin', userId: 'usr_founder' }], 1);
  return { store, payroll, invites, viewingKey: created.viewingKey, account: created.account.id };
};

/** Robin is invited in `asset` and hands over `address`; the founder then admits. */
const inviteAndHandOver = (c: Awaited<ReturnType<typeof aCompany>>, asset: string) => {
  const { sentTo } = c.payroll.invite(c.account, {
    name: 'Robin', email: 'robin@acme.example', title: 'Contractor', asset, baseAmount: 500_000n,
  }, c.viewingKey, 'usr_founder');
  const token = c.invites.tokenFor(sentTo!);
  c.store.putUser({
    id: 'usr_robin', email: sentTo, name: 'robin', keyBundle: null, keyBundleVersion: 0, identityPublicKey: null,
    walletKey: null, createdAt: '2026-09-25T00:00:00.000Z',
  } as unknown as User);
  const handOver = (address: string) => {
    const invite = c.store.getInvite(token)!;
    c.payroll.acceptInvite(token, sealHandover({
      wrappingPublicKey: newWrappingKeypair().publicKey, address, confirmation: null,
    }, c.store.getAccount(invite.accountId)!.inboxPublicKey), 'usr_robin');
    const robin = c.store.listEmployees(c.account).find(e => c.payroll.person(e.id, c.viewingKey)!.name === 'Robin')!;
    return () => c.payroll.admit(robin.id, c.viewingKey, 'usr_founder');
  };
  const robin = () => c.store.listEmployees(c.account).find(e => c.payroll.person(e.id, c.viewingKey)!.name === 'Robin')!;
  return { handOver, robin };
};

describe('an address of a kind the money has no form for is never admitted', () => {
  it('NIGHT, A PRIVATE ADDRESS: REFUSED AND PUT BACK, AND A PUBLIC ONE THEN ADMITTED', async () => {
    const c = await aCompany();
    const { handOver, robin } = inviteAndHandOver(c, 'NIGHT');
    /* RED WHEN admit takes a private address for NIGHT: it is written to the roster and refused only at the raise. */
    expect(handOver(PRIVATE.bech32)).toThrow(/^not admitted\. NIGHT can only be paid to a public address, and the address that arrived is a private one\./u);
    expect(robin().status).toBe('pending');
    expect(c.payroll.person(robin().id, c.viewingKey)!.address ?? null).toBeNull();
    /* Put back: the same invitation accepted again with a public address is admitted. */
    const admitted = handOver(PUBLIC.bech32)();
    expect([admitted.status, admitted.address?.kind, admitted.address?.bech32]).toEqual(['active', 'unshielded', PUBLIC.bech32]);
  });

  it('MONEY WITH NO PUBLIC FORM, A PUBLIC ADDRESS: REFUSED THE SAME WAY', async () => {
    const c = await aCompany();
    const { handOver, robin } = inviteAndHandOver(c, 'USDC');
    /* RED WHEN admit takes a public address for money that can only be paid privately. */
    expect(handOver(PUBLIC.bech32)).toThrow(/^not admitted\. USDC can only be paid to a private address, and the address that arrived is a public one\./u);
    expect(robin().status).toBe('pending');
    expect(handOver(PRIVATE.bech32)().status).toBe('active');
  });

  it('ADDING YOURSELF IN NIGHT WITH A PRIVATE ADDRESS IS REFUSED BEFORE ANYTHING IS WRITTEN', async () => {
    const c = await aCompany();
    const entries = () => c.store.listEmployees(c.account).length;
    const invites = () => c.store.listInvites(c.account).length;
    const before = [entries(), invites()];
    expect(() => c.payroll.addSelfAsPayee(c.account, 'usr_founder', {
      name: 'Ada', email: null, title: 'Founder', asset: 'NIGHT', baseAmount: 500_000n,
    }, c.viewingKey, { wrappingPublicKey: newWrappingKeypair().publicKey, address: PRIVATE }))
      .toThrow(/^NIGHT can only be paid to a public address, and the address that arrived is a private one\./u);
    /* RED WHEN the refusal is left to `admit`: an entry and an invitation are then made for an address that is refused. */
    expect([entries(), invites()]).toEqual(before);
  });

  it('MONEY WITH BOTH FORMS TAKES EITHER ADDRESS', async () => {
    const c = await aCompany(true);
    const { handOver } = inviteAndHandOver(c, 'NIGHT');
    /* RED WHEN a private address is refused for any money that can be paid publicly, rather than only for money with no private form. */
    expect(handOver(PRIVATE.bech32)().address?.kind).toBe('shielded');
  });
});
