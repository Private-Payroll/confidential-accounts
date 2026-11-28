/**
 * Whether a change can break a test that reads a proving or verifier key, written as keys=true or keys=false.
 * Anything it cannot read answers true: a key test skipped that should have run is the failure this prevents.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Every file the key tests load or read, the scripts and settings that build and run them, and this workflow and list. */
export const KEYS_PATHS = Object.freeze([
  // the contracts, their compiled code and keys, and their tests
  'contracts/**',
  // the code that builds, proves and submits a call
  'src/**',
  'packages/**',
  'apps/wallet/**',
  'apps/web/**',
  // the scripts that compile the contracts, build and check the keys and fetch the parameters
  'scripts/compile-contract.sh',
  'scripts/compile-contracts.sh',
  'scripts/compile-vault.sh',
  'scripts/contract-sources.mjs',
  'scripts/contract-version.mjs',
  'scripts/fetch-proving-parameters.ts',
  'scripts/fetch-proving-parameters-rules.ts',
  'scripts/artifact-freshness.ts',
  'scripts/artifact-freshness.globalSetup.ts',
  'scripts/identity-lib-fresh.ts',
  'scripts/identity-lib-fresh.globalSetup.ts',
  'scripts/ledger-limit.ts',
  'scripts/ledger-limit.globalSetup.ts',
  'scripts/dispatch-ceiling.ts',
  'scripts/reconcile-vault-pool-rules.ts',
  'scripts/browser-graph.ts',
  'scripts/serve-rules.ts',
  'scripts/find-compactc.sh',
  // the package versions and the lockfile, and what runs the tests
  'package.json',
  'package-lock.json',
  '.npmrc',
  '.nvmrc',
  'tsconfig.json',
  'vitest.config.ts',
  // the workflow that runs them, this list, and the build it shares with the other checks
  '.github/workflows/ci.yml',
  '.github/checks/keys-paths.mjs',
  '.github/actions/build/**',
  '.github/checks/fetch-compiler.mjs',
  '.github/checks/toolchain.mjs'
]);

/**
 * A path filter read the way GitHub reads one: `**` crosses folders, `*` does
 * not, and every other character is itself.
 * @param {string} glob
 * @param {string} path
 * @returns {boolean}
 */
export const pathMatches = (glob, path) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')
      )
      .join('.*')}$`
  ).test(path);

/**
 * Whether any changed file is one a key test loads. An empty list answers true:
 * a pull request always changes something, so nothing read means the reading failed.
 * @param {readonly string[]} changed
 * @returns {boolean}
 */
export const keysTouched = (changed) =>
  changed.length === 0 || changed.some((f) => KEYS_PATHS.some((g) => pathMatches(g, f)));

/**
 * A push answers false and any event but a pull request true. A pull request answers true when a listed file changed
 * or the changes cannot be read, except for an edit of a commit whose key tests already passed.
 * @param {{ event: string, action: string, changed: readonly string[] | null, passedBefore: boolean | null }} seen
 * @returns {'true' | 'false'}
 */
export const keysAnswer = ({ event, action, changed, passedBefore }) => {
  if (event === 'push') return 'false';
  if (event !== 'pull_request') return 'true';
  if (changed === null || keysTouched(changed)) {
    return action === 'edited' && changed !== null && passedBefore === true ? 'false' : 'true';
  }
  return 'false';
};

/**
 * The files a pull request changes since it branched, or null when the history cannot be read. Renames count as a
 * removal and an addition, so a file moved off the list is still a change to it.
 * @param {string} base
 * @param {string} head
 * @param {(args: string[]) => string} [git] what runs git; the tests pass their own.
 * @returns {string[] | null}
 */
export const changedFiles = (
  base,
  head,
  git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
) => {
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) return null;
  try {
    const out = git(['diff', '--name-only', '--no-renames', `${base}...${head}`]);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  } catch (e) {
    process.stderr.write(`the changed files could not be read, so the key tests run: ${String(e)}\n`);
    return null;
  }
};

/**
 * Whether an earlier run of this workflow on the same commit passed every key group; null when that cannot be read.
 * @param {{ api: string, repository: string, head: string, token: string, fetcher?: typeof fetch }} where `fetcher` asks; the tests pass their own.
 * @returns {Promise<boolean | null>}
 */
export const keysPassedBefore = async ({ api, repository, head, token, fetcher = fetch }) => {
  if (token === '' || repository === '' || !/^[0-9a-f]{40}$/.test(head)) return null;
  const ask = async (/** @type {string} */ path) => {
    const res = await fetcher(`${api}/repos/${repository}/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  };
  try {
    const { workflow_runs: runs } = await ask(
      `actions/workflows/ci.yml/runs?head_sha=${head}&status=completed&per_page=100`
    );
    for (const run of runs) {
      const { jobs } = await ask(`actions/runs/${run.id}/jobs?per_page=100`);
      const keys = jobs.filter((/** @type {{ name: string }} */ j) => j.name.startsWith('keys ('));
      if (keys.length > 0 && keys.every((/** @type {{ conclusion: string }} */ j) => j.conclusion === 'success'))
        return true;
    }
    return false;
  } catch (e) {
    process.stderr.write(`earlier runs could not be read, so the key tests run: ${String(e)}\n`);
    return null;
  }
};

const main = async () => {
  const env = process.env;
  const event = env.EVENT ?? '';
  const action = env.ACTION ?? '';
  const changed = event === 'pull_request' ? changedFiles(env.BASE ?? '', env.HEAD ?? '') : null;
  const passedBefore =
    event === 'pull_request' && action === 'edited'
      ? await keysPassedBefore({
          api: env.GITHUB_API_URL ?? 'https://api.github.com',
          repository: env.REPOSITORY ?? '',
          head: env.HEAD ?? '',
          token: env.GH_TOKEN ?? ''
        })
      : null;
  const answer = keysAnswer({ event, action, changed, passedBefore });
  if (changed !== null)
    process.stdout.write(
      `${changed.length} files changed; ${changed.filter((f) => KEYS_PATHS.some((g) => pathMatches(g, f))).length} of them a key test loads\n`
    );
  process.stdout.write(`keys=${answer}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `keys=${answer}\n`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Whatever went wrong, the key tests run; only an output that cannot be written fails the job.
    process.stderr.write(`the answer could not be worked out, so the key tests run: ${String(e)}\n`);
    process.stdout.write('keys=true\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'keys=true\n');
  });
}
