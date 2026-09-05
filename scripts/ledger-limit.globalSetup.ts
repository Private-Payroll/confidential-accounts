/**
 * THE WIRING, AND NOTHING ELSE. Named by `vitest.config.ts`'s `globalSetup`.
 *
 * The logic is in `scripts/ledger-limit.ts`. Same shape and same reasoning as
 * `scripts/artifact-freshness.globalSetup.ts`, whose header carries them: the
 * root comes from this file's own location, and the second parameter — which
 * vitest never supplies — exists so the test can call THIS function against a
 * fixture tree and watch it throw, rather than grepping this file for the call.
 */
import { fileURLToPath } from 'node:url';

import { assertLedgerLimit } from './ledger-limit.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default function setup(_project?: unknown, root: string = ROOT): void {
  assertLedgerLimit(root);
}
