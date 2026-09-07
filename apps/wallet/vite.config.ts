import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import tailwind from '@tailwindcss/vite';
import topLevelAwait from 'vite-plugin-top-level-await';

/**
 * The standalone wallet, served for testing.
 *
 * `ledger-v9` is a WebAssembly module and loads itself with a top-level await,
 * which is why both plugins are here — without them the build fails with
 * something unhelpful about `.wasm` not being a module.
 *
 * The port is fixed rather than "whatever is free" because **a passkey is bound
 * to an origin**, and an origin includes the port. A wallet created on 5180 is
 * unreachable from 5181, which is correct behaviour and a baffling way to lose
 * a test account.
 */
export default defineConfig({
  root: '.',
  /*
   * `vite-plugin-top-level-await` resolves `rollup`, `esbuild` and `@swc/core`
   * at RUNTIME without declaring any of them, which is why all three are pinned
   * in this repo's own devDependencies — until they were, they resolved from
   * the parent repo's node_modules and this build worked by accident.
   *
   * **`@swc/core` is pinned at 1.12.14 because 1.16.0 breaks this plugin**:
   * its `printSync` fails with "missing field `type`" in generateBundle and
   * `vite build` dies. Bumping that pin means testing `npm run wallet:build`,
   * not just the dev server — the dev server never runs the failing hook.
   */
  /*
   * `@tailwindcss/vite` is the whole of Tailwind v4's build integration —
   * there is no `tailwind.config.js` and no PostCSS step. It processes
   * `apps/wallet/app.css`, which `index.html` links directly.
   *
   * IT SHIPS A NATIVE BINARY (`@tailwindcss/oxide`), one per platform, which
   * is the class of dependency `vite.config.ts` already turns CSS
   * minification off to avoid. It is here because the toolchain decision was
   * taken by the design — but the same warning applies:
   * a `node_modules` installed on one machine does not build on another, so
   * a checkout on a different machine installs from the lockfile rather than
   * copying
   * the folder.
   */
  plugins: [react(), tailwind(), wasm(), topLevelAwait()],
  /*
   * The PROVING WORKER's own build pipeline. `proving-worker.ts` loads
   * the zkir WASM, which arrives through the same wasm plugin and therefore
   * under a top-level await; a worker bundles as `iife` by default, where
   * top-level await is refused and `vite build` dies. `es` format carries
   * it, and the worker graph needs the same two plugins the page graph has,
   * for the same reason the page has them.
   */
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  resolve: {
    /*
     * THE ARRAY FORM, NOT THE OBJECT FORM, AND THAT IS FORCED RATHER THAN
     * PREFERRED. The object form takes only string keys, and three of the
     * entries below have to match EXACTLY rather than by prefix. The two
     * forms are otherwise the same thing: vite converts an object to this
     * array, in key order, and a string `find` matches when the import is
     * exactly it or begins with it and a separator.
     */
    alias: [
      /*
       * Node's `assert`, for the browser - a probe find. The DUST address
       * encodes through `@subsquid/scale-codec` (CommonJS), which requires the
       * `assert` built-in and CALLS it; vite's default browser stand-in is an
       * empty object, so deriving a DUST address threw in every real browser
       * while the whole Node-run suite stayed green. The probe caught it. The
       * alias points the built-in at a ten-line shim that throws on failure,
       * which is all the codec asks of it.
       */
      { find: 'assert', replacement: fileURLToPath(new URL('../../packages/identity/src/browser/assert-shim.ts', import.meta.url)) },
      /*
       * The matching half of tsconfig's `paths`. The typechecker resolves
       * `@/` through `paths`; the bundler has to be told separately, or the
       * app builds green and dies at runtime on a module the compiler was
       * happy with.
       *
       * A BARE `@` IS SAFE HERE AND IT IS WORTH SAYING WHY, because it looks
       * like it would swallow every scoped package. A STRING `find` matches
       * only when the import is exactly `@` or begins `@/`.
       * `@radix-ui/react-dialog` and `@midnightntwrk/ledger-v9` do not begin
       * `@/` and are untouched - pinned by `apps/wallet/kit/alias.test.ts`,
       * which resolves one of each.
       */
      { find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) },
      /*
       * THE LIBRARY, REACHED BY ITS PACKAGE NAME AND RESOLVED FROM SOURCE.
       *
       * THE THREE EXACT ENTRIES MIRROR THE LIBRARY'S OWN `exports` MAP, so
       * this application spells a published subpath exactly as any other
       * consumer spells it - `midnight-identity/network` is `wallet/network`
       * inside the library, and an entry that got that wrong would resolve
       * silently to a file that is not there.
       *
       * THE PREFIX ENTRY BENEATH THEM REACHES MODULES THE `exports` MAP DOES
       * NOT PUBLISH. Those are not public API and the wallet is not an
       * outside consumer: it is built from this repository, from source, and
       * an outside consumer receives only what `exports` names. The set it
       * reaches is written down in `packages/identity/internal-subpaths.json`
       * and pinned, so it cannot grow without somebody saying so.
       *
       * FROM SOURCE RATHER THAN FROM THE EMITTED BUILD, so the dev server and
       * the tests need no build step and can never read a stale one.
       */
      { find: /^midnight-identity$/, replacement: fileURLToPath(new URL('../../packages/identity/src/index.ts', import.meta.url)) },
      { find: /^midnight-identity\/browser$/, replacement: fileURLToPath(new URL('../../packages/identity/src/browser/index.ts', import.meta.url)) },
      { find: /^midnight-identity\/network$/, replacement: fileURLToPath(new URL('../../packages/identity/src/wallet/network.ts', import.meta.url)) },
      { find: 'midnight-identity', replacement: fileURLToPath(new URL('../../packages/identity/src', import.meta.url)) },
    ],
  },
  server: { port: 5180, strictPort: true, host: true },
  /*
   * The dependency cache goes OUTSIDE node_modules. Vite's default is
   * `node_modules/.vite`, which creates a `node_modules` directory containing
   * no packages — and npm has been seen to get confused by exactly that.
   * A cache is not a dependency and does not belong in the same folder.
   */
  cacheDir: '../../.vite-cache',
  build: {
    outDir: '../../dist/wallet',
    emptyOutDir: true,
    target: 'esnext',
    /*
     * CSS minification is off. It pulls in `lightningcss`, which ships a native
     * binary per platform — so a `node_modules` installed on one machine cannot
     * build on another, which is exactly the situation when somebody checks the
     * build from a different box. A test wallet does not need smaller CSS, and
     * one fewer native dependency is worth more than the bytes.
     */
    cssMinify: false,
  },
  /*
   * `wallet-sdk-prover-client` is excluded for one reason: the WASM prover
   * runs in a WEB WORKER the SDK spawns with
   * `new Worker(new URL('../../dist/proof-worker.js', import.meta.url))`
   * (wallet-sdk-prover-client/dist/effect/WasmProver.js:67). Prebundled,
   * `import.meta.url` becomes the CACHE CHUNK's url and the relative path
   * points at a file that does not exist — measured in .vite-cache/deps:
   * the literal survives into the chunk — so the first real proof would die
   * on "worker failed to load", an error that looks like WASM and is a
   * bundler. Excluded, the package is served from node_modules, the URL
   * resolves to the real proof-worker.js, and vite transforms the worker's
   * own imports like any other module. The probe never noticed because a DUST
   * registration has no proof obligations and the worker never spawned.
   */
  optimizeDeps: {
    exclude: ['@midnightntwrk/ledger-v9', '@midnightntwrk/wallet-sdk-prover-client'],
  },
});
