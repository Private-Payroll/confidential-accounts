#!/usr/bin/env node
/**
 * MUTATING THE ADDRESS PROVENANCE AND THE PAYSLIP KEY. `docs/NEXT.md` PI2b.
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
  'src/core/company-address-source.test.ts',
  'src/core/payslip-key.test.ts',
  'src/core/core.test.ts',
];
const OUT = join(ROOT, 'logs', 'mutate-payslip-key');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  /* ------------------------- C140 — provenance ------------------------- */
  {
    id: 1,
    binding: 'A SIMULATED ADDRESS SAYS IT IS SIMULATED — C140, AND IT IS THE ONE THE BRIEF NAMES',
    file: 'src/core/ledger.ts',
    says: 'the simulation claims a chain gave it the address, so it is indistinguishable again',
    from: "    return a ? { value: a.address, source: 'simulated' } : null;",
    to: "    return a ? { value: a.address, source: 'chain' } : null;",
    kills: [
      'A SIMULATED ADDRESS SAYS IT IS SIMULATED, AND LOOKS EXACTLY LIKE A REAL ONE',
      'THE SOURCE IS WRITTEN ON THE RECORD IN THE SAME BREATH AS THE ADDRESS',
      'A SIMULATED COMPANY IS REFUSED, AND THE REFUSAL SAYS WHICH KIND OF NOTHING IT IS',
      'WITH IT OFF THE SAME CALL REFUSES — the setting is the only difference',
    ],
  },
  {
    id: 2,
    binding: 'THE LOOKUP READS THE PROVENANCE AND NOT ONLY THE SHAPE',
    file: 'src/core/company-address.ts',
    says: 'the refusal is removed, so the shape check is the only door again — PI2a exactly',
    from: "  if (rec.addressSource !== 'chain' && !inDevelopment()) {",
    to: '  if (false) {',
    kills: [
      'A SIMULATED COMPANY IS REFUSED, AND THE REFUSAL SAYS WHICH KIND OF NOTHING IT IS',
      'AN ACCOUNT FROM BEFORE THIS ROUND IS REFUSED, BECAUSE NOBODY CAN SAY WHAT IT WAS',
      'WITH IT OFF THE SAME CALL REFUSES — the setting is the only difference',
    ],
  },
  {
    id: 3,
    binding: 'AN UNRECORDED SOURCE IS NOT READ AS A CHAIN’S',
    file: 'src/core/company-address.ts',
    says: 'absent is treated as good, so every account made before this round walks through',
    from: "  if (rec.addressSource !== 'chain' && !inDevelopment()) {",
    to: "  if (rec.addressSource === 'simulated' && !inDevelopment()) {",
    kills: ['AN ACCOUNT FROM BEFORE THIS ROUND IS REFUSED, BECAUSE NOBODY CAN SAY WHAT IT WAS'],
  },
  {
    id: 4,
    binding: 'THE SOURCE SURVIVES A RE-SEAL',
    file: 'src/core/account.ts',
    says: 'the provenance is dropped every time the account is written back',
    from: '    addressSource: account.addressSource ?? null,',
    to: '    addressSource: null,',
    kills: ['AND THE SOURCE SURVIVES A RE-SEAL — dropping it is dropping the guard'],
  },

  /* ---------------------- C135 — the payslip key ----------------------- */
  {
    id: 5,
    binding: 'A PAYSLIP IS SEALED TO THAT PERSON AND TO NOBODY ELSE — THE ONE THAT MATTERS',
    file: 'src/core/payroll.ts',
    says: 'every slip in a run is wrapped to the FIRST payee’s key, so one colleague reads all of them',
    from: '      payslips.push({ employeeId: id, wrapped: wrapKey(slipKey, publicKey), slip });',
    to: '      payslips.push({ employeeId: id, wrapped: '
      + 'wrapKey(slipKey, employees[0]?.wrappingPublicKey ?? publicKey), slip });',
    kills: ['ANOTHER PERSON\'S DERIVED KEY DOES NOT OPEN IT EITHER'],
  },
  {
    id: 6,
    binding: 'THE KEY COMES FROM THE PERSON’S WALLET, NEVER FROM SOMETHING THE COMPANY HOLDS',
    file: 'src/core/payslip-key.ts',
    says: 'the key is derived from the company address, which the company holds in the clear — '
      + 'so the employer can compute every employee’s payslip key',
    from: '  return payslipKeypairFrom(unlockKeyFor(identityFromWords(words), ask));',
    to: '  return payslipKeypairFrom(sha256(utf8(company)));',
    kills: [
      'TWO COMPANIES NEVER SHARE A KEY, and neither do two people',
      'ANOTHER PERSON\'S DERIVED KEY DOES NOT OPEN IT EITHER',
      'AND A DIFFERENT WALLET ON THAT SECOND DEVICE OPENS NOTHING',
    ],
  },
  {
    id: 7,
    binding: 'NOTHING RANDOM ENTERS THE DERIVATION — THE SECOND-DEVICE TEST',
    file: 'src/core/payslip-key-derive.ts',
    says: 'the expansion picks up a random value, so the key is minted rather than derived',
    from: '  const secret = hkdf(sha256, companyKey, PAYSLIP_SALT, NO_INFO, KEY_BYTES);',
    to: '  const secret = hkdf(sha256, companyKey, PAYSLIP_SALT, '
      + 'utf8(String(Math.random())), KEY_BYTES);',
    kills: [
      'A WALLET REBUILT FROM ITS WORDS ALONE OPENS A PAYSLIP ISSUED BEFORE THAT DEVICE EXISTED',
      'THE SAME WORDS AND THE SAME COMPANY GIVE THE SAME KEY, EVERY TIME',
      'THE HOST IS NOT AN INGREDIENT — a self-hosted client derives the same key',
      'THE SEED DERIVES THE KEY AND NO LONGER INVENTS ONE',
      'THE COMPANY HOLDS ONLY THE PUBLIC HALF',
    ],
  },
  {
    id: 8,
    binding: 'THE HOST IS NOT AN INGREDIENT — a self-hosted client derives the same key',
    file: 'src/core/payslip-key.ts',
    says: 'the origin is folded into the key, so a customer’s data opens at our address only',
    from: '  if (ask.kind !== \'unlock\') throw new Error(`built a ${ask.kind}, not an unlock`);',
    to: '  if (ask.kind !== \'unlock\') throw new Error(`built a ${ask.kind}, not an unlock`);\n'
      + '  if (atOrigin) return payslipKeypairFrom(sha256(utf8(atOrigin + company)));',
    kills: ['THE HOST IS NOT AN INGREDIENT — a self-hosted client derives the same key'],
  },
  {
    id: 9,
    binding: 'THE SEED DERIVES THE KEY AND DOES NOT INVENT ONE',
    file: 'src/core/payroll.ts',
    says: 'the seed goes back to minting a random payslip key nothing can recompute',
    from: '    const wk = payslipKeypairForWallet(words, company, SEED_WALLET_ORIGIN);',
    to: '    const wk = newWrappingKeypair();',
    kills: [
      'THE SEED DERIVES THE KEY AND NO LONGER INVENTS ONE',
      'THE COMPANY HOLDS ONLY THE PUBLIC HALF',
    ],
  },
  {
    id: 10,
    binding: 'A MNEMONIC DOES NOT CROSS THE WIRE — C45, C312',
    file: 'src/core/demo.ts',
    says: 'the projection spreads the whole secret again, so every seeded person’s wallet '
      + 'words leave in an HTTP body',
    /*
     * **RE-AIMED BY `S56`, AND IT HAD BEEN WATCHING NOTHING FOR FOUR DAYS.**
     * `T-285` `P1`.
     *
     * The text this entry named lived inside `seedDemo`'s return object.
     * **`S29` lifted it out into `seededEmployeesForHttp` on 31 Aug** —
     * register `C312` — and nothing re-aimed the
     * mutation, so from that day `PAYSLIP-KEY-CHECK` reported
     * `0 survived, 1 not run` on every run **and the only check that a person's
     * wallet words never leave in an HTTP body produced no evidence at all.**
     * The four fields are still listed and still not spread, so there is no
     * reason to think anything was ever wrong — only that nothing was checking.
     * **`T-285` says the lift was 3 Sep. It was 31 Aug, and the row is what is
     * wrong about it rather than the date.**
     *
     * The `to:` restores exactly the failure `C312`'s positive control was
     * written for: `...e.secret` carries `words` — a string ARRAY, which is why
     * the old space-separated phrase probe matched nothing and the rule was
     * held by `not.toHaveProperty('words')` alone.
     */
    from: `  return hired.map(e => ({
    employeeId: e.secret.employeeId,
    name: e.secret.name,
    wrappingSecret: e.secret.wrappingSecret,
    title: e.employee.title,
  }));`,
    to: '  return hired.map(e => ({ ...e.secret, title: e.employee.title }));',
    kills: ['THE SEED\'S HTTP PAYLOAD CARRIES NO MNEMONIC — a wallet is not a wrapping secret'],
  },
  {
    /*
     * **`T-196`, `SC9` `F4`, ADDED BY `S46` IN THE TURN THAT PINNED THE SALT
     * (rule 18).** Mutation 7 above is the only other entry touching this HKDF
     * call and it replaces `NO_INFO`, **leaving `PAYSLIP_SALT` standing** —
     * which is how a constant whose own comment says *"the day it changes is
     * the day every payslip stops opening"* went four months with no
     * instrument on it at all.
     *
     * **A CHANGED-BUT-FIXED SALT IS THE WHOLE DANGER, WHICH IS WHY THIS
     * MUTATION IS `v1` → `v2` AND NOT A DELETION.** Determinism,
     * host-independence, distinctness, not-the-parent-key and the length
     * refusal all stay true under it; every payslip ever issued stops opening.
     * Before `S46` every assertion in `payslip-key.test.ts` was
     * self-referential and this would have SURVIVED.
     */
    id: 11,
    binding: 'THE PAYSLIP SALT IS A MIGRATION AND NEVER A PATCH — T-196',
    file: 'src/core/payslip-key-derive.ts',
    says: 'the wrapping domain moves to v2, so every payslip ever issued stops opening while '
      + 'every relation this suite checks stays true',
    from: "const PAYSLIP_SALT = utf8('midnight-payroll/payslip-wrapping/v1');",
    to: "const PAYSLIP_SALT = utf8('midnight-payroll/payslip-wrapping/v2');",
    kills: ['THE DERIVATION IS PINNED TO FIXED BYTES — the salt is not a thing anyone may tidy'],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-PAYSLIP-KEY.txt');

/**
 * Runs both suites and returns what the run actually COLLECTED, not what it
 * PARSED.
 *
 * **`ran` USED TO MEAN *THE JSON PARSED*, WHICH IS THE WRONG TEST**, and the
 * reasoning is written out in full in `scripts/mutate-authority.mjs` — this is
 * the same mechanism and not a variant. The short of it: a vitest run that
 * collects NOTHING still writes a well-formed empty report, that report parses,
 * `failures` is then `0`, and the loop below printed the loudest sentence this
 * harness owns about a run in which no assertion executed. `T-295`, `SC15` §2,
 * fixed by `S56`. `emptyFiles` is the other half — a suite file that failed to
 * COLLECT is hidden by `flatMap(… ?? [])` inside a report that parses and names
 * it — and `said` is vitest's own output, which was discarded at the one moment
 * it was the only record of the cause.
 */
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

  say(`MUTATING THE ADDRESS PROVENANCE AND THE PAYSLIP KEY  —  ${new Date().toISOString()}`);
  for (const s of SUITES) say(`suite: ${s}`);
  say('');

  recoverFromLastRun(say);

  const clean = runSuite('baseline');
  if (!clean.ran) {
    say('  THE SUITES DID NOT RUN AT ALL. Nothing below means anything.');
    say(`  ${clean.why}.`);
    say('  the last thing vitest said:');
    for (const l of tail(clean.said)) say(`    ${l}`);
    writeFileSync(reportAt, lines.join('\n') + '\n');
    process.exit(1);
  }
  say(`baseline: ${clean.failures} failed | ${clean.passed} passed | ${clean.collected} collected`);
  if (clean.failures > 0) {
    say('');
    say('  THE SUITE IS RED BEFORE ANY MUTATION. A mutation cannot be judged against');
    say('  a suite that is already failing, so nothing was run.');
    for (const t of clean.failed) say(`    - ${t}`);
    writeFileSync(reportAt, lines.join('\n') + '\n');
    process.exit(1);
  }
  say('');

  /*
   * **A `kills:` ENTRY IS MATCHED BY TITLE AND NOTHING ELSE**, so the moment two
   * suites carry the same title this harness can no longer say WHICH guard ran.
   * It held by naming luck until `S56` and now it names what enforces it —
   * rule 27. The reasoning is in `scripts/mutate-authority.mjs`; this is the same
   * guard, and it refuses before anything is mutated.
   */
  const named = new Set(MUTATIONS.flatMap(m => m.kills));
  const seenAt = new Map();
  for (const a of clean.byFile) {
    if (!named.has(a.title)) continue;
    if (!seenAt.has(a.title)) seenAt.set(a.title, []);
    seenAt.get(a.title).push(a.file);
  }
  /*
   * **TWO CORRECTIONS FROM `S56`'s OWN money-safety pass, BOTH ITS OWN
   * SUBJECT.** The first version compared every title in the baseline, so a
   * duplicate in a file no `kills:` entry names would have stopped the whole
   * corpus for a reason unrelated to any of it. And it compared FILES — `files.size
   * > 1` — so two assertions with the same title in ONE file passed, while
   * `known.has(t)` and `result.failed.includes(t)` are exactly as ambiguous there.
   * It now counts OCCURRENCES of the titles a mutation actually names.
   */
  const collisions = [...seenAt].filter(([, files]) => files.length > 1);
  if (collisions.length) {
    say('  TWO SUITES CARRY THE SAME ASSERTION TITLE, so a `kills:` entry cannot be');
    say('  matched to a file and this harness cannot say which guard ran. Nothing');
    say('  was mutated.');
    for (const [title, files] of collisions) {
      say(`    "${title}" — named by a mutation, and it appears ${files.length} times:`);
      for (const f of files) say(`      ${f}`);
    }
    writeFileSync(reportAt, lines.join('\n') + '\n');
    process.exit(1);
  }

  const known = new Set(clean.titles);
  let survived = 0;
  let stale = 0;
  /*
   * **THE FOURTH OUTCOME, NAMED.** `stale` is a mutation that could not be
   * APPLIED; `notRun` is one that WAS applied and whose run measured nothing.
   * `T-285` is what one number for two states costs: this door reported
   * `0 survived, 1 not run` while the only check that a person's wallet words
   * never leave in an HTTP body had not run, and the number a reader took away
   * was the zero.
   */
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
     * **THE FOUR WAYS A RUN CAN HAVE MEASURED NOTHING.** Written out in full in
     * `scripts/mutate-authority.mjs`; this is the same guard, deliberately
     * identical, so the two doors say the same thing about the same state.
     */
    const collapsed = measuredNothingBecause({ result, baseline: clean, kills: m.kills });

    if (collapsed.length) {
      say('    NOT RUN. The mutation was applied and the run measured NOTHING here.');
      say('    This is not a survivor and it is not a kill: nothing executed, so the');
      say('    entry says nothing about the binding in either direction.');
      /*
       * UNLESS THE NAMED GUARDS DID RUN, in which case that last sentence is
       * not true of this entry and saying it anyway is the kind of false line
       * these harnesses exist to catch. Checks 2 and 3 fire on a collapse
       * ANYWHERE in the run, which can happen while the guards this entry names
       * executed normally. Nothing here is graded differently: no counter
       * moves, the exit status is unchanged, and the outcome is still RAN AND
       * MEASURED NOTHING. What changes is that the report stops claiming more
       * than it knows.
       */
      if (m.kills.length && m.kills.every(k => result.titles.includes(k))) {
        say('    EXCEPT THAT THE GUARD(S) THIS ENTRY NAMES DID EXECUTE, and');
        say(`    ${result.failed.some(x => m.kills.includes(x)) ? 'at least one of them FAILED' : 'every one of them PASSED'}.`);
        say('    So the collapse above is somewhere else in the run, and this');
        say('    entry is worth reading rather than dismissing.');
      }
      for (const c of collapsed) say(`      - ${c}`);
      if (result.failed.length) {
        /*
         * **AND WHAT DID GO RED IS PRINTED, NOT DISCARDED.** `S56`'s
         * test-coverage pass: when check 2, 3 or 4 fires because ONE file collapsed
         * while a named guard in another genuinely died, *"nothing executed to
         * say it"* is false and the list of tests that died was being thrown
         * away — `T-295`'s shape, one branch over.
         */
        say(`    ${result.failed.length} test(s) DID go red under it, and they are evidence even`);
        say('    though the run as a whole measured less than it should have:');
        for (const t of result.failed) say(`      ${m.kills.includes(t) ? '✓' : '+'} ${t}`);
      }
      say('    the last thing vitest said, which is where the reason is:');
      for (const l of tail(result.said)) say(`      ${l}`);
      notRun += 1;
      /*
       * The tree is already restored by the `finally` above, so one more run says
       * whether the fault was this mutation's or the tree's — and only the second
       * kind will stop the next one too. `C293`'s abort, conditioned on a
       * measurement rather than on an assumption; the argument on both sides is
       * written out in `scripts/mutate-authority.mjs`.
       */
      const recheck = runSuite(`recheck-${m.id}`);
      if (!recheck.ran || recheck.collected < clean.collected) {
        say('');
        say('    AND THE TREE IS BACK AND THE SUITE STILL DOES NOT RUN, so whatever');
        say('    stopped it will stop the next one too. ABORTING rather than scoring');
        say('    nothing. C293.');
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
   * **THREE NUMBERS, THREE SENTENCES, NEVER ONE LINE.** `T-285`: the old summary
   * put staleness in the same breath as survivors, and *survivor* is the word
   * this door attaches "hole" to. `0 survived, 1 not run` therefore read as a
   * procedural hiccup while `C312`'s guard — the one that says a wallet phrase
   * never leaves in an HTTP body — had produced no evidence at all.
   */
  say(`${survived} SURVIVED — the code was broken and nothing noticed. A hole in the product.`);
  say(`${stale} COULD NOT BE APPLIED — a mutation aimed at code that has moved. The`);
  say('   binding it names has been unguarded since the day the code moved, and');
  say('   that looks exactly like a passing check.');
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
      + ' only the first is about the product. The other two are about this door.');
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
