/**
 * A CHECK THAT CANNOT FAIL IS A CHECK THAT HAS ALREADY FAILED.
 *
 * The guard this tests is the kind of thing that gets written, wired, and never
 * once observed doing its job — and a doc gate that never refuses is
 * indistinguishable, in every log this project keeps, from a repository whose
 * documents are always current. So every test below makes something differ and
 * asserts the refusal actually fires.
 *
 * `T-167` ADDED THE ONE THAT MATTERS MOST, and it is the last group in this
 * file: **a real file in a real scanned tree is touched, and the gate is
 * watched refusing.** The three earlier versions of this guard hashed a list of
 * files, the list was wrong three times, and every version of this test passed
 * throughout — because the fixtures exercised the comparison the guard made
 * rather than the question it was supposed to answer. A fixture cannot catch a
 * boundary drawn in the wrong place; only the real trees can.
 *
 * THE LIVE TEST WRITES TO A FILE THE REPOSITORY OWNS, WHICH NOTHING ELSE HERE
 * DOES, and that is deliberate and fenced: it prepends one line to one file,
 * restores the exact bytes in a `finally`, and asserts byte-identity afterwards.
 * There is no alternative that answers `T-167`'s *Done when* — a change in a
 * scanned tree must be seen to turn the gate red — and node cannot unlink
 * inside this repository, so creating a probe file was not an option either.
 *
 * THE WIRING IS EXECUTED, NOT GREPPED. Reading `vitest.config.ts` as text and
 * matching a regex leaves three ways to disarm a guard while staying green:
 * comment the key out, wrap the call in `try {} catch {}`, or put it behind
 * `if (process.env.X)`. So the config is imported as a MODULE and its value
 * read, and the globalSetup module's own default export is CALLED.
 *
 * THIS FILE MUST STAY SEQUENTIAL. `root` is one module-level variable shared by
 * every test.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENERATED_BLOCKS, GENERATED_FILES, type GeneratedBlock, type GeneratedFile } from './doc-registry.js';
import { assertDocsFresh, docRefusalText, docRefusals, fileRefusals } from './doc-freshness.js';
import { render, stripGeneratedAt, withGeneratedAt } from './generate-docs.js';
import { digest, parseBlocks, renderBlock } from './generated-blocks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The fixture's own block and file. Deliberately not the real ones. */
const BLOCK: GeneratedBlock = { file: 'docs/design/fixture.md', id: 'fixture', door: 'npm run fixture-docs' };
const FILE: GeneratedFile = { file: 'docs/design/fixture.json', door: 'npm run fixture-docs' };

const BODY = 'rows, as a generator would have written them\n';
const PAYLOAD = '{\n  "generatedBy": "npm run fixture-docs",\n  "rows": [1, 2, 3]\n}\n';

/** What a render of the fixture would produce. The tests vary this at will. */
const rendered = (body = BODY, payload = PAYLOAD) => ({
  blocks: new Map([[BLOCK.id, body]]),
  files: new Map([[FILE.file, ['{', `  "payload": ${JSON.stringify(digest(payload))},`, payload.slice(1)].join('\n')]]),
});

let root = '';

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** The fixture in the state a generation leaves behind. */
const generateFixture = () => {
  const r = rendered();
  write(BLOCK.file, `# Fixture\n\nProse a person wrote, above.\n\n${renderBlock({ id: BLOCK.id, door: BLOCK.door }, BODY)}\n\nProse a person wrote, below.\n`);
  write(FILE.file, withGeneratedAt(r.files.get(FILE.file) as string, new Date(0)));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'doc-freshness-'));
  generateFixture();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the guard passes only what a generation would have left behind', () => {
  it('says nothing when the document equals what the generator would write', () => {
    const r = rendered();
    expect(docRefusals(root, [BLOCK], r.blocks)).toEqual([]);
    expect(fileRefusals(root, [FILE], r.files)).toEqual([]);
  });

  it('ignores the CLOCK in a generated file, which changes on every run', () => {
    const r = rendered();
    write(FILE.file, withGeneratedAt(r.files.get(FILE.file) as string, new Date(1_700_000_000_000)));
    expect(fileRefusals(root, [FILE], r.files)).toEqual([]);
  });

  it('does not care about MTIMES, which is why it compares content', () => {
    // Every mutate-*.mjs writes a file, runs a suite and writes the ORIGINAL
    // BYTES back; scripts/source-hash.mjs's header records what an mtime-based
    // check cost this repository on 27 Aug.
    const path = join(root, BLOCK.file);
    const bytes = readFileSync(path);
    writeFileSync(path, '# clobbered\n');
    writeFileSync(path, bytes);
    expect(docRefusals(root, [BLOCK], rendered().blocks)).toEqual([]);
  });
});

describe('THE REFUSAL FIRES — the whole reason this file exists', () => {
  it('refuses when the generator would write something different', () => {
    const refusals = docRefusals(root, [BLOCK], rendered('rows, but one of them has changed\n').blocks);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].kind).toBe('stale');
  });

  it('THROWS rather than warns, so a caller cannot carry on past it', async () => {
    await expect(assertDocsFresh(root, [BLOCK], [FILE], rendered('different\n'))).rejects.toThrow(/THE SUITE DID NOT RUN/);
  });

  it('names the document, the region and the DOOR — rule 19', () => {
    const text = docRefusalText(docRefusals(root, [BLOCK], rendered('different\n').blocks));
    expect(text).toContain(BLOCK.file);
    expect(text).toContain(`block "${BLOCK.id}"`);
    expect(text).toContain(`Run ${BLOCK.door}, then run this again.`);
    // Not a file to write, not a variable to set. Rule 19.
    expect(text).not.toMatch(/export |environment variable|SKIP|set [A-Z_]+=/);
  });

  it('SHOWS ITS WORKING — the first differing line, both versions of it', () => {
    // A refusal that says "stale" without showing what it compared is a refusal
    // somebody argues with instead of acting on.
    const text = docRefusalText(docRefusals(root, [BLOCK], rendered('rows, CHANGED\n').blocks));
    expect(text).toMatch(new RegExp(`line\\(s\\) differ; the first is ${BLOCK.file}:\\d+`));
    expect(text).toContain('on disk    rows, as a generator would have written them');
    expect(text).toContain('generated  rows, CHANGED');
  });

  it('refuses a STALE GENERATED FILE, which is the artefact SC8 reads', () => {
    const r = rendered(BODY, '{\n  "generatedBy": "npm run fixture-docs",\n  "rows": [1, 2, 3, 4]\n}\n');
    const refusals = fileRefusals(root, [FILE], r.files);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].kind).toBe('stale');
    expect(docRefusalText(refusals)).toContain(`Run ${FILE.door}`);
  });

  it('REFUSES A HAND-EDIT INSIDE THE BLOCK, and says NO DOOR fixes it', () => {
    // Sending somebody to the generator here would silently delete the
    // paragraph they just typed.
    const path = join(root, BLOCK.file);
    writeFileSync(path, readFileSync(path, 'utf8').replace('a generator', 'a HUMAN'));
    const refusals = docRefusals(root, [BLOCK], rendered().blocks);
    expect(refusals[0].kind).toBe('hand-edited');
    const text = docRefusalText(refusals);
    expect(text).toContain('NO DOOR RESOLVES THIS');
    expect(text).not.toContain(`Run ${BLOCK.door}`);
  });

  it('REFUSES A HAND-EDIT IN A GENERATED FILE, distinctly from staleness', () => {
    const path = join(root, FILE.file);
    writeFileSync(path, readFileSync(path, 'utf8').replace('[1, 2, 3]', '[9, 9, 9]'));
    expect(fileRefusals(root, [FILE], rendered().files)[0].kind).toBe('hand-edited');
  });

  it('reports the HAND-EDIT rather than the staleness when a block is both', () => {
    const path = join(root, BLOCK.file);
    writeFileSync(path, readFileSync(path, 'utf8').replace('generator', 'HUMAN'));
    expect(docRefusals(root, [BLOCK], rendered('different again\n').blocks)[0].kind).toBe('hand-edited');
  });

  it('refuses when the document or the file is gone', () => {
    rmSync(join(root, BLOCK.file));
    expect(docRefusals(root, [BLOCK], rendered().blocks)[0].kind).toBe('file-missing');
    rmSync(join(root, FILE.file));
    expect(fileRefusals(root, [FILE], rendered().files)[0].kind).toBe('file-missing');
  });

  it('REFUSES A DRIFTED DELIMITER, because the delimiter is generated output too', () => {
    // The gate compared only the body between the markers, so `door=` sat
    // outside it: an auditor changed `door="npm run docs"` to
    // `door="npm run elsewhere"` in the real doc set and the suite stayed
    // green, while the generator on the same tree reported the file as needing
    // a rewrite. That is T-167's own symptom — gate green at one moment, door
    // rewriting at the next — reached through the generator's own output.
    const path = join(root, BLOCK.file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(`door="${BLOCK.door}"`, 'door="npm run elsewhere"'));
    const refusals = docRefusals(root, [BLOCK], rendered().blocks);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].kind).toBe('stale');
    expect(docRefusalText(refusals)).toContain('npm run elsewhere');
  });

  it('SHOWS A DIFFERENCE THAT IS PAST COLUMN 96, rather than two identical lines', () => {
    // The refusal truncated each line at 96 characters, so two long lines
    // differing at column 100 printed identically under a heading saying they
    // differed. The window follows the first differing column now.
    const long = (tail: string) => 'x'.repeat(120) + tail + '\n';
    write(BLOCK.file, `# F\n\n${renderBlock({ id: BLOCK.id, door: BLOCK.door }, long('AAA'))}\n`);
    const text = docRefusalText(docRefusals(root, [BLOCK], new Map([[BLOCK.id, long('BBB')]])));
    expect(text).toContain('AAA');
    expect(text).toContain('BBB');
  });

  it('COUNTS DIFFERING LINES ONCE, and the count does not depend on which side is longer', () => {
    // `filter` over the longer side already counts the indices past the end of
    // the shorter one; adding the length difference counted them twice, so the
    // same ten-line change reported 21 one way round and 11 the other.
    const base = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const longer = base + Array.from({ length: 10 }, (_, i) => `extra ${i}`).join('\n') + '\n';
    const count = (text: string) => Number(/(\d+) line\(s\) differ/.exec(text)?.[1]);

    write(BLOCK.file, `# F\n\n${renderBlock({ id: BLOCK.id, door: BLOCK.door }, longer)}\n`);
    const shrinking = count(docRefusalText(docRefusals(root, [BLOCK], new Map([[BLOCK.id, base]]))));
    write(BLOCK.file, `# F\n\n${renderBlock({ id: BLOCK.id, door: BLOCK.door }, base)}\n`);
    const growing = count(docRefusalText(docRefusals(root, [BLOCK], new Map([[BLOCK.id, longer]]))));
    // THE SYMMETRY IS THE FIX. The old count reported 21 one way round and 11
    // the other for the same ten-line change.
    expect(shrinking).toBe(growing);
    // Ten content lines plus the END delimiter, whose `body=` digest is a
    // function of the body and therefore differs too. The comparison is over
    // the whole delimited REGION, so that line is genuinely part of it.
    expect(shrinking).toBe(11);
  });

  it('CITES file:line, so the difference can be opened rather than counted', () => {
    const text = docRefusalText(docRefusals(root, [BLOCK], rendered('changed\n').blocks));
    expect(text).toMatch(new RegExp(`${BLOCK.file}:\\d+`));
  });

  it('refuses when the document exists and the REGION does not', () => {
    write(BLOCK.file, '# Fixture\n\nSomebody deleted the markers.\n');
    expect(docRefusals(root, [BLOCK], rendered().blocks)[0].kind).toBe('block-missing');
  });

  it('reports EVERY stale block, not the first one it meets', () => {
    const second: GeneratedBlock = { file: 'docs/design/second.md', id: 'second', door: 'npm run other-docs' };
    write(second.file, `# Second\n\n${renderBlock({ id: second.id, door: second.door }, 'second\n')}\n`);
    const map = new Map([[BLOCK.id, 'changed\n'], [second.id, 'changed too\n']]);
    const refusals = docRefusals(root, [BLOCK, second], map);
    expect(refusals.map((r) => r.kind)).toEqual(['stale', 'stale']);
    const text = docRefusalText(refusals);
    expect(text).toContain(BLOCK.door);
    expect(text).toContain(second.door);
  });

  it('names each door ONCE when two stale blocks share one', () => {
    const sibling: GeneratedBlock = { ...BLOCK, file: 'docs/design/sibling.md', id: 'sibling' };
    write(sibling.file, `# S\n\n${renderBlock({ id: sibling.id, door: sibling.door }, 'x\n')}\n`);
    const map = new Map([[BLOCK.id, 'a\n'], [sibling.id, 'b\n']]);
    expect(docRefusalText(docRefusals(root, [BLOCK, sibling], map)).match(new RegExp(`Run ${BLOCK.door}`, 'g'))).toHaveLength(1);
  });

  it('cannot be disarmed by being given nothing to check', () => {
    expect(() => docRefusals(root, [], rendered().blocks)).toThrow(/ZERO generated blocks/);
    expect(() => fileRefusals(root, [], rendered().files)).toThrow(/ZERO generated files/);
  });

  it('cannot be disarmed by rendering NOTHING for a block the registry names', () => {
    // The comparison is `rendered vs on disk`, so an empty render would make
    // every document look current for ever, silently.
    expect(() => docRefusals(root, [BLOCK], new Map())).toThrow(/nothing rendered for block/);
    expect(() => fileRefusals(root, [FILE], new Map())).toThrow(/nothing rendered for/);
  });

  it('cannot be walked past by half-deleting the markers', () => {
    const path = join(root, BLOCK.file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/<!-- GENERATED:END[^>]*-->/, ''));
    expect(() => docRefusals(root, [BLOCK], rendered().blocks)).toThrow(/opens and never closes/);
  });
});

describe('T-167 — A CHANGE IN A TREE THE GENERATOR READS TURNS THE GATE RED', () => {
  /*
   * THE TEST THE THREE EARLIER VERSIONS OF THIS GUARD WOULD HAVE FAILED, AND
   * THE ONE THING HOLDING THE WHOLE `T-167` PROPERTY UP.
   *
   * `scripts/edge-list.ts` walks `src`, `scripts` and `contracts/test` for
   * client-file→circuit edges. None of those trees was ever in the digest, so
   * the suite passed the gate at 07:23 and a regeneration rewrote two
   * documents at 07:24 with nothing changed in between.
   *
   * A FIXTURE CANNOT CATCH THIS. Every fixture above tests the comparison the
   * guard makes; the fault was in what the guard was comparing. So this touches
   * the real tree.
   *
   * **DO NOT `.skip` THIS FOR BEING SLOW.** An auditor made `render()` return
   * the ON-DISK content — the perfect no-op, which turns the entire gate into a
   * tautology — and this was the ONLY test in the repository that went red.
   * Skipping it removes the gate's teeth without a word.
   */
  const MARK = '// T-167 probe.';
  /** A file the edge list reads and draws an edge from, and one it reads and does not. */
  const CONTRIBUTOR = 'src/midnight/payout-tree.ts';
  const INERT = 'src/test-setup.ts';

  /*
   * THIS IS THE ONLY PLACE IN THE ROUND THAT WRITES TO A FILE THE REPOSITORY
   * OWNS, and the fence is a marker rather than a promise.
   *
   * The restores below run on an assertion failure, on a throw from `render()`
   * and on a timeout — vitest runs `afterEach` regardless of outcome. What they
   * cannot survive is the process dying: a SIGINT, an OOM, `--bail` killing the
   * pool. A leftover in the CONTRIBUTOR is loud, because the gate goes red on
   * the next run; a leftover in the INERT file is SILENT for ever, because that
   * file is chosen precisely for contributing no edge. Worse, `beforeEach`
   * re-reads from disk, so a leftover would become the next run's "original"
   * and be faithfully restored.
   *
   * So both probes carry the same marker and this refuses before touching
   * anything. It does not repair: running `npm run docs` to clear the red would
   * bake the probe's line-shift into `edges.json`, and the refusal says so.
   */
  beforeAll(() => {
    for (const rel of [CONTRIBUTOR, INERT]) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      if (text.includes(MARK)) {
        throw new Error(
          `${rel} still carries a T-167 probe line from an interrupted run.\n` +
            '  Remove that line by hand. Do NOT regenerate the documents first — it would bake\n' +
            '  the probe\n' +
            "  line's locator shift into docs/design/edges.json.",
        );
      }
    }
  });

  const path = join(ROOT, CONTRIBUTOR);
  let original: Buffer;

  beforeEach(() => { original = readFileSync(path); });
  afterEach(() => { writeFileSync(path, original); });

  it('refuses after a line is inserted in a file the edge list reads', async () => {
    // Fresh first, so the refusal below is the touch and not a repository that
    // was already stale.
    await expect(assertDocsFresh(ROOT)).resolves.toBeUndefined();

    // ONE LINE AT THE TOP, which moves every `file:line` locator below it. This
    // is exactly what happened: a round edited its own files after generating.
    writeFileSync(path, `${MARK} Restored by this test in the same turn.\n${original.toString('utf8')}`);

    // AND THE RENDER ITSELF MOVED, asserted separately from the gate's verdict.
    // Making `render()` return the ON-DISK content turns the whole gate into a
    // tautology, and the gate's refusal alone cannot tell that apart from a
    // gate that works. This says the bytes the generator would write are no
    // longer the bytes on disk, which a disk-echoing render can never satisfy.
    const moved = await render(ROOT);
    const onDisk = readFileSync(join(ROOT, 'docs/design/edges.json'), 'utf8');
    expect(stripGeneratedAt(moved.files.get('docs/design/edges.json') as string)).not.toBe(stripGeneratedAt(onDisk));

    let refused = '';
    try {
      await assertDocsFresh(ROOT);
    } catch (e) {
      refused = String((e as Error).message);
    }
    expect(refused).toContain('THE SUITE DID NOT RUN');
    expect(refused).toContain('docs/design/edges.json');
    expect(refused).toContain('Run npm run docs, then run this again.');

    // AND IT IS RESTORED, byte for byte, before anything else runs.
    writeFileSync(path, original);
    expect(readFileSync(path).equals(original)).toBe(true);
    await expect(assertDocsFresh(ROOT)).resolves.toBeUndefined();
  }, 60_000);

  it('does NOT refuse for a file in a scanned tree that calls no circuit', async () => {
    // The standing cost, asserted rather than asserted-about: of the ~290 files
    // the scan reads, ~33 contribute an edge. Hashing the trees would have gone
    // red for all 290 on every edit, for the whole of phase 2. Comparing the
    // RESULT goes red only when the result moves.
    const inert = join(ROOT, INERT);
    const before = readFileSync(inert);
    try {
      writeFileSync(inert, `${before.toString('utf8')}\n${MARK} Restored by this test in the same turn.\n`);
      await expect(assertDocsFresh(ROOT)).resolves.toBeUndefined();
    } finally {
      writeFileSync(inert, before);
      expect(readFileSync(inert).equals(before)).toBe(true);
    }
  }, 60_000);
});

describe('the guard is WIRED IN, and is pointed at the doc set the registry names', () => {
  it('vitest.config.ts really HOLDS the globalSetup value — read, not grepped', async () => {
    const config = (await import('../vitest.config.ts')).default as {
      test?: { globalSetup?: string | string[]; include?: string[] };
    };
    const wired = config.test?.globalSetup;
    expect(wired).toBeDefined();
    expect(Array.isArray(wired) ? wired : [wired]).toContain('./scripts/doc-freshness.globalSetup.ts');
    // And the glob that collects THIS file. Narrowing `include` switches
    // tests off without a word.
    expect(config.test?.include).toContain('scripts/**/*.test.ts');
  });

  it('THE WIRED MODULE ITSELF REFUSES — its default export, called, over a tree with no docs', async () => {
    // A `try {} catch {}` around its call, or a `process.env` gate in front of
    // it, turns this red; a substring check on the file cannot see either. It is
    // AWAITED here because the guard is async: a `setup` that forgot to await
    // would return a rejected promise instead of throwing, and this is what
    // notices.
    const mod = await import('./doc-freshness.globalSetup.js');
    expect(typeof mod.default).toBe('function');

    // BOTH DIRECTIONS THROUGH THE WIRING. Over the real tree it must RESOLVE —
    // a guard that always threw would be caught here rather than by every other
    // test file at once. Over a tree with no artifacts it must REJECT: what is
    // being proved is that the call happens at all, and a `try {} catch {}` or
    // an `if (process.env.X)` around it would resolve in both cases.
    await expect(mod.default(undefined, ROOT)).resolves.toBeUndefined();

    const empty = mkdtempSync(join(tmpdir(), 'doc-freshness-empty-'));
    try {
      // The message is the EXTRACTOR's here, not the gate's, and that is the
      // stated cost of a gate that renders: with no compiled artifact there is
      // nothing to render. `scripts/artifact-freshness.globalSetup.ts` runs
      // first in the real suite and reports that case as a compile problem,
      // naming COMPILE-CONTRACT.command, before this ever runs.
      await expect(mod.default(undefined, empty)).rejects.toThrow(/THE SUITE DID NOT RUN|contract-info\.json|is not on disk/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 60_000);

  it('derives its root from its own location, not from the working directory', () => {
    const source = readFileSync(join(ROOT, 'scripts/doc-freshness.globalSetup.ts'), 'utf8');
    expect(source).toContain("new URL('..', import.meta.url)");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('process.cwd()');
    // AND IT AWAITS. Without this the guard throws into a floating promise.
    expect(code).toContain('await assertDocsFresh');
  });

  it('THE LIVE REGISTRY IS PINNED BY IDENTITY, not by a count it can satisfy twice', () => {
    // A `>=` on the length is not a pin: replacing one entry with a copy of the
    // other leaves the count unchanged and takes a document out of the guard.
    expect(GENERATED_BLOCKS.map((b) => [b.file, b.id, b.door])).toEqual([
      ['docs/design/circuits.md', 'circuits', 'npm run docs'],
      ['docs/design/ledger-fields.md', 'ledger-fields', 'npm run docs'],
      ['docs/design/modules.md', 'modules', 'npm run docs'],
    ]);
    expect(GENERATED_FILES.map((f) => [f.file, f.door])).toEqual([['docs/design/edges.json', 'npm run docs']]);
    /*
     * AND THE DOOR IS ONE A READER OF THE PUBLISHED REPOSITORY CAN ACTUALLY
     * OPEN. This used to `readFileSync` the door name as a PATH, which passed
     * only because the door was a file in this folder — a file no clone has, so
     * the assertion proved the opposite of what it was for. Every door named by
     * the registry must now be an `npm run <script>` that the SHIPPING
     * `package.json` defines.
     */
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const b of [...GENERATED_BLOCKS, ...GENERATED_FILES]) {
      const m = /^npm run ([A-Za-z0-9:_-]+)$/.exec(b.door);
      expect({ door: b.door, shipped: m !== null && typeof pkg.scripts[m[1]] === 'string' })
        .toEqual({ door: b.door, shipped: true });
    }
  });

  it('THE RENDER COVERS EVERY REGISTRY ENTRY, so nothing is silently uncompared', async () => {
    const r = await render(ROOT);
    for (const b of GENERATED_BLOCKS) expect(r.blocks.get(b.id)?.length ?? 0).toBeGreaterThan(200);
    for (const f of GENERATED_FILES) expect(r.files.get(f.file)?.length ?? 0).toBeGreaterThan(1000);
    // And the render is DETERMINISTIC — the property T-167 rests on, since a
    // gate that compared against a moving target would refuse at random.
    const again = await render(ROOT);
    for (const b of GENERATED_BLOCKS) expect(again.blocks.get(b.id)).toBe(r.blocks.get(b.id));
    for (const f of GENERATED_FILES) expect(stripGeneratedAt(again.files.get(f.file) as string)).toBe(stripGeneratedAt(r.files.get(f.file) as string));
  }, 60_000);

  it('THE REAL DOC SET IS CURRENT — the live default, no arguments', async () => {
    // The assertion that turns red when somebody changes a contract, the
    // generator, or a file the generator reads, and does not regenerate.
    await expect(assertDocsFresh(ROOT)).resolves.toBeUndefined();
    // The delimiters carry no input digest any more; there is nothing there to
    // go out of date with what the render actually depends on.
    for (const b of GENERATED_BLOCKS) {
      const block = parseBlocks(readFileSync(join(ROOT, b.file), 'utf8')).find((x) => x.id === b.id);
      expect(block?.body).toMatch(/^[0-9a-f]{16}$/);
      expect(readFileSync(join(ROOT, b.file), 'utf8')).not.toContain('inputs="');
    }
  }, 60_000);
});
