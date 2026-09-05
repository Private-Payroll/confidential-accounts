/**
 * **THE INDEX AND THE DIRECTORY AGREE, IN BOTH DIRECTIONS.**
 *
 * `docs/command-index.md` says at the top that it was written by reading every
 * `.command` file. On 27 Aug 2026 that was false: three files on disk were
 * described nowhere in it, and it had been consulted INSTEAD OF the directory
 * for four days. **An index that is silently incomplete is worse than none.**
 *
 * It was found by a person noticing, which is not a mechanism. This is the
 * mechanism.
 *
 * ── WHY A TEST AND NOT A STEP IN A `.command` ────────────────────────────
 *
 * Because this repository already encodes its invariants this way, and the four
 * that exist are the argument: `no-wasm-in-the-page`, `no-password-in-the-bundle`,
 * `sink-not-in-production` and `one-wiring-point`. A step inside an everyday
 * script only fires when somebody runs that script; a test fires for everyone
 * who runs the suite, on every round, without anyone choosing to check. `R2`
 * wrote the rule down while making this same decision: **a search somebody has
 * to remember to run is a check that stops being run.**
 *
 * ── DRIFT RUNS BOTH WAYS, AND THE SECOND HALF IS THE ONE THAT GETS FORGOTTEN ──
 *
 * A file on disk that the index does not name is invisible to anybody
 * consulting the index. **A row naming a file that no longer exists is worse:**
 * it is a confident description of a script nobody can run, and the reader's
 * first evidence is a "no such file" after they have already decided to run it.
 * Both are asserted separately so a failure says which happened.
 *
 * ── AND IT COUNTS OUT LOUD ───────────────────────────────────────────────
 *
 * The count is printed on every run, passing or failing. A silent truncation of
 * the index — an edit that removes a whole table — otherwise shows up as
 * nothing at all, and this project has already lost a `BACKLOG.md` entry to
 * exactly that shape of edit (`scripts/check-backlog-ids.py` exists for it).
 *
 * ── AND IT ASSERTS A PRESENCE, OR THE ABSENCES BELOW MEAN NOTHING ────────
 *
 * "Every file is in the index" is also true of a directory read that found no
 * files, and "every row names a real file" is also true of a parse that matched
 * no rows. Both floors are asserted first, for the reason
 * `one-wiring-point.test.ts` asserts its own.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** `src/testing/` → the repository root. Every `.command` lives there and only there. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX = join(ROOT, 'docs', 'command-index.md');

/**
 * The three kinds every row must carry. `ONE-OFF` is not a euphemism for
 * "deletable": the round files and the probes are a research record, several of
 * them carrying corrections to their own earlier bugs, and the index says so.
 * The classification exists so a reader can tell a tool from a record without
 * opening either.
 */
const KINDS = new Set(['EVERYDAY', 'STANDING CHECK', 'ONE-OFF']);

/**
 * A row of the index's own tables: the name in backticks in the first cell,
 * the kind in the second.
 *
 * **THE TABLES ARE THE CANONICAL LIST AND THE PROSE IS NOT**, deliberately. The
 * previous index named `PROBE-VAULT-2` through `-9` only as "rounds 2 to 9",
 * which is honest prose and unfindable by any check — a substring search called
 * eight described files missing, which overstated the real staleness by eight
 * and would have taught whoever ran it to distrust the check. Prose may say
 * anything; a file is described when it has a row.
 */
const ROW = /^\|\s*`([A-Z0-9][A-Z0-9-]*)`\s*\|\s*([A-Z][A-Z -]*[A-Z])\s*\|/;

const onDisk = (): string[] =>
  readdirSync(ROOT)
    .filter(n => n.endsWith('.command'))
    .map(n => n.replace(/\.command$/, ''))
    .sort();

const rowsOf = (text: string): { name: string; kind: string }[] =>
  text.split('\n')
    .map(line => ROW.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ name: m[1], kind: m[2] }));

describe('the command index and the directory agree', () => {
  const files = onDisk();
  const text = readFileSync(INDEX, 'utf8');
  const rows = rowsOf(text);

  // Printed on every run, passing or failing. A count nobody sees is a count
  // that can halve without anybody noticing.
  console.log(
    `command index: ${files.length} .command files at the repository root, `
    + `${rows.length} rows in docs/command-index.md`,
  );

  it('read a directory and an index that are actually there', () => {
    expect(files.length, 'no .command files found — the walk is looking in the wrong place')
      .toBeGreaterThan(40);
    expect(rows.length, 'no rows parsed out of docs/command-index.md — the table format moved, and this check has been passing vacuously')
      .toBeGreaterThan(40);
  });

  it('every .command on disk has a row in the index', () => {
    const named = new Set(rows.map(r => r.name));
    const missing = files.filter(f => !named.has(f));
    expect(
      missing,
      `these exist at the repository root and the index describes none of them:\n  ${missing.join('\n  ')}\n`
      + 'Add a row — name, kind, one line — in the section it belongs to. The index '
      + 'is consulted INSTEAD OF the directory, so a file it omits is a file nobody '
      + 'finds before writing a second one that does the same thing.',
    ).toEqual([]);
  });

  it('every row in the index names a .command that exists', () => {
    const exists = new Set(files);
    const ghosts = rows.map(r => r.name).filter(n => !exists.has(n));
    expect(
      ghosts,
      `the index describes these and there is no such file:\n  ${ghosts.join('\n  ')}\n`
      + 'A confident description of a script nobody can run is the worse half of '
      + 'drift: it is believed until somebody tries to run it. If the file was '
      + 'renamed, rename the row; nothing here is ever deleted for being obsolete, '
      + 'so a missing file is a mistake rather than a tidy-up.',
    ).toEqual([]);
  });

  it('names each one exactly once, and classifies it', () => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
    const twice = [...seen].filter(([, n]) => n > 1).map(([n]) => n);
    expect(twice, `described in two places, which is two descriptions to keep in step:\n  ${twice.join('\n  ')}`)
      .toEqual([]);

    const unclassified = rows.filter(r => !KINDS.has(r.kind));
    expect(
      unclassified.map(r => `${r.name}: "${r.kind}"`),
      `the kind column must be one of ${[...KINDS].join(', ')} — a row without one is a row that does not say whether it is a tool or a record`,
    ).toEqual([]);

    expect(
      rows.length,
      `${rows.length} rows against ${files.length} files — the two lists are the same length or one of the assertions above says which way`,
    ).toBe(files.length);
  });
});
