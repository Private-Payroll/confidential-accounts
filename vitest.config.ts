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
     * **BOTH EXTENSIONS, AND THAT IS `X10` §3 RATHER THAN TIDINESS.** `C67` in
     * the wallet: this glob read `.ts` only there too, which silently excluded
     * every screen — a `.test.tsx` would not have been COLLECTED had somebody
     * written one, so eleven single-line changes to the shell left the suite
     * green. The typechecker reads a screen; it does not run it. **Narrowing
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
     * **AND THE OTHER CLOCK** — `C134`. `testTimeout` above bounds a whole
     * test; it has no effect on a wait INSIDE one, which takes its budget from
     * the testing library's own configuration and defaults to one second.
     * Setting only the first is how a suite on a loaded machine reports
     * failures in code that is fine. `src/test-setup.ts` sets the second, once,
     * centrally, and carries the discipline that goes with it.
     */
    setupFiles: ['./src/test-setup.ts', './packages/identity/src/test-setup.ts'],
    /*
     * **THE SUITE REFUSES TO RUN AGAINST AN ARTIFACT OLDER THAN ITS SOURCE.**
     *
     *
     * `globalSetup` and not `setupFiles`, and the difference is the whole
     * point. `setupFiles` above runs once per test FILE, inside each worker —
     * so a refusal there is ninety-nine file-level failures in a wall of
     * output, which is a warning wearing a refusal's clothes. This runs ONCE,
     * in the main process, before any worker evaluates any test module. It
     * cannot be out-ordered by an import, and it covers all three `include`
     * globs rather than `contracts/test/**`.
     *
     * **IT CARRIES NO ESCAPE HATCH, AND THAT IS DELIBERATE.** No environment
     * variable, no flag; `vitest` publishes no `--globalSetup` option.
     *
     * **AN EARLIER VERSION OF THIS COMMENT SAID THERE WAS NO WAY PAST IT AT
     * ALL. That was false and an auditor demonstrated it**, which is why the
     * true list is written here instead: `vitest --config <other>` replaces
     * this whole file and cannot be closed from inside it, and renaming this
     * file makes vitest fall back to `vite.config.ts`, which has no `test`
     * block.
     *
     * **AND THE FIRST OF THOSE IS NOW TAKEN, WHICH IS WHY THE SENTENCE THAT
     * STOOD HERE IS GONE.** It read *what keeps it shut is that neither door
     * passes that flag*, and `S39` made it false. `T-171`, ruled 2 Sep:
     * `MUTATE.command` runs under a mutation configuration, which is DERIVED
     * from this file and removes exactly one `globalSetup` entry below — the
     * doc gate, and only the doc gate. The harness breaks a contract on
     * purpose, so for the length of a run the artifact is a deliberate
     * temporary lie; since `T-167` made that gate a render-and-compare against
     * the COMPILED artifact, the first mutation to change an `assert` throws in
     * `globalSetup`, no worker evaluates a test module, and the harness aborts
     * having scored nothing.
     *
     * **THAT IS A PREDICTION AND IS WRITTEN AS ONE — rule 9.** The harness and
     * this gate have never run together: `REPORT-MUTATE.txt:1` is 31 Aug and
     * `scripts/doc-freshness.globalSetup.ts` was written 2 Sep, so there is no
     * run to have watched, and rule 1 forbids a session the door that would
     * settle it. `MUTATE.command` is that door.
     *
     * **WHAT IS STILL TRUE, AND IT IS NARROWER RATHER THAN WEAKER: only the
     * mutation door passes that flag, it DERIVES the config it weakens rather
     * than maintaining a second one, and the difference is pinned at that one
     * entry.** A test held outside the published set imports both configs as
     * MODULES, compares every other key deeply, and asserts that nothing else
     * in this repository passes `--config` to vitest at all — not a `.command`,
     * not `package.json`, not a script — and that no second `vitest.*.config.ts`
     * exists. The two entries this file wires for the artifact and for the
     * ledger are wired there too.
     *
     * **THAT TEST HAS RUN, SO "PINS" IS THE WORD — AND THE SENTENCE THAT STOOD
     * HERE IS THE VERY THING THE NEXT PARAGRAPH WARNS ABOUT.** It read *no vitest
     * invocation can start here today*, on the ground that the contract source
     * was newer than the compiled artifact. **MEASURED BY `S67`, 5 Sep: the
     * artifact is 3,074 SECONDS NEWER than the source, and this file's own test
     * ran green here — 28 assertions.** `SC19` measured it first. `T-338`(c).
     * **A guard whose written reason no longer matches its behaviour is the
     * next round's false confidence** — `C286`'s shape, which this repository
     * has paid for more than once.
     * **What IS closed is this key**: `scripts/artifact-freshness.test.ts`
     * imports this file as a MODULE and reads the value, and calls that
     * module's own default export against a stale fixture, so a deleted key, a
     * commented-out key and a swallowed throw are each a red suite rather than
     * a silent hole.
     */
    /*
     * **AND TWO MORE GUARDS, EACH WIRED SEPARATELY.**
     *
     * `doc-freshness` refuses when a generated block in `docs/design/` no
     * longer describes the contracts it was generated from, or when somebody
     * has typed inside one. It names `DOCS.command` and never regenerates: the
     * generator reads the COMPILED artifact, and a harness that regenerated for
     * itself would emit a document that is confidently wrong from whatever
     * artifact happened to be on disk. Same reasoning as the entry above, one
     * layer out. **It is the one entry the mutation configuration removes, and
     * the block above says under what ruling and what pins it.**
     *
     * `ledger-limit` refuses a contract whose ledger has passed fifteen
     * top-level fields. Sixteen COMPILES and DEPLOYS, the state nests,
     * and EVERY field's path moves — field 0 included — with no error anywhere
     * in the compiler. It is here rather than in a test file because it is a
     * property of the built artifact, and because a guard nobody wired in is
     * invisible to a unit test of the guard.
     *
     * THREE ENTRIES RATHER THAN ONE MODULE CALLING THREE THINGS, so that each
     * one's own test can import its wiring module and call its default export
     * against a fixture. A single wrapper would give the three of them one
     * shared failure and one shared way to be disarmed.
     */
    globalSetup: [
      './scripts/artifact-freshness.globalSetup.ts',
      './scripts/doc-freshness.globalSetup.ts',
      './scripts/ledger-limit.globalSetup.ts',
    ],
    /*
     * **THE SUITE'S OWN REFUSALS DO NOT GO IN THE FILE A WALK READS.**
     *
     * `X10` made the service write every 400 it answers to
     * `logs/REPORT-REFUSALS.txt`, and the server tests provoke dozens of them
     * on purpose. Mixed together, the first thing somebody opens after a walk
     * went wrong would be half fixtures — **which is the fault this row is
     * about, moved rather than fixed.** So the suite writes its own, under a
     * name that says what it is.
     *
     * Here rather than in the production code: a service that asks whether it
     * is being tested is a service whose behaviour under test is not the
     * behaviour it ships. `refusal-log.test.ts` overrides this again with a
     * temporary directory, because a test that greps this report has to grep
     * one it made.
     */
    env: { REFUSAL_LOG: './logs/REPORT-REFUSALS-FROM-TESTS.txt' },
  },
});
