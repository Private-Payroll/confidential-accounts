import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build, type Rolldown } from 'vite';
import config, { FIRST_DOWNLOAD_BUDGET, firstDownloadOf, isWorkers, overBudget, WORKERS, type BuiltFile } from '../vite.config.js';

/*
 * THE FIRST DOWNLOAD'S BUDGET: what a browser loads before any page is
 * opened, held to a number that can only fall, with every file under the
 * bundler's warning.
 */
const CONFIG = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const chunk = (fileName: string, bytes: number, imports: string[] = [], over: { isEntry?: boolean; css?: string[] } = {}): BuiltFile => ({
  type: 'chunk', fileName, code: 'x'.repeat(bytes), isEntry: over.isEntry ?? false, imports, viteMetadata: { importedCss: new Set(over.css ?? []) },
});
const asset = (fileName: string, bytes: number): BuiltFile => ({ type: 'asset', fileName, source: new Uint8Array(bytes) });
const BUNDLE: Record<string, BuiltFile> = Object.fromEntries([
  chunk('index.js', 100, ['shared.js'], { isEntry: true, css: ['index.css'] }),
  chunk('shared.js', 40, ['deep.js']),
  chunk('deep.js', 5),
  /* Loaded when a page is opened: the entry imports it by import(), so it is in no list of static imports. */
  chunk('home.js', 70, ['shared.js'], { css: ['home.css'] }),
  asset('index.css', 30),
  asset('home.css', 9),
  asset('inter.woff2', 900),
  asset('index.html', 1),
].map((f) => [f.fileName, f]));

describe('the first download', () => {
  /*
   * RED WHEN: the first download leaves out the entry, a script it imports
   * without waiting (however deep), or their stylesheet; or counts a page
   * loaded when opened, its stylesheet, or a font.
   */
  it('is the entry, what it imports without waiting, and their stylesheets', () => {
    expect(firstDownloadOf(BUNDLE)).toEqual({ files: ['deep.js', 'index.css', 'index.js', 'shared.js'], bytes: 175 });
  });

  /* RED WHEN: a first download over its budget, or any file over the bundler's warning, is let through; or a font is held to the file limit. */
  it('stops the build over its budget, or with a file over the bundler\'s warning', () => {
    expect(overBudget(BUNDLE, 175, 100)).toEqual([]);
    expect(overBudget(BUNDLE, 174, 100)).toEqual(['the first download is 175 bytes, over its budget of 174: deep.js, index.css, index.js, shared.js']);
    expect(overBudget(BUNDLE, 175, 99)).toEqual(['index.js is 100 bytes, over the bundler\'s warning at 99']);
    expect(overBudget({ ...BUNDLE, 'page.js': chunk('page.js', 101) }, 175, 100)).toEqual(['page.js is 101 bytes, over the bundler\'s warning at 100']);
  });

  /*
   * RED WHEN: a worker's script or WebAssembly, which a worker loads when it
   * starts and never with the page, is held to the file limit and stops the
   * build; or anything else is let past the limit as if it were a worker's:
   * a page's script, a stylesheet, or a picture.
   */
  it('holds a worker\'s files to no file limit, and nothing else', () => {
    const worker = { 'w.js': asset('assets/vault-worker-entry-x.js', 101), 'w.wasm': asset('assets/ledger-x.wasm', 101), 'w.mjs': asset('assets/y.mjs', 101) };
    expect(Object.values(worker).map(isWorkers)).toEqual([true, true, true]);
    expect(overBudget({ ...BUNDLE, ...worker }, 175, 100)).toEqual([]);
    expect([chunk('page.js', 1), asset('x.css', 1), asset('x.png', 1), asset('x.svg', 1)].map(isWorkers)).toEqual([false, false, false, false]);
    expect(overBudget({ ...BUNDLE, 'x.css': asset('x.css', 101) }, 175, 100)).toEqual(['x.css is 101 bytes, over the bundler\'s warning at 100']);
  });

  /* RED WHEN: the application's build does not carry the budget. */
  it('is held by the application\'s build', () => {
    const names = ((config as { plugins?: unknown[] }).plugins ?? []).flat().map((p) => (p as { name?: string }).name);
    expect(names).toContain('first-download-budget');
  });

  /*
   * RED WHEN: the application's first download grows past its budget, a file
   * reaches the bundler's warning, or the download falls by a kilobyte or
   * more and the budget is not lowered with it. Builds the application, so
   * it needs the stylesheet compiler's native part for the machine it runs on.
   */
  it('is within a kilobyte under its budget, as the application is built', async () => {
    /* Built as it is served: the test runner's own setting would build React's development copy. */
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const out = await build({ configFile: CONFIG, mode: 'production', logLevel: 'silent', build: { write: false } }).finally(() => { process.env.NODE_ENV = was; });
    const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => (o as Rolldown.RolldownOutput).output) as unknown as BuiltFile[];
    const bundle = Object.fromEntries(outputs.map((f) => [f.fileName, f]));
    const first = firstDownloadOf(bundle);
    expect(first.files.some((f) => /^assets\/index-.*\.js$/.test(f))).toBe(true);
    expect(first.files.some((f) => /\.css$/.test(f))).toBe(true);
    expect(overBudget(bundle, FIRST_DOWNLOAD_BUDGET, 500_000)).toEqual([]);
    expect(FIRST_DOWNLOAD_BUDGET - first.bytes).toBeLessThan(1000);
    /* RED WHEN: a worker the build names is not built, or a worker's file is in the first download. */
    const workers = outputs.filter(isWorkers).map((f) => f.fileName);
    for (const entry of Object.keys(WORKERS)) {
      const name = entry.split('/').pop()!.replace(/\.ts$/, '');
      expect(workers.some((w) => w.startsWith(`assets/${name}-`)), entry).toBe(true);
    }
    expect(first.files.filter((f) => workers.includes(f))).toEqual([]);
  }, 60_000);
});
