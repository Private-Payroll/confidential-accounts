import type { ContractState } from '@midnightntwrk/ledger-v9';
import { base64 } from '@scure/base';
import type { Identity } from 'midnight-identity/keys/derivation';
import { readAccountAddress, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { openEntry, tagAt, type RegistryEntry } from 'midnight-identity/profile/private-registry';
import { networkName, type NetworkName } from 'midnight-identity/network';
import { RELEASED_VERSIONS, type ReleasedContract, type ReleasedVersion } from 'midnight-identity/wallet/released-versions';
import type { Hex } from '../../../../src/core/crypto.js';
import { networkRecord } from '../../../../src/core/networks.js';
import type { LeafScheme } from '../../../../src/core/signer-leaf.js';
import { readContractAuthority, type AuthorityRead } from '../../../../src/midnight/contract-authority-read.js';
import { registryAuthorityRefusal } from '../../../../src/wiring/registry-call-checks.js';
import { seatAt } from '../keyring/seat-at.js';
import type { AccountBuilding } from './account-builder-client.js';
import { bytesOf, contractStateOfHex, publishedBuildOfState, type PublishedBuild } from './published-build.js';
import type { ContractStateHex } from './company-label-on-chain.js';
import { deployFromIndexerAt, fromIndexerAt, holdersOnChain, type HoldersOnChain } from './view-doors.js';

/**
 * **WHAT A PERSON'S ENTRIES IN THE NETWORK'S PRIVATE REGISTRIES SAY, AND WHICH OF THEM THIS WALLET CAN STAND BEHIND.**
 * It finds and judges; it pins nothing, so whoever calls it decides what to keep.
 *
 * Each registry the network's record lists is checked before anything in it is read: it must be held by no keys at
 * threshold exactly one, so no one can change its rules, and its `put` key must be a released version's, in every slot.
 * A registry that is not is passed over and named. Then its state is read once, and the person's tags are looked up in
 * it in order until `ABSENT_IN_A_ROW` tags in a row are absent; each value there that opens under the person's own registry keys is an
 * entry. An entry is believed only when the chain bears it out now: the account carries the entry's label, the seat the
 * entry names (at its own scope or at the every-vault scope) is among the account's seats, and every verifier key of
 * the account is a released version's, circuit by circuit and slot by slot. A seat that has left is believed of
 * nothing. Two believed entries naming different accounts under one label are a clash: both are answered, with both
 * fingerprints, and neither as found.
 *
 * Everything it reads is the chain's, through this wallet's own indexer and builder; nothing comes from our service.
 */

/** How many absent tags in a row end the walk through one registry. */
export const ABSENT_IN_A_ROW = 20;

/** Why a registry the network lists was passed over: held by keys, keys of no released version, or not read. */
export type RegistryPassedOver = 'held' | 'not-released' | 'unread';

/** A company the person's entries name and the chain bears out. */
export interface CompanyFound {
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  readonly fingerprint: string;
  /** The released version the account's keys are. */
  readonly version: number;
  /** Every entry that named this company and this account, in the order found. */
  readonly entries: readonly RegistryEntry[];
}

/** One label under which the person's entries name more than one account, each borne out by the chain. */
export interface LabelClash {
  readonly label: CompanyLabel;
  readonly accounts: readonly { readonly account: AccountAddress; readonly fingerprint: string }[];
}

/** What the find answers. */
export type RegistryFind =
  | { readonly of: 'no-registries'; readonly network: NetworkName }
  | {
    readonly of: 'read';
    readonly companies: readonly CompanyFound[];
    readonly clashes: readonly LabelClash[];
    /** Registries passed over, and accounts whose state or keys could not be read (named by the account's address, `unread`). */
    readonly passedOver: readonly { readonly registry: string; readonly why: RegistryPassedOver }[];
  };

/** Finds and judges a person's entries: `registryEntriesFound` over the reads of one network. */
export type RegistryFinder = (identity: Identity) => Promise<RegistryFind>;

/** What the find reads the chain with. */
export interface RegistryReads {
  /** The registries to read: the network's record's list. */
  readonly registries: readonly string[];
  /** A contract's state at an address, as the indexer serializes it (hex), or null when there is none. */
  readonly state: ContractStateHex;
  /** Who holds the account now, read for the label the entry names. */
  readonly holders: (account: AccountAddress, label: CompanyLabel) => Promise<HoldersOnChain>;
  /** What a registry in `state` (hex) holds at each of `tags`, in order: the value, or null for a tag it does not hold. */
  readonly values: (state: string, tags: readonly string[]) => Promise<readonly (Uint8Array | null)[]>;
  /** How a seat's leaf is made. */
  readonly scheme: () => Promise<LeafScheme>;
  /** The released versions keys are judged against; absent, the wallet's own list. */
  readonly versions?: readonly ReleasedVersion[];
}

/** An entry the chain bears out, with the account it names and the released version that account's keys are. */
interface Believed {
  readonly entry: RegistryEntry;
  readonly account: AccountAddress;
  readonly version: number;
}

const lower = (s: string): string => s.toLowerCase();

/** The contract at `address` as the chain holds it, or null when it holds none, or the read or its reading failed. */
async function stateAt(reads: RegistryReads, address: string): Promise<{ readonly hex: string; readonly state: ContractState } | null> {
  try {
    const hex = await reads.state(address as AccountAddress);
    const state = hex === null ? null : contractStateOfHex(hex);
    return hex === null || state === null ? null : { hex, state };
  } catch {
    /* Nothing is concluded from a read that failed: the caller passes the contract over, never reads it as empty. */
    return null;
  }
}

/** Whether every verifier key of `state` is a released version's, slot by slot; `unchecked` when the keys cannot be read. */
const buildOf = (state: ContractState, address: string, contract: ReleasedContract, reads: RegistryReads): PublishedBuild =>
  publishedBuildOfState(state, address, contract, reads.versions ?? RELEASED_VERSIONS);

/**
 * Why a registry is passed over for its authority, or null when it is held by no keys at threshold exactly one. An
 * authority that could not be read is `unread`, never `held`: nothing is known of who holds it.
 */
export const authorityPassedOver = (read: AuthorityRead): RegistryPassedOver | null =>
  (read.state !== 'read' ? 'unread' : registryAuthorityRefusal(read) === null ? null : 'held');

/** Why the registry at `address` is passed over, or its state as read when it is held by no one and released. */
async function registryChecked(reads: RegistryReads, address: string): Promise<{ readonly hex: string } | { readonly why: RegistryPassedOver }> {
  const at = await stateAt(reads, address);
  if (at === null) return { why: 'unread' };
  const held = authorityPassedOver(await readContractAuthority(async () => at.state, address));
  if (held !== null) return { why: held };
  const build = buildOf(at.state, address, 'registry', reads);
  if (build.of === 'unchecked') return { why: 'unread' };
  return build.of === 'published' ? { hex: at.hex } : { why: 'not-released' };
}

/** Every entry of this person's in the registry in `hex`, by tag, until `ABSENT_IN_A_ROW` tags in a row are absent. */
async function entriesIn(identity: Identity, network: NetworkName, reads: RegistryReads, hex: string): Promise<RegistryEntry[]> {
  const found: RegistryEntry[] = [];
  let absent = 0;
  for (let from = 0; absent < ABSENT_IN_A_ROW; from += ABSENT_IN_A_ROW) {
    const indexes = Array.from({ length: ABSENT_IN_A_ROW }, (_, k) => from + k);
    const values = await reads.values(hex, indexes.map((i) => tagAt(identity, network, i)));
    for (const [k, i] of indexes.entries()) {
      if (absent >= ABSENT_IN_A_ROW) break;
      const value = values[k] ?? null;
      if (value === null) {
        absent += 1;
        continue;
      }
      absent = 0;
      const opened = openEntry(identity, network, i, value);
      if (opened !== null) found.push(opened);
    }
  }
  return found;
}

/**
 * The entry with its account and that account's released version when the chain bears it out now; null when it does
 * not; `unread` when the account's state or keys could not be read, which is not the same as the chain saying no.
 */
async function judged(identity: Identity, reads: RegistryReads, scheme: LeafScheme, entry: RegistryEntry): Promise<Believed | null | 'unread'> {
  const account = readAccountAddress(entry.account);
  if (account === null) return null;
  const held = await reads.holders(account, entry.label);
  if (held.of === 'unreadable') return 'unread';
  if (held.of !== 'read') return null;
  const seat = seatAt(identity, entry.label, entry.n, entry.scope as Hex, scheme);
  const leaves = new Set(held.holders.seats.map(lower));
  if (!leaves.has(lower(seat.leaf)) && !leaves.has(lower(seat.leafAtAll))) return null;
  const at = await stateAt(reads, account);
  if (at === null) return 'unread';
  const build = buildOf(at.state, account, 'account', reads);
  if (build.of === 'unchecked') return 'unread';
  return build.of === 'published' ? { entry, account, version: build.version } : null;
}

/** The believed entries by label: one account under a label is a company found, more than one a clash. */
function companiesOf(believed: readonly Believed[]): { readonly companies: readonly CompanyFound[]; readonly clashes: readonly LabelClash[] } {
  const byLabel = new Map<CompanyLabel, Map<AccountAddress, Believed[]>>();
  for (const b of believed) {
    const accounts = byLabel.get(b.entry.label) ?? new Map<AccountAddress, Believed[]>();
    accounts.set(b.account, [...(accounts.get(b.account) ?? []), b]);
    byLabel.set(b.entry.label, accounts);
  }
  const companies: CompanyFound[] = [];
  const clashes: LabelClash[] = [];
  for (const [label, accounts] of byLabel) {
    const named = [...accounts].map(([account, all]) => ({ account, all, fingerprint: companyFingerprint(label, account) }));
    if (named.length > 1) {
      clashes.push(Object.freeze({ label, accounts: Object.freeze(named.map(({ account, fingerprint }) => Object.freeze({ account, fingerprint }))) }));
      continue;
    }
    const { account, all, fingerprint } = named[0]!;
    companies.push(Object.freeze({ label, account, fingerprint, version: all[0]!.version, entries: Object.freeze(all.map((b) => b.entry)) }));
  }
  return { companies: Object.freeze(companies), clashes: Object.freeze(clashes) };
}

/**
 * The companies this person's entries in the network's private registries name and the chain bears out, the clashes
 * among them, and the registries passed over. A network whose record lists no registry answers so, and reads nothing.
 */
export async function registryEntriesFound(identity: Identity, network: string, reads: RegistryReads): Promise<RegistryFind> {
  const named = networkName(network);
  if (reads.registries.length === 0) return Object.freeze({ of: 'no-registries', network: named });
  const passedOver: { readonly registry: string; readonly why: RegistryPassedOver }[] = [];
  const entries: RegistryEntry[] = [];
  for (const registry of reads.registries) {
    const checked = await registryChecked(reads, registry);
    if ('why' in checked) {
      passedOver.push(Object.freeze({ registry, why: checked.why }));
      continue;
    }
    try {
      entries.push(...await entriesIn(identity, named, reads, checked.hex));
    } catch {
      /* A walk the builder could not finish is a registry not read: it is named, and nothing in it is believed. */
      passedOver.push(Object.freeze({ registry, why: 'unread' }));
    }
  }
  const scheme = entries.length === 0 ? null : await reads.scheme();
  const judgments = scheme === null ? [] : await Promise.all(entries.map(async (e) => ({ entry: e, judgment: await judged(identity, reads, scheme, e) })));
  const believed: Believed[] = [];
  for (const { entry, judgment } of judgments) {
    /* An account that could not be read is named like an unread registry, so nothing is pinned while one is unread. */
    if (judgment === 'unread') passedOver.push(Object.freeze({ registry: entry.account, why: 'unread' }));
    else if (judgment !== null) believed.push(judgment);
  }
  return Object.freeze({ of: 'read', ...companiesOf(believed), passedOver: Object.freeze(passedOver) });
}

/**
 * What the find reads on a network through this wallet's own indexer and builder: the network's registries, each
 * contract's state read once, who holds an account, and what a registry holds at a tag (asked of the builder, which
 * holds the registry as compiled).
 */
export function liveRegistryReads(network: string, indexerUri: string, build: AccountBuilding): RegistryReads {
  const read = fromIndexerAt(indexerUri);
  const states = new Map<string, Promise<string | null>>();
  const state: ContractStateHex = (address) => {
    const was = states.get(lower(address)) ?? read(address);
    states.set(lower(address), was);
    return was;
  };
  return Object.freeze({
    registries: networkRecord(network).registries,
    state,
    holders: (account: AccountAddress, label: CompanyLabel) => holdersOnChain(account, label, state, deployFromIndexerAt(indexerUri)),
    values: async (hex: string, tags: readonly string[]) => (await build({ ask: 'registry-values', registryState: base64.encode(bytesOf(hex)), tags })).values
      .map((v) => (v === null ? null : base64.decode(v))),
    scheme: async () => (await import('../../../../src/midnight/commitments.js')).MidnightCommitments,
  });
}
