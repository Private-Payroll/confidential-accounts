import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROMISE_ENTRIES_ALLOWED, rises } from './suppressions-fall.mjs';

const ANY = '@typescript-eslint/no-explicit-any';
const AWAIT = '@typescript-eslint/await-thenable';
const one = (count) => ({ count });
const allowed = [...PROMISE_ENTRIES_ALLOWED][0];

test('a record that fell or stayed the same may land', () => {
  assert.deepEqual(rises({ 'a.ts': { [ANY]: one(3) } }, { 'a.ts': { [ANY]: one(2) } }), []);
  assert.deepEqual(rises({ 'a.ts': { [ANY]: one(3) } }, { 'a.ts': { [ANY]: one(3) } }), []);
});

test('a file that records more of a rule is refused', () => {
  // RED WHEN a file's own count may rise while another file's falls: a fix in one file would pay for a new violation in another.
  assert.equal(
    rises(
      { 'a.ts': { [ANY]: one(3) }, 'b.ts': { [ANY]: one(3) } },
      { 'a.ts': { [ANY]: one(4) }, 'b.ts': { [ANY]: one(1) } }
    ).length,
    1
  );
});

test('a rule whose total rose is refused', () => {
  // RED WHEN only files already recorded are compared: a new file would bring new violations in unrecorded.
  assert.equal(
    rises({ 'a.ts': { [ANY]: one(1) } }, { 'a.ts': { [ANY]: one(1) }, 'c.ts': { [ANY]: one(1) } })[0],
    `${ANY}: 2 recorded, 1 before`
  );
});

test('a file split in two keeps its count across the new files', () => {
  // RED WHEN a new path may not take a count: every split or rename of a file with violations would be refused.
  assert.deepEqual(
    rises({ 'a.ts': { [ANY]: one(4) } }, { 'a1.ts': { [ANY]: one(2) }, 'a2.ts': { [ANY]: one(2) } }),
    []
  );
});

test('a new path may not take what a kept file gave up', () => {
  // RED WHEN a new path may take any count while the rule's total holds: violations would move into new files.
  assert.equal(
    rises({ 'a.ts': { [ANY]: one(2) } }, { 'a.ts': { [ANY]: one(0) }, 'new.ts': { [ANY]: one(2) } }).length,
    1
  );
});

test('a file that stays may not take a rule it never recorded', () => {
  // RED WHEN a kept file may take a new rule's count from a rule another file gave up.
  assert.equal(
    rises(
      { 'a.ts': { [ANY]: one(1) }, 'b.ts': { [ANY]: one(1) } },
      { 'a.ts': { [ANY]: one(1) }, 'b.ts': { [ANY]: one(0), '@typescript-eslint/no-shadow': one(1) } }
    ).length,
    2
  );
});

test('a promise violation is recorded only where it is listed', () => {
  // RED WHEN a promise rule may be recorded anywhere: an unawaited payment step could be recorded instead of fixed.
  assert.equal(rises({ 'x.ts': { [AWAIT]: one(1) } }, { 'x.ts': { [AWAIT]: one(1) } }).length, 1);
  assert.deepEqual(rises({ [allowed]: { [AWAIT]: one(2) } }, { [allowed]: { [AWAIT]: one(1) } }), []);
});
