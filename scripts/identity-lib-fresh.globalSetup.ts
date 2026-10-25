/**
 * Refuses a test run on a stale identity library (`identity-lib-fresh.ts` says why), before any test loads it.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertIdentityLibFresh } from './identity-lib-fresh.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default function setup(_project?: unknown, root: string = ROOT): void {
  assertIdentityLibFresh(join(root, 'packages', 'identity'));
}
