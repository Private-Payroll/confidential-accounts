/**
 * **WHETHER THE KEYS ON DISK ARE THE KEYS THIS BUILD COMPILED, FOR EVERY
 * CIRCUIT OF BOTH CONTRACTS.**
 *
 * A test that proves or verifies needs each circuit's keys, and keys built by
 * an earlier compile are worse than none: they pass a gate that only asks
 * whether one file exists, and fail later inside a proof with nothing saying
 * why. So a gate asks this, once: every circuit the account deploys
 * (`DEPLOYED_CIRCUITS`) and every circuit of the vault (`VAULT_CIRCUITS`) has a
 * `.verifier` on disk, and the sha256 of each is exactly what the compiled
 * module pins for it (`expectedVk`). A gate that stands down says which file
 * is missing or stale.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_CIRCUITS } from '../../src/midnight/vault-contract.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { expectedVk as accountExpectedVk } from '../managed/contract/index.js';
import { expectedVk as vaultExpectedVk } from '../managed-vault/contract/index.js';

/** The repository's root, from this file's own place in it. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** One contract's keys: where they are, which circuits must have one, and what the compiled module pins for each. */
export interface ContractKeys {
  /** What a refusal calls it. */
  readonly name: string;
  /** The folder its `.verifier` files are in. */
  readonly dir: string;
  /** Every circuit that must have a key. */
  readonly circuits: readonly string[];
  /** The compiled module's `expectedVk`: each circuit's verifier key, as the sha256 of its file in hex. */
  readonly expectedVk: Readonly<Record<string, string>>;
  /** Where the compiled module is, for a refusal to name. */
  readonly module: string;
}

/** The account, as this build compiled it. */
export const ACCOUNT_KEYS: ContractKeys = {
  name: 'the account', dir: join(ROOT, 'contracts/managed/keys'), circuits: DEPLOYED_CIRCUITS,
  expectedVk: accountExpectedVk, module: 'contracts/managed/contract/index.js',
};

/** The vault, as this build compiled it. */
export const VAULT_KEYS: ContractKeys = {
  name: 'the vault', dir: join(ROOT, 'contracts/managed-vault/keys'), circuits: VAULT_CIRCUITS,
  expectedVk: vaultExpectedVk, module: 'contracts/managed-vault/contract/index.js',
};

/** What the keys on disk came to. */
export interface KeysOnDisk {
  /** Every circuit of every contract asked about has a verifier on disk, and each is the one its module pins. */
  readonly ok: boolean;
  /** Whether any `.verifier` at all is on disk for these contracts: none is a build without keys, not a stale one. */
  readonly anyOnDisk: boolean;
  /** Each file that is missing, stale or unpinned, by name, with why. Empty when `ok`. */
  readonly problems: readonly string[];
  /** One sentence for a gate that stands down: what is missing or stale, and how to build the keys. */
  readonly why: string;
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
/** A file as a refusal names it: from the repository's root when it is in it, whole when it is not. */
const shown = (file: string): string => (file.startsWith(ROOT) ? relative(ROOT, file) : file);

/** Answers for the contracts given, or for both of this build's when none are. */
export function keysOnDisk(contracts: readonly ContractKeys[] = [ACCOUNT_KEYS, VAULT_KEYS]): KeysOnDisk {
  const problems: string[] = [];
  let anyOnDisk = false;
  for (const c of contracts) {
    if (existsSync(c.dir) && readdirSync(c.dir).some((f) => f.endsWith('.verifier'))) anyOnDisk = true;
    if (Object.keys(c.expectedVk).length === 0) {
      problems.push(`${c.module} pins no verifier key for ${c.name}, so no key on disk can be checked against it`);
    }
    for (const circuit of c.circuits) {
      const file = join(c.dir, `${circuit}.verifier`);
      const pinned = c.expectedVk[circuit];
      if (!existsSync(file)) {
        problems.push(`${shown(file)} is missing`);
      } else if (typeof pinned !== 'string' || pinned === '') {
        problems.push(`${shown(file)} has no key pinned for it in ${c.module}`);
      } else if (sha256(file) !== pinned.toLowerCase()) {
        problems.push(`${shown(file)} is stale: its sha256 is not the key ${c.module} pins for ${circuit}`);
      }
    }
  }
  const why = problems.length === 0
    ? 'every circuit\'s verifier key is on disk and is the one this build compiled.'
    : `${problems.join('; ')}. \`npm run compact\` then \`npm run compact:vault -- --full\` build them.`;
  return { ok: problems.length === 0, anyOnDisk, problems, why };
}

/** The `.verifier` files in a folder, by circuit name; none when the folder is not there. */
export const verifiersIn = (dir: string): string[] =>
  (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.verifier')).map((f) => f.slice(0, -'.verifier'.length)).sort();

/**
 * **EVERY WAY ONE COMPILED MODULE AND THE KEYS ON DISK DISAGREE**: a module
 * that pins no key while keys are on disk, a key on disk the module does not
 * pin or pins another sha256 for, and a key it pins that is not on disk.
 * Empty when they agree, and when no keys are on disk at all, which is a build
 * without keys rather than a disagreement.
 */
export function moduleAgainstKeys(c: ContractKeys): string[] {
  const onDisk = verifiersIn(c.dir);
  if (onDisk.length === 0) return [];
  const pinned = Object.keys(c.expectedVk).sort();
  if (pinned.length === 0) {
    return [`${c.module} pins no verifier key while ${onDisk.length} are on disk in ${shown(c.dir)}`];
  }
  const out: string[] = [];
  for (const circuit of onDisk) {
    const file = join(c.dir, `${circuit}.verifier`);
    const want = c.expectedVk[circuit];
    if (typeof want !== 'string' || want === '') out.push(`${shown(file)} is on disk and ${c.module} pins no key for it`);
    else if (sha256(file) !== want.toLowerCase()) out.push(`${shown(file)} is not the key ${c.module} pins for ${circuit}`);
  }
  for (const circuit of pinned) {
    if (!onDisk.includes(circuit)) out.push(`${c.module} pins a key for ${circuit} and ${shown(join(c.dir, `${circuit}.verifier`))} is not on disk`);
  }
  return out;
}
