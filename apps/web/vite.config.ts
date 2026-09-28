import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
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
 * Nothing is rendered yet, so no React or WebAssembly plugin is loaded and no
 * worker is started; each is added with the first screen that needs it.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  /*
   * The page is the only entry of the dependency scan. A worker, when one is
   * started from this application, is named here beside it, for the reason the
   * root `vite.config.ts`, which serves `src/web-legacy`, gives: a dependency only a worker imports would
   * otherwise be prepared when the worker first starts, and the page reloaded.
   */
  optimizeDeps: { entries: ['index.html'] },
  /*
   * **NOTHING MAY FRAME THIS APPLICATION**, for the same reason as the one in
   * `src/web-legacy`: it frames the person's wallet, and the wallet answers it because
   * it is the top of the tab.
   */
  server: {
    host: 'localhost',
    proxy: { ...SERVICE_PROXY },
    headers: { ...framingHeadersFor(null) },
  },
  preview: { headers: { ...framingHeadersFor(null) } },
  build: { outDir: '../../dist/apps-web', emptyOutDir: true },
});
