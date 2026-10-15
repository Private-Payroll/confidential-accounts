/**
 * **WHO HOLDS A COMPANY'S ACCOUNT, READ OFF ITS SERIALISED STATE**: its
 * maintenance committee and their threshold, every seat it holds, its own
 * approval threshold and the vaults it has adopted. Pure: the bytes in, the
 * holders out, and nothing read from anywhere. The one reading of these fields,
 * for a wallet answering who holds an account and for a device reading what the
 * account held after each of its actions.
 */
import { ContractState } from '@midnightntwrk/ledger-v9';
import { authorityIn } from './contract-authority.js';
import type { AccountHolders, AccountSeats } from './records-key.js';

/** Where the account's shared map of roles sits among the fields of its public state. */
export const ROLES_FIELD = 13;

/** Where the account's set of seated signers' leaves sits among the fields of its public state. */
export const SIGNER_LEAVES_FIELD = 9;

/** Where the account's own approval threshold sits among the fields of its public state. */
export const ACCOUNT_THRESHOLD_FIELD = 5;

/** Where the account's set of adopted vaults sits among the fields of its public state. */
export const ADOPTED_VAULTS_FIELD = 7;

/** Where the account's map of retired vaults, each to the time it was retired, sits among the fields of its public state. */
export const RETIRED_VAULTS_FIELD = 10;

/* A field's bytes as the state holds them may have had trailing zero bytes
 * dropped; thirty-two bytes are put back by padding at the end. */
export const as32 = (value: unknown): Uint8Array | null => {
  if (!(value instanceof Uint8Array) || value.length > 32) return null;
  const out = new Uint8Array(32);
  out.set(value);
  return out;
};

/**
 * **WHO HOLDS AN ACCOUNT, FROM ITS SERIALISED STATE.** The seats come from the
 * account's own set of seated signers; the committee and threshold from
 * `authorityIn`. Throws when the bytes are not laid out as a company's
 * account, or when `authorityIn` refuses the authority, saying why.
 */
export function seatsInAccountState(serialized: Uint8Array): AccountSeats {
  const state = ContractState.deserialize(serialized);
  const fields = state.data.state.asArray();
  const leaves = fields === undefined || fields.length <= SIGNER_LEAVES_FIELD ? undefined : fields[SIGNER_LEAVES_FIELD]!.asMap();
  if (leaves === undefined) throw new Error('that contract\'s state is not laid out as a company\'s account.');
  const seats: string[] = [];
  for (const key of leaves.keys()) {
    const leaf = as32(key.value[0]);
    if (leaf === null) throw new Error('that contract\'s state is not laid out as a company\'s account.');
    seats.push(Array.from(leaf, (b) => b.toString(16).padStart(2, '0')).join(''));
  }
  const authority = authorityIn(state);
  if ('why' in authority) throw new Error('that contract\'s state is not laid out as a company\'s account: ' + authority.why);
  return Object.freeze({ committee: authority.committee, threshold: authority.threshold, seats: Object.freeze(seats) });
}

/**
 * **WHO HOLDS AN ACCOUNT AND WHAT IT HAS ADOPTED, FROM ITS SERIALISED STATE**:
 * everything `seatsInAccountState` reads, the account's own approval threshold
 * (a number the state holds as little-endian bytes with trailing zeros
 * dropped) and every vault in its set of adopted vaults. Throws when the bytes
 * are not a contract's state laid out as a company's account is.
 */
export function holdersInAccountState(serialized: Uint8Array): Omit<AccountHolders, 'founding' | 'foundingCommittee'> {
  const seats = seatsInAccountState(serialized);
  const fields = ContractState.deserialize(serialized).data.state.asArray();
  const notAnAccount = 'that contract\'s state is not laid out as a company\'s account.';
  if (fields === undefined || fields.length <= ROLES_FIELD) throw new Error(notAnAccount);
  const thresholdField = fields[ACCOUNT_THRESHOLD_FIELD]!;
  const cell = thresholdField.asCell() as ReturnType<typeof thresholdField.asCell> | undefined;
  const raw = cell === undefined || cell.value.length !== 1 ? null : cell.value[0];
  if (!(raw instanceof Uint8Array) || raw.length > 8) throw new Error(notAnAccount);
  let approvals = 0;
  for (let i = raw.length - 1; i >= 0; i -= 1) approvals = approvals * 256 + raw[i]!;
  if (!Number.isSafeInteger(approvals) || approvals < 1) throw new Error(notAnAccount);
  return Object.freeze({ ...seats, approvals, adoptedVaults: Object.freeze(vaultsInField(fields, ADOPTED_VAULTS_FIELD)) });
}

/** Every vault address a set or map field of the account's state lists, in the order the state holds them. */
function vaultsInField(fields: readonly { asMap(): unknown }[], index: number): string[] {
  const notAnAccount = 'that contract\'s state is not laid out as a company\'s account.';
  const map = fields[index]?.asMap() as { keys(): Iterable<{ value: unknown[] }> } | undefined;
  if (map === undefined) throw new Error(notAnAccount);
  const vaults: string[] = [];
  for (const key of map.keys()) {
    const v = as32(key.value[0]);
    if (v === null) throw new Error(notAnAccount);
    vaults.push(Array.from(v, (b) => b.toString(16).padStart(2, '0')).join(''));
  }
  return vaults;
}

/**
 * **EVERY VAULT A COMPANY'S ACCOUNT LISTS, FROM ITS SERIALISED STATE**: each it
 * adopted and each it retired, once. These are the company's contracts beside
 * the account itself, as the chain holds them. Throws when the bytes are not a
 * contract's state laid out as a company's account is.
 */
export function vaultsInAccountState(serialized: Uint8Array): readonly string[] {
  const fields = ContractState.deserialize(serialized).data.state.asArray();
  if (fields === undefined || fields.length <= ROLES_FIELD) throw new Error('that contract\'s state is not laid out as a company\'s account.');
  return Object.freeze([...new Set([...vaultsInField(fields, ADOPTED_VAULTS_FIELD), ...vaultsInField(fields, RETIRED_VAULTS_FIELD)])]);
}
