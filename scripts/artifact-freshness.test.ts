// Every test here makes the freshness guard refuse in a fixture tree, never in contracts/.
// Keep the file sequential: every test shares the module-level `root`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEYS_PATHS, pathMatches } from '../.github/checks/keys-paths.mjs';
import {
  type ArtifactPair,
  assertArtifactsFresh,
  CONTRACT_ARTIFACTS,
  findRefusals,
  refusalText
} from './artifact-freshness.js';
import { codeHash } from './contract-version.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The fixture's own pair. Deliberately not one of the real ones. */
const PAIR: ArtifactPair = {
  source: 'contracts/src/Fixture.compact',
  artifact: 'contracts/managed-fixture/contract/index.js',
  door: 'npm run compile:fixture'
};

let root = '';

/** Seconds since the epoch; `utimesSync` takes seconds, and whole ones avoid float drift. */
const setMtime = (path: string, seconds: number): void => utimesSync(path, seconds, seconds);

// A fixture tree at CONTRACT_ARTIFACTS' own paths, so the live default table finds every file it names.
const makeRealTree = (): string => {
  const tree = mkdtempSync(join(tmpdir(), 'artifact-freshness-live-'));
  for (const pair of CONTRACT_ARTIFACTS) {
    mkdirSync(dirname(join(tree, pair.source)), { recursive: true });
    mkdirSync(dirname(join(tree, pair.artifact)), { recursive: true });
    writeFileSync(join(tree, pair.source), 'circuit c(): [] {}\n');
    writeFileSync(join(tree, pair.artifact), 'export const Contract = {};\n');
    setMtime(join(tree, pair.source), 1_000_000);
    setMtime(join(tree, pair.artifact), 1_000_060);
  }
  return tree;
};

const sourcePath = (): string => join(root, PAIR.source);
const artifactPath = (): string => join(root, PAIR.artifact);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifact-freshness-'));
  mkdirSync(dirname(sourcePath()), { recursive: true });
  mkdirSync(dirname(artifactPath()), { recursive: true });
  writeFileSync(sourcePath(), 'circuit fixture(): [] {}\n');
  writeFileSync(artifactPath(), 'export const Contract = {};\n');
  // The state a compile leaves: the artifact written after the source was read.
  setMtime(sourcePath(), 1_000_000);
  setMtime(artifactPath(), 1_000_060);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the guard passes only what a compile would have left behind', () => {
  it('says nothing when the artifact is newer than the source', () => {
    expect(findRefusals(root, [PAIR])).toEqual([]);
    expect(() => assertArtifactsFresh(root, [PAIR])).not.toThrow();
  });

  it('says nothing when the two are stamped the same second', () => {
    // A filesystem with coarse resolution is not evidence of staleness, and a
    // guard that refused here would be refusing every fast compile.
    setMtime(artifactPath(), 1_000_000);
    expect(findRefusals(root, [PAIR])).toEqual([]);
  });
});

describe('BY THE CODE ONCE THE COMPILE RECORDED WHAT IT COMPILED', () => {
  // The compile writes <compiled folder>/.version with each source's code fingerprint. With it, a source
  // saved again with only its comments, spacing or save time changed is current; a code change is stale.
  const record = (): string => join(dirname(dirname(artifactPath())), '.version');
  const recordSource = (): void =>
    writeFileSync(record(), JSON.stringify({ sources: { [PAIR.source]: codeHash(sourcePath()) } }));

  it('says nothing when the same code is saved again after the compile', () => {
    recordSource();
    setMtime(sourcePath(), 1_000_061);
    expect(findRefusals(root, [PAIR])).toEqual([]);
  });

  it('says nothing when only a comment changed', () => {
    recordSource();
    writeFileSync(sourcePath(), '// a new comment\ncircuit fixture(): [] {}\n');
    setMtime(sourcePath(), 1_000_061);
    expect(findRefusals(root, [PAIR])).toEqual([]);
  });

  it('refuses when the code changed, whatever the save times say', () => {
    recordSource();
    writeFileSync(sourcePath(), 'circuit fixture(): [] { assert(true, "x"); }\n');
    setMtime(sourcePath(), 1_000_000);
    const refusals = findRefusals(root, [PAIR]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.kind).toBe('stale');
  });
});

describe('A FILE THE CONTRACT BRINGS IN IS CHECKED WITH IT', () => {
  // The main file imports a module by path; an edit made only in the module must turn the pair stale.
  const modulePath = (): string => join(root, 'contracts/src/modules/Part.compact');
  const record = (): string => join(dirname(dirname(artifactPath())), '.version');
  beforeEach(() => {
    mkdirSync(dirname(modulePath()), { recursive: true });
    writeFileSync(modulePath(), 'module Part { import CompactStandardLibrary; export circuit p(): [] {} }\n');
    writeFileSync(sourcePath(), 'import CompactStandardLibrary;\nimport "modules/Part";\ncircuit fixture(): [] {}\n');
    setMtime(modulePath(), 1_000_000);
    setMtime(sourcePath(), 1_000_000);
  });

  it('refuses when only the module was saved after the artifact', () => {
    expect(findRefusals(root, [PAIR])).toEqual([]);
    setMtime(modulePath(), 1_000_061);
    const refusals = findRefusals(root, [PAIR]);
    expect(refusals.map((r) => r.kind)).toEqual(['stale']);
    expect(refusals[0]!.sourceMs).toBe(1_000_061_000);
  });

  it("refuses when only the module's code changed, by the record, whatever the save times say", () => {
    writeFileSync(
      record(),
      JSON.stringify({
        sources: {
          [PAIR.source]: codeHash(sourcePath()),
          'contracts/src/modules/Part.compact': codeHash(modulePath())
        }
      })
    );
    expect(findRefusals(root, [PAIR])).toEqual([]);
    writeFileSync(
      modulePath(),
      'module Part { import CompactStandardLibrary; export circuit p(): [] { assert(true, "x"); } }\n'
    );
    setMtime(modulePath(), 1_000_000);
    expect(findRefusals(root, [PAIR]).map((r) => r.kind)).toEqual(['stale']);
  });

  it('refuses when the record was written before the module existed', () => {
    writeFileSync(record(), JSON.stringify({ sources: { [PAIR.source]: codeHash(sourcePath()) } }));
    expect(findRefusals(root, [PAIR]).map((r) => r.kind)).toEqual(['stale']);
  });
});

describe('THE REFUSAL FIRES — the whole reason this file exists', () => {
  it('refuses when the source is touched one second past the artifact', () => {
    setMtime(sourcePath(), 1_000_061);

    const refusals = findRefusals(root, [PAIR]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.kind).toBe('stale');
    expect(refusals[0]!.pair).toBe(PAIR);
    // The times are read off the filesystem, not computed.
    expect(refusals[0]!.sourceMs).toBe(1_000_061_000);
    expect(refusals[0]!.artifactMs).toBe(1_000_060_000);
  });

  it('THROWS rather than warns, so a caller cannot carry on past it', () => {
    setMtime(sourcePath(), 1_000_061);
    expect(() => assertArtifactsFresh(root, [PAIR])).toThrow(/THE SUITE DID NOT RUN/);
  });

  it('names the file and the DOOR, which is what a refusal owes the person', () => {
    setMtime(sourcePath(), 1_000_061);
    const text = refusalText(findRefusals(root, [PAIR]));
    expect(text).toContain(PAIR.source);
    expect(text).toContain(PAIR.artifact);
    expect(text).toContain(`Run ${PAIR.door}, then run this again.`);
    // Not a file to write, not a variable to set.
    expect(text).not.toMatch(/export |environment variable|SKIP|set [A-Z_]+=/);
  });

  it('SHOWS ITS WORKING — BOTH stamps it compared, distinguishable, in IST', () => {
    // The refusal shows both times it compared, each asserted, in different minutes so neither line can stand
    // in for the other.

    // The expected strings come from Intl.DateTimeFormat directly, not from ist(): 1_000_061_000 ms is 19:17 and
    // 999_940_000 ms is 19:15 in Asia/Kolkata.
    setMtime(artifactPath(), 999_940);
    setMtime(sourcePath(), 1_000_061);

    const text = refusalText(findRefusals(root, [PAIR]));
    const source = '12 Jan 1970, 19:17 IST';
    const artifact = '12 Jan 1970, 19:15 IST';
    expect(source).not.toBe(artifact);
    expect(text).toContain(source);
    expect(text).toContain(artifact);
    // The stamp sits on the line naming the file it belongs to, not merely
    // somewhere in the message.
    expect(text).toMatch(new RegExp(`source\\s+\\S*${PAIR.source}\\s+${source}`));
    expect(text).toMatch(new RegExp(`artifact\\s+\\S*${PAIR.artifact}\\s+${artifact}`));
    // The timezone is a claim about what the number is.
    expect(text).not.toContain('08:47');
  });

  it('refuses when the artifact was never built, not only when it is old', () => {
    rmSync(artifactPath());
    const refusals = findRefusals(root, [PAIR]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.kind).toBe('artifact-missing');
    const text = refusalText(refusals);
    expect(text).toContain('NOT BUILT');
    expect(text).toContain(PAIR.door);
  });

  it('refuses when the SOURCE is gone, and says no door resolves that', () => {
    // A renamed `.compact` must not silently retire the pair that guards it.
    rmSync(sourcePath());
    const refusals = findRefusals(root, [PAIR]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.kind).toBe('source-missing');
    const text = refusalText(refusals);
    expect(text).toContain('NO DOOR RESOLVES THIS');
    expect(text).not.toContain(`Run ${PAIR.door}`);
  });

  it('reports EVERY stale pair, not the first one it meets', () => {
    // A guard that stops at the first refusal sends a person through one door,
    // and the next run stops them at the second. Both doors, once.
    const second: ArtifactPair = {
      source: 'contracts/src/Other.compact',
      artifact: 'contracts/managed-other/contract/index.js',
      door: 'npm run compile:other'
    };
    mkdirSync(dirname(join(root, second.artifact)), { recursive: true });
    writeFileSync(join(root, second.source), 'circuit other(): [] {}\n');
    writeFileSync(join(root, second.artifact), 'export const Contract = {};\n');
    setMtime(join(root, second.artifact), 1_000_060);
    setMtime(join(root, second.source), 1_000_061);
    setMtime(sourcePath(), 1_000_061);

    const refusals = findRefusals(root, [PAIR, second]);
    expect(refusals.map((r) => r.kind)).toEqual(['stale', 'stale']);
    const text = refusalText(refusals);
    expect(text).toContain(`Run ${PAIR.door} and ${second.door}, then run this again.`);
  });

  it('names each door ONCE when two stale pairs share one', () => {
    // "Run npm run compact:vault and npm run compact:vault" is a refusal a
    // person reads twice to check they read it right.
    const sibling: ArtifactPair = { ...PAIR, source: 'contracts/src/Sibling.compact' };
    writeFileSync(join(root, sibling.source), 'circuit sibling(): [] {}\n');
    setMtime(join(root, sibling.source), 1_000_061);
    setMtime(sourcePath(), 1_000_061);

    const text = refusalText(findRefusals(root, [PAIR, sibling]));
    expect(text).toContain(`Run ${PAIR.door}, then run this again.`);
    expect(text.match(new RegExp(PAIR.door, 'g'))).toHaveLength(1);
  });

  it('cannot be disarmed by being given nothing to check', () => {
    // The only way past this guard from inside is an empty table, so an empty
    // table is an error rather than a pass.
    expect(() => findRefusals(root, [])).toThrow(/ZERO source\/artifact pairs/);
  });
});

describe('the guard is WIRED IN, and is pointed at the artifacts the tests import', () => {
  it('vitest.config.ts really HOLDS the globalSetup value — read, not grepped', async () => {
    // Imported as a module, so a commented-out key is `undefined` rather than a
    // regex match. This is the assertion the first way of disarming the guard walked past.
    const config = (await import('../vitest.config.ts')).default as {
      test?: { globalSetup?: string | string[]; include?: string[] };
    };
    const wired = config.test?.globalSetup;
    expect(wired).toBeDefined();
    expect(Array.isArray(wired) ? wired : [wired]).toContain('./scripts/artifact-freshness.globalSetup.ts');

    // The glob that collects this file: narrowing `include` past scripts/ would switch these tests off silently.
    expect(config.test?.include).toContain('scripts/**/*.test.ts');
  });

  it('THE WIRED MODULE ITSELF REFUSES — its default export, called, over a stale tree', async () => {
    // The module vitest loads, called as vitest calls it, so a try/catch or an environment gate around it is seen.
    const mod = await import('./artifact-freshness.globalSetup.js');
    expect(typeof mod.default).toBe('function');

    const tree = makeRealTree();
    try {
      // Fresh first, so the refusal below is the stale one and not a fixture
      // that was never right.
      expect(() => mod.default(undefined, tree)).not.toThrow();

      const account = CONTRACT_ARTIFACTS[0]!;
      setMtime(join(tree, account.source), 1_000_061);
      // The first argument is vitest's and is ignored; the second is the fixture root. The message must name this
      // source and this door.
      expect(() => mod.default(undefined, tree)).toThrow(new RegExp(`was edited after[\\s\\S]*${account.door}`));
      expect(() => mod.default(undefined, tree)).toThrow(new RegExp(account.source.replace(/[.]/g, '\\.')));
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('derives its root from its own location, not from the working directory', () => {
    // A guard that took its root from the caller could be pointed at a
    // directory with no contracts in it, where every pair is `source-missing`.
    const source = readFileSync(join(ROOT, 'scripts/artifact-freshness.globalSetup.ts'), 'utf8');
    expect(source).toContain("new URL('..', import.meta.url)");
    // Comments are stripped first, so the module's own explanation is not read as its code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('process.cwd()');
    expect(() => readFileSync(join(ROOT, 'package.json'), 'utf8')).not.toThrow();
  });

  it('THE LIVE DEFAULT is bound to the real table — no pairs argument, real paths', () => {
    // The default binding to CONTRACT_ARTIFACTS, which every other test bypasses by passing `pairs`.

    // The loop cannot see the table shrink, so its length is pinned here and its contents by the triples below.
    expect(CONTRACT_ARTIFACTS).toHaveLength(3);
    const tree = makeRealTree();
    try {
      expect(() => assertArtifactsFresh(tree)).not.toThrow();

      // Each pair on its own, so dropping EITHER from the table goes red.
      for (const pair of CONTRACT_ARTIFACTS) {
        setMtime(join(tree, pair.source), 1_000_061);
        expect(() => assertArtifactsFresh(tree)).toThrow(
          new RegExp(`${pair.source.replace(/[.]/g, '\\.')}[\\s\\S]*${pair.door}`)
        );
        setMtime(join(tree, pair.source), 1_000_000);
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('pairs each source with the door that rebuilds THAT artifact, not just a door', () => {
    // Each pair names the door that resolves it.
    expect(CONTRACT_ARTIFACTS.map((p) => [p.source, p.artifact, p.door])).toEqual([
      ['contracts/src/ConfidentialAccount.compact', 'contracts/managed/contract/index.js', 'npm run compact:fast'],
      ['contracts/src/Vault.compact', 'contracts/managed-vault/contract/index.js', 'npm run compact:fast'],
      ['contracts/src/PrivateRegistry.compact', 'contracts/managed-registry/contract/index.js', 'npm run compact:fast']
    ]);
  });

  it('every named door is one a reader of this repository can open, and every named source is here', () => {
    // Each door is a script in package.json and each source exists, so a refusal is one a person can act on.
    const pkg: { scripts: Record<string, string> } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    for (const pair of CONTRACT_ARTIFACTS) {
      const named = /^npm run ([A-Za-z0-9:_-]+)$/.exec(pair.door);
      expect({
        door: pair.door,
        defined: named !== null && named[1] !== undefined && typeof pkg.scripts[named[1]] === 'string'
      }).toEqual({ door: pair.door, defined: true });
      expect(() => readFileSync(join(ROOT, pair.source), 'utf8')).not.toThrow();
    }
  });

  // Key-gated assertions skip wherever the keys are not built, so one job must build them and then run every
  // gated file; this reads the workflow's shape and refuses a shape it cannot read.

  /** A step, read far enough to answer whether it runs and what it runs. */
  type WorkflowStep = {
    readonly run: string | null;
    readonly conditional: boolean;
    readonly tolerated: boolean;
    readonly env: Readonly<Record<string, string>>;
  };
  /** A named group of a job's matrix: its one-line description and the files it runs. */
  type WorkflowGroup = { readonly group: string; readonly about: string; readonly files: readonly string[] };
  /**
   * A job, in the order its steps are written. A step running `${{ matrix.files }}` reads as running every group's files.
   * `condition` is the job's own `if:`, null when it has none and `<more than one>` when it has two.
   */
  type WorkflowJob = {
    readonly id: string;
    readonly condition: string | null;
    readonly needs: string;
    readonly tolerated: boolean;
    readonly steps: readonly WorkflowStep[];
    readonly groups: readonly WorkflowGroup[];
  };

  const parseWorkflow = (text: string): WorkflowJob[] => {
    const lines = text.split('\n');
    const jobsAt = lines.findIndex((l) => l === 'jobs:');
    if (jobsAt === -1) throw new Error('this is not a workflow: it has no `jobs:` block');
    const jobs: WorkflowJob[] = [];
    let job: {
      id: string;
      condition: string | null;
      needs: string;
      tolerated: boolean;
      steps: WorkflowStep[];
      groups: { group: string; about: string; files: string[] }[];
    } | null = null;
    let step: { run: string | null; conditional: boolean; tolerated: boolean; env: Record<string, string> } | null =
      null;
    let inEnv = false;
    let inSteps = false;
    let block: { indent: number; parts: string[] } | null = null;

    const closeStep = () => {
      if (job && step) job.steps.push({ ...step, run: block ? block.parts.join(' ').trim() : step.run });
      step = null;
      block = null;
    };
    const closeJob = () => {
      closeStep();
      if (job) {
        const all = job.groups.flatMap((g) => g.files).join(' ');
        jobs.push({
          ...job,
          steps: job.steps.map((st) => ({
            ...st,
            run: st.run === null ? null : st.run.replace('${{ matrix.files }}', all)
          }))
        });
      }
      job = null;
      inSteps = false;
    };

    for (const raw of lines.slice(jobsAt + 1)) {
      const line = raw.replace(/\s+$/, '');
      if (line === '') continue;
      const indent = line.length - line.trimStart().length;
      const body = line.trim();
      if (block && indent > block.indent) {
        block.parts.push(body);
        continue;
      }
      if (block) block = null;
      if (body.startsWith('#')) continue;

      if (indent === 2 && /^[A-Za-z0-9_-]+:$/.test(body)) {
        closeJob();
        job = { id: body.slice(0, -1), condition: null, needs: '', tolerated: false, steps: [], groups: [] };
        continue;
      }
      if (!job) continue;
      if (indent === 4 && body === 'steps:') {
        inSteps = true;
        continue;
      }
      if (indent === 4 && body.startsWith('if:')) {
        job.condition = job.condition === null ? body.slice(3).trim() : '<more than one>';
        continue;
      }
      if (indent === 4 && body.startsWith('needs:')) {
        job.needs = body.slice(6).trim();
        continue;
      }
      if (indent === 4 && body.startsWith('continue-on-error:')) {
        job.tolerated = !/false\s*$/.test(body);
        continue;
      }
      // The matrix's named groups: `- group:` opens one, and its `about:` and `files:` follow it.
      if (!inSteps && indent === 10 && body.startsWith('- group:')) {
        job.groups.push({ group: body.slice(8).trim(), about: '', files: [] });
        continue;
      }
      const open = job.groups[job.groups.length - 1];
      if (!inSteps && indent === 12 && open !== undefined && body.startsWith('about:')) {
        open.about = body.slice(6).trim();
        continue;
      }
      if (!inSteps && indent === 12 && open !== undefined && body.startsWith('files:')) {
        open.files = body.slice(6).trim().split(/\s+/).filter(Boolean);
        continue;
      }
      if (!inSteps) continue;
      if (indent === 6 && body.startsWith('- ')) {
        closeStep();
        step = { run: null, conditional: false, tolerated: false, env: {} };
        inEnv = false;
      }
      if (!step) continue;
      if (inEnv && indent === 10) {
        const [k, ...v] = body.split(':');
        step.env[k!.trim()] = v.join(':').trim().replace(/^'|'$/g, '');
        continue;
      }
      inEnv = false;
      const field = body.replace(/^- /, '');
      if (indent === 8 && field === 'env:') {
        inEnv = true;
        continue;
      }
      if (field.startsWith('run:')) {
        const rest = field.slice(4).trim();
        if (rest === '|' || rest === '>') block = { indent, parts: [] };
        else step.run = rest;
        continue;
      }
      if (field.startsWith('if:')) {
        step.conditional = true;
        continue;
      }
      if (field.startsWith('continue-on-error:')) {
        step.tolerated = !/false\s*$/.test(field);
        continue;
      }
    }
    closeJob();
    if (jobs.length === 0) throw new Error('this workflow declares no jobs, so nothing below would mean anything');
    return jobs;
  };

  /** What starts the workflow: the pull-request paths (null when every change does), whether it ignores paths, and a nightly run. */
  type Triggers = {
    readonly pullRequest: boolean;
    readonly paths: readonly string[] | null;
    readonly ignores: boolean;
    readonly nightly: boolean;
    readonly types: string;
    readonly narrowed: boolean;
    readonly byHand: boolean;
  };

  const parseTriggers = (text: string): Triggers => {
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l === 'on:');
    if (at === -1) throw new Error('this workflow has no `on:` block, so when it runs cannot be read');
    let event = '';
    let key = '';
    let pullRequest = false;
    let paths: string[] | null = null;
    let ignores = false;
    let nightly = false;
    let types = '';
    let narrowed = false;
    let byHand = false;
    for (const raw of lines.slice(at + 1)) {
      const line = raw.replace(/\s+$/, '');
      if (line === '' || line.trim().startsWith('#')) continue;
      if (!line.startsWith(' ')) break;
      const indent = line.length - line.trimStart().length;
      const body = line.trim();
      if (indent === 2) {
        event = body.replace(/:.*$/, '');
        key = '';
        if (event === 'pull_request') pullRequest = true;
        if (event === 'workflow_dispatch') byHand = true;
        continue;
      }
      if (indent === 4 && !body.startsWith('- ')) {
        key = body.replace(/:.*$/, '');
        if (event === 'pull_request' && key === 'paths') paths = [];
        if (event === 'pull_request' && key === 'paths-ignore') ignores = true;
        if (event === 'pull_request' && key === 'types') types = body.replace(/^types:\s*/, '');
        if (event === 'pull_request' && /^branches/.test(key)) narrowed = true;
        continue;
      }
      // Every night: a fixed minute and hour, every day of every month.
      if (event === 'schedule' && /^- cron: '\d{1,2} \d{1,2} \* \* \*'$/.test(body)) nightly = true;
      if (event === 'pull_request' && key === 'paths' && indent === 6 && body.startsWith('- '))
        paths?.push(body.slice(2).trim().replace(/^'|'$/g, ''));
    }
    return { pullRequest, paths, ignores, nightly, types, narrowed, byHand };
  };

  // The keys run when a file they load changes: each gated file, the contracts, package.json, the lockfile, the
  // workflow and the path list must each start them.
  const MUST_START = [
    'contracts/src/Vault.compact',
    'package.json',
    'package-lock.json',
    '.github/workflows/ci.yml',
    '.github/checks/keys-paths.mjs'
  ];
  // The paths, pinned whole and written out apart from the changes job's list, so a path taken out there is refused.
  const KEY_PATHS = [
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
  ];
  /*
   * THE ONE CONDITION THE KEYS JOB MAY CARRY: `changes` answered true. Any other `if:` can leave it unrun with every
   * mark green, and `changes` answers true wherever it cannot tell.
   */
  const KEYS_CONDITION = "needs.changes.outputs.keys == 'true'";
  const KEYS_ANSWER = 'node .github/checks/keys-paths.mjs';
  /** Why the keys would not start on a change that can break them, or null. `paths` is the list the `changes` job reads. */
  const triggerProblem = (workflow: string, gated: readonly string[], paths: readonly string[]): string | null => {
    const t = parseTriggers(workflow);
    if (!t.nightly) return 'the keys run on no night: the workflow has no schedule';
    if (!t.pullRequest) return 'the keys never run on a pull request';
    if (!t.byHand) return 'the keys cannot be run by hand: the workflow has no workflow_dispatch';
    if (t.narrowed) return 'the keys run only on pull requests into some branches';
    if (!['opened', 'synchronize', 'reopened'].every((x) => t.types.includes(x)))
      return `the keys do not run on every push to a pull request (types ${t.types})`;
    if (t.ignores)
      return 'the checks skip paths by paths-ignore, so a change there starts no check at all, the keys included';
    if (t.paths !== null)
      return 'the checks start only on some paths, so a change outside them starts no check at all, the keys included';
    if (paths.length === 0) return 'the keys run on no change at all: the paths the changes job reads are empty';
    const missing = KEY_PATHS.filter((g) => !paths.includes(g));
    if (missing.length > 0)
      return `a change to ${missing.join(', ')} can break a key test and no longer starts the keys`;
    const extra = paths.filter((g) => !KEY_PATHS.includes(g));
    if (extra.length > 0)
      return `the paths hold ${extra.join(', ')}, which the list read off the graph does not: add it there, or take it out`;
    for (const f of [...gated, ...MUST_START]) {
      if (!paths.some((g) => pathMatches(g, f))) return `${f} can break a key test and no change to it starts the keys`;
    }
    return null;
  };

  /** Why the keys job could skip on anything but `changes` answering false, or null. */
  const conditionProblem = (jobs: readonly WorkflowJob[], job: WorkflowJob): string | null => {
    if (job.condition === null) return null;
    if (job.condition !== KEYS_CONDITION) return `the ${job.id} job is conditional, so it need never run`;
    if (!job.needs.split(/[\s,[\]]+/).includes('changes'))
      return `the ${job.id} job reads the changes job's answer without waiting for it`;
    const changes = jobs.find((j) => j.id === 'changes');
    if (changes === undefined) return `the ${job.id} job waits on a changes job the workflow does not have`;
    if (changes.condition !== null)
      return 'the changes job is conditional, so the keys can wait on an answer never given';
    if (changes.tolerated) return 'the changes job tolerates its own failure';
    const answer = changes.steps.find((s) => s.run === KEYS_ANSWER);
    if (answer === undefined) return `the changes job does not run ${KEYS_ANSWER}, so its answer is not the list's`;
    if (answer.conditional || answer.tolerated)
      return 'the step that answers whether the keys run is conditional or tolerates its own failure';
    return null;
  };

  // Every file whose assertions are gated on the verifier keys. Both searched texts are assembled from pieces so
  // this file does not match itself.
  const KEY_DIR = ['contracts', 'managed', 'keys'].join('/');
  // The vault is a second contract, and its keys come from a build of its own.
  const VAULT_KEY_DIR = ['contracts', 'managed-vault', 'keys'].join('/');
  // The network's shielded circuits are fetched by `npm run vendor-keys` into the
  // wallet's own folder, which the job that builds the keys runs before its tests.
  const NETWORK_KEY_DIR = ['apps', 'wallet', 'public', 'keys', 'zswap'].join('/');
  // The company account's keys are copied into the wallet's own folder by a command of
  // their own, after the build: a test that needs them names that command.
  const WALLET_ACCOUNT_KEYS = ['npm run vendor-keys', 'account'].join(':');
  const GATE = `skip${'If'}(`;
  // The helper every account and vault key gate reads the keys through: a file that imports it is
  // gated on the keys whether or not any title names a key folder.
  const KEYS_HELPER = ['keys', 'on', 'disk'].join('-');
  const ACCOUNT_AND_VAULT_KEYS: readonly string[] = [KEY_DIR, VAULT_KEY_DIR, KEYS_HELPER];

  const isGatedOnKeys = (text: string, dirs: readonly string[]): boolean =>
    dirs.some((d) => text.includes(d)) && text.includes(GATE);

  // Every tree a test can live in: the three fixed ones, and each src folder under apps/ and packages/.
  const keyRoots = (): string[] => {
    const grouped = ['apps', 'packages'].flatMap((group) =>
      !existsSync(join(ROOT, group))
        ? []
        : readdirSync(join(ROOT, group))
            .filter(
              (name) =>
                existsSync(join(ROOT, group, name, 'src')) && statSync(join(ROOT, group, name, 'src')).isDirectory()
            )
            .map((name) => `${group}/${name}/src`)
    );
    return ['src', 'scripts', 'contracts/test', ...grouped.sort()];
  };
  const KEY_ROOTS: readonly string[] = keyRoots();

  const gatedOnKeys = (dirs: readonly string[] = ACCOUNT_AND_VAULT_KEYS): string[] => {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(join(ROOT, rel))) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        const child = `${rel}/${name}`;
        if (statSync(join(ROOT, child)).isDirectory()) {
          walk(child);
          continue;
        }
        if (!/\.test\.tsx?$/.test(name)) continue;
        const text = readFileSync(join(ROOT, child), 'utf8');
        // Gated means BOTH: it names a key directory or imports the keys helper, and it turns
        // something off. Either alone is a file that merely mentions one of them.
        if (isGatedOnKeys(text, dirs)) out.push(child);
      }
    };
    for (const tree of KEY_ROOTS) walk(tree);
    return out.sort();
  };

  const keysCoverageProblem = (
    workflow: string,
    gated: readonly string[],
    vaultGated: readonly string[] = gatedOnKeys([VAULT_KEY_DIR]),
    walletAccountGated: readonly string[] = gatedOnKeys([WALLET_ACCOUNT_KEYS]),
    paths: readonly string[] = KEYS_PATHS
  ): string | null => {
    if (gated.length === 0) return 'nothing in the tree gates on the verifier keys, so this rule is checking nothing';
    const jobs = parseWorkflow(workflow);
    const starts = triggerProblem(workflow, gated, paths);
    if (starts !== null) return starts;

    // `npm run compact` is the full build (the fast one leaves no keys), matched whole so `compact:fast` is not it.
    const builds = (s: WorkflowStep) => s.run !== null && /(^|&&\s*)npm run compact(\s|$)/.test(s.run);
    const carrying = jobs.filter((j) => j.steps.some(builds));
    if (carrying.length !== 1) return `${carrying.length} jobs build the proving keys; there must be exactly one`;
    const job = carrying[0]!;
    const condition = conditionProblem(jobs, job);
    if (condition !== null) return condition;
    if (job.tolerated) return `the ${job.id} job tolerates its own failure`;
    // EACH GROUP FILE IS A FILE OF THIS TREE, WRITTEN AS THE TREE WRITES IT, or the test it meant runs in no group.
    for (const g of job.groups) {
      for (const f of g.files) {
        if (f !== f.replace(/^\.\//, '') || !existsSync(join(ROOT, f)))
          return `the ${g.group} group of ${job.id} names ${f}, which is no file of this tree`;
      }
    }

    const at = job.steps.findIndex(builds);
    const build = job.steps[at]!;
    if (build.conditional) return `the step that builds the keys in ${job.id} is conditional, so it need never run`;
    if (build.tolerated) return `the step that builds the keys in ${job.id} tolerates its own failure`;

    // AFTER the build, not merely in the same job. Ordered the other way, the
    // tests run against no keys, skip, and report green.
    const after = job.steps.slice(at + 1);
    const reads = after.filter((s) => s.run !== null && /(^|&&\s*)(npx )?vitest run(\s|$)/.test(s.run));
    if (reads.length === 0) return `nothing in ${job.id} runs the suite after the keys are built`;
    const runs = (s: WorkflowStep, f: string): boolean => (s.run as string).split(/\s+/).includes(f);
    for (const missing of gated.filter((f) => !reads.some((s) => runs(s, f)))) {
      return `${missing} gates on the keys and is run by no step after they are built`;
    }
    // The vault's keys need the vault's own full build in the same job, before the step that runs the file.
    if (vaultGated.length > 0) {
      const buildsVault = (s: WorkflowStep) =>
        s.run !== null && /(^|&&\s*)npm run compact:vault -- --full(\s|$)/.test(s.run);
      const v = job.steps.findIndex(buildsVault);
      if (v === -1) return `nothing in ${job.id} builds the vault's keys, and ${vaultGated[0]} reads them`;
      if (job.steps[v]!.conditional)
        return `the step that builds the vault's keys in ${job.id} is conditional, so it need never run`;
      if (job.steps[v]!.tolerated)
        return `the step that builds the vault's keys in ${job.id} tolerates its own failure`;
      const afterVault = job.steps.slice(v + 1).filter((s) => reads.includes(s));
      for (const missing of vaultGated.filter((f) => !afterVault.some((s) => runs(s, f)))) {
        return `${missing} reads the vault's keys and is run by no step after they are built`;
      }
    }
    // The wallet proves with keys copied into its own folder after the build and before the step that runs it.
    if (walletAccountGated.length > 0) {
      const copies = (s: WorkflowStep) =>
        s.run !== null && new RegExp(`(^|&&\\s*)${WALLET_ACCOUNT_KEYS}(\\s|$)`).test(s.run);
      const c = job.steps.findIndex(copies);
      if (c === -1 || c < at)
        return `nothing in ${job.id} copies the account's keys into the wallet after they are built, and ${walletAccountGated[0]} proves with them`;
      if (job.steps[c]!.conditional)
        return `the step that copies the account's keys into the wallet in ${job.id} is conditional, so it need never run`;
      if (job.steps[c]!.tolerated)
        return `the step that copies the account's keys into the wallet in ${job.id} tolerates its own failure`;
      const afterCopy = after.slice(c - at).filter((s) => reads.includes(s));
      for (const missing of walletAccountGated.filter((f) => !afterCopy.some((s) => runs(s, f)))) {
        return `${missing} proves with the account's keys in the wallet and is run by no step after they are copied there`;
      }
    }
    // EVERY FILE IN EXACTLY ONE NAMED GROUP, each group with its one-line description.
    const seen = new Map<string, string>();
    for (const g of job.groups) {
      if (g.about === '') return `the ${g.group} group of ${job.id} has no one-line description`;
      if (g.files.length === 0) return `the ${g.group} group of ${job.id} runs no files`;
      for (const f of g.files) {
        if (seen.has(f)) return `${f} is in two groups of ${job.id}, ${seen.get(f)} and ${g.group}`;
        seen.set(f, g.group);
      }
    }
    for (const s of reads) {
      if (s.conditional) return `a step in ${job.id} that reads the keys is conditional, so it need never run`;
      if (s.tolerated) return `a step in ${job.id} that reads the keys tolerates its own failure`;
      if (/--passWithNoTests/.test(s.run as string)) return `a step in ${job.id} passes when it collects nothing`;
      if (/\|\|/.test(s.run as string))
        return `a step in ${job.id} that reads the keys carries ||, so its failure need not count`;
      const flags = (s.run as string).split(/\s+/).filter((w) => w.startsWith('-'));
      if (flags.length > 0) return `a step in ${job.id} that reads the keys filters its run with ${flags.join(' ')}`;
      if (s.env.KEYS_MUST_BE_BUILT !== '1')
        return `a step in ${job.id} that reads the keys does not set KEYS_MUST_BE_BUILT, so a missing key stands down green`;
    }
    return null;
  };

  const WORKFLOW = () => readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('THE ASSERTIONS THAT NEED PROVING KEYS ARE STILL MADE SOMEWHERE, or this goes red', () => {
    const gated = gatedOnKeys();
    // The walk decides which files a copy has, so every gated file must be named here and the names are
    // intersected with what the walk found; the emptiness refusal stops it passing over nothing.
    const NAMED = [
      'contracts/test/a-company-born-held-from-the-browser.test.ts',
      'contracts/test/a-company-seats-its-signers-from-the-page.test.ts',
      'contracts/test/a-company-vault-from-the-page.test.ts',
      'contracts/test/a-payment-needs-a-vaults-receipt.test.ts',
      'contracts/test/a-private-payment-from-the-page.test.ts',
      'contracts/test/a-recovery-is-carried-out-on-the-chain.test.ts',
      'contracts/test/a-run-is-raised-approved-and-paid-on-the-signers-devices.test.ts',
      'contracts/test/a-run-raised-and-approved-from-the-page.test.ts',
      'contracts/test/a-spending-policy-is-set-from-a-device.test.ts',
      'contracts/test/a-vaults-committee-changes-with-its-signers.test.ts',
      'contracts/test/the-record-anchor-from-the-page.test.ts',
      'packages/web-shared/src/a-public-deposit-is-proved-on-the-device.test.ts',
      'packages/web-shared/src/a-deposit-built-on-the-device.test.ts',
      'packages/web-shared/src/a-vault-is-read-as-it-was-born.test.ts',
      'packages/web-shared/src/the-device-proves-only-with-this-builds-keys.test.ts',
      'packages/web-shared/src/vault-on-chain-here.test.ts',
      'packages/web-shared/src/vault-worker-client.test.ts',
      'packages/web-shared/src/the-worker-builds-an-account-only-with-this-builds-keys.test.ts',
      'src/midnight/a-company-is-created-in-two-steps.test.ts',
      'src/midnight/deferred-set.test.ts',
      'src/midnight/a-contracts-maintenance-authority-is-read-planned-and-refused.test.ts',
      'src/midnight/the-key-reaches-the-circuit.test.ts',
      'src/midnight/the-secret-comes-from-the-keyring.test.ts',
      'src/server/account-creation.test.ts',
      'src/wiring/vault-submission.test.ts',
      'apps/wallet/src/chain/creation-screen-in-a-browser.test.ts',
      'apps/wallet/src/chain/this-builds-account-keys.test.ts',
      'apps/wallet/src/chain/the-wallet-proves-the-pay-key.test.ts',
      'apps/wallet/src/chain/the-wallet-builds-a-vault-with-its-own-keys.test.ts',
      'apps/wallet/src/chain/a-company-account-is-read-at-one-block.test.ts',
      'apps/wallet/src/screens/approve-creation.test.tsx',
      'apps/wallet/src/actions/finish-company.test.ts',
      'apps/wallet/src/chain/the-wallet-anchors-with-its-own-keys.test.ts',
      'apps/wallet/src/chain/a-signer-invited-by-address-is-seated-from-the-wallet.test.ts',
      'contracts/test/keys-on-disk.test.ts',
      'contracts/test/the-compiled-keys-are-the-keys-on-disk.test.ts',
      'contracts/test/vault-recovery.test.ts',
      'contracts/test/vault-registry.test.ts',
      'contracts/test/vault-split.test.ts',
      'contracts/test/vault-threshold-recovery.test.ts',
      'contracts/test/vault-unshielded.test.ts',
      'src/midnight/vault-coin-nonces.test.ts',
      'contracts/test/a-deposit-made-on-the-device.test.ts',
      'contracts/test/a-vault-rebuilt-with-us-gone.test.ts',
      'contracts/test/a-vaults-secret-is-replaced-by-a-signer-who-did-not-raise-it.test.ts',
      'contracts/test/the-new-vault.test.ts',
      'contracts/test/a-company-before-its-second-step-lands.test.ts',
      'contracts/test/transcript.test.ts',
      'contracts/test/vault-batch-and-merge.test.ts',
      'contracts/test/vault-client.test.ts',
      'contracts/test/vault-payout.test.ts',
      'apps/wallet/src/chain/account-circuits.test.ts'
    ];
    expect(
      gated.filter((f) => !NAMED.includes(f)),
      'a test is gated on proving keys and this list does not name it'
    ).toEqual([]);
    expect(
      NAMED.filter((f) => existsSync(join(ROOT, f)) && !gated.includes(f)),
      'a test named here is still in this tree and is no longer gated on keys'
    ).toEqual([]);
    // A RULE OVER AN EMPTY LIST IS A RULE OVER NOTHING, and that was the point
    // of pinning the whole list. It is kept, as a floor rather than an identity.
    expect(gated.length, 'the walk found no gated tests, so nothing below means anything').toBeGreaterThan(0);
    const VAULT_NAMED = [
      'packages/web-shared/src/vault-on-chain-here.test.ts',
      'packages/web-shared/src/vault-worker-client.test.ts',
      'packages/web-shared/src/a-public-deposit-is-proved-on-the-device.test.ts',
      'packages/web-shared/src/the-device-proves-only-with-this-builds-keys.test.ts',
      'contracts/test/a-company-vault-from-the-page.test.ts',
      'contracts/test/a-private-payment-from-the-page.test.ts',
      'contracts/test/a-vaults-committee-changes-with-its-signers.test.ts',
      'src/wiring/vault-submission.test.ts',
      'packages/web-shared/src/a-deposit-built-on-the-device.test.ts',
      'packages/web-shared/src/a-vault-is-read-as-it-was-born.test.ts',
      'contracts/test/a-payment-needs-a-vaults-receipt.test.ts',
      'contracts/test/a-run-is-raised-approved-and-paid-on-the-signers-devices.test.ts',
      'apps/wallet/src/chain/the-wallet-builds-a-vault-with-its-own-keys.test.ts'
    ];
    const vaultGated = gatedOnKeys([VAULT_KEY_DIR]);
    expect(
      vaultGated.filter((f) => !VAULT_NAMED.includes(f)),
      'a test is gated on the vault keys and this list does not name it'
    ).toEqual([]);
    expect(
      VAULT_NAMED.filter((f) => existsSync(join(ROOT, f)) && !vaultGated.includes(f)),
      'a test named here is still in this tree and is no longer gated on the vault keys'
    ).toEqual([]);
    expect(keysCoverageProblem(WORKFLOW(), gated)).toBeNull();
    /* RED WHEN: a test is skipped without the network's shielded circuits and this list does not name it, so it can stop running in every job unnoticed. */
    const NETWORK_NAMED = ['packages/web-shared/src/the-device-proves-only-with-this-builds-keys.test.ts'];
    const networkGated = gatedOnKeys([NETWORK_KEY_DIR]);
    expect(
      networkGated.filter((f) => !NETWORK_NAMED.includes(f)),
      "a test is gated on the network's shielded circuits and this list does not name it"
    ).toEqual([]);
    expect(
      NETWORK_NAMED.filter((f) => existsSync(join(ROOT, f)) && !networkGated.includes(f)),
      "a test named here is still in this tree and is no longer gated on the network's shielded circuits"
    ).toEqual([]);
    /* RED WHEN: a test is skipped without the account's keys in the wallet and this list does not name it, so it can stop running in every job unnoticed. */
    const WALLET_ACCOUNT_NAMED = [
      'apps/wallet/src/chain/the-wallet-proves-the-pay-key.test.ts',
      'apps/wallet/src/chain/the-wallet-builds-a-vault-with-its-own-keys.test.ts',
      'apps/wallet/src/chain/the-wallet-anchors-with-its-own-keys.test.ts',
      'apps/wallet/src/chain/a-signer-invited-by-address-is-seated-from-the-wallet.test.ts'
    ];
    const walletAccountGated = gatedOnKeys([WALLET_ACCOUNT_KEYS]);
    expect(
      walletAccountGated.filter((f) => !WALLET_ACCOUNT_NAMED.includes(f)),
      "a test is gated on the account's keys in the wallet and this list does not name it"
    ).toEqual([]);
    expect(
      WALLET_ACCOUNT_NAMED.filter((f) => existsSync(join(ROOT, f)) && !walletAccountGated.includes(f)),
      "a test named here is still in this tree and is no longer gated on the account's keys in the wallet"
    ).toEqual([]);
  });

  it('a test is gated on the keys by the helper it imports, with no key folder named, and the walk reaches every package', () => {
    /* RED WHEN: a test that reads the proving keys through the shared helper, and names no key folder in its text, is not counted as needing the keys, so it can stop running in every job unnoticed. */
    const throughHelper = `import { keysOnDisk } from './${KEYS_HELPER}.js';\ndescribe.${GATE}!K.ok)('x', () => {});\n`;
    expect(isGatedOnKeys(throughHelper, ACCOUNT_AND_VAULT_KEYS)).toBe(true);
    /* RED WHEN: a test that only reads the shared keys helper is listed as needing the vault's keys, the network's circuits or the wallet's copy of the account's keys, which it does not. */
    for (const other of [[VAULT_KEY_DIR], [NETWORK_KEY_DIR], [WALLET_ACCOUNT_KEYS]]) {
      expect(isGatedOnKeys(throughHelper, other), other[0]).toBe(false);
    }
    /* RED WHEN: a test that skips on something unrelated to the keys is counted as needing them, so the list names tests the key job has no reason to run. */
    expect(isGatedOnKeys(`describe.${GATE}!process.env.SOMETHING)('x', () => {});\n`, ACCOUNT_AND_VAULT_KEYS)).toBe(
      false
    );
    /* RED WHEN: a test that imports the keys helper but never skips anything is counted as needing the keys, though it runs everywhere. */
    expect(isGatedOnKeys(`import { keysOnDisk } from './${KEYS_HELPER}.js';\n`, ACCOUNT_AND_VAULT_KEYS)).toBe(false);
    /* RED WHEN: a key-gated test placed in the identity package is never looked for, so it can stop running in every job unnoticed. */
    expect(KEY_ROOTS).toContain('packages/identity/src');
    /* RED WHEN: a tree the key gate used to read is no longer read, so a test in it can drop out of the list silently. */
    for (const old of [
      'src',
      'scripts',
      'contracts/test',
      'packages/web-shared/src',
      'apps/wallet/src',
      'apps/web/src'
    ]) {
      expect(KEY_ROOTS, old).toContain(old);
    }
  });

  it('and the rule above refuses every way that coverage can be taken away', () => {
    // Each of these mutations would leave a text-matching version of this rule green.
    const real = WORKFLOW();
    const gated = gatedOnKeys();
    /* Each walk of the tree is made once here, not once for every edit below. */
    const walked = [gatedOnKeys([VAULT_KEY_DIR]), gatedOnKeys([WALLET_ACCOUNT_KEYS])] as const;
    const refuses = (label: string, edited: string, matching: RegExp) => {
      expect(edited, `${label}: the edit changed nothing, so it proves nothing`).not.toBe(real);
      expect(keysCoverageProblem(edited, gated, ...walked), label).toMatch(matching);
    };
    /* The same, for an edit to the list of paths the changes job reads. */
    const refusesPaths = (label: string, edited: readonly string[], matching: RegExp) => {
      expect(edited, `${label}: the edit changed nothing, so it proves nothing`).not.toEqual([...KEYS_PATHS]);
      expect(keysCoverageProblem(real, gated, ...walked, edited), label).toMatch(matching);
    };
    const without = (path: string): string[] => {
      expect(KEYS_PATHS, `${path} is not on the list, so taking it off proves nothing`).toContain(path);
      return KEYS_PATHS.filter((g) => g !== path);
    };

    refuses(
      'the build step is commented out',
      real.replace(/\n(\s+)run: npm run compact\n/, '\n$1# run: npm run compact\n'),
      /build the proving keys|exactly one/
    );
    refuses(
      'the build step is made conditional',
      real.replace(/\n(\s+)run: npm run compact\n/, '\n$1if: false\n$1run: npm run compact\n'),
      /conditional/
    );
    refuses(
      'the build step tolerates its own failure',
      real.replace(/\n(\s+)run: npm run compact\n/, '\n$1continue-on-error: true\n$1run: npm run compact\n'),
      /tolerates/
    );
    refuses(
      'the whole job is made conditional',
      real.replace(/\n {4}name: keys \(/, '\n    if: false\n    name: keys ('),
      /job is conditional/
    );
    // THE ONE CONDITION IT MAY CARRY IS `changes` ANSWERING TRUE, read from a job that always runs and runs the list.
    refuses(
      "the whole job's condition is replaced by one that is never true",
      real.replace(`    if: ${KEYS_CONDITION}\n`, '    if: false\n'),
      /keys job is conditional/
    );
    refuses(
      'the job runs only when the answer is false',
      real.replace(`    if: ${KEYS_CONDITION}\n`, "    if: needs.changes.outputs.keys == 'false'\n"),
      /keys job is conditional/
    );
    refuses(
      'the job runs on any answer but true, so a missing one skips it',
      real.replace(`    if: ${KEYS_CONDITION}\n`, "    if: always() && needs.changes.outputs.keys == 'true'\n"),
      /keys job is conditional/
    );
    refuses(
      'the job reads the answer without waiting for it',
      real.replace(`    needs: changes\n    if: ${KEYS_CONDITION}\n`, `    if: ${KEYS_CONDITION}\n`),
      /without waiting for it/
    );
    refuses(
      'the changes job is gone',
      real.replace(/\n {2}changes:\n(?: {4}[^\n]*\n| {6,}[^\n]*\n|\n)*?(?= {2}compile:\n)/, '\n'),
      /changes job the workflow does not have/
    );
    refuses(
      'the changes job is made conditional',
      real.replace('\n    name: changes\n', "\n    name: changes\n    if: github.event_name == 'pull_request'\n"),
      /changes job is conditional/
    );
    refuses(
      'the changes job tolerates its own failure',
      real.replace('\n    name: changes\n', '\n    name: changes\n    continue-on-error: true\n'),
      /changes job tolerates/
    );
    refuses(
      'the changes job answers without the list',
      real.replace(`        run: ${KEYS_ANSWER}\n`, '        run: echo keys=false >> "$GITHUB_OUTPUT"\n'),
      /does not run node \.github\/checks\/keys-paths\.mjs/
    );
    refuses(
      'the step that answers is made conditional',
      real.replace(`        run: ${KEYS_ANSWER}\n`, `        if: false\n        run: ${KEYS_ANSWER}\n`),
      /answers whether the keys run is conditional/
    );
    refuses(
      'the runner is replaced by something that only prints',
      real.replace('- run: npx vitest run ${{ matrix.files }}', '- run: echo npx vitest run ${{ matrix.files }}'),
      /runs the suite after/
    );
    // Matches the file wherever it sits on the line, so a third file in the job still applies the mutation.
    refuses(
      'one of the files is dropped from the run and named in a comment',
      real.replace(
        /(files: [^\n]*?) (src\/midnight\/deferred-set\.test\.ts)([^\n]*)\n/,
        '$1$3\n            # also $2\n'
      ),
      /deferred-set\.test\.ts gates on the keys/
    );
    refuses(
      'the run passes when it collects nothing',
      real.replace(/- run: npx vitest run /, '- run: npx vitest run --passWithNoTests '),
      /collects nothing/
    );
    refuses(
      'THE CHEAP ONE: the keys are built AFTER the tests that read them',
      real.replace(
        / {6}- name: build the proving and verifier keys\n {8}run: npm run compact\n((?: {6}#[^\n]*\n| {6}- name: (?:build the vault|fetch Midnight|fetch the network|copy the company account)[^\n]*\n(?: {8}timeout-minutes: \d+\n)? {8}run: [^\n]*\n)*)( {6}- run: npx vitest run [^\n]*\n)/,
        '$1$2      - name: build the proving and verifier keys\n        run: npm run compact\n'
      ),
      /runs the suite after/
    );
    refuses(
      "the vault's keys are never built",
      real.replace(
        / {6}- name: build the vault's proving and verifier keys\n {8}run: npm run compact:vault -- --full\n/,
        ''
      ),
      /nothing in keys builds the vault's keys/
    );
    refuses(
      "the vault's keys are built AFTER the tests that read them",
      real.replace(
        /( {6}- name: build the vault's proving and verifier keys\n {8}run: npm run compact:vault -- --full\n)((?: {6}#[^\n]*\n| {6}- name: (?:fetch (?:Midnight|the network)|copy the company account)[^\n]*\n(?: {8}timeout-minutes: \d+\n)? {8}run: [^\n]*\n)*)( {6}- run: npx vitest run [^\n]*\n)/,
        '$2$3$1'
      ),
      /reads the vault's keys and is run by no step after they are built/
    );
    refuses(
      "the vault's build is made conditional",
      real.replace(
        /\n(\s+)run: npm run compact:vault -- --full\n/,
        '\n$1if: false\n$1run: npm run compact:vault -- --full\n'
      ),
      /vault's keys .* conditional/
    );
    refuses(
      "the vault's build tolerates its own failure",
      real.replace(
        /\n(\s+)run: npm run compact:vault -- --full\n/,
        '\n$1continue-on-error: true\n$1run: npm run compact:vault -- --full\n'
      ),
      /vault's keys .* tolerates/
    );
    refuses(
      "the vault's build is only the fast one",
      real.replace(/run: npm run compact:vault -- --full\n/, 'run: npm run compact:vault\n'),
      /nothing in keys builds the vault's keys/
    );
    refuses(
      "a file that reads the vault's keys is dropped from the run",
      real.replace('src/wiring/vault-submission.test.ts ', ''),
      /vault-submission\.test\.ts gates on the keys/
    );

    refuses(
      "the account's keys are never copied into the wallet",
      real.replace(
        / {6}- name: copy the company account's and the vault's keys into the wallet\n {8}run: npm run vendor-keys:account\n/,
        ''
      ),
      /copies the account's keys into the wallet/
    );
    refuses(
      "the account's keys are copied into the wallet AFTER the tests that prove with them",
      real.replace(
        /( {6}- name: copy the company account's and the vault's keys into the wallet\n {8}run: npm run vendor-keys:account\n)( {6}- run: npx vitest run [^\n]*\n(?: {8}env:\n(?: {10}[^\n]*\n)*)?)/,
        '$2$1'
      ),
      /proves with the account's keys in the wallet and is run by no step after they are copied there/
    );
    refuses(
      'the copy into the wallet tolerates its own failure',
      real.replace(
        /\n(\s+)run: npm run vendor-keys:account\n/,
        '\n$1continue-on-error: true\n$1run: npm run vendor-keys:account\n'
      ),
      /copies the account's keys into the wallet .* tolerates/
    );
    refuses(
      "a file that proves with the account's keys in the wallet is dropped from the run",
      real.replace(/(group: wallet-pay-key\n[^\n]*\n\s+files: )[^\n]*\n/, '$1\n'),
      /the-wallet-proves-the-pay-key\.test\.ts gates on the keys/
    );

    // THE NAMED GROUPS: every file in exactly one, each described.
    refuses(
      'a file is put in a second group',
      real.replace(/(group: wallet-pay-key\n[^\n]*\n\s+files: )/, '$1contracts/test/vault-split.test.ts '),
      /vault-split\.test\.ts is in two groups/
    );
    refuses(
      'a group loses its one-line description',
      real.replace(/(\n {10}- group: payroll\n) {12}about: [^\n]*\n/, '$1'),
      /payroll group of keys has no one-line description/
    );
    // THE KEYS RUN WHEN THEY CAN BREAK: a change that can break a key test starts them, and so does every night.
    refusesPaths(
      'the paths leave out a folder key tests live in',
      without('packages/**'),
      /packages\/\*\* can break a key test/
    );
    refusesPaths(
      'the paths leave out the lockfile',
      without('package-lock.json'),
      /package-lock\.json can break a key test/
    );
    refusesPaths(
      'the paths leave out the workflow itself',
      without('.github/workflows/ci.yml'),
      /ci\.yml can break a key test/
    );
    refusesPaths(
      'the paths leave out the list itself',
      without('.github/checks/keys-paths.mjs'),
      /keys-paths\.mjs can break a key test/
    );
    refuses(
      'the nightly run is taken away',
      real.replace(/ {2}schedule:\n(?: {4}#[^\n]*\n)? {4}- cron: [^\n]*\n/, ''),
      /no night/
    );
    refuses(
      'a change is skipped by paths-ignore',
      real.replace(/(\n {2}pull_request:\n {4}types: [^\n]*\n)/, "$1    paths-ignore: ['docs/**']\n"),
      /paths-ignore/
    );
    refuses(
      'the checks start only on some paths',
      real.replace(/(\n {2}pull_request:\n {4}types: [^\n]*\n)/, "$1    paths:\n      - 'src/**'\n"),
      /start only on some paths/
    );
    refusesPaths('the paths name nothing', [], /no change at all/);

    // THE WHOLE-JOB AND RUN-LINE TOLERANCES, AND THE FLAGS THAT NARROW A RUN.
    refuses(
      'the whole job tolerates its own failure',
      real.replace(/\n {4}name: keys \(/, '\n    continue-on-error: true\n    name: keys ('),
      /keys job tolerates its own failure/
    );
    refuses(
      'the run line swallows its failure',
      real.replace('- run: npx vitest run ${{ matrix.files }}', '- run: npx vitest run ${{ matrix.files }} || true'),
      /carries \|\|/
    );
    refuses(
      'the run is filtered to some tests',
      real.replace('- run: npx vitest run ${{ matrix.files }}', '- run: npx vitest run -t nothing ${{ matrix.files }}'),
      /filters its run with -t/
    );
    refuses(
      'the run no longer says the keys must be built',
      real.replace("          KEYS_MUST_BE_BUILT: '1'\n", "          KEYS_MUST_BE_BUILT: ''\n"),
      /KEYS_MUST_BE_BUILT/
    );
    refuses(
      'a group names a file the tree does not hold, so the test it meant runs nowhere',
      real.replace(
        'apps/wallet/src/screens/approve-creation.test.tsx',
        'apps/wallet/src/screens/approve-creation.test.ts'
      ),
      /approve-creation\.test\.ts|approve-creation\.test\.tsx/
    );
    refuses(
      'a group names a file written another way, which the run would take twice',
      real.replace(/(group: wallet-pay-key\n[^\n]*\n\s+files: )/, '$1./contracts/test/vault-split.test.ts '),
      /no file of this tree/
    );
    refusesPaths(
      'a folder is narrowed',
      KEYS_PATHS.map((g) => (g === 'src/**' ? 'src/**/*.ts' : g)),
      /src\/\*\* can break a key test/
    );
    refusesPaths('a path is excluded by negation', [...KEYS_PATHS, '!src/core/**'], /!src\/core\/\*\*/);
    refuses(
      'pull requests into most branches are left out',
      real.replace(/(\n {2}pull_request:\n)/, '$1    branches: [nowhere]\n'),
      /some branches/
    );
    refuses(
      'a push to a pull request no longer starts the keys',
      real.replace(/types: \[[^\]]*\]/, 'types: [closed]'),
      /every push to a pull request/
    );
    refuses('the night never comes', real.replace(/- cron: '[^']*'/, "- cron: '0 0 31 2 *'"), /no night/);
    refuses('the keys can no longer be run by hand', real.replace('\n  workflow_dispatch:\n', '\n'), /by hand/);

    // AND A SHAPE IT CANNOT READ IS A REFUSAL RATHER THAN A PASS.
    expect(() => keysCoverageProblem('name: check\non: push\n', gated)).toThrow(/no `jobs:` block/);
  });

  it('the artifact paths are the ones the tests really import', () => {
    // The table is checked against the imports, so a renamed output folder cannot leave it watching nothing.
    const simulator = readFileSync(join(ROOT, 'contracts/test/simulator.ts'), 'utf8');
    expect(simulator).toContain("from '../managed/contract/index.js'");
    const vaultTest = readFileSync(join(ROOT, 'contracts/test/vault-client.test.ts'), 'utf8');
    expect(vaultTest).toContain('managed-vault/contract/index.js');
  });
});
