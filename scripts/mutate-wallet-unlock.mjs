#!/usr/bin/env node
/**
 * MUTATING THE WALLET UNLOCK, ONE BINDING AT A TIME. `docs/NEXT.md` PI2a.
 *
 * The same harness `scripts/mutate-wallet-sign-in.mjs` built for `PI1`, aimed
 * at the round that follows it: the company a page may open, and the release it
 * is allowed to believe. **A test that has never been watched failing is a test
 * nobody knows the shape of**, and every assertion named here was written
 * before its mutation.
 *
 * TWO SUITES, NOT ONE, and that is what the round needed. §2's rule lives at a
 * ROUTE — it is about what arrives in a request — so the test that proves it
 * has to drive real HTTP; the rest is core and browser code with no server in
 * it. Both run for every mutation, so a mutation that happens to be caught by
 * the other half is reported rather than missed.
 *
 * THREE REFUSALS IT MAKES, ALL THREE BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *     Silently skipping it is indistinguishable from it passing, which is `T-7`.
 *   · **ambiguous target** — the text appears more than once, so which copy was
 *     broken is unknown.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-wallet-unlock.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { measuredNothingBecause, openTheDoor, runSuiteHonestly, tail } from './mutation-door.mjs';

const ROOT = process.cwd();
const SUITES = ['src/core/wallet-unlock.test.ts', 'src/server/unlock-company.test.ts'];
const OUT = join(ROOT, 'logs', 'mutate-unlock');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'THE COMPANY COMES FROM THE SESSION — §2, AND IT IS THE ONE THAT MATTERS',
    file: 'src/server/index.ts',
    says: 'the company is reachable from the request body',
    from: '    const company = companyForSession(store, req.userId!, String(req.params.id));',
    to: '    const company = String((req.body as { company?: unknown })?.company '
      + '?? companyForSession(store, req.userId!, String(req.params.id)));',
    kills: ['A CALLER THAT NAMES ITS OWN COMPANY IS NOT SERVED — the session decides'],
  },
  {
    id: 2,
    binding: 'AND NOT FROM A QUERY STRING EITHER',
    file: 'src/server/index.ts',
    says: 'the company is reachable from the query string',
    from: '    const company = companyForSession(store, req.userId!, String(req.params.id));',
    to: '    const company = String(req.query.company '
      + '?? companyForSession(store, req.userId!, String(req.params.id)));',
    kills: ['and it is not served from a query string either'],
  },
  {
    id: 3,
    binding: 'THE LOOKUP HAS ITS OWN MEMBERSHIP DOOR',
    file: 'src/core/company-address.ts',
    says: 'the lookup trusts the middleware and checks nothing itself',
    from: '  if (!rec || !rec.memberUserIds.includes(userId)) {',
    to: '  if (!rec) {',
    kills: ['SOMEBODY ELSE\'S COMPANY IS NOT FOUND, AND SO IS A COMPANY THAT DOES NOT EXIST'],
  },
  {
    id: 4,
    binding: 'A COMPANY WITH NO ADDRESS IS REFUSED, NOT SUBSTITUTED FOR',
    file: 'src/core/company-address.ts',
    says: 'a company with no address on any chain is served anyway',
    from: '  if (typeof address !== \'string\' || !COMPANY_ADDRESS.test(address)) {',
    to: '  if (false) {',
    kills: ['A COMPANY WITH NO ADDRESS REFUSES BY NAME RATHER THAN SUBSTITUTING ONE'],
  },
  {
    id: 5,
    binding: 'THE RELEASE IS CHECKED AGAINST THE COMPANY WE ASKED ABOUT',
    file: 'src/web/wallet-unlock.ts',
    says: 'the company is read out of the message being judged',
    from: '    forCompany: ask.company,',
    to: '    forCompany: String((answer as { company?: string }).company),',
    kills: ['A RELEASE FOR A DIFFERENT COMPANY IS REFUSED RATHER THAN USED'],
  },
  {
    id: 6,
    binding: 'THE RELEASE IS CHECKED AGAINST OUR OWN ORIGIN',
    file: 'src/web/wallet-unlock.ts',
    says: 'the origin is read out of the message being judged',
    from: '    atOrigin: ask.atOrigin,',
    to: '    atOrigin: String((answer as { origin?: string }).origin),',
    kills: ['A RELEASE MINTED FOR ANOTHER PAYROLL IS REFUSED HERE'],
  },
  {
    id: 7,
    binding: 'THE NONCE IS THE ONE THIS PAGE GENERATED',
    file: 'src/web/wallet-unlock.ts',
    says: 'the nonce is checked against itself',
    from: '    expectingNonce: nonce,',
    to: '    expectingNonce: String((answer as { nonce?: string }).nonce),',
    kills: ['A RELEASE ANSWERING AN EARLIER QUESTION IS REFUSED'],
  },
  {
    id: 8,
    binding: 'A REFUSED RELEASE IS NOT USED',
    file: 'src/web/wallet-unlock.ts',
    says: 'the reader’s verdict is ignored',
    from: '  if (!read.ok) throw new UnlockRefused(read.code, read.says);',
    to: '  if (false) throw new UnlockRefused(read.code, read.says);',
    kills: [
      'A RELEASE FOR A DIFFERENT COMPANY IS REFUSED RATHER THAN USED',
      'A RELEASE ANSWERING AN EARLIER QUESTION IS REFUSED',
      'A RELEASE MINTED FOR ANOTHER PAYROLL IS REFUSED HERE',
      'and something that is not a release at all is refused by name',
    ],
  },
  {
    id: 9,
    binding: 'THE ADDRESS SURVIVES A RE-SEAL',
    file: 'src/core/account.ts',
    says: 'the stored address is dropped every time the account is written back',
    from: '    contractAddress: account.contractAddress ?? null,',
    to: '    contractAddress: null,',
    kills: ['THE ADDRESS SURVIVES A RE-SEAL — losing it would be losing the data'],
  },
  {
    id: 10,
    binding: 'THE ADDRESS IS THE LEDGER’S AND IS NOT MINTED HERE',
    /*
     * **RE-AIMED, NOT DELETED.** `UNLOCK-CHECK` reported this one as
     * `NOT RUN` — `PI2b` refactored the line it named eight days ago, when the
     * ledger started answering with the address AND where it came from, so the
     * text it searched for stopped existing and the mutation stopped running.
     * **`not run` is a failure, not a pass**, and the eight days it was quiet
     * are eight days this binding had no test that anyone had watched fail.
     *
     * **WHAT THE LINE IT GUARDS IS FOR.** `src/core/account.ts:344` is the one
     * moment a company's identity is READ from the ledger that assigned it,
     * rather than minted on this side — and it is read once and written down
     * immediately, because the simulated ledger holds its whole world in memory
     * and would answer differently after a restart. **That address is what the
     * key opening this company's records is derived from**, on every
     * client, for as long as the company exists. An address invented here would
     * derive a key no chain will ever match, identically and repeatably, and
     * everything sealed under it would be unopenable by anything but this
     * process — which is `C127` arriving by the door `C136` was built to close.
     *
     * The replacement now also lies about the PROVENANCE, which the old one
     * could not: `PI2b` made the two travel in one value, so a
     * mutation that mints an address mints its source with it.
     */
    file: 'src/core/account.ts',
    says: 'the address is invented on this side instead of read from the ledger — and '
      + 'claims a chain assigned it',
    from: '    const assigned = await this.ledger.address(account.id);',
    to: '    const assigned = { value: \'ac\'.repeat(32), source: \'chain\' };',
    kills: ['THE ADDRESS IS THE LEDGER\'S OWN, NOT ONE MINTED ON THIS SIDE'],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'REPORT-MUTATE-UNLOCK.txt');

/** Runs both suites and returns the titles that failed, plus the two counts. */
function runSuite(tag) {
  return runSuiteHonestly({ suites: SUITES, cwd: ROOT, outFile: join(OUT, `${tag}.json`) });
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

const beginMutation = (path, before, after) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify({ path, before }));
  writeFileSync(path, after);
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
function main() {
  mkdirSync(OUT, { recursive: true });

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  say(`MUTATING THE WALLET UNLOCK  —  ${new Date().toISOString()}`);
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
  let notRun = 0;
  let aborted = false;

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

    /* `X8` — the on-disk journal, taken from `Identity/scripts/mutate-origin.mjs`
     * where it was paid for twice. This harness runs under a 45-second call cap,
     * so being killed part way through is the ORDINARY case
     * — and a `finally` cannot help, because `runSuite` blocks the event loop. */
    beginMutation(path, before, before.replace(m.from, m.to));
    let result;
    try {
      result = runSuite(`mutation-${m.id}`);
    } finally {
      endMutation(path, before);
    }

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
      const recheck = runSuite(`recheck-${m.id}`);
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
