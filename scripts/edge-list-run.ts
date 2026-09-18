/**
 * WRITES THE MODULE MAP AND NOTHING ELSE.
 *
 * The map is a machine-readable graph of this system: which circuit writes
 * which ledger field, which client module reaches which circuit, and where
 * money flows through. It is derived from the source and the compiled contracts
 * on every run, so it is build output rather than a document, and it is not
 * kept in this repository.
 *
 * -- WHY IT HAS AN ENTRY POINT OF ITS OWN ----------------------------------
 *
 * Several checks read the map instead of building their own picture of the
 * graph, and they SKIP when it is not on disk. In a fresh checkout it is never
 * on disk, so those checks skip, and a suite that skips them is quieter than it
 * looks while saying nothing about why.
 *
 * The obvious way to produce it - the command that writes every generated thing
 * - also rewrites the generated regions of the design documents. Running that
 * before the tests would make the gate that compares those documents against
 * what the source derives compare them against something just written from the
 * same source, which is a gate that can no longer refuse anything. So this
 * writes the one artefact those checks need and touches no document.
 *
 * It is safe to run at any point because the map is not compared against
 * anything: it is regenerated whole, and a reader consults it rather than
 * editing it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EDGE_LIST_FILE } from './doc-registry.js';
import { render, withGeneratedAt } from './generate-docs.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const rendered = await render(ROOT);
const body = rendered.files.get(EDGE_LIST_FILE);
if (body === undefined) {
  throw new Error(
    `${EDGE_LIST_FILE} was not rendered, so nothing was written. The renderer names every file it ` +
      'produces, and this one is not among them: either the map has been given another name, in ' +
      'which case this entry point names the old one, or the renderer has stopped producing it.',
  );
}

const path = join(ROOT, EDGE_LIST_FILE);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, withGeneratedAt(body, new Date()));
console.log(`  ${EDGE_LIST_FILE} written; no document was touched.`);
