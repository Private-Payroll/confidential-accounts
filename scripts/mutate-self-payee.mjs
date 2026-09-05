#!/usr/bin/env node
/**
 * MUTATING THE DOOR A PERSON MAKES THEMSELVES PAYABLE THROUGH. `docs/NEXT.md`
 * X8 §2 and §3, `docs/how-money-can-be-lost.md` `C153`.
 *
 * The harness `Identity/scripts/mutate-origin.mjs` grew, aimed at the two
 * things `X8` changed about this door: **where the address comes from**, and
 * **what stops one person becoming two payable people.**
 *
 * FOUR SUITES, AND THE SPREAD IS THE POINT. `core.test.ts` is the cap's oldest
 * home and this round did not touch its assertions — a mutation to the cap that
 * is caught only by a test written this week would say the older ones had
 * stopped protecting anything. `self-payee.test.ts` drives real HTTP, because
 * §2's rule lives at a ROUTE and is about what arrives in a request.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-self-payee.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SUITES = [
  'src/core/core.test.ts',
  'src/core/founder-payslip.test.ts',
  'src/core/wallet-payee.test.ts',
  'src/server/self-payee.test.ts',
];
const OUT = join(ROOT, 'logs', 'mutate-self-payee');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'ONE PAYABLE ENTRY PER PERSON — and two is two salaries',
    file: 'src/core/payroll.ts',
    says: 'the cap is removed, so the same person can be made payable twice on one '
      + 'company and be paid twice every month, by two records that are each perfectly '
      + 'well formed',
    from: '      const clash = this.listPeople(rec.accountId, viewingKey).find(p =>\n'
      + "        p.id !== employeeId && p.status === 'active' && isTheSamePerson(p));",
    to: '      const clash = undefined;',
    kills: [
      '§3 AND ONE PAYABLE ENTRY PER PERSON, WITH NO EMAIL TO KEY ON',
      'AND ONLY ONE PAYABLE ENTRY PER PERSON — two is two salaries',
      'A MEMBER CANNOT MINT GHOST PAYEES UNDER THEIR OWN EMAIL — C26',
      'AND THE CAP REFUSES WITHOUT BURNING THE INVITE — C28',
    ],
  },
  {
    id: 2,
    binding: 'AND IT KEYS ON THE PERSON, NOT ONLY ON AN EMAIL — `X8` §3',
    file: 'src/core/payroll.ts',
    says: 'the cap goes back to comparing emails alone, which is exactly the state `X7` '
      + 'ran into: somebody who signed in with their wallet has none, so the cap sees '
      + 'nothing to compare and every wallet sign-in can be made payable again and again',
    from: "        (p.handedOverBy !== null && p.handedOverBy === acceptedBy)\n"
      + '        || (p.email !== null && person.email !== null\n'
      + '          && same(p.email) === same(person.email)));',
    to: '        p.email !== null && person.email !== null\n'
      + '        && same(p.email) === same(person.email));',
    kills: ['§3 AND ONE PAYABLE ENTRY PER PERSON, WITH NO EMAIL TO KEY ON'],
  },
  {
    id: 3,
    binding: 'THE ADDRESS IS THE WALLET’S AND IS NOT READ OUT OF THE REQUEST — `C153`',
    file: 'src/server/index.ts',
    says: 'the pasted address is put back: a caller that names an address in the body is '
      + 'served that address, which is `X7`’s box with the box hidden and `V-78` option 3 '
      + 'reopened — an operator supplying somebody else’s address',
    from: '    address: fromWallet.address,',
    to: "    address: (req.body as { address?: unknown }).address\n"
      + "      ? payeeAddress(String((req.body as { address?: unknown }).address), NETWORK)\n"
      + '      : fromWallet.address,',
    kills: ['A CALLER THAT NAMES ITS OWN ADDRESS IS NOT SERVED IT'],
  },
  {
    id: 4,
    binding: 'AND IT IS ONE THE WALLET WORKED OUT, NOT ONE SOMEBODY TYPED',
    file: 'src/core/wallet-payee.ts',
    says: 'a value marked as something a person STATED is accepted, so a typed address '
      + 'inside a real signature is taken as a derived one — `X7`’s precedent surviving '
      + 'with wallet chrome round it, and harder to argue with for being signed',
    from: "  if (sent.asserted.by !== 'wallet') {",
    to: '  if (false) {',
    kills: ['AN ADDRESS SOMEBODY TYPED IS NOT ONE THE WALLET WORKED OUT'],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-SELF-PAYEE.txt');

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

say(`MUTATING THE SELF-PAYEE DOOR  —  ${new Date().toISOString()}`);
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
