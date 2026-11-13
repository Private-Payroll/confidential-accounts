/**
 * **WHAT A REBUILD OF A VAULT'S NOTES CROSSES TO THE VAULT WORKER WITH, AND WHAT COMES BACK** (`vault-rebuilt`), and one
 * step of the vault's payment journal as it crosses. Re-exported by `vault-worker-client.ts`.
 */
import type { NoteOnTheWire } from './vault-builder.js';
import type { CoinOnTheWire } from './vault-worker-client.js';

/**
 * What a rebuild of a vault's notes is asked over: the chain as one read gave it, the secrets the records hold, the
 * newest (or every) pool version, the journals' lines, the coins this device kept or was handed, and, for `walk`, the
 * company's own amounts. Amounts and values are decimal digits.
 */
export interface VaultRebuildAsked {
  readonly vault: string;
  readonly state?: string;
  readonly chain: {
    readonly notes: readonly string[];
    readonly everCreated: readonly string[];
    readonly nonceCommitment?: string;
    readonly splitJournal?: ReadonlyArray<readonly [string, string]>;
  };
  readonly secrets: readonly string[];
  readonly copyFor?: string;
  /** The secret this signer's own sealed copy opened to on the page: named with first when it is the one the vault holds now, and said when it is not. */
  readonly copySecret?: string;
  readonly versions: ReadonlyArray<{ readonly version: number; readonly notes: readonly CoinOnTheWire[] }>;
  readonly attempted: { readonly deposits: readonly CoinOnTheWire[]; readonly payments: readonly StepOnTheWire[] };
  readonly named?: readonly CoinOnTheWire[];
  readonly walk?: {
    readonly deposited: ReadonlyArray<{ readonly token: string; readonly value: string }>;
    readonly paid: ReadonlyArray<{ readonly token: string; readonly amount: string }>;
  };
}

/** A rebuild's answer: each held note with its held and output commitments, the chain notes nothing named, the sealed copy, and what was said. */
export interface VaultRebuilt {
  readonly held: ReadonlyArray<{ readonly nonce: string; readonly token: string; readonly value: string; readonly held: string; readonly output: string }>;
  readonly unexplained: readonly string[];
  readonly copy: readonly string[] | null;
  readonly said: readonly string[];
}

/** One step of the vault's payment journal as it crosses to the worker: its notes in place order, what left, and whether it was a merge. */
export interface StepOnTheWire {
  readonly spent: NoteOnTheWire;
  readonly further?: readonly NoteOnTheWire[];
  readonly amount: string;
  readonly merge?: boolean;
}
