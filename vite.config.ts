import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';

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
 * ── WHAT IS DELIBERATELY NOT COVERED: THE WORKER ─────────────────────────
 *
 * `worker.plugins` is not given this handling, and that is a decision rather
 * than an oversight. A worker is one of the shapes the seat derivation could
 * take, and `src/web/prover-worker.ts` is the seam it would arrive through —
 * but nothing instantiates that worker today, so wiring a build for a graph
 * that does not exist would be a configuration nobody can measure. **Whoever
 * gives that worker real work adds the same handling to `worker.plugins`
 * and measures the page again**, because a module that throws while a Worker
 * evaluates it is worse than one that throws in the page: the page sees
 * nothing at all.
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
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:8787' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
