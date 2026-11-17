/* Types for the vendoring script's folders and its account branch, so the
 * tests that hold them typecheck with the rest of this project rather than
 * under an implicit `any`. The implementation is plain JS because it runs
 * under Node before anything is built. */

export declare const WALLET_DIR: string;
export declare const REPO_ROOT: string;
export declare const KEYS_DIR: string;
/** The ledger's own circuits the wallet proves with, as the wallet serves them. */
export declare const LEDGER_CIRCUITS: readonly string[];
/** The hash the ledger release declares for each file of a circuit it publishes one for, by served path. */
export declare const LEDGER_DECLARED: Readonly<Record<string, string>>;
/** The bucket and the trusted-setup host the ledger's keys are fetched from. */
export declare const BUCKET: string;
export declare const TRUSTED_SETUP: string;
/** The host a ledger circuit file is fetched from. */
export declare function ledgerSourceOf(relPath: string): string;
/** The lines refusing a ledger circuit file whose bytes are not the declared ones, or null. */
export declare function declaredRefusal(relPath: string, hash: string, from: string): string[] | null;
export declare function droppedRefusal(relPath: string, url: string, cause: unknown): string[];
/** Every folder of ledger circuit files the keys folder or the pins hold, one generation deep. */
export declare function ledgerFoldersOf(input: { keysDir: string; artefacts: Record<string, { bytes: number; sha256: string }>; circuits: readonly string[] }): string[];

export interface AccountFile {
  /** Where the wallet serves it, under its keys folder. */
  readonly served: string;
  /** Where the compile wrote it, from the repository's root. */
  readonly built: string;
  readonly circuit: string;
}

export declare function accountFilesOf(circuits: readonly string[], folder: string, compiled?: string, verifierOnly?: boolean): AccountFile[];

export declare function vendorAccountKeys(input: {
  repoRoot: string;
  keysDir: string;
  circuits: readonly string[];
  folder: string;
  expectedVk: Readonly<Record<string, string>> | undefined;
  artefacts: Record<string, { bytes: number; sha256: string }>;
  repin?: boolean;
  log?: (line: string) => void;
  /** The folder under contracts/ the compile wrote: `managed` (the default) or `managed-vault`. */
  compiled?: string;
  /** Copy the verifier key alone. */
  verifierOnly?: boolean;
}): number;

/** The served paths under `folders` that a pin or a file on disk holds but `expected` (every path the run walked) does not. */
export declare function staleKeysOf(input: {
  keysDir: string;
  artefacts: Record<string, { bytes: number; sha256: string }>;
  folders: readonly string[];
  expected: readonly string[];
}): string[];

/** Moves each stale file into `graveyard` (never deletes) and drops its pin; returns how many files moved. */
export declare function pruneStale(input: {
  keysDir: string;
  artefacts: Record<string, { bytes: number; sha256: string }>;
  stale: readonly string[];
  graveyard: string;
  stamp: string;
}): number;

/** Refuses stale keys by name (returns 1) unless `prune`, which moves them and returns 0; returns 0 when none are stale. */
export declare function pruneOrRefuse(input: {
  keysDir: string;
  artefacts: Record<string, { bytes: number; sha256: string }>;
  folders: readonly string[];
  expected: readonly string[];
  prune: boolean;
  graveyard: string;
  stamp: string;
  log?: (line: string) => void;
  /** The command the refusal tells the reader to run with --prune. */
  command?: string;
}): number;

/** Refuses (returns 1) when the keys folder is missing, naming it and what restores it; never creates it. Returns 0 when it is there. */
export declare function keysFolderOrRefuse(input: {
  keysDir: string;
  repoRoot: string;
  log?: (line: string) => void;
}): number;

/** The closing line of a run, naming the manifest path it was given relative to the repository's root. */
export declare function wroteLine(input: { repoRoot: string; manifestPath: string; pins: number }): string;
