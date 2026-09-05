/**
 * The entry point `CITATIONS.command` runs. It holds no decision;
 * `scripts/citations.ts` is the checker, and the suite calls the same functions
 * over a narrower tree.
 */
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkFile, markdownUnder } from './citations.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tree = (process.argv[2] ?? '').trim();

const files = tree === ''
  ? [
      ...readdirSync(ROOT).filter((n) => n.endsWith('.md') && statSync(ROOT + n).isFile()),
      ...markdownUnder(ROOT, 'docs'),
      ...markdownUnder(ROOT, '.claude'),
    ]
  : markdownUnder(ROOT, tree);

let checked = 0;
let shorthand = 0;
let ignored = 0;
const findings: { file: string; at: number; raw: string; why: string }[] = [];
for (const f of files) {
  const r = checkFile(ROOT, f);
  checked += r.checked;
  shorthand += r.notCheckable;
  ignored += r.skippedIgnored;
  findings.push(...r.findings);
}

console.log('');
console.log(`  ${files.length} markdown file(s).`);
console.log('');
console.log(`      ${String(checked).padStart(5)}  citations checked against the file they name`);
console.log(`      ${String(shorthand).padStart(5)}  NOT CHECKABLE — package-relative, crate-relative or ambiguous bare filenames`);
console.log(`      ${String(ignored).padStart(5)}  into gitignored trees (midnight-src, node_modules, SAFE) — present here, absent in a clone`);
console.log('');
console.log('  The two skipped counts are printed rather than hidden. A skip nobody counts is a');
console.log('  hole nobody can see.');
console.log('');

if (findings.length === 0) {
  console.log('  Every checkable citation resolves.');
  console.log('');
  process.exit(0);
}

console.log(`  ${findings.length} CITATION(S) DO NOT RESOLVE:`);
console.log('');
for (const f of findings) {
  console.log(`      ${f.file}:${f.at}`);
  console.log(`          ${f.raw}`);
  console.log(`          ${f.why}`);
}
console.log('');
console.log('  NO DOOR RESOLVES THESE. Each one is a sentence to correct or a citation to move.');
console.log('');
process.exit(1);
