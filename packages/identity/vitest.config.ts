import { defineConfig } from 'vitest/config';

export default defineConfig({
  /*
   * THIS PACKAGE'S OWN RUNNER, FOR `npm test` INSIDE THIS FOLDER. The whole
   * repository's suite runs from the config at its root and includes this
   * package's tests; this one exists so the package can be tested on its own.
   *
   * IT DECLARES NO ALIAS AND NEEDS NONE. Everything under `src/` imports by
   * relative path. The comment that used to stand here described repeating the
   * application's `@/` alias and pointed at a `vite.config.ts` in this folder —
   * both were true of the folder this package came from and neither is true
   * here: the application and its config left with the split, and this package
   * has no `@/`.
   */
  /* Outside node_modules: a cache is not a dependency. */
  cacheDir: '.vite-cache',
  test: {
    /*
     * BOTH extensions, deliberately. This glob once read
     * `src/**\/*.test.ts`, which silently excluded every screen and the
     * session: a `.test.tsx` would not even have been COLLECTED had somebody
     * written one, so the entire shell sat outside the runner and eleven
     * single-line changes to it — including deleting the sign-up rollback —
     * left the suite green. The typechecker reads the shell; it does not run
     * it. Narrowing this glob switches the shell's tests off silently.
     */
    include: ['src/**/*.test.{ts,tsx}'],
    /*
     * TWO TESTS ARE NOT RUN HERE, AND THEY ARE THE TWO THAT REACH ACROSS.
     *
     * Both import the wallet application, which lives beside this package and
     * imports this package back by its published NAME. Under this config that
     * name resolves the way any outside consumer resolves it — through the
     * `exports` map — and five of the subpaths those screens use are not
     * published: `keys/derivation`, `profile/store`, `profile/seal`,
     * `passkey/verify`, `recovery/pieces`. So collecting them here fails with
     * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
     *
     * **THE REASON THIS IS AN EXCLUSION AND NOT A FIX IS THE FIX SOMEBODY
     * WOULD OTHERWISE REACH FOR.** The obvious way to make those five resolve
     * is to widen `exports` — which publishes the key derivation, the passkey
     * verification and the recovery pieces as library API, by accident, to
     * silence a runner. `internal-subpaths.json` beside this file names that
     * move as the one to avoid.
     *
     * They are not skipped: the repository's own suite runs them, with the
     * application's own resolution, and `apps/wallet/tsconfig.json` typechecks
     * them. What is excluded here is only the attempt to run a test of the
     * seam from the side that cannot see both halves.
     */
    exclude: [
      '**/node_modules/**',
      'src/profile/registry-open.test.tsx',
      'src/profile/unlock.test.ts',
    ],
    root: '.',
    /*
     * The portability test derives a wallet twice and builds an address, which
     * loads the ledger WASM. Ten seconds is generous; the default two are not.
     */
    testTimeout: 30_000,
    /*
     * AND THE OTHER CLOCK. `testTimeout` above bounds a whole test;
     * it has no effect on a wait INSIDE one, which takes its budget from the
     * testing library's own configuration and defaults to one second. Setting
     * only the first is how a suite on a loaded machine reports failures in
     * code that is fine. `src/test-setup.ts` sets the second, once, centrally.
     */
    setupFiles: ['./src/test-setup.ts'],
  },
});
