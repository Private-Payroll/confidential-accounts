/**
 * THE KIT'S AND THE APPLICATION'S SOURCE RULES, AS FUNCTIONS OVER SOURCE TEXT.
 *
 * Each rule is a function that takes files and returns what breaks it, so the
 * tests that hold the kit and the application run the same rule, and each rule
 * has its own test against text written to break it. Source is parsed with the
 * bundler's own parser, so what is read is what is served.
 *
 * THE WORDING, COLOUR AND LEFT-OR-RIGHT RULES REFUSE BY DEFAULT. Each reads
 * every string or every class word in a file, and lets through only what
 * stands in a position named in this file with the reason it is safe there. A
 * position a screen needs and this file lacks is added as one entry with its
 * reason. THE AMOUNT RULE CANNOT: nothing in source says which values are
 * amounts, so it refuses every conversion it names, from any value, and says
 * beside it which conversions it does not read. What it does not read is
 * closed by the amount itself, an object that React refuses to show and that
 * throws when anything makes text or a number of it.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseSync } from 'vite';

export interface Source { path: string; text: string }
export interface Breach { path: string; line: number; what: string }

type Node = { type: string; start: number; end: number; [k: string]: unknown };

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

const parse = (s: Source) => {
  const r = parseSync(s.path.replace(/\.(m?ts)$/, '.ts'), s.text);
  if (r.errors.length > 0) throw new Error(`${s.path} did not parse: ${r.errors[0]!.message}`);
  return r;
};

/** Every node under `root`, parents before children, each with its parent. */
function* walk(root: unknown, parent: Node | null = null): Generator<{ node: Node; parent: Node | null }> {
  if (Array.isArray(root)) { for (const r of root) yield* walk(r, parent); return; }
  if (root === null || typeof root !== 'object') return;
  const node = root as Node;
  if (typeof node.type === 'string') yield { node, parent };
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'parent') continue;
    if (v !== null && typeof v === 'object') yield* walk(v, typeof node.type === 'string' ? node : parent);
  }
}

/** Every node under `root`, each with every node above it, the outermost first. */
function* walkDown(root: unknown, up: readonly Node[] = []): Generator<{ node: Node; up: readonly Node[] }> {
  if (Array.isArray(root)) { for (const r of root) yield* walkDown(r, up); return; }
  if (root === null || typeof root !== 'object') return;
  const node = root as Node;
  const isNode = typeof node.type === 'string';
  if (isNode) yield { node, up };
  const below = isNode ? [...up, node] : up;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'parent') continue;
    if (v !== null && typeof v === 'object') yield* walkDown(v, below);
  }
}

/** Each node above `node` with the child it was reached through, the nearest first. */
function* parentsOf(node: Node, up: readonly Node[]): Generator<{ parent: Node; child: Node; above: Node | undefined }> {
  for (let i = up.length - 1; i >= 0; i -= 1) yield { parent: up[i]!, child: up[i + 1] ?? node, above: up[i - 1] };
}

const nameOf = (n: unknown): string => {
  const x = n as Node | null | undefined;
  return x?.type === 'Identifier' || x?.type === 'JSXIdentifier' ? String(x.name) : x?.type === 'Literal' ? String(x.value) : '';
};

/** A code file that ships: TypeScript or TSX, and not a test or a test's support. */
export const isShippingCode = (p: string): boolean =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !/\.test-support\.ts$/.test(p) && !p.endsWith('.d.ts');

/** Every file under `dir` whose path passes `keep`, relative to `root`, sorted. */
export function filesUnder(root: string, dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) go(p);
      else { const r = relative(root, p).split(sep).join('/'); if (keep(r)) out.push(r); }
    }
  };
  go(join(root, dir));
  return out.sort();
}

/* ------------------------------------------------------------------ imports */

/*
 * ONE READER OF IMPORTS, THE BROWSER GRAPH'S (`scripts/browser-graph.ts`). It
 * reads a file after the bundler's own TypeScript transform, so the rules here
 * see the imports a browser is served and give the same answer as the walk
 * that finds what a page reaches: an import used only for its types is gone,
 * as it is from the page, and an import whose module is worked out at run time
 * comes back as the code that works it out, which the package rule below
 * refuses unless that code happens to be spelled like a declared package's name
 * (`import(react)`). The reader is loaded
 * by its address, as the application's rules load the walk, so it is
 * typechecked where it lives and not a second time under the kit's settings.
 */
interface Edge { specifier: string; dynamic: boolean; worker: boolean }
interface ImportReader { importsOf: (file: string, source: string) => Promise<Edge[]>; isNodeBuiltin: (specifier: string) => boolean }
const READER = new URL('../../../../scripts/browser-graph.ts', import.meta.url).href;
let reader: Promise<ImportReader> | undefined;
const importReader = (): Promise<ImportReader> => (reader ??= import(/* @vite-ignore */ READER) as Promise<ImportReader>);

/** Where a module is named in a file: the first place its name is written in quotes, else the first line. */
const lineNaming = (text: string, specifier: string): number => {
  for (const q of ["'", '"', '`']) { const at = text.indexOf(q + specifier + q); if (at >= 0) return lineOf(text, at); }
  const bare = text.indexOf(specifier);
  return bare >= 0 ? lineOf(text, bare) : 1;
};

/** Every module a file names, as the browser graph reads it, each with the line it is named on. */
export async function specifiersOf(s: Source): Promise<{ specifier: string; line: number }[]> {
  const { importsOf } = await importReader();
  return (await importsOf(s.path, s.text)).map((e) => ({ specifier: e.specifier, line: lineNaming(s.text, e.specifier) }));
}

/*
 * EVERY MODULE A FILE NAMES IN ITS OWN DECLARATIONS, READ FROM THE SOURCE:
 * each `import` and `export ... from`, including those used only for types
 * (`import type`, `import { type X }`, `export type { X } from`), and a type
 * written as `import('...')`. The reader above drops the type-only ones,
 * because the page never loads them. The rules about WHERE a file may reach
 * need them too, because a type taken from a folder binds the file to that
 * folder's insides as surely as a value does.
 */
function declaredSpecifiersOf(s: Source): { specifier: string; line: number }[] {
  const out: { specifier: string; line: number }[] = [];
  for (const { node } of walk(parse(s).program)) {
    let source: Node | null = null;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') source = (node.source ?? null) as Node | null;
    if (node.type === 'TSImportType') {
      const arg = (node.source ?? node.argument ?? null) as Node | null;
      source = arg?.type === 'TSLiteralType' ? (arg.literal as Node) : arg;
    }
    if (source?.type === 'Literal' && typeof source.value === 'string') out.push({ specifier: source.value, line: lineOf(s.text, source.start) });
  }
  return out;
}

/** Every module a file names, as the browser is served it or as a type only, each with its line, each import once. */
async function everySpecifierOf(s: Source): Promise<{ specifier: string; line: number }[]> {
  const declared = declaredSpecifiersOf(s);
  /* Each declaration the reader also returned is counted once, at the declaration's own line; what the reader alone returns (an `import()`, a worker) is kept. */
  const left = new Map<string, number>();
  for (const d of declared) left.set(d.specifier, (left.get(d.specifier) ?? 0) + 1);
  const extra = (await specifiersOf(s)).filter((r) => {
    const n = left.get(r.specifier) ?? 0;
    if (n === 0) return true;
    left.set(r.specifier, n - 1);
    return false;
  });
  return [...extra, ...declared];
}

/** The package a bare specifier names: `@scope/name` or `name`. */
export const packageOf = (spec: string): string => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
};

const isPath = (spec: string) => spec.startsWith('.') || spec.startsWith('/');

/**
 * RULE: every package a file imports is declared by the package the file is
 * in. `declared` is that package's own dependencies and peer dependencies, and
 * its own name, which is how a package reaches its own files. A Node built-in
 * is never declared, so it is always a breach in code a browser is served, and
 * so is an import whose module is worked out at run time.
 */
export async function undeclaredImports(files: readonly Source[], declared: ReadonlySet<string>): Promise<Breach[]> {
  const { isNodeBuiltin } = await importReader();
  const out: Breach[] = [];
  for (const f of files) {
    for (const { specifier, line } of await specifiersOf(f)) {
      if (isPath(specifier)) continue;
      if (isNodeBuiltin(specifier) || !declared.has(packageOf(specifier))) out.push({ path: f.path, line, what: specifier });
    }
  }
  return out;
}

/** What a package's own `package.json` lets its files import. */
export function declaredBy(packageJson: string): Set<string> {
  const p = JSON.parse(packageJson) as { name: string; dependencies?: object; peerDependencies?: object };
  return new Set([p.name, ...Object.keys(p.dependencies ?? {}), ...Object.keys(p.peerDependencies ?? {})]);
}

/**
 * RULE: the application reaches the kit only by its package name, and only
 * what the kit's index exports. A relative or absolute path that lands inside
 * the kit's folder is a breach, and so is one used only for a type; so is a
 * module inside the kit named through the package (`vaults-ui/format/...`),
 * which reaches what the index keeps back, the amount formatter above all. A
 * stylesheet (`vaults-ui/styles.css`) is not code and is let through. `root`
 * is the repository, `kit` the kit's folder in it; `name` is the kit's package
 * name.
 */
export async function pathsIntoTheKit(files: readonly Source[], root: string, kit: string, name = 'vaults-ui'): Promise<Breach[]> {
  /* Compared without case: the Mac's file system finds `packages/UI` as `packages/ui`. */
  const kitDir = (resolve(root, kit) + sep).toLowerCase();
  const out: Breach[] = [];
  for (const f of files) {
    for (const { specifier, line } of await everySpecifierOf(f)) {
      const target = specifier.startsWith('.') ? resolve(root, dirname(f.path), specifier)
        : specifier.startsWith('/') ? resolve(root, `.${specifier}`) : null;
      if (target !== null && (target + sep).toLowerCase().startsWith(kitDir)) out.push({ path: f.path, line, what: specifier });
      if (target === null && specifier.startsWith(`${name}/`) && !specifier.endsWith('.css')) out.push({ path: f.path, line, what: specifier });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ cn */

/**
 * RULE: one `cn`, the kit's, at `home`. A breach is an import of the `cn`
 * package, or of the two libraries `cn` is made from, anywhere but `home`;
 * an import of `cx`, the class joiner `class-variance-authority` also offers;
 * or a function, variable or export named `cn` declared anywhere but `home`.
 * Which modules are imported is the reader's answer; which NAMES an import
 * binds is not something the reader returns, so `cx` is found in the parsed file.
 */
export async function secondCn(files: readonly Source[], home: string): Promise<Breach[]> {
  const out: Breach[] = [];
  for (const f of files) {
    if (f.path === home) continue;
    for (const { specifier, line } of await specifiersOf(f)) {
      if (['cn', 'clsx', 'tailwind-merge'].includes(packageOf(specifier))) out.push({ path: f.path, line, what: `imports ${specifier}` });
    }
    for (const { node } of walk(parse(f).program)) {
      if (node.type === 'ImportDeclaration' && (node.source as Node).value === 'class-variance-authority') {
        for (const s of node.specifiers as Node[]) if (s.type === 'ImportSpecifier' && nameOf(s.imported) === 'cx') out.push({ path: f.path, line: lineOf(f.text, node.start), what: 'imports cx' });
      }
      const id = (node.id ?? null) as Node | null;
      const named = (node.type === 'FunctionDeclaration' || node.type === 'VariableDeclarator') && id?.type === 'Identifier' && id.name === 'cn';
      if (named) out.push({ path: f.path, line: lineOf(f.text, node.start), what: 'declares cn' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the one way into shared code */

/*
 * THE PACKAGES OF SHARED CODE, reached only through the application's
 * adapters: the browser code both web applications are built on, which talks
 * to the service and to the person's wallet, and hands amounts back as bare
 * `bigint` counts.
 */
export const SHARED_PACKAGES: ReadonlySet<string> = new Set(['vaults-web-shared']);

/** The objects the browser's own globals are reached through. */
const GLOBAL_SCOPES = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'opener', 'frames']);

/** An expression without the casts, brackets and commas around it: `(window as any)` and `(0, window)` are `window`. */
const unwrapped = (n: unknown): Node | undefined => {
  let x = n as Node | undefined;
  for (;;) {
    if (x !== undefined && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'].includes(x.type)) x = x.expression as Node;
    else if (x?.type === 'SequenceExpression') x = (x.expressions as Node[]).at(-1);
    else return x;
  }
};
/** Whether an expression is one of the global objects, however it is cast, or the page's own window reached through its document (`document.defaultView`). */
const isGlobalScope = (n: unknown): boolean => {
  const x = unwrapped(n);
  return GLOBAL_SCOPES.has(nameOf(x)) || (x?.type === 'MemberExpression' && (GLOBAL_SCOPES.has(propertyName(x)) || propertyName(x) === 'defaultView'));
};

/** Every name a file binds: its variables, however taken apart, its functions, classes, parameters and imports. */
function bindingsOf(program: unknown): Set<string> {
  const out = new Set<string>();
  const add = (n: Node | null | undefined): void => {
    if (!n) return;
    if (n.type === 'Identifier') out.add(String(n.name));
    else if (n.type === 'ObjectPattern') for (const q of n.properties as Node[]) add(q.type === 'RestElement' ? q.argument as Node : q.value as Node);
    else if (n.type === 'ArrayPattern') for (const e of n.elements as (Node | null)[]) add(e);
    else if (n.type === 'RestElement') add(n.argument as Node);
    else if (n.type === 'AssignmentPattern') add(n.left as Node);
  };
  for (const { node } of walk(program)) {
    if (node.type === 'VariableDeclarator') add(node.id as Node);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) { add(node.id as Node); for (const q of (node.params as Node[]) ?? []) add(q); }
    if (node.type === 'ClassDeclaration') add(node.id as Node);
    if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) add(node.local as Node);
    if (node.type === 'CatchClause') add(node.param as Node);
  }
  return out;
}
/** A string written in the code, in quotes or as a template with nothing in it, or null. */
const literalText = (n: Node | undefined): string | null => n?.type === 'Literal' && typeof n.value === 'string' ? n.value
  : n?.type === 'TemplateLiteral' && (n.expressions as unknown[]).length === 0 ? textOf(n) : null;

/*
 * HOW A BROWSER PAGE TALKS TO ANYTHING OUTSIDE IT: the service over the
 * network, and the wallet through a frame, a window it opens, messages, or
 * what a wallet extension puts on the page. Each is a breach outside the
 * adapters, whichever way it is written.
 */
const TALKS_OUT = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'MessageChannel', 'BroadcastChannel', 'postMessage',
  'RTCPeerConnection', 'WebTransport', 'midnight', 'eval', 'Function']);
/** Reached through a global object only, since a name like `open` is also an ordinary name. */
const TALKS_OUT_ON_A_GLOBAL = new Set([...TALKS_OUT, 'open', 'midnight']);
/** Whatever it is reached on. */
const TALKS_OUT_ON_ANYTHING = new Set(['postMessage', 'contentWindow', 'sendBeacon', 'onmessage', 'serviceWorker']);

/** A property's name as written: `a.b` and `a['b']` are both `b`; a name built at run time is ''. */
const propertyName = (m: Node): string => {
  const prop = m.property as Node;
  return prop.type === 'Identifier' && !m.computed ? String(prop.name) : prop.type === 'Literal' ? String(prop.value) : '';
};

const inside = (path: string, dir: string): boolean => (path + sep).toLowerCase().startsWith((dir + sep).toLowerCase());

/**
 * RULE: SHARED CODE, THE SERVICE AND THE WALLET ARE REACHED ONLY FROM THE
 * ADAPTERS. Outside the folder `adapters` (null: nowhere), a breach is: an
 * import of a shared package (`SHARED_PACKAGES`), for its values or its types;
 * an import, of either kind, by a path that leaves `own` (the files' own
 * source folder), which is how the product's own code, the shared package's
 * files or the wallet's would be reached; an `import()` whose module is worked
 * out at run time; an `import.meta.glob` that leaves `own`; any name in
 * `TALKS_OUT` (`fetch`, `WebSocket`, `postMessage`, `midnight`, ...); `open`
 * on a global object (`window.open`); `postMessage`, `contentWindow`,
 * `sendBeacon`, `onmessage` or `serviceWorker` on anything; listening for
 * `message` events; a global reached by a name built at run time; and a global
 * object handed on as a value (`const w = window`, `Reflect.get(window, k)`),
 * since whatever it is handed to can reach all of the above. `typeof window`
 * is only a question and is let through. `root` is the repository.
 *
 * NOT READ: a page loaded some other way, by an element's address (`<iframe
 * src>`, `<img src>`, `<form action>`, `document.createElement('script')`) or
 * by moving the page (`location`).
 */
export async function waysIntoSharedCode(files: readonly Source[], root: string, own: string, adapters: string | null): Promise<Breach[]> {
  const ownDir = resolve(root, own);
  const out: Breach[] = [];
  for (const f of files) {
    if (adapters !== null && inside(resolve(root, f.path), resolve(root, adapters))) continue;
    const breach = (line: number, what: string) => out.push({ path: f.path, line, what });
    for (const { specifier, line } of await everySpecifierOf(f)) {
      if (isPath(specifier)) {
        const target = specifier.startsWith('.') ? resolve(root, dirname(f.path), specifier) : resolve(root, `.${specifier}`);
        if (!inside(target, ownDir)) breach(line, `reaches ${specifier}`);
      } else if (SHARED_PACKAGES.has(packageOf(specifier))) breach(line, `imports ${specifier}`);
    }
    const program = parse(f).program;
    /* A name the file binds itself (`const midnight = new Date()`) is its own, not the browser's. */
    const bound = bindingsOf(program);
    for (const { node, up } of walkDown(program)) {
      const at = lineOf(f.text, node.start);
      const p = up[up.length - 1];
      const isName = (p?.type === 'MemberExpression' && p.property === node && !p.computed) || (p?.type === 'Property' && p.key === node && !p.computed && !p.shorthand);
      const typeOnly = up.some((u) => u.type.startsWith('TS') && !RUNTIME_TS.has(u.type));
      if (node.type === 'Identifier' && TALKS_OUT.has(String(node.name)) && !bound.has(String(node.name)) && !isName && !typeOnly) breach(at, String(node.name));
      const aGlobal = (node.type === 'Identifier' && GLOBAL_SCOPES.has(String(node.name)) && !isName) || (node.type === 'MemberExpression' && isGlobalScope(node));
      if (aGlobal && !typeOnly) {
        /*
         * A global object is read here only as the object of a property, asked
         * about (`typeof window`), compared (`event.source === window`, `'x' in
         * window`), or taken apart into plain names that reach nothing above.
         */
        const q = [...up].reverse().find((u) => !['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'SequenceExpression'].includes(u.type));
        const named = q?.type === 'MemberExpression' && unwrapped(q.object) === node;
        const asked = q?.type === 'UnaryExpression' && q.operator === 'typeof';
        const compared = q?.type === 'BinaryExpression' && (['===', '!==', '==', '!='].includes(String(q.operator)) || (q.operator === 'in' && unwrapped(q.right) === node));
        const plainKey = (x: Node): boolean => x.type === 'Property' && !x.computed && (x.value as Node).type === 'Identifier'
          && !TALKS_OUT_ON_A_GLOBAL.has(nameOf(x.key)) && !TALKS_OUT_ON_ANYTHING.has(nameOf(x.key)) && !GLOBAL_SCOPES.has(nameOf(x.key)) && nameOf(x.key) !== 'defaultView';
        const takenApart = q?.type === 'VariableDeclarator' && unwrapped(q.init) === node && (q.id as Node).type === 'ObjectPattern' && ((q.id as Node).properties as Node[]).every(plainKey);
        const label = node.type === 'Identifier' ? String(node.name) : propertyName(node);
        if (!named && !asked && !compared && !takenApart) breach(at, `${label} handed on`);
      }
      if (node.type === 'MemberExpression' && node.computed && isGlobalScope(node.object) && propertyName(node) === '') breach(at, 'a global reached by a built name');
      if (node.type === 'ImportExpression' && literalText(node.source as Node) === null) breach(at, 'import() of a module worked out at run time');
      if (node.type === 'MemberExpression') {
        const name = propertyName(node);
        const onGlobal = isGlobalScope(node.object);
        if ((onGlobal && TALKS_OUT_ON_A_GLOBAL.has(name)) || TALKS_OUT_ON_ANYTHING.has(name)) breach(at, onGlobal ? `${nameOf(unwrapped(node.object)) || 'window'}.${name}` : `.${name}`);
      }
      /* Taken apart from a global object: `const { fetch } = window`. */
      if (node.type === 'VariableDeclarator' && (node.id as Node).type === 'ObjectPattern' && isGlobalScope(node.init)) {
        for (const q of (node.id as Node).properties as Node[]) {
          const key = q.type === 'Property' ? (q.computed && (q.key as Node).type !== 'Literal' ? '' : nameOf(q.key)) : '';
          if (TALKS_OUT_ON_A_GLOBAL.has(key) || TALKS_OUT_ON_ANYTHING.has(key)) breach(lineOf(f.text, q.start), `${nameOf(unwrapped(node.init)) || 'window'}.${key}`);
        }
      }
      if (node.type === 'CallExpression' && ['setTimeout', 'setInterval'].includes(nameOf((node.callee as Node).property ?? node.callee))) {
        const [first] = node.arguments as Node[];
        if (first !== undefined && (first.type === 'TemplateLiteral' || (first.type === 'Literal' && typeof first.value === 'string') || first.type === 'BinaryExpression')) breach(at, `${nameOf((node.callee as Node).property ?? node.callee)} given code as text`);
      }
      if (node.type === 'CallExpression' && nameOf((node.callee as Node).property ?? node.callee) === 'addEventListener') {
        const [first] = node.arguments as Node[];
        if (literalText(first) === 'message') breach(at, "addEventListener('message')");
      }
      if (node.type === 'CallExpression' && (node.callee as Node).type === 'MemberExpression' && ((node.callee as Node).object as Node).type === 'MetaProperty' && nameOf((node.callee as Node).property) === 'glob') {
        for (const a of node.arguments as Node[]) {
          const patterns = a.type === 'Literal' ? [a] : a.type === 'ArrayExpression' ? (a.elements as Node[]) : [];
          for (const g of patterns) {
            if (g?.type !== 'Literal' || typeof g.value !== 'string') continue;
            const pattern = String(g.value).replace(/^!/, '');
            const target = pattern.startsWith('/') ? resolve(root, `.${pattern}`) : resolve(root, dirname(f.path), pattern);
            if (!inside(target, ownDir)) breach(at, `import.meta.glob ${pattern}`);
          }
        }
      }
    }
  }
  return out;
}

/**
 * RULE: AN AMOUNT IS MADE ONLY IN THE ADAPTERS, where its decimals and code
 * are read from the token's own record. Anywhere else, naming `tokenAmount`
 * is a breach: a screen that made one would type the decimals, and a figure
 * with the wrong decimals is a figure a thousand or a million times wrong.
 * `adapters` is the folder allowed; null allows none.
 */
export function amountsMadeOutsideTheAdapters(files: readonly Source[], root: string, adapters: string | null): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    if (adapters !== null && inside(resolve(root, f.path), resolve(root, adapters))) continue;
    /* An import's name is two nodes at one place, the name imported and the local one. */
    const seen = new Set<string>();
    for (const { node, up } of walkDown(parse(f).program)) {
      const p = up[up.length - 1];
      const grand = up[up.length - 2];
      /* A key of an object the file writes is a name of its own; a key taken out of one (`const { tokenAmount: m } = kit`) is the constructor. */
      const ownKey = p?.type === 'Property' && p.key === node && !p.computed && !p.shorthand && grand?.type === 'ObjectExpression';
      const asProperty = p?.type === 'MemberExpression' && p.property === node;
      const named = (node.type === 'Identifier' && node.name === 'tokenAmount' && !ownKey && !asProperty)
        || (node.type === 'MemberExpression' && propertyName(node) === 'tokenAmount');
      if (!named || seen.has(`${node.start}:${node.end}`)) continue;
      seen.add(`${node.start}:${node.end}`);
      out.push({ path: f.path, line: lineOf(f.text, node.start), what: 'tokenAmount' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ what a file writes */

/** A stylesheet or a page, read as text rather than parsed as code. */
const isMarkup = (p: string) => /\.(css|html)$/.test(p);

/**
 * A page attribute's value, in any of the three ways a page may write one:
 * double quotes, single quotes, or none (`<p title=Hello>`). The value is in
 * one of three consecutive groups, the 2nd, 3rd and 4th of this pattern,
 * shifted by any group a caller puts before it; `valueOf` takes the first of
 * the three that matched.
 */
const ATTRIBUTE_VALUE = String.raw`\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))`;
const valueOf = (m: RegExpMatchArray, first: number): string => (m[first] ?? m[first + 1] ?? m[first + 2])!;

/** A stylesheet's text without its comments. */
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

/** The CSS a file carries: a stylesheet whole, or a page's `<style>` blocks and `style` attributes. */
function cssOf(s: Source): { css: string; at: number }[] {
  if (s.path.endsWith('.css')) return [{ css: withoutComments(s.text), at: 0 }];
  const out: { css: string; at: number }[] = [];
  for (const m of s.text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push({ css: withoutComments(m[1]!), at: m.index });
  for (const m of s.text.matchAll(new RegExp(String.raw`\sstyle` + ATTRIBUTE_VALUE, 'gi'))) out.push({ css: `{${valueOf(m, 2)}}`, at: m.index });
  return out;
}

/** Every declaration in some CSS: `color: red` is `color`, `red`. */
function declarationsOf(css: string): { property: string; value: string; at: number }[] {
  return [...css.matchAll(/(?:^|[{;])\s*(--?[A-Za-z][\w-]*|[A-Za-z][\w-]*)\s*:\s*([^;{}]*)(?=[;}]|$)/gm)]
    .map((m) => ({ property: m[1]!.toLowerCase(), value: m[2]!.trim(), at: m.index }));
}

/** The class words a stylesheet or page writes: every word of an `@apply`, and of a page's `class` attribute. */
function markupClassWordsOf(s: Source): { word: string; at: number }[] {
  const out: { word: string; at: number }[] = [];
  for (const { css, at } of cssOf(s)) for (const m of css.matchAll(/@apply\s+([^;]+);/g)) for (const w of m[1]!.split(/\s+/)) if (w) out.push({ word: w, at: at + m.index });
  if (s.path.endsWith('.html')) for (const m of s.text.matchAll(new RegExp(String.raw`\sclass` + ATTRIBUTE_VALUE, 'gi'))) for (const w of valueOf(m, 2).split(/\s+/)) if (w) out.push({ word: w, at: m.index });
  return out;
}

/**
 * Every word of every string a file writes, with where: each string literal
 * and each piece of template text in code, wherever it stands, and the class
 * words of a stylesheet or page. A class held in a variable, a map or a
 * function's return value is read the same as one written in `className`.
 */
export function stringWordsOf(s: Source): { word: string; at: number }[] {
  if (isMarkup(s.path)) return markupClassWordsOf(s);
  const out: { word: string; at: number }[] = [];
  for (const { node } of walk(parse(s).program)) {
    const text = node.type === 'Literal' && typeof node.value === 'string' ? node.value
      : node.type === 'TemplateElement' ? (node.value as { raw: string }).raw : null;
    if (text === null) continue;
    for (const w of text.split(/\s+/)) if (w) out.push({ word: w, at: node.start });
  }
  return out;
}

/* ------------------------------------------------------------------ colours */

const COLOUR_VALUE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g;

/** RULE: no colour value in a component or in the application; colours come from the theme's tokens. */
export function colourValues(files: readonly Source[]): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(COLOUR_VALUE)) out.push({ path: f.path, line: lineOf(f.text, m.index), what: m[0] });
  }
  return out;
}

/**
 * Every class name in a file, with where: each word of every string inside a
 * `className` prop or inside a call to `cn` or `cva`, the three places a class
 * name is written. The colour and left-or-right rules read `stringWordsOf`,
 * every string; this narrower reading is for the state variants a stylesheet
 * must define, where a word that is not a class would be a false alarm.
 */
export function classWordsOf(s: Source): { word: string; at: number }[] {
  const roots: Node[] = [];
  for (const { node } of walk(parse(s).program)) {
    if (node.type === 'JSXAttribute' && (node.name as Node).type === 'JSXIdentifier' && (node.name as Node).name === 'className' && node.value) roots.push(node.value as Node);
    if (node.type === 'CallExpression' && (node.callee as Node).type === 'Identifier' && ['cn', 'cva'].includes(String((node.callee as Node).name))) roots.push(...(node.arguments as Node[]));
  }
  const seen = new Set<number>();
  const out: { word: string; at: number }[] = [];
  for (const root of roots) {
    for (const { node, parent } of walk(root)) {
      if (seen.has(node.start)) continue;
      const isKey = parent?.type === 'Property' && parent.key === node && !parent.computed;
      let text: string | null = null;
      if (node.type === 'Literal' && typeof node.value === 'string' && !isKey) text = node.value;
      if (node.type === 'TemplateElement') text = (node.value as { raw: string }).raw;
      if (text === null) continue;
      seen.add(node.start);
      for (const w of text.split(/\s+/)) if (w) out.push({ word: w, at: node.start });
    }
  }
  return out;
}

/** The utility a class name applies, without its variants, `!` or leading `-`: `hover:-ml-2!` is `ml-2`. */
export function utilityOf(word: string): string {
  let depth = 0; let last = 0;
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
    else if (c === ':' && depth === 0) last = i + 1;
  }
  return word.slice(last).replace(/^!/, '').replace(/!$/, '').replace(/^-/, '');
}

const wordBreaches = (files: readonly Source[], bad: (utility: string) => boolean): Breach[] =>
  files.flatMap((f) => stringWordsOf(f).filter(({ word }) => bad(utilityOf(word)))
    .map(({ word, at }) => ({ path: f.path, line: lineOf(f.text, at), what: word })));

const PALETTE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|black|white';
const COLOUR_UTILITY = new RegExp(`^(?:bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|decoration|divide|from|via|to|shadow|inset-shadow|inset-ring|accent|caret|placeholder)-(?:${PALETTE})(?:-\\d+)?(?:\\/\\S+)?$`);

/**
 * RULE: no Tailwind palette colour (`bg-red-500`, `text-white`) in any string
 * a file writes, however it is held; the kit's stylesheet switches the palette
 * off, so one would silently draw nothing.
 */
export function paletteClasses(files: readonly Source[]): Breach[] {
  return wordBreaches(files, (u) => COLOUR_UTILITY.test(u));
}

const PHYSICAL = /^(?:m[lr]|p[lr]|scroll-m[lr]|scroll-p[lr]|left|right|border-[lr]|rounded-(?:[lr]|tl|tr|bl|br)|text-(?:left|right)|float-(?:left|right)|clear-(?:left|right)|bg-(?:left|right)|object-(?:left|right)|origin-(?:top-|bottom-)?(?:left|right)|(?:top|bottom)-(?:left|right))(?:-|$)/;
const LEFT_OR_RIGHT = /(?:^|[^\w])(?:left|right)(?:$|[^\w])/i;

/**
 * RULE: no left or right; start and end (`ms-`, `pe-`, `text-start`), so a
 * right-to-left language needs no redraw. Read in every string a file writes,
 * a prop's value included (`side="left"`, `position="bottom-right"`), and in
 * every declaration of a stylesheet or a page (`margin-left: 4px`, `float: right`).
 * A popup's slide-in animation named for the side it opens on
 * (`data-[side=left]:slide-in-from-right-2`) is not refused: it follows the
 * side the popup library places it on, which is itself left or right.
 */
export function physicalClasses(files: readonly Source[]): Breach[] {
  const out = wordBreaches(files, (u) => PHYSICAL.test(u));
  for (const f of files) {
    for (const { css, at } of cssOf(f)) {
      for (const d of declarationsOf(css)) if (LEFT_OR_RIGHT.test(`${d.property} ${d.value}`)) out.push({ path: f.path, line: lineOf(f.text, at + d.at), what: `${d.property}: ${d.value}` });
    }
  }
  return out;
}

/*
 * WHAT AN ARBITRARY VALUE MAY BE MADE OF, the only shapes allowed between the
 * brackets of a class (`rounded-[min(var(--radius-md),10px)]`): a theme token,
 * a size, and the functions that combine them. Anything else, a colour's name
 * above all (`bg-[red]`), is refused.
 */
export const ARBITRARY_VALUE_PARTS: Readonly<Record<string, string>> = {
  'var(--token), --token': 'a theme token, which follows the theme and the base colour',
  'calc, min, max, clamp': 'arithmetic on sizes and tokens',
  'color-mix(in_oklch|in_oklab|in_srgb, ...)': 'a blend of theme tokens, in a named colour space',
  'a number, bare or in px, rem, em, ch, vh, vw, dvh, svh, lh, %, deg, ms, s or fr': 'a size, a time or an angle',
  'auto, fr': 'a grid track sized by its content or its share of the space',
};
const VALUE_PART = /var\(--[\w-]+\)|--[\w-]+|\b(?:calc|min|max|clamp|color-mix)(?=\()|\bin_(?:oklch|oklab|srgb)\b|-?\d*\.?\d+(?:px|rem|em|ch|vh|vw|dvh|svh|lh|%|deg|ms|s|fr)?|(?<![A-Za-z])(?:auto|fr)(?![A-Za-z])/g;

/*
 * THE CSS PROPERTIES A CLASS MAY SET BY NAME (`[mask-type:luminance]`). None
 * yet: an arbitrary property is how a class sets a colour or a side that no
 * utility or token allows, so each one a screen needs is added here with why.
 */
export const ARBITRARY_PROPERTIES: Readonly<Record<string, string>> = {};

/**
 * RULE: every arbitrary value in a class is made of the parts named in
 * `ARBITRARY_VALUE_PARTS`, and every arbitrary property is named in
 * `ARBITRARY_PROPERTIES`. `bg-[red]` and `[margin-left:4px]` are refused.
 */
export function arbitraryValues(files: readonly Source[]): Breach[] {
  const bad = (u: string): boolean => {
    /* An opacity after the value (`bg-[red]/50`) does not hide the value. */
    const property = /^\[([A-Za-z-]+):(.+)\](?:\/\S+)?$/.exec(u);
    if (property) return !(property[1]!.toLowerCase() in ARBITRARY_PROPERTIES);
    const value = /^[\w-]+?-(?:\[([^\]]+)\]|\(([^)]+(?:\([^)]*\)[^)]*)*)\))(?:\/\S+)?$/.exec(u);
    if (!value) return false;
    const inside = (value[1] ?? value[2])!;
    return inside.replace(VALUE_PART, '').replace(/[\s_,()+*/-]/g, '') !== '';
  };
  return wordBreaches(files, bad);
}

/*
 * THE PROPERTIES AN INLINE STYLE MAY SET. None yet: a colour or a side set
 * inline escapes every class rule, so a screen that must set something inline
 * (a measured width) adds that one property here, with why.
 */
export const INLINE_STYLE_PROPERTIES: Readonly<Record<string, string>> = {};

/** A property whose value is, or may carry, a colour. */
const COLOUR_PROPERTY = /^(?:color|fill|stroke|background(?:-image)?|border(?:-(?:top|bottom|left|right|block|inline|block-start|block-end|inline-start|inline-end))?|outline|box-shadow|text-shadow|column-rule|text-decoration)$|-color$/;
/** What a colour-bearing value may be made of: a theme token, a size, and the words that name no colour. */
const COLOUR_WORD = /^(?:var\(--[\w-]+\),?|transparent|currentcolor|inherit|initial|unset|none|solid|dashed|dotted|double|inset|-?\d*\.?\d+(?:px|rem|em|%)?,?)$/i;

/**
 * RULE: no inline style sets anything not named in `INLINE_STYLE_PROPERTIES`:
 * a `style` prop, a `style` key in any object in code (the props of
 * `createElement` or `cloneElement`, or an object spread into an element), a
 * `.style` or `['style']` of an element in code, a `style` attribute or
 * `<style>` block in a page, a custom property (`--x`) included. A style built
 * where it cannot be read (`style={s}`) is refused whole. And in a stylesheet,
 * a declaration of a colour property (`color`, `background`, `border`,
 * `box-shadow`, any `...-color`) is made only of theme tokens, sizes and words
 * that name no colour; a custom property there (`--x`) is the theme's and is
 * not read.
 */
export function inlineStyles(files: readonly Source[]): Breach[] {
  const out: Breach[] = [];
  const allowed = (key: string) => key in INLINE_STYLE_PROPERTIES;
  const objectBreaches = (f: Source, v: Node): void => {
    if (v.type !== 'ObjectExpression') { out.push({ path: f.path, line: lineOf(f.text, v.start), what: 'style' }); return; }
    for (const p of v.properties as Node[]) {
      const key = p.type === 'Property' && !p.computed ? nameOf(p.key) : '';
      if (!allowed(key)) out.push({ path: f.path, line: lineOf(f.text, p.start), what: `style ${key || f.text.slice(p.start, p.end)}` });
    }
  };
  for (const f of files) {
    if (isMarkup(f.path)) {
      const sheet = f.path.endsWith('.css');
      for (const { css, at } of cssOf(f)) {
        for (const d of declarationsOf(css)) {
          if (sheet && d.property.startsWith('--')) continue;
          const colour = COLOUR_PROPERTY.test(d.property) && !d.value.split(/\s+/).every((w) => COLOUR_WORD.test(w));
          if ((!sheet && !allowed(d.property)) || colour) out.push({ path: f.path, line: lineOf(f.text, at + d.at), what: `${d.property}: ${d.value}` });
        }
      }
      continue;
    }
    for (const { node, parent } of walk(parse(f).program)) {
      if (node.type === 'JSXAttribute' && nameOf(node.name) === 'style' && node.value) {
        const v = node.value as Node;
        objectBreaches(f, v.type === 'JSXExpressionContainer' ? v.expression as Node : v);
      }
      /* A style is an object; a `style` that is a word (`{ style: 'percent' }`, a formatter's option) is not one. */
      const value = node.value as Node | undefined;
      if (node.type === 'Property' && nameOf(node.key) === 'style' && parent?.type === 'ObjectExpression' && !(value?.type === 'Literal' && typeof value.value === 'string')) objectBreaches(f, value!);
      if (node.type === 'MemberExpression' && ['style', 'cssText'].includes(nameOf(node.property))) {
        out.push({ path: f.path, line: lineOf(f.text, node.start), what: `.${nameOf(node.property)}` });
      }
      if (node.type === 'CallExpression' && nameOf((node.callee as Node).property) === 'setAttribute') {
        const [first] = node.arguments as Node[];
        if (first?.type === 'Literal' && String(first.value).toLowerCase() === 'style') out.push({ path: f.path, line: lineOf(f.text, node.start), what: "setAttribute('style')" });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ wording */

const hasLetter = (t: string) => /\p{L}/u.test(t);

const isCreateElement = (callee: Node): boolean => (callee.type === 'Identifier' && ['createElement', 'jsx', 'jsxs'].includes(String(callee.name)))
  || (callee.type === 'MemberExpression' && (callee.property as Node).type === 'Identifier' && (callee.property as Node).name === 'createElement');

/** Every name a translation function goes by in a file: `t`, and whatever `useText()`, `t` itself or a destructured `t` is given to. */
function translatorsOf(program: unknown): Set<string> {
  const names = new Set(['t']);
  for (const { node } of walk(program)) {
    if (node.type !== 'VariableDeclarator') continue;
    const id = node.id as Node; const init = node.init as Node | null;
    if (id.type === 'Identifier' && init !== null && ((init.type === 'CallExpression' && (init.callee as Node).type === 'Identifier' && (init.callee as Node).name === 'useText')
      || (init.type === 'Identifier' && names.has(String(init.name))))) names.add(String(id.name));
    if (id.type === 'ObjectPattern') {
      for (const p of id.properties as Node[]) {
        const key = p.key as Node | undefined; const value = p.value as Node | undefined;
        if (key?.type === 'Identifier' && key.name === 't' && value?.type === 'Identifier') names.add(String(value.name));
      }
    }
  }
  return names;
}

const isTranslator = (callee: Node, names: ReadonlySet<string>): boolean => (callee.type === 'Identifier' && names.has(String(callee.name)))
  || (callee.type === 'MemberExpression' && (callee.property as Node).type === 'Identifier' && (callee.property as Node).name === 't');

/*
 * THE ATTRIBUTES AND PROPS WHOSE VALUE IS NEVER SHOWN, each with why. A value
 * given to any other attribute, `title`, `alt`, `aria-label`, `content` or a
 * component's own `label`, is read as wording and refused. `data-...` is one
 * entry for every attribute that starts so. `on` limits an entry to the
 * elements or components named; `page` limits it to a page's own markup.
 */
export interface Attribute { why: string; on?: readonly string[]; page?: true }
export const ATTRIBUTES: Readonly<Record<string, Attribute>> = {
  className: { why: 'class names, which the colour and left-or-right rules read word by word' },
  class: { why: 'class names in a page, read the same way', page: true },
  'data-*': { why: 'a mark a stylesheet or a test finds an element by' },
  type: { why: 'what kind of button, input or script an element is' },
  dir: { why: 'which way text runs' },
  lang: { why: 'a language tag' },
  id: { why: 'the name code and labels find an element by' },
  src: { why: 'the address a script or a picture is loaded from' },
  charset: { why: 'how the page\'s bytes are read', page: true },
  name: { why: 'the name a meta tag is read under', page: true },
  content: { why: 'on the viewport meta tag only, how the browser lays the page out', page: true, on: ['meta name=viewport'] },
  variant: { why: 'which of a component\'s looks it takes' },
  size: { why: 'which of a component\'s sizes it takes' },
  align: { why: 'where a popup lines up against what opened it' },
  visibility: { why: 'whether an amount is private or public, which the amount component turns into words', on: ['Amount'] },
  kind: { why: 'whether a public amount is a payment or a balance, which the Public pill turns into words', on: ['Amount', 'PublicPill'] },
};
/** Whether `name`'s value is never shown when written in code on `element` (null: a prop's default, whose component is the function it is declared in). */
const isQuietAttribute = (name: string, element: string | null): boolean => {
  if (name.startsWith('data-')) return true;
  const a = ATTRIBUTES[name];
  if (a === undefined || a.page === true) return false;
  return a.on === undefined || (element !== null && a.on.includes(element));
};

/*
 * DECLARATIONS WHOSE STRINGS ARE CODES A PROGRAM READS, NEVER WORDS A PERSON
 * READS, each named by its file and name, with why. The kit's check requires
 * every entry to name a declaration that exists.
 */
export const CODES: Readonly<Record<string, string>> = {
  'packages/ui/src/i18n/languages.ts#FALLBACK': 'a language tag',
  'packages/ui/src/i18n/languages.ts#RTL_SCRIPTS': 'script codes, compared with the script of a language',
  'packages/ui/src/i18n/languages.ts#directionOf': 'a text direction, set as the page\'s `dir`',
  'packages/ui/src/theme/base-colors.ts#BASE_COLORS': 'the names of the stylesheet\'s theme blocks, matched against it by the theme check',
  'packages/ui/src/theme/base-colors.ts#DEFAULT_BASE_COLOR': 'one of those names',
  'packages/ui/src/theme/base-colors.ts#THEMES': 'the value of the root element\'s `data-theme`',
};

/** TypeScript nodes that stay in the code a browser runs; every other `TS...` node is a type, gone before the page is served. */
const RUNTIME_TS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSEnumDeclaration', 'TSEnumBody', 'TSEnumMember', 'TSModuleDeclaration', 'TSModuleBlock', 'TSParameterProperty', 'TSExportAssignment']);

interface Reading { path: string; translators: ReadonlySet<string>; elements: ReadonlySet<string>; codes: ReadonlySet<string> }

/** A place a string may stand without being wording, and why nothing there reaches a person. */
export interface Position { why: string; allows: (node: Node, up: readonly Node[], r: Reading, text: string) => boolean }

const someParent = (node: Node, up: readonly Node[], test: (parent: Node, child: Node, above: Node | undefined) => boolean): boolean => {
  for (const { parent, child, above } of parentsOf(node, up)) if (test(parent, child, above)) return true;
  return false;
};

/*
 * EVERY PLACE A STRING WITH A LETTER IN IT MAY STAND IN THE KIT OR THE
 * APPLICATION, each with why. A string anywhere else is wording and must come
 * from a language file: `const label = 'Send'`, `value="Send now"`,
 * `{'Cancel'}` and `new Error('...')` in the application are all refused. A
 * new place is one entry here with its reason.
 */
export const WORDING_POSITIONS: Readonly<Record<string, Position>> = {
  'translation key': {
    why: 'the key of a phrase, asked for by `t(...)`; what is shown is the phrase, and the key rule checks the English file has it',
    allows: (n, up, r) => someParent(n, up, (p, c) => p.type === 'CallExpression' && isTranslator(p.callee as Node, r.translators) && c === (p.arguments as Node[])[0]),
  },
  module: {
    why: 'the name of a module, in an import, an export or `import.meta.glob`; it tells the bundler which file to load',
    allows: (n, up) => someParent(n, up, (p, c) => (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(p.type) && c === p.source)
      || (p.type === 'CallExpression' && (p.callee as Node).type === 'MemberExpression' && ((p.callee as Node).object as Node).type === 'MetaProperty' && nameOf((p.callee as Node).property) === 'glob')),
  },
  class: {
    why: 'a class string, inside `className`, `cn(...)` or `cva(...)`; the colour and left-or-right rules read it word by word',
    allows: (n, up) => someParent(n, up, (p) => (p.type === 'JSXAttribute' && nameOf(p.name) === 'className')
      || (p.type === 'CallExpression' && (p.callee as Node).type === 'Identifier' && ['cn', 'cva'].includes(nameOf(p.callee)))),
  },
  attribute: {
    why: 'the value of an attribute or prop named in `ATTRIBUTES`, on an element it names, or its default where a component takes it',
    allows: (n, up) => someParent(n, up, (p, c, above) => {
      if (p.type === 'JSXAttribute' && c === p.value) return isQuietAttribute(nameOf(p.name), nameOf((above as Node | undefined)?.name));
      if (p.type !== 'Property' || c !== p.value) return false;
      if (above?.type === 'ObjectPattern') return isQuietAttribute(nameOf(p.key), null);
      const call = up.find((u) => u.type === 'CallExpression' && isCreateElement(u.callee as Node) && (u.arguments as Node[])[1] === above);
      return call !== undefined && isQuietAttribute(nameOf(p.key), nameOf((call.arguments as Node[])[0]));
    }),
  },
  type: {
    why: 'a type, which is gone before the page is served',
    allows: (_n, up) => up.some((u) => u.type.startsWith('TS') && !RUNTIME_TS.has(u.type)),
  },
  directive: {
    why: 'a directive to the bundler, such as `\'use client\'`',
    allows: (n, up) => someParent(n, up, (p) => p.type === 'ExpressionStatement' && typeof p.directive === 'string'),
  },
  comparison: {
    why: 'a value compared with `===`, `!==`, `==` or `!=`, or a `case` of a `switch`; it is tested, not shown',
    allows: (n, up) => someParent(n, up, (p, c) => (p.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(String(p.operator)) && (c === p.left || c === p.right))
      || (p.type === 'SwitchCase' && c === p.test)),
  },
  element: {
    why: 'the tag a component renders as, spelled as a tag (`span`, `my-tag`): the first argument of `createElement`, or the value of a capitalised variable written as a JSX tag, itself or one branch of a `?:` or `||`',
    allows: (n, up, r, text) => {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(text)) return false;
      const [parent, grand] = [up[up.length - 1], up[up.length - 2]];
      if (parent?.type === 'CallExpression' && isCreateElement(parent.callee as Node) && (parent.arguments as Node[])[0] === n) return true;
      const declarator = parent?.type === 'VariableDeclarator' ? parent
        : (parent?.type === 'ConditionalExpression' && (parent.consequent === n || parent.alternate === n)) || (parent?.type === 'LogicalExpression')
          ? (grand?.type === 'VariableDeclarator' && grand.init === parent ? grand : undefined) : undefined;
      return declarator !== undefined && (declarator.init === n || declarator.init === parent) && r.elements.has(nameOf(declarator.id));
    },
  },
  'element id': {
    why: 'the id `getElementById` looks an element up by',
    allows: (n, up) => someParent(n, up, (p, c) => p.type === 'CallExpression' && nameOf((p.callee as Node).property) === 'getElementById' && c === (p.arguments as Node[])[0]),
  },
  'formatter option': {
    why: 'an argument to one of the browser\'s own formatters, `new Intl.*(...)`: a language tag, or an option naming a style; the formatter writes the words in the person\'s language',
    allows: (n, up) => someParent(n, up, (p) => p.type === 'NewExpression' && nameOf(((p.callee as Node).object as Node | undefined)) === 'Intl'),
  },
  'kit error': {
    why: 'in the kit only, the message of an error it throws at a caller that used it wrongly; the kit shows no error\'s message, so it is read by whoever wrote the call',
    allows: (n, up, r) => r.path.startsWith('packages/ui/') && someParent(n, up, (p) => p.type === 'ThrowStatement'),
  },
  code: {
    why: 'a string in a declaration named in `CODES`',
    allows: (n, up, r) => someParent(n, up, (p) => (p.type === 'VariableDeclarator' || p.type === 'FunctionDeclaration') && `${r.path}#${nameOf(p.id)}` in CODES),
  },
  'asset code': {
    why: 'the code of an asset from the asset registry, written the same in every language',
    allows: (_n, _up, r, text) => r.codes.has(text),
  },
};

/** The first position that lets `node` stand, or null when it is wording. */
function positionOf(node: Node, up: readonly Node[], r: Reading, text: string): string | null {
  for (const [id, p] of Object.entries(WORDING_POSITIONS)) if (p.allows(node, up, r, text)) return id;
  return null;
}

/** Every string with a letter in a code file, with the position that lets it stand, or null. */
function stringsOf(s: Source, codes: ReadonlySet<string>): { text: string; at: number; position: string | null }[] {
  const program = parse(s).program;
  const elements = new Set<string>();
  /* Only a capitalised name is a variable: `<span>` is the element, never a variable called span. */
  for (const { node } of walk(program)) if (node.type === 'JSXOpeningElement' && (node.name as Node).type === 'JSXIdentifier' && /^\p{Lu}/u.test(nameOf(node.name))) elements.add(nameOf(node.name));
  const r: Reading = { path: s.path, translators: translatorsOf(program), elements, codes };
  const out: { text: string; at: number; position: string | null }[] = [];
  for (const { node, up } of walkDown(program)) {
    const raw = node.type === 'Literal' && typeof node.value === 'string' ? node.value
      : node.type === 'TemplateElement' ? (node.value as { raw: string }).raw
        : node.type === 'JSXText' ? String(node.value) : null;
    if (raw === null) continue;
    const text = raw.trim();
    if (!hasLetter(text)) continue;
    /* Text between tags stands in no position; only an asset's code may be written there as it is. */
    out.push({ text, at: node.start, position: node.type === 'JSXText' ? (codes.has(text) ? 'asset code' : null) : positionOf(node, up, r, text) });
  }
  return out;
}

/**
 * RULE: no wording outside the language files. Every string with a letter in
 * it, in every file given, is a breach unless it stands in a position named in
 * `WORDING_POSITIONS`; JSX text always is, but for an asset's code. A
 * stylesheet or page is read too: text in a page, an attribute not named in
 * `ATTRIBUTES` however its value is written (in either quotes or none), and a
 * stylesheet's `content`.
 * `codes` are the codes of the assets.
 */
export function wordingInCode(files: readonly Source[], codes: ReadonlySet<string>): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    if (isMarkup(f.path)) { out.push(...wordingInMarkup(f)); continue; }
    for (const s of stringsOf(f, codes)) if (s.position === null) out.push({ path: f.path, line: lineOf(f.text, s.at), what: s.text });
  }
  return out;
}

/**
 * How many strings with a letter the wording rule read in these files, and how
 * many each position let stand: so a rule that reads nothing, or a position
 * nothing uses any more, shows.
 */
export function wordingCensus(files: readonly Source[], codes: ReadonlySet<string>): { read: number; byPosition: Record<string, number>; codes: string[] } {
  const byPosition: Record<string, number> = {};
  const used = new Set<string>();
  let read = 0;
  for (const f of files) {
    if (isMarkup(f.path)) continue;
    for (const s of stringsOf(f, codes)) { read += 1; if (s.position !== null) byPosition[s.position] = (byPosition[s.position] ?? 0) + 1; }
    for (const { node } of walk(parse(f).program)) {
      if ((node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration') && `${f.path}#${nameOf(node.id)}` in CODES) used.add(`${f.path}#${nameOf(node.id)}`);
    }
  }
  return { read, byPosition, codes: [...used].sort() };
}

/** The wording a page or stylesheet carries: a page's text and its attributes, a stylesheet's `content`. */
function wordingInMarkup(f: Source): Breach[] {
  const out: Breach[] = [];
  const at = (i: number) => lineOf(f.text, i);
  if (f.path.endsWith('.html')) {
    const text = f.text.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length)).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (c) => ' '.repeat(c.length));
    for (const m of text.matchAll(/>([^<]+)</g)) if (hasLetter(m[1]!)) out.push({ path: f.path, line: at(m.index), what: m[1]!.trim() });
    for (const tag of text.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      const attrs = tag[2]!;
      for (const a of attrs.matchAll(new RegExp(String.raw`([\w:-]+)` + ATTRIBUTE_VALUE, 'g'))) {
        const name = a[1]!; const value = valueOf(a, 3);
        const quiet = name === 'content' ? tag[1]!.toLowerCase() === 'meta' && /\bname\s*=\s*["']?viewport["']?(?=[\s/>]|$)/i.test(attrs)
          : name.startsWith('data-') || (name in ATTRIBUTES && ATTRIBUTES[name]!.on === undefined);
        if (hasLetter(value) && !quiet) out.push({ path: f.path, line: at(tag.index), what: `${name}="${value}"` });
      }
    }
  }
  for (const { css, at: from } of cssOf(f)) {
    for (const d of declarationsOf(css)) if (d.property === 'content' && hasLetter(d.value.replace(/var\(--[\w-]+\)/g, '').replace(/\b(?:attr|counter|counters|open-quote|close-quote|no-open-quote|no-close-quote|none|normal)\b/g, ''))) out.push({ path: f.path, line: at(from + d.at), what: `content: ${d.value}` });
  }
  return out;
}

/**
 * RULE: no sentence in English exported to the application by the shared
 * browser code. A breach is a string of two or more words beginning with a
 * capital letter, or of three or more words however it begins, anywhere in
 * the module's code; comments are not code.
 */
export function englishSentences(files: readonly Source[]): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    for (const { node } of walk(parse(f).program)) {
      const text = node.type === 'Literal' && typeof node.value === 'string' ? node.value
        : node.type === 'TemplateLiteral' ? textOf(node) : null;
      if (text !== null && (/^\s*\p{Lu}\p{Ll}*[\p{L}']*\s+\p{L}/u.test(text) || /\p{L}[\p{L}']*\s+\p{L}[\p{L}']*\s+\p{L}/u.test(text))) out.push({ path: f.path, line: lineOf(f.text, node.start), what: text.slice(0, 80) });
    }
  }
  return out;
}

const textOf = (n: Node): string => (n.quasis as { value: { raw: string } }[]).map((q) => q.value.raw).join(' ');

/** Every key a file asks a translation for, as a literal: `t('kit.x')`, `i18n.t("kit.x")`. A key built at run time is returned as null. */
export function keysAskedFor(s: Source): { key: string | null; line: number }[] {
  const out: { key: string | null; line: number }[] = [];
  const program = parse(s).program;
  const names = translatorsOf(program);
  for (const { node } of walk(program)) {
    if (node.type !== 'CallExpression' || !isTranslator(node.callee as Node, names)) continue;
    const arg = (node.arguments as Node[])[0];
    const key = arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value
      : arg?.type === 'TemplateLiteral' && (arg.expressions as unknown[]).length === 0 ? textOf(arg) : null;
    out.push({ key, line: lineOf(s.text, node.start) });
  }
  return out;
}

/* ------------------------------------------------------------------ amounts */

/*
 * WHERE AN AMOUNT MAY BECOME TEXT OR A NUMBER, each with why. Everywhere else
 * in the kit and the application, the conversions `amountsOutsideTheComponent`
 * names are refused, from any value, because nothing in source says which
 * values are amounts.
 */
export const AMOUNT_HOMES: Readonly<Record<string, string>> = {
  'packages/ui/src/components/amount.tsx': 'the amount component, which writes an amount with its code and, when anyone can look it up, the Public pill',
  'packages/ui/src/format/token-amount.ts': 'the token-amount helper the component writes with, exactly and in the person\'s language',
};

/** The plain-number formatter, which may call the browser's number formatter and nothing else refused below. */
export const NUMBER_FORMATTER = 'packages/ui/src/format/intl.ts';

/** The names the browser's own number formatting is reached by. */
const FORMATTERS = new Set(['NumberFormat', 'toLocaleString', 'toFixed', 'toPrecision', 'toExponential']);

/**
 * RULE: an amount becomes text or a number only in `AMOUNT_HOMES`. A breach
 * is, anywhere else: the token-amount helper named; the browser's number
 * formatting reached (`NumberFormat` by name, in brackets with a literal, or
 * destructured; `toLocaleString`, `toFixed`, `toPrecision`, `toExponential`),
 * except `NumberFormat` by the plain-number formatter; `Number`, `String`,
 * `parseInt` or `parseFloat` called, made with `new`, or handed on as a value
 * (`xs.map(String)`); `.toString`, `.join`, `.concat`, `JSON.stringify`,
 * `encodeURIComponent`; a unary `+`; a `+` or `+=` with a string or template
 * literal on either side, beside a name the file gives a string, a template
 * or a phrase (`const label = t('x'); label + amount`), or beside a phrase
 * asked for in place (`t('x') + amount`); any template with a value in it; a
 * value written into an element's `textContent`, `innerText` or `innerHTML`;
 * and a global reached by a name built at run time (`globalThis['Str' +
 * 'ing']`, `window[name]`). In the kit, the message of an error it throws may
 * carry a value.
 *
 * WHAT THIS RULE DOES NOT READ, AND WHAT DOES. A value rendered as a JSX child
 * (`<span>{amount}</span>`) is not read here: an amount is an object, which
 * React refuses as a child, and every conversion of one throws, so it cannot
 * reach a page that way. A `+` beside a string that arrives from elsewhere
 * (a prop, a function's result) is not read either, and needs no rule: `+` on
 * an amount throws.
 */
export function amountsOutsideTheComponent(files: readonly Source[], homes: Readonly<Record<string, string>> = AMOUNT_HOMES): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    if (f.path in homes) continue;
    const seen = new Set<string>();
    const kit = f.path.startsWith('packages/ui/');
    const program = parse(f).program;
    const translators = translatorsOf(program);
    const isPhrase = (n: Node | undefined): boolean => n?.type === 'CallExpression' && isTranslator(n.callee as Node, translators);
    const isText = (n: Node | undefined): boolean => n?.type === 'TemplateLiteral' || (n?.type === 'Literal' && typeof n.value === 'string') || isPhrase(n);
    /* The names this file gives a string, a template or a phrase. */
    const textNames = new Set<string>();
    for (const { node } of walk(program)) {
      if (node.type === 'VariableDeclarator' && (node.id as Node).type === 'Identifier' && isText(node.init as Node | undefined)) textNames.add(nameOf(node.id));
    }
    const heldText = (n: Node | undefined): boolean => n?.type === 'Identifier' && textNames.has(String(n.name));
    for (const { node, up } of walkDown(program)) {
      /* An import's name is two nodes at one place, the name imported and the local one. */
      const at = `${node.type}:${node.start}:${node.end}`;
      if (seen.has(at)) continue;
      seen.add(at);
      const breach = (what: string) => { if (!(kit && up.some((u) => u.type === 'ThrowStatement'))) out.push({ path: f.path, line: lineOf(f.text, node.start), what }); };
      const callee = node.callee as Node | undefined;
      if (node.type === 'Identifier' && node.name === 'formatTokenAmount') breach('formatTokenAmount');
      if (node.type === 'MemberExpression') {
        const prop = node.property as Node;
        const name = prop.type === 'Identifier' && !node.computed ? String(prop.name) : prop.type === 'Literal' ? String(prop.value) : '';
        if (FORMATTERS.has(name) && !(f.path === NUMBER_FORMATTER && name === 'NumberFormat')) breach(name);
        if (['toString', 'stringify', 'join', 'concat'].includes(name) || ((name === 'parseInt' || name === 'parseFloat' || name === 'String' || name === 'Number') && nameOf(node.object) !== '')) breach(name);
      }
      if (node.type === 'Identifier' && ['Number', 'String', 'parseInt', 'parseFloat', 'encodeURIComponent'].includes(String(node.name))) {
        const p = up[up.length - 1];
        const called = (p?.type === 'CallExpression' || p?.type === 'NewExpression') && p.callee === node;
        const named = p?.type === 'MemberExpression' && p.object === node;
        const typeOnly = up.some((u) => u.type.startsWith('TS') && !RUNTIME_TS.has(u.type));
        if (!called && !named && !typeOnly && !(p?.type === 'MemberExpression' && p.property === node)) breach(`${String(node.name)} as a value`);
      }
      if (node.type === 'AssignmentExpression' && ['textContent', 'innerText', 'innerHTML'].includes(nameOf((node.left as Node).property))) breach(nameOf((node.left as Node).property));
      if (node.type === 'AssignmentExpression' && node.operator === '+=' && ((node.right as Node).type === 'TemplateLiteral' || ((node.right as Node).type === 'Literal' && typeof (node.right as Node).value === 'string'))) breach('+= with a string');
      if (node.type === 'Property' && nameOf(node.key) === 'NumberFormat' && !(f.path === NUMBER_FORMATTER)) breach('NumberFormat');
      if ((node.type === 'CallExpression' || node.type === 'NewExpression') && callee?.type === 'Identifier' && ['Number', 'String', 'parseInt', 'parseFloat', 'encodeURIComponent'].includes(String(callee.name))) breach(`${String(callee.name)}(...)`);
      if (node.type === 'UnaryExpression' && node.operator === '+') breach('unary +');
      if (node.type === 'BinaryExpression' && node.operator === '+' && [node.left, node.right].some((s) => (s as Node).type === 'TemplateLiteral' || ((s as Node).type === 'Literal' && typeof (s as Node).value === 'string'))) breach('+ with a string');
      if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length > 0) breach('template with a value');
      if (node.type === 'BinaryExpression' && node.operator === '+' && [node.left, node.right].some((x) => heldText(x as Node))) breach('+ with a string held in a name');
      if (node.type === 'BinaryExpression' && node.operator === '+' && [node.left, node.right].some((x) => isPhrase(x as Node))) breach('+ with a phrase');
      if (node.type === 'AssignmentExpression' && node.operator === '+=' && (heldText(node.left as Node) || heldText(node.right as Node) || isPhrase(node.right as Node))) breach('+= with a string held in a name');
      if (node.type === 'MemberExpression' && node.computed && isGlobalScope(node.object) && (node.property as Node).type !== 'Literal') breach('a global reached by a built name');
    }
  }
  return out;
}

/** The breaches of the amount rule that are a call of a number formatter; its other conversions are not among them. */
export const SCREEN_FORMATTERS = new Set(['formatTokenAmount', ...FORMATTERS]);

/* ------------------------------------------------------------------ language files */

/** The key a plural entry belongs to, and its category: `x.count_one` is `x.count`, `one`. */
export function pluralOf(key: string): { base: string; category: string | null } {
  const m = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
  return m ? { base: m[1]!, category: m[2]! } : { base: key, category: null };
}

/** The named gaps of a phrase, sorted: `{name} paid {count}` has `count`, `name`. */
export const gapsOf = (phrase: string): string[] => [...new Set([...phrase.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

/**
 * RULE: every language file has every phrase of the English one, with one entry
 * for each plural category the language needs, and nothing the English one has
 * not. A phrase is plural in every language when it is plural in English.
 */
export function missingPhrases(english: Readonly<Record<string, string>>, tag: string, messages: Readonly<Record<string, string>>): string[] {
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories as string[];
  const bases = new Map<string, boolean>();
  for (const k of Object.keys(english)) { const { base, category } = pluralOf(k); bases.set(base, (bases.get(base) ?? false) || category !== null); }
  const out: string[] = [];
  for (const [base, plural] of bases) {
    const want = plural ? categories.map((c) => `${base}_${c}`) : [base];
    for (const k of want) if (!(k in messages)) out.push(`${tag}: ${k} is missing`);
  }
  for (const k of Object.keys(messages)) {
    const { base, category } = pluralOf(k);
    if (!bases.has(base)) out.push(`${tag}: ${k} is not in the English file`);
    else if (category !== null && !categories.includes(category)) out.push(`${tag}: ${k} is a plural form ${tag} does not have`);
    else if (category === null && bases.get(base) === true) out.push(`${tag}: ${k} is plural in English and has no plural forms here`);
  }
  return out.sort();
}

/** RULE: every phrase has the same named gaps in every language, and in each of its plural forms. */
export function gapsThatDiffer(english: Readonly<Record<string, string>>, tag: string, messages: Readonly<Record<string, string>>): string[] {
  const want = new Map<string, string>();
  for (const [k, v] of Object.entries(english)) {
    const { base } = pluralOf(k);
    const g = gapsOf(v).join(',');
    if (want.has(base) && want.get(base) !== g) return [`en: the plural forms of ${base} have different gaps`];
    want.set(base, g);
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(messages)) {
    const { base } = pluralOf(k);
    const w = want.get(base);
    if (w !== undefined && gapsOf(v).join(',') !== w) out.push(`${tag}: ${k} has gaps {${gapsOf(v).join('}, {')}} where English has {${w.split(',').join('}, {')}}`);
  }
  return out.sort();
}

/** Whether the English file has a phrase for `key`: the key itself, or its plural forms. */
export function hasPhrase(english: Readonly<Record<string, string>>, key: string): boolean {
  if (key in english) return pluralOf(key).category === null;
  return Object.keys(english).some((e) => { const { base, category } = pluralOf(e); return category !== null && base === key; });
}

/**
 * The bare `data-...` variants a file's classes use (`data-open:`,
 * `group-data-open/button:`), which Tailwind would read as a plain attribute
 * and a stylesheet must define. Bracketed ones (`data-[state=open]:`) say
 * their own selector and are not returned.
 */
export function stateVariantsOf(s: Source): string[] {
  const out = new Set<string>();
  for (const { word } of classWordsOf(s)) {
    const variants = word.slice(0, word.length - utilityOf(word).length);
    for (const m of variants.matchAll(/(?:^|:|-)(data-[a-z]+(?:-[a-z]+)*)(?:\/[\w-]+)?:/g)) out.add(m[1]!);
  }
  return [...out].sort();
}
