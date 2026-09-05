/**
 * The entry point `CITATIONS.command` runs. **`scripts/citations.ts` is the
 * checker** and the suite calls the same functions over a narrower tree; what
 * lives here is the SCOPE — which trees a run with no argument walks — and the
 * reporting.
 *
 * **THAT SENTENCE USED TO SAY *it holds no decision*, AND IT WAS ALREADY UNTRUE
 * WHEN IT WAS WRITTEN**: the tree list below was inline in the expression it
 * describes. It is named now, and printed, because the one decision this file
 * holds is exactly the one that was invisible.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkFile, markdownUnder } from './citations.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tree = (process.argv[2] ?? '').trim();

/**
 * THE TREES THIS WALKS WHEN IT IS GIVEN NOTHING, EACH NAMED SO ITS COUNT CAN BE
 * PRINTED BESIDE IT.
 *
 * ── AN ABSENT TREE USED TO BE WORTH EXACTLY NOTHING AND SAID SO NOWHERE ────
 *
 * `markdownUnder` walks with a `try/catch` that RETURNS on a directory it
 * cannot read, so a tree that is not there yields an empty list with no
 * message, no counter and no non-zero exit. This file then printed one number —
 * `N markdown file(s)` — with nothing to compare it against.
 *
 * **`.claude/` IS THE LIVE CASE AND IT IS NOT HYPOTHETICAL.** It holds four
 * markdown files here and is not in the repository, so a clone walks three
 * trees where this machine walks four and both print a single confident total.
 * **A skip nobody counts is a hole nobody can see** — this file's own words,
 * two paragraphs down, about a different skip.
 *
 * So each tree is named, its count is printed, and a tree that is not there is
 * printed as ABSENT rather than as zero. **Absent is not an error**: `.claude/`
 * is deliberately not in the repository, and a door that went red in every
 * clone over a deliberate decision is a door somebody removes.
 */
const TREES = ['docs', '.claude'] as const;

const rootMarkdown = readdirSync(ROOT).filter((n) => n.endsWith('.md') && statSync(ROOT + n).isFile());

const walked: { tree: string; count: number; present: boolean }[] = [];
const files = tree === ''
  ? [
      ...rootMarkdown,
      ...TREES.flatMap((t) => {
        const present = existsSync(ROOT + t);
        const found = present ? markdownUnder(ROOT, t) : [];
        walked.push({ tree: t, count: found.length, present });
        return found;
      }),
    ]
  : (() => {
      const present = existsSync(ROOT + tree);
      const found = present ? markdownUnder(ROOT, tree) : [];
      walked.push({ tree, count: found.length, present });
      return found;
    })();

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
if (tree === '') console.log(`      ${String(rootMarkdown.length).padStart(5)}  at the repository root`);
for (const w of walked) {
  console.log(w.present
    ? `      ${String(w.count).padStart(5)}  under ${w.tree}/`
    : `      ABSENT  ${w.tree}/ is not in this tree, so nothing under it was read`);
}
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
