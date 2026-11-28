/*
 * A PERSON'S PRIVATE REGISTRY, AS THE CHAIN WOULD HOLD IT, for the tests of the find and of the pin put back from it.
 * Registries and accounts are real ledger contract states holding made-up keys behind real key-file headers, judged
 * against a released list of those keys; entries are sealed with the person's own registry keys; each account's seats
 * are the leaves the person's words make. Nothing here is read from a network.
 */
import * as L from '@midnightntwrk/ledger-v9';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { sealEntry, tagAt, type RegistryEntry } from 'midnight-identity/profile/private-registry';
import type { ReleasedVersion } from 'midnight-identity/wallet/released-versions';
import type { Hex } from '../../../../src/core/crypto.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { seatAt } from '../keyring/seat-at.js';
import type { HoldersOnChain } from './company-label-on-chain.js';
import type { RegistryReads } from './private-registry-on-chain.js';

export const NETWORK = 'preprod';
export const ALL = MidnightCommitments.allVaults().toLowerCase() as Hex;

const enc = new TextEncoder();
const HEADER = { v2: 'midnight:verifier-key[v6]:', v3: 'midnight:verifier-key[v7]:' } as const;
/** A made-up key behind a real key-file header for slot `slot`. */
export const keyFile = (slot: keyof typeof HEADER, seed: number): Uint8Array =>
  Uint8Array.from([
    ...enc.encode(HEADER[slot]),
    48 << 2,
    ...Array.from({ length: 48 }, (_, i) => (i * seed + 11) & 255)
  ]);

export const PUT = keyFile('v3', 3);
export const ADOPT_V2 = keyFile('v2', 5);
export const ADOPT_V3 = keyFile('v3', 7);
export const STRANGER_V2 = keyFile('v2', 13);
export const STRANGER_V3 = keyFile('v3', 17);

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
/** The one released version these keys are. */
export const VERSIONS: readonly ReleasedVersion[] = [
  {
    version: 4,
    reachedFrom: [],
    openRunsFinishFirst: false,
    withdrawn: false,
    keys: {
      account: { adopt: { v2: hexOf(sha256(ADOPT_V2)), v3: hexOf(sha256(ADOPT_V3)) } },
      vault: {},
      registry: { put: { v3: hexOf(sha256(PUT)) } }
    }
  }
];

/**
 * A contract's state holding `ops` (each circuit's keys) and held by `owners` keys at `threshold`, as the indexer
 * serializes it; `counter` only tells two such states apart.
 */
export function stateHex(ops: Record<string, readonly Uint8Array[]>, owners = 0, threshold = 1, counter = 0n): string {
  const s = new L.ContractState();
  for (const [name, keys] of Object.entries(ops)) {
    const op = new L.ContractOperation();
    for (const k of keys) op.verifierKey = k;
    s.setOperation(name, op);
  }
  const committee = Array.from({ length: owners }, () => L.signatureVerifyingKey(L.sampleSigningKey()));
  s.maintenanceAuthority = new L.ContractMaintenanceAuthority(committee, threshold, counter);
  return hexOf(s.serialize());
}

export const REGISTRY_STATE = stateHex({ put: [PUT] });
/** A second registry like the first, told apart from it by its state alone. */
export const SECOND_REGISTRY_STATE = stateHex({ put: [PUT] }, 0, 1, 1n);
export const ACCOUNT_STATE = stateHex({ adopt: [ADOPT_V2, ADOPT_V3] });

/** The leaves the words make for seat `n` of `label`, at the every-vault scope. */
export const leafOf = (identity: Identity, label: CompanyLabel, n: number): string =>
  seatAt(identity, label, n, ALL, MidnightCommitments).leaf;

/** Seat `n` of `label` at `account`, as the person's entry names it. */
export const entryFor = (label: CompanyLabel, account: string, n = 0): RegistryEntry => ({
  label,
  account,
  n,
  scope: ALL
});

/** Who holds an account with `seats`, as the chain answers it. */
export const holding = (seats: readonly string[]): HoldersOnChain => ({
  of: 'read',
  holders: {
    committee: [],
    threshold: 1,
    seats,
    approvals: 1,
    vaultThresholds: [],
    policyBar: null,
    seatBar: 1,
    adoptedVaults: [],
    founding: seats[0] ?? '00'.repeat(32),
    foundingCommittee: []
  }
});

/** One registry: what it holds at each index of the person's tags. */
export type Held = Readonly<Record<number, RegistryEntry | Uint8Array>>;

/** The world one find reads: each registry and its entries, each account's state and seats, and what was asked. */
export function registryWorld(
  identity: Identity,
  o: {
    readonly registries: Readonly<Record<string, { readonly state: string; readonly held: Held }>>;
    readonly accounts: Readonly<
      Record<string, { readonly label: CompanyLabel; readonly state: string; readonly seats: readonly string[] }>
    >;
    readonly unread?: readonly string[];
  }
) {
  const asked = { states: [] as string[], tags: [] as number[] };
  const byState = new Map(Object.values(o.registries).map((r) => [r.state, r.held] as const));
  const indexOf = new Map(Array.from({ length: 200 }, (_, k) => [tagAt(identity, NETWORK, k), k] as const));
  const reads: RegistryReads = {
    registries: Object.keys(o.registries),
    versions: VERSIONS,
    state: async (address) => {
      asked.states.push(address);
      if (o.unread?.includes(address)) throw new Error('the indexer did not answer');
      return o.registries[address]?.state ?? o.accounts[address]?.state ?? null;
    },
    holders: async (account: AccountAddress, label: CompanyLabel) => {
      const a = o.accounts[account];
      if (a === undefined) return { of: 'no-account' };
      return a.label === label ? holding(a.seats) : { of: 'other-label' };
    },
    values: async (state, tags) => {
      const held = byState.get(state) ?? {};
      return tags.map((tag) => {
        const i = indexOf.get(tag)!;
        asked.tags.push(i);
        const at = held[i];
        if (at === undefined) return null;
        return at instanceof Uint8Array ? at : sealEntry(identity, NETWORK, i, at);
      });
    },
    scheme: async () => MidnightCommitments
  };
  return { reads, asked };
}
