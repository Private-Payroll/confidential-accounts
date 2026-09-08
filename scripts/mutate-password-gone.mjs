#!/usr/bin/env node
/**
 * MUTATING THE PASSWORD BACK IN. This harness puts it back so the
 * guard next door can be watched failing. `C129`.
 *
 * The harness `scripts/mutate-deleted-systems.mjs` built for `PI4a`, aimed at
 * the round that finished what it started: **a deletion leaves no code to fail
 * when somebody puts it back**, so every piece of the password is written back
 * here, one at a time, and each names the test that has to die.
 *
 * FOUR SUITES, AND THE SPREAD IS THE POINT.
 *
 *   · `password-is-gone.test.ts` drives real HTTP, because a route answering
 *     404 is a claim about a ROUTE and nothing below the server can make it.
 *   · `no-password-in-the-bundle.test.ts` BUILDS THE APP, because *the code is
 *     not in the file the browser downloads* is the claim that matters and
 *     reading the source is a different one. It is also the slowest thing in
 *     this harness by a wide margin, and it is worth it.
 *   · `auth-screen.test.tsx` RENDERS the screen, because the failure a password
 *     leaves behind is a form a person is shown, not a string in a file.
 *   · `wallet-sign-in.test.ts` is included because **the row a sign-in leaves
 *     is where `authHash` and `authSalt` would come back**, and because S-2's
 *     lesson moved into it this round.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-password-gone.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SUITES = [
  'src/server/password-is-gone.test.ts',
  'src/web/no-password-in-the-bundle.test.ts',
  'src/web/auth-screen.test.tsx',
  'src/core/wallet-sign-in.test.ts',
];
const OUT = join(ROOT, 'logs', 'mutate-password-gone');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
const MUTATIONS = [
  {
    id: 1,
    binding: 'THE ROUTE THAT TOOK A PASSWORD STAYS DELETED — `/api/auth/login`',
    file: 'src/server/index.ts',
    says: 'a login route comes back, so a client-stretched key is a way in again — which '
      + 'is the whole of what this round removed, arriving without anybody having to '
      + 'write a password check',
    from: "app.get('/api/me/sessions', authed, wrap(async (req, res) => {",
    to: "app.post('/api/auth/login', wrap(async (_q, s) => { s.json({ ok: true }); }));\n"
      + "app.get('/api/me/sessions', authed, wrap(async (req, res) => {",
    kills: ['THE TWO ROUTES THAT TOOK ONE ANSWER 404 — they are deleted, not disabled'],
  },
  {
    id: 2,
    binding: 'AND SO DOES `/api/auth/register`, WHICH IS THE ONE THAT WROTE THE HASH',
    file: 'src/server/index.ts',
    says: 'the registration route comes back. It was the only writer of `authHash` and '
      + '`authSalt`, so this is the door through which a password returns to the STORE '
      + 'rather than merely to a request',
    from: "app.post('/api/auth/wallet/challenge', wrap(async (req, res) => {",
    to: "app.post('/api/auth/register', wrap(async (_q, s) => { s.json({ ok: true }); }));\n"
      + "app.post('/api/auth/wallet/challenge', wrap(async (req, res) => {",
    kills: ['THE TWO ROUTES THAT TOOK ONE ANSWER 404 — they are deleted, not disabled'],
  },
  {
    id: 3,
    binding: 'A PASSWORD FIELD DOES NOT COME BACK ONTO THE SIGN-IN SCREEN',
    file: 'src/web/Auth.tsx',
    says: 'the password input is put back on the screen — the FIELD alone, with no '
      + 'stretching and no route behind it, which is exactly how one returns: as a '
      + 'harmless-looking bit of markup somebody wires up afterwards',
    /*
     * **ANCHORED ON THE HEADING AND NOT ON THE ERROR LINE.** The first draft
     * used `{err && <div className="autherr">{err}</div>}`, which appears in
     * BOTH components in this file — and the harness refused it as an
     * `AMBIGUOUS TARGET` rather than breaking whichever copy it found first.
     * That refusal is the reason this harness has one.
     */
    from: '        <h1>Sign in</h1>',
    to: '        <h1>Sign in</h1>\n'
      + '        <label>Password\n'
      + '          <input type="password" required minLength={10}\n'
      + '            placeholder="At least 10 characters" />\n'
      + '        </label>',
    kills: [
      'HAS NO FIELD OF ANY KIND — not a password one, and not an email one either',
      'THE ONE THAT SAYS IT SHIPS NOTHING: a production bundle carries no password field, '
        + 'no route that took one, and no stretching',
      'and a DEVELOPMENT build carries no password path either — this was not a mode flag',
      'AND NOTHING ON IT OFFERS TO CREATE AN ACCOUNT OR SWAP TO A PASSWORD',
    ],
  },
  {
    id: 4,
    binding: 'AND NEITHER DOES THE FORM IT WOULD SIT IN',
    file: 'src/web/Auth.tsx',
    says: 'a `<form>` appears on the card again. A form with no fields does nothing — and '
      + 'it is one field away from doing everything, which is why the element is asserted '
      + 'and not only its contents',
    /*
     * **A SELF-CLOSING `<form />` RATHER THAN RE-WRAPPING THE CARD.** The first
     * draft changed the opening `<div className="authcard">` to a `<form>` and
     * left the closing tag alone — **which does not compile**, so the build
     * failed and three tests died of a syntax error rather than of the thing
     * being tested. A mutation that cannot compile proves nothing: it does not
     * ask whether anything is watching the binding, it asks whether the
     * compiler works. This one is valid JSX and renders a real `<form>`.
     */
    from: '        <button type="button" className="primary" disabled={busy} onClick={withWallet}>',
    to: '        <form />\n'
      + '        <button type="button" className="primary" disabled={busy} onClick={withWallet}>',
    kills: ['AND THERE IS NO FORM TO SUBMIT, so there is nothing for a field to come back into'],
  },
  {
    id: 5,
    binding: 'THE STRETCHING STAYS OUT OF THE BUNDLE — argon2id is not in the graph',
    file: 'src/web/Auth.tsx',
    says: 'argon2id is pulled into the browser again and run on the sign-in path. **This '
      + 'is the mutation the bundle test exists for**: it adds no field and no route, so '
      + 'nothing a person can see changes and nothing a route can answer changes, and the '
      + 'only thing that can notice is the built output',
    /*
     * **IT HAS TO BE REACHABLE, AND THE FIRST DRAFT WAS NOT.** That draft added
     * an exported `stretch()` to `keyring.ts` and **SURVIVED** — correctly. An
     * export nobody calls is tree-shaken out, so it was never in the bundle,
     * so no test could see it and none should have. **That is the bundle test
     * working, not failing**: the claim is about what the browser downloads,
     * and dead code is not downloaded.
     *
     * So this puts the stretching where it would actually come back: inside the
     * click that signs somebody in. The dynamic import lands in a chunk of its
     * own, which `markersIn` reads too — it searches every emitted asset rather
     * than the entry file, and this is why.
     */
    from: '      onDone(await keyring.signInWithWallet(WALLET_ORIGIN));',
    to: "      const { argon2id } = await import('@noble/hashes/argon2.js');\n"
      + "      argon2id(new TextEncoder().encode('typed by a person'),\n"
      + "        new TextEncoder().encode('a salt from somewhere'),\n"
      + '        { m: 19456, t: 2, p: 1, dkLen: 32 });\n'
      + '      onDone(await keyring.signInWithWallet(WALLET_ORIGIN));',
    kills: [
      'THE ONE THAT SAYS IT SHIPS NOTHING: a production bundle carries no password field, '
        + 'no route that took one, and no stretching',
      'and a DEVELOPMENT build carries no password path either — this was not a mode flag',
    ],
  },
  {
    id: 6,
    binding: 'NOTHING A PASSWORD LEFT BEHIND COMES BACK ONTO A PERSON — `authHash`',
    file: 'src/core/wallet-identity.ts',
    says: 'the row a wallet sign-in creates carries `authHash` again. It is null, which is '
      + 'the point: a field that is always absent reads as harmless, and it is the shape '
      + 'the whole password path grew back into last time it existed',
    from: "      keyBundle: null,\n      keyBundleVersion: 0,\n      walletKey: walletKeyOf(address),",
    to: "      keyBundle: null,\n      keyBundleVersion: 0,\n      authHash: null,\n"
      + "      walletKey: walletKeyOf(address),",
    /*
     * **NAMES ONLY THE TEST THAT ACTUALLY DIES.** The first draft also named
     * `password-is-gone.test.ts`'s *THE ROW A SIGN-IN LEAVES CARRIES NO HASH,
     * NO SALT AND NO KEY MATERIAL*, and the harness reported it as EXPECTED TO
     * DIE AND DID NOT — **correctly, and the reason is worth keeping.** That
     * test asks the ROUTES, and `/api/me` projects `{ id, email, name }` rather
     * than handing back the row, so a field on the row never reaches a
     * response. Both claims are worth making and only one of them is what this
     * mutation breaks.
     */
    kills: ['NO EMAIL, NO PASSWORD AND NO NAME — nothing asked for any of them'],
  },
  {
    id: 7,
    binding: 'AND THE KEY ROUTE STILL HANDS BACK EXACTLY TWO THINGS',
    file: 'src/server/index.ts',
    says: 'a third field appears beside the bundle. `PI4a` deleted `bundleKey` — the half '
      + 'a password unwrapped — and an exact key set is what stops one creeping back in '
      + 'under a client that no longer reads it',
    from: '  res.json({\n    keyBundle: u.keyBundle,',
    to: '  res.json({\n    keyBundle: u.keyBundle, bundleKey: null,',
    kills: ['AND THE KEY ROUTE HANDS BACK EXACTLY TWO THINGS'],
  },
  {
    id: 8,
    binding: 'S-2 MOVED WITH THE DOOR — the wallet sign-in counts',
    file: 'src/core/wallet-identity.ts',
    says: 'the sign-in stops counting on the limiter, which is exactly the state S-2 was '
      + 'written against: a limiter that is finished, correct, and not called. `login` '
      + 'used to be where this could go wrong; this is where it can go wrong now',
    from: '  private async limit(ctx: RequestContext): Promise<void> {\n    if (!ctx.ip) return;',
    to: '  private async limit(ctx: RequestContext): Promise<void> {\n    if (ctx.ip) return;\n'
      + '    if (!ctx.ip) return;',
    kills: [
      'ASKING FOR A CHALLENGE COUNTS, so nobody can mint nonces for free',
      'AND THE SIGN-IN ITSELF COUNTS — a correct one is refused once the address is over',
      'the refusal says how long to wait and nothing about who was asking',
    ],
  },
  {
    id: 9,
    binding: 'AND THE WAY IN IS STILL THERE — the presence, not an absence',
    file: 'src/web/Auth.tsx',
    says: 'the wallet button loses the words it is found by. Every other mutation here '
      + 'asserts that something is MISSING, and all of them would pass just as well '
      + 'against a screen with nothing on it at all',
    from: "          {busy ? 'Waiting for your wallet' : 'Sign in with your wallet'}",
    to: "          {busy ? 'Waiting' : 'Continue'}",
    kills: [
      'SHOWS ONE WAY IN, AND IT IS THE WALLET',
      'AND THE SAME BUILD DOES CARRY THE WALLET, so the check above can fail',
    ],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-PASSWORD-GONE.txt');

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

say(`MUTATING THE PASSWORD BACK IN  —  ${new Date().toISOString()}`);
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
