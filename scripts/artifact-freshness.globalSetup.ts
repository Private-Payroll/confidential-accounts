/**
 * THE WIRING, AND NOTHING ELSE. Named by `vitest.config.ts`'s `globalSetup`.
 *
 * `vitest` runs this ONCE, in the main process, before any worker evaluates any
 * test module — so a throw here stops the whole run with one message instead of
 * failing ninety-nine files one at a time. The logic is in
 * `artifact-freshness.ts`; this file holds no decision, so there is nothing here
 * that can be got wrong separately from the thing it is testing.
 *
 * THE ROOT IS DERIVED FROM THIS FILE'S OWN LOCATION rather than from
 * `process.cwd()` or from anything `vitest` hands in. A guard that reads its
 * root from the caller can be pointed at a directory with no contracts in it,
 * where every pair is `source-missing` and the guard argues with itself. This
 * file lives in `scripts/`, one level under the repository root, and that is
 * the only fact it needs.
 */
import { fileURLToPath } from 'node:url';

import { assertArtifactsFresh } from './artifact-freshness.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `vitest` calls this as `setup(project)` — `cli-api.…js:10746`, `await
 * globalSetupFile.setup?.(this)` — so the first parameter is taken and cannot
 * be a root. The SECOND is one vitest never supplies, and it exists so that
 * `artifact-freshness.test.ts` can call THIS function, not a copy of it,
 * against a fixture tree and watch it throw. It cannot skip anything: there is
 * no value of it that turns the guard off, only one that points it at a
 * different directory, and vitest passes none.
 *
 * The alternative was a test that greps this file for the call. An auditor
 * showed what that misses: wrapping the call in `try {} catch {}`, or behind
 * `if (process.env.NEVER_SET)`, leaves the substring intact and the guard dead.
 */
export default function setup(_project?: unknown, root: string = ROOT): void {
  assertArtifactsFresh(root);
}
