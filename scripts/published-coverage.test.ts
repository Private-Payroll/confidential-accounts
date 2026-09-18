/**
 * WHAT THE PUBLISHED SUITE DOES NOT COVER SAYS SO, AND THE PART THAT CAN BE
 * COVERED IS.
 *
 * Some checks here read a derived artefact rather than building their own
 * picture of the system, and they stand down when it is not on disk. That is
 * the right behaviour - a check that invented its input would be checking its
 * invention - but the cost is invisible from outside: the suite goes green,
 * quieter than it was, and nothing says which assertions were not among the
 * ones that passed.
 *
 * Three situations were being treated as one, and this file separates them:
 *
 *   MADE HERE    the module map and the built library are derived from the
 *                source. They are absent from a fresh checkout because they are
 *                build output, not because they are secret, so the checks make
 *                them and the assertions below hold the checks to doing so.
 *
 *   NOT HERE     the publication allowlist names the files that are NOT
 *                published, so it cannot itself be published. The assertion
 *                that reads it can only run where that file already is.
 *
 *   THE MACHINE  several assertions stand down on a database or on what the
 *                filesystem can do rather than on anything this repository
 *                ships. That is a different question, and they are named
 *                rather than judged here.
 *
 * -- THE FAILURE THIS PREVENTS ---------------------------------------------
 *
 * A later reader treating a green published suite as coverage of everything it
 * collects. One of the assertions that was standing down is the instrument for
 * a defect this project has already had: a file on the publication allowlist
 * swallowed by an ignore rule, which publishes nothing and reports nothing.
 *
 * -- THE RULES ARE IMPORTED, AND THEY ARE DRIVEN HERE BEFORE THEY ARE USED ---
 *
 * Two versions of the reader that finds a stand-down were wrong, and neither
 * could be measured because both were private to this file. They now live in
 * `scripts/stand-downs.ts` as functions, and the first group below drives them
 * over conditions written every way this repository writes them, including the
 * ones that defeated each previous version. A rule nothing can drive is a rule
 * nothing has measured.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EDGE_LIST_FILE, GENERATED_BLOCKS, GENERATED_FILES } from './doc-registry.js';
import {
  assertionsUnder, codeOnly, lexedMentions, mentionsStandingDown, senseOf, standDowns,
} from './stand-downs.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const text = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** The entry point that writes the module map and no document. */
const MAP_WRITER = 'npx tsx scripts/edge-list-run.ts';

/** The checks a reader of this repository sees, and the steps every job runs first. */
const WORKFLOW = '.github/workflows/ci.yml';
const BUILD_ACTION = '.github/actions/build/action.yml';
const SHARED_STEPS = './.github/actions/build';

/* ------------------------------------------------- reading the checks --- */

type Step = { readonly command: string; readonly uses: string; readonly conditional: boolean };

/**
 * THE STEPS OF A BLOCK OF WORKFLOW, READ AS STEPS, AND READ AS A LIST.
 *
 * Only lines inside a `steps:` list count, and a step is a LIST ITEM rather
 * than a line: its `run:` and its `if:` belong to each other, and a reader that
 * took them line by line credited a command that never runs.
 *
 * Four things that look like a step that runs and do not: a comment; a `run:`
 * spelled inside a build matrix; a `run:` line inside a block of shell
 * belonging to an earlier step; and a step carrying `if:` or
 * `continue-on-error: true`, which may not run or may fail and be forgiven.
 * Each is either skipped or recorded as something no command will ever match.
 */
const steps = (source: string): Step[] => {
  const lines = source.split('\n');
  const out: Step[] = [];
  let inSteps = false;
  let stepsIndent = -1;
  let item: { command: string; uses: string; conditional: boolean } | undefined;
  const close = (): void => { if (item !== undefined) out.push(item); item = undefined; };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.search(/\S/);
    const key = line.match(/^\s*([A-Za-z0-9_-]+):\s*$/);
    if (key && key[1] === 'steps') { close(); inSteps = true; stepsIndent = indent; continue; }
    if (inSteps && key && indent <= stepsIndent) { close(); inSteps = false; }
    if (!inSteps) continue;
    if (/^\s*-\s/.test(line)) { close(); item = { command: '', uses: '', conditional: false }; }
    if (item === undefined) continue;
    const bare = line.replace(/^(\s*)-\s+/, (_m, w: string) => `${w}  `);
    if (/^\s*if:\s*\S/.test(bare)) { item.conditional = true; continue; }
    if (/^\s*continue-on-error:\s*true\s*$/.test(bare)) { item.conditional = true; continue; }
    const run = bare.match(/^\s*run:\s*(\S.*?)\s*$/);
    if (run) {
      if (/^[|>][-+]?\d*$/.test(run[1])) {
        item.command = '<a block of shell this check does not read>';
        const runIndent = bare.search(/\S/);
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next.trim() !== '' && next.search(/\S/) <= runIndent) break;
          i += 1;
        }
        continue;
      }
      item.command = run[1];
      continue;
    }
    const uses = bare.match(/^\s*uses:\s*(\S+)\s*$/);
    if (uses) item.uses = uses[1];
  }
  close();
  return out;
};

/**
 * One `run:` value split into the commands it actually invokes.
 *
 * A VALUE CONTAINING `||` INVOKES NOTHING THIS CHECK WILL CREDIT. `npm run
 * compact || true` runs the build and then forgives its failure, so crediting
 * the left-hand side means crediting a step that is allowed not to work - which
 * is the same hole as reading a step's `run:` without its `if:`.
 */
const invocations = (command: string): string[] => {
  if (command.includes('||')) return ['<a command allowed to fail>'];
  return command.split(/&&|;/)
    .map((c) => c.replace(/>>?\s*"?\$?\{?[\w{}$]+"?\s*$/, '').trim())
    .filter((c) => c.length > 0);
};

/**
 * EVERY JOB IN THE CHECKS, WITH THE COMMANDS IT RUNS IN ORDER.
 *
 * Only what is under `jobs:` counts: the keys naming the events that start a
 * run sit at the same indentation and are not jobs. A job that defers to the
 * shared build steps gets those steps' commands spliced in where it defers to
 * them, because that is where they run - and the deferral is matched WHOLE,
 * since a neighbouring action with a longer name runs something else entirely.
 */
const jobs = (): { name: string; commands: string[] }[] => {
  const lines = text(WORKFLOW).split('\n');
  const top = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (top === -1) return [];
  const shared = steps(text(BUILD_ACTION)).flatMap((s) => invocations(s.command));
  const starts: { name: string; at: number }[] = [];
  for (let i = top + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) starts.push({ name: m[1], at: i });
  }
  return starts.map(({ name, at }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : lines.length;
    const block = lines.slice(at, end);
    /*
     * A JOB CARRYING ITS OWN `if:` MAY NEVER START, so nothing in it can be
     * credited with making anything. Measured: the job that runs the suite was
     * given `if: github.event_name == 'never'` and every assertion here stayed
     * green.
     */
    const conditional = block.some((l) => /^    if:\s*\S/.test(l));
    const commands: string[] = [];
    for (const step of steps(block.join('\n'))) {
      if (step.conditional) { commands.push('<a step that may not run>'); continue; }
      if (step.uses === SHARED_STEPS) { commands.push(...shared); continue; }
      if (step.uses !== '') continue;
      commands.push(...invocations(step.command));
    }
    return { name, commands: conditional ? [] : commands };
  });
};

/** The job whose commands run the whole suite, found by what it runs. */
const suiteJob = (): { name: string; commands: string[] } =>
  jobs().find((j) => j.commands.includes('npx vitest run')) ?? { name: '', commands: [] };

/**
 * Where a command runs the given test file: the whole suite covers every file
 * the runner collects, and a run naming files covers the ones it names.
 */
const covers = (command: string, file: string): boolean =>
  command === 'npx vitest run'
  || (command.startsWith('npx vitest run ') && command.split(/\s+/).includes(file));

/* --------------------------------------------- reading the suite ------- */

/**
 * WHAT THE RUNNER INCLUDES, READ OFF THE RUNNER'S OWN CONFIGURATION.
 *
 * Not a list in this file. A first version of the walk below carried its own
 * idea of what to skip - directories called `lib`, `dist`, `SAFE` - while the
 * runner excludes only installed packages and the history. TWO PUBLISHED TEST
 * FILES WERE SITTING IN ONE OF THOSE DIRECTORIES, collected and run by the
 * suite and judged by nothing, and an unnamed stand-down added to one of them
 * left this whole file green. So the set is derived from the patterns the
 * runner actually uses.
 */
const INCLUDE = ['src/**/*.test.{ts,tsx}', 'contracts/test/**/*.test.ts',
  'scripts/**/*.test.ts', 'packages/identity/src/**/*.test.{ts,tsx}',
  'apps/wallet/**/*.test.{ts,tsx}'];

/** One of those patterns, as something that can be asked about a path. */
const asRegExp = (glob: string): RegExp => {
  /*
   * ALTERNATION FIRST, THEN ESCAPING, AND THAT ORDER IS THE WHOLE OF IT: a
   * first version escaped the braces before reading them, so `{ts,tsx}` became
   * a pattern matching nothing and every file looked like a finding. A
   * translation that silently matches nothing is worse than none. The markers
   * are words rather than escapes so that nothing in a path can be one.
   */
  const body = glob
    .replace(/\{([^}]*)\}/g, (_m, alts: string) => `@ONEOF@${alts.split(',').join('|')}@END@`)
    .replace(/[.+^$()[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '@ANYDIRS@')
    .replace(/\*/g, '[^/]*')
    .replace(/@ANYDIRS@/g, '(?:.*/)?')
    .replace(/@ONEOF@/g, '(?:')
    .replace(/@END@/g, ')');
  return new RegExp(`^${body}$`);
};

const PATTERNS = INCLUDE.map(asRegExp);

/**
 * THE DIRECTORIES THE RUNNER'S PATTERNS CAN REACH, DERIVED FROM THE PATTERNS.
 *
 * The literal part of each pattern, before its first wildcard. A file the
 * runner collects must match one of those patterns and therefore lives under
 * one of these, so walking exactly these cannot miss one - and unlike a list of
 * directories to skip, it has nothing in it that somebody chose.
 */
const ROOTS = [...new Set(INCLUDE.map((g) => g.slice(0, g.indexOf('*')).replace(/\/$/, '')))];

/**
 * EVERY FILE UNDER THOSE ROOTS THAT LOOKS LIKE A TEST, skipping only what the
 * runner skips: installed packages and the history.
 *
 * NOTHING ELSE IS SKIPPED BY NAME. A first version carried its own idea of what
 * to skip - directories called `lib`, `dist`, `SAFE` - while the runner
 * excludes only those two. TWO PUBLISHED TEST FILES WERE IN ONE OF THOSE
 * DIRECTORIES, collected and run by the suite and judged by nothing, and an
 * unnamed stand-down added to one of them left this whole file green.
 */
let shapedCache: string[] | undefined;
const everythingTestShaped = (): string[] => {
  if (shapedCache !== undefined) return shapedCache;
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git') continue;
      const at = join(dir, n);
      let st;
      try { st = statSync(at); } catch { continue; }
      if (st.isDirectory()) { walk(at, rel ? `${rel}/${n}` : n); continue; }
      if (/\.test\.tsx?$/.test(n)) out.push(rel ? `${rel}/${n}` : n);
    }
  };
  for (const root of ROOTS) walk(join(ROOT, root), root);
  shapedCache = out.sort();
  return shapedCache;
};

/**
 * THE SAME QUESTION ASKED A DIFFERENT WAY, for the reverse comparison below.
 *
 * One listing per root, from the platform rather than from a recursion written
 * here, with no list of directories to skip beyond the one the runner skips.
 * BOTH DIRECTIONS OF A COMPARISON DRAWN FROM ONE WALK ARE ONE DIRECTION: a walk
 * that misses a file reports it as missing from both sides and the comparison
 * stays green - measured, by putting a skipped directory name back and watching
 * nothing go red.
 */
const everythingTestShapedIndependently = (): string[] => {
  const out: string[] = [];
  for (const root of ROOTS) {
    let entries: string[];
    try { entries = readdirSync(join(ROOT, root), { recursive: true }) as string[]; } catch { continue; }
    for (const entry of entries) {
      const rel = `${root}/${String(entry).split(sep).join('/')}`;
      if (rel.includes('/node_modules/') || rel.includes('/.git/')) continue;
      if (/\.test\.tsx?$/.test(rel)) out.push(rel);
    }
  }
  return out.sort();
};

/** The ones the runner collects, which is the set this file may speak for. */
let judgedCache: string[] | undefined;
const testFiles = (): string[] => {
  if (judgedCache === undefined) {
    judgedCache = everythingTestShaped().filter((f) => PATTERNS.some((p) => p.test(f)));
  }
  return judgedCache;
};

type Named = { readonly file: string; readonly title: string; readonly sense: string };

const allStandDowns = (): Named[] => {
  const out: Named[] = [];
  for (const f of testFiles()) {
    for (const d of standDowns(text(f)).found) out.push({ file: f, title: d.title, sense: d.sense });
  }
  return out;
};

/** The commands a bracketed note names as making what it waits for. */
const namedCommands = (title: string): string[] => {
  const note = title.match(/\[(?:needs|only without) ([^\]]+)\]/);
  if (!note) return [];
  return [...note[1].matchAll(/`([^`]+)`/g)].map((c) => c[1]);
};

/**
 * THE FILES WHOSE STAND-DOWNS DO NOT SAY WHAT DECIDES THEM, NAMED SO THAT
 * NOTHING JOINS THEM QUIETLY.
 *
 * Every one stands down on the machine rather than on anything this repository
 * ships: on a database being reachable, or on whether the filesystem can refuse
 * a write. That is a different question from the build output above and
 * answering it is not this change's. THE LIST MAY SHRINK AND MAY NEVER GROW:
 * name the condition in the title and delete the line here in the same turn.
 *
 * ONE LINE LEFT THIS LIST BECAUSE ITS FILE LEFT THE PUBLISHED SET. It stood
 * down on a sampling budget, and it was a reproduction harness rather than
 * coverage - so it is now private tooling and is not walked from here at all.
 * The breakdown above no longer counts the entries, deliberately: a count in a
 * sentence beside a list is a second copy of the list, and this one had already
 * drifted from it before today.
 */
/**
 * THE FILES WHOSE PROSE MENTIONS STANDING DOWN WHILE HOLDING NONE OF IT.
 *
 * The crudest question reads the untouched bytes, comments included, so a
 * sentence about a stand-down counts as one. That is the price of a question no
 * lexer can be wrong about, and it is a cheap price: a line here, checked in
 * both directions. THE REVERSE CHECK IS THE IMPORTANT HALF - a file listed here
 * must hold nothing the LEXED question can see either, so putting a file on
 * this list cannot hide a real stand-down in it.
 */
const MENTIONS_IT_WITHOUT_DOING_IT: readonly string[] = [
  'scripts/module-graph.test.ts',
  'scripts/published-coverage.test.ts',
];

const SAYS_NOTHING_YET: readonly string[] = [
  'src/core/rate-limit.test.ts',
  'src/core/sessions.test.ts',
  'src/core/store-file.test.ts',
  'src/db/migrate.test.ts',
  'src/db/vault-records.test.ts',
  'src/midnight/vault-ledger.test.ts',
];

describe('THE RULES THAT FIND A STAND-DOWN, DRIVEN BEFORE THEY ARE TRUSTED', () => {
  /*
   * Each case below is a way this repository, or a reader of it, writes a
   * stand-down. Two earlier versions of these rules reported nothing for some
   * of them WITHOUT SAYING SO, which is the failure this whole file is about,
   * committed by the thing that reports it.
   */
  it('finds a stand-down however the runner and the condition are spelled', () => {
    const one = (src: string): ReturnType<typeof standDowns> => standDowns(src);
    expect(one("describe.skipIf(!HAS)('t [needs x]', () => {});").found).toHaveLength(1);
    expect(one("test.skipIf(!HAS)('t [needs x]', () => {});").found).toHaveLength(1);
    expect(one("it.concurrent.skipIf(!HAS)('t [needs x]', () => {});").found).toHaveLength(1);
    expect(one("it.each([1]).skipIf(!HAS)('t [needs x]', () => {});").found).toHaveLength(1);
    /* The runner chosen as a value, inline and bound to a name used later. */
    expect(one("(HAVE ? describe : describe.skip)('t [needs x]', () => {});").found)
      .toHaveLength(1);
    const bound = one("const withDb = DB ? describe : describe.skip;\nwithDb('against a db', () => {});");
    expect(bound.found).toHaveLength(1);
    expect(bound.found[0].title).toBe('against a db');
    /* A comment inside the condition is not a quote and not a parenthesis. */
    expect(one("describe.skipIf(/* don't */ !HAS)('t [needs x]', () => {});").found)
      .toHaveLength(1);
  });

  it('AND SAYS SO WHEN IT CANNOT FINISH READING ONE, rather than reporting nothing', () => {
    /*
     * A condition holding a regex or a string with a bracket in it is beyond
     * these rules. That is allowed; dropping it in silence is not, because the
     * emptiness check is satisfied by the shapes that did read and the gap is
     * then quiet at both ends.
     */
    const r = standDowns("it.skipIf(!/\\(a/.test(s))('t [needs x]', () => {});");
    expect(r.found).toHaveLength(0);
    expect(r.unreadable, 'it could not read the condition and did not say so').toBe(1);
  });

  it('AND A TITLE IT CANNOT READ IS ALSO SAID, not only a condition it cannot read', () => {
    /*
     * There are two ways to fail to finish reading a stand-down, and only one
     * of them was held. A title given as a constant rather than written out is
     * beyond these rules; being unable to read it is allowed, and dropping it
     * in silence is not.
     */
    const r = standDowns("describe.skipIf(!HAS)(TITLE_FROM_A_CONSTANT, () => {});");
    expect(r.found).toHaveLength(0);
    expect(r.unreadable, 'it could not read the title and did not say so').toBe(1);
  });

  it('AND A SPELLING QUOTED INSIDE A STRING IS NOT TAKEN FOR A STAND-DOWN', () => {
    /*
     * A file that writes ABOUT these spellings holds them in its own string
     * literals - this one holds a dozen - and a reader that matched inside a
     * quotation reported this file as holding a dozen unnamed stand-downs it
     * does not have. A quotation is not a statement.
     *
     * The example is one that would READ CLEANLY if the quotation were ignored,
     * so the difference between excluding it and failing to parse it is
     * visible. An earlier version of this case used one the reader could not
     * finish anyway, and passed whether or not the quotation was noticed.
     */
    const writing = 'const example = "describe.skipIf(!HAS)(\'t\', () => {});";';
    const read = standDowns(writing);
    expect(read.found, 'a spelling quoted inside a string was read as a stand-down')
      .toHaveLength(0);
    expect(read.unreadable, 'it was excluded by being unreadable rather than by being quoted')
      .toBe(0);
    /* And the real thing beside it is still found, so the exclusion is not a blanket. */
    const both = standDowns(`${writing}\ndescribe.skipIf(!HAS)('real [needs x]', () => {});`);
    expect(both.found).toHaveLength(1);
    expect(both.found[0].title).toBe('real [needs x]');
  });

  it('and the cruder question over-reports on purpose, so a shape it cannot parse is loud', () => {
    /*
     * GREATER THAN ZERO, NOT EQUAL TO ONE. This question is allowed to count
     * the same stand-down more than once - it reads shapes rather than syntax -
     * and pinning an exact number here would be pinning the over-reporting it
     * exists to do.
     */
    expect(mentionsStandingDown("it.skipIf(!/\\(a/.test(s))('t', () => {});"))
      .toBeGreaterThan(0);
    expect(mentionsStandingDown('const g = DB ? describe : describe.skip;')).toBeGreaterThan(0);
    /* And the shape the reader above cannot see at all: a no-op other arm. */
    expect(
      mentionsStandingDown('const g = DB ? describe : NOTHING;'),
      'a runner chosen against something that is not the skipping runner is invisible to both '
        + 'questions, which is how one of these came to be written',
    ).toBeGreaterThan(0);
    expect(mentionsStandingDown('nothing stands down here')).toBe(0);
    expect(
      mentionsStandingDown('// somebody wondering: is it a stand-down or not'),
      'ordinary prose is being counted, so every file must account for itself and the lists '
        + 'below become the whole suite',
    ).toBe(0);
  });

  it('THE SENSE IS REDUCED OR REPORTED UNKNOWN - it is never guessed from a spelling', () => {
    expect(senseOf('skipIf', '!X')).toBe('present');
    expect(senseOf('skipIf', '(!X)')).toBe('present');
    expect(senseOf('skipIf', 'X')).toBe('absent');
    expect(senseOf('runIf', 'X')).toBe('present');
    expect(senseOf('runIf', '!X')).toBe('absent');
    /* The three that defeated deciding this by whether the text starts with `!`. */
    expect(senseOf('skipIf', '!!X'), 'a double negation was read as a negation').toBe('unknown');
    expect(senseOf('skipIf', 'KEYS === undefined'), 'a comparison was read as plain')
      .toBe('unknown');
    expect(senseOf('skipIf', 'A && B')).toBe('unknown');
    /*
     * AND A BARE RELATIONAL OPERATOR IS NOT A PLAIN CONDITION EITHER. `>=` and
     * `<=` were refused while `>` and `<` were read as plain, so
     * `skipIf(n > 0)` was reported with a sense it had been guessed rather than
     * reduced - and a guessed sense moves an assertion into or out of the
     * refusal-path check below without a word.
     */
    expect(senseOf('skipIf', 'n > 0'), 'a bare relational condition was read as plain')
      .toBe('unknown');
    expect(senseOf('skipIf', 'n < 2')).toBe('unknown');
    expect(senseOf('skipIf', 'a ?? b')).toBe('unknown');
  });

  it('AND THE COMMENT STRIPPER IS DRIVEN AGAINST WHAT DEFEATED THE LAST ONE', () => {
    /*
     * The positive assertions in the guards beside this one read stripped
     * source, so a statement commented out must not satisfy "this is present".
     * A line-level stripper let three shapes through.
     */
    expect(codeOnly('let a = 1; /*\nsurvived += 1;\n*/\nreal();'),
      'a block comment opened mid-line hid a statement').not.toContain('survived += 1;');
    expect(codeOnly('let x = 1; // survived += 1;'),
      'a trailing line comment hid a statement').not.toContain('survived += 1;');
    expect(codeOnly('}\n} /* survived += 1; */')).not.toContain('survived += 1;');
    /* And it leaves alone what is not a comment. */
    expect(codeOnly("const s = '/*'; survived += 1;")).toContain('survived += 1;');
    expect(codeOnly('const r = /https:\\/\\//; survived += 1;')).toContain('survived += 1;');
    expect(codeOnly('const y = 2\n* 3;'), 'a continuation line was taken for a comment')
      .toContain('* 3;');
    /*
     * AND THE SHAPE IS KEPT: comments are blanked rather than deleted, so a
     * line and a column in the stripped source are a line and a column in the
     * file. A previous instrument in this repository deleted them and had to be
     * corrected for exactly that, and this module now ships, so the next caller
     * that reports a position inherits whichever choice is made here.
     */
    for (const shape of ['const a = 1; /* here */ const b = 2;',
      'const a = 1; // here\nconst b = 2;']) {
      expect(codeOnly(shape), `the length of ${JSON.stringify(shape)} changed`)
        .toHaveLength(shape.length);
      expect(
        codeOnly(shape).indexOf('const b'),
        `the column of the code after the comment in ${JSON.stringify(shape)} moved`,
      ).toBe(shape.indexOf('const b'));
    }
    expect(codeOnly('a();\n// gone\nb();').split('\n')).toHaveLength(3);
  });
});

describe('THE BUILD OUTPUT THE SUITE READS IS MADE BEFORE THE SUITE READS IT', () => {
  it('the job that runs the whole suite derives the module map first', () => {
    const { name, commands } = suiteJob();
    expect(name, `${WORKFLOW} has no job that runs the whole suite`).not.toBe('');
    const writes = commands.indexOf(MAP_WRITER);
    expect(
      writes,
      `the ${name} job runs no step that derives the module map, so every check that reads it `
        + 'stands down and the suite is quieter than it reads. Nothing else produces it without '
        + 'also rewriting the design documents, which would disarm the gate comparing them.',
    ).toBeGreaterThan(-1);
    expect(
      writes,
      'the map is derived AFTER the suite runs, so the suite it is meant to complete has '
        + 'already stood those checks down.',
    ).toBeLessThan(commands.indexOf('npx vitest run'));
  });

  it('AND DERIVING IT MASKS NOTHING - the map is not among the things the gate compares', () => {
    /*
     * This is what makes the step above safe to run before the suite. The gate
     * keeping the design documents true compares each against what the source
     * derives now; a step that REWROTE one of those before the comparison would
     * leave a gate that can no longer refuse anything.
     */
    const compared = [...GENERATED_BLOCKS.map((s) => s.file), ...GENERATED_FILES.map((s) => s.file)];
    expect(compared.length, 'the gate compares nothing, so the assertion below is vacuous')
      .toBeGreaterThan(0);
    expect(
      compared,
      'the module map is compared against what the source derives, and a step deriving it '
        + 'immediately before the suite is a comparison that can no longer refuse anything.',
    ).not.toContain(EDGE_LIST_FILE);
  });

  it('and the writer reaches only that one artefact', () => {
    const source = codeOnly(text('scripts/edge-list-run.ts'));
    expect(source).toContain('EDGE_LIST_FILE');
    expect(
      (source.match(/writeFileSync\(/g) ?? []).length,
      'the map writer writes more than one file, so it is no longer the narrow writer the step '
        + 'before the suite is allowed to be.',
    ).toBe(1);
  });

  it('AND THE NUMBER THE CHECKS CLAIM IT RESTORES IS THE NUMBER THERE IS', () => {
    /*
     * The workflow tells a reader how many assertions this step restores. That
     * is a claim about the suite written in a comment, and a comment goes stale
     * in silence - which is the shape of the defect it was itself written to
     * correct. So the number is counted here.
     */
    let restored = 0;
    for (const f of testFiles()) {
      const source = text(f);
      for (const d of standDowns(source).found) {
        if (d.sense !== 'present' || !/\[needs the module map;/.test(d.title)) continue;
        /*
         * A GROUP TAKES EVERY ASSERTION INSIDE IT WITH IT, and the number a
         * reader is given is assertions rather than groups. An `it` standing
         * down on its own counts as the one it is.
         */
        restored += Math.max(1, assertionsUnder(source, d.title));
      }
    }
    expect(restored, 'nothing waits on the module map, so this proves nothing')
      .toBeGreaterThan(0);
    /*
     * MATCHED AS A WHOLE NUMBER, NOT AS A SUBSTRING. `toContain` on a number
     * accepts any number ending in the true one: the checks could say 110 while
     * the truth was 10, measured and green. A number checked by substring is
     * the shape of the defect this assertion exists to correct.
     */
    const stated = /# (\d+) assertions read that map/.exec(text(WORKFLOW));
    expect(stated, `${WORKFLOW} states no number of assertions this step restores`)
      .not.toBeNull();
    expect(
      Number((stated as RegExpExecArray)[1]),
      'the checks state a number of assertions this step restores and it is not the number '
        + 'there is',
    ).toBe(restored);
  });
});

describe('AN ASSERTION THAT STANDS DOWN NAMES WHAT IT IS WAITING FOR', () => {
  it('every one of them, in every test file here, says so in its own title', () => {
    const collected = testFiles();
    expect(collected.length, 'no test files were found, so this proves nothing')
      .toBeGreaterThan(0);

    /*
     * THE TWO READERS ARE COMPARED, FILE BY FILE. A file whose live code
     * mentions standing down while the finder reports none of it, or reports
     * one it could not finish reading, or one whose sense it cannot reduce, is
     * REFUSED unless it is named. That is what stops a shape these rules do not
     * know from being a silence.
     */
    const refuse: string[] = [];
    let found = 0;
    const senses = { present: 0, absent: 0 };
    for (const f of collected) {
      const source = text(f);
      /*
       * THE CRUDEST QUESTION DECIDES WHETHER A FILE MUST ACCOUNT FOR ITSELF,
       * and it reads the untouched bytes, so no fault in the reader's lexer can
       * excuse a file from being read. It over-reports, and the cost of that is
       * a line in one of the two lists below.
       */
      if (mentionsStandingDown(source) === 0) continue;
      if (MENTIONS_IT_WITHOUT_DOING_IT.includes(f)) continue;
      const reading = standDowns(source);
      found += reading.found.length;
      for (const d of reading.found) {
        if (d.sense === 'present') senses.present += 1;
        if (d.sense === 'absent') senses.absent += 1;
      }
      const unnamed = reading.found.filter((d) => !/\[(?:needs|only without) /.test(d.title));
      const unclear = reading.found.filter((d) => d.sense === 'unknown');
      /*
       * AND THE COUNTS ARE COMPARED, NOT JUST THEIR PRESENCE. A bare `it.skip`
       * - an assertion that runs NOWHERE, which is worse than one that stands
       * down - sat beside a properly named stand-down and passed a check that
       * asked only whether the reader had found anything at all.
       */
      if (!reading.ended || reading.unreadable > 0 || reading.found.length === 0
        || reading.found.length < lexedMentions(source)
        || unnamed.length > 0 || unclear.length > 0) refuse.push(f);
    }
    expect(found, 'the reader found no stand-down anywhere, so it is matching nothing')
      .toBeGreaterThan(0);
    expect(senses.present, 'no stand-down of the sense that hides coverage was found')
      .toBeGreaterThan(0);
    expect(
      senses.absent,
      'no stand-down of the opposite sense was found, so that half of the reader is matching '
        + 'nothing',
    ).toBeGreaterThan(0);

    expect(
      refuse.filter((f) => !SAYS_NOTHING_YET.includes(f)),
      'these files hold an assertion that does not run everywhere and does not say what decides '
        + 'it - or hold one written a way these rules cannot read. Either name the condition in '
        + 'the title, in brackets, as the others do, or say here that it is not named yet.',
    ).toEqual([]);
    const here = new Set(collected);
    /*
     * AND EVERY FILE EXCUSED AS PROSE IS CHECKED, by the other question. A file
     * on that list must hold nothing the lexed reader can see either; if it
     * does, the excuse is hiding a stand-down rather than a sentence.
     */
    expect(
      MENTIONS_IT_WITHOUT_DOING_IT.filter((f) => here.has(f)
        && (lexedMentions(text(f)) > 0 || standDowns(text(f)).found.length > 0)),
      'these are excused as only WRITING about standing down, and one of them is doing it: the '
        + 'lexed reader can see a stand-down there. Take the line out and name the condition.',
    ).toEqual([]);
    expect(
      MENTIONS_IT_WITHOUT_DOING_IT.filter((f) => here.has(f) && mentionsStandingDown(text(f)) === 0),
      'these are excused as writing about standing down and no longer mention it at all: delete '
        + 'the line in the same turn.',
    ).toEqual([]);
    expect(
      SAYS_NOTHING_YET.filter((f) => here.has(f) && !refuse.includes(f)),
      'these are named as not saying yet and no longer belong here: the title now names its '
        + 'condition, so delete the line in the same turn.',
    ).toEqual([]);
  });

  it('AND WHAT IT WAITS FOR IS MADE BY THE CHECKS, OR IS NAMED AS UNMAKEABLE', () => {
    /*
     * A title that names its input is honest. It is not yet coverage: an input
     * nothing makes is an assertion that runs nowhere, and a green run says so
     * nowhere. So a note carries the command that makes what it waits for, and
     * SOME job of the checks has to run every one of those commands and then
     * run the file, in that order.
     *
     * SOME JOB, BECAUSE IT IS DELIBERATELY NOT ALL ONE JOB. The proving keys
     * take minutes and a hundred megabytes nothing else reads, so they are
     * built once, in a job of their own, which then runs exactly the files that
     * read them.
     *
     * WHOLE COMMANDS, AND EVERY ONE, BOTH FOR MEASURED REASONS. The command
     * that builds the proving keys is a PREFIX of the command that skips
     * building them, so a substring test accepts the one that leaves the keys
     * absent and the assertions over a private payout stay silently stood down.
     * And a note naming two commands names them because it needs both.
     *
     * ONE INPUT CANNOT EXIST IN A CHECKOUT AT ALL: the publication allowlist
     * names the files that are NOT published, so publishing it is a
     * contradiction and no command will ever make it.
     */
    const UNMAKEABLE = ['the publication allowlist, which this repository does not publish'];

    const inTheChecks = jobs();
    expect(inTheChecks.length, 'the checks define no jobs, so this proves nothing')
      .toBeGreaterThan(0);

    const waiting = allStandDowns().filter((d) => /\[needs /.test(d.title));
    expect(waiting.length, 'no assertion names an input it waits for, so this proves nothing')
      .toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const d of waiting) {
      const reason = (d.title.match(/\[needs ([^\]]+)\]/) as RegExpMatchArray)[1];
      if (UNMAKEABLE.includes(reason)) continue;
      const needed = namedCommands(d.title);
      if (needed.length === 0) { uncovered.push(`${d.file}: ${reason} names no command`); continue; }
      const covered = inTheChecks.some((job) => job.commands.some((c, runs) => {
        if (!covers(c, d.file)) return false;
        return needed.every((cmd) => {
          const made = job.commands.indexOf(cmd);
          return made !== -1 && made < runs;
        });
      }));
      if (!covered) {
        uncovered.push(`${d.file}: no job runs all of [${needed.join(', ')}] and then runs it`);
      }
    }
    expect(
      uncovered,
      'these assertions stand down for an input and no job of the checks makes that input and '
        + 'then runs them, so the published suite collects them and covers nothing. Either add '
        + 'the steps, or record the input as one no command can make.',
    ).toEqual([]);

    const reasons = new Set(waiting.map(
      (d) => (d.title.match(/\[needs ([^\]]+)\]/) as RegExpMatchArray)[1]));
    expect(
      UNMAKEABLE.filter((r) => !reasons.has(r)),
      'these are recorded as inputs no command can make and no assertion waits for them any '
        + 'more: delete the line in the same turn as the change that covered it.',
    ).toEqual([]);
  });
});

describe('AND THE TWO THINGS THAT MADE AN EARLIER VERSION OF THIS FILE PASS EMPTY', () => {
  it('THE REFUSAL PATH RUNS BEFORE THE INPUT EXISTS - and this counts what it examined', () => {
    /*
     * An assertion that runs only where an input is ABSENT is the refusal path,
     * and making that input before the suite is exactly what stops it running
     * at all. It is the cheaper half to lose and the worse half to lose
     * silently: the one thing the query it guards must never do is answer
     * *nothing depends on it* for a name that is not there.
     *
     * AND IT COUNTS WHAT IT EXAMINED, which an earlier version did not.
     * Retitling one phrase moved the only refusal path out of its scope and it
     * then passed having looked at nothing - the defect it exists to catch,
     * rebuilt inside the fix. Measured: its loop ran one time, then zero, and
     * it passed both ways.
     */
    const { name, commands } = suiteJob();
    const refusalPaths = allStandDowns().filter(
      (d) => d.sense === 'absent' && /\[only without /.test(d.title));
    expect(
      refusalPaths.length,
      'no refusal path was found at all. Either one lost its bracketed note, or its condition '
        + 'stopped reducing to a sense - and this assertion would then pass having examined '
        + 'nothing.',
    ).toBeGreaterThan(0);

    const gaps: string[] = [];
    for (const d of refusalPaths) {
      const makers = namedCommands(d.title);
      expect(
        makers.length,
        `${d.file}: its note names no command, so nothing says when the input it needs absent `
          + 'comes into being',
      ).toBeGreaterThan(0);
      const runsIt = commands.findIndex(
        (c) => c.startsWith('npx vitest run ') && c.includes(d.file));
      if (runsIt === -1) { gaps.push(`${d.file} is run by no step of its own`); continue; }
      for (const maker of makers) {
        const made = commands.indexOf(maker);
        if (made !== -1 && made < runsIt) {
          gaps.push(`${d.file} is run after \`${maker}\` has already made what it needs absent`);
        }
      }
    }
    expect(
      gaps,
      `these refusal paths run nowhere in the ${name} job: the input they need MISSING is made `
        + 'before they run, so they stand down there as well as in a fresh checkout.',
    ).toEqual([]);
  });

  it('AND THE SET IT JUDGES IS THE RUNNER OWN SET, COMPARED IN BOTH DIRECTIONS', () => {
    /*
     * BOTH DIRECTIONS, AND THE SECOND ONE IS THE ONE THAT WAS MISSING. A first
     * version asked only whether every file it judged was one the runner
     * collects. It never asked the reverse - whether every file the runner
     * collects is one it judges - and its own comment claimed it compared the
     * two sets. TWO PUBLISHED TEST FILES were in the gap, in a directory the
     * walk skipped by name, and an unnamed stand-down in one of them left this
     * file green.
     */
    const patternsAreTheRunners = (): void => {
      const config = codeOnly(text('vitest.config.ts'));
      for (const glob of INCLUDE) {
        expect(
          config,
          `${glob} is not among what the runner includes any more, so both comparisons below `
            + 'are against a list this file made up',
        ).toContain(glob);
      }
      const excludes = /exclude\s*:/.test(config);
      expect(
        excludes,
        'the runner has grown an exclude list, and the walk below skips only installed packages '
          + 'and the history, so the two sets can no longer be derived from the include patterns '
          + 'alone',
      ).toBe(false);
    };
    patternsAreTheRunners();

    expect(
      PATTERNS.some((p) => p.test('scripts/published-coverage.test.ts')),
      'the patterns do not match even this file, so both comparisons are vacuous',
    ).toBe(true);

    expect(
      ROOTS.sort(),
      'the roots walked are not the literal part of the patterns any more, so the walk may not '
        + 'reach a directory the runner collects from',
    ).toEqual(['apps/wallet', 'contracts/test', 'packages/identity/src', 'scripts', 'src']);
    const shaped = everythingTestShapedIndependently();
    const judged = new Set(testFiles());
    expect(shaped.length, 'nothing test-shaped was found at all').toBeGreaterThan(0);
    expect(
      shaped.length,
      'the two enumerations disagree about how many test-shaped files are under those roots, so '
        + 'one of them is skipping something the other is not',
    ).toBe(everythingTestShaped().length);
    expect(judged.size, 'nothing is judged, so every assertion above is vacuous')
      .toBeGreaterThan(0);

    /* One: nothing is judged that the runner does not collect. */
    expect(
      [...judged].filter((f) => !PATTERNS.some((p) => p.test(f))),
      'these are judged as part of the published suite and the runner collects none of them.',
    ).toEqual([]);

    /*
     * Two: nothing test-shaped under those roots goes UNCOLLECTED. A file the
     * runner does not collect is not a quieter assertion, it is one that never
     * runs at all, and it is the easiest of these to create by accident: the
     * pattern over one of these roots takes `.test.ts` and not `.test.tsx`.
     */
    expect(
      shaped.filter((f) => !PATTERNS.some((p) => p.test(f))),
      'these look like tests, sit under a root the runner collects from, and the runner '
        + 'collects none of them, so nothing in them ever runs and nothing says so.',
    ).toEqual([]);

    /* Three: nothing the runner collects goes unjudged. */
    expect(
      shaped.filter((f) => PATTERNS.some((p) => p.test(f)) && !judged.has(f)),
      'the runner collects these and this file judges none of them, so an assertion in one of '
        + 'them could stop running and nothing here would say so.',
    ).toEqual([]);
  });
});
