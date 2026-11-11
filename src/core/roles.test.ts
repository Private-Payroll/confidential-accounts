import { describe, expect, it } from 'vitest';
import { readFoundingAsked } from 'midnight-identity/profile/request';
import { isRole, isSignerRole, MAY_FILE, mayFile, mayInvite, READER_ROLES, ROLES, SIGNER_ROLES, type Role } from './roles.js';

describe('THE ROLES A SEAT CAN HOLD', () => {
  it('are three signer roles and two reader roles, and nothing else', () => {
    /* RED WHEN: a role is added, dropped or renamed without every reader of the list moving with it. */
    expect([...ROLES]).toEqual(['admin', 'approver', 'initiator', 'limited', 'accountant']);
    expect([...SIGNER_ROLES]).toEqual(['admin', 'approver', 'initiator']);
    expect([...READER_ROLES]).toEqual(['limited', 'accountant']);
    /* RED WHEN: a role no seat can hold any more, or a value that is no role, passes as one. */
    for (const x of ['viewer', 'owner', '', null, 3]) expect(isRole(x), String(x)).toBe(false);
    /* RED WHEN: a reader role passes as a role a seat with a leaf is given. */
    for (const r of READER_ROLES) expect(isSignerRole(r), r).toBe(false);
  });

  it('a company is founded only at a signer role, read off the same list', () => {
    /* RED WHEN: the founding seat, which holds a leaf, can be asked for at a reader role or a role nothing defines. */
    for (const role of SIGNER_ROLES) expect(readFoundingAsked({ name: 'Acme', signer: { name: 'Ada', role } }), role).not.toBeNull();
    for (const role of [...READER_ROLES, 'viewer']) expect(readFoundingAsked({ name: 'Acme', signer: { name: 'Ada', role } }), role).toBeNull();
  });

  it('a reader role, or a role nothing defines, files nothing and invites nobody', () => {
    for (const role of READER_ROLES) {
      /* RED WHEN: a seat with no leaf files any of the company's records. */
      expect(MAY_FILE[role], role).toEqual([]);
      expect(mayInvite({ role }), role).toBe(false);
    }
    /* RED WHEN: a seat read with a role nothing defines stops the read instead of filing nothing. */
    expect(mayFile({ role: 'owner' as Role })).toEqual([]);
    expect(mayInvite({ role: 'owner' as Role })).toBe(false);
  });

  const WIRE = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];
  const EVERY_KIND = ['state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer', 'spending-policy', 'vault-info', 'transfer', 'vendor', 'grants', ...WIRE];

  it('an admin and a seat with no role set file every kind, written out here', () => {
    /* RED WHEN: a kind is added or dropped from what an admin files, or the founding seat, whose role is not set, files other than what an admin files. */
    expect([...MAY_FILE.admin]).toEqual(EVERY_KIND);
    expect([...MAY_FILE.unset]).toEqual(EVERY_KIND);
    expect([...mayFile({ role: null })]).toEqual(EVERY_KIND);
    expect([...mayFile({ role: 'admin' })]).toEqual(EVERY_KIND);
  });

  it('an approver files proposals, the read grants and the vault records, and nothing else', () => {
    /* RED WHEN: an approver files a run, a transfer or any company record beyond a proposal and the read grants, or stops filing a vault's pool or journals. */
    expect([...MAY_FILE.approver]).toEqual(['proposal', 'grants', ...WIRE]);
    expect([...mayFile({ role: 'approver' })]).toEqual(['proposal', 'grants', ...WIRE]);
    for (const kind of ['state', 'roster', 'policy', 'person', 'run', 'offer', 'spending-policy', 'vault-info', 'transfer', 'vendor']) {
      expect(mayFile({ role: 'approver' }), kind).not.toContain(kind);
    }
    expect(mayFile({ role: 'approver' })).toContain('pool');
  });

  it('an initiator files runs, transfers, proposals, the read grants and the vault records, and nothing else', () => {
    /* RED WHEN: an initiator stops filing a run or a transfer, or files a policy, a vault's name, a vendor, a person or any other company record. */
    expect([...MAY_FILE.initiator]).toEqual(['run', 'transfer', 'proposal', 'grants', ...WIRE]);
    expect([...mayFile({ role: 'initiator' })]).toEqual(['run', 'transfer', 'proposal', 'grants', ...WIRE]);
    for (const kind of ['state', 'roster', 'policy', 'person', 'offer', 'spending-policy', 'vault-info', 'vendor']) {
      expect(mayFile({ role: 'initiator' }), kind).not.toContain(kind);
    }
  });

  it('every signer role, and a seat with no role set, may invite; a reader role may not', () => {
    /* RED WHEN: an approver or an initiator can no longer invite, withdraw an invitation or re-issue one, or a reader or a role nothing defines can. */
    for (const role of ['admin', 'approver', 'initiator'] as const) expect(mayInvite({ role }), role).toBe(true);
    expect(mayInvite({ role: null })).toBe(true);
    for (const role of ['limited', 'accountant'] as const) expect(mayInvite({ role }), role).toBe(false);
  });

  it('every signer role files the read grants, since each signer at the seat bar signs a change of them by filing it', () => {
    /* RED WHEN: a signer at the seat bar cannot add its signature to a change of the read grants, so the bar can never be met. */
    for (const role of SIGNER_ROLES) expect(MAY_FILE[role], role).toContain('grants');
    for (const role of READER_ROLES) expect(MAY_FILE[role], role).not.toContain('grants');
  });
});
