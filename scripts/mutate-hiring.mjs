#!/usr/bin/env node
/**
 * **MUTATING THE ROUND THAT LETS SOMEBODY WHO HAS NOTHING BE HIRED.**
 * `docs/NEXT.md` `X12`, `docs/how-money-can-be-lost.md` `C161`, `C21`,
 * `docs/scope-invitations.md` §5 and §8.
 *
 * `scripts/mutate-invitations.mjs` is `X11`'s and is untouched — it still runs
 * and its eight are still the eight. **This is a second harness rather than
 * eight more entries in that one**, and the reason is `T-7`: a harness that
 * grows without bound is a harness that takes minutes, and one that takes
 * minutes is one nobody runs. Each round's four aim at that round's own
 * bindings and at a suite small enough to run under a minute.
 *
 * THE FOUR, in one line each:
 *
 *   1  the wallet's no-identity path falls through to the ordinary ask, so a
 *      window opened for a request with no wallet in it says nothing and tells
 *      the asking page nothing
 *   2  the confirmation code stops being a code OF THE ADDRESS, so every
 *      comparison an admin ever makes passes
 *   3  an expired invitation is checked only where the offer is SHOWN
 *   4  a revoked invitation is checked only where the offer is SHOWN
 *
 * **IT SPANS BOTH REPOSITORIES**, as `X12` does: two of the four are the
 * wallet's, because what the invitee sees and the code they carry back are
 * both drawn there.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-hiring.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { measuredNothingBecause, openTheDoor, runSuiteHonestly, tail } from './mutation-door.mjs';

const ROOT = process.cwd();
const WALLET = join(ROOT, 'Identity');

/**
 * The suites each repository runs.
 *
 * **THE WALLET RUNS TWO AND THE PAYROLL ONE**, and none of them is a whole
 * suite: `invitations.test.ts` is the doors this round changed, and the two
 * wallet files are the screen a person with nothing sees and the function that
 * renders the code they carry back.
 */
const SUITES = {
  payroll: ['src/server/invitations.test.ts'],
  wallet: ['src/app/approve-no-wallet.test.tsx', 'src/profile/fingerprint.test.ts'],
};
const CWD = { payroll: ROOT, wallet: WALLET };
const OUT = join(ROOT, 'logs', 'mutate-hiring');

/** file (relative to its repo), what it breaks, the exact text, and what must die. */
const MUTATIONS = [
  {
    id: 1,
    repo: 'wallet',
    binding: 'A WINDOW OPENED FOR A REQUEST WITH NO WALLET IN IT HAS WORDS — `X12` §1, `C161`',
    file: 'src/app/app.tsx',
    says: 'the approve route falls back to the ordinary entry screens, which is what it did '
      + 'before this round. Two things break together and only one of them is visible: the '
      + 'person who has just been hired reads a product pitch instead of an answer to the '
      + 'question they were sent here to answer, **and nothing tells the page that opened '
      + 'this window that a wallet is listening** — so its twenty-second ready window '
      + 'expires while they are still reading, and somebody who does exactly what they were '
      + 'asked comes back to an offer that has given up',
    from: '      return (\n'
      + '        <Shell narrow>\n'
      + '          <ApproveEntry phase={phase} entry={entryFor(phase)} />\n'
      + '        </Shell>\n'
      + '      );',
    to: '      return <Shell narrow>{entryFor(phase)}</Shell>;',
    kills: [
      'SAYS SO, AND OFFERS TO MAKE ONE HERE',
      'AND TELLS THE ASKING PAGE A WALLET IS LISTENING, SO THE OFFER IS NOT LOST',
    ],
  },
  {
    id: 2,
    repo: 'wallet',
    binding: 'THE CODE IS A CODE OF THE ADDRESS — `X12` §2, `C21`',
    file: 'src/profile/fingerprint.ts',
    says: 'the code stops depending on the address it is about, so every address renders the '
      + 'same twenty characters. **Every comparison an admin ever makes then passes**, on '
      + 'every screen, for ever — including the one where a page substituted the address a '
      + 'salary is paid to, which is the single thing this control exists to catch. Nothing '
      + 'else in the product changes shape: the screens still show two codes and they still '
      + 'agree',
    from: '  return render(RECEIVING_ADDRESS_LABEL, address.toLowerCase());',
    to: "  return render(RECEIVING_ADDRESS_LABEL, '');",
    kills: ['TWO DIFFERENT ADDRESSES NEVER RENDER THE SAME CODE'],
  },
  {
    id: 3,
    repo: 'payroll',
    binding: 'AN EXPIRED INVITATION IS REFUSED WHERE THE OFFER IS READ — `X12` §3, §8',
    file: 'src/core/payroll.ts',
    says: 'the deadline stops being enforced at the doors and survives only wherever a screen '
      + 'chooses to honour it. **A stale link still opens an offer and still spends it** — '
      + 'and a link is a bearer credential sitting in a chat history, which is the whole of '
      + 'why §8 says an offer that never expires is a salary waiting for whoever eventually '
      + 'finds it',
    from: '    if (!invite.expiresAt || Date.parse(invite.expiresAt) <= Date.now()) {',
    to: '    if (false) {',
    kills: ['AN EXPIRED INVITATION CAN NEITHER BE OPENED NOR ACCEPTED'],
  },
  {
    id: 4,
    repo: 'payroll',
    binding: 'AND SO IS A REVOKED ONE — `X12` §3, §8',
    file: 'src/core/payroll.ts',
    says: 'taking an invitation back stops meaning anything behind the screen that offers it. '
      + 'The admin presses revoke, the row says so, and the link keeps working: whoever holds '
      + 'it can still set the address a salary is paid to, which is the state §8 was written '
      + 'against',
    from: '    if (invite.revokedAt) {\n      throw new Error(',
    to: '    if (false) {\n      throw new Error(',
    kills: ['A REVOKED INVITATION CAN NEITHER BE OPENED NOR ACCEPTED'],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-HIRING.txt');

/** Runs one repository's suites and returns the titles that failed, plus counts. */
function runSuite(repo, tag) {
  return runSuiteHonestly({
    suites: SUITES[repo], cwd: CWD[repo], outFile: join(OUT, `${repo}-${tag}.json`),
  });
}

/*
 * **A KILLED RUN PUTS THE FILE BACK, AND IT DOES NOT RELY ON A SIGNAL.** The
 * argument is `scripts/mutate-self-payee.mjs`'s in full and it was paid for
 * twice: `execFileSync` BLOCKS THE EVENT LOOP, so a `SIGTERM` arriving mid-suite
 * cannot be serviced until the call it would have interrupted has finished, and
 * a `SIGKILL` never reaches JavaScript at all. This harness runs under a
 * 45-second call cap, so being killed part way through is the ORDINARY case. The record of what is in flight therefore lives ON DISK.
 */
const JOURNAL = join(OUT, 'in-flight.json');
const beginMutation = (path, before) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify({ path, before }));
};
/* CLEARED, NOT DELETED: `rm` is refused on a mounted folder, and a
 * swallowed failure there left the journal behind after a good run and made the
 * next one announce a recovery that had not happened. */
const endMutation = (path, before) => {
  writeFileSync(path, before);
  writeFileSync(JOURNAL, '{}');
};
function recoverFromLastRun(say) {
  let held;
  try { held = JSON.parse(readFileSync(JOURNAL, 'utf8')); } catch { return; }
  if (!held?.path || typeof held.before !== 'string') return;
  writeFileSync(held.path, held.before);
  writeFileSync(JOURNAL, '{}');
  say('  A PREVIOUS RUN WAS KILLED WITH A MUTATION STILL IN THE TREE.');
  say(`  ${held.path} has been put back before anything else was done.`);
  say('');
}

function main() {
  mkdirSync(OUT, { recursive: true });

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  say(`MUTATING THE HIRING ROUND  —  ${new Date().toISOString()}`);
  for (const [repo, suites] of Object.entries(SUITES)) {
    for (const s of suites) say(`suite (${repo}): ${s}`);
  }
  say('');

  recoverFromLastRun(say);

  /** Baselines, taken lazily so a `--only` run does not pay for both repositories. */
  const baselines = {};
  function baselineFor(repo) {
    if (baselines[repo]) return baselines[repo];
    const clean = runSuite(repo, 'baseline');
    if (!clean.ran) {
      say(`  THE ${repo.toUpperCase()} SUITES DID NOT RUN AT ALL. Nothing below means anything.`);
    } else if (clean.failures > 0) {
      say(`  THE ${repo.toUpperCase()} SUITE IS RED BEFORE ANY MUTATION. A mutation cannot be`);
      say('  judged against a suite that is already failing.');
      for (const t of clean.failed) say(`    - ${t}`);
    } else {
      say(`baseline (${repo}): ${clean.failures} failed | ${clean.passed} passed`);
    }
    baselines[repo] = clean;
    return clean;
  }

  let survived = 0;
  let stale = 0;
  let notRun = 0;
  let aborted = false;
  let judged = 0;

  for (const m of MUTATIONS) {
    if (wanted && !wanted.has(m.id)) continue;
    const clean = baselineFor(m.repo);
    if (!clean.ran || clean.failures > 0) { stale += 1; continue; }
    const known = new Set(clean.titles);

    const path = join(CWD[m.repo], m.file);
    const before = readFileSync(path, 'utf8');
    const hits = before.split(m.from).length - 1;

    say(`${String(m.id).padStart(2, '0')}  [${m.repo}] ${m.binding}`);
    say(`    breaks: ${m.says}`);

    if (hits === 0) {
      say('    STALE MUTATION — that text is not in the file any more. NOT RUN.');
      say(`      ${m.file}: ${m.from.trim().slice(0, 120)}`);
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
    let result;
    try {
      writeFileSync(path, before.replace(m.from, m.to));
      result = runSuite(m.repo, `mutation-${m.id}`);
    } finally {
      endMutation(path, before);
    }
    judged += 1;

    /*
     * A RUN THAT COLLECTED NOTHING IS NOT A SURVIVOR AND IS NOT A KILL. The four
     * ways it can happen are asked together in `scripts/mutation-door.mjs`, so
     * every harness here answers the question the same way and none of them can
     * drift away from it quietly.
     */
    const collapsed = measuredNothingBecause({ result, baseline: clean, kills: m.kills });

    if (collapsed.length) {
      say('    NOT RUN. The mutation was applied and the run measured NOTHING here.');
      say('    This is not a survivor and it is not a kill: it says nothing whatever');
      say('    about the binding, because nothing executed to say it.');
    /*
     * UNLESS THE NAMED GUARDS DID RUN, in which case that last sentence is not
     * true of this entry and saying it anyway is the kind of false line these
     * harnesses exist to catch. Checks 2 and 3 fire on a collapse ANYWHERE in
     * the run, which can happen while the guards this entry names executed
     * normally. Nothing here is graded differently: no counter moves, the exit
     * status is unchanged, and the outcome is still RAN AND MEASURED NOTHING.
     * What changes is that the report stops claiming more than it knows.
     */
    if (m.kills.length && m.kills.every(k => result.titles.includes(k))) {
      say('    EXCEPT THAT THE GUARD(S) THIS ENTRY NAMES DID EXECUTE, and');
      say(`    ${result.failed.some(x => m.kills.includes(x)) ? 'at least one of them FAILED' : 'every one of them PASSED'}.`);
      say('    So the collapse above is somewhere else in the run, and this');
      say('    entry is worth reading rather than dismissing.');
    }
      for (const c of collapsed) say(`      - ${c}`);
      if (result.failed.length) {
        say(`    ${result.failed.length} test(s) DID go red under it, and they are evidence even`);
        say('    though the run as a whole measured less than it should have:');
        for (const t of result.failed) say(`      ${m.kills.includes(t) ? '✓' : '+'} ${t}`);
      }
      say('    the last thing the test runner said, which is where the reason is:');
      for (const l of tail(result.said)) say(`      ${l}`);
      notRun += 1;

      /*
       * WHICH KIND OF COLLAPSE IT WAS, MEASURED RATHER THAN GUESSED. The tree is
       * already restored, so one more run answers it: a RESTORED tree that still
       * collects nothing has something wrong with it that is not this mutation's
       * and will stop the next one too, so the rest of the corpus cannot be
       * scored. A restored tree that collects normally means the collapse was
       * this mutation's own doing and every entry after it still means something.
       */
      const recheck = runSuite(m.repo, `recheck-${m.id}`);
      if (!recheck.ran || recheck.collected < clean.collected) {
        say('');
        say('    AND THE TREE IS BACK AND THE SUITE STILL DOES NOT RUN. Whatever');
        say('    stopped it is not this mutation, so it will stop the next one too.');
        say('    ABORTING rather than scoring nothing.');
        say('    the last thing the recheck said:');
        for (const l of tail(recheck.said)) say(`      ${l}`);
        aborted = true;
        say('');
        break;
      }
      say(`    The restored tree runs (${recheck.collected} collected), so the collapse is`);
      say('    this mutation\'s own doing and the entries after it still mean something.');
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
  say(`${judged} JUDGED — a mutation went in and the run measured what happened.`);
  /*
   * FOUR STATES, FOUR LINES, NEVER ONE SENTENCE. A reader takes the SURVIVOR
   * count away, because *survivor* is the word this harness attaches "hole" to.
   * They are different failures with different fixes, so each gets its own line
   * and says what it is.
   */
  say(`${survived} SURVIVED — the code was broken and nothing noticed. A hole in the product.`);
  say(`${stale} COULD NOT BE APPLIED — a mutation aimed at code that has moved. The`);
  say('   binding has been unguarded since the day it moved, which is a hole in this');
  say('   instrument that looks exactly like a passing check.');
  say(`${notRun} RAN AND MEASURED NOTHING — the mutation went in and no assertion came`);
  say('   back. This says nothing about the product in either direction.');
  if (aborted) {
    say('');
    say('AND THE RUN STOPPED EARLY. Every entry after the last one above was never');
    say('scored, and this report does not describe them.');
  }
  say('');
  say(survived + stale + notRun === 0 && !aborted
    ? 'Every binding has a test that notices when it is broken.'
    : 'Read the entries above. THE THREE NUMBERS ARE THREE DIFFERENT FAILURES, and'
      + ' only the first is about the product. The other two are about this harness.');
  writeFileSync(reportAt, lines.join('\n') + '\n');
  console.log(`\nwritten to ${reportAt}`);
  process.exit(survived + stale + notRun === 0 && !aborted ? 0 : 1);
}

/*
 * THE CORPUS IS READABLE WITHOUT RUNNING ANYTHING, and it is exported HERE
 * rather than on its declaration for a reason worth keeping: the module-graph
 * scan reads `export` at column zero and runs to the first `from '...'` before a
 * semicolon, and several of these entries hold the TEXT of an import as data. On
 * the declaration it would put a module edge into a generated document for a
 * dependency this file does not have. Measured: one, and it is gone.
 */
export { MUTATIONS };

/*
 * ONE ENTRANCE, SHARED. `openTheDoor` answers three ways rather than two: node
 * pointed at this file MUTATES; an import does nothing at all, so reading this
 * harness's list of mutations costs a tree nothing; and an entrance that cannot
 * be resolved REFUSES, because the alternative is exiting 0 having mutated
 * nothing and measured nothing, which every script that invokes a harness reads
 * as a clean run in which every binding was checked.
 */
if (openTheDoor(import.meta.url)) main();
