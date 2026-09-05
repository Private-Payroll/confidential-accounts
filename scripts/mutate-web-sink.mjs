#!/usr/bin/env node
/**
 * MUTATING THE BROWSER ERROR SINK. `docs/NEXT.md` X4.
 *
 * The harness `scripts/mutate-app-origin.mjs` built for `X1`, aimed at the two
 * claims this round makes that are worth nothing if nothing watches them:
 *
 *   · **a production build does not contain the sink at all** — the rule the
 *     round was told to mutate by name.
 *   · **nothing this project keeps on disk ever contains a seed** — `C145`, and
 *     the row says in as many words that a test which greps its own logs is
 *     what closes it.
 *
 * **THE REDACTION IS MUTATED TWICE, ONCE PER LAYER, ON PURPOSE.** The page
 * redacts before the text crosses the wire and the service redacts again before
 * it reaches the disk. Two layers is the right design and it is also a trap for
 * a mutation harness: break either one alone and the other still hides the
 * secret, so a single mutation would SURVIVE and prove the opposite of what it
 * looks like it proves. Each layer therefore has its own mutation and its own
 * test, exercising that layer by itself.
 *
 * FIVE SUITES, and the last two are here because they must not become
 * collateral: the redactor's own cases, and the report format that has to tell
 * an empty page apart from a broken one.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-web-sink.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SUITES = [
  'src/web/sink-not-in-production.test.ts',
  'src/web/error-sink.test.ts',
  'src/server/web-console-sink.test.ts',
  'src/core/redact-secrets.test.ts',
  'scripts/web-check-observe.test.ts',
];
const OUT = join(ROOT, 'logs', 'mutate-web-sink');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'A PRODUCTION BUILD DOES NOT CONTAIN THE SINK AT ALL',
    file: 'src/web/error-sink.ts',
    says: 'the guard stops asking whether this is a development build, so a production '
      + 'build ships an unauthenticated error reporter to every customer — X4 §1, rule 1',
    from: "const ARMED = import.meta.env.DEV && import.meta.env.VITE_DEV_ERROR_SINK === '1';",
    to: "const ARMED = import.meta.env.VITE_DEV_ERROR_SINK === '1';",
    kills: [
      'THE ONE THAT SAYS IT SHIPS NOTHING: a production bundle contains none of it',
    ],
  },
  {
    id: 2,
    binding: 'THE PAGE REDACTS BEFORE ANYTHING CROSSES THE WIRE',
    file: 'src/web/error-sink.ts',
    says: 'a message is posted as the browser produced it, so a seed in an exception '
      + 'reaches the service in plain text — C145, the first of the two layers',
    from: '        message: redactSecrets(asText(message)),',
    to: '        message: asText(message),',
    kills: [
      'THE ONE C145 ASKS OF THE PAGE: nothing shaped like a secret crosses the wire',
    ],
  },
  {
    id: 3,
    binding: 'THE SERVICE REDACTS BEFORE ANYTHING REACHES THE DISK',
    file: 'src/server/web-console-log.ts',
    says: 'the report is written as it arrived, so a seed that reached the service is '
      + 'kept in a file — C145, and this is the layer the row is actually about',
    from: '    lines.push(`  ${String(entry.level).slice(0, 20).padEnd(14)} ${redactSecrets(entry.message)}`);',
    to: '    lines.push(`  ${String(entry.level).slice(0, 20).padEnd(14)} ${entry.message}`);',
    kills: [
      'THE ONE C145 ASKS FOR: it walks its own report and finds no seed, key or token',
    ],
  },
  {
    id: 4,
    binding: 'THE SINK OBSERVES AND RE-THROWS, AND SWALLOWS NOTHING',
    file: 'src/web/error-sink.ts',
    says: 'a fetch that failed is answered with a fake success, so the screen fails '
      + 'silently and the report says everything is fine — X4 §1, rule 3',
    from: '      throw failure;',
    to: '      return { ok: true, status: 200 };',
    kills: [
      'THE ONE THAT SAYS IT SWALLOWS NOTHING: a rejected fetch is re-thrown, unchanged',
    ],
  },
  {
    id: 5,
    binding: 'THE ORIGINAL CONSOLE IS ALWAYS CALLED',
    file: 'src/web/error-sink.ts',
    says: 'console.error is recorded instead of being passed on, so watching the app '
      + 'silences it — the sink changing what the app does, X4 §1, rule 3',
    from: "    record('console.error', args.map(asText).join(' '));\n    originalError(...args);",
    to: "    record('console.error', args.map(asText).join(' '));",
    kills: [
      'THE ONE THAT SAYS IT CHANGES NOTHING: the original console is always called',
    ],
  },
  {
    id: 6,
    binding: 'THE ROUTE EXISTS ONLY WHERE THE RELAXATION IS DECLARED',
    file: 'src/server/index.ts',
    says: 'the sink route is registered whatever the deployment said, so any page on '
      + 'the machine can write to a file on a server nobody relaxed — C140',
    from: 'if (WEB_CONSOLE_SINK) {\n  const webConsolePost',
    to: 'if (true) {\n  const webConsolePost',
    kills: [
      'THE ONE THAT KEEPS IT OUT OF A DEPLOYMENT: without the relaxation the route is not there',
    ],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-WEB-SINK.txt');

mkdirSync(OUT, { recursive: true });

/** Runs both suites and returns the titles that failed, plus the two counts. */
function runSuite(tag) {
  const file = join(OUT, `${tag}.json`);
  try { rmSync(file); } catch { /* first run */ }
  try {
    execFileSync('./node_modules/.bin/vitest',
      ['run', ...SUITES, '--reporter=json', `--outputFile=${file}`],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* a failing suite exits non-zero, which is the ordinary case here */ }
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { ran: false, failed: [], passed: 0, failures: 0, titles: [] }; }
  const assertions = json.testResults.flatMap(r => r.assertionResults ?? []);
  return {
    ran: true,
    titles: assertions.map(a => a.title),
    failed: assertions.filter(a => a.status === 'failed').map(a => a.title),
    passed: assertions.filter(a => a.status === 'passed').length,
    failures: assertions.filter(a => a.status === 'failed').length,
  };
}

/*
 * **A KILLED RUN PUTS THE FILE BACK, AND IT DOES NOT RELY ON A SIGNAL.**
 * Found the hard way, PI2b, twice.
 *
 * The mutation is written to disk, the suite runs, and a `finally` restores it.
 * **Neither a `finally` nor a signal handler is any use here**, and the second
 * one is the trap: `runSuite` uses `execFileSync`, which BLOCKS THE EVENT LOOP,
 * so a `SIGTERM` arriving mid-suite is queued and cannot be serviced until the
 * call it would have interrupted has already finished. A `SIGKILL` is never
 * delivered to JavaScript at all. This harness runs under a 45-second
 * call cap, so being killed part way through is the ORDINARY case, not the
 * exotic one.
 *
 * It happened here. A timeout landed between the write and the restore and left
 * `src/core/company-address.ts` holding `if (false)` — **a disarmed guard, in a
 * working tree, that compiles and typechecks and is indistinguishable from one
 * that was never written.** The first fix was signal handlers; they did not
 * work, for the reason above, and it happened a second time.
 *
 * So the record of what is in flight lives ON DISK, written before the mutation
 * and deleted after the restore. Nothing has to survive for it to work: the
 * NEXT run reads it, puts the file back and says so before doing anything else.
 * The window in which a tree can be left mutated is now bounded by "until
 * somebody runs this again", and it announces itself rather than being found by
 * grep.
 */
const JOURNAL = join(OUT, 'in-flight.json');

const beginMutation = (path, before) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify({ path, before }));
};

/*
 * **CLEARED, NOT DELETED, AND THAT IS NOT FUSSiness.** Found in PI2b.
 *
 * `rm` is REFUSED on the mounted folder this runs against, so the
 * `rmSync` this first used failed, was swallowed by its own `catch`, and left
 * the journal behind after a perfectly successful run — which made the next run
 * announce a recovery that had not happened. **A warning that fires every time
 * is a warning nobody reads**, which would have cost more than the bug it was
 * written for. Writing an empty record needs no delete permission anywhere.
 */
const endMutation = (path, before) => {
  writeFileSync(path, before);
  writeFileSync(JOURNAL, '{}');
};

/** Puts back whatever a previous run was killed in the middle of. */
function recoverFromLastRun(say) {
  let held;
  try { held = JSON.parse(readFileSync(JOURNAL, "utf8")); } catch { return; }
  if (!held?.path || typeof held.before !== "string") return;
  writeFileSync(held.path, held.before);
  writeFileSync(JOURNAL, '{}');
  say(`  A PREVIOUS RUN WAS KILLED WITH A MUTATION STILL IN THE TREE.`);
  say(`  ${held.path} has been put back before anything else was done.`);
  say("");
}
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

say(`MUTATING THE BROWSER ERROR SINK  —  ${new Date().toISOString()}`);
for (const s of SUITES) say(`suite: ${s}`);
say('');

recoverFromLastRun(say);

const clean = runSuite('baseline');
if (!clean.ran) {
  say('  THE SUITES DID NOT RUN AT ALL. Nothing below means anything.');
  writeFileSync(reportAt, lines.join('\n') + '\n');
  process.exit(1);
}
say(`baseline: ${clean.failures} failed | ${clean.passed} passed`);
if (clean.failures > 0) {
  say('');
  say('  THE SUITE IS RED BEFORE ANY MUTATION. A mutation cannot be judged against');
  say('  a suite that is already failing, so nothing was run.');
  for (const t of clean.failed) say(`    - ${t}`);
  writeFileSync(reportAt, lines.join('\n') + '\n');
  process.exit(1);
}
say('');

const known = new Set(clean.titles);
let survived = 0;
let stale = 0;

for (const m of MUTATIONS) {
  if (wanted && !wanted.has(m.id)) continue;
  const path = join(ROOT, m.file);
  const before = readFileSync(path, 'utf8');
  const hits = before.split(m.from).length - 1;

  say(`${String(m.id).padStart(2, '0')}  ${m.binding}`);
  say(`    breaks: ${m.says}`);

  if (hits === 0) {
    say('    STALE MUTATION — that text is not in the file any more. NOT RUN.');
    say(`      ${m.file}: ${m.from.trim()}`);
    say('');
    stale += 1;
    continue;
  }
  if (hits > 1) {
    say(`    AMBIGUOUS TARGET — that text appears ${hits} times, so which copy was`);
    say('    broken is unknown. NOT RUN.');
    say('');
    stale += 1;
    continue;
  }
  const missing = m.kills.filter(t => !known.has(t));
  if (missing.length) {
    say('    STALE EXPECTATION — it names a test that is not in the suite:');
    for (const t of missing) say(`      "${t}"`);
    say('');
    stale += 1;
    continue;
  }

  beginMutation(path, before);
  writeFileSync(path, before.replace(m.from, m.to));
  let result;
  try {
    result = runSuite(`mutation-${m.id}`);
  } finally {
    endMutation(path, before);
  }

  if (!result.ran) {
    say('    THE SUITE DID NOT RUN under this mutation. Treated as SURVIVED.');
    survived += 1;
  } else if (result.failures === 0) {
    say('    SURVIVED. The code was broken and every test still passed —');
    say('    nothing is watching this binding.');
    survived += 1;
  } else {
    const named = m.kills.filter(t => result.failed.includes(t));
    const extra = result.failed.filter(t => !m.kills.includes(t));
    say(`    KILLED by ${result.failed.length} test${result.failed.length === 1 ? '' : 's'}:`);
    for (const t of named) say(`      ✓ ${t}`);
    for (const t of m.kills.filter(x => !named.includes(x))) {
      say(`      ! EXPECTED TO DIE AND DID NOT: ${t}`);
    }
    for (const t of extra) say(`      + also: ${t}`);
    if (named.length === 0) {
      say('    NAMED NO TEST THAT ACTUALLY DIED. The mutation is killed, but by');
      say('    something other than the assertion written for it — worth reading.');
    }
  }
  say('');
}

say('-----------------------------------------------------------------------');
say(`${survived} survived, ${stale} not run.`);
say(survived === 0 && stale === 0
  ? 'Every binding has a test that notices when it is broken.'
  : 'Read the entries above. A survivor is a hole; a stale one is a mutation'
    + ' aimed at code that has moved.');
writeFileSync(reportAt, lines.join('\n') + '\n');
console.log(`\nwritten to ${reportAt}`);
process.exit(survived + stale === 0 ? 0 : 1);
