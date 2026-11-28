// Refuses an eslint-suppressions.json that records more than the base branch's copy, or a promise entry not listed below.
// Usage: node .github/checks/suppressions-fall.mjs <the base branch's copy, or a missing path> <this change's copy>

import { existsSync, readFileSync } from 'node:fs';

export const PROMISE_RULES = new Set([
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/await-thenable'
]);

// Awaits of store calls that become correct when those calls become asynchronous, and two deliberate waits of one turn
// in a test of ordering. Each entry goes when its count reaches zero; none may be added.
export const PROMISE_ENTRIES_ALLOWED = new Set([
  'src/core/one-writer-for-a-proposal.test.ts',
  'src/server/a-seat-taken-by-address-is-admitted-only-on-the-invitation-its-proposal-carries.test.ts',
  'src/server/a-signer-invited-by-address-is-approved-and-admitted-from-another-seat.test.ts',
  'src/server/a-signer-invited-by-address-is-seated-by-their-own-wallet.test.ts',
  'src/server/a-signer-invited-by-address-sets-a-new-threshold.test.ts',
  'src/server/a-signer-invited-by-address.test-support.ts'
]);

const totals = (record) => {
  const out = new Map();
  for (const rules of Object.values(record)) {
    for (const [rule, { count }] of Object.entries(rules)) out.set(rule, (out.get(rule) ?? 0) + count);
  }
  return out;
};

/** Every reason `head` records more than `base` allows; empty when it may land. */
export const rises = (base, head) => {
  const out = [];
  const before = totals(base);
  for (const [rule, total] of totals(head)) {
    if (total > (before.get(rule) ?? 0)) out.push(`${rule}: ${total} recorded, ${before.get(rule) ?? 0} before`);
  }
  // A path new here may take, per rule, only what paths gone from here held: a split or a rename, never a move.
  const gone = totals(Object.fromEntries(Object.entries(base).filter(([file]) => !(file in head))));
  const added = totals(Object.fromEntries(Object.entries(head).filter(([file]) => !(file in base))));
  for (const [rule, total] of added) {
    if (total > (gone.get(rule) ?? 0))
      out.push(`${rule}: ${total} recorded on new paths, ${gone.get(rule) ?? 0} on paths gone`);
  }
  for (const [file, rules] of Object.entries(head)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      if (PROMISE_RULES.has(rule) && !PROMISE_ENTRIES_ALLOWED.has(file))
        out.push(`${file}: ${rule} may not be recorded`);
      const was = base[file]?.[rule]?.count;
      if (was !== undefined ? count > was : base[file] !== undefined) {
        out.push(`${file}: ${rule} ${count} recorded, ${was ?? 0} before`);
      }
    }
  }
  return out;
};

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

if (process.argv[1] && process.argv[1].endsWith('suppressions-fall.mjs')) {
  const [basePath, headPath] = process.argv.slice(2);
  const head = read(headPath) ?? {};
  const base = read(basePath);
  if (base === null) {
    console.log('no recorded violations on the base branch: this change sets the first record');
    process.exit(0);
  }
  const found = rises(base, head);
  for (const line of found) console.error(line);
  process.exit(found.length === 0 ? 0 : 1);
}
