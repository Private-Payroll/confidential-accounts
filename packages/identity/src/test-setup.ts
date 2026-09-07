/**
 * WHAT EVERY WAIT IN THIS SUITE IS ALLOWED TO TAKE.
 *
 * A screen test waits for something to appear. That wait's budget is NOT the
 * one in `vitest.config.ts`: `testTimeout` bounds a whole test, and the wait
 * inside it reads its own default from the testing library's own configuration
 * — `@testing-library/dom/dist/config.js:15`, `asyncUtilTimeout: 1000`, read at
 * `dist/wait-for.js:16`. **They are two different clocks and only one of them
 * was ever set.**
 *
 * So a step that takes 1,500ms on a loaded machine fails while its test still
 * has twenty-nine seconds of budget left, and it fails at about 1,015ms every
 * time — which is the giveaway. There are 240 such waits across this suite and
 * not one of them names a budget of its own.
 *
 * **The cost of leaving it is not the failing test. It is what a randomly red
 * suite teaches**: that red means run it again. A project whose people learn
 * that reflex has no suite at all, because the next failure is real and is
 * dismissed in the same breath.
 *
 * Five seconds is chosen to be longer than any wait this suite legitimately
 * needs on a loaded laptop and still far short of `testTimeout`, so a test that
 * is genuinely stuck still fails as a test rather than hanging.
 */
import { configure } from '@testing-library/dom';
import { afterEach } from 'vitest';

configure({ asyncUtilTimeout: 5000 });

/**
 * EVERY RENDERED TREE IS UNMOUNTED AT THE END OF ITS OWN TEST.
 *
 * Almost every file in this suite calls `cleanup()` in `beforeEach`, which
 * unmounts the PREVIOUS test's tree. That is enough for isolation and it is
 * not enough for teardown: it leaves the LAST test's tree mounted while vitest
 * takes the environment down.
 *
 * **A MOUNTED TREE IS NOT INERT.** Home starts an eleven-slot checkpoint read
 * on mount (`app/shell/wallet-balances.tsx`), so that loop was still awaiting
 * IndexedDB when `localStorage` and the rest of the jsdom globals went — an
 * unhandled rejection with no failing assertion behind it, which the harness
 * reports as a failed run. A suite whose failures do not point at a test is a
 * suite people learn to re-run, and that is what it costs.
 *
 * **HERE RATHER THAN IN ONE FILE**, because the hole is open in every file
 * that renders and does asynchronous work, and one place closes all of them.
 * It is additive: `cleanup()` on an already-clean document does nothing, so a
 * file that keeps its own `beforeEach(cleanup)` is unaffected.
 *
 * Registered FIRST, so it runs LAST — vitest runs `afterEach` hooks in reverse
 * order of registration, and a file's own `afterEach` (restoring real timers,
 * say) must get its turn before the trees come down.
 */
/*
 * **AND IT ASKS WHETHER THERE IS A DOM BEFORE IT TOUCHES ONE.** This file is
 * wired into a suite that runs the wallet's screen tests and a much larger set
 * of node tests beside them, in one runner. `cleanup()` unmounts a React tree
 * and needs a document; in a node test there is none and there is nothing
 * mounted either, so the honest behaviour there is to do nothing rather than to
 * throw in a hook that has no test to blame.
 *
 * The import is dynamic for the same reason and not for tidiness: at module
 * scope `@testing-library/react` would be loaded by every node test file in the
 * suite, to be used by none of them.
 */
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});
