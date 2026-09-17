#!/usr/bin/env node
/**
 * **MUTATING THE ROUND THAT LETS SOMEBODY BE HIRED.** `docs/NEXT.md` `X11`,
 * `docs/how-money-can-be-lost.md` `C160`.
 *
 * The harness `scripts/mutate-self-payee.mjs` grew, aimed at the five things
 * `X11` changed: **where the token can be reached**, **what the accept door is
 * able to receive**, **what meters the one unauthenticated door**, **what makes
 * somebody payable**, and **whether an error a person reads is kept**.
 *
 * **IT SPANS BOTH REPOSITORIES, WHICH IS NEW HERE.** `X11` is a cross-repository
 * round: the WebAssembly-free address check that lets the invitee's own browser
 * refuse a preview address before it seals one lives in the wallet, because the
 * wallet owns the address vocabulary and is the side that may load the ledger.
 * A mutation aimed there has to run the WALLET's suite, so each mutation names
 * its repository and a baseline is taken per repository, lazily.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-invitations.mjs [--only=1,3] [--report=PATH]
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
 * **DELIBERATELY NOT `core.test.ts`.** It is twelve seconds and nothing here
 * targets a line it is the only witness to; a mutation harness that takes
 * minutes is a mutation harness nobody runs, and `T-7` is what a mutation
 * nobody runs is worth.
 */
const SUITES = {
  payroll: [
    'src/server/invitations.test.ts',
    'src/web/join-error-reaches-the-report.test.tsx',
  ],
  wallet: ['src/wallet/address-shape.test.ts'],
};
const CWD = { payroll: ROOT, wallet: WALLET };
const OUT = join(ROOT, 'logs', 'mutate-invitations');

/** file (relative to its repo), what it breaks, the exact text, and what must die. */
const MUTATIONS = [
  {
    id: 1,
    repo: 'payroll',
    binding: 'THE TOKEN IS UNREACHABLE AFTER THE INVITATION IS MADE — `X11` §1',
    file: 'src/server/index.ts',
    says: 'the invite listing serves the raw token again, so any MEMBER — the check is '
      + 'membership, not role, so a viewer seat too — can read every open invitation and '
      + 'redeem it. Whoever opens an invitation sets the address the salary is paid to, so '
      + 'this is the deleted "open it as them" button arriving as a listing field',
    from: '  res.json(store.listInvites(String(req.params.id)).map(({ token, ...rest }) => ({\n'
      + '    ...rest, redeemed: Boolean(rest.acceptedAt),\n'
      + '  })));',
    to: '  res.json(store.listInvites(String(req.params.id)).map((rest) => ({\n'
      + '    ...rest, redeemed: Boolean(rest.acceptedAt),\n'
      + '  })));',
    kills: ['AN OPERATOR CANNOT REACH AN EMPLOYEE\'S TOKEN AFTER THE INVITATION IS MADE'],
  },
  {
    id: 2,
    repo: 'payroll',
    binding: 'THE ACCEPT DOOR CANNOT RECEIVE A PLAIN ADDRESS — `C160`, `X11` §7',
    file: 'src/server/index.ts',
    says: 'the route takes a bech32 address out of the request body again and seals it on '
      + 'our side, so the plaintext is back in this process and in anything that ever logs '
      + 'a body — which is the exact thing §5 of the scope decided against on 22 Aug, and '
      + 'the whole reason `X11` opened this door rather than leaving it for later',
    from: "  if (refuseInTheClear('address', 'a receiving address')) return;",
    to: '  /* mutation: the field is read instead of refused */',
    kills: ['AN ADDRESS THAT ARRIVES IN THE CLEAR IS REFUSED BY NAME'],
  },
  {
    id: 3,
    repo: 'payroll',
    binding: 'THE OFFER ENDPOINT IS METERED — `X11` §6',
    file: 'src/server/index.ts',
    says: 'the limiter comes off the one unauthenticated door in this product, so a guesser '
      + 'can walk the token space as fast as the network allows and nothing anywhere counts '
      + 'the attempt',
    from: "    const decision = await limiter.record('invite-offer', from);",
    to: '    const decision = { allowed: true, attempts: 0, retryAfterSeconds: 0 };',
    kills: ['REFUSES A CALLER WHO ASKS TOO MANY TIMES, WITH A `Retry-After`'],
  },
  {
    id: 4,
    repo: 'payroll',
    binding: 'AND IT IS KEYED ON THE CALLER, NEVER ON THE TOKEN — `X11` §6',
    file: 'src/server/index.ts',
    says: 'the bucket becomes the token instead of the caller. The endpoint is still metered '
      + 'and completely unprotected: every guess is a different token, so every guess gets a '
      + 'fresh allowance and one guesser can walk the whole space for ever, one attempt per '
      + 'token. **This is the mutation that would survive a limiter nobody thought about**',
    from: "    const decision = await limiter.record('invite-offer', from);",
    to: "    const decision = await limiter.record('invite-offer', String(req.params.token));",
    kills: ['REFUSES A CALLER WHO ASKS TOO MANY TIMES, WITH A `Retry-After`'],
  },
  {
    id: 5,
    repo: 'payroll',
    binding: '`active` IS NOT A STATUS SOMEBODY CAN JUST BE GIVEN — `C156`',
    file: 'src/core/payroll.ts',
    says: 'the roster can mark a pending person with no address and no key active, which is '
      + 'the state only `admit` may produce. Nothing is paid — a run refuses by name for a '
      + 'person with no address — but the door answers a question it may not answer, and '
      + 'the interface has believed this guard existed since `X7`',
    from: "    if (status === 'active' && !e.address) {",
    to: '    if (false) {',
    kills: ['THE ROSTER CANNOT MARK A PERSON WITH NO ADDRESS ACTIVE — C156'],
  },
  {
    id: 6,
    repo: 'payroll',
    binding: 'AN ERROR A PERSON READS IS AN ERROR THE REPORT KEEPS — `C159`, `X11` §5',
    file: 'src/web/shown-error.ts',
    says: 'showing and keeping come apart again: the sentence still reaches the screen and '
      + 'nothing reaches the report. **This is exactly the state `C159` describes** — the '
      + 'one class of failure that by definition reaches a human is the one class no '
      + 'artefact keeps, and it was found by a walk rather than by any test',
    from: '  recordShownError(`${where}: ${sentence}`, stack === undefined ? undefined : redactSecrets(stack));',
    to: '  void where;',
    kills: ['THE INVITATION SCREEN SHOWS A REFUSAL AND THE REPORT KEEPS IT'],
  },
  {
    id: 7,
    repo: 'payroll',
    binding: 'AND IT IS REDACTED BEFORE IT IS KEPT — `C145`, `C148`',
    file: 'src/web/shown-error.ts',
    says: 'a shown error reaches the report and the screen unredacted, so a key, a seed or a '
      + 'company address in an error message is written to disk and rendered onto a screen '
      + 'somebody is about to photograph',
    from: '    sentence = redactSecrets(sentence);',
    to: '    sentence = String(sentence);',
    kills: ['AND IT IS REDACTED ON THE WAY, LIKE EVERYTHING ELSE THAT REACHES DISK'],
  },
  {
    id: 8,
    repo: 'wallet',
    binding: 'A PREVIEW ADDRESS HANDED TO A STAGENET COMPANY IS REFUSED — `X11` §7',
    file: 'src/wallet/address-shape.ts',
    says: 'the network check comes off the WebAssembly-free address check, so the invitee\'s '
      + 'own browser seals a well-formed address for the wrong chain and nobody notices '
      + 'until a payment settles into a coin no wallet on this network can ever see. **This '
      + 'is the check `X11` §7 moved rather than deleted**, and the mutation is what says '
      + 'the move was real',
    from: '  if (theirs !== wanted) {',
    to: '  if (false) {',
    /*
     * ONE TEST, AND THE SECOND CANDIDATE IS DELIBERATELY NOT NAMED. *AGREES
     * WITH THE PLATFORM ON EVERY NETWORK* compares the mirror and the real
     * decoder on MATCHING networks only, so it is green under this mutation and
     * correctly so — naming it would be a stale expectation dressed as rigour.
     * Watched failing before it was written down.
     */
    kills: ['REFUSES A PREVIEW ADDRESS HANDED TO A STAGENET COMPANY, BY NAME'],
  },
  /*
   * **NINE AND TEN ARE `PI4c`, AND THEY POINT IN OPPOSITE DIRECTIONS ON
   * PURPOSE.** `docs/how-money-can-be-lost.md` `C21`.
   *
   * `PI4c` DELETED a check — `admit`'s comparison of the redeemer's sign-in
   * email against the email an operator typed at hire time — on the grounds
   * that `X12`'s confirmation code had already replaced it. **Removing a check
   * is only safe if the thing that replaced it actually bites**, and one
   * mutation cannot say that. So there are two:
   *
   *   · **9 makes the replacement stop working** — every address renders the
   *     same code — and a test must die. If none does, the code is decoration
   *     and the deletion took the only thing that was there.
   *   · **10 puts the deleted comparison BACK** and the inverted test must
   *     die. If it does not, that test is not actually asserting that a real
   *     invitee gets hired, and the round proved nothing in the other
   *     direction either.
   *
   * **NINE'S FILE IS IN THE WALLET AND ITS SUITE IS PAYROLL'S**, which is not
   * a mistake: `node_modules/midnight-identity` is a symlink to `Identity/`,
   * so payroll runs that exact source. The path is written from payroll's root
   * because that is the repository whose tests are the assertion here.
   */
  {
    id: 9,
    repo: 'payroll',
    binding: 'THE CODE IS OF ONE ADDRESS AND NOT ANOTHER — `X12` §2, `C21`',
    file: 'Identity/src/profile/fingerprint.ts',
    says: 'the fingerprint stops depending on the address, so every address on earth renders '
      + 'the same twenty characters and any two codes agree. **This is the replacement `PI4c` '
      + 'deleted the email comparison in favour of**: a join page that sealed somebody else\'s '
      + 'address would now show a matching code to the admin and pass `admit`, and the only '
      + 'positive left in the hiring flow would be a constant',
    from: '  const digest = sha256(new TextEncoder().encode(label + value));',
    to: '  const digest = sha256(new TextEncoder().encode(label));',
    kills: [
      'AND ONE WHOSE TWO CODES DISAGREE IS REFUSED AT ADMIT, RECOVERABLY — C21',
      'AND AN ADDRESS THAT IS NOT THE ONE THE WALLET SHOWED DOES NOT MATCH',
    ],
  },
  {
    id: 10,
    repo: 'payroll',
    binding: 'AND THE DELETED EMAIL COMPARISON STAYS DELETED — `PI4c`, `C21`',
    file: 'src/core/payroll.ts',
    says: 'the comparison `C21` says closes by DELETION is put back at `admit`: the redeemer\'s '
      + 'sign-in email against the email the operator typed at hire time. It never stopped an '
      + 'operator, who controls both sides of it — and it refuses every real invitee, because '
      + 'a wallet sign-in has no email. **Nobody can be hired again**',
    from: '      const same = (a: string) => a.trim().toLowerCase();',
    to: '      const same = (a: string) => a.trim().toLowerCase();\n'
      + '      if (person.email !== null && (redeemer.email === null\n'
      + '        || same(redeemer.email) !== same(person.email))) {\n'
      + '        putBack();\n'
      + '        throw new Error(\'mutation: the email comparison is back at admit\');\n'
      + '      }',
    kills: ['AN INVITEE WHO SIGNS IN WITH A WALLET CAN BE ADMITTED — C21'],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-INVITATIONS.txt');

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

  say(`MUTATING THE INVITATION ROUND  —  ${new Date().toISOString()}`);
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
