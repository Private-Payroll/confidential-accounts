/**
 * **WHO HOLDS EACH OF THE COMPANY'S CONTRACTS, AS THE CHAIN SHOWS IT, AND WHICH VAULTS ITS ACCOUNT LISTS.** The reads
 * `committee-here.ts` judges the super admins by, as plain answers that can cross from the vault worker to the page:
 * the ledger's state reader and the account's compiled reader stay where they load (the vault worker, or a test), and
 * the page asks for what they read (`vault-worker-client.ts`).
 */
import { authorityIn, type ContractAuthority } from 'midnight-identity/profile/contract-authority';
import type { VaultChainSource } from './vault-on-chain-here.js';

/** A contract's authority as its state carries it, or the sentence naming what is missing (`authorityIn`). */
export type AuthorityRead = ContractAuthority | { readonly why: string };

/** The account as the chain holds it: who holds it, and the vaults its state lists as adopted and as retired. */
export interface AccountRead {
  readonly authority: AuthorityRead;
  /** Each by its address in lower-case hex; null when the account's state does not list them, or its authority could not be read. */
  readonly vaults: { readonly adopted: readonly string[]; readonly retired: readonly string[] } | null;
}

/** The two reads, each at the indexer the person's own wallet names, and null when that indexer holds no contract there. */
export interface CommitteeReads {
  readonly accountAt: (account: string) => Promise<AccountRead | null>;
  readonly authorityAt: (address: string) => Promise<AuthorityRead | null>;
}

/** What the reads are made with where the ledger loads: the runtime's state reader and the account's compiled reader. */
interface ReadersHere {
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  readonly accountLedger: (data: unknown) => unknown;
}

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A contract's state at the wallet's indexer, deserialized, or null when the indexer holds none there. */
async function stateAt(deps: ReadersHere, chain: Pick<VaultChainSource, 'contractState'>, address: string): Promise<unknown | null> {
  const served = await chain.contractState(address);
  return served === null || served === undefined ? null : deps.runtimeState.deserialize(served.serialize());
}

/**
 * The reads, made with the ledger's readers over `chain`. The account's lists are read off the same state as its
 * authority, and only once that authority could be read.
 */
export const committeeReadsOf = (deps: ReadersHere, chain: Pick<VaultChainSource, 'contractState'>): CommitteeReads => ({
  accountAt: async (account) => {
    const state = await stateAt(deps, chain, account);
    if (state === null) return null;
    const authority = authorityIn(state);
    if ('why' in authority) return { authority, vaults: null };
    const view = deps.accountLedger((state as { data: unknown }).data) as {
      vaults?: Iterable<Uint8Array>; retiredAt?: Iterable<[Uint8Array, unknown]>;
    } | null;
    if (view?.vaults === undefined || view.retiredAt === undefined) return { authority, vaults: null };
    return { authority, vaults: { adopted: [...view.vaults].map(hexOf), retired: [...view.retiredAt].map(([v]) => hexOf(v)) } };
  },
  authorityAt: async (address) => {
    const state = await stateAt(deps, chain, address);
    return state === null ? null : authorityIn(state);
  },
});
