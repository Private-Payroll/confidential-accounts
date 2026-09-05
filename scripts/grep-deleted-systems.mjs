#!/usr/bin/env node
/**
 * **NEITHER DELETED SYSTEM IS LEFT ANYWHERE IN `src/`.** `docs/NEXT.md` PI4a.
 *
 * Comments may name what used to be there — several deliberately do, because a
 * deletion with no explanation is a deletion somebody undoes. **Code may not.**
 * So comments are blanked before the search, exactly as `wallet-unlock.test.ts`
 * does it, and what is left is what actually runs.
 *
 * **IT IS SCOPED TO THESE TWO SYSTEMS BY NAME**, and that is the correction
 * `PI4` earned: a bare word-grep for `password` would have forbidden Midnight's
 * own storage password, the redactor that keeps a database credential out of
 * every report, and a list of what kinds of login factor can exist. **A check
 * loosened to go green is how this project has been burned before**, so the
 * check is narrowed to what is actually claimed instead.
 *
 * The one place these names are still allowed to appear in code is the test
 * that asserts the routes answer 404, which is listed explicitly.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ALLOWED = new Set(['src/server/deleted-systems.test.ts']);

const CHECKS = [
  ['the device-envelope system',
    /\bbundleKey\b|\bbundleKeyId\b|DeviceService|putDevice|getDevice|listDevices|replaceDeviceEnvelope|me\/devices|keys\/upgrade/],
  ['the account recovery flow',
    /recoveryChallenge|recoverWithSeed|setPasswordWithSeed|auth\/recover/],
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
  console.log(`   ${name}: ${hits.length} code hits outside the test that asserts it is gone`);
  for (const h of hits) { console.log(`     ${h}`); bad += 1; }
}
process.exit(bad === 0 ? 0 : 1);
