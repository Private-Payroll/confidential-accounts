/**
 * **WHAT A SIGNER SEAT MAY DO WITH THE COMPANY'S RUNS, AS ITS LEAF COMMITS TO IT.**
 *
 * A seat's leaf on the company's account commits to a scope: `allVaults()`, every right on every vault, or the hash
 * of a rights record (`rightsScopeOf`), which every run the seat raises, approves or holds opens inside its proof.
 * The rights a seat is offered follow its role (`RIGHTS_PRESET`), on every vault or on up to four named ones; an admin
 * on every vault is seated with `allVaults()`. The hashes are worked out here as the account's own circuits work them
 * out, so the page, the wallet and the service read the same scope without the compiled contract.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, type Hex } from './crypto.js';
import { isReaderRole, isSignerRole, RIGHTS_PRESET, type Role, type SignerRole } from './roles.js';
import { EVERY_RIGHT, type SeatRights } from './vault-approvers.js';

/** A rights record as a leaf's scope commits to it: the run rights, and every vault or the vaults named. */
export interface RightsRecord {
  readonly mayRaise: boolean;
  readonly mayApprove: boolean;
  readonly mayHold: boolean;
  readonly everyVault: boolean;
  /** The vaults named, as 32-byte hex addresses; none when the record is for every vault. */
  readonly vaults: readonly Hex[];
}

/** How many vaults a rights record can name. */
export const RIGHTS_VAULT_PLACES = 4;

const HEX64 = /^[0-9a-f]{64}$/u;

/** A text tag as the account's circuits pad it: its bytes, then zeros, to thirty-two. */
const tagOf = (text: string): Uint8Array => {
  const tag = new Uint8Array(32);
  tag.set(new TextEncoder().encode(text));
  return tag;
};

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu)!.map((b) => parseInt(b, 16)));

/** The scope of a seat that may do everything on every vault (`allVaults`). */
export const ALL_VAULTS: Hex = toHex(sha256(tagOf('midnight-accounts:scope:all')));

/** The vault a company-wide run names (`companyWide`): no rights record names it, since nearly every vault may pay it. */
export const COMPANY_WIDE: Hex = toHex(sha256(tagOf('midnight-accounts:vault:company')));

/**
 * The scope a leaf commits to for `rights` (`rightsScopeOf`): the hash of the record's tag, its three run rights and
 * whether it covers every vault, one byte each, and its four vault places, an unused one as thirty-two zero bytes.
 */
export const rightsScopeOf = (rights: RightsRecord): Hex => {
  const places = [...rights.vaults.map((v) => bytesOf(v.toLowerCase())), ...Array.from({ length: RIGHTS_VAULT_PLACES }, () => new Uint8Array(32))]
    .slice(0, RIGHTS_VAULT_PLACES);
  const flags = Uint8Array.from([rights.mayRaise, rights.mayApprove, rights.mayHold, rights.everyVault].map((b) => (b ? 1 : 0)));
  const all = new Uint8Array(32 + flags.length + 32 * RIGHTS_VAULT_PLACES);
  all.set(tagOf('midnight-accounts:rights:'), 0);
  all.set(flags, 32);
  places.forEach((p, i) => all.set(p, 32 + flags.length + 32 * i));
  return toHex(sha256(all));
};

/**
 * Why `vaults` is not a list of vaults a rights record can name, or null when it is. Absent means every vault; a list
 * names one to four distinct vault addresses, never the company-wide one, which only a seat on every vault covers.
 */
export const vaultsRefusal = (vaults: unknown): string | null => {
  if (vaults === undefined) return null;
  if (!Array.isArray(vaults) || vaults.length === 0) return 'the vaults it names are not a list of at least one vault; leave them out for every vault';
  if (vaults.length > RIGHTS_VAULT_PLACES) return `it names ${vaults.length} vaults, and a seat's rights name at most ${RIGHTS_VAULT_PLACES}; offer every vault, or name fewer`;
  if (!vaults.every((v) => typeof v === 'string' && HEX64.test(v))) return 'a vault it names is not a vault\'s address of thirty-two bytes of lower-case hex';
  if (new Set(vaults).size !== vaults.length) return 'it names one vault twice';
  if (vaults.includes(COMPANY_WIDE)) return 'it names company-wide runs as if they were one vault; offer every vault, which covers them, or name the vaults themselves';
  return null;
};

/** The rights record a seat of `role` is offered on `vaults`, or on every vault when none are named. */
export const rightsOfRole = (role: SignerRole, vaults?: readonly Hex[]): RightsRecord => ({
  ...RIGHTS_PRESET[role], everyVault: vaults === undefined, vaults: vaults === undefined ? [] : vaults.map((v) => v.toLowerCase() as Hex),
});

/**
 * The rights record a seat of `role` holds on `vaults`, or null for an admin on every vault, which is seated with
 * `allVaults()` and needs no record on its device.
 */
export const seatRightsRecordOf = (role: SignerRole, vaults?: readonly Hex[]): RightsRecord | null =>
  role === 'admin' && vaults === undefined ? null : rightsOfRole(role, vaults);

/** The scope a leaf of a seat of `role` on `vaults` commits to: `allVaults()` for an admin on every vault. */
export const scopeOfRole = (role: SignerRole, vaults?: readonly Hex[]): Hex => {
  const record = seatRightsRecordOf(role, vaults);
  return record === null ? ALL_VAULTS : rightsScopeOf(record);
};

/**
 * **WHY A SEAT OF `role` ON `vaults` MAY NOT BE SEATED WITH `scope`**, or null when it may. A reader role holds no seat
 * on the chain, so no leaf is made for it. A signer role's scope must be exactly the one its role gives on those
 * vaults, so a seat never holds on the chain a right its role does not give. Every such refusal is cleared by inviting
 * the person again, at the role's own rights.
 */
export const seatScopeRefusal = (role: Role, vaults: readonly Hex[] | undefined, scope: string): string | null => {
  if (isReaderRole(role)) {
    return 'limited and accountant people read the company\'s records and hold no seat, so nobody is seated as one. Giving read '
      + 'access is not on a screen yet';
  }
  if (!isSignerRole(role)) return 'the role it names is not one a seat of a company can hold';
  const vaultsWrong = vaultsRefusal(vaults);
  if (vaultsWrong !== null) return vaultsWrong;
  if (String(scope).toLowerCase() !== scopeOfRole(role, vaults)) {
    return `the rights the seat carries are not the ones an ${role} is given on ${vaults === undefined ? 'every vault' : 'the vaults it names'}; `
      + 'invite the person again at the rights of their role';
  }
  return null;
};

/** A seat counted on no vault: what the count gives a scope it cannot open. */
export const NO_VAULT_COUNTED: SeatRights = Object.freeze({ every: false, mayApprove: false, everyVault: false, onVaults: [] }) as SeatRights;

/**
 * **WHO A SEAT COUNTS AS ABLE TO APPROVE**, read from its leaf's `scope` and the rights record it was seated with:
 * every right for `allVaults()`; the record's own for a record whose hash is the scope; and no vault for anything
 * else, so a seat whose rights this device cannot open never counts as an approver.
 */
export const countedRightsOf = (scope: string, record: RightsRecord | null): SeatRights => {
  const s = String(scope).toLowerCase();
  if (s === ALL_VAULTS) return EVERY_RIGHT;
  if (record === null || rightsScopeOf(record) !== s) return NO_VAULT_COUNTED;
  return { every: false, mayApprove: record.mayApprove, everyVault: record.everyVault, onVaults: [...record.vaults] };
};

/**
 * The rights record a seat invited at `invited.role` on `invited.vaults` holds once its leaf commits to `scope`, for
 * its own device to prove runs with; null for an admin on every vault, which needs none, and for a scope that is not
 * its role's, which the company's directory refuses to believe.
 */
export const rightsRecordFor = (invited: { readonly role: Role; readonly vaults?: readonly Hex[] }, scope: string): RightsRecord | null =>
  (isSignerRole(invited.role) && String(scope).toLowerCase() === scopeOfRole(invited.role, invited.vaults)
    ? seatRightsRecordOf(invited.role, invited.vaults) : null);

/**
 * Who a seat invited at `invited.role` on `invited.vaults` counts as able to approve, once its leaf commits to `scope`:
 * its role's rights where the scope is theirs, and no vault where it is not or the role is no signer's.
 */
export const invitedSeatRightsOf = (invited: { readonly role: Role; readonly vaults?: readonly Hex[] }, scope: string): SeatRights =>
  countedRightsOf(scope, isSignerRole(invited.role) ? seatRightsRecordOf(invited.role, invited.vaults) : null);

/**
 * **WHY AN INVITING SEAT MAY NOT OFFER `vaults`**, or null when it may: a seat at every vault offers any vaults or every
 * vault; any other seat offers only vaults it holds itself, and never every vault. The one rule every path that signs a
 * signer invitation asks, and the directory's claim with it.
 */
export const vaultsOfferedRefusal = (own: SeatRights, vaults: readonly Hex[] | undefined): string | null => {
  if (own.every === true || own.everyVault) return null;
  if (vaults !== undefined && vaults.every((v) => own.onVaults.includes(v.toLowerCase() as Hex))) return null;
  return 'it offers vaults beyond the ones the inviting seat holds itself; a signer whose rights reach those vaults, or every vault, invites the person';
};
