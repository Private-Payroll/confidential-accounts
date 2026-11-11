/*
 * What this wallet keeps of each role change it started, and the only writes of it in the saved keys: kept when the
 * seat's removal is raised, and taken out once the invitation that follows it is raised.
 */
import type { SignerRole } from '../../../src/core/roles.js';
import type { Keyring } from './keyring-blob.js';

/**
 * **ONE ROLE CHANGE THIS WALLET STARTED**: the company, the seat, the coin key of the address the person is invited
 * again at, the new role, and the token of the invitation link it is invited under, as the person confirmed them
 * when the seat's removal was raised. The invitation that follows the removal is held to them. Public values only.
 */
export interface RoleChangeKept {
  readonly accountId: string;
  readonly leaf: string;
  readonly coinPublicKey: string;
  readonly role: SignerRole;
  readonly token: string;
}

/** Where a role change of `leaf` on `accountId` is kept in the saved keys. */
export const roleChangeKeyOf = (accountId: string, leaf: string): string => `${accountId}|${leaf.toLowerCase()}`;

/**
 * The saved keys keeping the role change of `leaf` this wallet confirmed when it raised the seat's removal. Raising
 * the same seat's removal again replaces what was kept for it, so there is never more than one entry for a seat.
 */
export const withRoleChangeKept = (k: Keyring, accountId: string, leaf: string, coinPublicKey: string, role: SignerRole, token: string): Keyring => ({
  ...k,
  roleChangesKept: {
    ...(k.roleChangesKept ?? {}),
    [roleChangeKeyOf(accountId, leaf)]: { accountId, leaf: leaf.toLowerCase(), coinPublicKey: coinPublicKey.toLowerCase(), role, token: token.toLowerCase() },
  },
});

/**
 * The saved keys with the role change of `leaf` on `accountId` taken out, once the invitation that follows the removal
 * is raised: the change is carried, and nothing is left to hold a second press to. Saved keys keeping no such change
 * are returned as they are.
 */
export const withRoleChangeDone = (k: Keyring, accountId: string, leaf: string): Keyring => {
  const key = roleChangeKeyOf(accountId, leaf);
  if (k.roleChangesKept?.[key] === undefined) return k;
  const { [key]: _done, ...rest } = k.roleChangesKept;
  return { ...k, roleChangesKept: rest };
};
