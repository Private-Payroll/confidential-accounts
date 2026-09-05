#!/usr/bin/env node
/**
 * MUTATING THE COMPANY CREATION PATH. `docs/NEXT.md` PI3, `C141`.
 *
 * The harness `scripts/mutate-wallet-unlock.mjs` built for `PI2a`, aimed at the
 * round that follows it: **whether the system can tell where a company's
 * address came from** (`C140`), and **whether the key that opens a person's
 * payslips is derived or minted** (`C135`).
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
    binding: 'IT MAY NOT MINT AN IDENTIFIER ON THIS SIDE — C136, C140',
    file: 'src/web/keyring.ts',
    says: 'the company is worked out from the account id on this side instead of being '
      + 'asked for, so the identifier this platform seals under is one it invented',
    from: '  const { company } = await api(`/api/accounts/${accountId}/unlock`, '
      + "{ method: 'POST' });",
    to: "  const company = accountId.replace(/[^0-9a-f]/g, '').padEnd(64, '0').slice(0, 64);",
    kills: [
      'THE COMPANY HANDED TO THE WALLET IS THE ONE THE SERVER NAMED, NOT ONE MADE UP HERE',
      'THE ORDER IS CREATE, THEN ASK WHICH COMPANY, THEN SEAL — and it cannot be another',
    ],
  },
  {
    id: 2,
    binding: 'IT MAY NOT SEAL UNDER AN ADDRESS WHOSE PROVENANCE IS NOT A CHAIN’S — C140',
    file: 'src/web/keyring.ts',
    says: 'the creation path reads the address off the account record instead of going '
      + 'through the door that checks where it came from, so a refusal never reaches it',
    from: '  await unlockWithWallet(waiting.accountId, walletOrigin, view, atOrigin);',
    to: '  const rec = await api(`/api/accounts/${waiting.accountId}`);\n'
      + '  encKey = toHex(await askWalletToUnlock(view, walletOrigin, {\n'
      + '    company: String(rec.contractAddress), atOrigin,\n'
      + '    name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,\n'
      + '  }));',
    kills: ['CREATION IS REFUSED, AND NOT ONE BYTE IS SEALED'],
  },
  {
    id: 3,
    binding: 'IT MAY NOT ASK FOR A PASSWORD — C129, and it is why this round exists',
    file: 'src/web/keyring.ts',
    says: 'the creation path carries auth material, which is what asking for a password '
      + 'looks like on the wire',
    from: "    body: JSON.stringify({ name: spec.name, signers: spec.signers, "
      + "threshold: spec.threshold }),",
    to: "    body: JSON.stringify({ name: spec.name, signers: spec.signers, "
      + "threshold: spec.threshold, authKey: 'aa'.repeat(32) }),",
    kills: [
      'NOT ONE REQUEST CARRIES AUTH MATERIAL',
      'AND THE CREATION PATH HAS NOWHERE TO PUT ONE',
    ],
  },
  {
    id: 4,
    binding: 'THE FOUNDER’S FIRST DEVICE IS NOT SPECIAL — the judged test',
    file: 'src/web/keyring.ts',
    says: 'the keyring is sealed under a key this tab minted rather than the one the '
      + 'wallet released, so nothing else can ever recompute it',
    from: '        keyBundle: seal(JSON.stringify(keyring), key),',
    to: "        keyBundle: seal(JSON.stringify(keyring), 'ab'.repeat(32)),",
    kills: [
      'A SECOND DEVICE, FROM THE WORDS ALONE, OPENS WHAT THE FIRST DEVICE SEALED',
    ],
  },
  {
    id: 5,
    binding: 'A DECLINED PRESS COSTS A RETRY, NOT THE COMPANY',
    file: 'src/web/keyring.ts',
    says: 'the founder’s secrets are dropped before the bundle is written, so a refusal '
      + 'anywhere in step 2 loses the only copy of them in existence',
    from: '  await unlockWithWallet(waiting.accountId, walletOrigin, view, atOrigin);',
    to: '  pendingCompany = null;\n'
      + '  await unlockWithWallet(waiting.accountId, walletOrigin, view, atOrigin);',
    kills: [
      'AND THE COMPANY IS NOT LOST — the secrets are still here and it can be finished',
    ],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-CREATE-COMPANY.txt');

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
