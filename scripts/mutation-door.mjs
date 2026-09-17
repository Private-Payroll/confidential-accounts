/**
 * ONE DOOR FOR EVERY MUTATION HARNESS IN THIS PROJECT.
 *
 * A mutation harness breaks a named piece of the product on purpose, runs the
 * tests that are supposed to notice, puts the file back, and scores what
 * happened. There are many of them and they were written by copying one
 * another, so each carried its own copy of three decisions that are not
 * specific to anything it mutates:
 *
 *   * WHETHER IT MAY MUTATE AT ALL. A harness is a script that edits files in
 *     the working tree. Importing one to read its list of mutations used to RUN
 *     it, which is a file edit nobody asked for, against a tree somebody else
 *     may be working in.
 *   * WHETHER A TEST RUN HAPPENED. A run that collects NOTHING still writes a
 *     well-formed report with zero suites, zero tests and zero failures. Asking
 *     `JSON.parse` whether it threw says yes to that report, and zero failures
 *     then reads as *the code was broken and every test still passed* - the
 *     loudest thing a harness can say, about a run in which nothing executed.
 *   * WHICH TESTS A MUTATION WAS ENTITLED TO CLAIM. An entry names the tests it
 *     expects to die. A name that ran and PASSED means the entry credits a
 *     guard that is not watching the binding, whatever else killed the
 *     mutation.
 *
 * All three are here, once. **Every harness beside this file asks them. The
 * wallet's own seven do not yet, and the checker beside these harnesses names
 * exactly which** - a sentence saying *every* one of them would be false today
 * and would stay false quietly.
 *
 * The decisions are exported as ordinary functions with no hidden state, so a
 * test CALLS them rather than matching a sentence inside a script that cannot
 * be run without mutating the tree, which is what a test of these decisions had
 * to do until now. **That does not replace every text match, and the difference
 * is worth stating: whether a harness ASKS the shared question is a property of
 * its own source and is still read as one. What stopped being text is the
 * ANSWER, and the answer is where all three of these defects lived.**
 *
 * NOTHING IN THIS FILE RUNS ON IMPORT: importing it runs no tests, touches no
 * file and exits nothing. **Calling `runSuiteHonestly` does write** - it is the
 * function that runs the tests - and that is the whole of what anything here
 * writes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------- what is a harness --- */

/**
 * WHERE MUTATION HARNESSES LIVE, AND THE ONLY PLACE THAT SAYS SO.
 *
 * The two products in this repository each keep their harnesses beside their
 * own scripts. A list of harness NAMES goes stale the moment somebody adds
 * one and it goes stale silently, so THE DERIVATION WRITES DOWN NO NAME: the
 * names are read off disk, under these directories, every time they are asked
 * for. Lists of harness names do exist - the checker beside these files keeps
 * two, for the harnesses a change has not reached yet - and each of them is
 * held to the tree in BOTH directions, so a name on one after the work lands is
 * red rather than quietly stale. What is gone is a list anything DERIVES
 * from.
 *
 * **THIS LIST OF DIRECTORIES IS ITSELF A LIST AND CAN GO STALE THE SAME WAY.**
 * It is written down rather than derived because a walk of the whole folder
 * would have to know which directories to skip, and that is a list too - a
 * longer one, kept further from the thing it describes. What holds this one
 * true is not this sentence: the checker beside these harnesses sweeps the
 * WHOLE folder and refuses when it finds a harness these directories do not
 * reach.
 */
export const HARNESS_TREES = ['scripts', join('apps', 'wallet', 'scripts')];

/** What a harness is called. The name is the only thing that declares one. */
export const HARNESS_NAME = /^mutate-.*\.mjs$/;

/**
 * EVERY HARNESS IN A TREE, DERIVED, SORTED, AND RELATIVE TO THE ROOT.
 *
 * A directory that is not there yields nothing rather than throwing: one
 * product may be checked out without the other, and a walk that dies on an
 * absent directory turns that into a failure of the harness list.
 */
export function harnessesOnDisk(root, trees = HARNESS_TREES) {
  const out = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const at = join(dir, n);
      let st;
      try { st = statSync(at); } catch { continue; }
      /*
       * SUBDIRECTORIES TOO. A harness one folder down is still a harness, and a
       * walk that stopped at the top would make a subdirectory the one place a
       * harness could be put where nothing looks for it.
       */
      if (st.isDirectory()) { walk(at); continue; }
      if (!st.isFile() || !HARNESS_NAME.test(n)) continue;
      out.push(relative(root, at).split(sep).join('/'));
    }
  };
  for (const tree of trees) walk(join(root, tree));
  return out.sort();
}

/* ------------------------------------------------------- the entrance --- */

/**
 * THE THREE ANSWERS, AND THE THIRD IS THE ONE THAT MATTERS.
 *
 *   `door`     node was pointed at this file. Mutate.
 *   `import`   something imported it. Do nothing at all.
 *   `misfired` node was pointed at a file of this name and the comparison
 *              still said `import`.
 *
 * WITHOUT THE THIRD ANSWER THIS GUARD IS WORSE THAN NO GUARD. The scripts that
 * invoke a harness treat a zero exit as success. A guard that wrongly decides
 * it was imported therefore prints nothing, mutates nothing, measures nothing,
 * exits 0, and is read as a clean run in which every binding was checked -
 * which is the exact failure the harnesses exist to catch, committed by the
 * thing that catches it. So a resolution failure on a path node was plainly
 * given is never allowed to look like an ordinary import.
 *
 * It is a pure function of its arguments so that all three answers can be
 * driven without a process whose entry point is anything in particular.
 */
export function entryPointVerdict(entry, modulePath, realpath = realpathSync) {
  if (typeof entry !== 'string' || entry === '') return 'import';
  try {
    if (realpath(entry) === realpath(modulePath)) return 'door';
  } catch {
    /* Falls through to the name comparison, which is what tells the two apart. */
  }
  return basename(entry) === basename(modulePath) ? 'misfired' : 'import';
}

/** What a harness says when its own entrance could not be established. */
export function theEntranceIsUnreadable(name) {
  return `${name}: node was pointed at a file of this name and this file's entry-point `
    + 'check could not establish whether it was that file, so nothing would have been '
    + 'mutated and nothing measured, while the exit status said the opposite. Nothing '
    + 'was written. What resolves it: invoke this harness by its own path from the '
    + 'repository root, or, if two harnesses share this name, give one of them a name '
    + 'of its own - the check compares the path node was given against this file and '
    + 'needs them to resolve to the same thing.';
}

/**
 * THE ONE LINE EVERY HARNESS ASKS. `true` means mutate; `false` means an import
 * and the harness does nothing; a misfired entrance throws here and never
 * returns, because a harness that cannot tell the two apart must not choose the
 * quiet one.
 */
export function openTheDoor(moduleUrl, argv = process.argv) {
  const modulePath = fileURLToPath(moduleUrl);
  const verdict = entryPointVerdict(argv[1], modulePath);
  if (verdict === 'misfired') throw new Error(theEntranceIsUnreadable(basename(modulePath)));
  return verdict === 'door';
}

/* ----------------------------------------------------- what a run was --- */

/**
 * RUNS THE TESTS AND REPORTS WHAT WAS ACTUALLY COLLECTED, NOT WHAT PARSED.
 *
 * `ran` means ASSERTIONS WERE COLLECTED. `collected` is the number a caller
 * compares against its baseline. `byFile` keeps each assertion's suite file,
 * which is the one thing needed to see a single file go quiet inside a report
 * that otherwise looks normal. `said` keeps the child's own words: when a run
 * refuses to START, that text is the only place the reason exists, and an empty
 * `catch` around it turns a one-glance diagnosis into a day of guessing.
 *
 * `emptyFiles` is the half that never reached `ran` in the copies this
 * replaces: flattening `assertionResults ?? []` hides a file that failed to
 * COLLECT - a broken import, a syntax error, a throw at module scope - inside a
 * report that parses and names it.
 */
export function runSuiteHonestly({
  suites,
  cwd,
  outFile,
  clear = 'remove',
  vitest = './node_modules/.bin/vitest',
}) {
  /*
   * **THE REPORT THIS RUN READS MUST BE THE ONE THIS RUN WROTE, AND A DELETE IS
   * NOT ENOUGH TO PROMISE THAT.** The report is named after the mutation, so
   * the same name is reused on every run, and the only thing binding the file
   * to the run that reads it was the delete below - whose failure was swallowed
   * as *the first run*. Two things make that unsafe and both are recorded in
   * this project: removing a file is REFUSED on the folder these run against,
   * so the delete fails silently and leaves the old report behind; and a test
   * runner that cannot START writes no report at all, leaving whatever was
   * there. Together those score the LAST run's assertions as this one's, and a
   * mutation that was killed a week ago is reported killed today over code
   * nothing watches any more.
   *
   * So the file is cleared and then its ABSENCE IS CHECKED. If it is still
   * there, this run writes where nothing could have written before, and the
   * report it reads is its own by construction rather than by assumption.
   */
  let at = outFile;
  if (clear === 'remove') {
    try { rmSync(at); } catch { /* it may never have existed, or may be undeletable */ }
  }
  /*
   * OUTSIDE THE CLEARING, ON PURPOSE. The clearing is what a caller may turn
   * off; being sure the report is this run's is not, and a check that lived
   * inside the `if` would be a whole protection a caller could skip by passing
   * a different word.
   *
   * **AND THE FALLBACK IS CHECKED TOO**, rather than trusted to be unique
   * because a process id and a millisecond make a collision unlikely. The
   * sentence above claims the report is this run's BY CONSTRUCTION, and one
   * half of it resting on improbability would make that sentence false.
   *
   * **WHAT THIS COSTS, SAID RATHER THAN LEFT TO BE FOUND:** on a folder where
   * removing a file is refused, every suite run leaves one more report behind
   * and nothing here removes it. Sweeping them would be a delete on the folder
   * that refuses deletes, so it would fail silently and the sentence promising
   * it would be the false one. Correct answers that accumulate beat wrong
   * answers that do not, and the growth is named here so it is a known cost.
   */
  for (let n = 0; existsSync(at); n += 1) {
    at = `${outFile}.${process.pid}.${Date.now()}.${n}.json`;
  }
  let said = '';
  try {
    execFileSync(vitest, ['run', ...suites, '--reporter=json', `--outputFile=${at}`],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    /*
     * A failing suite exits non-zero, which is the ordinary case here, so this
     * is not an error path. What it must not do is drop what the child said: on
     * a suite that refused to START, this is the only place the reason exists.
     */
    said = [e?.stderr, e?.stdout].map(b => (b ? String(b) : '')).join('\n');
  }
  let json;
  try { json = JSON.parse(readFileSync(at, 'utf8')); }
  catch {
    return {
      ran: false, collected: 0, emptyFiles: [], byFile: [], titles: [],
      failed: [], passed: 0, failures: 0, said,
      why: 'the test runner wrote no report this run could parse',
    };
  }
  return readTheReport(json, said);
}

/**
 * THE REPORT, READ. Split out from the run so that every shape of report a
 * caller has to survive can be handed in directly and the reading watched.
 */
export function readTheReport(json, said = '') {
  const suites = json?.testResults ?? [];
  const byFile = suites.flatMap(r => (r.assertionResults ?? []).map(a => ({
    file: r.name ?? '(unnamed suite)', title: a.title, status: a.status,
  })));
  const emptyFiles = suites
    .filter(r => (r.assertionResults ?? []).length === 0)
    .map(r => r.name ?? '(unnamed suite)');
  /*
   * A SKIPPED ASSERTION IS NOT ONE THAT RAN. When a `beforeAll` throws, that
   * file's assertions come back `skipped` and the run reports ZERO failures -
   * so a named guard that never executed would otherwise be present in
   * `titles`, be found, and let the mutation be scored a survivor.
   */
  return {
    ran: byFile.length > 0,
    why: byFile.length > 0 ? ''
      : `the test runner wrote a report naming ${suites.length} suite file(s) and NOT ONE assertion`,
    collected: byFile.length,
    emptyFiles,
    byFile,
    said,
    titles: byFile.filter(a => a.status !== 'skipped').map(a => a.title),
    failed: byFile.filter(a => a.status === 'failed').map(a => a.title),
    passed: byFile.filter(a => a.status === 'passed').length,
    failures: byFile.filter(a => a.status === 'failed').length,
  };
}

/* ------------------------------------ a run that measured nothing --- */

/**
 * THE FOUR WAYS A RUN CAN HAVE MEASURED NOTHING, COLLECTED BEFORE ANYTHING IS
 * SAID SO THE REPORT NAMES EVERY REASON IT HAS RATHER THAN THE FIRST.
 *
 *   1. NOTHING AT ALL was collected.
 *   2. FEWER assertions than the baseline. This catches a collapse in a file
 *      no entry names, which 1 and 4 both miss.
 *   3. A SUITE FILE that collected nothing and was not empty at the baseline.
 *   4. A TITLE THE ENTRY NAMES, ABSENT FROM WHAT RAN. Per mutation, so it
 *      survives the case where one file collapses, another gains failures, and
 *      the totals happen to coincide.
 *
 * An empty array means the run measured something and may be scored. A
 * non-empty one means the run measured LESS than it should have, so it is
 * neither a survivor nor a kill and must never be reported as one.
 *
 * **HOW MUCH LESS DEPENDS ON WHICH CHECK FIRED, AND THAT IS WORTH SAYING
 * RATHER THAN LEAVING TO BE FOUND.** Under 1 and 4, nothing about the binding
 * follows in either direction, because the guards that watch it did not
 * execute. Under 2 or 3 ALONE, the named guards may all have run, in which case
 * something does follow and this is reporting a collapse elsewhere. This
 * function reports the collapse rather than settling that question, and a
 * caller that wants the stronger reading has `result.titles` and
 * `result.failures` to ask it with.
 */
export function measuredNothingBecause({ result, baseline, kills = [] }) {
  const collapsed = [];
  if (!result.ran) collapsed.push(`${result.why}`);
  if (baseline && result.collected < baseline.collected) {
    collapsed.push(
      `${result.collected} assertions collected where the baseline collected ${baseline.collected}`);
  }
  const wentQuiet = (result.emptyFiles ?? [])
    .filter(f => !(baseline?.emptyFiles ?? []).includes(f));
  if (wentQuiet.length) {
    collapsed.push(`a suite file collected nothing that collected at the baseline: ${wentQuiet.join(', ')}`);
  }
  const silent = kills.filter(t => !result.titles.includes(t));
  if (silent.length) {
    collapsed.push(`the guard it names did not execute: ${silent.map(t => `"${t}"`).join(', ')}`);
  }
  return collapsed;
}

/* --------------------------------------------- what an entry claimed --- */

/**
 * THE THREE KINDS OF NAME IN A SCORED MUTATION.
 *
 *   `named`   an expected test that died. The claim held.
 *   `missed`  an expected test that ran and PASSED. The entry credits a guard
 *             which is not watching the binding.
 *   `extra`   a test that died and was not expected to.
 *
 * The asymmetry is deliberate: over-claiming is a false statement about what
 * guards the product, under-claiming is extra evidence and is printed rather
 * than counted against anybody.
 */
export function scoreKills(kills, failed) {
  return {
    named: kills.filter(t => failed.includes(t)),
    missed: kills.filter(t => !failed.includes(t)),
    extra: failed.filter(t => !kills.includes(t)),
  };
}

/**
 * THE LAST FEW LINES OF WHATEVER THE TEST RUNNER SAID, for a report a person
 * reads. Empty in, SAID SO out - a missing reason is printed as a missing
 * reason and never as a blank space that reads like nothing happened.
 */
export function tail(said, n = 20) {
  const ls = String(said ?? '').split('\n').map(l => l.trimEnd()).filter(l => l !== '');
  return ls.length ? ls.slice(-n) : ['(the child printed nothing)'];
}
