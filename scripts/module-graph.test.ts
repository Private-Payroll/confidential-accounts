/**
 * THE MODULE WALKER, PINNED SHAPE BY SHAPE.
 *
 * EVERY ASSERTION BELOW NAMES THE ONE-LINE CHANGE TO `scripts/module-graph.ts`
 * THAT TURNS IT RED, AND EACH OF THOSE CHANGES WAS APPLIED AND WATCHED. They
 * were applied to a COPY of this file and of the walker held outside this
 * folder, never to this tree: a test that edits the repository to prove itself
 * puts every other test asserting the tree is clean inside its window, and this
 * project has dismissed two real defects as flakiness already.
 *
 * WHY THE WALKER TAKES `read` AND `exists` AS ARGUMENTS AT ALL. Because of
 * this file. A rule that lives inside a walk over the real tree can be watched
 * SUCCEED and can never be watched FAIL, and an assertion nobody has watched
 * fail is an assertion nobody has tested. Every fixture here is a string.
 */
import { describe, expect, it } from 'vitest';

import {
  BYTE_WIDTH_SHAPES, IMPORT_SHAPES, INTERPOLATION,
  absentFrom, buildModuleGraph, byteWidthsIn, candidatesFor, exportsIn, joinLiterals,
  normalise, refusalsIn, resolveSpecifier, specifiersIn,
} from './module-graph.js';

/**
 * A DYNAMIC IMPORT, ASSEMBLED RATHER THAN WRITTEN OUT, AND THE REASON IS A
 * LIMIT OF THE THING BEING TESTED.
 *
 * The dynamic shape is matched WHEREVER it appears, because a dynamic import
 * may be anywhere; a string literal containing the text of one is therefore
 * matched too, and this file's own fixtures are string literals. Written out in
 * full they put THREE permanent phantom entries into the unresolved counter of
 * the real tree — measured, not guessed — and a loud counter that cries wolf is
 * a counter somebody stops reading.
 *
 * So the fixture is built from two halves that the matcher cannot see as one.
 * That is not a trick to hide a defect: the limit is named in the walker's own
 * header and printed in the generated document, and this is what it looks like.
 */
const dyn = (spec: string): string => 'await imp' + `ort('${spec}')`;

/** A tree of fixtures, addressed the way the walker addresses real files. */
const treeOf = (files: Record<string, string>) => ({
  files: Object.keys(files),
  read: (rel: string) => {
    const t = files[rel];
    if (t === undefined) throw new Error(`no such fixture: ${rel}`);
    return t;
  },
  exists: (rel: string) => Object.prototype.hasOwnProperty.call(files, rel),
});

describe('the shapes are a table, so dropping one is loud', () => {
  it('names all four import shapes, in order', () => {
    // RED WHEN: an entry is removed from IMPORT_SHAPES, or renamed. Seven of
    // the circuit scan's ten shapes were once dropped with the suite staying
    // green, because nothing asserted what the scanner LOOKS for.
    expect(IMPORT_SHAPES.map((s) => s.name)).toEqual([
      "import/export ... from 'X'", "import 'X'", "import('X')", "require('X')",
    ]);
    expect(IMPORT_SHAPES.filter((s) => s.anchored).map((s) => s.name)).toEqual([
      "import/export ... from 'X'", "import 'X'",
    ]);
    /*
     * AND THE FLAG MUST AGREE WITH THE PATTERN, which pinning the flag alone
     * does not say. `specifiersIn` skips the comment-line guard for a shape
     * that declares itself anchored, so a shape whose `^` is dropped while the
     * flag stays true is matched anywhere AND unguarded. MEASURED: doing that
     * to the side-effect shape invents six specifiers over the client trees,
     * two of them packages this repository does not have.
     */
    for (const shape of IMPORT_SHAPES) {
      expect({ name: shape.name, anchored: shape.anchored })
        .toEqual({ name: shape.name, anchored: shape.re.source.startsWith('^') });
    }
  });

  it('names all five byte-width shapes, in order', () => {
    // RED WHEN: an entry is removed from BYTE_WIDTH_SHAPES.
    expect(BYTE_WIDTH_SHAPES.map((s) => s.name)).toEqual([
      'a declared byte-width constant', 'a fixed-width random draw',
      'a fixed-width buffer', 'a fixed-width slice', 'a width compared',
      'a width compared against a named constant',
    ]);
  });
});

describe('finding a specifier', () => {
  it('reads a MULTI-LINE brace import, which is the ordinary shape here', () => {
    // RED WHEN: the first shape's `[^;]*?` becomes `[^;\n]*?`. 683 imports in
    // this repository span more than one line; a line-bounded matcher finds the
    // `import {` and never the `from`, so those 683 modules import nothing.
    const src = "import {\n  a,\n  b,\n} from './x.js';\n";
    expect(specifiersIn(src).map((s) => s.spec)).toEqual(['./x.js']);
  });

  it('IGNORES PROSE IN A COMMENT that happens to contain the word from', () => {
    // RED WHEN: the `^` anchor is dropped from the first shape.
    //
    // **THE FIXTURE HAS BEEN CHANGED AND THE OLD ONE IS WHY THIS NOTE EXISTS.**
    // It read ` * telling one thing apart from './not-an-import.js' is the job`
    // and it COULD NOT FAIL: with or without the anchor that line yields
    // nothing, because the shape needs a whole-word `import` or `export` before
    // the `from` and the sentence has neither. The property is real —
    // MEASURED, the unanchored shape invents 35 specifiers over the client
    // trees, one of them this very string — but the control was testing the
    // absence of a keyword rather than the presence of the anchor.
    const src = " * we re-export the helper, taken from './not-an-import.js', see below\n";
    expect(specifiersIn(src)).toEqual([]);
  });

  it('ignores an INDENTED static import, which this tree does not have', () => {
    // RED WHEN: the anchor is dropped. Stated as a limit rather than a feature:
    // indented static imports were measured at zero occurrences, and one added
    // later is invisible to this walker rather than wrong in it.
    expect(specifiersIn("  import a from './x.js';\n")).toEqual([]);
  });

  it('reads a side-effect import and a dynamic one', () => {
    // RED WHEN: either of the last three shapes is removed.
    const src = `import './boot.js';\nconst m = ${dyn('./late.js')};\n`;
    expect(specifiersIn(src).map((s) => s.spec).sort()).toEqual(['./boot.js', './late.js']);
  });

  it('does NOT read a METHOD named require or import as a module specifier', () => {
    // RED WHEN: the lookbehind is removed from either unanchored shape.
    // MEASURED before it was added: `assets.require('NIGHT')` in a test put a
    // package called NIGHT into the published dependency list, and this file's
    // own shape table put one called X there — two packages this repository
    // does not have, invented by a matcher told to look anywhere.
    expect(specifiersIn("const a = assets.require('NIGHT');\n")).toEqual([]);
    expect(specifiersIn("const b = loader.import('./x.js');\n")).toEqual([]);
  });

  it('does NOT take a dynamic import written inside a comment', () => {
    // RED WHEN: the `isCommentLine` guard is removed from `specifiersIn`. This
    // is the one shape that must be matched anywhere, so the comment rule is
    // all that stands between the graph and every example in a header.
    const src = ` * do not write ${dyn('./ghost.js')} here\n// ${dyn('./ghost2.js')}\n`;
    expect(specifiersIn(src)).toEqual([]);
  });

  it('finds an import with NO trailing semicolon, which the bound does not require', () => {
    // THIS ASSERTION REPLACES ONE THAT WAS WRONG, AND THE WRONG ONE IS WHY IT
    // IS HERE. It claimed a semicolon-less import was invisible, on the
    // strength of reading `[^;]*?` as *requires a semicolon*. It does not: it
    // is a bound on how far the match may run, and its ABSENCE costs nothing.
    // The claim was written into a shipping document as a known limit before a
    // control caught it. RED WHEN: the bound becomes `[^;\n]*?`.
    expect(specifiersIn("import a from './x.js'\n").map((s) => s.spec)).toEqual(['./x.js']);
  });

  it('is BLIND to a multi-line import whose brace list carries a semicolon in a comment', () => {
    // RED WHEN: the bound is widened past a `;`. This is the real limit the
    // bound creates, and it is the one worth writing down: valid TypeScript
    // cannot put a `;` between `import` and its `from`, but a line comment
    // inside the brace list can, and then the statement is silently invisible.
    // MEASURED across all 1,585 static specifiers in the three client trees:
    // zero occurrences today, and this walker misses none of them.
    expect(specifiersIn("import {\n  a, // a note; with a semicolon\n  b,\n} from './x.js';\n")).toEqual([]);
  });

  it('takes only the FIRST of two static imports written on one physical line', () => {
    // RED WHEN: the anchor is dropped — which would fix this and break the
    // twelve prose matches the anchor exists for. Named as a limit rather than
    // repaired, because the trade is the wrong way round.
    expect(specifiersIn("import a from './x.js'; import b from './y.js';\n").map((s) => s.spec)).toEqual(['./x.js']);
  });
});

describe('resolving a specifier', () => {
  const exists = (rel: string) => ['src/core/x.ts', 'src/core/y.tsx', 'src/core/z/index.ts'].includes(rel);

  it('prefers the `.ts` on disk for a `.js` specifier, which is how this tree is written', () => {
    // RED WHEN: the `.js` -> `.ts` substitution is removed from `candidatesFor`.
    // Every internal import in this repository is written `.js` and every file
    // is `.ts`, so without it the graph has NO internal edges at all.
    expect(resolveSpecifier('src/core/a.ts', './x.js', exists)).toEqual({ kind: 'internal', to: 'src/core/x.ts' });
    expect(candidatesFor('src/core/a.ts', './x.js')[0]).toBe('src/core/x.ts');
  });

  it('REPORTS a relative specifier that resolves to nothing instead of inventing one', () => {
    // RED WHEN: the final `return { kind: 'unresolved' }` becomes an `external`
    // or a silent skip. A specifier quietly dropped is a missing edge, and a
    // missing edge reads exactly like a module nothing imports.
    const r = resolveSpecifier('src/core/a.ts', './gone.js', exists);
    expect(r.kind).toBe('unresolved');
    expect(r.kind === 'unresolved' ? r.tried.length : 0).toBeGreaterThan(3);
  });

  it('names the PACKAGE for a deep import, scoped and unscoped', () => {
    // RED WHEN: `parts.slice(0, 2)` becomes `parts.slice(0, 1)`. A scoped
    // package would then be reported as `@scope`, and every package under one
    // scope would collapse into a single dependency.
    expect(resolveSpecifier('a.ts', '@midnight-ntwrk/compact-runtime/dist/x.js', exists))
      .toEqual({ kind: 'external', pkg: '@midnight-ntwrk/compact-runtime' });
    expect(resolveSpecifier('a.ts', 'midnight-identity/profile/unlock', exists))
      .toEqual({ kind: 'external', pkg: 'midnight-identity' });
  });

  it('knows a platform module from a package, by prefix and by name', () => {
    // RED WHEN: the `node:` branch is removed, or a name is taken out of
    // BUILTINS. `node:fs` counted as a package puts a dependency in the
    // document that nobody installed.
    expect(resolveSpecifier('a.ts', 'node:fs', exists)).toEqual({ kind: 'builtin', module: 'fs' });
    expect(resolveSpecifier('a.ts', 'crypto', exists)).toEqual({ kind: 'builtin', module: 'crypto' });
  });

  it('RESOLVES TO THE FIRST CANDIDATE THAT EXISTS, so the preference is a preference', () => {
    // RED WHEN: `resolveSpecifier` returns the LAST match instead of the first,
    // or `base + '/index.ts'` is dropped from `candidatesFor`. Pinning the
    // array's CONTENTS says the candidates exist; it does not say which one
    // wins, and `./x.js` can name both a `.ts` beside it and a directory with
    // an index — the two are different modules and only the order decides.
    const both = (rel: string) => ['src/core/x.ts', 'src/core/x.js/index.ts'].includes(rel);
    expect(resolveSpecifier('src/core/a.ts', './x.js', both)).toEqual({ kind: 'internal', to: 'src/core/x.ts' });
    const onlyDir = (rel: string) => rel === 'src/core/x/index.ts';
    expect(resolveSpecifier('src/core/a.ts', './x', onlyDir)).toEqual({ kind: 'internal', to: 'src/core/x/index.ts' });
  });

  it('RECORDS WHICH SHAPE FOUND EACH SPECIFIER, and not a single shape for all of them', () => {
    // RED WHEN: `specifiersIn` stamps a constant shape name. Nothing else reads
    // the field back, so it is a label that could quietly become a lie — and it
    // is the field a reader uses to judge how sure an edge is.
    const src = `import { a } from './s.js';\nimport './t.js';\nconst m = ${dyn('./u.js')};\n`;
    expect(specifiersIn(src).map((s) => [s.spec, s.shape])).toEqual([
      ['./s.js', "import/export ... from 'X'"],
      ['./t.js', "import 'X'"],
      ['./u.js', "import('X')"],
    ]);
  });

  it('collapses `..` without a filesystem', () => {
    // RED WHEN: the `'..'` branch is removed from `normalise`. Every import
    // that climbs a directory then fails to resolve, and 44 imports of the
    // crypto module alone are written that way.
    expect(normalise('src/midnight/../core/crypto.ts')).toBe('src/core/crypto.ts');
    expect(candidatesFor('src/midnight/a.ts', '../core/x.js')[0]).toBe('src/core/x.ts');
  });
});

describe('what a module declares', () => {
  it('reads an exported declaration, ANCHORED so a quoted example is not one', () => {
    // RED WHEN: the `^` anchor is dropped from `exportsIn`. This repository
    // quotes its own code inside comments constantly, and an unanchored matcher
    // reports every quoted example as part of the module's public surface.
    const src = [
      'export const A = 1;',
      ' * an example: export function ghost(x) {}',
      // AN EXPORTED TYPE, WHICH HAD NO FIXTURE AND IS THE ONLY THING IN THIS
      // DOCUMENT THAT PRODUCES A PIPE. Removing `type` from the alternation
      // deletes six rows from the reference and nothing was red — including the
      // rows that motivated the table-column fix in the renderer's own test.
      "export type Scheme = 'a' | 'b';",
      'export function real(x: number): number {',
    ].join('\n');
    expect(exportsIn(src).map((e) => e.name)).toEqual(['A', 'Scheme', 'real']);
    expect(exportsIn(src).find((e) => e.name === 'Scheme')?.signature).toContain('|');
  });

  it('counts a RE-EXPORT as part of the surface', () => {
    // RED WHEN: the `reExport` loop is deleted. A module whose whole public
    // surface is re-exported would render as exporting nothing.
    const src = "export { payslipKeypairFrom } from './derive.js';\n";
    expect(exportsIn(src).map((e) => e.name)).toEqual(['payslipKeypairFrom']);
  });

  it('takes the name a re-export is renamed TO, not the one it came from', () => {
    // RED WHEN: `.pop()` becomes `[0]` on the `as` split. The document would
    // name a symbol that nothing outside the module can import.
    expect(exportsIn('export { inner as outer };\n').map((e) => e.name)).toEqual(['outer']);
  });
});

describe('what a module refuses', () => {
  it('JOINS a concatenated message rather than printing half a sentence', () => {
    // RED WHEN: `joinLiterals` returns only the first literal. Most refusals in
    // this repository are written across two or more literals, and half a
    // sentence in a public reference is worse than none.
    expect(joinLiterals("'a run needs ' + 'at least one payee'")).toBe('a run needs at least one payee');
  });

  it('marks an interpolated value rather than dropping it or printing the code', () => {
    // RED WHEN: the `${` branch is removed from `joinLiterals`. Without it the
    // expression text lands in the document, which is how an internal
    // identifier reaches a public page.
    expect(joinLiterals('`a run holds at most ${2 ** DEPTH} payees`'))
      .toBe(`a run holds at most ${INTERPOLATION} payees`);
  });

  it('reads a refusal and its kind', () => {
    // RED WHEN: `assert` is removed from the pattern in `refusalsIn`.
    const src = "throw new Error('no');\nassert(x, 'also no');\n";
    expect(refusalsIn(src).map((r) => [r.kind, r.message])).toEqual([['throw', 'no'], ['assert', 'also no']]);
  });

  it('READS A REFUSAL RAISED THROUGH THE PRODUCT`S OWN ERROR CLASS, not only the built-in one', () => {
    // RED WHEN: the pattern narrows back to `throw new [A-Za-z]*Error(`.
    // MEASURED before it was widened: over the declared money-path set that
    // pattern found 6 of 25 refusals in the vault boundary, 2 of 7 in the coin
    // reader and 44 of 47 in the account boundary — and a module can reach ZERO
    // matches while refusing seven times, at which point the document prints a
    // sentence about a money-path file accepting everything.
    const src = [
      "throw new VaultCannotAfford('the vault holds less than this run needs');",
      "throw deferredCircuitError('this circuit is not deployed at this address');",
    ].join('\n');
    expect(refusalsIn(src).map((r) => r.message)).toEqual([
      'the vault holds less than this run needs',
      'this circuit is not deployed at this address',
    ]);
  });

  it('SKIPS an unbalanced call rather than guessing where it ended', () => {
    // RED WHEN: the `if (depth !== 0) continue` guard is removed. It would then
    // read to the end of the file and print everything after the refusal as
    // though it were the message.
    expect(refusalsIn("throw new Error('never closed'\n")).toEqual([]);
  });

  it('ignores a refusal written inside a comment', () => {
    // RED WHEN: the `isCommentLine` guard is removed from `refusalsIn`. Header
    // comments here quote refusals they are explaining.
    expect(refusalsIn(" * throw new Error('this is prose about a throw');\n")).toEqual([]);
  });
});

describe('where a width is fixed', () => {
  it('finds each of the five shapes, and not a commented one', () => {
    // RED WHEN: any entry is removed from BYTE_WIDTH_SHAPES, or the
    // `isCommentLine` guard is removed from `byteWidthsIn`.
    const src = [
      'const SALT_BYTES = 32;',
      'const s = randomBytes(32);',
      'const b = new Uint8Array(64);',
      'const h = x.slice(0, 32);',
      'if (s.length !== 32) {',
      'if (k.length !== SALT_BYTES) {',
      // NOT A WIDTH, AND THE NARROWING THAT MADE IT SO HAD NO TEST UNTIL NOW.
      // `x.length === 0` asks whether there is anything there; it was published
      // as a fixed byte width until the pattern required a non-zero number.
      'if (raw.length === 0) {',
      // THE COMMENTED LINE USES AN UNANCHORED SHAPE, AND THE ONE IT USED TO USE
      // IS WHY. It was ` * const GHOST_BYTES = 99;`, which the FIRST shape's
      // `^\s*const` could never have matched behind a `*` — so the guard's
      // claim in this test's own comment was never exercised. A random draw is
      // matched anywhere, so it is the line that actually needs the guard.
      ' * const s = randomBytes(64);',
    ].join('\n');
    expect(byteWidthsIn(src).map((w) => w.why)).toEqual([
      'a declared byte-width constant', 'a fixed-width random draw',
      'a fixed-width buffer', 'a fixed-width slice', 'a width compared',
      'a width compared against a named constant',
    ]);
  });
});

describe('a declared set that has gone short', () => {
  it('NAMES THE MEMBERS THE WALK DID NOT FIND, which is what the refusal is built on', () => {
    // RED WHEN: `absentFrom` returns the wrong side of the comparison, or an
    // empty array. THIS FUNCTION EXISTS BECAUSE THE REFUSAL BUILT ON IT COULD
    // NOT OTHERWISE BE WATCHED FIRE: it lived inside a walk over the real tree,
    // where the only way to make it fire is to break the tree, so nothing
    // exercised it and deleting the `throw` broke no assertion at all.
    expect(absentFrom(['a.ts', 'b.ts', 'c.ts'], ['b.ts'])).toEqual(['a.ts', 'c.ts']);
    expect(absentFrom(['a.ts'], ['a.ts', 'b.ts'])).toEqual([]);
    expect(absentFrom([], ['a.ts'])).toEqual([]);
  });
});

describe('the graph itself', () => {
  it('DEDUPLICATES the imports, so one module importing another twice is one edge in the graph', () => {
    // RED WHEN: `uniq` is dropped from the `imports` map. A module that imports
    // both a type and a value from the same neighbour — which most of this tree
    // does — would carry that neighbour twice, and the duplicate would flow
    // through into the importer list as well.
    //
    // **THE SECOND `uniq`, ON `importedBy`, IS NOT PINNED AND CANNOT BE.** It
    // is fed from this one, so no input distinguishes it. It is kept as the
    // guarantee rather than the mechanism, and that is said here rather than
    // left for the next reader to assume it was tested.
    const g = buildModuleGraph(treeOf({
      'a.ts': "import type { T } from './b.js';\nimport { v } from './b.js';\n",
      'b.ts': 'export const v = 1;\n',
    }));
    // ON `imports`, WHICH IS THE ONE THAT MATTERS. Asserting the importer list
    // instead cannot see this: the second `uniq` cleans up after the first, so
    // the two mask each other and removing either alone leaves the importer
    // column correct. MEASURED — the first version of this assertion did
    // exactly that and stayed green.
    expect(g.modules.find((m) => m.file === 'a.ts')?.imports).toEqual(['b.ts']);
    expect(g.modules.find((m) => m.file === 'b.ts')?.importedBy).toEqual(['a.ts']);
    // And the EDGE list keeps both sites, because they are two places to look.
    expect(g.edges.map((e) => e.line)).toEqual([1, 2]);
  });

  it('builds an edge, and its INVERSE, from one import', () => {
    // RED WHEN: `importedBy.get(to)?.push(f)` becomes `importedBy.get(f)?.push(to)`.
    // The two columns would swap, and *what breaks if I change this* would be
    // answered with the list of what this module depends on.
    const g = buildModuleGraph(treeOf({
      'a.ts': "import { x } from './b.js';\n",
      'b.ts': 'export const x = 1;\n',
    }));
    const a = g.modules.find((m) => m.file === 'a.ts');
    const b = g.modules.find((m) => m.file === 'b.ts');
    expect(a?.imports).toEqual(['b.ts']);
    expect(a?.importedBy).toEqual([]);
    expect(b?.imports).toEqual([]);
    expect(b?.importedBy).toEqual(['a.ts']);
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['a.ts->b.ts']);
  });

  it('REPORTS a file it could not read, and still emits it as a node', () => {
    // RED WHEN: the `catch` in `buildModuleGraph` drops the file instead of
    // recording it. A module missing from the graph is indistinguishable from a
    // module nothing imports, and *nothing imports this* is acted on.
    const g = buildModuleGraph({
      files: ['a.ts', 'broken.ts'],
      read: (rel) => { if (rel === 'broken.ts') throw new Error('EISDIR'); return ''; },
      exists: () => true,
    });
    expect(g.unreadable.map((u) => u.file)).toEqual(['broken.ts']);
    expect(g.modules.map((m) => m.file)).toEqual(['a.ts', 'broken.ts']);
  });

  it('REPORTS a specifier that resolved to nothing, with the line it is on', () => {
    // RED WHEN: the `unresolved.push` is replaced by a `continue`.
    const g = buildModuleGraph(treeOf({ 'a.ts': "\nimport { x } from './gone.js';\n" }));
    expect(g.unresolved.map((u) => [u.from, u.spec, u.line])).toEqual([['a.ts', './gone.js', 2]]);
    expect(g.edges).toEqual([]);
  });

  it('COUNTS a real file outside the walked set, so the largest hole in the graph is not silent', () => {
    // RED WHEN: the `else` branch that records it is removed. It is not an
    // edge and not an error — a compiled contract module is a real dependency
    // of a test and not a module of this graph — but 86 sites in this tree take
    // that branch, `contracts/src/witnesses.ts` among them, and a coverage
    // table that showed none of them would invite a reader to believe the graph
    // has no unexplained holes.
    const g = buildModuleGraph({
      files: ['a.ts'],
      read: () => "import { C } from '../managed/contract/index.js';\n",
      exists: (rel: string) => rel === 'managed/contract/index.js',
    });
    expect(g.outsideTheWalkedSet.map((x) => [x.from, x.to])).toEqual([['a.ts', 'managed/contract/index.js']]);
  });

  it('does NOT make an edge to a real file outside the walked set, and does not call it unresolved either', () => {
    // RED WHEN: the `known.has(r.to)` guard becomes an unconditional push, or
    // the `internal` branch falls through to `unresolved`. A contract's
    // generated module is a real file and is not a module of this graph;
    // reporting it as unresolved would be a defect that is not there.
    const g = buildModuleGraph({
      files: ['a.ts'],
      read: () => "import { C } from '../managed/contract/index.js';\n",
      exists: (rel) => rel === 'managed/contract/index.js',
    });
    expect(g.modules[0].imports).toEqual([]);
    expect(g.unresolved).toEqual([]);
  });

  it('REACHES A CIRCUIT TWO HOPS AWAY, through a module that does not name it', () => {
    // RED WHEN: the frontier push in the reachability walk is removed, leaving
    // only the module's own invocations. `reaches` would then equal `names`,
    // and the whole layering question the graph exists to answer is gone.
    const g = buildModuleGraph({
      ...treeOf({
        'screen.ts': "import { pay } from './boundary.js';\n",
        'boundary.ts': "import { z } from './leaf.js';\n",
        'leaf.ts': 'export const z = 1;\n',
      }),
      invocations: [{ from: 'leaf.ts', circuit: 'Vault.payout' }],
    });
    expect(g.modules.find((m) => m.file === 'screen.ts')?.circuits).toEqual([]);
    expect(g.modules.find((m) => m.file === 'screen.ts')?.circuitsReached).toEqual(['Vault.payout']);
  });

  it('reachability follows the IMPORT direction and not the reverse', () => {
    // RED WHEN: the walk follows `importedBy` instead of `imports`. A leaf
    // module would then be reported as reaching every circuit its callers
    // reach, which is the opposite claim and reads just as plausible.
    const g = buildModuleGraph({
      ...treeOf({ 'top.ts': "import { z } from './leaf.js';\n", 'leaf.ts': 'export const z = 1;\n' }),
      invocations: [{ from: 'top.ts', circuit: 'Vault.payout' }],
    });
    expect(g.modules.find((m) => m.file === 'leaf.ts')?.circuitsReached).toEqual([]);
    expect(g.modules.find((m) => m.file === 'top.ts')?.circuitsReached).toEqual(['Vault.payout']);
  });

  it('GIVES EVERY MEMBER OF A CYCLE THE SAME ANSWER, which a memoised walk does not', () => {
    // RED WHEN: `seen` is hoisted out of the per-module loop, which is the
    // ordinary way somebody makes this faster. The first module walked keeps
    // the full answer and every other module reports nothing at all — and
    // cycles are ordinary in this tree, so it would be most of them.
    const g = buildModuleGraph({
      ...treeOf({
        'a.ts': "import { b } from './b.js';\n",
        'b.ts': "import { a } from './a.js';\n",
      }),
      invocations: [{ from: 'b.ts', circuit: 'Vault.payout' }],
    });
    expect(g.modules.find((m) => m.file === 'a.ts')?.circuitsReached).toEqual(['Vault.payout']);
    expect(g.modules.find((m) => m.file === 'b.ts')?.circuitsReached).toEqual(['Vault.payout']);
  });

  it('an invocation attributed to a file outside the set is DROPPED, never invented as a node', () => {
    // RED WHEN: `direct` accepts an unknown key AND the node list is built from
    // the files union the invocation sources. **BOTH HALVES, AND THAT IS THE
    // POINT OF THE NOTE.** The first control written for this assertion changed
    // only the first half and STAYED GREEN — an assertion that cannot fail, in
    // the shape this project has been bitten by before. Each half alone is
    // inert: an unknown key nothing reads changes nothing, and a union over a
    // map with no unknown keys is the same list. So what protects this is two
    // places agreeing, a single-line regression in either is invisible, and
    // that is worth knowing rather than being reassured by a green test.
    const g = buildModuleGraph({
      ...treeOf({ 'a.ts': 'export const x = 1;\n' }),
      invocations: [{ from: 'elsewhere.ts', circuit: 'Vault.payout' }],
    });
    expect(g.modules.map((m) => m.file)).toEqual(['a.ts']);
    expect(g.modules[0].circuits).toEqual([]);
  });

  it('CLOSES OVER WHAT A CIRCUIT ITSELF RUNS, including across the contract boundary', () => {
    // RED WHEN: the second flood is removed, or `circuitCalls` is not passed
    // in. Without it the column answers a narrower question than its own
    // heading: the vault boundary reaches `Vault.payout` and NOT the account
    // circuit every payout lands on chain, because that hop belongs to a
    // contract and not to an import. MEASURED on the real tree after the fix:
    // `src/midnight/vault-ledger.ts` went from 24 circuits to 32, and
    // `ConfidentialAccount.recordPayment` from 22 modules reaching it to 36.
    const g = buildModuleGraph({
      ...treeOf({ 'boundary.ts': 'export const x = 1;\n' }),
      invocations: [{ from: 'boundary.ts', circuit: 'Vault.payout' }],
      circuitCalls: [
        { from: 'Vault.payout', to: 'ConfidentialAccount.recordPayment' },
        { from: 'ConfidentialAccount.recordPayment', to: 'ConfidentialAccount.payoutLeaf' },
      ],
    });
    expect(g.modules[0].circuits).toEqual(['Vault.payout']);
    expect(g.modules[0].circuitsReached).toEqual([
      'ConfidentialAccount.payoutLeaf', 'ConfidentialAccount.recordPayment', 'Vault.payout',
    ]);
  });

  it('TERMINATES on a cycle between circuits, as it does on one between modules', () => {
    // RED WHEN: the `if (!circuits.has(next))` guard is dropped from the second
    // flood — it would not fail, it would hang, which is why the guard is
    // asserted here rather than trusted.
    const g = buildModuleGraph({
      ...treeOf({ 'a.ts': 'export const x = 1;\n' }),
      invocations: [{ from: 'a.ts', circuit: 'A.one' }],
      circuitCalls: [{ from: 'A.one', to: 'A.two' }, { from: 'A.two', to: 'A.one' }],
    });
    expect(g.modules[0].circuitsReached).toEqual(['A.one', 'A.two']);
  });

  it('is DETERMINISTIC in its ordering, whatever order the files arrive in', () => {
    // RED WHEN: the `.sort()` on the incoming file list is removed.
    //
    // **THIS USED TO CLAIM IT COVERED ALL ELEVEN SORTS AND IT COVERED ONE.**
    // Comparing two runs over the same already-sorted input cannot see an
    // unsorted collection at all — both runs produce the same wrong order. Ten
    // of the eleven sites survived it, five of them invisible everywhere in
    // the repository. The claim was the file's worst one, because this file's
    // whole thesis is that its comments were watched. The next test is the
    // repair: every collection gets input whose natural order is NOT its
    // sorted order, and the ordering is asserted exactly.
    const files = { 'b.ts': "import { x } from './a.js';\n", 'a.ts': 'export const x = 1;\n', 'c.ts': "import { x } from './a.js';\n" };
    const one = buildModuleGraph(treeOf(files));
    const two = buildModuleGraph({ ...treeOf(files), files: ['c.ts', 'a.ts', 'b.ts'] });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.modules.map((m) => m.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('SORTS EVERY COLLECTION IT EMITS, each against input that arrives out of order', () => {
    // RED WHEN: any ONE of the sorts is removed. Every fixture below is written
    // so that the order it is READ in differs from the order it must be
    // PUBLISHED in — which is the only way a sort can be watched to matter.
    // These artefacts are diffed byte for byte before any test runs, and the
    // gate that notices is a gate whose named remedy REGENERATES the document
    // around the change, so a moved ordering reaches a public diff by being
    // blessed rather than by being caught. The catching has to happen here.
    const g = buildModuleGraph({
      files: ['z.ts', 'a.ts'],
      read: (rel: string) => {
        if (rel === 'a.ts') return 'export const x = 1;\n';
        return [
          'export { reExported };',                //  1  found by the SECOND loop
          "import { x } from './a.js';",          //  2  an internal edge
          "import 'zeta';",                        //  3  a package, out of order
          "import 'alpha';",                       //  4
          "import 'node:zlib';",                   //  5  a platform module, out of order
          "import 'node:buffer';",                 //  6
          "import { q } from './missing-z.js';",   //  7  unresolved
          "import { q } from './missing-a.js';",   //  8
          'export const zeta = 1;',                //  9  a declaration, after the re-export
          'export const alpha = 2;',               // 10
          "const b = new Uint8Array(8);",          // 11  a width, two shapes, line order
          "const c = randomBytes(4);",             // 12
        ].join('\n');
      },
      exists: (rel: string) => ['a.ts', 'z.ts'].includes(rel),
    });
    const z = g.modules.find((m) => m.file === 'z.ts');
    // `uniq` — packages and platform modules, read out of order.
    expect(z?.external).toEqual(['alpha', 'zeta']);
    expect(z?.builtin).toEqual(['buffer', 'zlib']);
    // `exportsIn` — a re-export on an EARLIER line than a declaration. The two
    // are found by two loops, the declaration loop first, so without the sort
    // the earlier line is published second.
    expect(z?.exports.map((e) => e.name)).toEqual(['reExported', 'zeta', 'alpha']);
    // `byteWidthsIn` — two shapes matched in table order, published in line order.
    expect(z?.byteWidths.map((w) => w.line)).toEqual([11, 12]);
    // the unresolved list, read `missing-z` before `missing-a`, published by line.
    expect(g.unresolved.map((u) => u.spec)).toEqual(['./missing-z.js', './missing-a.js']);
    // `importedBy` — the inverse, uniq'd and sorted.
    expect(g.modules.find((m) => m.file === 'a.ts')?.importedBy).toEqual(['z.ts']);
    // the edge list — sorted by source file, so `a.ts` would come first if it had one.
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['z.ts->a.ts']);
  });

  it('SORTS THE REACHED CIRCUITS, which arrive from a Set in insertion order', () => {
    // RED WHEN: the `.sort()` on the reached set is removed. A Set iterates in
    // insertion order, so the flood publishes circuits in whatever order it
    // happened to visit them — stable within one run and different the moment
    // an import moves.
    const g = buildModuleGraph({
      ...treeOf({ 'top.ts': "import { x } from './leaf.js';\n", 'leaf.ts': 'export const x = 1;\n' }),
      invocations: [
        { from: 'leaf.ts', circuit: 'Z.last' },
        { from: 'leaf.ts', circuit: 'A.first' },
      ],
      circuitCalls: [{ from: 'A.first', to: 'M.middle' }],
    });
    expect(g.modules.find((m) => m.file === 'top.ts')?.circuitsReached).toEqual(['A.first', 'M.middle', 'Z.last']);
  });

  it('SORTS THE REFUSALS AND THE SPECIFIERS, which are matched shape by shape', () => {
    // RED WHEN: the `.sort()` in `refusalsIn` or in `specifiersIn` is removed.
    // Both walk a TABLE of shapes and then a file, so a match on line 1 found
    // by the second shape is emitted after a match on line 9 found by the
    // first. Neither ordering is visible in any published artefact today,
    // which is exactly why neither had a control.
    const refusals = "assert(x, 'second');\nthrow new Error('first');\n";
    expect(refusalsIn(refusals).map((r) => r.message)).toEqual(['second', 'first']);
    const specs = "import './anchored-second.js';\nimport { a } from './anchored-first.js';\n";
    expect(specifiersIn(specs).map((s) => s.line)).toEqual([1, 2]);
  });

  it('PUBLISHES THE FILE OUTSIDE THE WALKED SET IN LINE ORDER TOO', () => {
    // RED WHEN: the `.sort()` on `outsideTheWalkedSet` is removed. Same shape
    // as the two above and the same reason it had no control: nothing reads the
    // order back, so only a fixture can hold it.
    const g = buildModuleGraph({
      files: ['a.ts'],
      read: () => "import 'zzz';\nimport { B } from '../out/b.js';\nimport { A } from '../out/a.js';\n",
      exists: (rel: string) => ['out/a.ts', 'out/b.ts'].includes(rel),
    });
    expect(g.outsideTheWalkedSet.map((x) => [x.line, x.to])).toEqual([[2, 'out/b.ts'], [3, 'out/a.ts']]);
  });
});
