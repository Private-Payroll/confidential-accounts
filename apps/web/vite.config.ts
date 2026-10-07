import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
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
 * ONE WORKER, THE VAULT'S. Creating a vault builds and proves its transactions
 * in the shared package's vault worker, where the ledger and the prover load;
 * they are WebAssembly, and never load on the page. The worker is built with
 * its own plugin list, which is the WebAssembly plugin alone, as the legacy
 * application builds it: a worker renders nothing, so it takes neither
 * Tailwind nor the budget.
 */
const ROOT = fileURLToPath(new URL('.', import.meta.url));

/*
 * THE FOLDERS THE DEVELOPMENT SERVER MAY SERVE A FILE FROM BY ITS PATH: this
 * application's own, as the server would choose by itself, and the one font
 * package the kit's stylesheet names, which is installed at the top of the
 * repository, outside this folder. Without it the server refuses the font and
 * the page falls back to another. Nothing else of the repository's packages
 * is opened; the build bundles the font and needs none of this.
 */
export const SERVED_FROM = [
  searchForWorkspaceRoot(ROOT),
  fileURLToPath(new URL('../../node_modules/@fontsource-variable/inter', import.meta.url)),
];

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
export const FIRST_DOWNLOAD_BUDGET = 680_811;

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
   */
  optimizeDeps: { entries: ['index.html', ...Object.keys(WORKERS)] },
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
    fs: { allow: SERVED_FROM },
    proxy: { ...SERVICE_PROXY },
    headers: { ...framingHeadersFor(null) },
  },
  preview: { headers: { ...framingHeadersFor(null) } },
  build: { outDir: '../../dist/apps-web', emptyOutDir: true },
});
