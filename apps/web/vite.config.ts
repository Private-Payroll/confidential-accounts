import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { framingHeadersFor } from '../../packages/identity/src/profile/origin.js';
import { SERVICE_PROXY } from '../../scripts/serve-rules.js';

/**
 * THE NEW PAYROLL APPLICATION.
 *
 * It is served on the same origin as the application in `src/web-legacy`, one at a
 * time, so the service's sign-in, its cookie and the wallet's framing all see
 * the address they already know. What differs is the folder served and, until
 * a screen needs them, the plugins.
 *
 * Tailwind's plugin is the one plugin: the kit's stylesheet is Tailwind, and
 * without it the build stops on the stylesheet. JSX needs none, because the
 * bundler compiles it for React itself. No WebAssembly plugin is loaded and no
 * worker is started; each is added with the first screen that needs it.
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

export default defineConfig({
  root: ROOT,
  plugins: [tailwindcss()],
  /*
   * The development server prepares the dependencies it finds by following
   * imports out from the entries listed here, before the page loads. It does
   * not follow a worker started with `new Worker(new URL(...))`, so a
   * dependency that only a worker imports would be found when the worker first
   * starts, and the server would then reload the page, losing whatever the
   * person had done on it. Listing entries replaces the default of every page
   * in this folder, so the page is named; when this application starts a
   * worker, the worker's entry file is added beside it.
   */
  optimizeDeps: { entries: ['index.html'] },
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
