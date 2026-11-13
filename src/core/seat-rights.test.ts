import { describe, expect, it } from 'vitest';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { fromHex, toHex, type Hex } from './crypto.js';
import { SIGNER_ROLES } from './roles.js';
import {
  ALL_VAULTS, COMPANY_WIDE, countedRightsOf, NO_VAULT_COUNTED, rightsOfRole, rightsScopeOf, scopeOfRole, seatScopeRefusal,
  vaultsRefusal, type RightsRecord,
} from './seat-rights.js';
import { EVERY_RIGHT } from './vault-approvers.js';

const vault = (n: number): Hex => toHex(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : i === 31 ? 7 : 0)));
const VAULT_SETS: ReadonlyArray<readonly Hex[] | undefined> = [undefined, [vault(1)], [vault(1), vault(2), vault(3), vault(4)]];

const compiled = (r: RightsRecord): Hex => {
  const vaults = [...r.vaults.map((v) => fromHex(v)), ...Array.from({ length: 4 }, () => new Uint8Array(32))].slice(0, 4);
  return toHex(pureCircuits.rightsScopeOf({ mayRaise: r.mayRaise, mayApprove: r.mayApprove, mayHold: r.mayHold, everyVault: r.everyVault, vaults }));
};

describe('a seat\'s scope is worked out on any device exactly as the account\'s circuits work it out', () => {
  it('every role\'s rights, on every vault, one vault and four, hash to the scope the contract computes', () => {
    /* RED WHEN: the page or the wallet works out another scope than the leaf commits to, so a seated signer is judged by rights it does not hold. */
    for (const role of SIGNER_ROLES) {
      for (const vaults of VAULT_SETS) {
        const record = rightsOfRole(role, vaults);
        expect(rightsScopeOf(record), `${role} on ${vaults?.length ?? 'every'} vault(s)`).toBe(compiled(record));
      }
    }
  });

  it('the scope of every vault and the company-wide vault are the contract\'s own', () => {
    /* RED WHEN: an admin on every vault is judged by another scope than allVaults(), or the company-wide vault is not recognised. */
    expect(ALL_VAULTS).toBe(toHex(pureCircuits.allVaults()));
    expect(COMPANY_WIDE).toBe(toHex(pureCircuits.companyWide()));
  });
});

describe('the rights a seat is offered follow its role', () => {
  it('an admin on every vault is seated with every right; every other role and every vault list with its own record', () => {
    /* RED WHEN: an approver or an initiator is seated with allVaults(), and holds on the chain every right its role does not give. */
    expect(scopeOfRole('admin')).toBe(ALL_VAULTS);
    expect(scopeOfRole('approver')).not.toBe(ALL_VAULTS);
    expect(scopeOfRole('initiator')).not.toBe(ALL_VAULTS);
    expect(scopeOfRole('admin', [vault(1)])).toBe(rightsScopeOf(rightsOfRole('admin', [vault(1)])));
    expect(rightsOfRole('approver')).toMatchObject({ mayRaise: false, mayApprove: true, mayHold: true, everyVault: true });
    expect(rightsOfRole('initiator')).toMatchObject({ mayRaise: true, mayApprove: false, mayHold: false, everyVault: true });
  });

  it('a scope other than the role\'s own is refused, with the way to clear it', () => {
    /* RED WHEN: an approver invited at allVaults(), or at another role's rights, is accepted. */
    expect(seatScopeRefusal('approver', undefined, ALL_VAULTS)).toMatch(/invite the person again at the rights of their role/u);
    expect(seatScopeRefusal('initiator', undefined, scopeOfRole('approver'))).toMatch(/not the ones an initiator is given/u);
    expect(seatScopeRefusal('admin', undefined, rightsScopeOf(rightsOfRole('admin')))).not.toBeNull();
    expect(seatScopeRefusal('approver', [vault(1)], scopeOfRole('approver'))).not.toBeNull();
    for (const role of SIGNER_ROLES) for (const vaults of VAULT_SETS) expect(seatScopeRefusal(role, vaults, scopeOfRole(role, vaults))).toBeNull();
  });

  it('a reader role is never seated on the chain', () => {
    /* RED WHEN: a limited or accountant seat is given a leaf. */
    expect(seatScopeRefusal('limited', undefined, ALL_VAULTS)).toMatch(/hold no seat, so nobody is seated as one\. Read access is given on the Roles tab in Settings$/u);
    expect(seatScopeRefusal('accountant', undefined, ALL_VAULTS)).toMatch(/hold no seat, so nobody is seated as one/u);
  });

  it('a vault list the chain could not hold is refused', () => {
    /* RED WHEN: rights naming five vaults, the company-wide vault, one vault twice or none at all are offered. */
    expect(vaultsRefusal([vault(1), vault(2), vault(3), vault(4), vault(5)])).toMatch(/at most 4/u);
    expect(vaultsRefusal([COMPANY_WIDE])).toMatch(/company-wide/u);
    expect(vaultsRefusal([vault(1), vault(1)])).toMatch(/twice/u);
    expect(vaultsRefusal([])).toMatch(/at least one/u);
    expect(vaultsRefusal(['AB'])).toMatch(/thirty-two bytes/u);
    expect(vaultsRefusal(undefined)).toBeNull();
  });
});

describe('a seat is counted as approving only where its own rights let it', () => {
  it('every right for allVaults(), the record\'s own vaults for its scope, and no vault for a record that is not the scope\'s', () => {
    /* RED WHEN: a seat scoped to one vault is counted on another, or a seat whose record does not open its scope is counted at all. */
    expect(countedRightsOf(ALL_VAULTS, null)).toBe(EVERY_RIGHT);
    const one = rightsOfRole('approver', [vault(1)]);
    expect(countedRightsOf(rightsScopeOf(one), one)).toEqual({ every: false, mayApprove: true, everyVault: false, onVaults: [vault(1)] });
    expect(countedRightsOf(rightsScopeOf(one), rightsOfRole('approver', [vault(2)]))).toBe(NO_VAULT_COUNTED);
    expect(countedRightsOf(rightsScopeOf(one), null)).toBe(NO_VAULT_COUNTED);
  });
});
