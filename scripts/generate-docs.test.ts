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

import { ist, render, stripGeneratedAt } from './generate-docs.js';
import { MONEY_PATH } from './edge-list.js';
import { EDGE_LIST_FILE, GENERATED_BLOCKS, GENERATED_FILES } from './doc-registry.js';
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
    //
    // **IT COUNTS UNESCAPED PIPES, AND IT DID NOT USED TO.** `cell()` escapes a
    // `|` to `\|`, which is how a pipe is written inside a table cell and is
    // what GitHub reads; this counter split on every `|` including the escaped
    // ones, so the two disagreed about the same row. Nothing showed it while no
    // generated cell contained a pipe. The first one that did was an exported
    // type whose declaration is a union — and the guard reported a broken table
    // for a row the renderer had handled correctly, which is the guard blaming
    // the wrong component.
    // IT STRIPS IN THE SAME ORDER THE RENDERER ESCAPES IN — an escaped
    // backslash first, then an escaped pipe — or the two disagree about a cell
    // whose content ends in a backslash.
    const columns = (line: string) => line.replace(/\\\\/g, '').replace(/\\\|/g, '').split('|').length;
    for (const spec of GENERATED_BLOCKS) {
      const block = parseBlocks(read(spec.file)).find((b) => b.id === spec.id);
      expect(block).toBeDefined();
      const lines = (block?.text ?? '').split('\n');
      let expected = 0;
      for (const line of lines) {
        if (!line.startsWith('|')) { expected = 0; continue; }
        const cols = columns(line);
        if (expected === 0) { expected = cols; continue; }
        expect({ file: spec.file, line, cols }).toEqual({ file: spec.file, line, cols: expected });
      }
    }
  });

  it('NO GENERATED BLOCK QUOTES A VERIFIER KEY, because most copies of this repository have none', () => {
    // THE DEFECT THIS EXISTS TO STOP COMING BACK. There was a verifier-key
    // column here. Those keys come from a separate build that takes minutes and
    // that an ordinary compile skips, so the value in the document was decided
    // by which build the machine had run rather than by the contract - and this
    // block is compared against what is on disk. Frozen with keys it refused on
    // every machine without them; frozen without, on every machine with them.
    // A clone could not start the suite at all.
    const text = read('docs/design/circuits.md');
    const rows = text.split('\n').filter((l) => l.startsWith('| `') && l.includes('provable'));
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(/\d+ B `[0-9a-f]{12}`/.test(r), `a key measurement is quoted in: ${r}`).toBe(false);
      expect(/NOT MEASURED/.test(r), `a key refusal is quoted in: ${r}`).toBe(false);
    }
    // And the header says the same thing, so a column added back with a
    // different cell format is caught too.
    const header = text.split('\n').find((l) => l.startsWith('| circuit | kind |')) ?? '';
    expect(header.split('|').map((c) => c.trim()).filter((c) => c !== ''))
      .toEqual(['circuit', 'kind', 'reads', 'writes', 'asserts', 'discloses', 'calls']);
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

  it('THE MODULE MAP IS REGISTERED AND ON DISK, and the registry is the only place it is named', () => {
    // RED WHEN: the `modules` entry is removed from GENERATED_BLOCKS. The
    // generator would then stop writing the document, the freshness gate would
    // stop checking it, and the file on disk would go stale under a green
    // suite — which is exactly what happened to the edge list before a
    // coverage pass and a money-safety pass found it independently.
    const spec = GENERATED_BLOCKS.find((b) => b.id === 'modules');
    expect(spec?.file).toBe('docs/design/modules.md');
    const block = parseBlocks(read('docs/design/modules.md')).find((b) => b.id === 'modules');
    expect(block).toBeDefined();
    /*
     * A STRUCTURAL FLOOR AND NOT A BYTE COUNT. It was `length > 1000` against a
     * document of 69,841 characters, which is a presence check wearing a size
     * check's clothes: the block could lose 98.6% of itself — both tables and
     * every one of the fourteen module sections — and stay green. What is
     * asserted now is that the document carries a section for every member of
     * the declared set, read from the constant rather than from a literal, so
     * the floor rises with the set instead of going stale beneath it.
     */
    const text = block?.text ?? '';
    for (const f of MONEY_PATH) {
      expect({ file: f, has: text.includes(`## \`${f}\``) }).toEqual({ file: f, has: true });
      expect(text).toContain(`### \`${f}\` — what it refuses`);
      expect(text).toContain(`### \`${f}\` — where a width is fixed`);
    }
  });

  it('LABELS THE PER-MODULE LIST AS WHAT IT IS, not as the narrower thing it used to be', () => {
    // The bullet said `circuits reachable through imports` while the paragraph
    // four screens above described two closures, the second crossing the
    // contract boundary. MEASURED at the time: nine entries across two modules
    // were NOT reachable through imports, `ConfidentialAccount.recordPayment`
    // among them — the label was false about the most important one.
    const text = read('docs/design/modules.md');
    expect(text).not.toContain('circuits reachable through imports');
    expect(text).toContain('**circuits reached** — *through imports, then through what those circuits themselves run*');
  });

  it('DOES NOT CLAIM that `reaches` is a call graph', () => {
    // A sentence about what the system does is a truth claim and is checked
    // when it is written; this set is public. `reaches` follows imports, so
    // it is an UPPER BOUND — read as "this module calls that circuit" it
    // overstates every row, and the overstatement is about which code can move
    // money.
    const text = read('docs/design/modules.md');
    expect(text).toContain('IS NOT A CALL');
    expect(text).toContain('upper bound');
  });

  it('DOES NOT LET AN EMPTY REFUSAL TABLE READ AS A GUARANTEE', () => {
    // The verifier-key column's rule, one document along. `It refuses nothing.
    // Every value that reaches it is one it will accept.` is a safety claim
    // about a money-path module held up by a regular expression — and the
    // matcher missed 27 refusals across the declared set on its first pass, 19
    // in one file. The sentence now describes the matcher, not the module.
    const text = read('docs/design/modules.md');
    expect(text).not.toContain('Every value that reaches it is one it will accept');
    expect(text).toContain('MATCHED RATHER THAN UNDERSTOOD');
    expect(text).toContain('Neither table is');
  });

  it('SAYS WHAT AN EMPTY `naming` CELL DOES AND DOES NOT MEAN', () => {
    // A circuit no TypeScript names may still be entered from another contract,
    // and one is: `ConfidentialAccount.retireVault`. A document that said
    // "never invoked" beside it would be false about the retirement path.
    const text = read('docs/design/modules.md');
    expect(text).not.toContain('this repository never invokes');
    expect(text).toContain('does not mean the circuit is');
    expect(text).toContain('only ever entered');
  });

  it('CARRIES WHAT THE WALK CANNOT SEE, rather than implying a complete graph', () => {
    // A graph that omits silently cannot be questioned. The circuit scan
    // carries the same section, for the same reason.
    const text = read('docs/design/modules.md');
    expect(text).toContain('cannot see');
    expect(text).toContain('built from a variable');
    expect(text).toContain('modules that could not be read');
    expect(text).toContain('specifiers that resolved to nothing');
    expect(text).toContain('specifiers naming a real file outside the walked set');
    expect(text).toContain('invents a dependency');
    /*
     * AND IT DOES NOT SEND A READER TO THE WRONG ROW. The paragraph about
     * unresolved CIRCUIT sites used to say they were "counted below"; the only
     * row below counts unresolved IMPORT specifiers and reads zero, so a reader
     * following the sentence found a zero and concluded the gap was empty.
     */
    expect(text).not.toContain('counted below');
    expect(text).toContain('not in the table below');
    // The width table over-matches as well as under-matching, and says so:
    // six of its seventeen rows across the declared set are not byte widths.
    expect(text).toContain('OVER-MATCHES');
    expect(text).toContain('never a byte width');
  });

  it('the `modules naming it` column REFUSES or LISTS — it is never blank', () => {
    // The same rule as the verifier-key column: a blank cell reads as "nothing
    // is known", and here the fact worth reading is the opposite — a circuit
    // NOTHING in this repository invokes is a real and unusual thing to be
    // told, and it must not arrive as an empty box.
    const text = read('docs/design/modules.md');
    const rows = text.split('\n').filter((l) => /^\| `(ConfidentialAccount|Vault)\./.test(l));
    // ONE ROW PER CIRCUIT ON BOTH CONTRACTS, counted from the other generated
    // document rather than from a number typed here. `> 20` against 39 let the
    // table lose half its circuits in silence.
    const circuits = read('docs/design/circuits.md')
      .split('\n').filter((l) => /^\| `[a-zA-Z]+` \| (pure|provable) \|/.test(l));
    expect(rows.length).toBe(circuits.length);
    for (const r of rows) {
      const cell = r.split('|')[2]?.trim() ?? '';
      expect(cell).not.toBe('');
      expect(cell).not.toBe('—');
      expect(/^\*\*NONE\*\*$|^`/.test(cell)).toBe(true);
    }
  });

  it('a generated whole FILE carries the hand-edit digest, and NO input digest. T-167.', async () => {
    // READ OFF THE RENDER RATHER THAN OFF THIS MACHINE'S DISK. The one such
    // artefact is deliberately not part of this repository, so a clone has no
    // copy to read and a loop over the gated list is now empty; either way,
    // reading the disk would make this test pass by having nothing to look at.
    const rendered = await render(ROOT);
    const named = [EDGE_LIST_FILE, ...GENERATED_FILES.map((f) => f.file)];
    expect(named.length).toBeGreaterThan(0);
    for (const file of named) {
      const text = rendered.files.get(file);
      expect(text, `${file} is not rendered`).toBeDefined();
      expect(text as string).toMatch(/^ {2}"payload": "[0-9a-f]{16}",$/m);
      // A list of inputs was a proxy for "would the generator write this", and
      // it was wrong three times in one round. Staleness is now answered by
      // rendering and comparing, so there is nothing stored here to go stale
      // against what the render actually depends on.
      expect(text as string).not.toContain('"inputs"');
      expect(JSON.parse(text as string)).toHaveProperty('generatedBy', 'npm run docs');
    }
  }, 60_000);
});
