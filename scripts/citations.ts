/**
 * A `file:line` CITATION THAT NO LONGER RESOLVES IS A FALSE CLAIM ABOUT WHERE
 * THE EVIDENCE IS.
 *
 * `docs/the-doc-set.md` §10 accepts the cost knowingly: the design set goes to
 * GitHub, which makes every sentence in it a public truth claim about a system
 * that holds money, and rule 14 says such a claim is checked when it is
 * WRITTEN. Without a mechanical check the set becomes the largest surface of
 * unverified claims in the repository.
 *
 * THE FAILURE THIS EXISTS FOR HAS A NAME. `SC7` cited a compiler path that does
 * not exist, and then committed twenty-seven citation errors of its own that a
 * mechanical check found in minutes. Row `13` contemplated this for the
 * register; it was pulled forward because the doc set needs it first and two
 * implementations would be two checks that must agree.
 *
 * ── WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────
 *
 * Surveyed across 176 markdown files, this repository writes citations in a
 * dozen shapes and roughly 3,750 of them. They divide into three groups and
 * only the first can be checked:
 *
 *   CHECKABLE — a path with a `/` under a repository tree, or a bare filename
 *   at the repository root (`TEST.command:112`, `REPORT-COMPILE.txt:3`). The
 *   file is opened and the line number compared against its length.
 *
 *   NOT CHECKABLE, AND COUNTED RATHER THAN DROPPED — package-relative
 *   shorthand with the `node_modules/` prefix omitted
 *   (`midnight-js-contracts/dist/index.mjs:1951`), Rust crate-relative
 *   shorthand (`ledger/src/verify.rs:1775`), `@sha/` package shorthand, and
 *   bare filenames that are not at the root. Roughly a third of all citations
 *   in the tracked docs are one of these. THEY ARE REPORTED AS A COUNT, because
 *   a skip nobody counts is a hole nobody can see — which is the same lesson as
 *   `C238` in a different coat.
 *
 *   GITIGNORED TREES — `midnight-src/`, `node_modules/`, `SAFE/`. Present on
 *   this disk and absent from a clone, so checking them passes locally and
 *   fails in CI for a reason that has nothing to do with the citation. Skipped
 *   by name, counted separately from the shorthand above.
 *
 * ── WHY IT IS NOT POINTED AT EVERY MARKDOWN FILE IN THE REPOSITORY ───────────
 *
 * It CAN be — `checkFile` takes any path, and `CITATIONS.command` runs it over
 * anything, which is what serves the register and the backlog. What the SUITE
 * enforces is narrower and the reason is rule 32: `BACKLOG.md`,
 * `docs/build-log.md`, `docs/corrections.md` and
 * `docs/how-money-can-be-lost.md` are owned elsewhere under rule 32, and a
 * session may not edit them. A gate that turns the suite red over a file this session
 * is forbidden to fix is a gate whose only escape is to disarm it. Thirteen
 * line-beyond-end-of-file citations exist in those files today and every one of
 * them is real; placing them is not this round's, and `CITATIONS.command` finds
 * them on demand.
 *
 * So the enforced scope is `docs/design/` — the set being written, which is
 * where the public claims are — and it grows as `SD1`-`SD5` land, without this
 * file changing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Repository trees a citation may name with a `/`-bearing path. */
const REPO_TREES = ['src/', 'scripts/', 'contracts/', 'docs/', 'db/', '.claude/'];

/** Present on this disk, absent from a clone. Skipped by name and counted. */
const IGNORED_TREES = ['node_modules/', 'midnight-src/', 'SAFE/', 'Identity/', '_to_delete/', 'dist/', 'browser-proving/', 'logs/'];

/** Extensions a bare root-level filename may carry. */
const ROOT_EXT = /\.(command|md|txt|json|ts|mjs|js|sh|py)$/;

export type Citation = {
  readonly raw: string;
  readonly path: string;
  readonly first: number;
  readonly last: number;
  /** 1-based line of the markdown file the citation appears on. */
  readonly at: number;
};

export type CitationFinding = {
  readonly file: string;
  readonly at: number;
  readonly raw: string;
  readonly why: string;
};

export type CitationReport = {
  readonly file: string;
  readonly checked: number;
  readonly findings: CitationFinding[];
  /** Named shorthand that cannot be resolved to a path. Counted, never silently dropped. */
  readonly notCheckable: number;
  /** Citations into trees that are gitignored. */
  readonly skippedIgnored: number;
};

/**
 * Every `path:line` and `path:line-line` in the text, whether or not it is
 * inside backticks — the repository writes them both ways and a check that
 * only saw the backticked ones would miss 53 of them.
 *
 * FENCED CODE BLOCKS ARE EXCLUDED. A generated block quotes circuit signatures
 * and assert messages, and a `Uint<0..18446744073709551615>` inside one is not
 * a citation. Blanked rather than removed so every line number still points at
 * the real file.
 */
export function findCitations(text: string): Citation[] {
  const lines = text.split('\n');
  let fenced = false;
  const out: Citation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of line.matchAll(/([A-Za-z0-9_./@-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g)) {
      const path = m[1];
      // `127.0.0.1:6301` and `localhost:3000` match the shape and are not
      // citations. A citation's path carries a file extension that is not
      // entirely digits.
      if (/^\d+(\.\d+)*$/.test(path)) continue;
      if (!/\.[A-Za-z]/.test(path)) continue;
      out.push({
        raw: m[0],
        path,
        first: Number(m[2]),
        last: m[3] === undefined ? Number(m[2]) : Number(m[3]),
        at: i + 1,
      });
    }
  }
  return out;
}

type Resolution = { kind: 'check'; path: string } | { kind: 'ignored' } | { kind: 'shorthand' };

export function resolve(root: string, path: string): Resolution {
  for (const t of IGNORED_TREES) if (path.startsWith(t)) return { kind: 'ignored' };
  for (const t of REPO_TREES) if (path.startsWith(t)) return { kind: 'check', path };
  if (!path.includes('/') && ROOT_EXT.test(path) && existsSync(join(root, path))) return { kind: 'check', path };
  // A `/`-bearing path under no known tree is package- or crate-relative
  // shorthand; a bare filename that is not at the root is ambiguous — 25 of
  // them in this repository match more than one file, `ledger.ts` alone
  // matching two. Neither is resolved by guessing.
  return { kind: 'shorthand' };
}

export function checkText(root: string, file: string, text: string): CitationReport {
  const findings: CitationFinding[] = [];
  let checked = 0;
  let notCheckable = 0;
  let skippedIgnored = 0;

  for (const c of findCitations(text)) {
    const r = resolve(root, c.path);
    if (r.kind === 'ignored') { skippedIgnored += 1; continue; }
    if (r.kind === 'shorthand') { notCheckable += 1; continue; }
    checked += 1;
    const abs = join(root, r.path);
    if (!existsSync(abs)) {
      findings.push({ file, at: c.at, raw: c.raw, why: `${r.path} is not on disk` });
      continue;
    }
    if (statSync(abs).isDirectory()) {
      findings.push({ file, at: c.at, raw: c.raw, why: `${r.path} is a directory, and a directory has no line ${c.first}` });
      continue;
    }
    // A FILE ENDING IN A NEWLINE HAS N LINES, NOT N+1. `split` yields a final
    // empty element for the text after the last newline, and counting it lets a
    // citation to the line past the end pass. Caught by a `test-auditor` pass.
    const text2 = readFileSync(abs, 'utf8');
    const n = text2.split('\n').length - (text2.endsWith('\n') ? 1 : 0);
    if (c.first < 1) { findings.push({ file, at: c.at, raw: c.raw, why: 'line numbers start at 1' }); continue; }
    if (c.last > n) {
      findings.push({ file, at: c.at, raw: c.raw, why: `${r.path} has ${n} lines, and this cites line ${c.last}` });
      continue;
    }
    if (c.last < c.first) {
      findings.push({ file, at: c.at, raw: c.raw, why: 'the range runs backwards' });
    }
  }
  return { file, checked, findings, notCheckable, skippedIgnored };
}

export function checkFile(root: string, rel: string): CitationReport {
  return checkText(root, rel, readFileSync(join(root, rel), 'utf8'));
}

/** Every markdown file under a tree, repository-relative, sorted. */
export function markdownUnder(root: string, tree: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const child = join(rel, n);
      const st = statSync(join(root, child));
      if (st.isDirectory()) walk(child);
      else if (n.endsWith('.md')) out.push(child.split(sep).join('/'));
    }
  };
  walk(tree);
  return out;
}

/**
 * THE TREE THE SUITE ENFORCES. `docs/design/` and nothing else, for the reason
 * in this file's header: a gate over files rule 32 forbids a session to edit is
 * a gate whose only escape is to disarm it.
 */
export const ENFORCED_TREE = 'docs/design';

export function assertCitationsResolve(root: string, tree: string = ENFORCED_TREE): void {
  const files = markdownUnder(root, tree);
  if (files.length === 0) {
    throw new Error(
      `citations: no markdown files under ${tree}. A check over nothing cannot fail, so this is an ` +
        'error rather than a pass. C238.',
    );
  }
  const findings = files.flatMap((f) => checkFile(root, f).findings);
  if (findings.length === 0) return;
  const lines = ['', '  CITATIONS THAT DO NOT RESOLVE.', ''];
  lines.push('  A file:line citation is a claim about where the evidence is. These do not point');
  lines.push('  at it, and this set goes to GitHub where a reader is invited to check them.');
  lines.push('');
  for (const f of findings) lines.push(`    ${f.file}:${f.at}   ${f.raw}\n        ${f.why}`);
  lines.push('');
  lines.push('  NO DOOR RESOLVES THIS. Each one is a sentence to correct or a citation to move.');
  lines.push('');
  throw new Error(lines.join('\n'));
}
