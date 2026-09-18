/**
 * THE SUITE REFUSES TO RUN AGAINST A GENERATED DOCUMENT THAT NO LONGER
 * DESCRIBES THE CONTRACT IT WAS GENERATED FROM.
 *
 * The principle this exists to serve is *make
 * staleness impossible, not a discipline.* Every document in this repository
 * that a human typed and a human had to remember to update has gone stale —
 * board rows went stale twice on 1 Sep alone, each time after a ruling that
 * made a sentence inside an existing row false —
 * and `M-104` is on record as the defect this project has paid for more than
 * any other. A doc set maintained by intention would be the largest instance of
 * it yet. So *actively maintained* is not a promise here, it is a gate.
 *
 * IT REFUSES. IT DOES NOT REGENERATE, AND THAT IS THE WHOLE DESIGN.
 *
 * The generator reads the COMPILED artifact, so it is only correct where a
 * compile is correct, and rule 1 forbids a session to compile. A gate that
 * repaired itself would regenerate from whatever artifact happened to be on
 * disk and emit a document that is confidently wrong — worse than one that is
 * missing, because a missing document is obviously missing. So generation is a
 * SEPARATE STEP, `npm run docs`, which somebody runs deliberately, and this
 * names it. Rule 19 — and it names a script in the shipping `package.json`
 * rather than a local `.command`, because a reader of the published repository
 * has no `.command` files and a refusal naming one sends them nowhere.
 *
 * `scripts/artifact-freshness.ts` made the identical call for the compiler and
 * its reasoning transfers unchanged; read that file's header for the part about
 * why `globalSetup` is the only chokepoint that cannot be out-ordered by an
 * import, and for the honest list of what still disarms a guard wired there
 * (`vitest --config <other>`, renaming `vitest.config.ts`). Both apply here and
 * neither is closable from inside a config.
 *
 * ── AND ONE DOOR NOW TAKES THE FIRST OF THOSE, AGAINST THIS GATE ALONE ───────
 *
 * `T-171`, ruled 2 Sep. `MUTATE.command` runs under a mutation configuration,
 * which is DERIVED from `vitest.config.ts` and removes exactly one `globalSetup`
 * entry: this one. `artifact-freshness` and `ledger-limit` stay wired there, so
 * a mutation is still scored against a fresh artifact and a bounded ledger.
 *
 * **IT IS A SCOPE CORRECTION AND NOT A DISARM, AND THAT DISTINCTION IS THE
 * WHOLE RULING.** This gate asks *do the documents describe the artifact on
 * disk?* The mutation harness breaks a contract on purpose, compiles the break,
 * runs `contracts/test` against it and puts the contract back. Inside that LOOP
 * the artifact is a DELIBERATE TEMPORARY LIE; the documents describing the
 * unmutated contract are correct, and this gate firing there is a FALSE
 * POSITIVE — it is not catching a human who forgot to regenerate, which is the
 * only thing it was written to catch. Since
 * `T-167` made this a render-and-compare against the COMPILED artifact, the
 * first mutation to change an `assert` throws here in `globalSetup`, no worker
 * evaluates a test module, no failing test is named, and the harness aborts
 * having scored nothing at all.
 *
 * **WRITTEN IN THAT TENSE ON PURPOSE: NOBODY HAS WATCHED IT. Rule 9.** This
 * gate and that harness have never run together — `REPORT-MUTATE.txt:1` is
 * 31 Aug and `scripts/doc-freshness.globalSetup.ts` was written 2 Sep — and
 * rule 1 forbids a session the door that would settle it.
 *
 * **TWO THINGS WERE REFUSED IN GETTING HERE AND MUST STAY REFUSED.**
 * Regenerating the documents inside the mutation loop — that renders the doc
 * set from a contract broken on purpose, which is what the paragraph above
 * exists to forbid. And an environment variable, a flag or a marker file that
 * turns this off from inside — a route that can be taken by something which is
 * not a door. A config file passed on a command line is readable in the door
 * that passes it; `process.env.SOMETHING` is readable nowhere.
 *
 * **AND THE EXCEPTION IS ITSELF GUARDED, or it is the hole it looks like.**
 * A test held outside the published set imports both configs as MODULES rather
 * than matching text, pins the difference at this one entry with every other key
 * deeply equal, and asserts that `MUTATE.command` is the ONLY `.command` in the
 * repository that names that config. `TEST.command` runs under
 * `vitest.config.ts` with this gate wired, and remains the only door that
 * speaks for the suite.
 *
 * **AND ONE THING THIS GATE REALLY DOES LOSE, SAID PLAINLY RATHER THAN LEFT TO
 * BE FOUND.** `MUTATE.command`'s BASELINE run — the one before anything is
 * broken — is under that config too, and there the artifact is the real one, so
 * this gate firing would have been a TRUE positive. It is dropped there for a
 * different reason: `C293` says the baseline certifies the invocation the loop
 * will use, so it must BE that invocation. **The consequence is that a stale
 * doc set now survives a full mutation run.** `TEST.command` is what catches
 * it, `T-171`'s run order puts the regeneration in front of `MUTATE.command`, and
 * `MUTATE.command` prints the condition into its own report.
 *
 * ── IT RENDERS AND COMPARES. IT DOES NOT HASH A LIST OF INPUTS. ──────────────
 *
 * The first three versions of this gate hashed a list of files each block was
 * believed to be generated from, and the list was wrong three times in one
 * round: `edges.json` was outside it; then it held the contracts and not the
 * generator; then the generator and not the three trees the generator READS.
 * **MEASURED, and it is what settled the design:** the suite passed this
 * gate at 07:23 and a regeneration rewrote two documents at 07:24 with nothing
 * changed in between, while a later run rewrote nothing — so the generator is
 * deterministic and that was real staleness a digest of inputs could not see.
 *
 * **EACH FIX MOVED A BOUNDARY ONE STEP AND STOPPED, WHICH IS THE TELL THAT THE
 * BOUNDARY WAS THE WRONG IDEA.** A list of inputs is a guess about what the
 * render depends on. The question is *would the generator write something
 * different from what is on disk*, so this asks that: it calls the SAME render
 * the writer calls (`scripts/generate-docs.ts`'s `render`), and compares.
 * There is no file the gate cannot see, because it no longer names any. What it
 * compares is the whole delimited REGION the generator emits, delimiters
 * included — an auditor found `door=` outside the comparison when only the body
 * was compared, and that was `T-167`'s symptom reachable one more time.
 *
 * IT STILL DOES NOT WRITE ANYTHING. Computing the answer is not repairing it —
 * the refusal names `npm run docs` and somebody runs it.
 *
 * ── WHY CONTENT DIGESTS AND NOT MTIMES, WHICH IS WHAT THAT FILE USES ─────────
 *
 * `artifact-freshness.ts` compares two whole files and has nothing to hash a
 * subset of, so a clock is right there. Here the thing being guarded is a
 * REGION of a markdown file, and `scripts/source-hash.mjs` has already argued
 * out what clocks cost this repository: every `mutate-*.mjs` writes a file, runs
 * a suite and writes the ORIGINAL BYTES back, so an eighty-eight-mutation run
 * leaves eighty-eight fresh mtimes and no changed content — and twice on 27 Aug
 * that refused a commit for a change that did not happen. A digest is immune to
 * that, and it catches the reverse case a clock cannot see at all: a file edited
 * after a generation and reverted before the check.
 *
 * ── TWO REFUSALS, BECAUSE THERE ARE TWO FAULTS AND ONE DOOR FIXES ONE ────────
 *
 *   - STALE. The files the block was generated FROM have changed. The block
 *     describes a contract that is no longer there. `npm run docs` fixes it,
 *     and the refusal says so.
 *   - HAND-EDITED. Somebody typed inside a generated region. NO DOOR FIXES
 *     THIS: running the generator would silently delete what they wrote, so the
 *     refusal names the region and stops, exactly as `artifact-freshness.ts`
 *     refuses to send somebody through a door for a missing source.
 *
 * Reporting both as one message would send a person to `npm run docs` to
 * destroy their own paragraph.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GENERATED_BLOCKS, GENERATED_FILES, type GeneratedBlock, type GeneratedFile } from './doc-registry.js';
import { render, stripGeneratedAt, type Rendered } from './generate-docs.js';
import { digest, parseBlocks, renderBlock } from './generated-blocks.js';

export type DocRefusalKind =
  /** The document named in the registry is not on disk. */
  | 'file-missing'
  /** The document is there and carries no block with that id. */
  | 'block-missing'
  /** What the generator would write now differs from what is on disk. */
  | 'stale'
  /** The block's own text has changed since it was written. */
  | 'hand-edited';

export type DocRefusal = {
  readonly kind: DocRefusalKind;
  readonly block: GeneratedBlock;
  readonly detail: string;
};

/**
 * Every block that stops the suite, in registry order, given the bytes the
 * generator would write now.
 *
 * `rendered` IS PASSED IN RATHER THAN COMPUTED HERE, so a test can hand it a
 * render it controls and watch the comparison fail — and so the whole guard has
 * exactly one place that runs the extractor.
 *
 * IT THROWS ON AN EMPTY REGISTRY. A check over zero things
 * cannot fail, and a check that cannot fail has already failed.
 */
export function docRefusals(
  root: string,
  blocks: readonly GeneratedBlock[],
  rendered: ReadonlyMap<string, string>,
): DocRefusal[] {
  if (blocks.length === 0) {
    throw new Error(
      'doc-freshness: asked to check ZERO generated blocks. A check over nothing cannot fail, ' +
        'so this is an error rather than a pass. Something has emptied GENERATED_BLOCKS.',
    );
  }

  const out: DocRefusal[] = [];
  for (const b of blocks) {
    const path = join(root, b.file);
    if (!existsSync(path)) { out.push({ kind: 'file-missing', block: b, detail: b.file }); continue; }

    const text = readFileSync(path, 'utf8');
    const found = parseBlocks(text).find((x) => x.id === b.id);
    if (!found) { out.push({ kind: 'block-missing', block: b, detail: b.id }); continue; }

    // HAND-EDITED IS CHECKED FIRST. A block somebody typed in is very likely
    // ALSO stale, and reporting the stale half would send them to a door that
    // overwrites what they typed.
    const bodyNow = digest(found.text);
    if (bodyNow !== found.body) {
      out.push({ kind: 'hand-edited', block: b, detail: `recorded ${found.body || '(none)'}, now ${bodyNow}` });
      continue;
    }

    const fresh = rendered.get(b.id);
    if (fresh === undefined) {
      throw new Error(
        `doc-freshness: nothing rendered for block "${b.id}". The registry and the generator disagree about ` +
          'what exists, so the comparison would pass by having nothing to compare. C238.',
      );
    }
    /*
     * THE WHOLE DELIMITED REGION, NOT THE BODY BETWEEN THE DELIMITERS.
     *
     * `renderBlock` emits the BEGIN line too, and it carries `door=`. Comparing
     * only the body left that attribute outside the gate: an auditor changed
     * `door="npm run docs"` to `door="npm run elsewhere"` in
     * `docs/design/circuits.md` and the suite stayed GREEN, while `generate()`
     * on the same tree reported the file as needing a rewrite. **That is
     * `T-167`'s own measurement reproduced** — the gate passing at one moment
     * and the door rewriting a document at the next with nothing else changed —
     * reached through the one region of the generator's output the gate was not
     * rendering and comparing.
     *
     * Comparing the region also removes a second copy of `renderBlock`'s
     * wrapping rule, which used to be re-derived here and could drift from it.
     */
    const expected = renderBlock({ id: b.id, door: b.door }, fresh);
    const onDisk = text.slice(found.from, found.to);
    if (expected !== onDisk) {
      out.push({ kind: 'stale', block: b, detail: describeDiff(onDisk, expected, b.file, found.line) });
    }
  }
  return out;
}

/**
 * The first line that differs, and how many do, so a refusal shows its working.
 *
 * FOUR THINGS HERE ARE CORRECTIONS RATHER THAN CHOICES, each one an auditor
 * driving this function and reading nonsense out of it:
 *
 *   - THE COUNT WAS DOUBLED, ASYMMETRICALLY. A `filter` over the longer side
 *     already counts the indices past the end of the shorter one, and an
 *     `Math.abs(length difference)` was added to it — so the same ten-line
 *     change reported "21 line(s) differ" one way round and "11" the other.
 *   - THE END-OF-REGION BRANCH WAS DEAD. A body ends in a newline, so `split`
 *     leaves a trailing empty string and the boundary rendered as "(a blank
 *     line)" rather than as the region ending.
 *   - THE LINE NUMBER WAS RELATIVE TO A REGION AND CALLED NOTHING. It is now
 *     `file:line`, which is the form the rest of this repository cites in and
 *     the form a person can open.
 *   - TRUNCATION AT 96 CHARACTERS HID THE DIFFERENCE ITSELF. Two long lines
 *     differing at column 100 printed identically, under a heading saying they
 *     differed. The window now follows the first differing COLUMN.
 */
function describeDiff(onDisk: string, fresh: string, file: string, baseLine: number): string {
  const a = onDisk.split('\n');
  const b = fresh.split('\n');
  const n = Math.max(a.length, b.length);

  let first = -1;
  let differing = 0;
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) continue;
    differing += 1;
    if (first === -1) first = i;
  }
  if (first === -1) return 'the two are identical, which should not have been reported';

  // A window around the first differing COLUMN, so the difference is on screen.
  const width = 96;
  const show = (line: string | undefined): string => {
    if (line === undefined) return '(the region ends here)';
    const other = line === a[first] ? b[first] : a[first];
    let col = 0;
    while (col < line.length && col < (other?.length ?? 0) && line[col] === other[col]) col += 1;
    const from = Math.max(0, col - Math.floor(width / 3));
    const slice = line.slice(from, from + width);
    if (slice.trim() === '') return '(a blank line)';
    return (from > 0 ? '…' : '') + slice + (from + width < line.length ? '…' : '');
  };

  return [
    `${differing} line(s) differ; the first is ${file}:${baseLine + first}`,
    `        on disk    ${show(a[first])}`,
    `        generated  ${show(b[first])}`,
  ].join('\n');
}

/**
 * The same two questions for a file generated WHOLE, which has no delimiters and
 * carries its hand-edit digest in its own payload.
 *
 * `generatedAt` IS EXCLUDED FROM BOTH COMPARISONS. It is a clock, it changes on
 * every run, and a clock inside a digest is a digest that never matches. The
 * regex that removes it is anchored to a line start and the two-space top-level
 * indent, so a `generatedAt` appearing inside the payload cannot be used to hide
 * an edit.
 */
export function fileRefusals(
  root: string,
  files: readonly GeneratedFile[],
  rendered: ReadonlyMap<string, string>,
): DocRefusal[] {
  // AN EMPTY LIST IS THE DECLARED STATE HERE AND IT IS NOT A DISARMED CHECK.
  //
  // This used to throw, on the ground that a check over nothing cannot fail. The
  // ground is right and the conclusion was aimed at the wrong list: what must
  // never be empty is the REGISTRY, and `blockRefusals` above throws on an empty
  // `GENERATED_BLOCKS` for exactly that reason. Whole-file artefacts are a
  // SHAPE the registry supports and has no members of today, because the one
  // member was a file this repository does not publish and a gate may not depend
  // on a file the repository does not publish. `doc-registry.ts` carries the
  // decision and `doc-freshness.test.ts` asserts it, so an entry that reappeared
  // by accident is caught where it would be made rather than here.
  if (files.length === 0) {
    return [];
  }
  const out: DocRefusal[] = [];
  for (const f of files) {
    const asBlock: GeneratedBlock = { file: f.file, id: f.file, door: f.door };
    const path = join(root, f.file);
    if (!existsSync(path)) { out.push({ kind: 'file-missing', block: asBlock, detail: f.file }); continue; }

    const text = readFileSync(path, 'utf8');
    const recordedPayload = /^ {2}"payload": "([^"]*)"/m.exec(text)?.[1];
    if (recordedPayload === undefined) {
      out.push({ kind: 'block-missing', block: asBlock, detail: `${f.file} carries no "payload" digest` });
      continue;
    }
    // The body is everything after the header lines, re-opened as an object —
    // exactly what the generator digested.
    const bodyAt = text.indexOf('\n', text.indexOf('"payload"'));
    const bodyNow = digest('{' + text.slice(bodyAt + 1));
    if (bodyNow !== recordedPayload) {
      out.push({ kind: 'hand-edited', block: asBlock, detail: `recorded ${recordedPayload}, now ${bodyNow}` });
      continue;
    }

    const fresh = rendered.get(f.file);
    if (fresh === undefined) {
      throw new Error(
        `doc-freshness: nothing rendered for ${f.file}. The registry and the generator disagree about ` +
          'what exists, so the comparison would pass by having nothing to compare. C238.',
      );
    }
    const onDisk = stripGeneratedAt(text);
    const want = stripGeneratedAt(fresh);
    if (want !== onDisk) {
      /*
       * THE DIFF SKIPS THE PAYLOAD HEADER, AND WITHOUT THAT IT SAYS NOTHING.
       *
       * `payload` is a digest of everything below it, so it changes whenever
       * the body does — which made it the FIRST differing line of every single
       * refusal on this file. The one artefact a later round reads instead of
       * building its own picture was getting the least actionable refusal in
       * the set: two hashes, and no hint of what moved.
       */
      const body = (t: string) => t.slice(t.indexOf('\n', t.indexOf('"payload"')) + 1);
      const skipped = stripGeneratedAt(text).slice(0, stripGeneratedAt(text).indexOf(body(onDisk))).split('\n').length;
      out.push({ kind: 'stale', block: asBlock, detail: describeDiff(body(onDisk), body(want), f.file, skipped) });
    }
  }
  return out;
}

/**
 * What a person reads when the suite stops. It names the document, the region
 * and the door, and shows the two digests it compared — a refusal that does not
 * show its working is a refusal somebody argues with instead of acting on.
 */
export function docRefusalText(refusals: readonly DocRefusal[]): string {
  const out: string[] = [];
  out.push('');
  out.push('  THE SUITE DID NOT RUN.');
  out.push('');
  out.push('  A generated document that describes a contract which has moved is not a weaker');
  out.push('  claim than no document, it is a FALSE one — and this set goes to GitHub, where');
  out.push('  every sentence in it is a public claim about a system that holds money.');
  out.push('');

  const doors: string[] = [];
  for (const r of refusals) {
    const where = r.block.id === r.block.file ? `${r.block.file}` : `${r.block.file}  block "${r.block.id}"`;
    if (r.kind === 'hand-edited') {
      out.push(`  ${where}`);
      out.push('      has been edited inside the generated region.');
      out.push('');
      out.push(`      ${r.detail}`);
      out.push('');
      out.push(`      NO DOOR RESOLVES THIS. Running ${r.block.door} would overwrite whatever was`);
      out.push('      typed there. Move it outside the markers — the bands around a generated');
      out.push('      block are where prose belongs — and then regenerate.');
      out.push('');
      continue;
    }
    if (r.kind === 'stale') {
      out.push(`  ${where}`);
      out.push('      is not what the generator would write now.');
      out.push('');
      out.push(`      ${r.detail}`);
      out.push('');
      doors.push(r.block.door);
      continue;
    }
    if (r.kind === 'file-missing') {
      out.push(`  ${r.detail} is named in scripts/doc-registry.ts and is not on disk.`);
      out.push('');
      out.push('      NO DOOR RESOLVES THIS. A generator does not create a document; it fills a');
      out.push('      region in one that already carries the delimiters.');
      out.push('');
      continue;
    }
    out.push(`  ${r.block.file} carries no generated region with id "${r.detail}".`);
    out.push('');
    out.push('      NO DOOR RESOLVES THIS. Add the two markers by hand, once, where the block');
    out.push('      belongs, then run ' + r.block.door + '.');
    out.push('');
  }

  const unique = doors.filter((d, i) => doors.indexOf(d) === i);
  if (unique.length > 0) {
    out.push(`  Run ${unique.join(', ')}, then run this again.`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * The whole guard in one call, and the ONE place the extractor is run.
 *
 * It is async because rendering imports the compiled artifacts. Measured: 440 ms
 * cold, 174 ms warm, once per suite run in the main process — which buys a gate
 * with no proxy in it. `scripts/artifact-freshness.globalSetup.ts` runs first,
 * so a missing or stale artifact is reported as a compile problem there rather
 * than as an extractor crash here.
 */
export async function assertDocsFresh(
  root: string,
  blocks: readonly GeneratedBlock[] = GENERATED_BLOCKS,
  files: readonly GeneratedFile[] = GENERATED_FILES,
  rendered?: Rendered,
): Promise<void> {
  const r = rendered ?? (await render(root));
  const refusals = [...docRefusals(root, blocks, r.blocks), ...fileRefusals(root, files, r.files)];
  if (refusals.length > 0) throw new Error(docRefusalText(refusals));
}
