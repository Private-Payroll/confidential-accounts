#!/usr/bin/env node
/**
 * MUTATING THE SIGN-IN, ONE BINDING AT A TIME. `docs/NEXT.md` PI1.
 *
 * `MUTATE.command` does this for the contracts and there is no equivalent for
 * TypeScript — `T-11`, and it matters because the client is the larger money
 * surface. This is not that harness; it is one round's worth of it, over the
 * four bindings a sign-in rests on and the one safeguard only this side can
 * build. **A test that has never been watched failing is a test nobody knows
 * the shape of**, and every assertion here was written before its mutation.
 *
 * THREE REFUSALS IT MAKES, ALL THREE BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more, so
 *     the mutation is aimed at code that no longer exists. Silently skipping it
 *     is indistinguishable from it passing, which is `T-7`.
 *   · **ambiguous target** — the text appears more than once, so which copy was
 *     broken is unknown.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.** The code
 * was broken and every test still passed, which means nothing was watching that
 * binding.
 *
 * Usage:  node scripts/mutate-wallet-sign-in.mjs [--only=1,3] [--report=PATH]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { measuredNothingBecause, openTheDoor, runSuiteHonestly, tail } from './mutation-door.mjs';

const ROOT = process.cwd();
const SUITE = 'src/core/wallet-sign-in.test.ts';
const OUT = join(ROOT, 'logs', 'mutate-sign-in');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'THE ORIGIN IS OURS',
    file: 'src/core/wallet-identity.ts',
    says: 'the verifier reads the origin out of the payload it is judging',
    from: '      atOrigin: this.origin,',
    to: '      atOrigin: response.payload.origin,',
    kills: ['A SIGN-IN MINTED FOR ANOTHER PAYROLL IS REFUSED HERE'],
  },
  {
    id: 2,
    binding: 'THE NONCE IS OURS',
    file: 'src/core/wallet-identity.ts',
    says: 'the verifier checks the payload’s nonce against the payload’s nonce',
    from: '      expectingNonce: args.nonce,',
    to: '      expectingNonce: response.payload.nonce,',
    kills: ['a sign-in answering an EARLIER request is refused against the open one'],
  },
  {
    id: 3,
    binding: 'THE NONCE IS USED ONCE',
    file: 'src/core/wallet-identity.ts',
    says: 'a spent or unknown challenge is accepted',
    from: '    if (!ours) {',
    to: '    if (false && !ours) {',
    kills: [
      'A REPLAYED SIGN-IN IS NOT A SIGN-IN — the second use of a nonce is refused',
      'A NONCE THIS DEPLOYMENT NEVER ISSUED IS REFUSED',
      'A NONCE WITHOUT ITS HANDLE IS NOT A SIGN-IN — the fixation half',
    ],
  },
  {
    id: 4,
    binding: 'THE ADDRESS IS THE SIGNER’S',
    file: 'src/core/wallet-identity.ts',
    says: 'a payload may name an address its own key does not produce',
    from: '    if (response.payload.address !== address) {',
    to: '    if (false && response.payload.address !== address) {',
    kills: ['A PAYLOAD NAMING AN ADDRESS ITS OWN KEY DOES NOT PRODUCE IS REFUSED'],
  },
  {
    id: 5,
    binding: 'A BAD SIGNATURE IS A REFUSAL',
    file: 'src/core/wallet-identity.ts',
    says: 'the verifier’s verdict is ignored',
    from: '    if (!verdict.ok) throw new WalletSignInError(verdict.code, verdict.says);',
    to: '    if (false) throw new WalletSignInError(verdict.code, verdict.says);',
    kills: [
      'ONE FLIPPED CHARACTER IN THE SIGNATURE AND NOBODY IS SIGNED IN',
      'A SIGN-IN MINTED FOR ANOTHER PAYROLL IS REFUSED HERE',
      'REWRITING THE PAYLOAD TO SAY OUR ORIGIN DOES NOT HELP',
    ],
  },
  {
    id: 6,
    binding: 'A SIGN-IN CARRIES NOTHING ABOUT A PERSON',
    file: 'src/core/wallet-identity.ts',
    says: 'details nobody asked for are kept instead of refused',
    from: '    if (response.payload.disclosed.length > 0 || response.payload.declined.length > 0) {',
    to: '    if (false) {',
    kills: [
      'a response carrying details is REFUSED rather than quietly kept',
      'and a list of what was DECLINED is refused too — nothing was asked',
    ],
  },
  {
    id: 7,
    binding: 'THE ADDRESS IS NOT STORED, ONLY ITS HASH',
    file: 'src/core/wallet-identity.ts',
    says: 'the subwallet address is written on the user row beside its memberships',
    from: '      walletKey: walletKeyOf(address),',
    to: '      walletKey: address,',
    kills: ['NO EMAIL, NO PASSWORD AND NO NAME — nothing asked for any of them'],
  },
  {
    id: 8,
    binding: 'ONE SUBWALLET, ONE EMPLOYER',
    file: 'src/core/subwallet-binding.ts',
    says: 'a wallet already bound to another company is let through',
    from: '  if (elsewhere.length > 0) throw new SubwalletAlreadyBound();',
    to: '  if (false) throw new SubwalletAlreadyBound();',
    kills: [
      'WATCHED FAILING: the same wallet cannot take a seat on a second company',
      'and creating a company from scratch is refused too — `null` is a company',
      'THE REFUSAL NAMES NO COMPANY, because naming one would be the leak',
    ],
  },
  {
    id: 9,
    binding: 'AND ONLY WHEN IT IS ANOTHER EMPLOYER',
    file: 'src/core/subwallet-binding.ts',
    says: 'signing in again to the company you are already on is refused too',
    from: '  const elsewhere = employersFor(store, userId).filter(id => id !== joining);',
    to: '  const elsewhere = employersFor(store, userId);',
    kills: ['WATCHED FAILING: the same wallet cannot take a seat on a second company'],
  },
  {
    id: 10,
    binding: 'A PASSWORD ACCOUNT PRESENTS NO SLOT',
    file: 'src/core/subwallet-binding.ts',
    says: 'the rule is applied to accounts that have no wallet at all',
    from: '  if (!user?.walletKey) return;',
    to: '  if (!user) return;',
    kills: ['AN ACCOUNT WITH NO SUBWALLET IS NOT TOUCHED BY THIS RULE'],
  },
  /*
   * THE TWO REPOSITORIES ARE MADE TO DISAGREE, WHICH IS THE DEFECT
   * ITSELF rather than a proxy for it: the wallet is compiled for one network,
   * payroll is given a second constant of its own, and the address one writes
   * is not the address the other derives.
   */
  {
    id: 11,
    binding: 'ONE NETWORK — THE LINK BETWEEN THE TWO REPOSITORIES',
    file: 'src/midnight/network.ts',
    says: 'payroll pins its own network instead of reading the wallet\u2019s',
    from: 'export const PAIR_NETWORK: NetworkName = WALLET_NETWORK;',
    to: "export const PAIR_NETWORK: NetworkName = 'preview';",
    kills: [
      'WATCHED FAILING: the wallet and payroll name the same Midnight network',
      'A SIGN-IN MINTED ON THE WALLET\u2019S NETWORK IS ACCEPTED ON PAYROLL\u2019S',
      'WATCHED FAILING: a deployment that names a DIFFERENT network is refused at boot,'
        + ' and the sentence carries both values',
    ],
  },
  {
    id: 12,
    binding: 'ONE NETWORK — THE VALUE THE PAIR AGREED ON',
    file: 'Identity/src/wallet/network.ts',
    says: 'the wallet is rebuilt for a different network and nobody is told',
    from: "export const NETWORK: NetworkName = 'stagenet';",
    to: "export const NETWORK: NetworkName = 'preview';",
    kills: [
      'WATCHED FAILING: the wallet and payroll name the same Midnight network',
      'WATCHED FAILING: a deployment that names a DIFFERENT network is refused at boot,'
        + ' and the sentence carries both values',
    ],
  },
  /*
   * `C151`, second half. The refusal stops being able to tell one key under two
   * network names from two different keys, and goes back to blaming the key.
   */
  {
    id: 13,
    binding: 'THE REFUSAL NAMES THE LIKELY CAUSE',
    file: 'src/core/wallet-identity.ts',
    says: 'a network-only difference is reported as somebody else\u2019s key',
    from: '  if (elsewhere !== undefined) {',
    to: '  if (false) {',
    kills: [
      'WATCHED FAILING: ONE KEY, TWO NETWORKS — the refusal names both networks and'
        + ' clears the wallet',
    ],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'REPORT-MUTATE-SIGN-IN.txt');

/** Runs the suite and returns the titles that failed, plus the two counts. */
function runSuite(tag) {
  return runSuiteHonestly({ suites: [SUITE], cwd: ROOT, outFile: join(OUT, `${tag}.json`) });
}

function main() {
  mkdirSync(OUT, { recursive: true });

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  say(`MUTATING THE WALLET SIGN-IN  —  ${new Date().toISOString()}`);
  say(`suite: ${SUITE}`);
  say('');

  const clean = runSuite('baseline');
  if (!clean.ran) {
    say('  THE SUITE DID NOT RUN AT ALL. Nothing below means anything.');
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

    writeFileSync(path, before.replace(m.from, m.to));
    let result;
    try {
      result = runSuite(`mutation-${m.id}`);
    } finally {
      writeFileSync(path, before);
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
