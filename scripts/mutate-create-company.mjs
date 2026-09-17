#!/usr/bin/env node
/**
 * MUTATING THE COMPANY CREATION PATH. `docs/NEXT.md` PI3.
 *
 * The harness `scripts/mutate-wallet-unlock.mjs` built for `PI2a`, aimed at the
 * round that follows it: **whether the system can tell where a company's
 * address came from**, and **whether the key that opens a person's
 * payslips is derived or minted**.
 *
 * THREE SUITES. `C140`'s assertions are core; `C135`'s are core; and
 * `core.test.ts` is included because **it is where the payslip-sealing
 * guarantee lives and this round did not touch it.** A mutation to the
 * derivation that made a payslip readable by the wrong person should be caught
 * by tests written long before this round, and running them here is how that is
 * shown rather than hoped.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-payslip-key.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { measuredNothingBecause, openTheDoor, runSuiteHonestly, tail } from './mutation-door.mjs';

const ROOT = process.cwd();
const SUITES = [
  'src/core/create-company.test.ts',
  'src/core/wallet-unlock.test.ts',
];
const OUT = join(ROOT, 'logs', 'mutate-create-company');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'THE KEY A PERSON\'S KEYS ARE SAVED UNDER IS ASKED FOR THIS PERSON',
    file: 'src/web/keyring.ts',
    says: 'the wallet is asked for the keys of a person the session does not name, so what is '
      + 'saved is sealed under a key for somebody else',
    from: '    person: who.id,',
    to: "    person: 'usr_somebody',",
    kills: [
      'THE WALLET IS ASKED ONCE, FOR THIS PERSON AND THE ADDRESS THEY SIGNED IN AS, BEFORE THE COMPANY IS CREATED',
    ],
  },
  {
    id: 2,
    binding: 'A SECOND COMPANY\'S KEYS ARE SAVED BESIDE THE FIRST\'S, NEVER OVER THEM',
    file: 'src/web/keyring.ts',
    says: 'saving a new company\'s keys writes only that company, so every key already saved '
      + 'for the person, blindings included, is written over',
    from: '  await putBundle({ ...keyring, accounts: { ...keyring.accounts, [accountId]: keys } });',
    to: '  await putBundle({ ...keyring, accounts: { [accountId]: keys } });',
    kills: [
      "THE SAME TAB STARTS A SECOND COMPANY WITHOUT ASKING THE WALLET, AND BOTH COMPANIES' KEYS ARE SAVED TOGETHER",
    ],
  },
  {
    id: 3,
    binding: 'IT MAY NOT ASK FOR A PASSWORD',
    file: 'src/web/keyring.ts',
    says: 'the creation path carries auth material, which is what asking for a password '
      + 'looks like on the wire',
    from: "    body: JSON.stringify({ name: spec.name, signers: spec.signers, "
      + "threshold: spec.threshold }),",
    to: "    body: JSON.stringify({ name: spec.name, signers: spec.signers, "
      + "threshold: spec.threshold, authKey: 'aa'.repeat(32) }),",
    kills: [
      'NOT ONE REQUEST CARRIES AUTH MATERIAL',
    ],
  },
  {
    id: 4,
    binding: 'THE FOUNDER\'S FIRST DEVICE IS NOT SPECIAL',
    file: 'src/web/keyring.ts',
    says: 'the keys are sealed under a key this tab minted rather than the one the wallet '
      + 'gave, so nothing else can ever work it out again',
    from: '      keyBundle: seal(JSON.stringify(next), key),',
    to: "      keyBundle: seal(JSON.stringify(next), 'ab'.repeat(32)),",
    kills: [
      "A SECOND DEVICE, FROM THE WORDS ALONE, AT ANOTHER ADDRESS, OPENS BOTH COMPANIES' KEYS",
    ],
  },
  {
    id: 5,
    binding: 'SAVED KEYS THAT DO NOT OPEN ARE REFUSED, NEVER REPLACED',
    file: 'src/web/keyring.ts',
    says: 'keys that do not open are taken as nothing saved, so the next save writes over keys '
      + 'this tab could not open',
    from: '        throw new SavedKeysDidNotOpen(DID_NOT_OPEN);\n      }\n    }\n    encKey = key;',
    to: '        opened = { accounts: {} };\n      }\n    }\n    encKey = key;',
    kills: [
      'SAVED KEYS THAT DO NOT OPEN ARE REFUSED BEFORE ANY COMPANY IS CREATED',
    ],
  },
  {
    id: 6,
    binding: 'A PERSON\'S FIRST KEYS ARE SAVED ONLY FROM THE TAB THAT SIGNED THEM IN',
    file: 'src/web/keyring.ts',
    says: 'a tab that cannot tell which wallet signed in starts a company, so its first keys '
      + 'may be sealed under a wallet the person did not sign in with',
    from: "    if (savedKeys !== 'some' && !keyCheckedAgainstSignIn) throw new Error(FIRST_KEYS_NEED_THE_SIGN_IN);\n\n",
    to: '\n',
    kills: [
      "A TAB THAT DID NOT SIGN IN MAY NOT SAVE A PERSON'S FIRST KEYS, AND SAYS SO BEFORE ANY COMPANY IS CREATED",
    ],
  },
  {
    id: 7,
    binding: 'A REFUSED SAVE COSTS A RETRY, NOT THE COMPANY',
    file: 'src/web/keyring.ts',
    says: 'the founder\'s secrets are dropped when the save is refused, so the only copy of them '
      + 'in existence is gone',
    from: '  } catch (e) {\n    if (dialog !== null) putAway(dialog);',
    to: '  } catch (e) {\n    pendingCompany = null;\n    if (dialog !== null) putAway(dialog);',
    kills: [
      'A SAVE REFUSED TWICE BECAUSE ANOTHER DEVICE KEPT SAVING KEEPS THE COMPANY, AND FINISH SAVES IT BESIDE WHAT WAS SAVED, WITHOUT THE WALLET',
    ],
  },
  {
    id: 8,
    binding: 'A COMPANY THAT CAN NEVER BE SAVED IS SAID TO BE',
    file: 'src/web/keyring.ts',
    says: 'a Finish that found keys it cannot open does not mark the company, and the screen goes '
      + 'on offering a Finish that always fails',
    from: "      pendingCompany = { ...pendingCompany, savingFailed: 'cannot-be-saved' };",
    to: '      pendingCompany = { ...pendingCompany };',
    kills: [
      "WHEN WHAT WAS SAVED MEANWHILE DOES NOT OPEN WITH THIS TAB'S KEY, FINISH SAYS IT CANNOT BE SAVED AND WRITES NOTHING",
    ],
  },
  {
    id: 9,
    binding: 'A TAB WAITING TO FINISH A COMPANY DOES NOT START ANOTHER',
    file: 'src/web/keyring.ts',
    says: 'a second company started in the same tab replaces the first one\'s unsaved secrets',
    from: "  if (pendingCompany !== null) {\n    throw new Error('a company this tab started is not finished yet",
    to: "  if (false) {\n    throw new Error('a company this tab started is not finished yet",
    kills: [
      'A TAB WAITING TO FINISH A COMPANY DOES NOT START ANOTHER',
    ],
  },
  {
    id: 10,
    binding: 'A PAYSLIP KEY IS WORKED OUT FROM THIS COMPANY\'S OWN KEY',
    file: 'src/web/keyring.ts',
    says: 'the key handed to the payslip derivation is the key the saved keys open with, so '
      + 'payslips are sealed to a key no company key can ever reproduce',
    from: '    releasedCompanyKey = { accountId: company.accountId, key: toHex(released.companyKey) };',
    to: '    releasedCompanyKey = { accountId: company.accountId, key: key };',
    kills: [
      "THE KEY HANDED BACK IS THE COMPANY'S OWN KEY FROM THIS WALLET, NOT THE KEY THE SAVED KEYS OPEN WITH",
    ],
  },
  {
    id: 11,
    binding: 'A REFUSED SAVE IS READ AGAIN AND TRIED ONCE MORE, AT ONCE',
    file: 'src/web/keyring.ts',
    says: 'a save refused because another device saved at the same moment is left waiting for '
      + 'a Finish, in a tab whose sign-in may end before anybody presses it',
    from: '      return await finishCompanyCreation();',
    to: '      throw refused;',
    kills: [
      "ONE PRESS: WHEN ANOTHER DEVICE SAVES A COMPANY'S KEYS BETWEEN THIS TAB'S READ AND ITS SAVE, BOTH ARE SAVED AND NOTHING IS LEFT WAITING",
    ],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-CREATE-COMPANY.txt');

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
function main() {
  mkdirSync(OUT, { recursive: true });

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  say(`MUTATING THE COMPANY CREATION PATH  —  ${new Date().toISOString()}`);
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

    beginMutation(path, before);
    writeFileSync(path, before.replace(m.from, m.to));
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
