import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import { framingHeadersFor } from '../../packages/identity/src/profile/origin.js';
import { SERVICE_PROXY } from '../../scripts/serve-rules.js';

/**
 * THE NEW PAYROLL APPLICATION.
 *
 * It is served on the application's origin, so the service's sign-in, its
 * cookie and the wallet's framing all see the address they already know.
 *
 * Tailwind's plugin is the one plugin that changes what the page is built
 * from: the kit's stylesheet is Tailwind, and without it the build stops on
 * the stylesheet. The other, the first download's budget (below), only
 * measures what was built. JSX needs no plugin, because the bundler compiles
 * it for React itself.
 *
 * TWO WORKERS, THE VAULT'S. Creating a vault builds and proves its transactions
 * in the shared package's vault worker, where the ledger and the prover load,
 * and that worker starts a second to prove one part beside the others; they
 * are WebAssembly, and never load on the page. The workers are built with
 * their own plugin list, which is the WebAssembly plugin alone, as the legacy
 * application builds it: a worker renders nothing, so it takes neither
 * Tailwind nor the budget.
 */
const ROOT = fileURLToPath(new URL('.', import.meta.url));

/*
 * THE FIRST DOWNLOAD HAS A BUDGET. It rises only when a change deliberately
 * adds to what every page loads, and falls with the download otherwise.
 *
 * The first download is what a browser loads before any page is opened: the
 * entry's script, every script it imports without waiting, and their
 * stylesheets. Fonts are left out, since the browser fetches only those the
 * page's characters need. A build whose first download is larger than the
 * budget stops, and so does one with any file other than a font over the
 * size at which the bundler warns. The budget is the first download as it
 * was measured when it was set; a test holds it within a kilobyte of what is built, so when the
 * download falls the budget is lowered with it.
 */
/*
 * 719,000 bytes, measured from the built application at 718,078: the language
 * file, which the first page loads whole, carries every page's words, and the
 * sign-in path loads the curve library that checks a committee key is a point
 * on its curve, about 34 KB that sign-in itself never uses.
 */
export const FIRST_DOWNLOAD_BUDGET = 734_166;

/**
 * THE WORKERS THIS APPLICATION STARTS, by their entry's path from this folder,
 * each with why. What a worker loads is loaded when it starts, never with the
 * page, so it is outside the first download; and the ledger and prover it
 * carries are larger than the bundler's warning, so a worker's own files are
 * held to no file limit here.
 */
export const WORKERS: Readonly<Record<string, string>> = {
  '../../packages/web-shared/src/vault-worker-entry.ts': 'builds and proves a vault\'s transactions, with the ledger and the prover, which are WebAssembly',
  '../../packages/web-shared/src/vault-proof-worker-entry.ts': 'proves one part of a private deposit beside the others, started by the vault worker and never by the page; carries the prover, which is WebAssembly',
};

/**
 * THE PACKAGES THE WORKERS LOAD THAT CARRY WEBASSEMBLY: the ledger, the
 * on-chain runtime and the prover's circuit checker. Each ships a loader that
 * starts its WebAssembly as the loader's own file is read. The development
 * server's preparation of dependencies rewrites that loader, and the loader
 * then reads the WebAssembly before it exists: the worker stops with "Cannot
 * access before initialization" or "undefined", and creating a vault never
 * gets past its first press. Left as shipped, with the WebAssembly plugin
 * serving the WebAssembly, each starts. The build is not affected: it
 * bundles them whole.
 */
export const WASM_PACKAGES = ['@midnight-ntwrk/zkir-v2', '@midnightntwrk/ledger-v9', '@midnightntwrk/onchain-runtime-v4'] as const;

/**
 * Where a package really is: the nearest modules folder above this one that holds it, with any link followed, so
 * that a modules folder shared or hoisted from elsewhere is listed by the place the files are served from.
 */
function packageFolder(name: string): string {
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`${name} is not installed, so the development server cannot be allowed to serve its WebAssembly. Install the packages.`);
  }
}

/*
 * THE FOLDERS THE DEVELOPMENT SERVER MAY SERVE A FILE FROM BY ITS PATH: this
 * application's own, the folder of each worker's entry, and the one font
 * package the kit's stylesheet names, which is installed at the top of the
 * repository, outside this folder, and the folder of each of the three
 * packages that carry WebAssembly (WASM_PACKAGES), which the worker fetches
 * from the modules folder by its address, and no other package beside them. A page's script names the files it
 * imports, and the server serves those wherever they are; a worker's entry
 * is the one file the browser asks for by its path, so the folder it is in
 * must be listed, or the worker never starts and creating a vault stops
 * before it begins. The font is the same: without it the server refuses the
 * font and the page falls back to another. Nothing else of the repository is
 * opened, and the repository's top folder never is; the build bundles the
 * workers and the font and needs none of this.
 */
export const SERVED_FROM = [
  ROOT.replace(/\/$/, ''),
  ...new Set(Object.keys(WORKERS).map((entry) => dirname(fileURLToPath(new URL(entry, import.meta.url))))),
  fileURLToPath(new URL('../../node_modules/@fontsource-variable/inter', import.meta.url)),
  ...WASM_PACKAGES.map(packageFolder),
];

/*
 * WHAT THE DEVELOPMENT SERVER REFUSES EVEN INSIDE A FOLDER IT MAY SERVE: the
 * server's own list (environment files, certificates and keys, the version
 * history) and every place this repository keeps something secret or private
 * to a machine: the seeds, the key backups, the wallet's state, the data
 * folders, the logs, the chain's local database, and the safe. Each name is
 * refused as a file and as a folder with everything in it.
 */
export const REFUSED_NAMES = ['.env', '.env.*', '*.seed', '.keys-backup', '.midnight', 'logs', 'SAFE', '.data', '.wallet-state', '.pre-reset-*', 'midnight-level-db', 'db', '.git'];
export const REFUSED = ['**/*.{crt,pem}', ...REFUSED_NAMES.flatMap((name) => [`**/${name}`, `**/${name}/**`])];


/** One file of a build's output, as the bundler hands it to a plugin: a script, with what it imports, or anything else. */
export type BuiltFile =
  | { type: 'chunk'; fileName: string; code: string; isEntry: boolean; imports: readonly string[]; viteMetadata?: { importedCss?: ReadonlySet<string> } }
  | { type: 'asset'; fileName: string; source: string | Uint8Array };

const bytesOf = (f: BuiltFile): number => (f.type === 'chunk' ? Buffer.byteLength(f.code) : typeof f.source === 'string' ? Buffer.byteLength(f.source) : f.source.length);

/** The files of the first download, and their size in bytes. */
export function firstDownloadOf(bundle: Readonly<Record<string, BuiltFile>>): { files: string[]; bytes: number } {
  const files = new Set<string>();
  const take = (name: string): void => {
    const f = bundle[name];
    if (f === undefined || files.has(name)) return;
    files.add(name);
    if (f.type !== 'chunk') return;
    for (const css of f.viteMetadata?.importedCss ?? []) take(css);
    for (const i of f.imports) take(i);
  };
  for (const f of Object.values(bundle)) if (f.type === 'chunk' && f.isEntry) take(f.fileName);
  return { files: [...files].sort(), bytes: [...files].reduce((n, name) => n + bytesOf(bundle[name]!), 0) };
}

/**
 * WHETHER A FILE OF THE BUILD IS A WORKER'S: a script or WebAssembly the
 * bundler hands over as an asset. The page's own scripts are chunks; a
 * worker is built on its own and its files come into the page's build as
 * assets, loaded only when the worker starts.
 */
export const isWorkers = (f: BuiltFile): boolean => f.type === 'asset' && /\.(m?js|wasm)$/.test(f.fileName);

/** What stops the build: the first download over `budget`, and each file of the build over `fileLimit`, each in bytes; a font and a worker's files are held to no file limit. */
export function overBudget(bundle: Readonly<Record<string, BuiltFile>>, budget: number, fileLimit: number): string[] {
  const over: string[] = [];
  const first = firstDownloadOf(bundle);
  if (first.bytes > budget) over.push(`the first download is ${first.bytes} bytes, over its budget of ${budget}: ${first.files.join(', ')}`);
  for (const f of Object.values(bundle)) if (bytesOf(f) > fileLimit && !/\.woff2?$/.test(f.fileName) && !isWorkers(f)) over.push(`${f.fileName} is ${bytesOf(f)} bytes, over the bundler's warning at ${fileLimit}`);
  return over;
}

/** The plugin that stops a build over the budget. The file limit is the bundler's own warning, read from the config. */
export function firstDownloadBudget(budget = FIRST_DOWNLOAD_BUDGET): Plugin {
  let fileLimit = 0;
  return {
    name: 'first-download-budget',
    apply: 'build',
    configResolved(c) { fileLimit = c.build.chunkSizeWarningLimit * 1000; },
    generateBundle(_options, bundle) {
      const over = overBudget(bundle as unknown as Record<string, BuiltFile>, budget, fileLimit);
      if (over.length > 0) this.error(over.join('\n'));
    },
  };
}

export default defineConfig({
  root: ROOT,
  plugins: [tailwindcss(), firstDownloadBudget()],
  /*
   * The development server prepares the dependencies it finds by following
   * imports out from the entries listed here, before the page loads. It does
   * not follow a worker started with `new Worker(new URL(...))`, so a
   * dependency that only a worker imports would be found when the worker first
   * starts, and the server would then reload the page, losing whatever the
   * person had done on it. Listing entries replaces the default of every page
   * in this folder, so the page is named, and each worker's entry beside it.
   *
   * The packages that carry WebAssembly are left as they are shipped, never
   * rewritten by that preparation: it breaks the loader each of them ships,
   * and the worker that loads one stops before it answers (see WASM_PACKAGES).
   */
  optimizeDeps: { entries: ['index.html', ...Object.keys(WORKERS)], exclude: [...WASM_PACKAGES] },
  /* The worker's own plugins: WebAssembly alone. */
  worker: { format: 'es', plugins: () => [wasm()] },
  /*
   * No page, on any site, may show this application in a frame. The
   * application shows the person's wallet in a frame, and the wallet answers
   * it because it is the page at the top of the tab; a stranger's page framing
   * this one would sit around both. The development and preview servers send
   * the headers that forbid it.
   */
  server: {
    host: 'localhost',
    /*
     * The page is never reloaded by the server. With the connection for file
     * changes on, the server tells the browser to reload the page whenever a
     * file the page or a worker loads is saved (the page has no refresh plugin,
     * so there is nothing that takes a change without a reload), and a company
     * is made over many minutes in a page that holds its progress only in
     * memory. A person who changes a file reloads the page themselves; the
     * server still reads the changed file when they do.
     */
    hmr: false,
    fs: { allow: SERVED_FROM, deny: REFUSED },
    proxy: { ...SERVICE_PROXY },
    headers: { ...framingHeadersFor(null) },
  },
  preview: { headers: { ...framingHeadersFor(null) } },
  build: { outDir: '../../dist/apps-web', emptyOutDir: true },
});
