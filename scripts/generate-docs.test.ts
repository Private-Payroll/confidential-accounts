/**
 * THE RENDERER HAD NO TEST AT ALL, and it is the last thing between a correct
 * extraction and a wrong document.
 *
 * Everything upstream can be right and still reach GitHub broken: an assert
 * message containing a `|` splits a markdown table; a verifier-key cell that
 * goes blank instead of refusing says a circuit has no key; a comparison that
 * fails to strip the timestamp makes every regeneration produce a diff nobody
 * can read. None of those are extraction bugs and none of them were covered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ist, stripGeneratedAt } from './generate-docs.js';
import { GENERATED_BLOCKS, GENERATED_FILES } from './doc-registry.js';
import { parseBlocks } from './generated-blocks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('the timestamp is stripped before two generations are compared', () => {
  it('removes the top-level generatedAt line and nothing else', () => {
    const a = '{\n  "generatedAt": "01 Jan 1970, 00:00 IST",\n  "inputs": "aa",\n  "rows": 1\n}\n';
    const b = '{\n  "generatedAt": "02 Sept 2026, 05:00 IST",\n  "inputs": "aa",\n  "rows": 1\n}\n';
    expect(stripGeneratedAt(a)).toBe(stripGeneratedAt(b));
    expect(stripGeneratedAt(a)).toContain('"inputs": "aa"');
  });

  it('is ANCHORED, so a nested generatedAt cannot be used to hide a change', () => {
    // The first version was an unanchored, non-global regex that worked only
    // because the top-level key happened to serialise first.
    const nested = '{\n  "inputs": "aa",\n  "rows": [\n    { "generatedAt": "x", "hot": true }\n  ]\n}\n';
    expect(stripGeneratedAt(nested)).toBe(nested);
  });

  it('two generations differing ONLY in the timestamp compare equal', () => {
    const body = '  "inputs": "aa",\n  "payload": "bb",\n  "rows": 1\n}\n';
    expect(stripGeneratedAt(`{\n  "generatedAt": "A",\n${body}`)).toBe(stripGeneratedAt(`{\n  "generatedAt": "B",\n${body}`));
  });
});

describe('IST, rule 22', () => {
  it('renders a known instant in Asia/Kolkata and says so', () => {
    // Derived independently: 1_000_061_000 ms is 1970-01-12T13:47:41Z, which is
    // 19:17 in Asia/Kolkata and 08:47 in America/New_York.
    const s = ist(new Date(1_000_061_000));
    expect(s).toBe('12 Jan 1970, 19:17 IST');
    expect(s).not.toContain('08:47');
  });
});

describe('the documents on disk are well-formed markdown, not merely present', () => {
  it('every generated table row has the same number of columns as its header', () => {
    // A `|` inside an assert message would split a row and the table would
    // render as prose from that point down — on GitHub, silently.
    for (const spec of GENERATED_BLOCKS) {
      const block = parseBlocks(read(spec.file)).find((b) => b.id === spec.id);
      expect(block).toBeDefined();
      const lines = (block?.text ?? '').split('\n');
      let expected = 0;
      for (const line of lines) {
        if (!line.startsWith('|')) { expected = 0; continue; }
        const cols = line.split('|').length;
        if (expected === 0) { expected = cols; continue; }
        expect({ file: spec.file, line, cols }).toEqual({ file: spec.file, line, cols: expected });
      }
    }
  });

  it('the verifier-key column REFUSES or MEASURES — it is never blank', () => {
    const text = read('docs/design/circuits.md');
    const rows = text.split('\n').filter((l) => l.startsWith('| `') && l.includes('provable'));
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      const last = r.split('|').at(-2)?.trim() ?? '';
      expect(last).not.toBe('');
      expect(last).not.toBe('—');
      // Either a measured size in bytes, or a refusal that names a door.
      expect(/\d+ B `[0-9a-f]{12}`|NOT MEASURED.*\.command/.test(last)).toBe(true);
    }
  });

  it('CARRIES THE CAVEAT that `discloses` is not a list of what is public', () => {
    // `C356` records its own first reading of this as wrong: `disclose()` has
    // no runtime effect and around a circuit argument publishes nothing at all.
    // A column headed `discloses`, in a public reference for a money system,
    // reads as "here is what leaks" unless it says otherwise where it is read.
    const text = read('docs/design/circuits.md');
    expect(text).toContain('IS NOT A LIST OF WHAT IS PUBLIC');
    expect(text).toContain('no runtime effect');
    expect(text).toContain('privacy.md');
  });

  it('DOES NOT CLAIM that cold means safe to merge', () => {
    // Rule 14: a sentence about what the system does is a truth claim, checked
    // when it is written. "A cold field sharing an entry with a hot one is
    // contention" is neither necessary nor sufficient, and this set is public.
    const text = read('docs/design/ledger-fields.md');
    expect(text).toContain('DOES NOT MEAN "SAFE TO MERGE');
    expect(text).toContain('EXCLUDES THE CONSTRUCTOR');
    expect(text).toContain('NO CIRCUIT');
  });

  it('the generated file carries the hand-edit digest, and NO input digest. T-167.', () => {
    for (const spec of GENERATED_FILES) {
      const text = read(spec.file);
      expect(text).toMatch(/^ {2}"payload": "[0-9a-f]{16}",$/m);
      // A list of inputs was a proxy for "would the generator write this", and
      // it was wrong three times in one round. Staleness is now answered by
      // rendering and comparing, so there is nothing stored here to go stale
      // against what the render actually depends on.
      expect(text).not.toContain('"inputs"');
      expect(JSON.parse(text)).toHaveProperty('generatedBy', spec.door);
    }
  });
});
