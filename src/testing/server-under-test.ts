/**
 * **HOW A TEST STARTS THIS SERVICE INSIDE ITS OWN PROCESS, AND THE ONLY WAY.**
 *
 * A test that drives the routes imports the service's entry point, which reads
 * most of its settings while it is being imported: from `process.env`, and from
 * a `.env` file in the working directory for any name `process.env` leaves
 * unset. Left to itself that makes three things part of every server test's
 * input that no test file wrote down:
 *
 * - **whatever else is in `process.env`** - the shell that started the suite,
 *   and anything a module imported earlier put there;
 * - **the working tree's `.env`**, which on a developer's machine names a live
 *   database, a network and a proof server, and on a clean clone does not exist;
 * - **the rest of what the entry point finds from the working directory**: the
 *   deployment record above all, so a machine that has deployed a contract
 *   serves a different product from one that has not, and the public
 *   parameters that machine has downloaded.
 *
 * So the settings are BUILT, not inherited, and the import happens in a
 * directory made for it. `useOnlyTheseSettings` replaces the environment with
 * the few names node and the test runner need, plus exactly the settings the
 * file names; `importTheServer` refuses to run before that, and imports the
 * entry point from a fresh directory holding only links to this checkout's two
 * compiled contracts - no `.env` and no deployment record for it to find. Every
 * server test then sees what a clean clone sees, on every machine and in CI
 * alike, and what it sees is written in the file.
 *
 * One order still matters and nothing here can hold it: a module a test file
 * imports statically is evaluated before the file's first line runs, so a
 * module that read a setting at the top level would read the shell's value.
 * None does today; the entry point is the only module that reads settings while
 * it is imported, and it is imported here.
 *
 * **AND THE ADDRESS IS THE OTHER HALF.** A test serves the app on a port the
 * system picks and then dials `127.0.0.1` on that port. Called with a port
 * alone, `listen` holds every address - and on macOS every-address is not
 * exclusive: another process may take `127.0.0.1` on the same port, and every
 * request the test makes then reaches that process instead, answered from its
 * settings. So a test server listens on `LOOPBACK`, the address it dials, which
 * nobody else can then hold. `server-under-test.test.ts` pins both halves, and
 * walks every test file for a direct import of the entry point and for a server
 * listening on a port alone.
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The address a test server listens on and the address its requests dial. */
export const LOOPBACK = '127.0.0.1';

const CHECKOUT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The names kept from the environment the suite was started with: what node,
 * the operating system and the test runner need to run at all. None of them is
 * a setting of this service, except the last, which the suite's own config
 * sets so that no test writes refusals into the file a person reads.
 */
const PLATFORM = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'TERM',
  'NODE_OPTIONS', 'CI', 'TEST', 'FORCE_COLOR', 'NO_COLOR', 'SystemRoot',
  'REFUSAL_LOG',
]);
const PLATFORM_PREFIXES = ['VITEST', '__VITEST', 'LC_'];
const isPlatform = (name: string): boolean =>
  PLATFORM.has(name) || PLATFORM_PREFIXES.some((p) => name.startsWith(p));

/**
 * `NODE_ENV` is not taken from the shell: the web framework under the routes
 * reads it, so a shell that said `production` would change what the routes do.
 * It is what the test runner sets, stated, and a file may still name its own.
 */
const UNDER_TEST = { NODE_ENV: 'test' } as const;

let settled = false;

/**
 * Makes `process.env` the platform's names plus `settings`, and nothing else.
 * Call it before anything reads a setting, which in a test file means where the
 * settings used to be assigned one by one.
 */
export function useOnlyTheseSettings(settings: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(process.env)) {
    if (!isPlatform(name)) delete process.env[name];
  }
  Object.assign(process.env, UNDER_TEST, settings);
  settled = true;
}

/**
 * A fresh directory for the entry point to be imported from. It holds links to
 * this checkout's compiled contracts, where they have been built, because the
 * routes that serve verifier keys and compiled artefacts fix their folders from
 * the working directory while the entry point is imported. Nothing else: no
 * `.env`, and no `.midnight` with a deployment record or downloaded parameters.
 */
const aDirectoryToImportFrom = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'server-under-test-'));
  mkdirSync(join(dir, 'contracts'));
  for (const built of ['managed', 'managed-vault']) {
    const there = join(CHECKOUT, 'contracts', built);
    if (existsSync(there)) symlinkSync(there, join(dir, 'contracts', built), 'dir');
  }
  return dir;
};

/**
 * Imports the service's entry point from `aDirectoryToImportFrom`, then puts
 * the working directory back. What the entry point resolves from the working
 * directory while it is imported - the deployment record, the default data
 * file, where compiled artefacts and downloaded parameters are read from - is
 * resolved against that directory and stays so for the life of the test; only
 * code that reads the working directory later, per request, sees the real one
 * again. Refuses unless the settings were settled first: an import before that
 * reads whatever the environment happened to hold.
 */
export async function importTheServer(): Promise<typeof import('../server/index.js')> {
  if (!settled) {
    throw new Error(
      'the server was imported before its settings were: call useOnlyTheseSettings with every '
      + 'setting this file relies on first, so nothing it sees comes from the shell, the working '
      + "tree's .env or another module.");
  }
  const here = process.cwd();
  process.chdir(aDirectoryToImportFrom());
  try {
    return await import('../server/index.js');
  } finally {
    process.chdir(here);
  }
}
