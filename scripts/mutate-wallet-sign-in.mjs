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
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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

mkdirSync(OUT, { recursive: true });

/** Runs the suite and returns the titles that failed, plus the two counts. */
function runSuite(tag) {
  const file = join(OUT, `${tag}.json`);
  try { rmSync(file); } catch { /* first run */ }
  try {
    execFileSync('./node_modules/.bin/vitest',
      ['run', SUITE, '--reporter=json', `--outputFile=${file}`],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* a failing suite exits non-zero, which is the ordinary case here */ }
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return { ran: false, failed: [], passed: 0, failures: 0, titles: [] }; }
  const assertions = json.testResults.flatMap(r => r.assertionResults ?? []);
  return {
    ran: true,
    titles: assertions.map(a => a.title),
    failed: assertions.filter(a => a.status === 'failed').map(a => a.title),
    passed: assertions.filter(a => a.status === 'passed').length,
    failures: assertions.filter(a => a.status === 'failed').length,
  };
}

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
