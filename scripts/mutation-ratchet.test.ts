/**
 * WHAT HOLDS THE MUTATION HARNESSES HONEST, CHECKED IN EVERY CHECKOUT.
 *
 * The harnesses beside this file measure whether a test actually watches a line
 * of the money path: each one changes a binding on purpose and asks whether an
 * assertion dies. Two properties have to hold or their answers are worth
 * nothing, and this file is where both are held.
 *
 * -- THE FIRST: A RUN THAT MEASURED NOTHING IS NOT A SURVIVOR ----------------
 *
 * A harness reports a SURVIVOR when it changed a binding and every test still
 * passed. That is the loudest claim any of this makes: it says a line of the
 * money path has no test behind it. The failure that has to be impossible is a
 * run in which nothing executed at all being scored as one of those, because
 * the scripts that invoke a harness read a zero exit as a clean run. So a run
 * that measured nothing is its own state, it reaches the exit status, and the
 * expression that computes that status is COMPILED AND DRIVEN here rather than
 * read - a name in a source file is not a value, and an expression naming
 * every state while using none of them passes any check that only reads.
 *
 * -- THE SECOND: THE WEAKENED CONFIGURATION IS WEAKER IN EXACTLY ONE WAY -----
 *
 * A mutation run uses a second test configuration that drops one guard on
 * purpose: a mutation which changes an assertion would otherwise trip the
 * documentation gate, and the gate refuses the whole suite, which would score
 * every mutation in that corpus as nothing. That is sound only while the second
 * configuration differs by that one entry and in no other way. Both
 * configurations are IMPORTED AND THEIR VALUES COMPARED here. Nothing matches
 * text against a configuration: a commented-out key matches a pattern and is
 * not a value, and a key can be disarmed three further ways that leave any
 * text match green.
 *
 * -- WHY BOTH LIVE IN A FILE THAT SHIPS ------------------------------------
 *
 * Both properties are about files that ship. A check for them that runs in one
 * working copy and in no checkout is a check a reader of this repository cannot
 * make, over the instruments that measure the part of this system where money
 * moves.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * IMPORTING A HARNESS RUNS NOTHING, AND THAT IS ITSELF ONE OF THE PROPERTIES
 * BELOW - held by importing every one of them, in a scratch tree outside this
 * repository, and counting what the import left behind. A harness does its work
 * only when a process is pointed at it, so the shared entrance and one harness
 * are imported here as ordinary modules.
 *
 * WHICH MAKES THIS FILE ITSELF THE FIRST PLACE THAT REGRESSION SHOWS. If one of
 * those imports ever starts doing the work, this file runs it - so instead of
 * one red assertion it takes minutes, edits the source it was reading, and its
 * results are worth nothing. That is the signal, and it is worth knowing before
 * it is met: a run of this file that is slow is not a slow test.
 */
// @ts-ignore - the shared entrance is plain JavaScript and is the source under test.
import {
  entryPointVerdict, harnessesOnDisk, measuredNothingBecause, openTheDoor, readTheReport,
  scoreKills, theEntranceIsUnreadable,
} from './mutation-door.mjs';

// @ts-ignore - a harness is plain JavaScript, and the journal below is its own.
import { beginMutation, recoverFromLastRun } from './mutate-authority.mjs';

import { codeOnly } from './stand-downs.js';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The guards a test run wires, in the order the real configuration wires them. */
const KEPT = ['./scripts/artifact-freshness.globalSetup.ts', './scripts/ledger-limit.globalSetup.ts'];

/**
 * The one a mutation run drops. Spelled here rather than read from the
 * configuration that removes it, so that removing a second entry there is a
 * disagreement between two files instead of a change that carries its own
 * confirmation.
 */
const DROPPED = './scripts/doc-freshness.globalSetup.ts';

/**
 * THE HARNESSES THAT DO NOT ASK THE SHARED ENTRANCE YET, NAMED SO THAT NOTHING
 * JOINS THEM QUIETLY.
 *
 * They belong to the other product in this repository and are out of scope here
 * on purpose rather than by oversight. Some checkouts do not contain them at
 * all, so a name for a file that is not here is not evidence of anything; what
 * is refused is a harness that IS here, outside the entrance, and unnamed. THE
 * LIST MAY SHRINK AND MAY NEVER GROW: a harness given the entrance loses its
 * line in the same turn.
 */
const NOT_THROUGH_YET: readonly string[] = [
  'apps/wallet/scripts/mutate-checkpoint-compartment.mjs',
  'apps/wallet/scripts/mutate-inbox.mjs',
  'apps/wallet/scripts/mutate-origin.mjs',
  'apps/wallet/scripts/mutate-payee-address.mjs',
  'apps/wallet/scripts/mutate-waiting-screen.mjs',
  'apps/wallet/scripts/mutate-wallet-name.mjs',
  'apps/wallet/scripts/mutate-wrong-wallet.mjs',
];

/**
 * The harnesses the rules below speak for: every one in this checkout that
 * takes its decisions from the shared entrance. Derived by subtraction from
 * what is on disk, so a new harness is inside this set the day it arrives
 * rather than the day somebody remembers to add it.
 */
const throughTheEntranceHere = (): string[] =>
  harnessesOnDisk(ROOT).filter((f) => !NOT_THROUGH_YET.includes(f));

type Config = {
  test?: {
    globalSetup?: string | string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

const loadBase = async (): Promise<Config> => (await import('../vitest.config.ts')).default as Config;
const loadMutation = async (): Promise<Config> =>
  (await import('../vitest.mutation.config.ts')).default as Config;

const setups = (c: Config): string[] => {
  const g = c.test?.globalSetup;
  if (g === undefined) return [];
  return Array.isArray(g) ? [...g] : [g];
};

const text = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The live code of a file, with its comments gone.
 *
 * EVERY POSITIVE ASSERTION BELOW READS THIS RATHER THAN THE RAW FILE. A check
 * that a statement is PRESENT by looking for its text is satisfied by that
 * statement commented out, which is the disarm this file's own header warns
 * about and which it was committing itself. The one place the RAW file is the
 * right input is a NEGATIVE assertion - that a sentence is gone - because
 * there a commented-out copy is genuinely gone from the code, and the raw file
 * is the stricter question. The rules are shared with the guard over what the
 * published suite covers, and are driven there.
 */
const code = (rel: string): string => codeOnly(text(rel));

describe('THE WEAKENED CONFIGURATION IS WEAKER IN EXACTLY ONE WAY', () => {
  it('a test run wires all three guards - read as values, not matched as text', async () => {
    const wired = setups(await loadBase());
    for (const entry of [...KEPT, DROPPED]) expect(wired).toContain(entry);
    expect(wired).toHaveLength(3);
  });

  it('a mutation run drops the documentation gate and keeps the other two, in order', async () => {
    expect(setups(await loadMutation())).toEqual(KEPT);
  });

  it('it removes ONE entry - not zero, not two - counted against the real one', async () => {
    const base = setups(await loadBase());
    const mutation = setups(await loadMutation());
    expect(base.length - mutation.length).toBe(1);
    expect(base.filter((e) => !mutation.includes(e))).toEqual([DROPPED]);
    expect(mutation.filter((e) => !base.includes(e))).toEqual([]);
  });

  it('NOTHING ELSE DIFFERS - every other key of both, compared deeply', async () => {
    const base = await loadBase();
    const mutation = await loadMutation();
    const flatten = (c: Config): Config => ({
      ...c,
      test: { ...c.test, globalSetup: '<compared separately, above>' },
    });
    expect(JSON.parse(JSON.stringify(flatten(mutation))))
      .toEqual(JSON.parse(JSON.stringify(flatten(base))));
  });

  it('IS DERIVED AND NOT COPIED - it reaches the real configuration by import', () => {
    const source = text('vitest.mutation.config.ts');
    expect(source).toMatch(/from '\.\/vitest\.config(\.ts)?'/);
    /*
     * A second configuration that RETYPED the real one would satisfy every
     * comparison above on the day it was written and drift the day after. What
     * makes the comparisons above a ratchet rather than a snapshot is that
     * there is only one place the values come from.
     */
    expect(source).not.toMatch(/globalSetup:\s*\[\s*'\.\//);
  });
});

describe('EVERY HARNESS IN THIS CHECKOUT GOES THROUGH THE SHARED ENTRANCE', () => {
  /**
   * A harness goes through the entrance when it takes all three of its
   * decisions there: whether it was run or imported, how the suite is run and
   * read, and whether the run measured anything at all.
   *
   * The import is matched by the tail of the specifier rather than by one
   * literal spelling, because the literal form is only reachable from a file
   * sitting beside the entrance and a harness in another tree has to climb to
   * it.
   */
  const throughTheEntrance = (t: string): boolean =>
    /from '[^']*mutation-door\.mjs'/.test(t)
    && t.includes('if (openTheDoor(import.meta.url)) main();')
    && t.includes('runSuiteHonestly(')
    && t.includes('measuredNothingBecause(');

  /**
   * Directories that are not this project's own source. A harness under one of
   * these belongs to something else and is not this file's to judge.
   */
  const NOT_THIS_PROJECT_S_SOURCE = new Set([
    'node_modules', 'dist', 'lib', 'logs', 'midnight-level-db', '_to_delete',
    'midnight-src', 'SAFE',
  ]);

  /** Every harness anywhere in this checkout, found by sweeping the whole of it. */
  const sweep = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string, rel: string): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.') || NOT_THIS_PROJECT_S_SOURCE.has(n)) continue;
        const at = join(dir, n);
        let st;
        try { st = statSync(at); } catch { continue; }
        if (st.isDirectory()) { walk(at, rel ? `${rel}/${n}` : n); continue; }
        if (/^mutate-.*\.mjs$/.test(n)) found.push(rel ? `${rel}/${n}` : n);
      }
    };
    walk(ROOT, '');
    return found.sort();
  };

  it('the harnesses are read off disk, so none can be quietly absent', () => {
    const found = harnessesOnDisk(ROOT);
    /*
     * The count is not pinned. Pinning it is the same act as keeping a list,
     * and a list is the thing this check exists to replace. What is asserted is
     * that the enumeration agrees with a plain directory read, which is true
     * in any checkout and false the moment the walk starts skipping.
     */
    const plain = readdirSync(join(ROOT, 'scripts'))
      .filter((f) => /^mutate-.*\.mjs$/.test(f)).map((f) => `scripts/${f}`).sort();
    expect(plain.length, 'no harnesses beside this file, so this proves nothing')
      .toBeGreaterThan(0);
    expect(found.filter((f) => f.startsWith('scripts/'))).toEqual(plain);
  });

  it('AND THE DIRECTORIES IT WALKS REACH EVERY HARNESS HERE - swept, not assumed', () => {
    /*
     * The entrance walks a written-down list of directories, and a written-down
     * list goes stale in silence. This is what stops it: the checkout is swept
     * whole, and a harness those directories do not reach is red here.
     */
    const swept = sweep();
    const enumerated = harnessesOnDisk(ROOT);
    expect(swept.length, 'the sweep found no harnesses, so it proves nothing').toBeGreaterThan(0);
    expect(
      swept.filter((f) => !enumerated.includes(f)),
      'these harnesses are in this checkout and the directories the shared entrance '
        + 'walks do not reach them, so nothing below sees them at all.',
    ).toEqual([]);
  });

  it('AND THERE IS EXACTLY ONE ENTRANCE - a copy beside a harness is not a shared one', () => {
    /*
     * Every check here asks whether a harness IMPORTS a file of that name. A
     * second copy of it, placed beside a harness, satisfies all of them while
     * sharing nothing.
     */
    const doors: string[] = [];
    const look = (dir: string, rel: string): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.') || NOT_THIS_PROJECT_S_SOURCE.has(n)) continue;
        const at = join(dir, n);
        let st;
        try { st = statSync(at); } catch { continue; }
        if (st.isDirectory()) { look(at, rel ? `${rel}/${n}` : n); continue; }
        if (n === 'mutation-door.mjs') doors.push(rel ? `${rel}/${n}` : n);
      }
    };
    look(ROOT, '');
    expect(doors, 'one entrance, or the harnesses are not sharing one')
      .toEqual(['scripts/mutation-door.mjs']);
  });

  it('every harness in this checkout asks the entrance all three questions, or is named', () => {
    const all = harnessesOnDisk(ROOT);
    expect(all.length, 'no harnesses were found, so this proves nothing').toBeGreaterThan(0);
    const outside = all.filter((f) => !throughTheEntrance(code(f))).sort();
    expect(
      outside.filter((f) => !NOT_THROUGH_YET.includes(f)),
      'these harnesses answer the entrance\'s three questions themselves instead of asking it, '
        + 'so nothing holds their answers to the rules below. Give one the shared entrance; do '
        + 'not add it to the list.',
    ).toEqual([]);
    expect(
      NOT_THROUGH_YET.filter((f) => all.includes(f) && outside.includes(f) === false),
      'these are named as not asking the entrance yet and they now ask it: delete their lines '
        + 'in the same turn as the change that fixed them.',
    ).toEqual([]);
  });
});

describe('A RUN THAT MEASURED NOTHING IS NOT SCORED AS A SURVIVOR', () => {
  const harnesses = throughTheEntranceHere;

  it('the sentence the defect was made of is gone from every one of them', () => {
    /*
     * A run in which nothing executed, reported as the loudest claim a harness
     * can make about the product, is what this whole section is here to stop.
     */
    for (const f of harnesses()) {
      expect(text(f), `${f} still scores a run that did not happen as a survivor`)
        .not.toContain('Treated as SURVIVED');
    }
  });

  it('each one reports the states separately rather than in one sentence', () => {
    for (const f of harnesses()) {
      expect(code(f), `${f} has no line of its own for a run that measured nothing`)
        .toContain('RAN AND MEASURED NOTHING');
      expect(code(f), `${f} has no line of its own for a mutation that could not be applied`)
        .toContain('COULD NOT BE APPLIED');
    }
  });

  it('AND THE EXIT STATUS IS DRIVEN, NOT READ - every state reaches it', () => {
    for (const f of harnesses()) {
      /*
       * The LAST exit is the verdict. The earlier ones are refusals that stop
       * before anything is scored.
       */
      const exits = [...code(f).matchAll(/process\.exit\(([^;]*)\);/g)].map((x) => x[1]);
      expect(exits.length, `${f} never exits`).toBeGreaterThan(0);
      const exit = exits[exits.length - 1];

      /*
       * THE EXPRESSION IS EVALUATED RATHER THAN MATCHED. Requiring the names to
       * APPEAR is satisfied by an expression in which none of them does
       * anything: one that reads `survived + stale + notRun === 0 || !aborted`
       * is a character away from the real one, contains every name, and exits 0
       * on every ordinary run whatever the harness found. So it is compiled and
       * driven over the states that matter, and what is asserted is the VERDICT.
       *
       * The names are read OFF the expression rather than assumed, because a
       * harness may count a state the others do not - an entry that credited a
       * guard which ran and passed is one - and a driver that knew only the
       * common ones would quietly stop covering the rest.
       */
      const names = [...new Set(exit.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])];
      for (const required of ['survived', 'stale', 'notRun', 'aborted']) {
        expect(names, `${f}: \`${required}\` is not in the exit expression at all`)
          .toContain(required);
      }
      const verdict = new Function(...names, `return (${exit});`) as (...a: unknown[]) => number;
      const drive = (raised?: string): number =>
        verdict(...names.map((n) => (n === 'aborted' ? n === raised : n === raised ? 1 : 0)));

      expect(drive(), `${f}: a clean run does not exit 0`).toBe(0);
      expect(drive('survived'), `${f}: A SURVIVOR DOES NOT REACH THE EXIT STATUS. A survivor `
        + 'is a claim that a line of the money path has no test behind it, and whatever invokes '
        + 'this harness reads a zero exit as a clean run.').toBe(1);
      expect(drive('stale'), `${f}: a mutation that could not be applied exits 0`).toBe(1);
      expect(drive('notRun'), `${f}: a run that measured nothing exits 0`).toBe(1);
      expect(drive('aborted'), `${f}: a run that stopped early exits 0`).toBe(1);
      for (const other of names.filter((n) => n !== 'aborted')) {
        expect(drive(other), `${f}: \`${other}\` is in the exit expression and changes no verdict`)
          .toBe(1);
      }
    }
  });

  it('AND THE COUNTERS ARE FED - an expression over a number nothing sets is decoration', () => {
    for (const f of harnesses()) {
      for (const counter of ['survived += 1;', 'stale += 1;', 'notRun += 1;']) {
        expect(code(f), `${f}: \`${counter}\` is gone or is commented out, so that state is `
          + 'counted nowhere').toContain(counter);
      }
      expect(code(f), `${f}: nothing ever sets \`aborted\``).toContain('aborted = true;');
    }
  });
});

describe('WHETHER A RUN MEASURED ANYTHING IS CALLED, NOT MATCHED', () => {
  /*
   * The decision itself, driven over the shapes a collapsed run arrives in. The
   * harnesses take this answer from the shared entrance, so driving it here
   * covers all of them at once.
   */
  const healthy = { ran: true, why: '', collected: 40, titles: ['a guard'], emptyFiles: [] as string[] };

  it('a run in which nothing executed is a reason, and the reason is kept', () => {
    const result = readTheReport('{"testResults":[],"numTotalTests":0}');
    expect(measuredNothingBecause({ result, baseline: undefined }).length).toBeGreaterThan(0);
  });

  it('FEWER ASSERTIONS THAN THE BASELINE is a collapse the count alone would miss', () => {
    const why = measuredNothingBecause({
      result: { ...healthy, collected: 12 },
      baseline: { ...healthy, collected: 40 },
    });
    expect(why.join(' ')).toContain('12 assertions collected where the baseline collected 40');
  });

  it('A SUITE FILE THAT WENT QUIET is named, even when the totals look ordinary', () => {
    const why = measuredNothingBecause({
      result: { ...healthy, emptyFiles: ['a.test.ts'] },
      baseline: { ...healthy, emptyFiles: [] },
    });
    expect(why.join(' ')).toContain('a.test.ts');
  });

  it('A NAMED GUARD THAT DID NOT EXECUTE has observed nothing, whatever else ran', () => {
    const why = measuredNothingBecause({
      result: healthy, baseline: healthy, kills: ['a guard that was not there'],
    });
    expect(why.join(' ')).toContain('the guard it names did not execute');
  });

  it('AND THE NEGATIVE CONTROL: a healthy run reports no reason at all', () => {
    expect(measuredNothingBecause({ result: healthy, baseline: healthy, kills: ['a guard'] }))
      .toEqual([]);
  });

  it('and a report nothing can parse is a run that did not happen', () => {
    const result = readTheReport('this is not a report');
    expect(result.ran).toBe(false);
    expect(measuredNothingBecause({ result, baseline: undefined }).length).toBeGreaterThan(0);
  });
});

describe('THE DERIVATION REFUSES RATHER THAN QUIETLY BECOMING A COPY', () => {
  /*
   * The comparisons above read the two configurations' present values. They
   * pass whether or not the derivation can refuse, so on their own they leave
   * every refusal below unheld - delete all four and nothing goes red. Each one
   * is a state in which the second configuration would be a copy rather than a
   * derivation, and one of them is a mutation run scored against no guard at
   * all, which makes every score it produces meaningless.
   */
  it('refuses when the entry it removes is not there', async () => {
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([...KEPT])).toThrow(/is not among/);
  });

  it('refuses when that entry appears twice, because removing one would remove two', async () => {
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([KEPT[0], DROPPED, DROPPED, KEPT[1]])).toThrow(/appears 2 times/);
  });

  it('refuses an empty list - a mutation run with no guard at all', async () => {
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([])).toThrow(/NO globalSetup at all/);
  });

  it('AND REFUSES WHEN THE REMOVAL EMPTIES THE LIST, not only when the input was empty', async () => {
    /*
     * The path a first version missed: a list wiring the dropped entry ALONE is
     * a non-empty input, one hit, and an empty result - a mutation run with no
     * guard whatsoever, produced silently by the function whose own reason said
     * it prevented exactly that. A refusal whose written reason does not match
     * its behaviour is the next reader's false confidence.
     */
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([DROPPED])).toThrow(/leaves NO globalSetup at all/);
  });

  it('and returns the survivors, in order, when the list is the real one', async () => {
    const { dropDocGate, DOC_GATE } = await import('../vitest.mutation.config.ts');
    /*
     * The configuration removes the entry IT names; this file names it
     * independently, so a typo in either is a red assertion rather than a guard
     * that stayed wired.
     */
    expect(DOC_GATE).toBe(DROPPED);
    expect(dropDocGate([KEPT[0], DROPPED, KEPT[1]])).toEqual(KEPT);
  });
});

describe('IMPORTING A HARNESS MUTATES NOTHING, WRITES NOTHING AND EXITS NOTHING', () => {
  it('every harness here, imported, leaves an empty tree and exits 0', () => {
    /*
     * DRIVEN FOR EVERY ONE, NOT ASSERTED FOR A SAMPLE AND NOT MATCHED AS TEXT.
     * Each is imported in its own process whose working directory is a scratch
     * tree OUTSIDE this repository, which is where these scripts take their root
     * from - so anything an import writes lands there and is counted, and
     * nothing it might write can reach this checkout.
     *
     * Reading a harness's list of mutations has to be free. Before the entrance
     * existed, importing one ran the whole thing, which is how a mutation was
     * once left live in the product's own source.
     */
    const harnesses = throughTheEntranceHere();
    expect(harnesses.length, 'no harnesses were imported, so this proves nothing')
      .toBeGreaterThan(0);

    const failures: string[] = [];
    for (const rel of harnesses) {
      const cwd = mkdtempSync(join(tmpdir(), 'harness-import-'));
      let status = 0;
      let said = '';
      try {
        execFileSync(process.execPath, ['-e', `import(${JSON.stringify(join(ROOT, rel))})`],
          { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      } catch (e) {
        const err = e as { status?: number; stderr?: unknown; stdout?: unknown };
        status = err.status ?? -1;
        said = [err.stderr, err.stdout].map((b) => (b ? String(b) : '')).join('\n');
      }
      const left = readdirSync(cwd);
      if (status !== 0) failures.push(`${rel}: importing it exited ${status}. ${said.slice(0, 300)}`);
      if (left.length) failures.push(`${rel}: importing it wrote ${JSON.stringify(left)}`);
      rmSync(cwd, { recursive: true, force: true });
    }
    expect(
      failures,
      'importing a harness ran it. A harness edits files in the working tree, and reading its '
        + 'list of mutations must not do that.',
    ).toEqual([]);
  });
});

describe('THE ENTRANCE ANSWERS THREE WAYS AND THE THIRD IS THE ONE THAT MATTERS', () => {
  /*
   * An entrance that wrongly decides it was imported prints nothing, mutates
   * nothing, measures nothing and exits 0 - and everything that invokes a
   * harness reads a zero exit as a clean run in which every binding was
   * checked. That is the exact failure these harnesses exist to catch,
   * committed by the thing that catches it, which is why a resolution failure
   * on a path a process was plainly given is never allowed to look ordinary.
   */
  const HERE = join(ROOT, 'scripts', 'mutate-authority.mjs');

  it('a process pointed at the file says door; anything else says import', () => {
    expect(entryPointVerdict(HERE, HERE)).toBe('door');
    expect(entryPointVerdict(join(ROOT, 'scripts', 'mutate-refusals.mjs'), HERE)).toBe('import');
    expect(entryPointVerdict(undefined, HERE)).toBe('import');
    expect(entryPointVerdict('', HERE)).toBe('import');
    expect(entryPointVerdict(42 as unknown as string, HERE)).toBe('import');
  });

  it('AND A PATH IT CANNOT RESOLVE, BEARING THE FILE\'S OWN NAME, IS A MISFIRE', () => {
    expect(entryPointVerdict('/no/such/place/mutate-authority.mjs', HERE)).toBe('misfired');
    const throws = ((): string => { throw new Error('cannot resolve'); }) as unknown as
      typeof import('node:fs').realpathSync;
    expect(entryPointVerdict(HERE, HERE, throws)).toBe('misfired');
    /* And one it cannot resolve that is NOT this file is an ordinary import. */
    expect(entryPointVerdict('/no/such/place/some-other-thing.mjs', HERE)).toBe('import');
  });

  it('and the refusal names the harness and says nothing was measured', () => {
    expect(() => openTheDoor(`file://${HERE}`, ['node', '/no/such/place/mutate-authority.mjs']))
      .toThrow(/nothing would have been mutated and nothing measured/);
    expect(theEntranceIsUnreadable('mutate-anything.mjs')).toContain('mutate-anything.mjs');
  });

  it('DRIVEN END TO END, in a tree outside this repository', () => {
    /*
     * A whole harness, three ways: pointed at, it acts; imported, it does not;
     * and an entrance it cannot resolve refuses rather than exiting 0 having
     * done neither.
     */
    const root = mkdtempSync(join(tmpdir(), 'harness-entrance-'));
    copyFileSync(join(ROOT, 'scripts', 'mutation-door.mjs'), join(root, 'mutation-door.mjs'));
    writeFileSync(join(root, 'mutate-fixture.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "import { openTheDoor } from './mutation-door.mjs';",
      'export const MUTATIONS = [{ id: 1 }];',
      "function main() { writeFileSync(new URL('./IT-ACTED.txt', import.meta.url), 'acted\\n'); }",
      'if (openTheDoor(import.meta.url)) main();',
      '',
    ].join('\n'));
    const at = join(root, 'mutate-fixture.mjs');
    const acted = join(root, 'IT-ACTED.txt');

    execFileSync(process.execPath, [at], { cwd: root, stdio: 'pipe' });
    expect(existsSync(acted), 'a harness a process was pointed at did not act').toBe(true);
    rmSync(acted);

    execFileSync(process.execPath, ['-e', `import(${JSON.stringify(at)})`],
      { cwd: root, stdio: 'pipe' });
    expect(existsSync(acted), 'importing the harness ran it').toBe(false);

    writeFileSync(join(root, 'misfire.mjs'), [
      "import { openTheDoor } from './mutation-door.mjs';",
      "const url = new URL('./mutate-fixture.mjs', import.meta.url).href;",
      "openTheDoor(url, ['node', '/no/such/place/mutate-fixture.mjs']);",
      '',
    ].join('\n'));
    let status = 0;
    let said = '';
    try {
      execFileSync(process.execPath, [join(root, 'misfire.mjs')], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      const err = e as { status?: number; stderr?: unknown };
      status = err.status ?? -1;
      said = String(err.stderr ?? '');
    }
    expect(status, 'an entrance it could not resolve exited 0, which reads as a clean run')
      .not.toBe(0);
    expect(said).toContain('nothing would have been mutated and nothing measured');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('A SCORE THAT CREDITS A GUARD WHICH PASSED IS A FAILURE, NOT A KILL', () => {
  it('separates the claim that held, the claim that did not, and the unnamed catcher', () => {
    const scored = scoreKills(
      ['names a guard that died', 'names a guard that ran and PASSED'],
      ['names a guard that died', 'died without being named'],
    );
    expect(scored.named).toEqual(['names a guard that died']);
    expect(
      scored.missed,
      'a credited guard that did not fail is the whole point: the entry says a test watches '
        + 'this binding and the run says it does not',
    ).toEqual(['names a guard that ran and PASSED']);
    expect(scored.extra).toEqual(['died without being named']);
  });

  it('an entry whose every named guard died claims nothing wrong', () => {
    const scored = scoreKills(['a', 'b'], ['a', 'b']);
    expect(scored.missed).toEqual([]);
    expect(scored.extra).toEqual([]);
  });

  it('AND AN ENTRY THAT NAMED NOTHING THAT DIED IS ALL MISSED, NOT SILENTLY EMPTY', () => {
    const scored = scoreKills(['a', 'b'], ['something else entirely']);
    expect(scored.named).toEqual([]);
    expect(scored.missed).toEqual(['a', 'b']);
  });

  it('and the over-claim is counted where it changes the verdict', () => {
    /*
     * The decision above is a pure function and is driven. The wiring from it to
     * the exit status cannot be exercised without running a harness, so this
     * half is a ratchet and says so. What it refuses is the regression that
     * matters: a counter incremented somewhere that touches no verdict, which
     * is the whole shape of the defect it was written for.
     */
    const live = code('scripts/mutate-authority.mjs');
    const branch = live.indexOf('if (missed.length) {');
    const counted = live.indexOf('wrongClaim += 1;');
    expect(branch, 'the over-claim branch is gone').toBeGreaterThan(-1);
    expect(counted, 'the counter is not incremented inside it').toBeGreaterThan(branch);
    expect(counted - branch, 'the increment has drifted out of the branch').toBeLessThan(200);
    expect(live, 'the fifth outcome has no line in the summary')
      .toContain('NAMED A GUARD THAT RAN AND PASSED');
  });
});

describe('THE JOURNAL REFUSES RATHER THAN REVERTING OVER SOMEBODY ELSE\'S WORK', () => {
  /*
   * A harness edits the product's own source on purpose and puts it back. If a
   * run is killed between the edit and the restore, the record it left is the
   * only thing that knows what to put back - and a record that is trusted
   * blindly writes a stale snapshot over whatever has been written since. That
   * has nearly cost this project a round's work once. So the record carries
   * hashes of both states and a path inside the repository, and anything else
   * is refused rather than honoured.
   */
  const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

  const BEFORE = 'export const approvedFor = 1;\n// the text a harness mutated\n';
  const MUTATED = 'export const approvedFor = 0;\n// the text a harness mutated\n';
  const SINCE = 'export const approvedFor = 1;\n// WRITTEN SINCE, AND IT MUST SURVIVE\n';
  const REL = join('src', 'core', 'account.ts');

  const scratch = (fileText: string): { root: string; at: string; journal: string } => {
    const root = mkdtempSync(join(tmpdir(), 'harness-journal-'));
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    const at = join(root, REL);
    writeFileSync(at, fileText);
    return { root, at, journal: join(root, 'in-flight.json') };
  };
  const clean = (root: string): void => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const honest = (): Record<string, unknown> => ({
    v: 2, file: REL, before: BEFORE, expect: sha(MUTATED), restored: sha(BEFORE),
  });

  it('a record with a path and no hash is REFUSED, and the later work survives', () => {
    const { root, at, journal } = scratch(SINCE);
    writeFileSync(journal, JSON.stringify({ path: at, before: BEFORE }));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });
    expect(verdict.state, 'an unversioned record carries no hash and cannot be trusted')
      .toBe('refused');
    expect(readFileSync(at, 'utf8'), 'THE WORK WRITTEN SINCE WAS OVERWRITTEN').toBe(SINCE);
    expect(said, 'it announced a recovery it did not perform').toEqual([]);
    clean(root);
  });

  it('AND SO IS A RECORD WHOSE PATH CLIMBS OUT OF THE REPOSITORY', () => {
    /*
     * THE FILE OUTSIDE HOLDS EXACTLY THE TEXT THE RECORD EXPECTS, AND THAT IS
     * THE WHOLE POINT OF THE CASE. A record naming somewhere outside whose
     * content does NOT match is refused by the hash check further down, so an
     * assertion built that way passes whether or not the path is ever looked
     * at - it holds the wrong thing, and watching it proved so. With the
     * content matching, only the path check stands between this record and a
     * write to a file outside the repository.
     */
    const { root, journal } = scratch(BEFORE);
    const outside = join(root, '..', `outside-${process.pid}.ts`);
    writeFileSync(outside, MUTATED);
    writeFileSync(journal, JSON.stringify({ ...honest(), file: join('..', `outside-${process.pid}.ts`) }));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });
    expect(verdict.state, 'a record naming a path outside the repository was honoured')
      .toBe('refused');
    expect(
      readFileSync(outside, 'utf8'),
      'A FILE OUTSIDE THE REPOSITORY WAS WRITTEN from a stored copy',
    ).toBe(MUTATED);
    expect(said).toEqual([]);
    rmSync(outside, { force: true });
    clean(root);
  });

  it('AND A PATH THAT CLIMBS OUT THROUGH A LINK IS REFUSED TOO - the real path, not the spelt one', () => {
    /*
     * Resolving a path does not follow links, so a record naming a link INSIDE
     * the repository that points anywhere on the machine satisfies a check that
     * reads the spelling and then writes straight through it. The record this
     * refuses is one nothing here wrote, which is exactly where a link would
     * come from.
     */
    const { root, journal } = scratch(BEFORE);
    const outside = join(root, '..', `linked-${process.pid}.ts`);
    writeFileSync(outside, MUTATED);
    const link = join(root, 'src', 'core', 'link.ts');
    symlinkSync(outside, link);
    writeFileSync(journal, JSON.stringify({ ...honest(), file: join('src', 'core', 'link.ts') }));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });
    expect(verdict.state, 'a link out of the repository was followed and honoured')
      .toBe('refused');
    expect(
      readFileSync(outside, 'utf8'),
      'A FILE OUTSIDE THE REPOSITORY WAS WRITTEN THROUGH A LINK',
    ).toBe(MUTATED);
    expect(said).toEqual([]);
    rmSync(outside, { force: true });
    clean(root);
  });

  it('a stale hash is REFUSED - somebody has been working here since', () => {
    const { root, at, journal } = scratch(SINCE);
    writeFileSync(journal, JSON.stringify(honest()));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });
    expect(verdict.state, 'the file on disk is neither the mutation nor the original').toBe('refused');
    expect(readFileSync(at, 'utf8')).toBe(SINCE);
    clean(root);
  });

  it('AND AN HONEST RECORD RECOVERS - the mutation is still there and is put back', () => {
    const { root, at, journal } = scratch(MUTATED);
    writeFileSync(journal, JSON.stringify(honest()));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });
    expect(verdict.state).toBe('recovered');
    expect(readFileSync(at, 'utf8'), 'the mutation was left in the product\'s own source')
      .toBe(BEFORE);
    expect(
      said.join(' '),
      'it put the file back and said nothing, so the next person does not know a run was killed',
    ).toContain('has been put back');
    clean(root);
  });

  it('AND THE RECORD THE WRITER PRODUCES IS THE SHAPE THE READER ACCEPTS', () => {
    /*
     * THE TWO ENDS, PINNED TOGETHER. Every refusal above is held against a
     * record this file writes by hand, which says nothing about the record the
     * harness actually leaves. Two things that must agree, checked on one side
     * only, is the shape this project keeps paying for: let the writer drift to
     * an absolute path or drop the hash of the mutated text, and every
     * assertion above stays green while the first killed run leaves its
     * mutation live in the product's own source and the recovery declines to
     * put it back - a silent failure wearing a working guard's refusal.
     *
     * So the writer is called, and what it wrote is handed to the reader.
     */
    const { root, at, journal } = scratch(MUTATED);
    beginMutation(REL, BEFORE, MUTATED, { journal });

    const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
    expect(record.v, 'the record carries no version, which the reader refuses').toBe(2);
    expect(record.file, 'the record names an absolute path, which the reader refuses')
      .toBe(REL);
    expect(
      record.expect,
      'the hash is not of the MUTATED text, so the reader cannot answer *is this file still the '
        + 'one the harness broke* and refuses every honest recovery',
    ).toBe(sha(MUTATED));
    expect(
      record.restored,
      'the hash of the restored text is missing, so a run killed between the record and the '
        + 'write - a clean tree - is reported as somebody having worked here since',
    ).toBe(sha(BEFORE));

    /* And the reader accepts it end to end, which is the point of the pairing. */
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });
    expect(
      verdict.state,
      'the reader refused the record the writer just produced, so no killed run is recoverable',
    ).toBe('recovered');
    expect(readFileSync(at, 'utf8')).toBe(BEFORE);
    clean(root);
  });

  it('AND A RUN KILLED BEFORE THE MUTATION LANDED IS A CLEAN TREE, NOT TAMPERING', () => {
    /*
     * The record is written BEFORE the mutation is, so a run killed between the
     * two lines leaves an untouched file and a live record. Without the second
     * hash the honest case reads as somebody having worked in the file since,
     * and a person is invited to restore over work that was never disturbed.
     */
    const { root, at, journal } = scratch(BEFORE);
    beginMutation(REL, BEFORE, MUTATED, { journal });
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });
    expect(verdict.state, 'a clean tree was reported as tampering').toBe('nothing');
    expect(readFileSync(at, 'utf8')).toBe(BEFORE);
    expect(
      JSON.parse(readFileSync(journal, 'utf8')),
      'the record was left behind, so the next run announces a recovery that did not happen',
    ).toEqual({});
    clean(root);
  });

  it('and an empty or absent record says nothing at all', () => {
    const { root, journal } = scratch(BEFORE);
    expect(recoverFromLastRun(() => {}, { root, journal }).state).toBe('nothing');
    writeFileSync(journal, '{}');
    expect(recoverFromLastRun(() => {}, { root, journal }).state).toBe('nothing');
    clean(root);
  });
});
