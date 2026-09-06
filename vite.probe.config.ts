import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Serves the browser-proving probe with the headers threading needs.
 *
 * COOP/COEP are what turn on `crossOriginIsolated`, and therefore
 * SharedArrayBuffer. We serve the application ourselves in production, so these
 * headers are ours to set — this config is the proof that our side of the
 * threaded-WASM ask is already in place and waiting on the artefact.
 */
export default defineConfig({
  /*
   * `@midnight-ntwrk/zkir-v2`'s `browser` entry is the wasm-bindgen BUNDLER
   * target: it does `import * as wasm from './midnight_zkir_wasm_bg.wasm'` and
   * then calls `wasm.__wbindgen_start()` at the top level. Webpack understands
   * both; Vite understands neither without these two plugins, and fails at
   * runtime rather than at build time — `__wbindgen_export_1 of undefined`,
   * which names nothing useful.
   */
  // The dep optimiser rewrites the glue and breaks the wasm URL, so this
  // package has to be served as source.
  optimizeDeps: { exclude: ['@midnight-ntwrk/zkir-v2'] },
  root: resolve(__dirname, 'browser-proving'),
  // Two pages: the prover load probe, and the Worker/IndexedDB probe.
  build: { rollupOptions: { input: ['index.html', 'worker.html', 'wallet.html'] } },
  server: {
    port: 5199,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: [resolve(__dirname)] },
  },
  plugins: [
    wasm(),
    topLevelAwait(),
    {
      name: 'serve-artefacts-in-place',
      configureServer(server) {
        const roots: Record<string, string> = {
          '/artefacts/zkir/': resolve(__dirname, 'contracts/managed/zkir'),
          '/artefacts/keys/': resolve(__dirname, 'contracts/managed/keys'),
          '/artefacts/params/': resolve(__dirname, '.midnight/params'),
        };
        /*
         * Lets the page write its own report file.
         *
         * The wallet check runs in a real browser rather than in headless
         * Chromium, so there is no Playwright to read the result out. Posting
         * it back means one button press leaves a REPORT file next to the
         * others, which is the pattern every other script here follows.
         */
        server.middlewares.use((req, res, next) => {
          if (req.method !== 'POST' || !(req.url ?? '').startsWith('/report')) return next();
          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
          req.on('end', () => {
            try {
              const { text, result } = JSON.parse(body);
              writeFileSync(
                resolve(__dirname, 'REPORT-BROWSER-WALLET.txt'),
                `Started ${new Date().toISOString()}\n\n${text}\n\n--- structured ---\n${JSON.stringify(result, null, 2)}\n`,
              );
            } catch { /* a malformed post must not take the dev server down */ }
            res.statusCode = 204;
            res.end();
          });
        });
        server.middlewares.use((req, res, next) => {
          const url = (req.url ?? '').split('?')[0];
          const prefix = Object.keys(roots).find((p) => url.startsWith(p));
          if (!prefix) return next();
          // basename only: a probe must not become a way to read the disk.
          const name = basename(url.slice(prefix.length));
          const file = resolve(roots[prefix], name);
          if (!existsSync(file)) { res.statusCode = 404; return res.end('no such artefact'); }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(readFileSync(file));
        });
      },
    },
  ],
  /*
   * Artefacts are SERVED FROM WHERE THEY ALREADY ARE rather than copied into a
   * public/ folder. A copy would be 16 MB of duplicated proving keys and SRS in
   * the repo, and — worse — a second copy that could silently go stale after a
   * recompile, which is exactly the class of failure M-85 was.
   */
  publicDir: false,
  resolve: { conditions: ['browser'] },
});
