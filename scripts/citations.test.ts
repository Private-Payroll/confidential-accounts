/**
 * THE TEST MUST FAIL ON A CITATION THAT HAS MOVED, and the only way to know it
 * does is to move one and watch.
 *
 * `SC7` cited a compiler path that does not exist and then committed
 * twenty-seven citation errors of its own. A citation checker that only ever
 * saw correct citations would have caught none of them and would have looked
 * exactly like this one.
 *
 * So every test below builds a file, writes a citation into a markdown fixture,
 * and then CHANGES THE FILE — truncates it, deletes it — and asserts the
 * finding appears. Nothing here reads `docs/` except the two tests at the end
 * that exercise the live enforced tree, which is the guard actually guarding.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENFORCED_TREE, assertCitationsResolve, checkFile, checkText, findCitations, markdownUnder, resolve } from './citations.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let root = '';

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'citations-'));
  write('src/thing.ts', lines(100));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('it finds citations in the shapes this repository actually writes', () => {
  it('backticked, bare, single, ranged and root-level', () => {
    const found = findCitations(
      'see `src/thing.ts:12` and src/thing.ts:20-30 and `TEST.command:112-134` and `langs.ss:851`',
    );
    expect(found.map((c) => [c.path, c.first, c.last])).toEqual([
      ['src/thing.ts', 12, 12],
      ['src/thing.ts', 20, 30],
      ['TEST.command', 112, 134],
      ['langs.ss', 851, 851],
    ]);
  });

  it('is not fooled by a host:port, which matches the same shape', () => {
    expect(findCitations('the server is on 127.0.0.1:6301 and localhost:3000')).toEqual([]);
  });

  it('IGNORES FENCED CODE, because a generated block quotes signatures', () => {
    // `Uint<0..18446744073709551615>` and an assert message are not citations,
    // and a checker that read them would fail on its own output.
    const text = 'before `src/thing.ts:1`\n\n```\nfoo(x: Uint<0..99>): Bytes<32> at a.ts:99999\n```\n\nafter\n';
    expect(findCitations(text).map((c) => c.raw)).toEqual(['src/thing.ts:1']);
  });
});

describe('THE FINDING FIRES — the whole reason this file exists', () => {
  it('says nothing while the citation still points at a line that is there', () => {
    write('docs/design/d.md', 'Evidence at `src/thing.ts:100`.\n');
    const r = checkText(root, 'docs/design/d.md', 'Evidence at `src/thing.ts:100`.\n');
    expect(r.findings).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it('FAILS WHEN THE CITATION MOVES PAST THE END OF THE FILE', () => {
    // The file shrinks — a deletion above the cited line, which is how every
    // one of these happens in practice.
    write('src/thing.ts', lines(40));
    const r = checkText(root, 'docs/design/d.md', 'Evidence at `src/thing.ts:100`.\n');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].why).toBe('src/thing.ts has 40 lines, and this cites line 100');
    expect(r.findings[0].raw).toBe('src/thing.ts:100');
  });

  it('FAILS WHEN THE FILE IS GONE — the SC7 shape', () => {
    rmSync(join(root, 'src/thing.ts'));
    const r = checkText(root, 'docs/design/d.md', 'Evidence at `src/thing.ts:12`.\n');
    expect(r.findings[0].why).toContain('is not on disk');
  });

  it('checks the END of a range, not only its start', () => {
    write('src/thing.ts', lines(50));
    expect(checkText(root, 'd.md', '`src/thing.ts:40-90`').findings).toHaveLength(1);
    expect(checkText(root, 'd.md', '`src/thing.ts:40-50`').findings).toHaveLength(0);
  });

  it('reports the markdown line the citation is ON, so it can be found', () => {
    rmSync(join(root, 'src/thing.ts'));
    const r = checkText(root, 'd.md', 'one\ntwo\nthree `src/thing.ts:1`\n');
    expect(r.findings[0].at).toBe(3);
  });

  it('catches a directory cited as if it were a file', () => {
    mkdirSync(join(root, 'src/dir.ts'), { recursive: true });
    expect(checkText(root, 'd.md', '`src/dir.ts:5`').findings[0].why).toContain('is a directory');
  });

  it('catches a backwards range and a zero line', () => {
    expect(checkText(root, 'd.md', '`src/thing.ts:30-20`').findings[0].why).toBe('the range runs backwards');
    expect(checkText(root, 'd.md', '`src/thing.ts:0`').findings[0].why).toBe('line numbers start at 1');
  });
});

describe('what it does NOT check is COUNTED, because a silent skip is a hole', () => {
  it('counts package-relative and crate-relative shorthand rather than dropping it', () => {
    const r = checkText(root, 'd.md', '`midnight-js-contracts/dist/index.mjs:1951` and `ledger/src/verify.rs:1775-1795`');
    expect(r.notCheckable).toBe(2);
    expect(r.checked).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('counts gitignored trees separately — present here, absent in a clone', () => {
    const r = checkText(root, 'd.md', '`midnight-src/compact/compiler/langs.ss:851` and `node_modules/vitest/x.js:1`');
    expect(r.skippedIgnored).toBe(2);
    expect(r.checked).toBe(0);
  });

  it('resolve() says which of the three a path is, and never guesses', () => {
    expect(resolve(root, 'midnight-src/x.ss')).toEqual({ kind: 'ignored' });
    expect(resolve(root, 'src/thing.ts')).toEqual({ kind: 'check', path: 'src/thing.ts' });
    // A bare filename that is NOT at the root is ambiguous — `ledger.ts` alone
    // matches two files in this repository — so it is shorthand, not a guess.
    expect(resolve(root, 'ledger.ts')).toEqual({ kind: 'shorthand' });
    expect(resolve(root, 'somepackage/dist/index.mjs')).toEqual({ kind: 'shorthand' });
  });
});

describe('the check the SUITE enforces', () => {
  it('cannot be disarmed by being pointed at an empty tree', () => {
    expect(() => assertCitationsResolve(root, 'docs/design')).toThrow(/A check over nothing cannot fail/);
  });

  it('THROWS over a tree with a broken citation, and names no door', () => {
    write('docs/design/broken.md', 'Evidence at `src/thing.ts:9999`.\n');
    expect(() => assertCitationsResolve(root, 'docs/design')).toThrow(/CITATIONS THAT DO NOT RESOLVE/);
    expect(() => assertCitationsResolve(root, 'docs/design')).toThrow(/NO DOOR RESOLVES THIS/);
  });

  it('THE REAL DOC SET RESOLVES — and the guard is not checking almost nothing', () => {
    // A `C238` FLOOR ON CITATIONS, NOT ONLY ON FILES. An auditor reduced this
    // guard to zero coverage two ways with one array element each — removing
    // `contracts/` from REPO_TREES, or adding it to IGNORED_TREES — and the
    // suite stayed green, because the only assertions were "at least 2 files"
    // and "does not throw". `checkFile` returns the three counters; throwing
    // them away is how a guard passes while measuring nothing.
    expect(markdownUnder(ROOT, ENFORCED_TREE).length).toBeGreaterThanOrEqual(2);
    let checked = 0;
    let notCheckable = 0;
    let skippedIgnored = 0;
    for (const f of markdownUnder(ROOT, ENFORCED_TREE)) {
      const r = checkFile(ROOT, f);
      checked += r.checked;
      notCheckable += r.notCheckable;
      skippedIgnored += r.skippedIgnored;
    }
    expect(checked).toBeGreaterThan(100);
    // In this tree everything is checkable, so a citation that stopped being
    // checked would show up as a skip rather than vanishing.
    expect(notCheckable).toBe(0);
    expect(skippedIgnored).toBe(0);
    expect(() => assertCitationsResolve(ROOT)).not.toThrow();
  });

  it('a file ending in a newline has N lines, not N+1', () => {
    // `split('\n')` yields a trailing empty element, and counting it lets a
    // citation to the line past the end pass. Caught by an auditor.
    write('src/exact.ts', 'one\ntwo\nthree\n');
    expect(checkText(root, 'd.md', '`src/exact.ts:3`').findings).toEqual([]);
    expect(checkText(root, 'd.md', '`src/exact.ts:4`').findings[0].why).toBe('src/exact.ts has 3 lines, and this cites line 4');
    // And a file with no trailing newline still counts its last line.
    write('src/nonl.ts', 'one\ntwo');
    expect(checkText(root, 'd.md', '`src/nonl.ts:2`').findings).toEqual([]);
    expect(checkText(root, 'd.md', '`src/nonl.ts:3`').findings).toHaveLength(1);
  });
});
