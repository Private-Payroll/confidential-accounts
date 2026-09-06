import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    ],
    root: '.',
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
    setupFiles: ['./src/test-setup.ts'],
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
     * `MUTATE.command` runs under `vitest.mutation.config.ts`, which is DERIVED
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
     * entry.** `scripts/mutation-config.test.ts` imports both configs as
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
     * layer out. **It is the one entry `vitest.mutation.config.ts` removes, and
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
