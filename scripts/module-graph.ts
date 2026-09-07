/**
 * THE MODULE GRAPH. EVERY RULE IN IT IS PURE AND TAKES NO FILESYSTEM, AND THAT
 * IS THE POINT RATHER THAN A STYLE.
 *
 * `scripts/edge-list.ts` already walks the client trees, and the walk it does
 * could have been widened in place. It was not: a rule that exists only inside
 * a walk over the real tree can be watched succeed and can never be watched
 * FAIL, because the only way to make it fail is to break the tree.
 * Everything here takes `read` and `exists` as arguments, so
 * `scripts/module-graph.test.ts` hands it a fixture, mutates one character of
 * that fixture, and watches a named assertion go red. Nothing in this file
 * reads a file.
 *
 * -- WHAT IT ANSWERS, AND WHY THE ANSWER DID NOT EXIST ------------------------
 *
 * The machine-readable edge list carried 529 client edges when this was written and
 * every one of them was TypeScript to circuit. NONE were TypeScript to
 * TypeScript, so the list could say what calls the chain and could not say what
 * calls what -- a graph with no layers in it. A reader asking *what breaks if I
 * change this module* had nothing to read.
 *
 * -- THE FAILURE MODE IS LOUD, WHICH IS THE HALF THAT IS EASY TO GET WRONG ----
 *
 * A walker that cannot understand a file has two ways to behave and only one of
 * them is honest. Skipping it produces a graph with a hole in it that looks
 * exactly like a module nothing imports -- and *nothing imports this* is a
 * conclusion somebody acts on. So every file this cannot read and every
 * specifier it cannot resolve is COLLECTED and returned, the caller prints
 * both, and the counts go in the generated document where a reader meets them.
 * A check over nothing cannot fail.
 *
 * -- THE THREE MATCHING RULES, WRITTEN DOWN BECAUSE THEY ARE ASSUMPTIONS ------
 *
 * This is not a TypeScript parser and must not be read as one. It matches three
 * shapes, each measured against this tree rather than imagined:
 *
 *   1. A STATIC `import`/`export` STATEMENT STARTS AT COLUMN ZERO. Measured
 *      across every TypeScript file in the three client trees: indented static
 *      import statements, NONE. **THE COUNT OF THOSE FILES IS DELIBERATELY NOT
 *      WRITTEN HERE.** It was, and it went stale inside the same day it was
 *      written, because adding this file and its test changed it. A number a
 *      document writes down is a number that rots; the walk derives it and
 *      prints it. The anchor is what keeps prose out --
 *      the words `from "B is no longer in the tree"` appear in twelve comment
 *      lines in this repository, every one of them indented behind a marker,
 *      and an unanchored matcher takes all twelve.
 *   2. THE STATEMENT ENDS AT THE FIRST SEMICOLON. Multi-line brace imports are
 *      ordinary here -- 683 of them -- so the statement is read from the anchor
 *      to the first `;`, not to the end of the line.
 *   3. A DYNAMIC `import(...)` OR `require(...)` MAY BE ANYWHERE, so it is
 *      matched anywhere AND the line it sits on is required not to be a comment
 *      line. That test is a rule rather than a parse, it is stated here, and it
 *      is the one shape in this file that a sufficiently determined comment can
 *      fool.
 *
 * WHAT THIS COSTS IS STATED RATHER THAN DISCOVERED: a specifier built from a
 * variable is invisible to all three, exactly as the circuit scan's dynamic
 * dispatch sites are. Those are counted and named as unresolved rather than
 * dropped, for the same reason.
 */

/* ------------------------------------------------------------ the shapes --- */

/**
 * The four statement shapes, as one exported table.
 *
 * `scripts/edge-list.ts`'s `SHAPES` is the same construct and its test says why
 * it is a table and not four literals inside a walk: seven of that file's ten
 * shapes were once dropped and the suite stayed green, because nothing asserted
 * what the scanner LOOKS for -- only that the numbers it produced agreed with
 * each other.
 */
export const IMPORT_SHAPES: readonly { name: string; re: RegExp; anchored: boolean }[] = [
  /* `import x from 'y'`, `import type {A} from 'y'`, `export {A} from 'y'`,
   * `export * from 'y'` -- everything with a `from`, over as many lines as it
   * takes, anchored at column zero and stopped at the first semicolon. */
  { name: "import/export ... from 'X'", re: /^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm, anchored: true },
  /* `import 'y'` for side effects only. Anchored the same way. */
  { name: "import 'X'", re: /^import\s+['"]([^'"]+)['"]/gm, anchored: true },
  /*
   * `await import('y')`. Anywhere, subject to the comment-line rule -- AND NOT
   * PRECEDED BY A DOT OR A QUOTE. Both exclusions are corrections rather than
   * caution: `assets.require('NIGHT')` is a method named `require` and was read
   * as a dependency on a package called NIGHT, and this file's own shape table
   * contains the literal `"import('X')"`, which was read as a dependency on a
   * package called X. Two packages this repository does not have, in a
   * published document, from a matcher that was told to look anywhere.
   */
  { name: "import('X')", re: /(?<![.'"`\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, anchored: false },
  /* One site in this repository, and a shape that costs nothing to keep. */
  { name: "require('X')", re: /(?<![.'"`\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, anchored: false },
];

/**
 * A LINE THAT IS A COMMENT LINE, FOR THE UNANCHORED SHAPES ONLY.
 *
 * It is deliberately crude and deliberately stated: a line whose first
 * non-space characters open or continue a comment. It does not know about a
 * block comment's interior lines that begin with a word, and it does not know
 * about a string containing the text of an import. Both are named in the
 * document this feeds rather than left for a reader to find.
 */
export const isCommentLine = (line: string): boolean => /^\s*(?:\*|\/\/|\/\*)/.test(line);

/** Node's own modules. A `node:` prefix is unambiguous; the bare names are not. */
export const BUILTINS: readonly string[] = [
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https',
  'net', 'os', 'path', 'process', 'stream', 'string_decoder', 'timers', 'tls',
  'url', 'util', 'worker_threads', 'zlib',
];

/* ------------------------------------------------------------- the types --- */

export type Specifier = {
  readonly spec: string;
  readonly line: number;
  readonly shape: string;
};

export type Resolution =
  | { readonly kind: 'internal'; readonly to: string }
  | { readonly kind: 'external'; readonly pkg: string }
  | { readonly kind: 'builtin'; readonly module: string }
  | { readonly kind: 'unresolved'; readonly tried: readonly string[] };

export type ExportedName = {
  readonly name: string;
  /** The declaration as written, to the end of its line. */
  readonly signature: string;
  readonly line: number;
};

export type Refusal = {
  readonly line: number;
  /** The message as the product states it, with the concatenation joined. */
  readonly message: string;
  readonly kind: 'throw' | 'assert';
};

export type ByteWidthSite = {
  readonly line: number;
  readonly text: string;
  readonly why: string;
};

export type ModuleNode = {
  readonly file: string;
  readonly imports: readonly string[];
  readonly importedBy: readonly string[];
  readonly external: readonly string[];
  readonly builtin: readonly string[];
  readonly exports: readonly ExportedName[];
  readonly refusals: readonly Refusal[];
  readonly byteWidths: readonly ByteWidthSite[];
  /** Circuits invoked from this file itself, from the client scan. */
  readonly circuits: readonly string[];
  /** Circuits reachable from this file, following imports. */
  readonly circuitsReached: readonly string[];
};

/** One resolved module-to-module import, with the line it was written on. */
export type ModuleEdge = {
  readonly from: string;
  readonly to: string;
  readonly spec: string;
  readonly line: number;
  readonly shape: string;
};

export type ModuleGraph = {
  readonly modules: readonly ModuleNode[];
  /** Every internal import, one entry per site rather than one per pair. */
  readonly edges: readonly ModuleEdge[];
  /** A file that could not be READ AT ALL. Never silently absent. */
  readonly unreadable: readonly { readonly file: string; readonly why: string }[];
  /** A specifier that named nothing this walker could find. */
  readonly unresolved: readonly {
    readonly from: string; readonly spec: string; readonly line: number; readonly tried: readonly string[];
  }[];
  /**
   * A specifier that names a REAL file outside the walked set. Not an edge and
   * not an error — a compiled contract module is a real dependency of a test
   * and is not a module of this graph — but the largest single class of thing
   * the graph does not draw, so it is COUNTED rather than dropped in silence.
   */
  readonly outsideTheWalkedSet: readonly {
    readonly from: string; readonly spec: string; readonly line: number; readonly to: string;
  }[];
};

/* --------------------------------------------------------- the specifiers --- */

const lineAt = (text: string, at: number): number => text.slice(0, at).split('\n').length;

const lineOf = (text: string, at: number): string => {
  const from = text.lastIndexOf('\n', at - 1) + 1;
  const to = text.indexOf('\n', at);
  return text.slice(from, to === -1 ? text.length : to);
};

/**
 * Every module specifier in one file, with the shape that found it.
 *
 * THE SEMICOLON IS A BOUND AND NOT A REQUIREMENT, and the difference was got
 * wrong here first: `[^;]*?` says how far a match may RUN, so an import with no
 * trailing semicolon is found and an import whose brace list carries a `;` --
 * which only a line comment can put there -- is not. The second is the real
 * limit and it is the one written down.
 *
 * MEASURED AGAINST A GROUND TRUTH BUILT A DIFFERENT WAY: of the 1,585 static
 * specifiers in the three client trees, this misses NONE. A completeness claim
 * with no second construction behind it is a claim nobody checked.
 */
export function specifiersIn(text: string): Specifier[] {
  const out: Specifier[] = [];
  for (const shape of IMPORT_SHAPES) {
    shape.re.lastIndex = 0;
    for (const hit of text.matchAll(shape.re)) {
      const at = hit.index ?? 0;
      if (!shape.anchored && isCommentLine(lineOf(text, at))) continue;
      out.push({ spec: hit[1], line: lineAt(text, at), shape: shape.name });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.spec.localeCompare(b.spec));
}

/** `a/b/../c` becomes `a/c`, with no filesystem and no platform separator. */
export function normalise(p: string): string {
  const up: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { up.pop(); continue; }
    up.push(part);
  }
  return up.join('/');
}

/**
 * The candidate paths a relative specifier could mean, in the order they are
 * tried. This tree writes `.js` in the specifier for a `.ts` file on disk, so
 * the substitution is the first thing tried and not a fallback.
 */
export function candidatesFor(fromFile: string, spec: string): string[] {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const base = normalise(dir + '/' + spec);
  return [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.ts'),
    base,
    base + '.ts',
    base + '.tsx',
    base + '/index.ts',
  ];
}

/**
 * What one specifier means. A bare name is a package or a builtin and is never
 * guessed at on disk; a relative one is resolved against `exists` or reported.
 */
export function resolveSpecifier(fromFile: string, spec: string, exists: (rel: string) => boolean): Resolution {
  if (spec.startsWith('node:')) return { kind: 'builtin', module: spec.slice(5) };
  if (!spec.startsWith('.')) {
    if (BUILTINS.includes(spec)) return { kind: 'builtin', module: spec };
    /* `@scope/name/deep/path` is the package `@scope/name`; `name/deep` is `name`. */
    const parts = spec.split('/');
    return { kind: 'external', pkg: spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] };
  }
  const tried = candidatesFor(fromFile, spec);
  for (const c of tried) if (exists(c)) return { kind: 'internal', to: c };
  return { kind: 'unresolved', tried };
}

/* ------------------------------------------------ what a module declares --- */

/**
 * Every exported name, with the declaration as written.
 *
 * ANCHORED AT COLUMN ZERO for the same reason the imports are: this
 * repository's comments quote its own code constantly, and an unanchored
 * matcher reads a quoted example as a declaration.
 */
export function exportsIn(text: string): ExportedName[] {
  const out: ExportedName[] = [];
  const re = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:(?:abstract\s+)?class|function\*?|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const hit of text.matchAll(re)) {
    const at = hit.index ?? 0;
    const line = lineOf(text, at);
    /* To the end of the declaration line, with a trailing brace or `=` cut off.
     * A whole body is not a signature. */
    const cut = line.replace(/\s*\{\s*$/, '').replace(/\s*=\s*$/, '').trimEnd();
    out.push({ name: hit[1], signature: cut, line: lineAt(text, at) });
  }
  /* `export { a, b } from './x.js'` and `export { a }` re-export names declared
   * elsewhere. They are the module's surface too. */
  const reExport = /^export\s*\{([^}]*)\}/gm;
  for (const hit of text.matchAll(reExport)) {
    const at = hit.index ?? 0;
    for (const raw of hit[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop();
      const clean = name === undefined ? '' : name.trim();
      if (clean.length > 0) out.push({ name: clean, signature: 'export { ' + clean + ' }', line: lineAt(text, at) });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/**
 * WHAT THE PRODUCT SAYS WHEN IT REFUSES, joined across a concatenation.
 *
 * `throw new Error('a' + 'b')` is one sentence in two literals and most of this
 * repository's refusals are written that way. Reading the first literal only
 * would print half a sentence into a public document, which is worse than
 * printing none. An interpolation becomes a placeholder rather than being
 * dropped, so a reader can see that a value goes there without this file
 * pretending to know which.
 */
/*
 * ONE PATTERN, SO THE MATCHES ARRIVE IN LINE ORDER ALREADY. The sort at the end
 * is in the same class as the four above: a guarantee nothing can distinguish,
 * kept so that adding a second pattern later does not silently reorder a
 * published table.
 */
export function refusalsIn(text: string): Refusal[] {
  const out: Refusal[] = [];
  /*
   * `throw new SomethingError(` COVERS THE BUILT-IN SHAPE AND NOT THE PRODUCT'S
   * OWN CLASSES, WHICH IS WHERE MOST OF THIS REPOSITORY'S REFUSALS LIVE.
   * MEASURED before this line was widened: over the declared set the narrow
   * pattern found 6 of 25 refusals in the vault boundary, 2 of 7 in the coin
   * reader and 44 of 47 in the account boundary -- 27 missing, and a module can
   * reach zero matches while refusing seven times, at which point the document
   * prints a sentence saying it accepts everything.
   */
  const re = /\b(throw new [A-Za-z_$][A-Za-z0-9_$]*\s*\(|throw [a-z][A-Za-z0-9_$]*\s*\(|assert(?:Equals)?\s*\(|invariant\s*\()/g;
  for (const hit of text.matchAll(re)) {
    const at = hit.index ?? 0;
    if (isCommentLine(lineOf(text, at))) continue;
    let i = at + hit[0].length;
    let depth = 1;
    const start = i;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    /* UNBALANCED MEANS NOT UNDERSTOOD, AND NOT UNDERSTOOD IS NEVER GUESSED AT. */
    if (depth !== 0) continue;
    const message = joinLiterals(text.slice(start, i - 1));
    if (message.length === 0) continue;
    out.push({ line: lineAt(text, at), message, kind: hit[1].startsWith('throw') ? 'throw' : 'assert' });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The placeholder an interpolated value leaves behind. */
export const INTERPOLATION = '[value]';

/**
 * The string literals of an expression, joined in order, with interpolations
 * shown as a placeholder. Everything outside a literal is dropped.
 */
export function joinLiterals(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "'" || c === '"') {
      i += 1;
      while (i < expr.length && expr[i] !== c) {
        if (expr[i] === '\\') i += 1;
        out += expr[i] === undefined ? '' : expr[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < expr.length && expr[i] !== '`') {
        if (expr[i] === '\\') { i += 1; out += expr[i] === undefined ? '' : expr[i]; i += 1; continue; }
        if (expr[i] === '$' && expr[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < expr.length && depth > 0) {
            if (expr[i] === '{') depth += 1;
            else if (expr[i] === '}') depth -= 1;
            i += 1;
          }
          out += INTERPOLATION;
          continue;
        }
        out += expr[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * EVERY SITE WHERE A VALUE'S BYTE WIDTH IS FIXED, which is the third thing the
 * parity rule asks a generated reference to carry.
 *
 * IT IS A NAMED TABLE AND NOT A JUDGEMENT, so a reader can see what it looks
 * for and a later change is deliberate. IT IS INCOMPLETE BY CONSTRUCTION -- a
 * width arriving as a variable is invisible to every entry here -- and the
 * document says so where it is read rather than implying a complete list.
 */
export const BYTE_WIDTH_SHAPES: readonly { name: string; re: RegExp }[] = [
  { name: 'a declared byte-width constant', re: /^\s*(?:export\s+)?const\s+[A-Z0-9_]*BYTES[A-Z0-9_]*\s*=\s*\d+/gm },
  { name: 'a fixed-width random draw', re: /\brandomBytes\(\s*\d+\s*\)/g },
  { name: 'a fixed-width buffer', re: /\bnew Uint8Array\(\s*\d+\s*\)/g },
  { name: 'a fixed-width slice', re: /\.slice\(\s*\d+\s*,\s*\d+\s*\)/g },
  /*
   * A WIDTH, NOT AN EMPTINESS CHECK. `x.length === 0` is a question about
   * whether there is anything there and was printed as a fixed byte width
   * until the number was required to be non-zero.
   */
  { name: 'a width compared', re: /\.length\s*[!=]==\s*[1-9]\d*\b/g },
  /*
   * A WIDTH COMPARED AGAINST A NAMED CONSTANT, which is how the three guards
   * that actually matter are written -- the proposal salt, the blinding and the
   * payslip key all read `x.length !== SOMETHING_BYTES`. A table that saw only
   * literals reported the declaration and missed the check.
   */
  { name: 'a width compared against a named constant', re: /\.length\s*[!=]==\s*[A-Z][A-Z0-9_]*\b/g },
];

export function byteWidthsIn(text: string): ByteWidthSite[] {
  const out: ByteWidthSite[] = [];
  for (const shape of BYTE_WIDTH_SHAPES) {
    shape.re.lastIndex = 0;
    for (const hit of text.matchAll(shape.re)) {
      const at = hit.index ?? 0;
      if (isCommentLine(lineOf(text, at))) continue;
      out.push({ line: lineAt(text, at), text: hit[0].trim(), why: shape.name });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.text.localeCompare(b.text));
}

/**
 * WHICH MEMBERS OF A DECLARED SET THE WALK DID NOT FIND.
 *
 * IT IS HERE, AND PURE, BECAUSE THE REFUSAL BUILT ON IT COULD NOT OTHERWISE BE
 * WATCHED FIRE. It lived as three lines inside the walk over the real tree,
 * where the only way to test it is to break the tree — so nothing tested it,
 * and a refusal nothing exercises is a refusal somebody can delete without a
 * single assertion noticing.
 */
export function absentFrom(declared: readonly string[], found: readonly string[]): string[] {
  const have = new Set(found);
  return declared.filter((d) => !have.has(d));
}

/* -------------------------------------------------------------- the walk --- */

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * THE GRAPH, FROM INJECTED READERS AND NOTHING ELSE.
 *
 * `read` may throw; a file it throws on is reported in `unreadable` and is
 * still a NODE, with empty edges, so that *nothing imports this* and *this
 * could not be read* can never be confused for one another in the document.
 */
export function buildModuleGraph(input: {
  readonly files: readonly string[];
  readonly read: (rel: string) => string;
  readonly exists: (rel: string) => boolean;
  readonly invocations?: readonly { readonly from: string; readonly circuit: string }[];
  /**
   * CIRCUIT TO CIRCUIT, so that reaching a circuit means reaching what that
   * circuit itself runs. Without it the column answers a narrower question than
   * the one it is headed with: the vault boundary would reach `Vault.payout`
   * and NOT the account circuit every payout lands on chain, because that hop
   * is a contract's and not an import's.
   */
  readonly circuitCalls?: readonly { readonly from: string; readonly to: string }[];
}): ModuleGraph {
  const files = [...input.files].sort();
  const known = new Set(files);

  const unreadable: { file: string; why: string }[] = [];
  const unresolved: { from: string; spec: string; line: number; tried: string[] }[] = [];
  const outside: { from: string; spec: string; line: number; to: string }[] = [];

  const edges: ModuleEdge[] = [];
  const imports = new Map<string, string[]>();
  const external = new Map<string, string[]>();
  const builtin = new Map<string, string[]>();
  const exports = new Map<string, ExportedName[]>();
  const refusals = new Map<string, Refusal[]>();
  const widths = new Map<string, ByteWidthSite[]>();

  for (const file of files) {
    let text: string;
    try {
      text = input.read(file);
    } catch (e) {
      unreadable.push({ file, why: e instanceof Error ? e.message : String(e) });
      imports.set(file, []); external.set(file, []); builtin.set(file, []);
      exports.set(file, []); refusals.set(file, []); widths.set(file, []);
      continue;
    }
    const into: string[] = [];
    const pkgs: string[] = [];
    const nodeMods: string[] = [];
    for (const s of specifiersIn(text)) {
      const r = resolveSpecifier(file, s.spec, input.exists);
      if (r.kind === 'internal') {
        /* A RESOLVED PATH THAT IS NOT IN THE WALKED SET IS NOT AN EDGE AND IS
         * NOT AN ERROR EITHER. It is a real file outside the three client
         * trees -- a contract's generated module, most often -- and calling it
         * unresolved would report a defect that is not there. */
        if (known.has(r.to)) {
          into.push(r.to);
          edges.push({ from: file, to: r.to, spec: s.spec, line: s.line, shape: s.shape });
        } else {
          outside.push({ from: file, spec: s.spec, line: s.line, to: r.to });
        }
        continue;
      }
      if (r.kind === 'external') { pkgs.push(r.pkg); continue; }
      if (r.kind === 'builtin') { nodeMods.push(r.module); continue; }
      unresolved.push({ from: file, spec: s.spec, line: s.line, tried: [...r.tried] });
    }
    imports.set(file, uniq(into));
    external.set(file, uniq(pkgs));
    builtin.set(file, uniq(nodeMods));
    exports.set(file, exportsIn(text));
    refusals.set(file, refusalsIn(text));
    widths.set(file, byteWidthsIn(text));
  }

  const importedBy = new Map<string, string[]>(files.map((f) => [f, []]));
  for (const f of files) {
    for (const to of imports.get(f) === undefined ? [] : (imports.get(f) as string[])) {
      const list = importedBy.get(to);
      if (list !== undefined) list.push(f);
    }
  }

  /* Circuits this file names itself, from the client scan the caller passes in. */
  const direct = new Map<string, string[]>(files.map((f) => [f, []]));
  for (const inv of input.invocations === undefined ? [] : input.invocations) {
    const list = direct.get(inv.from);
    if (list !== undefined) list.push(inv.circuit);
  }

  /*
   * REACHABILITY RUNS ALONG THE IMPORT EDGE, IMPORTER TO IMPORTED, and the
   * direction is the whole meaning of the column: *if I call into this module,
   * what can end up on chain?* A cycle is ordinary in this tree, so the walk is
   * a visited-set flood per module rather than a memoised recursion, which
   * would return a half-filled answer for whichever member of a cycle it
   * entered first.
   */
  /* Circuit to circuit, as an adjacency map, for the second closure below. */
  const runs = new Map<string, string[]>();
  for (const e of input.circuitCalls === undefined ? [] : input.circuitCalls) {
    runs.set(e.from, [...(runs.get(e.from) === undefined ? [] : (runs.get(e.from) as string[])), e.to]);
  }

  const reached = new Map<string, string[]>();
  for (const f of files) {
    const seen = new Set<string>();
    const frontier = [f];
    const circuits = new Set<string>();
    while (frontier.length > 0) {
      const cur = frontier.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const c of direct.get(cur) === undefined ? [] : (direct.get(cur) as string[])) circuits.add(c);
      for (const next of imports.get(cur) === undefined ? [] : (imports.get(cur) as string[])) {
        if (!seen.has(next)) frontier.push(next);
      }
    }
    /*
     * THEN CLOSE OVER WHAT THOSE CIRCUITS THEMSELVES RUN. Two floods rather
     * than one, because they follow different kinds of edge and only the second
     * can cross a contract boundary. A cycle between circuits is handled the
     * same way as one between modules.
     */
    const circuitFrontier = [...circuits];
    while (circuitFrontier.length > 0) {
      const cur = circuitFrontier.pop() as string;
      for (const next of runs.get(cur) === undefined ? [] : (runs.get(cur) as string[])) {
        if (!circuits.has(next)) { circuits.add(next); circuitFrontier.push(next); }
      }
    }
    reached.set(f, [...circuits].sort());
  }

  const at = <T>(m: Map<string, T[]>, k: string): T[] => (m.get(k) === undefined ? [] : (m.get(k) as T[]));

  const modules: ModuleNode[] = files.map((file) => ({
    file,
    imports: at(imports, file),
    importedBy: uniq(at(importedBy, file)),
    external: at(external, file),
    builtin: at(builtin, file),
    exports: at(exports, file),
    refusals: at(refusals, file),
    byteWidths: at(widths, file),
    circuits: uniq(at(direct, file)),
    circuitsReached: at(reached, file),
  }));

  /*
   * FIVE OF THE ORDERINGS BELOW ARE A GUARANTEE AND NOT A MECHANISM, AND
   * SAYING SO IS THE POINT.
   *
   * The file list is sorted before the walk and each per-file extractor
   * publishes in line order, so `edges`, `unreadable`, `unresolved` and
   * `outsideTheWalkedSet` are already in the order these calls put them in —
   * and so is the second `uniq`, on `importedBy`, which is fed from an
   * already-deduplicated list. NO FIXTURE CAN DISTINGUISH ANY OF THEM, so no
   * test pins them, and a reader must not take their presence as evidence that
   * ordering was checked here. What IS pinned is the sort on the incoming file
   * list, on which all five depend.
   */
  return {
    modules,
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.to.localeCompare(b.to)),
    unreadable: unreadable.sort((a, b) => a.file.localeCompare(b.file)),
    unresolved: unresolved.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line),
    outsideTheWalkedSet: outside.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line),
  };
}
