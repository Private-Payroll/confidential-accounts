import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { framingHeadersFor } from './packages/identity/src/profile/origin.js';

/**
 * The payroll interface.
 *
 * ── WHY WebAssembly HANDLING IS HERE ─────────────────────────────────────
 *
 * A device computes its own seat, and a seat is the contract's own circuit:
 * `src/midnight/commitments.ts` is one line over the compiled circuits, and
 * those reach `@midnight-ntwrk/compact-runtime` and the WebAssembly behind it.
 * The page is not handed that scheme today, but it must be ABLE to be — the
 * signing secret never leaves the device, so the derivation happens where the
 * secret is.
 *
 * Without `vite-plugin-wasm` the development server serves the WebAssembly glue
 * behind an initialiser the glue itself does not wait for, so the glue reads
 * exports that are not there yet and throws while the module is still being
 * evaluated: `Cannot read properties of undefined (reading
 * '__wbindgen_export_2')`. Nothing renders — no text, no background, no error
 * on screen — because the failure happens before React is reached.
 *
 * ── AND THE PRODUCTION BUILD DOES NOT SHOW THIS, WHICH IS THE TRAP ───────
 *
 * Measured both ways round on this configuration, with the contract's scheme in
 * the page's graph: `vite build` SUCCEEDS without this plugin, emits the
 * WebAssembly asset, and the built page renders correctly — while `npm run dev`
 * on the same source renders nothing at all. **So neither a green build nor a
 * search of the bundle is evidence here.** What settles it is the page opened in
 * a real browser with its rendered text read back, which the check that drives a
 * browser at the running app already reports.
 *
 * ── AND THE WORKER GETS THE SAME HANDLING, NOW THAT IT HAS REAL WORK ─────
 *
 * This block used to say `worker.plugins` was deliberately left bare, because
 * nothing instantiated a worker and wiring a build for a graph that did not
 * exist would be a configuration nobody could measure. **That is no longer
 * true.** The page starts a proving worker, and that worker's whole job is to
 * reach a WebAssembly prover — so it needs exactly what the page needed, for
 * exactly the same reason.
 *
 * **AND THE FAILURE IT PREVENTS IS WORSE IN A WORKER THAN IN A PAGE.** A module
 * that throws while a page evaluates it leaves a blank screen; a module that
 * throws while a Worker evaluates it leaves a thread that simply never answers,
 * with nothing on screen and nothing in the console. The worker posts a ready
 * notice once its listener stands and the page waits for it, so this failure
 * presents as a strip that never appears rather than as an error.
 *
 * ── ONE PLUGIN, NOT TWO ──────────────────────────────────────────────────
 *
 * The standalone wallet in this repository pairs this plugin with
 * `vite-plugin-top-level-await`, which rewrites top-level await for build
 * targets that cannot carry it. This build does not need it: measured here, the
 * page renders under the development server and under a production build at
 * this configuration's own target with `vite-plugin-wasm` alone. It is left out
 * rather than copied across because that plugin loads `@swc/core`, a native
 * binary that must be present and working on every machine that runs this
 * build, and an unused dependency on one is a way for the interface to stop
 * building for a reason that has nothing to do with the interface.
 */
export default defineConfig({
  root: 'src/web',
  plugins: [react(), wasm()],
  /*
   * The worker's own plugin list is separate from the page's, so the handling
   * above does not reach it and has to be stated again here. `react()` is
   * deliberately absent: a worker renders nothing, and a plugin that rewrites
   * JSX in a graph that contains none is a plugin that can only cost.
   */
  worker: { format: 'es', plugins: () => [wasm()] },
  /*
   * **NOTHING MAY FRAME THIS APPLICATION.** It frames the person's wallet, and the
   * wallet answers it because it is the top of the tab; this page inside a
   * stranger's would put a stranger around both. `frame-ancestors` is honoured
   * only as a response header, so it is sent with every document here.
   */
  server: {
    port: 5173, host: true, proxy: { '/api': 'http://localhost:8787', '/artefacts/vault': 'http://localhost:8787' },
    headers: { ...framingHeadersFor(null) },
  },
  preview: { headers: { ...framingHeadersFor(null) } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
