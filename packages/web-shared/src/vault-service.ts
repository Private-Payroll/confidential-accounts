import type { Committee } from '../../../src/midnight/vault-committee.js';
import type { Hex } from '../../../src/core/crypto.js';

/**
 * What the company's service answers for one vault's chain route: the service's own read, shown only, never an answer to
 * whether money may go in or out (`vaultFundableHere` is that).
 */
export interface ServedVaultChain {
  readonly vault: Hex;
  readonly onChain: boolean;
  readonly state?: string;
  readonly notes?: readonly Hex[];
  readonly everCreated?: readonly string[];
  readonly authority?: {
    readonly committee: readonly { tag: string; value: string }[];
    readonly threshold: number;
    readonly counter: string;
    readonly shape: string;
  } | null;
  readonly committee?: Committee | null;
  /** Whether the vault is held by the same keys, at the same threshold, as the company's account: shown, never a gate on money. */
  readonly heldByCommittee?: boolean;
  /** Base64 of the deploy the vault's address was made from, as the service kept it when it sent it. */
  readonly deployed?: string | null;
  /** Whether the service reads the vault's first secret as set with every sealed copy written. */
  readonly started?: boolean;
  readonly notesFromThisBuild?: boolean;
  readonly notesWhy?: string;
}

/** What the service answered for one step of a vault's start it sent. */
interface StartStepSent { readonly txRef: string; readonly transactionHash?: string | null }

export interface VaultKeysView {
  readonly committee: Committee | null;
  readonly why: string | null;
  /** Every signer's records key the service holds, this device's included. */
  readonly readers: readonly Hex[];
}

/** The routes in `src/server/company-vaults.ts`, as the page calls them. */
export interface VaultService {
  keys(): Promise<VaultKeysView>;
  deploy(tx: string): Promise<{ vault: Hex; txRef: string }>;
  handover(vault: Hex, tx: string): Promise<{ txRef: string }>;
  chain(vault: Hex): Promise<ServedVaultChain>;
  deposit(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * Sends a public deposit into the vault, with the network fee paid for it.
   * The service is handed the transaction and nothing else: it reads the token
   * and the amount from it, and refuses one that is not exactly one public
   * token, a positive amount of it, into this vault.
   */
  depositPublicly?(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * One block's view of the vault and the company's account, as the service
   * reads it. Nothing on the page reads it: a vault's start, a deposit and a
   * payment read their block on this device (`chainAtOneBlockHere`).
   */
  payoutState(vault: Hex): Promise<{
    vault: Hex; account: Hex; blockHash: string;
    vaultState: string; zswapState: string; parameters: string; accountState: string;
  }>;
  payout(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /** Sends a merge of the vault's own notes, with the network fee paid for it. It moves nothing out of the vault. */
  merge(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /** Sends a public payment out of the vault, with the network fee paid for it. */
  payoutPublicly(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * **A STEP OF THE VAULT'S START ON THE COMPANY'S ACCOUNT**, proved on this
   * device: the adoption round or the first secret run approved, or the
   * adoption carried out. Each is raised with its record instead
   * (`VaultStartProposals`).
   */
  startAccountCall?(vault: Hex, body: { tx: string; step: 'adoption' | 'secret-run'; call: 'approve' | 'adopt' }): Promise<StartStepSent>;
  /** The vault's first secret set under its approved run. */
  startSecret?(vault: Hex, tx: string): Promise<StartStepSent>;
  /** One signer's sealed copy of the secret written, by its place in the approved tree. */
  startCopy?(vault: Hex, tx: string, place: number): Promise<StartStepSent>;
}
