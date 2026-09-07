/**
 * The entry point `npm run docs` runs, and the only thing that writes a
 * generated block. It holds no decision — `scripts/generate-docs.ts` is the
 * generator — so there is nothing here that can be got wrong separately.
 */
import { fileURLToPath } from 'node:url';

import { generate } from './generate-docs.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const written = await generate(ROOT);
if (written.length === 0) {
  console.log('  Nothing changed — every generated block already describes the artifacts on disk.');
} else {
  console.log(`  ${written.length} file(s) rewritten:`);
  for (const f of written) console.log(`      ${f}`);
}
