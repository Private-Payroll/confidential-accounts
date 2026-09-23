/**
 * WHAT A BROWSER LOADS, FILE BY FILE, AND WHETHER ANY OF IT IS NODE.
 *
 * A module that imports a Node built-in cannot run in a browser. The bundler
 * does not refuse it: it substitutes a stand-in that throws the first time a
 * name is read from it, and a named import is read the moment the module is
 * evaluated. So one static `import { x } from 'node:fs'` anywhere under a page
 * or a worker stops that whole page or worker before its first line runs, and
 * nothing short of loading it in a real browser shows it.
 *
 * This walks the same graph the bundler walks, from every page each build
 * serves and from every worker those pages start, and reports every static
 * import of a Node built-in it meets on the way.
 *
 * ── TYPE-ONLY IMPORTS ARE EXCLUDED THE WAY THE BUNDLER EXCLUDES THEM ──────
 *
 * Each file is first put through the bundler's own TypeScript transform, and
 * the imports are read from what comes out. An `import type`, an import whose
 * every binding is a type, and an import whose bindings are only ever used as
 * types are all gone by then, exactly as they are gone from what a browser is
 * served. Nothing here decides for itself which imports are real.
 *
 * ── WHAT IT DOES NOT FOLLOW ───────────────────────────────────────────────
 *
 * It stops at a package installed from outside this repository: that
 * package's own browser field and export conditions decide what the browser
 * gets there, and following them is the bundler's job - so a Node import inside
 * a third-party dependency is NOT seen here. It follows every file in this
 * repository, including those reached through an alias, those reached only by a
 * dynamic `import()`, and those reached by package name through a workspace
 * link back into this repository, where it reads the package's `exports` the
 * way the bundler does.
 *
 * A DYNAMIC import of a Node built-in is reported but is not a violation: it is
 * evaluated only if the line that asks for it runs, so a guard that a browser
 * never passes keeps it out. A STATIC one has no such guard.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseSync, transformWithOxc } from 'vite';

/** One alias, with vite's own matching rule: a string matches exactly or as a prefix followed by `/`. */
export interface Alias { find: string | RegExp; replacement: string }

/** One build that serves pages to a browser. Paths are relative to the repository root. */
export interface BrowserBuild {
  name: string;
  /** The build's config file, so the list of builds can be checked against the configs that exist. */
  config: string;
  /** The directory the build serves pages from. */
  root: string;
  /** Every page that build serves. */
  pages: string[];
  /** The build's `resolve.alias`, replacements relative to the repository root. */
  alias: Alias[];
}

export interface NodeImport {
  /** The file the import is written in, relative to the repository root. */
  file: string;
  specifier: string;
  /** How a browser gets from its entry to `file`, entry first. */
  chain: string[];
}

export interface BuildGraph {
  build: string;
  /** The page scripts and the worker entries, relative to the repository root. */
  entries: string[];
  /** Every repository file reached, relative to the repository root. */
  files: string[];
  staticNode: NodeImport[];
  dynamicNode: NodeImport[];
  /** An import that names no file and no installed package. The graph is incomplete while this is non-empty. */
  unresolved: { file: string; specifier: string }[];
}

const CODE = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
const BUILTINS = new Set(builtinModules);

/** True for `node:fs`, `fs`, `fs/promises` - anything Node provides and a browser does not. */
export const isNodeBuiltin = (specifier: string): boolean => {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]);
};

const applyAlias = (specifier: string, alias: Alias[], repo: string): string => {
  for (const a of alias) {
    if (typeof a.find === 'string') {
      if (specifier === a.find || specifier.startsWith(`${a.find}/`)) {
        return join(repo, a.replacement) + specifier.slice(a.find.length);
      }
    } else if (a.find.test(specifier)) {
      return specifier.replace(a.find, join(repo, a.replacement));
    }
  }
  return specifier;
};

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

/** The file a path names, trying what the bundler tries: as written, the TypeScript source of a `.js` import, an added extension, an index. */
const resolveFile = (p: string): string | null => {
  const tries: string[] = [p];
  const ext = extname(p);
  if (ext === '.js') tries.push(p.slice(0, -3) + '.ts', p.slice(0, -3) + '.tsx');
  if (ext === '.jsx') tries.push(p.slice(0, -4) + '.tsx');
  if (ext === '.mjs') tries.push(p.slice(0, -4) + '.mts');
  for (const e of CODE) tries.push(p + e);
  for (const e of CODE) tries.push(join(p, `index${e}`));
  return tries.find(isFile) ?? null;
};

/** True when a package of this name is installed where `from` would find it, walking up the way Node resolution does. */
const installedFrom = (specifier: string, from: string): boolean => {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    if (isFile(join(dir, 'node_modules', name, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
};

/** The directory of the package `specifier` names, found the way Node resolution finds it, or null. */
const packageDirFrom = (specifier: string, from: string): string | null => {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (isFile(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
};

/** The conditions a browser build matches. `types` is never one. */
const BROWSER_CONDITIONS = new Set(['browser', 'import', 'module', 'default']);

/** An `exports` target: the FIRST key in the map's own order that is a matching condition, as Node and the bundler take it. */
const exportTarget = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  for (const [condition, inner] of Object.entries(value as Record<string, unknown>)) {
    if (!BROWSER_CONDITIONS.has(condition)) continue;
    const t = exportTarget(inner);
    if (t !== null) return t;
  }
  return null;
};

/**
 * A package that is a link back into this repository is this repository's code, and the browser is
 * served it. Resolved through its `exports` (exact subpaths, then `*` patterns), else `module`/`main`.
 * Returns the file, `unresolved` when the package does not export the subpath, or null when the
 * package lives outside the repository.
 */
const resolveWorkspacePackage = (specifier: string, from: string, repo: string): string | 'unresolved' | null => {
  const dir = packageDirFrom(specifier, from);
  if (dir === null) return null;
  const real = realpathSync(dir);
  const inside = relative(repo, real);
  if (inside.startsWith('..') || inside.split(sep).includes('node_modules')) return null;
  const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as Record<string, unknown>;
  const name = String(pkg.name ?? '');
  const sub = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  let target: string | null = null;
  const exp = pkg.exports as unknown;
  if (exp !== undefined && exp !== null) {
    const map = typeof exp === 'string' || !Object.keys(exp as object).some((k) => k.startsWith('.'))
      ? { '.': exp } as Record<string, unknown> : exp as Record<string, unknown>;
    if (sub in map) target = exportTarget(map[sub]);
    else {
      // The pattern with the longest part before `*` wins, whatever order the map lists them in.
      const patterns = Object.entries(map).filter(([key]) => key.includes('*'))
        .sort(([a], [b]) => b.indexOf('*') - a.indexOf('*'));
      for (const [key, value] of patterns) {
        const star = key.indexOf('*');
        const head = key.slice(0, star);
        const tail = key.slice(star + 1);
        if (sub.startsWith(head) && sub.endsWith(tail) && sub.length >= key.length - 1) {
          const t = exportTarget(value);
          if (t !== null) target = t.replace('*', sub.slice(head.length, sub.length - tail.length));
          break;
        }
      }
    }
  } else if (sub === '.') {
    target = String(pkg.module ?? pkg.main ?? './index.js');
  } else {
    target = sub;
  }
  if (target === null) return 'unresolved';
  return resolveFile(join(real, target)) ?? 'unresolved';
};

type Resolved =
  | { kind: 'file'; path: string; worker: boolean }
  | { kind: 'asset' }
  | { kind: 'node' }
  | { kind: 'package' }
  | { kind: 'unresolved' };

const resolveSpecifier = (raw: string, from: string, build: BrowserBuild, repo: string): Resolved => {
  const [bare, query = ''] = raw.split('?');
  const worker = /(^|&)(worker|sharedworker)(&|$)/.test(query);
  if (!worker && /(^|&)(url|raw|inline)(&|$)/.test(query)) return { kind: 'asset' };
  const aliased = applyAlias(bare, build.alias, repo);
  let target: string | null = null;
  if (aliased.startsWith('./') || aliased.startsWith('../')) target = resolve(dirname(from), aliased);
  else if (aliased.startsWith(repo + sep) || aliased === repo) target = aliased;
  else if (aliased.startsWith('/')) target = join(repo, build.root, aliased);
  if (target === null) {
    // The bundler tries an installed package before a built-in, so a bare `buffer` with the `buffer`
    // package installed is that package. `node:`-prefixed names are never a package.
    // A bare name that is not installed is either an alias this list does not know or a missing
    // dependency, and in both cases the walk cannot see past it, so it is reported rather than skipped.
    if (!isNodeBuiltin(aliased)) {
      const own = resolveWorkspacePackage(aliased, from, repo);
      if (own === 'unresolved') return { kind: 'unresolved' };
      if (own !== null) return CODE.includes(extname(own)) ? { kind: 'file', path: own, worker } : { kind: 'asset' };
      return installedFrom(aliased, from) ? { kind: 'package' } : { kind: 'unresolved' };
    }
    return !aliased.startsWith('node:') && installedFrom(aliased, from) ? { kind: 'package' } : { kind: 'node' };
  }
  const file = resolveFile(target);
  if (file === null) return { kind: 'unresolved' };
  if (!CODE.includes(extname(file))) return { kind: 'asset' };
  return { kind: 'file', path: file, worker };
};

const WORKER = /new\s+(?:Shared)?Worker\s*\(\s*new\s+URL\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)/g;

interface Edge { specifier: string; dynamic: boolean; worker: boolean }

/** The imports a browser would actually be served for one file, after the bundler's own TypeScript transform. */
export const importsOf = async (file: string, source: string): Promise<Edge[]> => {
  const ext = extname(file);
  const lang = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : ext === '.ts' || ext === '.mts' ? 'ts' : 'js';
  const { code } = await transformWithOxc(source, file, { lang, jsx: { runtime: 'automatic' } });
  const parsed = parseSync(file.replace(/\.(m?ts|tsx|jsx)$/, '.js'), code);
  if (parsed.errors.length > 0) throw new Error(`${file} did not parse after transform: ${parsed.errors[0].message}`);
  const edges: Edge[] = [];
  for (const i of parsed.module.staticImports) edges.push({ specifier: i.moduleRequest.value, dynamic: false, worker: false });
  for (const e of parsed.module.staticExports) {
    for (const entry of e.entries) {
      if (entry.moduleRequest !== null) edges.push({ specifier: entry.moduleRequest.value, dynamic: false, worker: false });
    }
  }
  for (const d of parsed.module.dynamicImports) {
    const text = code.slice(d.moduleRequest.start, d.moduleRequest.end).trim();
    const literal = /^(['"`])([^'"`$]+)\1$/.exec(text);
    // A computed specifier cannot be followed; it is reported as itself so it is never silently skipped.
    edges.push({ specifier: literal ? literal[2] : text, dynamic: true, worker: false });
  }
  for (const m of code.matchAll(WORKER)) edges.push({ specifier: m[2], dynamic: false, worker: true });
  return edges;
};

/** The page scripts a page loads. */
export const scriptsOf = (html: string): string[] =>
  [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);

/** Walks one build's whole browser graph, from every page and every worker. */
export const walkBuild = async (build: BrowserBuild, repoGiven: string): Promise<BuildGraph> => {
  // Normalised once, so a root given with a trailing separator compares equal to the paths built from it.
  const repo = resolve(repoGiven);
  const rel = (p: string): string => relative(repo, p).split(sep).join('/');
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  const entries: string[] = [];
  const unresolved: BuildGraph['unresolved'] = [];
  const staticNode: NodeImport[] = [];
  const dynamicNode: NodeImport[] = [];

  const chainOf = (file: string): string[] => {
    const out: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) out.unshift(rel(at));
    return out;
  };
  const enqueue = (file: string, from: string | null, entry: boolean): void => {
    if (entry && !entries.includes(rel(file))) entries.push(rel(file));
    if (parent.has(file)) return;
    parent.set(file, from);
    queue.push(file);
  };

  for (const page of build.pages) {
    const html = join(repo, page);
    for (const src of scriptsOf(readFileSync(html, 'utf8'))) {
      const r = resolveSpecifier(src, html, build, repo);
      if (r.kind !== 'file') { unresolved.push({ file: page, specifier: src }); continue; }
      enqueue(r.path, null, true);
    }
  }

  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const edge of await importsOf(file, readFileSync(file, 'utf8'))) {
      const r = resolveSpecifier(edge.specifier, file, build, repo);
      if (r.kind === 'node') {
        (edge.dynamic ? dynamicNode : staticNode).push({ file: rel(file), specifier: edge.specifier, chain: chainOf(file) });
      } else if (r.kind === 'unresolved') {
        unresolved.push({ file: rel(file), specifier: edge.specifier });
      } else if (r.kind === 'file') {
        enqueue(r.path, file, edge.worker || r.worker);
      }
    }
  }

  return { build: build.name, entries, files: [...parent.keys()].map(rel).sort(), staticNode, dynamicNode, unresolved };
};

/** Every HTML page directly inside a build's root, so the page list cannot fall behind the files. */
export const pagesIn = (root: string, repo: string): string[] =>
  readdirSync(join(repo, root)).filter((n) => n.endsWith('.html')).map((n) => `${root}/${n}`).sort();

/**
 * EVERY BUILD IN THIS REPOSITORY THAT SERVES A BROWSER.
 *
 * The aliases are the builds' own, restated by hand. NOTHING CHECKS THAT THEY
 * STILL MATCH the configs they were copied from - loading the wallet's config
 * needs a native binary that is not present on every machine - so an alias
 * changed there must be changed here too.
 */
export const BROWSER_BUILDS: BrowserBuild[] = [
  { name: 'payroll', config: 'vite.config.ts', root: 'src/web', pages: ['src/web/index.html'], alias: [] },
  { name: 'standalone', config: 'vite.standalone.config.ts', root: 'src/standalone', pages: ['src/standalone/index.html'], alias: [] },
  {
    name: 'proving-probe', config: 'vite.probe.config.ts', root: 'browser-proving',
    pages: ['browser-proving/index.html', 'browser-proving/wallet.html', 'browser-proving/worker.html'], alias: [],
  },
  {
    name: 'wallet', config: 'apps/wallet/vite.config.ts', root: 'apps/wallet',
    pages: ['apps/wallet/index.html', 'apps/wallet/probe.html'],
    alias: [
      { find: 'assert', replacement: 'packages/identity/src/browser/assert-shim.ts' },
      { find: '@', replacement: 'apps/wallet/src' },
      { find: /^midnight-identity$/, replacement: 'packages/identity/src/index.ts' },
      { find: /^midnight-identity\/browser$/, replacement: 'packages/identity/src/browser/index.ts' },
      { find: /^midnight-identity\/network$/, replacement: 'packages/identity/src/wallet/network.ts' },
      { find: 'midnight-identity', replacement: 'packages/identity/src' },
    ],
  },
];
