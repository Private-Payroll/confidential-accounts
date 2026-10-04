import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATION_STEPS } from '../../src/midnight/deferral.js';

/**
 * **THIS BUILD'S COMPANY-ACCOUNT KEYS, AS THE WALLET IS BUILT WITH THEM.**
 *
 * The founding signer's wallet checks every key of a company's account it is
 * asked to sign for against these: one digest per circuit, made here, when the
 * wallet is built, from the very verifier key files the page and the service
 * compile against, and listed in the order each step of a creation takes them.
 * Nothing is copied by hand, and a key rebuilt is a wallet rebuilt.
 *
 * Served as one module, `virtual:this-builds-account-keys`, to the wallet's
 * bundle and to its tests. Where the keys are not on disk the module says so,
 * and the wallet then refuses to sign any creation rather than check against
 * nothing.
 */
export const THIS_BUILDS_ACCOUNT_KEYS = 'virtual:this-builds-account-keys';

export interface AccountKeyDigests {
  readonly first: ReadonlyArray<readonly [string, string]>;
  readonly second: ReadonlyArray<readonly [string, string]>;
  /** Why there are none, when the keys are not on disk; null when every one was read. */
  readonly missing: string | null;
}

/** The digests, read from `<root>/contracts/managed/keys`. */
export function accountKeyDigests(root: string): AccountKeyDigests {
  const dir = join(root, 'contracts', 'managed', 'keys');
  const absent = [...CREATION_STEPS.first, ...CREATION_STEPS.second].filter((c) => !existsSync(join(dir, `${c}.verifier`)));
  if (absent.length > 0) {
    return { first: [], second: [], missing: `this wallet was built without the company account's compiled keys (${absent.join(', ')})` };
  }
  const digest = (c: string) => [c, createHash('sha256').update(readFileSync(join(dir, `${c}.verifier`))).digest('hex')] as const;
  return { first: CREATION_STEPS.first.map(digest), second: CREATION_STEPS.second.map(digest), missing: null };
}

/** The plugin that serves them. `root` is this repository's own directory. */
export function thisBuildsAccountKeys(root: string) {
  const resolved = `\0${THIS_BUILDS_ACCOUNT_KEYS}`;
  return {
    name: 'this-builds-account-keys',
    resolveId(id: string) { return id === THIS_BUILDS_ACCOUNT_KEYS ? resolved : null; },
    load(id: string) {
      if (id !== resolved) return null;
      const d = accountKeyDigests(root);
      return `export const first = ${JSON.stringify(d.first)};\n`
        + `export const second = ${JSON.stringify(d.second)};\n`
        + `export const missing = ${JSON.stringify(d.missing)};\n`;
    },
  };
}

/**
 * **WHAT THIS FILE SERVES THE WALLET'S BUILD, DECLARED ONCE**: the module's id,
 * this file, and the plugin that makes the module. The wallet's config installs
 * the plugin from here, and the browser walk (`scripts/browser-graph.ts`) asks
 * the same plugin for the module and walks what it serves, so the build and the
 * walk cannot name different modules. What the plugin itself imports runs when
 * the wallet is built, never in a browser, and is not part of what is served.
 */
export const SERVED_TO_THE_WALLET = {
  id: THIS_BUILDS_ACCOUNT_KEYS,
  servedBy: fileURLToPath(import.meta.url),
  plugin: thisBuildsAccountKeys,
} as const;
