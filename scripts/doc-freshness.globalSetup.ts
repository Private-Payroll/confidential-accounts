/**
 * THE WIRING, AND NOTHING ELSE. Named by `vitest.config.ts`'s `globalSetup`.
 *
 * The logic is in `scripts/doc-freshness.ts`; this file holds no decision, so
 * there is nothing here that can be got wrong separately from the thing it is
 * testing. `scripts/artifact-freshness.globalSetup.ts` is the same shape for
 * the same reasons and its header carries them.
 *
 * THE ROOT IS DERIVED FROM THIS FILE'S OWN LOCATION rather than from
 * `process.cwd()` or from anything vitest hands in. A guard that reads its root
 * from the caller can be pointed at a directory with no documents in it, where
 * every block is `file-missing` and the guard argues with itself.
 *
 * The SECOND parameter is one vitest never supplies. It exists so that
 * `scripts/doc-freshness.test.ts` can call THIS function — not a copy of it —
 * against a fixture tree and watch it throw. There is no value of it that turns
 * the guard off, only one that points it at a different directory. The
 * alternative was a test that greps this file for the call, and an auditor has
 * already shown on `artifact-freshness` what that misses: a `try {} catch {}`
 * around the call, or an `if (process.env.NEVER_SET)` in front of it, leaves
 * the substring intact and the guard dead.
 */
import { fileURLToPath } from 'node:url';

import { assertDocsFresh } from './doc-freshness.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default async function setup(_project?: unknown, root: string = ROOT): Promise<void> {
  // AWAITED, AND THAT MATTERS MORE THAN IT LOOKS. `assertDocsFresh` renders the
  // documents to compare them, so it is async; a `setup` that called it without
  // awaiting would return a rejected promise vitest may or may not surface, and
  // a guard that MIGHT throw is a guard.
  await assertDocsFresh(root);
}
