import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import { AccountService, openAccount, sealAccount, seatingDrift, approvalMessage } from './account.js';
import { sealRecord } from './sealed-records.js';
import { sign } from './crypto.js';

/*
 * The account's threshold is held once: by the chain. These tests pin that the service keeps no copy of it, sealed
 * or readable, and that its removal (now the devices', in packages/web-shared/src/a-signer-is-removed-from-the-devices.test.ts)
 * is not here.
 */

const THREE = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

function harness() {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-u5b-')), 'db.json'));
  const ledger = new SimulatedLedger(SimulatedCommitments);
  return { store, ledger, accounts: new AccountService(store, ledger, SimulatedCommitments) };
}

const present = <T,>(v: T | undefined): T => { if (v === undefined) throw new Error('missing'); return v; };

describe('the service keeps no copy of the account threshold', () => {
  it('writes no threshold on the stored record and none in the sealed policy', async () => {
    /* RED WHEN: sealAccount writes a threshold to the readable record, or a Policy carries one. */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2, undefined, drawCompanyLabel());
    const rec = h.accounts.require(c.account.id);
    expect(Object.keys(rec)).not.toContain('threshold');
    expect(Object.keys(h.accounts.open(c.account.id, c.viewingKey).policy)).toEqual(['limitsByRole']);
  });

  it('drops a threshold an older record carries, on read and on the next write', async () => {
    /* RED WHEN: openAccount takes the threshold of a stored policy back into the opened account. */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2, undefined, drawCompanyLabel());
    const rec = h.accounts.require(c.account.id);
    const old = { ...rec, sealedPolicy: sealRecord('policy', rec.id,
      { policy: { threshold: 2, limitsByRole: {} }, recovery: { signerIds: [], threshold: 1 } }, c.viewingKey) };
    const opened = openAccount(old as never, c.viewingKey);
    expect(Object.keys(opened.policy)).toEqual(['limitsByRole']);
    expect(Object.keys(sealAccount(opened, c.viewingKey, [], 0))).not.toContain('threshold');
  });

  it('has no removal of its own: a removal is the devices\'', () => {
    /* RED WHEN: AccountService.removeSigner comes back. */
    expect((AccountService.prototype as unknown as Record<string, unknown>).removeSigner).toBeUndefined();
  });

  it('moves the chain\'s threshold through a round and leaves nothing of its own to move', async () => {
    /* RED WHEN: setThreshold writes the number into the sealed account. */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2, undefined, drawCompanyLabel());
    const ada = present(c.secrets[0]);
    const blake = present(c.secrets[1]);
    const p = await h.accounts.proposeThresholdChange(c.account.id, c.viewingKey, 3, ada.signerId);
    await h.accounts.approve(p.id, ada.signerId, sign(approvalMessage(p), ada.signingSecret), c.viewingKey);
    await h.accounts.approve(p.id, blake.signerId, sign(approvalMessage(p), blake.signingSecret), c.viewingKey);
    await h.accounts.setThreshold(c.account.id, c.viewingKey, 3);
    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(3);
    expect(Object.keys(h.accounts.open(c.account.id, c.viewingKey).policy)).toEqual(['limitsByRole']);
    expect(Object.keys(h.accounts.require(c.account.id))).not.toContain('threshold');
  });

  it('says only what the roster says when it disagrees with the chain, and names no stored threshold', async () => {
    /* RED WHEN: the drift clause names a stored threshold, or loses the seat count. */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2, undefined, drawCompanyLabel());
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const agree = { state: 'read' as const, threshold: 2, signerCount: 3 };
    expect(seatingDrift(account, agree)).toBe('');
    expect(seatingDrift(account, { ...agree, threshold: 3 })).toBe('');
    const drift = seatingDrift(account, { ...agree, signerCount: 4 });
    expect(drift).toMatch(/our roster holds 3 active signers/);
    expect(drift).not.toMatch(/threshold/);
  });
});
