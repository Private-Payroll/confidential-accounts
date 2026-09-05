/** The entry point `WHAT-BREAKS.command` runs. It holds no decision. */
import { fileURLToPath } from 'node:url';

import { answer, index, loadEdges } from './what-breaks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const name = (process.argv[2] ?? '').trim();

try {
  const edges = loadEdges(ROOT);
  console.log(name === '' ? index(edges) : answer(edges, name));
} catch (e) {
  console.log('\n  ' + String((e as Error).message) + '\n');
  process.exit(1);
}
