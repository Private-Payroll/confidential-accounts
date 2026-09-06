#!/usr/bin/env node
/**
 * MUTATING THE THINGS `X10` CLAIMS. `docs/NEXT.md` X10.
 *
 * The harness `scripts/mutate-app-origin.mjs` built for `X1`, aimed at the
 * three claims this round makes that are worth nothing if nothing watches them.
 *
 * **THE REDACTION IS MUTATED ONCE PER PATH, SEPARATELY, AND THE ROUND SAID SO
 * IN AS MANY WORDS.** `X10` §1 sends text to disk down two new routes — the
 * service writing why it refused, and the page keeping a refusal's body beside
 * its status — and each redacts at its own boundary. **One mutation covering
 * both would prove nothing**: break either alone and the other still hides the
 * secret, so a single mutation SURVIVES and proves the opposite of what it
 * looks like it proves. That is the lesson `X4` wrote down when it built this
 * redactor with a layer on each side, and it is why `wrap` deliberately does
 * NOT redact a third time in the middle.
 *
 * **02 IS AN ORDER AND NOT A CALL**, which is the one worth reading. Removing
 * the page's redaction outright would survive — `record` redacts again a line
 * later. What cannot survive is redacting AFTER the length cap: a
 * sixty-four character key cut in half is twenty hex characters, under every
 * threshold the redactor has, and it reaches the wire whole in spirit.
 *
 * FIVE SUITES, and the last is here because it must not become collateral: the
 * screen environment `X10` §3 added is what proves a payroll screen renders at
 * all, and a config change that switches it off silently is exactly the failure
 * `C67` cost the wallet.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-refusals.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SUITES = [
  'src/core/redact-secrets.test.ts',
  'src/server/refusal-log.test.ts',
  'src/server/refusal-both-artefacts.test.ts',
  'src/web/error-sink.test.ts',
  'src/web/wallet-waiting.test.tsx',
];
const OUT = join(ROOT, 'logs', 'mutate-refusals');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'THE SERVICE REDACTS BEFORE A REFUSAL REACHES THE DISK',
    file: 'src/server/refusal-log.ts',
    says: 'the reason is written to REPORT-REFUSALS.txt exactly as it was thrown, so a '
      + 'refusal that quotes a key keeps the key in a file — C157 with C145 taken out '
      + 'of it, and this is the first of the round two new paths to disk',
    from: '  + `                            ${String(kind).slice(0, 40)}: ${redactSecrets(reason)}\\n`;',
    to: '  + `                            ${String(kind).slice(0, 40)}: ${reason}\\n`;',
    kills: [
      'C157: it walks its own report and finds no seed, key or token',
    ],
  },
  {
    id: 2,
    binding: 'THE PAGE REDACTS A REFUSAL BODY BEFORE IT CUTS IT, NOT AFTER',
    file: 'src/web/error-sink.ts',
    says: 'the body is cut to length and redacted afterwards, so a key straddling the '
      + 'cap is posted as a twenty-character fragment that no rule downstream is wide '
      + 'enough to see — C157, and the second of the two new paths',
    from: '  return redactSecrets(text).slice(0, BODY_CHARS);',
    to: '  return text.slice(0, BODY_CHARS);',
    kills: [
      'C157: A SECRET IS REDACTED BEFORE THE BODY IS CUT, NOT AFTER',
    ],
  },
  {
    id: 3,
    binding: 'A RECOVERY PHRASE IS CAUGHT IN ANY CASE',
    file: 'src/core/redact-secrets.ts',
    says: 'the seed-phrase shape goes back to lower case only, so one capitalised word '
      + 'anywhere in twenty-four writes the whole phrase to disk — C148, the hole that '
      + 'had to close before section 1 could send anything anywhere',
    from: "  [/\\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\\b/gi, '<redacted:seed-phrase>'],",
    to: "  [/\\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\\b/g, '<redacted:seed-phrase>'],",
    kills: [
      'C148: a phrase with ONE capitalised word in it, which a phone keyboard produces',
      'C148: and a phrase in capitals, which is the same wallet',
    ],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-REFUSALS.txt');

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

say(`MUTATING WHAT X10 CLAIMS  —  ${new Date().toISOString()}`);
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
