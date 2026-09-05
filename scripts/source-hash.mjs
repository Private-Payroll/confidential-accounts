/**
 * WHAT THE TRACKED SOURCE ACTUALLY SAYS, AS CONTENT RATHER THAN AS A CLOCK.
 *
 *   node scripts/source-hash.mjs --write [path]   write the manifest
 *   node scripts/source-hash.mjs --check [path]   compare, exit 1 on a difference
 *   node scripts/source-hash.mjs --print          print it, change nothing
 *
 * Default path: `.midnight/source-manifest.json`, which is gitignored — it is a
 * local artefact of a test run, like `REPORT-TEST.txt`, and it describes one
 * machine at one moment.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * `COMMIT.command` refuses a commit whose test report describes other code.
 * It used to answer that question with mtimes, and its own comment said not
 * to: **every `mutate-*.mjs` writes a file, runs a suite and writes the
 * ORIGINAL BYTES back.** The bytes are identical; the mtime is not. So an
 * eighty-eight-mutation run — twenty minutes on this repository — ended with a
 * commit refused for a change that did not happen. Twice on 27 Aug.
 *
 * A content hash is immune to that, and it catches something a clock cannot: a
 * file edited after the suite ran and reverted before the commit. Same mtime
 * ordering, different history, and the timestamp check calls it clean.
 *
 * ── WHY IT DOES NOT ASK GIT, THOUGH THE WORD IS "TRACKED" ────────────────
 *
 * The old check ran `git ls-files` and said so: only git knows what is tracked.
 * That was affordable because `COMMIT.command` is the one file in this project
 * that runs git at all. **This one is written by `TEST.command`, which must not
 * run git** — the rule that nothing but the commit script touches git is older
 * than this check and worth more than the precision it buys.
 *
 * So the scope is enumerated here, explicitly, and BOTH SIDES USE THIS FILE.
 * The manifest and the comparison are produced by the same walk, so they cannot
 * disagree about what is in scope; the only thing they can disagree about is
 * content, which is the question being asked.
 *
 * **WHAT THAT COSTS, STATED RATHER THAN DISCOVERED:** an untracked file inside
 * the scope — a scratch `.ts` left in `scripts/` — is hashed like any other, so
 * editing it after a test run refuses a commit. That is a false refusal for a
 * file git would have ignored. It is cheap to clear (run `TEST.command`), it
 * errs in the safe direction, and no `.gitignore` parser is worth writing to
 * avoid it. The reverse case does not exist: nothing in scope is skipped.
 *
 * ── THE SCOPE IS THE ONE THE COMMIT GUARD ALREADY DECIDED ────────────────
 *
 * `src/`, `contracts/src/`, `scripts/`, the `.command` files at the root, and
 * the build configuration. **A round that edits only `docs/`, `BACKLOG.md` or
 * `COMMIT-MESSAGE.md` never appears here**, which is what makes refusing —
 * rather than warning — affordable. That decision is not reopened here; it is
 * transcribed, so that changing it means changing one list in one file.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = join('.midnight', 'source-manifest.json');

/** Directories walked in full. */
const TREES = ['src', join('contracts', 'src'), 'scripts'];

/** Single files, by exact name at the root. */
const FILES = ['package.json', 'tsconfig.json', 'tsconfig.scripts.json', 'vitest.config.ts'];

/**
 * Directory names never descended into, at any depth.
 *
 * `node_modules` is not source. Anything beginning with a dot is either tooling
 * state or the manifest's own home. Nothing else is excluded: a build output
 * inside a source tree would be a reason to fix the tree, not to widen this.
 */
const SKIP_DIRS = new Set(['node_modules']);

const walk = (rel, out) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const childRel = join(rel, name);
    const st = statSync(join(ROOT, childRel));
    if (st.isDirectory()) walk(childRel, out);
    else if (st.isFile()) out.push(childRel);
  }
  return out;
};

/** Every path in scope, relative to the repository root, sorted, POSIX-spelled. */
export const filesInScope = () => {
  const found = [];
  for (const t of TREES) walk(t, found);
  for (const f of FILES) if (existsSync(join(ROOT, f))) found.push(f);
  for (const name of readdirSync(ROOT).sort()) {
    if (name.endsWith('.command') && statSync(join(ROOT, name)).isFile()) found.push(name);
  }
  return found.map((p) => p.split(sep).join('/')).sort();
};

/** `{ path: sha256 }`. Content only — no mtime, no size, no mode. */
export const manifest = () => {
  const files = {};
  for (const rel of filesInScope()) {
    files[rel] = createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
  }
  return { version: 1, at: new Date().toISOString(), count: Object.keys(files).length, files };
};

/**
 * What changed between a recorded manifest and the tree as it is now.
 * Three kinds, kept apart because they mean different things to a reader.
 */
export const compare = (before, now) => {
  const a = before?.files ?? {};
  const b = now.files;
  const changed = [], added = [], removed = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) added.push(k);
    else if (a[k] !== b[k]) changed.push(k);
  }
  for (const k of Object.keys(a)) if (!(k in b)) removed.push(k);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
};

/* ------------------------------------------------------------------ cli --- */

/** Repository-relative where that reads better, absolute where it does not. */
const shortPath = (p) => {
  const rel = relative(ROOT, p);
  return rel.startsWith('..') ? p : rel;
};

const argv = process.argv.slice(2);
const mode = argv[0] ?? '--print';
/* An absolute path is taken as given, so a manifest can be kept outside the
 * repository — which is how both directions of this check were demonstrated
 * without writing a misleading artefact into `.midnight/`. */
const path = argv[1]
  ? (isAbsolute(argv[1]) ? argv[1] : join(ROOT, argv[1]))
  : join(ROOT, DEFAULT_MANIFEST);

if (mode === '--print') {
  console.log(JSON.stringify(manifest(), null, 2));
} else if (mode === '--write') {
  mkdirSync(dirname(path), { recursive: true });
  const m = manifest();
  writeFileSync(path, JSON.stringify(m, null, 2));
  console.log(`  source manifest written: ${m.count} files  ${shortPath(path)}`);
} else if (mode === '--check') {
  if (!existsSync(path)) {
    console.log(`NO MANIFEST at ${shortPath(path)}`);
    process.exit(2);
  }
  let before;
  try {
    before = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.log(`THE MANIFEST AT ${shortPath(path)} IS NOT READABLE: ${String(e?.message ?? e)}`);
    process.exit(2);
  }
  const now = manifest();
  const { changed, added, removed } = compare(before, now);
  const total = changed.length + added.length + removed.length;
  if (total === 0) {
    console.log(`  ${now.count} tracked source files, all identical to the manifest`);
    process.exit(0);
  }
  console.log(`  ${total} difference(s) against ${shortPath(path)} (written ${before.at ?? '?'})`);
  // Named individually up to a limit, because "17 files differ" sends somebody
  // looking and "these 17" does not.
  const show = (label, list) => {
    for (const f of list.slice(0, 20)) console.log(`    ${label}  ${f}`);
    if (list.length > 20) console.log(`    ${label}  … and ${list.length - 20} more`);
  };
  show('CHANGED', changed);
  show('ADDED  ', added);
  show('REMOVED', removed);
  process.exit(1);
} else {
  console.log('usage: node scripts/source-hash.mjs [--write|--check|--print] [manifest-path]');
  process.exit(2);
}
