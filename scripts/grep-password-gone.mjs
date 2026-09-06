#!/usr/bin/env node
/**
 * **THE PASSWORD IS NOT LEFT ANYWHERE IN `src/`.** `docs/ROUND-PI4b.md`,
 *
 *
 * `scripts/grep-deleted-systems.mjs` for the round that followed it, and its
 * two rules are this file's rules:
 *
 * **COMMENTS MAY NAME WHAT USED TO BE THERE. CODE MAY NOT.** Several comments
 * deliberately do — a deletion with no explanation is a deletion somebody
 * undoes, and this round left the reason in `identity.ts`, `rate-limit.ts`,
 * `types.ts` and `Auth.tsx` on purpose. So comments are blanked before the
 * search and what is left is what actually runs.
 *
 * **AND IT IS SCOPED BY NAME, NOT BY THE WORD "PASSWORD".** That correction was
 * earned by `PI4`: a bare word-grep would forbid Midnight's own storage
 * password, the redactor that keeps a database credential out of every report,
 * and the sentence on the account screen telling a person their key is NOT made
 * from one. **A check loosened to go green is how this project has been burned
 * before**, so the check is narrowed to what is actually claimed instead.
 *
 * ── THE FILES THAT ARE ALLOWED TO SAY THESE WORDS IN CODE ────────────────
 *
 * Three kinds, and each is listed one at a time rather than by a pattern:
 *
 *   · the tests that ASSERT THE ABSENCE — they have to name what is absent;
 *   · the tests of the REDACTOR, which plant an `authKey` in a fake log line
 *     precisely to prove it is removed before anything is written down;
 *   · nothing else.
 *
 * A file added to this list is a claim that it is one of those two things.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ALLOWED = new Set([
  /* Assert the absence, over HTTP, in the built bundle, on the row, and in
   * the source of the one path that must never derive a key from a secret. */
  'src/server/password-is-gone.test.ts',
  'src/web/no-password-in-the-bundle.test.ts',
  'src/core/create-company.test.ts',
  'src/core/wallet-sign-in.test.ts',
  'src/core/core.test.ts',
  'src/server/server.test.ts',
  /* Plant a credential in a fake log line to prove the redactor removes it.
   * The redactor ships in production and is not a leak in any
   * direction — a person may still type a secret into the wrong field, and
   * third-party payloads are not ours to shape. */
  'src/core/redact-secrets.test.ts',
  'src/web/error-sink.test.ts',
  'src/server/web-console-sink.test.ts',
]);

const CHECKS = [
  ['the key material a password produced',
    /\bauthHash\b|\bauthSalt\b|\bderiveAuthMaterial\b/],
  ['the stretching',
    /argon2|@noble\/hashes\/argon2/],
  ['the two routes that took one',
    /auth\/login|auth\/register/],
];

const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/.*$/gm, '');

const files = execSync("find src -name '*.ts' -o -name '*.tsx' | sort", { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

let bad = 0;
for (const [name, rx] of CHECKS) {
  const hits = [];
  for (const f of files) {
    if (ALLOWED.has(f)) continue;
    strip(readFileSync(f, 'utf8')).split('\n').forEach((l, i) => {
      if (rx.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
  }
  console.log(`   ${name}: ${hits.length} code hits outside the files that assert it is gone`);
  for (const h of hits) { console.log(`     ${h}`); bad += 1; }
}
process.exit(bad === 0 ? 0 : 1);
