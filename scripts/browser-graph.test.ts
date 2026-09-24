/**
 * NOTHING A BROWSER LOADS MAY REACH A NODE-ONLY MODULE.
 *
 * Every other test in this repository runs in Node, where `node:fs` is simply
 * there. So a page or a worker that imports it, however indirectly, passes the
 * whole suite and then stops in a real browser before its first line runs,
 * with *Module "node:fs" has been externalized for browser compatibility*.
 * That is how the vault builder once failed to load: the worker reached the
 * whole server-side ledger adapter to get two pure functions, and the adapter
 * reads compiled artefacts from disk.
 *
 * This walks the graph each browser build actually serves - every page, every
 * worker those pages start, every file in this repository they reach - through
 * the bundler's own TypeScript transform, so a type-only import is excluded
 * exactly when the bundler excludes it, and refuses any static import of a Node
 * built-in.
 *
 * WHAT IT DOES NOT SEE: a Node import inside a third-party package. It stops at
 * a dependency installed from outside this repository, so a dependency whose
 * browser entry still needs a Node built-in passes here and fails only in a
 * browser. A package linked back into this repository is followed.
 *
 * The first block proves the walker can see what it claims to see, on a
 * fixture built outside the repository. The rest run it on the real builds.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_BUILDS, pagesIn, scriptsOf, walkBuild, type BrowserBuild, type BuildGraph } from './browser-graph.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

describe('THE WALKER SEES A NODE IMPORT WHERE A BROWSER WOULD MEET ONE, AND ONLY THERE', () => {
  let root = '';
  let graph: BuildGraph;
  let broken: BuildGraph;

  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-graph-')));
    put('node_modules/buffer/package.json', '{"name":"buffer","version":"0.0.0"}');
    put('site/index.html', '<!doctype html><script type="module" src="./main.ts"></script>');
    put('site/main.ts', [
      "import type { Stats } from 'node:fs';",
      "import { type Dirent } from 'node:fs';",
      "import { StatsFs } from 'node:fs';",
      "import { Buffer } from 'buffer';",
      "import { leaf } from './leaf.js';",
      "import secondWorker from './second-worker.ts?worker&url';",
      "import { own } from 'own-package/part';",
      "import { deep } from 'own-package/deep/x';",
      "export { host } from './passed-on.js';",
      'export let used: Stats | Dirent | StatsFs | undefined;',
      "export const worker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });",
      "export const later = () => import('node:fs/promises');",
      'console.log(leaf, Buffer, secondWorker, own, deep);',
    ].join('\n'));
    put('site/leaf.ts', "import { readFileSync } from 'node:fs';\nexport const leaf = () => readFileSync;\n");
    put('site/passed-on.ts', "import { hostname } from 'node:os';\nexport const host = hostname;\n");
    put('site/second-worker.ts', "import { gzip } from 'node:zlib';\nexport const z = gzip;\n");
    put('packages/own/package.json', JSON.stringify({
      name: 'own-package', type: 'module',
      exports: {
        './part': { types: './lib/part.d.ts', import: './lib/part.js', browser: './lib/clean.js' },
        './*': './lib/wrong/*.js',
        './deep/*': './lib/deep/*.js',
      },
    }));
    put('packages/own/lib/part.js', "import { createHash } from 'node:crypto';\nexport const own = createHash;\n");
    put('packages/own/lib/clean.js', 'export const own = 1;\n');
    put('packages/own/lib/deep/x.js', "import { lookup } from 'node:dns';\nexport const deep = lookup;\n");
    put('packages/own/lib/wrong/deep/x.js', 'export const deep = 1;\n');
    symlinkSync('../packages/own', join(root, 'node_modules/own-package'));
    put('site/worker.ts', "import { join } from 'node:path';\nexport const j = join;\n");
    put('broken/index.html', '<script type="module" src="./main.ts"></script>');
    put('broken/main.ts', [
      "import { gone } from './missing.js';",
      "import { nowhere } from 'not-installed';",
      "import { Buffer } from 'node:buffer';",
      'console.log(gone, nowhere, Buffer);',
    ].join('\n'));
    const build = (name: string): BrowserBuild => ({ name, config: '', root: name, pages: [`${name}/index.html`], alias: [] });
    graph = await walkBuild(build('site'), root);
    broken = await walkBuild(build('broken'), root);
  });

  afterAll(() => { if (root !== '') rmSync(root, { recursive: true, force: true }); });

  it('REPORTS A STATIC NODE IMPORT ONE FILE AWAY AND ONE WORKER AWAY, WITH THE WAY THERE', () => {
    /* RED WHEN: relative imports stop being followed, or a `.js` specifier stops being read as its `.ts`
     * source - `leaf.ts` then drops out; or a `?worker&url` import is taken for an asset - `second-worker.ts`
     * drops out; or a package linked back into the repository is treated as a third-party one, or its
     * `exports` are not read - `part.js` drops out; or a condition is chosen by a fixed priority rather
     * than by the map's own key order - `clean.js` is taken instead; or a shorter `*` pattern listed first
     * wins over the longer one - `lib/wrong/deep/x.js` is taken and `deep/x.js` drops out; or `export ... from` stops being followed -
     * `passed-on.ts` drops out; or `new Worker(new URL(...))` stops being followed - `worker.ts` drops out. */
    expect(graph.staticNode).toEqual([
      { file: 'site/leaf.ts', specifier: 'node:fs', chain: ['site/main.ts', 'site/leaf.ts'] },
      { file: 'site/second-worker.ts', specifier: 'node:zlib', chain: ['site/main.ts', 'site/second-worker.ts'] },
      { file: 'packages/own/lib/part.js', specifier: 'node:crypto', chain: ['site/main.ts', 'packages/own/lib/part.js'] },
      { file: 'packages/own/lib/deep/x.js', specifier: 'node:dns', chain: ['site/main.ts', 'packages/own/lib/deep/x.js'] },
      { file: 'site/passed-on.ts', specifier: 'node:os', chain: ['site/main.ts', 'site/passed-on.ts'] },
      { file: 'site/worker.ts', specifier: 'node:path', chain: ['site/main.ts', 'site/worker.ts'] },
    ]);
    /* RED WHEN: a worker is followed as an ordinary import rather than recorded as an entry of its own. */
    expect(graph.entries).toEqual(['site/main.ts', 'site/second-worker.ts', 'site/worker.ts']);
  });

  it('DOES NOT COUNT A TYPE, AN INSTALLED PACKAGE OR A DYNAMIC IMPORT AS A STATIC NODE IMPORT', () => {
    /* RED WHEN: imports are read from the source rather than from the transform's output - the three
     * type-only imports of `node:fs` in `main.ts` then appear above; or an installed package named like
     * a built-in (`buffer`) is taken for the built-in. Both would put `site/main.ts` in `staticNode`. */
    expect(graph.staticNode.map((n) => n.file)).not.toContain('site/main.ts');
    /* RED WHEN: a dynamic import is filed as static, or is dropped instead of reported. */
    expect(graph.dynamicNode).toEqual([{ file: 'site/main.ts', specifier: 'node:fs/promises', chain: ['site/main.ts'] }]);
  });

  it('REPORTS WHAT IT CANNOT FOLLOW, AND READS node: AS NODE EVEN WHERE A PACKAGE OF THAT NAME EXISTS', () => {
    /* RED WHEN: an import that names no file, or a bare name that is not installed, is skipped silently -
     * which is how an alias the walker did not know would hide the files behind it. */
    expect(broken.unresolved).toEqual([
      { file: 'broken/main.ts', specifier: './missing.js' },
      { file: 'broken/main.ts', specifier: 'not-installed' },
    ]);
    /* RED WHEN: a `node:` specifier is looked up as the package of the bare name - `buffer` is installed in
     * this fixture, so `node:buffer` would then be taken for it. The bundler never does that. */
    expect(broken.staticNode.map((n) => n.specifier)).toEqual(['node:buffer']);
  });
});

describe('EVERY BROWSER BUILD IN THIS REPOSITORY', () => {
  const graphs = new Map<string, BuildGraph>();

  beforeAll(async () => {
    for (const b of BROWSER_BUILDS) graphs.set(b.name, await walkBuild(b, REPO));
  });

  const byName = (name: string): BuildGraph => {
    const g = graphs.get(name);
    if (g === undefined) throw new Error(`no build named ${name}`);
    return g;
  };

  it.each(BROWSER_BUILDS.map((b) => b.name))('%s REACHES NO STATIC IMPORT OF A NODE BUILT-IN', (name) => {
    /* RED WHEN: any file a page or worker of this build reaches imports a Node built-in as a value.
     * Measured: `src/midnight/vault-committee.ts` importing its two authority functions from
     * `./ledger.js` again turns `payroll` and `standalone` red, through `ledger.ts` to `circuit-arity.ts`. */
    const found = byName(name).staticNode.map((n) => `${n.specifier} in ${n.chain.join(' -> ')}`);
    expect(found).toEqual([]);
  });

  it.each(BROWSER_BUILDS.map((b) => b.name))('%s REACHES NOTHING THE WALK COULD NOT FOLLOW', (name) => {
    /* RED WHEN: a page names a script that is not there, a relative import names no file, or a bare
     * import is neither installed nor one of the build's aliases - the walk would stop short there and
     * the refusal above would be answering for part of the graph only. */
    expect(byName(name).unresolved).toEqual([]);
  });

  it('NO BROWSER BUILD REACHES THE SERVER-SIDE LEDGER ADAPTER', () => {
    /* The Node import is only where this surfaced. The defect is a browser module holding a reference to
     * the adapter, which is built to run on a server and may reach Node at any time.
     * RED WHEN: any browser file imports a value from `src/midnight/ledger.ts` - restoring the value import
     * in `vault-committee.ts` does. */
    const reaching = BROWSER_BUILDS.filter((b) => byName(b.name).files.includes('src/midnight/ledger.ts')).map((b) => b.name);
    expect(reaching).toEqual([]);
  });

  it('THE PAYROLL PAGE IS WALKED THROUGH BOTH ITS WORKERS AND INTO THE VAULT BUILDER', () => {
    /* A walk that stopped at the page would pass the refusal above for the wrong reason.
     * RED WHEN: workers stop being followed - the worker entries vanish from `entries` and the vault
     * builder and its committee rule vanish from `files`. */
    const g = byName('payroll');
    expect(g.entries).toEqual([
      'src/web/main.tsx', 'src/web/proving-worker-entry.ts', 'src/web/vault-worker-entry.ts', 'src/web/payslip-worker-entry.ts',
    ]);
    expect(g.files).toEqual(expect.arrayContaining(['src/web/vault-builder.ts', 'src/midnight/vault-committee.ts', 'src/midnight/authority-replacement.ts']));
    /* RED WHEN: `midnight-identity`, linked into `node_modules` from this repository, stops being followed -
     * the page is served its built `lib/` files and they would go unexamined. */
    expect(g.files).toEqual(expect.arrayContaining(['packages/identity/lib/profile/fingerprint.js', 'packages/identity/lib/wallet/network.js']));
  });

  it('THE ONLY DYNAMIC NODE IMPORTS ARE THE TWO BEHIND THE DISK-BACKED KEY SOURCE', () => {
    /* A dynamic import is not refused - it runs only if the line that asks for it runs. These two sit inside
     * `fileKeyMaterialSource`, which nothing a browser loads calls. Pinned so a new one is looked at.
     * RED WHEN: a new dynamic import of a Node built-in enters a browser graph, or these two move. */
    for (const name of ['payroll', 'standalone']) {
      expect(byName(name).dynamicNode.map((n) => `${n.file} ${n.specifier}`)).toEqual([
        'src/midnight/wasm-proving.ts node:fs/promises',
        'src/midnight/wasm-proving.ts node:path',
      ]);
    }
    for (const name of ['proving-probe', 'wallet']) expect(byName(name).dynamicNode).toEqual([]);
  });

  it('THE LIST OF BUILDS IS EVERY VITE CONFIG, AND EACH LISTS EVERY PAGE IN ITS ROOT', () => {
    /* RED WHEN: a vite config is added at the root or under `apps/` without a line in `BROWSER_BUILDS`, or a
     * page is added to a build's root without being listed - its graph would otherwise never be walked. */
    const configs = [
      ...readdirSync(REPO).filter((n) => /^vite(\..+)?\.config\.ts$/.test(n)),
      ...readdirSync(join(REPO, 'apps')).flatMap((d) => readdirSync(join(REPO, 'apps', d))
        .filter((n) => /^vite(\..+)?\.config\.ts$/.test(n)).map((n) => `apps/${d}/${n}`)),
    ].sort();
    expect(BROWSER_BUILDS.map((b) => b.config).sort()).toEqual(configs);
    for (const b of BROWSER_BUILDS) expect(b.pages).toEqual(pagesIn(b.root, REPO));
  });

  it('THE DEVELOPMENT SERVER PRE-SCANS THE PAYROLL PAGE AND EVERY WORKER IT STARTS', async () => {
    /* A dependency only a worker imports is otherwise found when the worker first starts, and the
     * development server then reloads the page and loses what was on it.
     * RED WHEN: `optimizeDeps.entries` is removed from `vite.config.ts`, or a worker is added to the page
     * without being named there. */
    const { default: config } = await import('../vite.config.ts');
    const build = BROWSER_BUILDS.find((b) => b.name === 'payroll') as BrowserBuild;
    expect(config.root).toBe(build.root);
    const scanned = (config.optimizeDeps?.entries ?? []) as string[];
    const pageScripts = build.pages.flatMap((p) => scriptsOf(readFileSync(join(REPO, p), 'utf8'))
      .map((s) => relative(REPO, join(REPO, dirname(p), s)).split('\\').join('/')));
    const expected = [
      ...build.pages.map((p) => relative(build.root, p)),
      ...byName('payroll').entries.filter((e) => !pageScripts.includes(e)).map((e) => relative(build.root, e)),
    ];
    expect([...scanned].sort()).toEqual(expected.sort());
  });
});
