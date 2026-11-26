/**
 * The record of frozen facts (`contracts/frozen-facts.json`), read: for each released version, by its version id,
 * what its account, vault and registry hold on the chain and work out, and what the wallet works out to find a
 * person's registry entries. A contract already deployed keeps these facts for good, so every version still in force
 * must keep agreeing with the wallet; the record is written from the build by `add-frozen-facts.ts`, only ever added
 * to, and `the-frozen-facts-hold.test.ts` holds the build to its newest entry and each entry to its own digest.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RELEASED_VERSIONS, type ReleasedVersion } from '../../packages/identity/src/wallet/released-versions.js';
import type { JsonValue } from './values-in-json.js';

/** A compiled description as `contract-info.json` gives it, its largest numbers kept as digits. */
export type CompiledJson = string | number | boolean | null | readonly CompiledJson[] | { readonly [k: string]: CompiledJson };

/** One ledger field: its place, its name, how it is stored, and the shape of what it holds. */
export interface LedgerFieldFact {
  readonly name: string;
  readonly index: number;
  readonly storage: string;
  readonly [k: string]: CompiledJson;
}

/** One derivation on fixed inputs: what it returned, or the words it refused with. */
export interface DerivationFact {
  readonly inputs: readonly JsonValue[];
  readonly output?: JsonValue;
  readonly refused?: string;
}

/** What one contract of a version holds and works out. */
export interface ContractFacts {
  /** Its ledger fields in order, as compiled. */
  readonly fields: readonly LedgerFieldFact[];
  /** How a newly deployed contract stores each field, read off its initial state. */
  readonly slots: readonly string[];
  /** Every pure circuit, run on each fixed input set. */
  readonly derivations: Readonly<Record<string, readonly DerivationFact[]>>;
  /** The fields each proving circuit writes. */
  readonly writes: Readonly<Record<string, readonly string[]>>;
  /** What the contract reads from the device's private state: each witness, its arguments and its result. */
  readonly witnesses: readonly CompiledJson[];
  /** The circuits of other contracts it calls, with their arguments. */
  readonly calls: readonly CompiledJson[];
  /** The names of what a device keeps for this contract, sorted, each with the kind of value it holds. */
  readonly device: Readonly<Record<string, string>>;
}

/** Where a circuit works a derivation out from its own address: the arguments it passes, and the key that gives. */
export interface CallSiteFact {
  readonly in: string;
  readonly args: readonly string[];
  readonly key: string;
}

/** What depends on a contract's own address, worked out at fixed addresses. */
export interface AddressFacts {
  readonly account: string;
  readonly vault: string;
  /** The derivations inside the account's circuits that money paths key on, by the account's compiled code. */
  readonly internal: Readonly<Record<string, DerivationFact>>;
  /** Each place a circuit derives a key from the account's own address. */
  readonly callSites: Readonly<Record<string, readonly CallSiteFact[]>>;
  /** The colour of each receipt the vault at `vault` mints. */
  readonly receiptColours: { readonly payment: string; readonly change: string; readonly retire: string };
}

/** What the wallet works out to find a person's entries in the registry, for one fixed person. */
export interface RegistryWalletFacts {
  readonly secret: string;
  /** Per network: the registry key, the entry-sealing key and the tags at three places. */
  readonly networks: Readonly<Record<string, { readonly registryKey: string; readonly entrySealingKey: string; readonly tags: Readonly<Record<string, string>> }>>;
  /** A sealed entry's parts in bytes: its nonce, its sealed body and the seal's check. */
  readonly layout: { readonly nonce: number; readonly body: number; readonly check: number };
  /** One fixed entry, sealed on one network at one place: what the seal is bound to, and the body it opens to. */
  readonly entry: { readonly network: string; readonly at: number; readonly words: CompiledJson; readonly boundTo: string; readonly body: string };
}

/** Every frozen fact of one released version. */
export interface VersionFacts {
  readonly account: ContractFacts;
  readonly vault: ContractFacts;
  readonly registry: ContractFacts & { readonly inTheWallet: RegistryWalletFacts };
  readonly atAnAddress: AddressFacts;
}

export type RecordedContract = 'account' | 'vault' | 'registry';
export const RECORDED_CONTRACTS: readonly RecordedContract[] = ['account', 'vault', 'registry'];

/** The record, by version id. */
export type FrozenFacts = Readonly<Record<string, VersionFacts>>;

export const FROZEN_FACTS_FILE = join(import.meta.dirname, '..', 'frozen-facts.json');

export const readFrozenFacts = (): FrozenFacts => JSON.parse(readFileSync(FROZEN_FACTS_FILE, 'utf8'));

/** The digest a version's entry is pinned by: SHA-256 over its JSON, in the record's own order. */
export const entryDigestOf = (facts: VersionFacts): string => createHash('sha256').update(JSON.stringify(facts)).digest('hex');

/** The highest version id the record holds; refuses an empty record. */
export function newestVersionIn(record: FrozenFacts): number {
  const versions = Object.keys(record).map(Number);
  if (versions.length === 0) throw new Error('the record of frozen facts holds no version');
  return Math.max(...versions);
}

/** The newest version's facts. */
export const newestFacts = (record: FrozenFacts = readFrozenFacts()): VersionFacts => record[String(newestVersionIn(record))]!;

/**
 * Every recorded version a deployed contract may still be on: released and not withdrawn. Wallets read companies on
 * any of them, so each one's facts are held, not only the newest's.
 */
export function versionsInForce(record: FrozenFacts = readFrozenFacts(), released: readonly ReleasedVersion[] = RELEASED_VERSIONS): [number, VersionFacts][] {
  return Object.entries(record)
    .filter(([v]) => released.some((r) => r.version === Number(v) && !r.withdrawn))
    .map(([v, facts]) => [Number(v), facts]);
}

/** A recorded field's place in its contract's ledger; refuses a name the contract has no field for. */
export function fieldIndexOf(facts: ContractFacts, name: string): number {
  const field = facts.fields.find((f) => f.name === name);
  if (field === undefined) throw new Error(`the record holds no field called ${name}`);
  return field.index;
}

/** A recorded derivation's 32 bytes as hex, from its first input set; refuses one that refused or returned something else. */
export function recordedHexOf(facts: ContractFacts, derivation: string): string {
  const output = facts.derivations[derivation]?.[0]?.output;
  if (typeof output !== 'string' || !/^0x[0-9a-f]{64}$/u.test(output)) throw new Error(`the record holds no 32 bytes for ${derivation}`);
  return output.slice(2);
}

/** The account's fields the wallet reads a company by. */
export const ACCOUNT_FIELDS_THE_WALLET_READS = [
  'signerRoles', 'signerLeaves', 'threshold', 'thresholds', 'vaults', 'retiredAt', 'movements', 'openProposals',
] as const;

/** The entries the wallet looks up in the account's shared map, by the derivation that keys each. */
export const ENTRIES_THE_WALLET_READS = ['companyLabelKey', 'payKeyCommitmentKey'] as const;

/** What the wallet reads a version's contracts by: field places, the vault's field count, and entry keys. */
export function walletReadFactsOf(facts: VersionFacts): Record<string, string | number> {
  return {
    ...Object.fromEntries(ACCOUNT_FIELDS_THE_WALLET_READS.map((n) => [`account field ${n}`, fieldIndexOf(facts.account, n)])),
    'vault field account': fieldIndexOf(facts.vault, 'account'),
    'vault field count': facts.vault.fields.length,
    ...Object.fromEntries(ENTRIES_THE_WALLET_READS.map((n) => [`entry key ${n}`, recordedHexOf(facts.account, n)])),
  };
}

/** Every fact the wallet reads by on which two versions disagree, named; empty when one wallet reads both. */
export function walletReadDifferences(earlier: VersionFacts, later: VersionFacts): string[] {
  const a = walletReadFactsOf(earlier);
  const b = walletReadFactsOf(later);
  return Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} then ${b[k]}`);
}
