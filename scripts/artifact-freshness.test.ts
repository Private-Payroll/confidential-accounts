/**
 * A CHECK THAT CANNOT FAIL IS A CHECK THAT HAS ALREADY FAILED.
 *
 * This file exists because the guard it tests is the kind of thing that gets
 * written, wired, and never once observed doing its job — and a staleness guard
 * that never refuses is indistinguishable, in every log this project keeps,
 * from a repository whose artifacts are always fresh. So every test below
 * TOUCHES a `.compact`'s mtime in a fixture tree and asserts the refusal
 * actually fires, rather than asserting the happy path and inferring the rest.
 *
 * It runs against fixtures and never against `contracts/`. Nothing here reads a
 * real artifact, compiles anything, or touches the mtime of a file the
 * repository owns: a test that moved `contracts/src/Vault.compact`'s mtime
 * would be a test that makes the thing it is testing true.
 *
 * THE WIRING IS EXECUTED, NOT GREPPED, AND THAT IS AN AUDITOR'S CORRECTION.
 * `C263`'s lesson was that an array nobody writes to is invisible to a
 * typechecker and to a unit test of the function that reads it. The same shape
 * here is a guard nobody wired in. The first version of this file asserted the
 * wiring by reading `vitest.config.ts` as TEXT and matching a regex — and a
 * test-coverage pass showed three separate ways to disarm the guard that left
 * that assertion green: comment the key out (a regex matches inside a comment),
 * wrap the call in `try {} catch {}`, or put it behind `if (process.env.X)`.
 * So the config is now imported as a MODULE and its value read, and the
 * globalSetup module's own default export is CALLED against a stale fixture. A
 * commented-out key is not a value and a swallowed throw is not a throw.
 *
 * THE LIVE DEFAULT IS EXERCISED TOO. Every early test passed `pairs`
 * explicitly, so `assertArtifactsFresh`'s default binding to
 * `CONTRACT_ARTIFACTS` — the only binding production uses — was never run, and
 * the auditor dropped the vault from it with this file fully green.
 *
 * THIS FILE MUST STAY SEQUENTIAL. `root` below is one module-level variable
 * shared by every test, which holds because vitest runs a file's tests in
 * order. Under `sequence.concurrent` it goes red for a reason that has nothing
 * to do with the guard.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_ARTIFACTS,
  type ArtifactPair,
  assertArtifactsFresh,
  findRefusals,
  refusalText,
} from './artifact-freshness.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The fixture's own pair. Deliberately not one of the real ones. */
const PAIR: ArtifactPair = {
  source: 'contracts/src/Fixture.compact',
  artifact: 'contracts/managed-fixture/contract/index.js',
  door: 'COMPILE-FIXTURE.command',
};

let root = '';

/**
 * A fixture tree laid out at `CONTRACT_ARTIFACTS`' own relative paths, so the
 * live default table finds something at every path it names.
 *
 * IT EXISTS BECAUSE THE FIRST DRAFT PASSED FOR THE WRONG REASON. Calling the
 * wired module against the small single-pair fixture threw all right — but it
 * threw `source-missing`, because the default table looks for
 * `contracts/src/ConfidentialAccount.compact` and that fixture has no such
 * file. A refusal fired; the refusal being tested did not. Every assertion on
 * the live default now names the kind and the door it expects.
 */
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

/** Seconds since the epoch; `utimesSync` takes seconds, and whole ones avoid float drift. */
const setMtime = (path: string, seconds: number): void => utimesSync(path, seconds, seconds);

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

describe('THE REFUSAL FIRES — the whole reason this file exists', () => {
  it('refuses when the source is touched one second past the artifact', () => {
    setMtime(sourcePath(), 1_000_061);

    const refusals = findRefusals(root, [PAIR]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].kind).toBe('stale');
    expect(refusals[0].pair).toBe(PAIR);
    // The times are read off the filesystem, not computed. Rule 9.
    expect(refusals[0].sourceMs).toBe(1_000_061_000);
    expect(refusals[0].artifactMs).toBe(1_000_060_000);
  });

  it('THROWS rather than warns, so a caller cannot carry on past it', () => {
    setMtime(sourcePath(), 1_000_061);
    expect(() => assertArtifactsFresh(root, [PAIR])).toThrow(/THE SUITE DID NOT RUN/);
  });

  it('names the file and the DOOR, which is what rule 19 asks a refusal for', () => {
    setMtime(sourcePath(), 1_000_061);
    const text = refusalText(findRefusals(root, [PAIR]));
    expect(text).toContain(PAIR.source);
    expect(text).toContain(PAIR.artifact);
    expect(text).toContain(`Run ${PAIR.door}, then run this again.`);
    // Not a file to write, not a variable to set. Rule 19.
    expect(text).not.toMatch(/export |environment variable|SKIP|set [A-Z_]+=/);
  });

  it('SHOWS ITS WORKING — BOTH stamps it compared, distinguishable, in IST', () => {
    // The refusal's whole justification is that it shows the two times it
    // compared. A first version of this test asserted one stamp, and a second
    // auditor pass showed two mutations that survived it green: printing the
    // SOURCE's time on both lines, and an `ist()` that ignores its argument and
    // returns a constant — a number no instrument read off anything, which is
    // rule 9, surviving inside the test written to enforce rule 9. Both got
    // through because the default fixture's two stamps are one second apart and
    // render to the same MINUTE, so either line satisfied the assertion.
    
    // So the artifact is moved to a different minute here, and both stamps are
    // asserted. The expected strings were read off `Intl.DateTimeFormat`
    // directly rather than out of `ist()`, so this is an independent derivation
    // and not the code checking itself: 1_000_061_000 ms is
    // 1970-01-12T13:47:41Z, which is 19:17 in Asia/Kolkata and 08:47 in
    // America/New_York; 999_940_000 ms is 19:15 in Asia/Kolkata.
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
    // Rule 22: the timezone is a claim about what the number is.
    expect(text).not.toContain('08:47');
  });

  it('refuses when the artifact was never built, not only when it is old', () => {
    rmSync(artifactPath());
    const refusals = findRefusals(root, [PAIR]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].kind).toBe('artifact-missing');
    const text = refusalText(refusals);
    expect(text).toContain('NOT BUILT');
    expect(text).toContain(PAIR.door);
  });

  it('refuses when the SOURCE is gone, and says no door resolves that', () => {
    // A renamed `.compact` must not silently retire the pair that guards it.
    rmSync(sourcePath());
    const refusals = findRefusals(root, [PAIR]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].kind).toBe('source-missing');
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
      door: 'COMPILE-OTHER.command',
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
    // "Run COMPILE-VAULT.command and COMPILE-VAULT.command" is a refusal a
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
    // regex match. This is the assertion the auditor's first disarm walked past.
    const config = (await import('../vitest.config.ts')).default as {
      test?: { globalSetup?: string | string[]; include?: string[] };
    };
    const wired = config.test?.globalSetup;
    expect(wired).toBeDefined();
    expect(Array.isArray(wired) ? wired : [wired]).toContain(
      './scripts/artifact-freshness.globalSetup.ts',
    );

    // AND THE GLOB THAT COLLECTS THIS FILE. `C67`, which this config's own
    // comment records for the wallet: narrowing `include` switches tests off
    // without a word. Narrow it past `scripts/` and the guard still runs, but
    // every test proving the guard works disappears under a green summary line.
    expect(config.test?.include).toContain('scripts/**/*.test.ts');
  });

  it('THE WIRED MODULE ITSELF REFUSES — its default export, called, over a stale tree', async () => {
    // The module vitest loads, doing the thing vitest loads it to do. A
    // `try {} catch {}` around its call, or a `process.env` gate in front of
    // it, turns this red; a substring check on the file cannot see either.
    const mod = await import('./artifact-freshness.globalSetup.js');
    expect(typeof mod.default).toBe('function');

    const tree = makeRealTree();
    try {
      // Fresh first, so the refusal below is the stale one and not a fixture
      // that was never right.
      expect(() => mod.default(undefined, tree)).not.toThrow();

      const account = CONTRACT_ARTIFACTS[0];
      setMtime(join(tree, account.source), 1_000_061);
      // First argument is the one vitest supplies and this module ignores; the
      // second is the fixture root. The message must name THIS source and THIS
      // door, so a refusal fired for any other reason is not a pass.
      expect(() => mod.default(undefined, tree)).toThrow(
        new RegExp(`was edited after[\\s\\S]*${account.door}`),
      );
      expect(() => mod.default(undefined, tree)).toThrow(
        new RegExp(account.source.replace(/[.]/g, '\\.')),
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('derives its root from its own location, not from the working directory', () => {
    // A guard that took its root from the caller could be pointed at a
    // directory with no contracts in it, where every pair is `source-missing`.
    const source = readFileSync(join(ROOT, 'scripts/artifact-freshness.globalSetup.ts'), 'utf8');
    expect(source).toContain("new URL('..', import.meta.url)");
    // Comments stripped first — this module's own comment explains why it does
    // NOT use `process.cwd()`, and an assertion over the whole file text would
    // be reading the explanation as the code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('process.cwd()');
    expect(() => readFileSync(join(ROOT, 'package.json'), 'utf8')).not.toThrow();
  });

  it('THE LIVE DEFAULT is bound to the real table — no pairs argument, real paths', () => {
    // Every other test passes `pairs` explicitly, so the default binding to
    // CONTRACT_ARTIFACTS was never exercised. An auditor changed that default
    // to the account alone, and to a self-referential dummy that can never be
    // stale, with this file fully green both times.
    
    // WHAT THIS TEST DOES NOT DO, because a second auditor pass caught the
    // first version of this comment claiming it: it cannot see the table
    // SHRINKING, because the fixture and the loop below both iterate
    // CONTRACT_ARTIFACTS — drop a pair and there is simply less to iterate.
    // The table's contents are pinned by the `toEqual` on triples below, and
    // its length is pinned here against a literal, independently of the loop.
    expect(CONTRACT_ARTIFACTS).toHaveLength(2);
    const tree = makeRealTree();
    try {
      expect(() => assertArtifactsFresh(tree)).not.toThrow();

      // Each pair on its own, so dropping EITHER from the table goes red.
      for (const pair of CONTRACT_ARTIFACTS) {
        setMtime(join(tree, pair.source), 1_000_061);
        expect(() => assertArtifactsFresh(tree)).toThrow(
          new RegExp(`${pair.source.replace(/[.]/g, '\\.')}[\\s\\S]*${pair.door}`),
        );
        setMtime(join(tree, pair.source), 1_000_000);
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('pairs each source with the door that rebuilds THAT artifact, not just a door', () => {
    // Existence is not correctness: an auditor swapped the two doors and this
    // file stayed green, which sends a person editing the account off to
    // recompile the vault. Rule 19 asks for the door that RESOLVES it.
    expect(CONTRACT_ARTIFACTS.map((p) => [p.source, p.artifact, p.door])).toEqual([
      [
        'contracts/src/ConfidentialAccount.compact',
        'contracts/managed/contract/index.js',
        'npm run compact:fast',
      ],
      [
        'contracts/src/Vault.compact',
        'contracts/managed-vault/contract/index.js',
        'npm run compact:vault',
      ],
    ]);
  });

  it('every named door is one a reader of this repository can open, and every named source is here', () => {
    // A refusal naming a door nobody can open is not a refusal a person can act
    // on. This used to read the door as a PATH, which passed only because the
    // door was a file in one folder -- a file no clone has, so the assertion
    // proved the opposite of what it was for. The sources are checked because a
    // rename would otherwise turn every run into a `source-missing` refusal
    // nobody predicted.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const pair of CONTRACT_ARTIFACTS) {
      const named = /^npm run ([A-Za-z0-9:_-]+)$/.exec(pair.door);
      expect({ door: pair.door, defined: named !== null && typeof pkg.scripts[named[1]] === 'string' })
        .toEqual({ door: pair.door, defined: true });
      expect(() => readFileSync(join(ROOT, pair.source), 'utf8')).not.toThrow();
    }
  });

  /*
   * A SKIP THAT NOBODY EVER UNSKIPS IS A DELETED TEST WITH A TICK NEXT TO IT.
   *
   * Some assertions read the verifier keys: that a deployed entry point still
   * carries the key this build produces, and that the deferral list names
   * exactly the circuits with keys. Those keys come from the proving backend,
   * which an ordinary compile skips, so they are skipped wherever nobody has
   * built them - which is every clone, and five of the six machines the checks
   * run on.
   *
   * That is only acceptable because ONE of those machines builds the keys and
   * then runs every file that gates on them. The rule below reads the checks
   * and refuses if that stops being true.
   *
   * -- WHY IT PARSES RATHER THAN MATCHES, WHICH IS THE WHOLE OF THIS ----------
   *
   * The first version of this rule asked whether the text `run: npm run compact`
   * appeared and whether the two filenames appeared in the same job. EIGHT edits
   * left it green with the assertions running nowhere: commenting the build step
   * out, `if: false` on the step or on the job, `continue-on-error`, replacing
   * the runner with `echo`, running one file and naming the other in a comment,
   * `--passWithNoTests` with a filter that matches nothing, and - the cheap one,
   * and the one a person would actually make - moving the build step BELOW the
   * test step, so the tests run first, find no keys, skip, and report green.
   *
   * A rule that reads a file as text answers questions about the text. These are
   * questions about ORDER, about whether a step runs at all, and about whether a
   * failure counts - so the shape has to be read. What is below is not a YAML
   * parser and does not pretend to be one: it models the shape this file
   * actually has, and it REFUSES on a shape it cannot read rather than treating
   * unknown as satisfied.
   *
   * AND THE LIST OF FILES IS DERIVED FROM THE TREE, NOT TYPED HERE. It was two
   * paths written by hand, so a third file that started gating on the keys
   * tomorrow would have joined nothing at all.
   */

  /** A step, read far enough to answer whether it runs and what it runs. */
  type WorkflowStep = { readonly run: string | null; readonly conditional: boolean; readonly tolerated: boolean };
  /** A job, in the order its steps are written. */
  type WorkflowJob = { readonly id: string; readonly conditional: boolean; readonly steps: readonly WorkflowStep[] };

  const parseWorkflow = (text: string): WorkflowJob[] => {
    const lines = text.split('\n');
    const jobsAt = lines.findIndex((l) => l === 'jobs:');
    if (jobsAt === -1) throw new Error('this is not a workflow: it has no `jobs:` block');
    const jobs: WorkflowJob[] = [];
    let job: { id: string; conditional: boolean; steps: WorkflowStep[] } | null = null;
    let step: { run: string | null; conditional: boolean; tolerated: boolean } | null = null;
    let inSteps = false;
    let block: { indent: number; parts: string[] } | null = null;

    const closeStep = () => { if (job && step) job.steps.push({ ...step, run: block ? block.parts.join(' ').trim() : step.run }); step = null; block = null; };
    const closeJob = () => { closeStep(); if (job) jobs.push({ ...job, steps: job.steps }); job = null; inSteps = false; };

    for (const raw of lines.slice(jobsAt + 1)) {
      const line = raw.replace(/\s+$/, '');
      if (line === '' ) continue;
      const indent = line.length - line.trimStart().length;
      const body = line.trim();
      if (block && indent > block.indent) { block.parts.push(body); continue; }
      if (block) block = null;
      if (body.startsWith('#')) continue;

      if (indent === 2 && /^[A-Za-z0-9_-]+:$/.test(body)) { closeJob(); job = { id: body.slice(0, -1), conditional: false, steps: [] }; continue; }
      if (!job) continue;
      if (indent === 4 && body === 'steps:') { inSteps = true; continue; }
      if (indent === 4 && body.startsWith('if:')) { job.conditional = true; continue; }
      if (!inSteps) continue;
      if (indent === 6 && body.startsWith('- ')) {
        closeStep();
        step = { run: null, conditional: false, tolerated: false };
      }
      if (!step) continue;
      const field = body.replace(/^- /, '');
      if (field.startsWith('run:')) {
        const rest = field.slice(4).trim();
        if (rest === '|' || rest === '>') block = { indent, parts: [] };
        else step.run = rest;
        continue;
      }
      if (field.startsWith('if:')) { step.conditional = true; continue; }
      if (field.startsWith('continue-on-error:')) { step.tolerated = !/false\s*$/.test(field); continue; }
    }
    closeJob();
    if (jobs.length === 0) throw new Error('this workflow declares no jobs, so nothing below would mean anything');
    return jobs;
  };

  /*
   * Every file in the tree whose assertions are gated on the verifier keys.
   *
   * THE TWO THINGS IT LOOKS FOR ARE ASSEMBLED FROM PIECES, AND THAT IS NOT
   * DECORATION. Written out whole, they would appear in THIS file, and this file
   * is under one of the trees the walk reads - so the search found itself, and
   * the derived list gained an entry that gates on nothing. A scanner whose own
   * source is a match is a scanner that reports itself.
   */
  const KEY_DIR = ['contracts', 'managed', 'keys'].join('/');
  // The vault is a second contract, and its keys come from a build of its own.
  const VAULT_KEY_DIR = ['contracts', 'managed-vault', 'keys'].join('/');
  const GATE = `skip${'If'}(`;

  const gatedOnKeys = (dirs: readonly string[] = [KEY_DIR, VAULT_KEY_DIR]): string[] => {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(join(ROOT, rel))) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        const child = `${rel}/${name}`;
        if (statSync(join(ROOT, child)).isDirectory()) { walk(child); continue; }
        if (!/\.test\.tsx?$/.test(name)) continue;
        const text = readFileSync(join(ROOT, child), 'utf8');
        // Gated means BOTH: it names the key directory, and it turns something
        // off. Either alone is a file that merely mentions one of them.
        if (dirs.some((d) => text.includes(d)) && text.includes(GATE)) out.push(child);
      }
    };
    for (const tree of ['src', 'scripts', 'contracts/test']) walk(tree);
    return out.sort();
  };

  const keysCoverageProblem = (
    workflow: string, gated: readonly string[], vaultGated: readonly string[] = gatedOnKeys([VAULT_KEY_DIR]),
  ): string | null => {
    if (gated.length === 0) return 'nothing in the tree gates on the verifier keys, so this rule is checking nothing';
    const jobs = parseWorkflow(workflow);

    // `npm run compact` is the full build. The fast one leaves no keys and is
    // the whole reason anything is gated. Matched as a whole command so that
    // `compact:fast` is not mistaken for it.
    const builds = (s: WorkflowStep) => s.run !== null && /(^|&&\s*)npm run compact(\s|$)/.test(s.run);
    const carrying = jobs.filter((j) => j.steps.some(builds));
    if (carrying.length !== 1) return `${carrying.length} jobs build the proving keys; there must be exactly one`;
    const job = carrying[0];
    if (job.conditional) return `the ${job.id} job is conditional, so it need never run`;

    const at = job.steps.findIndex(builds);
    const build = job.steps[at];
    if (build.conditional) return `the step that builds the keys in ${job.id} is conditional, so it need never run`;
    if (build.tolerated) return `the step that builds the keys in ${job.id} tolerates its own failure`;

    // AFTER the build, not merely in the same job. Ordered the other way, the
    // tests run against no keys, skip, and report green.
    const after = job.steps.slice(at + 1);
    const reads = after.filter((s) => s.run !== null && /(^|&&\s*)(npx )?vitest run(\s|$)/.test(s.run));
    if (reads.length === 0) return `nothing in ${job.id} runs the suite after the keys are built`;
    for (const missing of gated.filter((f) => !reads.some((s) => (s.run as string).includes(f)))) {
      return `${missing} gates on the keys and is run by no step after they are built`;
    }
    // THE VAULT'S KEYS ARE NOT THE ACCOUNT'S, and the account's full build does
    // not make them: a file that reads them needs the vault's own full build,
    // in the same job, before the step that runs it.
    if (vaultGated.length > 0) {
      const buildsVault = (s: WorkflowStep) => s.run !== null && /(^|&&\s*)npm run compact:vault -- --full(\s|$)/.test(s.run);
      const v = job.steps.findIndex(buildsVault);
      if (v === -1) return `nothing in ${job.id} builds the vault's keys, and ${vaultGated[0]} reads them`;
      if (job.steps[v].conditional) return `the step that builds the vault's keys in ${job.id} is conditional, so it need never run`;
      if (job.steps[v].tolerated) return `the step that builds the vault's keys in ${job.id} tolerates its own failure`;
      const afterVault = job.steps.slice(v + 1).filter((s) => reads.includes(s));
      for (const missing of vaultGated.filter((f) => !afterVault.some((s) => (s.run as string).includes(f)))) {
        return `${missing} reads the vault's keys and is run by no step after they are built`;
      }
    }
    for (const s of reads) {
      if (s.conditional) return `a step in ${job.id} that reads the keys is conditional, so it need never run`;
      if (s.tolerated) return `a step in ${job.id} that reads the keys tolerates its own failure`;
      if (/--passWithNoTests/.test(s.run as string)) return `a step in ${job.id} passes when it collects nothing`;
    }
    return null;
  };

  const WORKFLOW = () => readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('THE ASSERTIONS THAT NEED PROVING KEYS ARE STILL MADE SOMEWHERE, or this goes red', () => {
    const gated = gatedOnKeys();
    /*
     * **THE LIST IS DERIVED FROM A DIRECTORY WALK, SO A LITERAL `toEqual` OVER
     * IT IS A CLAIM ABOUT WHICH FILES A COPY HAS, NOT ABOUT KEY COVERAGE.** In
     * any copy that does not carry one of these nine it went red with a message
     * about proving keys, which is not what changed.
     *
     * The direction that is the guard: every file gated on keys is named here,
     * so a new one cannot appear unremarked. The reverse is intersected with
     * what the walk found, and the emptiness refusal below is what stops the
     * whole thing passing over nothing.
     */
    const NAMED = [
      'contracts/test/a-company-seats-its-signers-from-the-page.test.ts',
      'contracts/test/a-company-vault-from-the-page.test.ts',
      'contracts/test/a-private-payment-from-the-page.test.ts',
      'contracts/test/a-run-raised-and-approved-from-the-page.test.ts',
      'src/midnight/deferred-set.test.ts',
      'src/midnight/ledger.test.ts',
      'src/midnight/the-key-reaches-the-circuit.test.ts',
      'src/midnight/the-secret-comes-from-the-keyring.test.ts',
      'src/wiring/vault-submission.test.ts',
    ];
    expect(gated.filter((f) => !NAMED.includes(f)),
      'a test is gated on proving keys and this list does not name it').toEqual([]);
    expect(NAMED.filter((f) => existsSync(join(ROOT, f)) && !gated.includes(f)),
      'a test named here is still in this tree and is no longer gated on keys').toEqual([]);
    // A RULE OVER AN EMPTY LIST IS A RULE OVER NOTHING, and that was the point
    // of pinning the whole list. It is kept, as a floor rather than an identity.
    expect(gated.length, 'the walk found no gated tests, so nothing below means anything')
      .toBeGreaterThan(0);
    const VAULT_NAMED = [
      'contracts/test/a-company-vault-from-the-page.test.ts',
      'contracts/test/a-private-payment-from-the-page.test.ts',
      'src/wiring/vault-submission.test.ts',
    ];
    const vaultGated = gatedOnKeys([VAULT_KEY_DIR]);
    expect(vaultGated.filter((f) => !VAULT_NAMED.includes(f)),
      'a test is gated on the vault keys and this list does not name it').toEqual([]);
    expect(VAULT_NAMED.filter((f) => existsSync(join(ROOT, f)) && !vaultGated.includes(f)),
      'a test named here is still in this tree and is no longer gated on the vault keys')
      .toEqual([]);
    expect(keysCoverageProblem(WORKFLOW(), gated)).toBeNull();
  });

  it('and the rule above refuses every way that coverage can be taken away', () => {
    /*
     * EACH OF THESE LEFT THE FIRST VERSION OF THIS RULE GREEN. They are written
     * out rather than described because the first version's own three named
     * breakages were three it already caught, which is how it passed while
     * eight real ones walked through it.
     */
    const real = WORKFLOW();
    const gated = gatedOnKeys();
    const refuses = (label: string, edited: string, matching: RegExp) => {
      expect(edited, `${label}: the edit changed nothing, so it proves nothing`).not.toBe(real);
      expect(keysCoverageProblem(edited, gated), label).toMatch(matching);
    };

    refuses('the build step is commented out',
      real.replace(/\n(\s+)run: npm run compact\n/, '\n$1# run: npm run compact\n'), /build the proving keys|exactly one/);
    refuses('the build step is made conditional',
      real.replace(/\n(\s+)run: npm run compact\n/, '\n$1if: false\n$1run: npm run compact\n'), /conditional/);
    refuses('the build step tolerates its own failure',
      real.replace(/\n(\s+)run: npm run compact\n/, '\n$1continue-on-error: true\n$1run: npm run compact\n'), /tolerates/);
    refuses('the whole job is made conditional',
      real.replace(/\n    name: keys\n/, '\n    name: keys\n    if: false\n'), /job is conditional/);
    refuses('the runner is replaced by something that only prints',
      real.replace(/- run: npx vitest run src\/midnight/, '- run: echo npx vitest run src/midnight'), /runs the suite after/);
    // WRITTEN TO MATCH THE FILE WHEREVER IT SITS ON THE LINE, not to match a
    // line with exactly two files on it. The first version anchored on the
    // newline after the second name, so adding a THIRD file to that job stopped
    // the mutation applying at all and this control quietly proved nothing -
    // measured 13 Sep, when the third file was added.
    refuses('one of the files is dropped from the run and named in a comment',
      real.replace(/(- run: npx vitest run [^\n]*?) (src\/midnight\/deferred-set\.test\.ts)([^\n]*)\n/,
        '$1$3\n      # also $2\n'), /deferred-set\.test\.ts gates on the keys/);
    refuses('the run passes when it collects nothing',
      real.replace(/- run: npx vitest run /, '- run: npx vitest run --passWithNoTests '), /collects nothing/);
    refuses('THE CHEAP ONE: the keys are built AFTER the tests that read them',
      real.replace(/      - name: build the proving and verifier keys\n        run: npm run compact\n((?:      #[^\n]*\n|      - name: build the vault[^\n]*\n        run: [^\n]*\n)*)(      - run: npx vitest run [^\n]*\n)/,
        '$1$2      - name: build the proving and verifier keys\n        run: npm run compact\n'), /runs the suite after/);
    refuses('the vault\'s keys are never built',
      real.replace(/      - name: build the vault's proving and verifier keys\n        run: npm run compact:vault -- --full\n/, ''),
      /nothing in keys builds the vault's keys/);
    refuses('the vault\'s keys are built AFTER the tests that read them',
      real.replace(/(      - name: build the vault's proving and verifier keys\n        run: npm run compact:vault -- --full\n)(      - run: npx vitest run [^\n]*\n)/,
        '$2$1'), /reads the vault's keys and is run by no step after they are built/);
    refuses('the vault\'s build is made conditional',
      real.replace(/\n(\s+)run: npm run compact:vault -- --full\n/, '\n$1if: false\n$1run: npm run compact:vault -- --full\n'), /vault's keys .* conditional/);
    refuses('the vault\'s build tolerates its own failure',
      real.replace(/\n(\s+)run: npm run compact:vault -- --full\n/, '\n$1continue-on-error: true\n$1run: npm run compact:vault -- --full\n'), /vault's keys .* tolerates/);
    refuses('the vault\'s build is only the fast one',
      real.replace(/run: npm run compact:vault -- --full\n/, 'run: npm run compact:vault\n'), /nothing in keys builds the vault's keys/);
    refuses('a file that reads the vault\'s keys is dropped from the run',
      real.replace(/(- run: npx vitest run [^\n]*?) (src\/wiring\/vault-submission\.test\.ts)([^\n]*)\n/, '$1$3\n'),
      /vault-submission\.test\.ts gates on the keys/);

    // AND A SHAPE IT CANNOT READ IS A REFUSAL RATHER THAN A PASS.
    expect(() => keysCoverageProblem('name: check\non: push\n', gated)).toThrow(/no `jobs:` block/);
  });

  it('the artifact paths are the ones the tests really import', () => {
    // The table is checked against the imports rather than against itself: a
    // renamed output directory would otherwise leave the guard watching a path
    // nothing reads, passing forever.
    const simulator = readFileSync(join(ROOT, 'contracts/test/simulator.ts'), 'utf8');
    expect(simulator).toContain("from '../managed/contract/index.js'");
    const vaultTest = readFileSync(join(ROOT, 'contracts/test/vault-client.test.ts'), 'utf8');
    expect(vaultTest).toContain('managed-vault/contract/index.js');
  });
});
