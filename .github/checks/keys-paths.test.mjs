/**
 * Which changes start the key tests, and how the check workflow is wired to the answer. The list is compared with a
 * copy written out here, so a path taken off it is decided twice; git and GitHub are stood in for, so it runs offline.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { changedFiles, KEYS_PATHS, keysAnswer, keysPassedBefore, keysTouched, pathMatches } from './keys-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('the list is every file a key test loads, this workflow and this list', () => {
  /* RED WHEN: a path a key test loads is taken off the list, or one is added that nothing here agreed to. */
  assert.deepEqual(
    [...KEYS_PATHS],
    [
      'contracts/**',
      'src/**',
      'packages/**',
      'apps/wallet/**',
      'apps/web/**',
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
      'package.json',
      'package-lock.json',
      '.npmrc',
      '.nvmrc',
      'tsconfig.json',
      'vitest.config.ts',
      '.github/workflows/ci.yml',
      '.github/checks/keys-paths.mjs',
      '.github/actions/build/**',
      '.github/checks/fetch-compiler.mjs',
      '.github/checks/toolchain.mjs'
    ]
  );
});

test('a path is matched the way GitHub matches one', () => {
  /* RED WHEN: `*` crosses a folder, `**` does not, or a dot matches any character. */
  assert.equal(pathMatches('src/**', 'src/a/b.ts'), true);
  assert.equal(pathMatches('scripts/*.ts', 'scripts/a/b.ts'), false);
  assert.equal(pathMatches('scripts/*.ts', 'scripts/a.ts'), true);
  assert.equal(pathMatches('.nvmrc', 'xnvmrc'), false);
  assert.equal(pathMatches('package.json', 'apps/web/package.json'), false);
  // RED WHEN a file whose name starts with a dot is missed, as Node's path.matchesGlob misses contracts/managed/.version.
  assert.equal(pathMatches('contracts/**', 'contracts/managed/.version'), true);
});

test('a change to a file a key test loads starts them, and a change to nothing else does not', () => {
  /* RED WHEN: a contract change skips the key tests, or a change to the documents alone starts them. */
  assert.equal(keysTouched(['contracts/src/Vault.compact']), true);
  assert.equal(keysTouched(['README.md', 'docs/design/the-vault-contract.md']), false);
  assert.equal(keysTouched(['README.md', 'package-lock.json']), true);
  assert.equal(keysTouched(['.github/workflows/ci.yml']), true);
  assert.equal(keysTouched(['.github/checks/keys-paths.mjs']), true);
  /* RED WHEN: a reading that found no changed file at all is taken for a change that cannot break them. */
  assert.equal(keysTouched([]), true);
});

test('the answer: the nightly run and a run by hand run them, a merge to main does not, and a pull request runs them when it can break them', () => {
  const pr = (action, changed, passedBefore = null) =>
    keysAnswer({ event: 'pull_request', action, changed, passedBefore });
  /* RED WHEN: the nightly run, a run by hand or an event this does not know skips the key tests. */
  for (const event of ['schedule', 'workflow_dispatch', 'something new']) {
    assert.equal(keysAnswer({ event, action: '', changed: null, passedBefore: null }), 'true', event);
  }
  /* RED WHEN: every merge to main spends six key runs that its pull request and the nightly run already cover. */
  assert.equal(keysAnswer({ event: 'push', action: '', changed: null, passedBefore: null }), 'false');
  /* RED WHEN: a pull request that changes only the documents spends six key runs, or one that changes a contract skips them. */
  assert.equal(pr('opened', ['README.md']), 'false');
  assert.equal(pr('synchronize', ['contracts/src/Vault.compact']), 'true');
  /* RED WHEN: a pull request whose changes could not be read skips the key tests. */
  assert.equal(pr('synchronize', null), 'true');
  /* RED WHEN: a title edit leaves the key tests unrun when no run of that commit passed them, or reruns them when one did. */
  assert.equal(pr('edited', ['contracts/src/Vault.compact'], null), 'true');
  assert.equal(pr('edited', ['contracts/src/Vault.compact'], false), 'true');
  assert.equal(pr('edited', ['contracts/src/Vault.compact'], true), 'false');
  assert.equal(pr('edited', ['README.md'], null), 'false');
  assert.equal(pr('edited', null, true), 'true');
  /* RED WHEN: an earlier pass is trusted on a push to the pull request, which may have changed what the tests see. */
  assert.equal(pr('synchronize', ['contracts/src/Vault.compact'], true), 'true');
});

test('the changed files are read against the branch point, with a moved file read as two changes', () => {
  /** @type {unknown[][]} */
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return 'src/a.ts\n\ndocs/b.md\n';
  };
  /* RED WHEN: a file moved off the list reads as its new name only, or the diff is taken against the base's tip rather than the branch point. */
  assert.deepEqual(changedFiles(SHA_A, SHA_B, run), ['src/a.ts', 'docs/b.md']);
  assert.deepEqual(calls, [['diff', '--name-only', '--no-renames', `${SHA_A}...${SHA_B}`]]);
  /* RED WHEN: a failed or impossible reading is taken for an empty change. */
  assert.equal(
    changedFiles(SHA_A, SHA_B, () => {
      throw new Error('bad object');
    }),
    null
  );
  assert.equal(changedFiles('', SHA_B, run), null);
  assert.equal(changedFiles(SHA_A, 'main; echo', run), null);
  assert.equal(calls.length, 1);
});

test('an earlier pass of the same commit is read from the runs, and anything unread is no pass', async () => {
  const answering =
    (runs, jobsOf, status = 200) =>
    async (url) => {
      const u = String(url);
      // A refusal whose body reads like a pass, so only the status can tell them apart.
      if (status !== 200)
        return {
          ok: false,
          status,
          json: async () => ({ workflow_runs: [{ id: 1 }], jobs: [{ name: 'keys (account)', conclusion: 'success' }] })
        };
      if (u.includes('/actions/workflows/ci.yml/runs?head_sha='))
        return { ok: true, status, json: async () => ({ workflow_runs: runs }) };
      const id = Number(/actions\/runs\/(\d+)\/jobs/.exec(u)?.[1]);
      return { ok: true, status, json: async () => ({ jobs: jobsOf(id) }) };
    };
  const where = { api: 'https://api.example', repository: 'o/r', head: SHA_B, token: 't' };
  const keys = (conclusion) => ['account', 'vault'].map((g) => ({ name: `keys (${g})`, conclusion }));
  /* RED WHEN: a run whose key groups all passed is not seen. */
  assert.equal(
    await keysPassedBefore({
      ...where,
      fetcher: answering([{ id: 1 }, { id: 2 }], (id) => (id === 2 ? keys('success') : keys('cancelled')))
    }),
    true
  );
  /* RED WHEN: a run where one group failed, was cancelled or was skipped counts as a pass. */
  assert.equal(
    await keysPassedBefore({
      ...where,
      fetcher: answering([{ id: 1 }], () => [
        { name: 'keys (account)', conclusion: 'success' },
        { name: 'keys (vault)', conclusion: 'failure' }
      ])
    }),
    false
  );
  assert.equal(await keysPassedBefore({ ...where, fetcher: answering([{ id: 1 }], () => keys('skipped')) }), false);
  /* RED WHEN: a run with no key group at all counts as a pass. */
  assert.equal(
    await keysPassedBefore({
      ...where,
      fetcher: answering([{ id: 1 }], () => [{ name: 'test', conclusion: 'success' }])
    }),
    false
  );
  /* RED WHEN: a refused or failed question is taken for an answer. */
  assert.equal(await keysPassedBefore({ ...where, fetcher: answering([], () => [], 403) }), null);
  assert.equal(
    await keysPassedBefore({
      ...where,
      fetcher: async () => {
        throw new Error('offline');
      }
    }),
    null
  );
  assert.equal(
    await keysPassedBefore({ ...where, token: '', fetcher: answering([{ id: 1 }], () => keys('success')) }),
    null
  );
});

test('run as the workflow runs it, it writes true or false and nothing else', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'keys-paths-')), 'output');
  const answer = (env) => {
    execFileSync(process.execPath, [join(HERE, 'keys-paths.mjs')], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
      encoding: 'utf8'
    });
    return readFileSync(out, 'utf8').trim().split('\n').pop();
  };
  /* RED WHEN: the nightly run writes no answer, or one the key jobs do not read as run. */
  assert.equal(answer({ EVENT: 'schedule' }), 'keys=true');
  /* RED WHEN: a merge to main starts the key tests. */
  assert.equal(answer({ EVENT: 'push' }), 'keys=false');
  /* RED WHEN: a pull request whose base cannot be read skips the key tests. */
  assert.equal(answer({ EVENT: 'pull_request', ACTION: 'opened', BASE: '', HEAD: '' }), 'keys=true');
});

/** The lines of one job of the check workflow, up to the next job. */
const jobOf = (text, id) => {
  const lines = text.split('\n');
  const at = lines.indexOf(`  ${id}:`);
  if (at === -1) return null;
  const next = lines.findIndex((l, i) => i > at && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return lines.slice(at, next === -1 ? lines.length : next).join('\n');
};
const WORKFLOW = readFileSync(join(HERE, '..', 'workflows', 'ci.yml'), 'utf8');
const jobIds = (text) =>
  [...text.slice(text.indexOf('\njobs:\n')).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);

/** What is wrong with the wiring from `changes` to the key jobs and `done`, or null. */
const wiringProblem = (text) => {
  const changes = jobOf(text, 'changes');
  const keys = jobOf(text, 'keys');
  const done = jobOf(text, 'done');
  if (changes === null || keys === null || done === null) return 'the workflow has no changes, keys or done job';
  const ids = jobIds(text);
  if (ids[0] !== 'changes' || ids[ids.length - 1] !== 'done')
    return `the jobs run in the order ${ids.join(', ')}: changes first and done last`;
  if (
    !/^ {4}name: changes$/m.test(changes) ||
    !/^ {4}name: keys \(\$\{\{ matrix\.group \}\}\)$/m.test(keys) ||
    !/^ {4}name: done$/m.test(done)
  )
    return 'a check is named other than changes, keys (<group>) and done';
  if (/^ {4}if:/m.test(changes)) return 'changes is conditional, so the key tests may wait on a job that never ran';
  const step = /^ {6}- id: (\S+)\n(?: {8}.*\n)*? {8}run: node \.github\/checks\/keys-paths\.mjs$/m.exec(changes);
  if (step === null) return 'changes does not run .github/checks/keys-paths.mjs in a step with an id';
  if (!changes.includes(`      keys: \${{ steps.${step[1]}.outputs.keys }}`))
    return `changes does not hand on the answer of its ${step[1]} step as its keys output`;
  if (!step[0].includes('          EVENT: ${{ github.event_name }}\n'))
    return 'changes does not tell the list which event started the run, so a merge to main reads as an unknown event';
  if (!/^ {10}fetch-depth: 0$/m.test(changes))
    return 'changes checks out without the history, so it cannot read what a pull request changed';
  if (!/^ {4}needs: changes$/m.test(keys)) return 'the key jobs do not wait for changes';
  if (!/^ {4}if: needs\.changes\.outputs\.keys == 'true'$/m.test(keys))
    return 'the key jobs run on something other than changes answering true';
  if (!/^ {4}if: always\(\)$/m.test(done))
    return 'done does not always run, so a failed job skips it and it reports green';
  const needs =
    /^ {4}needs: \[([^\]]*)\]$/m
      .exec(done)?.[1]
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean) ?? [];
  const missing = ids.filter((id) => id !== 'done' && !needs.includes(id));
  if (missing.length > 0) return `done does not wait for ${missing.join(', ')}, so it can pass while they fail`;
  if (!done.includes('[ "$job" = keys ] && [ "$KEYS" = false ]'))
    return 'done does not tie a skipped key job to changes answering false';
  return null;
};

test('the key jobs start on the answer, and done waits for every job', () => {
  assert.equal(wiringProblem(WORKFLOW), null);
  const refuses = (label, edited, matching) => {
    assert.notEqual(edited, WORKFLOW, `${label}: the edit changed nothing`);
    assert.match(String(wiringProblem(edited)), matching, label);
  };
  /* RED WHEN: a job is added to the page and done does not wait for it, so done passes while it fails. */
  refuses(
    'a job is left out of done',
    WORKFLOW.replace(/(\n {4}needs: \[[^\]]*), message\b/, '$1'),
    /does not wait for message/
  );
  refuses(
    'the lint job is left out of done',
    WORKFLOW.replace(/(\n {4}needs: \[[^\]]*), lint\b/, '$1'),
    /does not wait for lint/
  );
  refuses(
    'a new job is not added to done',
    WORKFLOW.replace('\n  done:\n', '\n  extra:\n    name: extra\n\n  done:\n'),
    /does not wait for extra/
  );
  /* RED WHEN: done stops running after a failure, or the key tests skip on anything but a false answer. */
  refuses(
    'done runs only when everything passed',
    WORKFLOW.replace(/(\n {2}done:\n(?:.*\n)*?) {4}if: always\(\)\n/, '$1'),
    /always run/
  );
  refuses(
    'the key jobs skip on a misread answer',
    WORKFLOW.replace("if: needs.changes.outputs.keys == 'true'", "if: needs.changes.outputs.keys != 'false'"),
    /something other than changes answering true/
  );
  refuses(
    'the key jobs do not wait for the answer',
    WORKFLOW.replace('\n    needs: changes\n', '\n'),
    /do not wait for changes/
  );
  /* RED WHEN: the answer is written under one name and read under another, so the key tests skip on every change. */
  refuses(
    'the output names a step that is not there',
    WORKFLOW.replace('steps.paths.outputs.keys }}\n    steps:', 'steps.path.outputs.keys }}\n    steps:'),
    /keys output/
  );
  refuses(
    'changes is made conditional',
    WORKFLOW.replace('\n    name: changes\n', "\n    name: changes\n    if: github.event_name == 'pull_request'\n"),
    /changes is conditional/
  );
  refuses(
    'changes does not say which event started the run',
    WORKFLOW.replace('          EVENT: ${{ github.event_name }}\n', ''),
    /which event started the run/
  );
  refuses('changes reads no history', WORKFLOW.replace('          fetch-depth: 0\n', ''), /without the history/);
  refuses(
    'done no longer allows a skip only on a false answer',
    WORKFLOW.replace('[ "$job" = keys ] && [ "$KEYS" = false ]', '[ "$job" = keys ]'),
    /skipped key job/
  );
  refuses(
    'a key check is renamed',
    WORKFLOW.replace('name: keys (${{ matrix.group }})', 'name: proofs (${{ matrix.group }})'),
    /named other than/
  );
  refuses(
    'done is not the last job',
    WORKFLOW.replace('\n  done:\n', '\n  done:\n    name: done\n\n  late:\n'),
    /done last|does not wait for late/
  );
});
