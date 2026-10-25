/* Types for the vendoring script's folders and its account branch, so the
 * tests that hold them typecheck with the rest of this project rather than
 * under an implicit `any`. The implementation is plain JS because it runs
 * under Node before anything is built. */

export declare const WALLET_DIR: string;
export declare const REPO_ROOT: string;
export declare const KEYS_DIR: string;

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
