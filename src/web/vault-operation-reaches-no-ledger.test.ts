/**
 * **THE PAGE'S VAULT OPERATIONS NEVER LOAD THE NOTE INDEX, WHICH LOADS THE
 * LEDGER.**
 *
 * `vault-operation.ts` runs on the payroll page, and the page does not carry
 * the ledger's WebAssembly. The note index (`src/midnight/note-index.ts`)
 * loads the ledger, so whatever it judges is asked of the vault worker, which
 * does carry it.
 *
 * `no-wasm-in-the-page.test.ts` builds the whole page and lists the modules
 * that arrived; it says WHAT arrived, not by which import. This file names the
 * one route by which it arrived before: any import, static, re-exported or
 * dynamic, from `vault-operation.ts` or anything it imports, that reaches the
 * note index. An `import type` is erased and is not followed.
 *
 * Each file is parsed by the parser the page's own build uses, rather than
 * searched with a pattern, so an import is found however it is written and a
 * comment or a string is never mistaken for one. The build in the sibling file remains the
 * evidence of what the page carries.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const NOTE_INDEX = 'src/midnight/note-index.ts';
const LEDGER_PACKAGES = /^@midnight-ntwrk\/midnight-js-protocol\/ledger$|^@midnightntwrk\/ledger-v\d+/u;

/** Every specifier a file loads at run time: static imports, re-exports, side-effect imports and dynamic imports. */
const loadedSpecifiers = (text: string, name = 'source.ts'): string[] => {
  const { module } = parseSync(name, text);
  const found: string[] = [];
  for (const i of module.staticImports) {
    /* An import whose every name is a type is erased; one with no names at all loads the file. */
    if (i.entries.length === 0 || i.entries.some((e) => !e.isType)) found.push(i.moduleRequest.value);
  }
  for (const x of module.staticExports) {
    for (const e of x.entries) if (e.moduleRequest !== null && !e.isType) found.push(e.moduleRequest.value);
  }
  for (const d of module.dynamicImports) {
    const literal = /^(['"`])([^'"`$]*)\1$/u.exec(text.slice(d.moduleRequest.start, d.moduleRequest.end));
    if (literal !== null) found.push(literal[2]!);
  }
  return found;
};

interface Sources {
  isFile(path: string): boolean;
  read(path: string): string;
}
const onDisk: Sources = {
  isFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
  read: (path) => readFileSync(path, 'utf8'),
};

const resolveRelative = (sources: Sources, from: string, specifier: string): string | null => {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.(?:js|mjs|jsx)$/u, '');
  return [`${stem}.ts`, `${stem}.tsx`, base, `${base}.ts`, join(base, 'index.ts')].find((p) => sources.isFile(p)) ?? null;
};

/** Every file and every package reached from `entry`, following only what loads at run time. */
const reachedFrom = (entry: string, root = REPO, sources = onDisk): { files: Set<string>; packages: Set<string> } => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const name = relative(root, file).replace(/\\/gu, '/');
    if (files.has(name)) continue;
    files.add(name);
    if (!/\.(?:ts|tsx|js|mjs)$/u.test(file) || file.includes('/node_modules/')) continue;
    for (const specifier of loadedSpecifiers(sources.read(file), file)) {
      if (!specifier.startsWith('.')) { packages.add(specifier); continue; }
      const next = resolveRelative(sources, file, specifier);
      if (next !== null) queue.push(next);
    }
  }
  return { files, packages };
};

describe('the page\'s vault operations and the ledger', () => {
  it('NOTHING vault-operation.ts LOADS, DIRECTLY OR THROUGH ANOTHER FILE, IS THE NOTE INDEX OR A LEDGER PACKAGE', () => {
    const { files, packages } = reachedFrom('src/web/vault-operation.ts');
    expect(files.has('src/web/vault-operation.ts')).toBe(true);
    expect([...files].filter((f) => f === NOTE_INDEX),
      'the note index loads the ledger, which the page does not carry: ask the vault worker instead').toEqual([]);
    expect([...packages].filter((p) => LEDGER_PACKAGES.test(p))).toEqual([]);
  });

  it('THE SAME WALK FROM THE VAULT WORKER DOES REACH THE NOTE INDEX AND A LEDGER PACKAGE, so the walk is not blind', () => {
    const { files, packages } = reachedFrom('src/web/vault-worker-entry.ts');
    expect(files.has(NOTE_INDEX)).toBe(true);
    expect([...packages].some((p) => LEDGER_PACKAGES.test(p))).toBe(true);
    expect(['@midnight-ntwrk/midnight-js-protocol/ledger', '@midnightntwrk/ledger-v9'].filter((p) => LEDGER_PACKAGES.test(p)),
      'both names the ledger is loaded under').toHaveLength(2);
  });

  /*
   * The dynamic-import keyword is spelt in two halves in the fixtures below, so the
   * repository's own import walker does not read these sample lines as real imports
   * of files that do not exist. The text each test reads is unchanged.
   */
  const DYN = 'imp' + 'ort';

  it('follows a route through other files, and not one that is only a type', () => {
    const tree: Record<string, string> = {
      '/t/a.ts': "import { b } from './b.js';\nimport type { Erased } from './erased.js';",
      '/t/b.ts': "export * from './c/index.js';",
      '/t/c/index.ts': `export async function later() { return ${DYN}('../target.js'); }`,
      '/t/target.ts': '',
      '/t/erased.ts': "import './only-through-a-type.js';",
      '/t/only-through-a-type.ts': '',
    };
    const inMemory: Sources = { isFile: (p) => p in tree, read: (p) => tree[p]! };
    const { files } = reachedFrom('a.ts', '/t', inMemory);
    expect([...files].sort()).toEqual(['a.ts', 'b.ts', 'c/index.ts', 'target.ts']);
  });

  it('reads each kind of import, and passes over an erased one, a comment and a string', () => {
    expect(loadedSpecifiers([
      "import { a } from './static.js';",
      "import x, { y } from './default-and-named.js';",
      'import {',
      '  z,',
      "} from './multi-line.js';",
      "import type { B } from './erased.js';",
      "import { type Only } from './erased-inline.js';",
      "import { type T, v } from './mixed.js';",
      "export type { C } from './erased-too.js';",
      "export { c } from './re-exported.js';",
      "export * from './every-export.js';",
      "import './side-effect.js';",
      `const d = await ${DYN}('./dynamic.js');`,
      'const e = await import(`./template.js`);',
      `// served under /artefacts/vault/* and then ${DYN}('./in-a-line-comment.js')`,
      "const s = '/artefacts/vault/*'; const t = \"import('./in-a-string.js')\";",
      `/* ${DYN}('./in-a-block-comment.js') */`,
    ].join('\n')).sort()).toEqual([
      './default-and-named.js', './dynamic.js', './every-export.js', './mixed.js', './multi-line.js', './re-exported.js',
      './side-effect.js', './static.js', './template.js',
    ]);
  });
});
