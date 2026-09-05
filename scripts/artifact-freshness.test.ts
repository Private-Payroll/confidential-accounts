/**
 * A CHECK THAT CANNOT FAIL IS A CHECK THAT HAS ALREADY FAILED. `C238`, `C263`.
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
 * `test-auditor` pass showed three separate ways to disarm the guard that left
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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    //
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
    // table is an error rather than a pass. C238, C263.
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
    //
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
        'COMPILE-CONTRACT.command',
      ],
      [
        'contracts/src/Vault.compact',
        'contracts/managed-vault/contract/index.js',
        'COMPILE-VAULT.command',
      ],
    ]);
  });

  it('every named door exists on disk, and every named source does too', () => {
    // A refusal naming a door nobody can open is not a refusal a person can act
    // on. The sources are checked here because a rename would otherwise turn
    // every run into a `source-missing` refusal nobody predicted.
    for (const pair of CONTRACT_ARTIFACTS) {
      expect(() => readFileSync(join(ROOT, pair.door), 'utf8')).not.toThrow();
      expect(() => readFileSync(join(ROOT, pair.source), 'utf8')).not.toThrow();
    }
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
