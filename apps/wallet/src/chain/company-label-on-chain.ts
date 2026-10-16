import { ContractState } from '@midnightntwrk/ledger-v9';
import { PAY_KEY_COMMITMENT_ENTRY } from 'midnight-identity/profile/records-key';
import type { AccountHolders, AccountPaymentFacts, AccountRoleEntry, AccountSeats, VaultHolders } from 'midnight-identity/profile/records-key';
import { COMPANY_LABEL_ENTRY, companyLabelOf, readAccountAddress, readVaultAddress } from 'midnight-identity/profile/company-label';
import {
  ACCOUNT_THRESHOLD_FIELD, ADOPTED_VAULTS_FIELD, as32, holdersInAccountState, ROLES_FIELD, SIGNER_LEAVES_FIELD, seatsInAccountState,
  vaultsInAccountState,
} from 'midnight-identity/profile/account-state';
import { authorityIn } from 'midnight-identity/profile/contract-authority';
import type { ContractAuthority } from 'midnight-identity/profile/contract-authority';
import type { ChainRead, ContractOnTheChain } from 'midnight-identity/profile/committee-sign';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';

/**
 * **THE WALLET READS A COMPANY'S LABEL OFF ITS ACCOUNT ITSELF.**
 *
 * Every key a signer holds for a company is derived from the company's label,
 * and a page asking for keys or a signature names the label and the account it
 * says carries it. Nothing on the chain stops a second account being deployed
 * with a label somebody learned from the first, so a label and an address
 * named together by a page are a claim. **This is where the claim is checked:
 * over this wallet's own connection to the indexer, not the page's and not the
 * page's service.** The account's constructor wrote the label into its shared
 * map of roles when it was deployed, and that entry is what is read here.
 *
 * A read that fails is never an answer. The screens give nothing and sign
 * nothing for an account until this says the account carries the label asked
 * about.
 *
 * **What the indexer learns** is that this wallet asked about that account's
 * address, as it learns from any read; the label is not sent.
 */

/* Read off an account's state where the wallet and a device both read them (`midnight-identity/profile/account-state`). */
export { ACCOUNT_THRESHOLD_FIELD, ADOPTED_VAULTS_FIELD, holdersInAccountState, ROLES_FIELD, SIGNER_LEAVES_FIELD, seatsInAccountState };

/** Where the account's record of payments sits among the fields of its public state. */
export const MOVEMENTS_FIELD = 4;

/** Where the account's map of the proposals it holds open sits among the fields of its public state. */
export const OPEN_PROPOSALS_FIELD = 2;

/** Where a vault's public state names the account it is pinned to: written once, by its constructor. */
export const VAULT_ACCOUNT_FIELD = 0;

/** How many fields a vault's public state has, as this product deploys one. */
export const VAULT_FIELDS = 14;

/**
 * **WHO HOLDS THE ACCOUNT, AS THIS WALLET READ IT FROM THE CHAIN**: the keys of
 * its maintenance committee and their threshold, and every seat the account
 * holds now. Read in the same answer as the label, so they are of one block. A
 * page checks every key a vault's secret is sealed to against this, and this is
 * the one copy of it no service handed over.
 */
export type SeatsOnChain = AccountSeats;

export type LabelOnAccount =
  /** The account exists and carries this label; `seats` is who holds it, read in the same answer. */
  | { readonly of: 'carries'; readonly label: CompanyLabel; readonly seats?: SeatsOnChain }
  /** The indexer knows no contract at that address. */
  | { readonly of: 'no-account' }
  /** A contract is there and carries no label: not a company's account as this product deploys one. */
  | { readonly of: 'no-label' }
  /** The read did not come back, or came back as something that is not a contract's state. */
  | { readonly of: 'unreadable'; readonly why: string };

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
const ENTRY = bytesOf(COMPANY_LABEL_ENTRY);

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * **THE LABEL AN ACCOUNT'S SERIALISED STATE CARRIES**, or `null` when it
 * carries none. Throws when the bytes are not a contract's state, or not one
 * laid out as a company's account is.
 */
export function labelInAccountState(serialized: Uint8Array): CompanyLabel | null {
  const state = ContractState.deserialize(serialized);
  const fields = state.data.state.asArray();
  if (fields === undefined || fields.length <= ROLES_FIELD) {
    throw new Error('that contract\'s state is not laid out as a company\'s account.');
  }
  const roles = fields[ROLES_FIELD]!.asMap();
  if (roles === undefined) throw new Error('that contract\'s state is not laid out as a company\'s account.');
  for (const key of roles.keys()) {
    const k = as32(key.value[0]);
    if (k === null || !same(k, ENTRY)) continue;
    const cell = roles.get(key);
    /* A value that is not a cell is not how this contract writes its label. */
    const inner = cell === undefined ? undefined : (cell.asCell() as ReturnType<typeof cell.asCell> | undefined);
    if (cell !== undefined && inner === undefined) throw new Error('that contract\'s state is not laid out as a company\'s account.');
    const value = inner === undefined ? null : as32(inner.value[0]);
    if (value === null || value.every((b) => b === 0)) return null;
    return companyLabelOf(value);
  }
  return null;
}

/**
 * **WHAT AN ACCOUNT RECORDS ABOUT PAYMENTS, FROM ITS SERIALISED STATE**, for
 * the entries asked about: which of them its record of payments holds, in the
 * order asked, and the commitment its map of roles holds to the company's
 * pay-record key, or null when it holds none; and from the same state every
 * proposal it holds open and how many entries its record of payments holds.
 * Throws when the bytes are not a contract's state laid out as a company's
 * account is.
 */
export function paymentsInAccountState(serialized: Uint8Array, asked: readonly string[]): AccountPaymentFacts {
  const fields = ContractState.deserialize(serialized).data.state.asArray();
  const notAnAccount = 'that contract\'s state is not laid out as a company\'s account.';
  if (fields === undefined || fields.length <= ROLES_FIELD) throw new Error(notAnAccount);
  const movements = fields[MOVEMENTS_FIELD]!.asMap();
  const roles = fields[ROLES_FIELD]!.asMap();
  const open = fields[OPEN_PROPOSALS_FIELD]!.asMap();
  if (movements === undefined || roles === undefined || open === undefined) throw new Error(notAnAccount);
  const recorded = new Set<string>();
  for (const key of movements.keys()) {
    const entry = as32(key.value[0]);
    if (entry === null) throw new Error(notAnAccount);
    recorded.add(hexOf32(entry));
  }
  const openRounds: string[] = [];
  for (const key of open.keys()) {
    const id = as32(key.value[0]);
    if (id === null) throw new Error(notAnAccount);
    openRounds.push(hexOf32(id));
  }
  let payKeyCommitment: string | null = null;
  for (const key of roles.keys()) {
    const k = as32(key.value[0]);
    if (k === null || hexOf32(k) !== PAY_KEY_COMMITMENT_ENTRY) continue;
    const cell = roles.get(key);
    const inner = cell === undefined ? undefined : (cell.asCell() as ReturnType<typeof cell.asCell> | undefined);
    const value = inner === undefined ? null : as32(inner.value[0]);
    if (value === null) throw new Error(notAnAccount);
    payKeyCommitment = hexOf32(value);
  }
  return Object.freeze({
    payKeyCommitment, held: Object.freeze(asked.filter((e) => recorded.has(e))),
    openRounds: Object.freeze(openRounds.sort()), entries: recorded.size,
  });
}

const hexOf32 = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * **WHAT AN ACCOUNT HOLDS UNDER ENTRIES OF ITS MAP OF ROLES, FROM ITS
 * SERIALISED STATE**, for the entries asked about, in the order asked: the
 * thirty-two bytes held under each, or null where it holds nothing. Throws
 * when the bytes are not a contract's state laid out as a company's account
 * is, or an entry holds something that is not thirty-two bytes.
 */
export function rolesInAccountState(serialized: Uint8Array, asked: readonly string[]): readonly AccountRoleEntry[] {
  const fields = ContractState.deserialize(serialized).data.state.asArray();
  const notAnAccount = 'that contract\'s state is not laid out as a company\'s account.';
  if (fields === undefined || fields.length <= ROLES_FIELD) throw new Error(notAnAccount);
  const roles = fields[ROLES_FIELD]!.asMap();
  if (roles === undefined) throw new Error(notAnAccount);
  const wanted = new Set(asked);
  const held = new Map<string, string>();
  for (const key of roles.keys()) {
    const k = as32(key.value[0]);
    if (k === null) throw new Error(notAnAccount);
    const entry = hexOf32(k);
    if (!wanted.has(entry)) continue;
    const cell = roles.get(key);
    const inner = cell === undefined ? undefined : (cell.asCell() as ReturnType<typeof cell.asCell> | undefined);
    const value = inner === undefined || inner.value.length !== 1 ? null : as32(inner.value[0]);
    if (value === null) throw new Error(notAnAccount);
    held.set(entry, hexOf32(value));
  }
  return Object.freeze(asked.map((key) => Object.freeze({ key, value: held.get(key) ?? null })));
}

/**
 * **WHO HOLDS A VAULT, AND WHICH ACCOUNT IT IS PINNED TO, FROM ITS SERIALISED
 * STATE.** The committee and threshold are the vault's own maintenance
 * authority, read exactly as an account's are; the account is the one its
 * constructor wrote. Throws when the bytes are not a contract's state laid out
 * as a vault is, and when `authorityIn` refuses the state's authority, saying
 * why.
 */
export function vaultInState(vault: VaultAddress, serialized: Uint8Array): VaultHolders {
  const { account, authority } = vaultPartsIn(serialized);
  return Object.freeze({ vault: String(vault), account, committee: authority.committee, threshold: authority.threshold });
}

/** The account a vault's state is pinned to and its authority, each read once; throws as `vaultInState` says. */
function vaultPartsIn(serialized: Uint8Array): { readonly account: string; readonly authority: ContractAuthority } {
  const state = ContractState.deserialize(serialized);
  const fields = state.data.state.asArray();
  const notAVault = 'that contract\'s state is not laid out as a company\'s vault.';
  if (fields === undefined || fields.length !== VAULT_FIELDS) throw new Error(notAVault);
  const field = fields[VAULT_ACCOUNT_FIELD]!;
  const cell = field.asCell() as ReturnType<typeof field.asCell> | undefined;
  /* The account is a reference to a contract: one thirty-two byte address, which is all the cell holds. */
  const account = cell === undefined || cell.value.length !== 1 ? null : as32(cell.value[0]);
  if (account === null || account.every((b) => b === 0)) throw new Error(notAVault);
  const authority = authorityIn(state);
  if ('why' in authority) throw new Error(notAVault.slice(0, -1) + ': ' + authority.why);
  return { account: Array.from(account, (b) => b.toString(16).padStart(2, '0')).join(''), authority };
}

/**
 * **ONE CONTRACT A COMMITTEE ASK NAMES, FROM ITS SERIALISED STATE**: who holds
 * it, its counter, for a vault the account its constructor pinned it to, and
 * for the account every vault it lists, adopted and retired.
 * The company's account is the contract at `account`'s address and every
 * other address is read as a vault, so which rules a contract is judged by
 * comes from its address and never from what a page calls it. Throws when the
 * bytes are not laid out as that contract is.
 */
export function contractInState(address: string, account: AccountAddress, serialized: Uint8Array): ContractOnTheChain {
  if (address === account) {
    const authority = authorityIn(ContractState.deserialize(serialized));
    if ('why' in authority) throw new Error('that contract\'s state is not laid out as a company\'s account: ' + authority.why);
    return Object.freeze({
      of: 'read', committee: authority.committee, threshold: authority.threshold, counter: authority.counter, pinnedTo: null,
      vaults: vaultsInAccountState(serialized),
    });
  }
  const { account: pinnedTo, authority } = vaultPartsIn(serialized);
  return Object.freeze({ of: 'read', committee: authority.committee, threshold: authority.threshold, counter: authority.counter, pinnedTo });
}

/**
 * Reads every contract at `addresses` through `read`, the indexer this wallet
 * reads its own balance from, for a committee ask about `account`. Never
 * throws: a failed read, no contract, or a state that does not read is
 * `unreadable`, and nothing is signed for it.
 */
export async function contractsOnChain(account: AccountAddress, addresses: readonly string[], read: ContractStateHex): Promise<ChainRead> {
  const out = new Map<string, ContractOnTheChain>();
  await Promise.all(addresses.map(async (raw) => {
    const address = raw.toLowerCase();
    try {
      const hex = await read(address as AccountAddress);
      out.set(address, hex === null
        ? { of: 'unreadable', why: 'the indexer holds no contract at that address.' }
        : contractInState(address, account, bytesOf(hex)));
    } catch (e) {
      out.set(address, { of: 'unreadable', why: e instanceof Error ? e.message : 'the read did not come back.' });
    }
  }));
  return out;
}

export type VaultOnChain =
  /** The vault exists; who holds it and the account it is pinned to, as read. */
  | { readonly of: 'read'; readonly holders: VaultHolders }
  /** The indexer knows no contract at that address. */
  | { readonly of: 'no-vault' }
  /** The read did not come back, or came back as something that is not a vault's state. */
  | { readonly of: 'unreadable'; readonly why: string };

/** Reads who holds the vault at `vault`. Never throws: a failed read is `unreadable`. */
export async function vaultOnChain(vault: VaultAddress, read: ContractStateHex): Promise<VaultOnChain> {
  if (readVaultAddress(vault) === null) return { of: 'unreadable', why: 'that is not a vault\'s address.' };
  let hex: string | null;
  try {
    hex = await read(vault as unknown as AccountAddress);
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the read did not come back.' };
  }
  if (hex === null) return { of: 'no-vault' };
  try {
    return { of: 'read', holders: vaultInState(vault, bytesOf(hex)) };
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the state did not read.' };
  }
}

/** What the read goes through: the indexer's own answer for one contract, as hex, or null. */
export type ContractStateHex = (account: AccountAddress) => Promise<string | null>;

const QUERY = 'query ($address: HexEncoded!) { contract(address: $address) { state } }';

/** The read through one indexer: the screens pass the one this wallet reads its own balance from. */
export const fromIndexerAt = (indexerUri: string): ContractStateHex => async (account) => {
  const response = await fetch(indexerUri, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { address: account } }),
  });
  if (!response.ok) throw new Error(`the indexer answered ${response.status}.`);
  const body = await response.json() as { data?: { contract?: { state?: unknown } | null }; errors?: unknown };
  if (body.errors !== undefined) throw new Error('the indexer refused the read.');
  const state = body.data?.contract?.state;
  /* An action that left no state is not a contract this read can say anything about: no contract, not unreadable. */
  if (state === undefined || state === null || state === '') return null;
  if (typeof state !== 'string' || !/^([0-9a-fA-F]{2})+$/u.test(state)) throw new Error('the indexer answered with something that is not a state.');
  return state;
};

/** What the read of a deploy goes through: the state the contract's deploy left, as hex, or null when the indexer has none. */
export type DeployStateHex = (account: AccountAddress) => Promise<string | null>;

const DEPLOY_QUERY = 'query ($address: HexEncoded!) { contract(address: $address) { actions(type: DEPLOY, limit: 1) { state } } }';

/**
 * The read of a contract's deploy through one indexer: the screens pass the one
 * this wallet reads its own balance from. A contract is deployed once, so the
 * one deploy action the indexer holds for it is the deploy, however many calls
 * and updates came after.
 */
export const deployFromIndexerAt = (indexerUri: string): DeployStateHex => async (account) => {
  const response = await fetch(indexerUri, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: DEPLOY_QUERY, variables: { address: account } }),
  });
  if (!response.ok) throw new Error(`the indexer answered ${response.status}.`);
  const body = await response.json() as { data?: { contract?: { actions?: unknown } | null }; errors?: unknown };
  if (body.errors !== undefined) throw new Error('the indexer refused the read.');
  const contract = body.data?.contract;
  if (contract === undefined || contract === null) return null;
  const actions = contract.actions;
  if (!Array.isArray(actions) || actions.length !== 1) throw new Error('the indexer did not answer with the account\'s one deploy.');
  const state = (actions[0] as { state?: unknown } | null)?.state;
  if (typeof state !== 'string' || !/^([0-9a-fA-F]{2})+$/u.test(state)) throw new Error('the indexer answered with something that is not a state.');
  return state;
};

/**
 * **THE SEAT AN ACCOUNT'S DEPLOY SEATED, AND THE COMMITTEE IT WAS HELD BY**:
 * the one leaf in the set of seated signers' leaves of the state the deploy
 * left, and the deploy's maintenance committee, for an account carrying
 * `label`. A company's account is deployed with exactly one seat, its founding
 * signer's, held by that signer's own committee key; both stay the founding
 * signer's whoever is removed or seated after. Throws when the bytes are not a
 * company's account as deployed: another label, not exactly one seat, or held
 * by no committee.
 */
export function foundingInDeployState(serialized: Uint8Array, label: CompanyLabel): {
  readonly seat: string; readonly committee: readonly { readonly tag: string; readonly value: string }[];
} {
  if (labelInAccountState(serialized) !== label) throw new Error('the account\'s deploy does not carry this company\'s label.');
  const { seats, committee } = seatsInAccountState(serialized);
  if (seats.length !== 1) throw new Error('the account\'s deploy did not seat exactly one signer.');
  if (committee.length === 0) throw new Error('the account\'s deploy was held by no committee.');
  return { seat: seats[0]!, committee };
}

/** Reads the label the account at `account` carries. Never throws: a failed read is `unreadable`. */
export async function labelOnAccount(account: AccountAddress, read: ContractStateHex): Promise<LabelOnAccount> {
  if (readAccountAddress(account) === null) return { of: 'unreadable', why: 'that is not an account\'s address.' };
  let hex: string | null;
  try {
    hex = await read(account);
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the read did not come back.' };
  }
  if (hex === null) return { of: 'no-account' };
  try {
    const bytes = bytesOf(hex);
    const label = labelInAccountState(bytes);
    return label === null ? { of: 'no-label' } : { of: 'carries', label, seats: seatsInAccountState(bytes) };
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the state did not read.' };
  }
}

/** Whether what was read lets a screen give or sign anything for `label` on that account. */
export const accountCarries = (read: LabelOnAccount, label: CompanyLabel): boolean =>
  read.of === 'carries' && read.label === label;

export type HoldersOnChain =
  /**
   * The account exists and carries this label; who holds it and what it has
   * adopted, read in the same answer, with what it records about the payments
   * asked about when any were.
   */
  | {
    readonly of: 'read'; readonly holders: AccountHolders; readonly payments?: AccountPaymentFacts;
    /** What the account holds under the entries of its map of roles asked about, when any were. */
    readonly roles?: readonly AccountRoleEntry[];
  }
  | { readonly of: 'no-account' }
  /** A contract is there and does not carry this label: not this company's account. */
  | { readonly of: 'other-label' }
  | { readonly of: 'unreadable'; readonly why: string };

/**
 * The key the account keeps the approvals a policy change needs under, as 64
 * lower-case hex characters: what the account's own `policyBarKey` makes.
 */
export type PolicyBarKeyRead = () => Promise<string>;

/** The account's own `policyBarKey`, run in this wallet from the compiled contract it already loads. */
export const barKeyOfTheContract: PolicyBarKeyRead = async () => {
  const account = await import('../../../../contracts/managed/contract/index.js') as unknown as {
    pureCircuits: { policyBarKey(): Uint8Array };
  };
  return hexOf32(account.pureCircuits.policyBarKey());
};

/**
 * Reads who holds the account at `account`, which must carry `label`, and the
 * seat its deploy seated (`readDeploy`), with the approvals it asks for, the
 * policy bar's row found under the key `barKey` reads off the compiled
 * contract. Never throws.
 */
export async function holdersOnChain(
  account: AccountAddress, label: CompanyLabel, read: ContractStateHex, readDeploy: DeployStateHex,
  /** Entries of the account's record of payments to say whether it holds, read in the same answer. */
  movements?: readonly string[],
  /** Entries of the account's map of roles to say what it holds under, read in the same answer. */
  roles?: readonly string[],
  barKey: PolicyBarKeyRead = barKeyOfTheContract,
): Promise<HoldersOnChain> {
  if (readAccountAddress(account) === null) return { of: 'unreadable', why: 'that is not an account\'s address.' };
  let hex: string | null;
  let deployHex: string | null;
  let key: string;
  try {
    [hex, deployHex, key] = await Promise.all([read(account), readDeploy(account), barKey()]);
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the read did not come back.' };
  }
  if (hex === null) return { of: 'no-account' };
  try {
    const bytes = bytesOf(hex);
    if (labelInAccountState(bytes) !== label) return { of: 'other-label' };
    /* An account the indexer holds a state for and no deploy is not one this wallet can say who founded. */
    if (deployHex === null) return { of: 'unreadable', why: 'the indexer holds no deploy for that account.' };
    const founding = foundingInDeployState(bytesOf(deployHex), label);
    const holders = { ...holdersInAccountState(bytes, key), founding: founding.seat, foundingCommittee: founding.committee };
    return {
      of: 'read', holders,
      ...(movements === undefined ? {} : { payments: paymentsInAccountState(bytes, movements) }),
      ...(roles === undefined ? {} : { roles: rolesInAccountState(bytes, roles) }),
    };
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the state did not read.' };
  }
}
