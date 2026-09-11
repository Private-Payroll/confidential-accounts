#!/usr/bin/env node
/**
 * MUTATING THE WINDOW THE WALLET OPENS IN, AND THE REFUSAL THAT IS GONE.
 * `docs/NEXT.md` X9 §1 and §2, `docs/how-money-can-be-lost.md` `C154`.
 *
 * The harness `scripts/mutate-self-payee.mjs` grew, aimed at two things this
 * round changed: **when the window is opened**, and **what the platform
 * refuses.**
 *
 * **01 AND 02 ARE THE ROUND.** They put the open back BEHIND the await, which
 * is the state that shipped: a permission spent on a round trip to this
 * product's own server and then a window asked for with it gone. Chromium
 * forgives a few seconds of that and Safari and Firefox do not, so the defect
 * was invisible on the machine it was walked on and total everywhere else.
 * **A test that awaited the whole journey would pass under both orders**, which
 * is exactly how it shipped, so the tests these kill do not await it.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-wallet-dialog.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
/*
 * **TWO SUITES, AND THE NARROWNESS IS DELIBERATE.** Every binding below lives
 * in one of these two files, and the other wallet suites — `create-company`,
 * `wallet-unlock`, `wallet-sign-in` — AWAIT the whole journey, so they pass
 * under either order by construction. Naming them here would pad the counts
 * with suites that cannot fail, which is the shape of a mutation report that
 * looks thorough and proves less. They are run alongside by
 * `WALLET-DIALOG-CHECK.command` as an ordinary regression, which is what they
 * are.
 */
const SUITES = [
  'src/web/wallet-dialog.test.ts',
  'src/server/two-companies.test.ts',
];
const OUT = join(ROOT, 'logs', 'mutate-wallet-dialog');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'THE SIGN-IN OPENS THE WINDOW IN THE CLICK — `C154`',
    file: 'src/web/keyring.ts',
    says: 'the open goes back behind the challenge, which is the state that shipped: by '
      + 'the time a window is asked for the click is over, so Safari and Firefox refuse it '
      + 'outright and a slow answer refuses it everywhere',
    from: '  const dialog = openTheWallet(view, walletOrigin);\n'
      + '  try {\n'
      + "    const challenge = await api('/api/auth/wallet/challenge', { method: 'POST' });",
    to: '  let dialog!: WalletDialog;\n'
      + '  try {\n'
      + "    const challenge = await api('/api/auth/wallet/challenge', { method: 'POST' });\n"
      + '    dialog = openTheWallet(view, walletOrigin);',
    kills: ['WATCHED FAILING: SIGNING IN OPENS THE WALLET BEFORE THE CHALLENGE IS ASKED FOR'],
  },
  {
    id: 2,
    binding: 'A COMPANY\'S KEY FOR A PAYSLIP OPENS THE WINDOW IN THE CLICK',
    file: 'src/web/keyring.ts',
    says: 'the open goes back behind the question of which company may be opened - the same '
      + 'shape as the sign-in: the permission is spent on a round trip before it is used',
    from: "  const dialog = openTheWallet(view, walletOrigin);\n  let companyKey = companyKeyReleasedFor(accountId);\n  /* **TWO ASKS, ONE WINDOW.** An ask that settles closes its window unless it was\n   * told another is coming, and the second would then meet a window that is gone.\n   * So the window is this journey's, and the journey closes it. */\n  const twoAsks = companyKey === null;\n  if (twoAsks) dialog.moreThanOneAsk();",
    to: "  let dialog!: WalletDialog;\n  let companyKey = companyKeyReleasedFor(accountId);\n  /* **TWO ASKS, ONE WINDOW.** An ask that settles closes its window unless it was\n   * told another is coming, and the second would then meet a window that is gone.\n   * So the window is this journey's, and the journey closes it. */\n  const twoAsks = companyKey === null;\n",
    also: {
      file: 'src/web/keyring.ts',
      from: "      const { company } = await api(`/api/accounts/${accountId}/unlock`, { method: 'POST' });\n"
        + '      await openKeysOnceOpen(',
      to: "      const { company } = await api(`/api/accounts/${accountId}/unlock`, { method: 'POST' });\n"
        + '      dialog = openTheWallet(view, walletOrigin);\n'
        + '      if (twoAsks) dialog.moreThanOneAsk();\n'
        + '      await openKeysOnceOpen(',
    },
    kills: ["WATCHED FAILING: A COMPANY'S KEY OPENS THE WALLET BEFORE IT ASKS WHICH COMPANY"],
  },
  {
    id: 3,
    binding: 'A WALLET MAY CREATE A SECOND COMPANY — `C155`',
    file: 'src/server/index.ts',
    says: 'the refusal is put back on the creation door, in the shape it had: any wallet '
      + 'user already on any account is refused, so a founder can create exactly one '
      + 'company ever and the refusal talks to them about employers',
    from: '  const signers = body.signers.map(',
    to: '  if (store.accountsForUser(req.userId!).length > 0) {\n'
      + '    res.status(409).json({\n'
      + "      error: 'this wallet address is already used by another employer on this "
      + "platform',\n"
      + "      code: 'subwallet-already-bound',\n"
      + '    });\n'
      + '    return;\n'
      + '  }\n'
      + '  const signers = body.signers.map(',
    kills: [
      'WATCHED FAILING: ONE WALLET, TWO COMPANIES, AND THE SECOND IS NOT REFUSED',
      'AND A THIRD IS NOT A SPECIAL CASE EITHER',
      'NOTHING ANSWERS `subwallet-already-bound` ANY MORE, on any of these doors',
    ],
  },
  {
    id: 4,
    binding: 'IT IS A DIALOG RATHER THAN A TAB — `C154`',
    file: 'src/web/wallet-sign-in.ts',
    says: 'the window features go away and the target goes back to `_blank`, which is what '
      + 'made it a tab: no size, no position, no name, so a second ask stacks a third '
      + 'window behind the second and nothing is ever brought forward',
    from: '  const wallet = view.open(dialogUrl(walletOrigin), WALLET_DIALOG_NAME, '
      + 'featuresFor(view));',
    to: "  const wallet = view.open(`${walletOrigin}/#/approve`, '_blank');",
    kills: [
      'WATCHED FAILING: it is opened with a size and centred on the page that opened it',
      'WATCHED FAILING: A SECOND ASK REUSES THE WINDOW AND BRINGS IT FORWARD',
    ],
  },
  {
    id: 5,
    binding: 'THE REFUSAL DOES NOT BLAME THE PERSON — `C154`',
    file: 'src/web/wallet-sign-in.ts',
    says: 'the old sentence comes back — *allow pop-ups for this site* — which is advice '
      + 'for a problem the person does not have, because the page gave the permission '
      + 'away rather than the browser withholding it',
    from: "const NO_WINDOW_SAYS =\n"
      + "  'your wallet window did not open, so nothing has been signed and nothing has "
      + "been sent. '",
    to: "const NO_WINDOW_SAYS =\n"
      + "  'your browser stopped this page opening your wallet. Allow pop-ups for this "
      + "site. '",
    kills: ['WATCHED FAILING: A WINDOW THAT DID NOT OPEN DOES NOT BLAME THE PERSON’S BROWSER'],
  },
];

/*
 * **`--suites=` NARROWS THE RUN, AND SAYS SO IN THE REPORT.** It exists for one
 * reason: this harness also runs under a call cap that kills it at 45
 * seconds, and a mutation whose report is truncated by a timeout leaves the
 * tree mutated and proves nothing. On the machine that owns the folder there is
 * no such cap and `WALLET-DIALOG-CHECK.command` passes none, so the ordinary
 * run is the whole list above.
 */
const narrowed = (process.argv.find(a => a.startsWith('--suites=')) ?? '').slice(9);
if (narrowed) SUITES.length = 0, SUITES.push(...narrowed.split(','));

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-WALLET-DIALOG.txt');

mkdirSync(OUT, { recursive: true });

/** Runs the suites and returns the titles that failed, plus the two counts. */
function runSuite(tag) {
  const file = join(OUT, `${tag}.json`);
  try { writeFileSync(file, ''); } catch { /* first run */ }
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
 * **A KILLED RUN PUTS THE FILES BACK, AND IT DOES NOT RELY ON A SIGNAL.**
 * The reasoning is `scripts/mutate-self-payee.mjs`'s and it was learned twice:
 * `runSuite` blocks the event loop, so a `SIGTERM` arriving mid-suite cannot be
 * serviced until the call it would interrupt has finished, and a `SIGKILL` never
 * reaches JavaScript at all. This harness runs under a 45-second call cap, so
 * being killed part way through is the ORDINARY case.
 *
 * So the record of what is in flight lives ON DISK, written before the mutation
 * and emptied after the restore. Nothing has to survive for it to work: the
 * NEXT run reads it, puts the files back and says so before doing anything else.
 *
 * **CLEARED, NOT DELETED.** `rm` is refused on a mounted folder, so a
 * delete fails, is swallowed, and leaves a journal that makes the next run
 * announce a recovery that did not happen. Writing an empty record needs no
 * delete permission anywhere.
 */
const JOURNAL = join(OUT, 'in-flight.json');

const beginMutation = (edits) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify(edits));
};

const endMutation = (edits) => {
  for (const e of edits) writeFileSync(e.path, e.before);
  writeFileSync(JOURNAL, '[]');
};

/** Puts back whatever a previous run was killed in the middle of. */
function recoverFromLastRun(say) {
  let held;
  try { held = JSON.parse(readFileSync(JOURNAL, 'utf8')); } catch { return; }
  if (!Array.isArray(held) || held.length === 0) return;
  for (const e of held) {
    if (e?.path && typeof e.before === 'string') writeFileSync(e.path, e.before);
  }
  writeFileSync(JOURNAL, '[]');
  say('  A PREVIOUS RUN WAS KILLED WITH A MUTATION STILL IN THE TREE.');
  for (const e of held) say(`  ${e.path} has been put back before anything else was done.`);
  say('');
}

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

say(`MUTATING THE WALLET DIALOG AND THE SECOND COMPANY  —  ${new Date().toISOString()}`);
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
  const parts = [{ file: m.file, from: m.from, to: m.to }];
  if (m.also) parts.push(m.also);

  say(`${String(m.id).padStart(2, '0')}  ${m.binding}`);
  say(`    breaks: ${m.says}`);

  /*
   * **TWO EDITS IN ONE FILE ARE APPLIED IN SEQUENCE, NOT SIDE BY SIDE.**
   * Learned here, by a mutation that SURVIVED and should not have: each part
   * was read from disk and written back independently, so the second write
   * threw the first away and the harness reported a hole where the code was
   * still broken in only one of the two places. **A mutation harness that can
   * quietly half-apply a mutation is worse than none**, because its green
   * lines are the evidence somebody else is going to trust.
   */
  let bad = false;
  const held = new Map();
  const working = new Map();
  for (const part of parts) {
    const path = join(ROOT, part.file);
    if (!held.has(path)) {
      const before = readFileSync(path, 'utf8');
      held.set(path, before);
      working.set(path, before);
    }
    const soFar = working.get(path);
    const hits = soFar.split(part.from).length - 1;
    if (hits === 0) {
      say('    STALE MUTATION — that text is not in the file any more. NOT RUN.');
      say(`      ${part.file}: ${part.from.trim().split('\n')[0]}`);
      bad = true;
      break;
    }
    if (hits > 1) {
      say(`    AMBIGUOUS TARGET — that text appears ${hits} times, so which copy was`);
      say('    broken is unknown. NOT RUN.');
      bad = true;
      break;
    }
    working.set(path, soFar.replace(part.from, part.to));
  }
  const edits = [...held.keys()].map(
    path => ({ path, before: held.get(path), after: working.get(path) }));
  if (bad) { say(''); stale += 1; continue; }

  const missing = m.kills.filter(t => !known.has(t));
  if (missing.length) {
    say('    STALE EXPECTATION — it names a test that is not in the suite:');
    for (const t of missing) say(`      "${t}"`);
    say('');
    stale += 1;
    continue;
  }

  beginMutation(edits.map(e => ({ path: e.path, before: e.before })));
  for (const e of edits) writeFileSync(e.path, e.after);
  let result;
  try {
    result = runSuite(`mutation-${m.id}`);
  } finally {
    endMutation(edits);
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
    say(`    KILLED by ${result.failed.length} test${result.failed.length === 1 ? '' : 's'}:`);
    for (const t of named) say(`      ✓ ${t}`);
    for (const t of m.kills.filter(x => !named.includes(x))) {
      say(`      ! EXPECTED TO DIE AND DID NOT: ${t}`);
    }
    for (const t of result.failed.filter(t => !m.kills.includes(t))) say(`      + also: ${t}`);
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
