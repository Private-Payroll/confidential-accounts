import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/*
 * ── THE WALLET REACHES THE LIBRARY FROM SOURCE. NOTHING ELSE DOES. ──────────
 *
 * Two products share this runner. Both import `midnight-identity`, and they
 * must not resolve it the same way.
 *
 * PAYROLL IS AN OUTSIDE CONSUMER and resolves it the way an outside consumer
 * does: through the package's `exports` map, at the emitted build. One of its
 * tests pins a key derivation against exactly that artefact, so redirecting
 * payroll at the source would quietly change what that test is a pin ON.
 *
 * THE WALLET IS NOT AN OUTSIDE CONSUMER. It is built from this repository and
 * reaches modules the `exports` map does not publish; those are written down in
 * `packages/identity/internal-subpaths.json` and pinned by
 * `apps/wallet/src/internal-reach.test.ts`.
 *
 * SO THE RESOLVER ASKS WHO IS IMPORTING. A file under `apps/wallet/` gets the
 * source; everything else gets `null`, which is this resolver saying it has no
 * opinion, and the request goes on to resolve normally. **THE IMPORTER TEST IS
 * THE WHOLE OF IT** - without it this is a repository-wide redirection wearing
 * an application-scoped comment, and the pin it breaks is on the money path.
 */
const WALLET = fileURLToPath(new URL('./apps/wallet/', import.meta.url));
const LIB = fileURLToPath(new URL('./packages/identity/src/', import.meta.url));

/*
 * The three exact spellings mirror the library's own `exports` map, so a
 * published subpath is written the same way in both products.
 * `midnight-identity/network` is `wallet/network` inside the library, and an
 * entry that got that wrong would resolve to a file that is not there.
 */
const EXACT: Record<string, string> = {
  'midnight-identity': LIB + 'index.ts',
  'midnight-identity/browser': LIB + 'browser/index.ts',
  'midnight-identity/network': LIB + 'wallet/network.ts',
};

export const walletLibraryResolver = (source: string, importer: string | undefined): string | null => {
  if (importer === undefined || !importer.startsWith(WALLET)) return null;
  const exact = EXACT[source];
  if (exact !== undefined) return exact;
  if (source.startsWith('midnight-identity/')) return LIB + source.slice('midnight-identity/'.length);
  return null;
};

export default defineConfig({
  /*
   * A PLUGIN AND NOT AN ALIAS ENTRY, because an alias cannot ask who is
   * importing without `customResolver`, which vite has deprecated. `enforce:
   * 'pre'` puts it ahead of node resolution, and returning `null` means it has
   * no opinion - which is the answer for every importer that is not the wallet.
   */
  plugins: [
    {
      name: 'wallet-reaches-the-library-from-source',
      enforce: 'pre' as const,
      /*
       * `this.resolve` FINISHES THE JOB AND THAT IS NOT A DETAIL. What the
       * mapping produces for a subpath is a path with no extension - the
       * library is TypeScript and the import is spelled the way the `exports`
       * map spells it. A `pre` plugin's return value is taken as FINAL, so
       * returning that would name a file that is not there, and the failure
       * reads as a missing module rather than as an unfinished resolution.
       */
      async resolveId(source: string, importer: string | undefined) {
        const mapped = walletLibraryResolver(source, importer);
        if (mapped === null) return null;
        const finished = await this.resolve(mapped, importer, { skipSelf: true });
        return finished ?? mapped;
      },
    },
  ],
  resolve: {
    alias: [
      /*
       * The wallet's own `@/`. A STRING find matches only an import that is
       * exactly `@` or begins `@/`, so no scoped package is touched - measured
       * here as well as in the wallet's own config: nothing outside
       * `apps/wallet/` imports either spelling.
       */
      { find: '@', replacement: WALLET + 'src' },
    ],
  },
  test: {
    /*
     * contracts/ runs the compiled Compact circuits in process, so it needs
     * `npm run compact:fast` to have produced contracts/managed first.
     *
     * **BOTH EXTENSIONS, BECAUSE NARROWING THIS HAS ALREADY COST A DEFECT.**
     * The wallet's glob once read `.ts` only, which silently excluded every
     * screen - a `.test.tsx` would not have been COLLECTED had somebody written
     * one, so eleven single-line changes to the wallet's screen shell went
     * through with the suite green. The typechecker reads a screen; it does not run it. **Narrowing
     * this back switches the screen tests off without a word.**
     */
    include: [
      'src/**/*.test.{ts,tsx}', 'contracts/test/**/*.test.ts', 'scripts/**/*.test.ts',
      /*
       * BOTH PRODUCTS' TESTS RUN HERE, and that is the whole of what the merge
       * changed about this file. The wallet's tests used to run under a second
       * runner in a folder of their own; there is one repository now and one
       * suite, so a change to the shared library goes red in whichever product
       * it broke rather than in whichever product somebody thought to run.
       */
      'packages/identity/src/**/*.test.{ts,tsx}', 'apps/wallet/**/*.test.{ts,tsx}',
      /*
       * AND THE NEW WEB APPLICATION AND ITS COMPONENT KIT, from before either
       * has a test, so the first one written is collected rather than
       * discovered missing later.
       */
      'apps/web/**/*.test.{ts,tsx}', 'packages/ui/**/*.test.{ts,tsx}',
    ],
    /*
     * **THE ROOT IS THIS FILE'S OWN DIRECTORY, SAID ABSOLUTELY.**
     *
     * It was `'.'`. A relative root is handed to vite and resolved with
     * `path.resolve`, which resolves against the WORKING DIRECTORY - so `'.'`
     * meant this repository only for as long as every run started here, and a
     * run begun from a subdirectory would have pointed the whole suite at that
     * subdirectory. Deriving it from this file's own URL makes it the
     * repository root whatever directory the runner was invoked from, and gives
     * a config that spreads this `test` block a settled absolute path rather
     * than one that re-resolves under it.
     */
    root: fileURLToPath(new URL('.', import.meta.url)),
    testTimeout: 30_000,
    /*
     * **THE ENVIRONMENT IS NOT SET HERE, ON PURPOSE.**
     *
     * Almost every test in this repository is a node test: it spawns the real
     * service, opens sqlite, reads the filesystem, loads ledger WASM. Turning
     * jsdom on globally would put a fake DOM under all of them to serve the one
     * that needs it. So the default stays node and a screen test declares its
     * own with `// @vitest-environment jsdom` on its first line — **the shape
     * the wallet already uses**, in 64 files, rather than a second one invented
     * here.
     *
     * **AND THE OTHER CLOCK.** `testTimeout` above bounds a whole
     * test; it has no effect on a wait INSIDE one, which takes its budget from
     * the testing library's own configuration and defaults to one second.
     * Setting only the first is how a suite on a loaded machine reports
     * failures in code that is fine. `src/test-setup.ts` sets the second, once,
     * centrally, and carries the discipline that goes with it.
     */
    setupFiles: ['./src/test-setup.ts', './packages/identity/src/test-setup.ts'],
    /*
     * **TWO REFUSALS BEFORE ANY TEST RUNS: A COMPILED CONTRACT OLDER THAN ITS
     * SOURCE, AND A CONTRACT LEDGER WITH MORE TOP-LEVEL FIELDS THAN ITS LAYOUT
     * ALLOWS.**
     *
     * `globalSetup` and not `setupFiles`. `setupFiles` above runs once per test
     * file, inside each worker, so a refusal there would be one failure per
     * file. This runs once, in the main process, before any worker evaluates a
     * test module: it cannot be out-ordered by an import, and it covers every
     * `include` glob rather than only the contract tests.
     *
     * `artifact-freshness` refuses when the compiled contract is older than its
     * source. `ledger-limit` refuses a contract whose ledger has passed fifteen
     * top-level fields: sixteen compiles and deploys, but the state nests and
     * every field's path moves, field 0 included, with no error from the
     * compiler. It is here rather than in a test file because it is a property
     * of the built artifact. They are two entries rather than one module that
     * calls both, so each one's test can import its wiring module and call its
     * default export against a fixture, and neither can be disarmed with the
     * other. `scripts/artifact-freshness.test.ts` and
     * `scripts/ledger-limit.test.ts` each import this file as a module and
     * check for their own entry, so a deleted or commented-out entry turns the
     * suite red.
     *
     * No environment variable skips them, and the test runner has no
     * `--globalSetup` option. What does skip them is `--config` with another
     * file, which replaces this one, or renaming this file (the runner then
     * falls back to `vite.config.ts`, which has no `test` block). Every
     * configuration in this repository that runs with a different guard list
     * spreads this one, so the rest of it cannot drift.
     */
    globalSetup: [
      './scripts/artifact-freshness.globalSetup.ts',
      './scripts/ledger-limit.globalSetup.ts',
    ],
    /*
     * **THE SUITE'S OWN REFUSALS DO NOT GO IN THE FILE A PERSON READS AFTER
     * TRYING THE PRODUCT.**
     *
     * The service writes every 400 it answers to
     * `logs/REPORT-REFUSALS.txt`, and the server tests provoke dozens of them
     * on purpose. Mixed together, the first thing somebody opens after trying
     * the product by hand and meeting a refusal would be half fixtures — **which is the confusion the file
     * exists to end, moved rather than fixed.** So the suite writes its own, under a
     * name that says what it is.
     *
     * Here rather than in the production code: a service that asks whether it
     * is being tested is a service whose behaviour under test is not the
     * behaviour it ships. `refusal-log.test.ts` overrides this again with a
     * temporary directory, because a test that greps this report has to grep
     * one it made.
     */
    /*
     * AND THE ORIGIN A SERVER TEST SIGNS AGAINST IS NOT SET HERE.
     *
     * A wallet signature names an origin, so the server refuses a sign-in with
     * 503 unless it knows its own. Every test file that signs in names that
     * origin among its own settings, through `src/testing/server-under-test.ts`,
     * which builds the server's environment from those settings plus the few
     * names node and the test runner need, and from nothing the shell, another
     * module or the working tree's `.env` might hold. The one name below is kept
     * by that helper on purpose: it is the suite's, not the machine's.
     */
    env: {
      REFUSAL_LOG: './logs/REPORT-REFUSALS-FROM-TESTS.txt',
    },
  },
});
