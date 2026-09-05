/**
 * WHAT EVERY WAIT IN THIS SUITE IS ALLOWED TO TAKE. `C134`.
 *
 * **COPIED FROM `Identity/src/test-setup.ts`, WITH ITS REASONING, WHEN `X10`
 * GAVE THIS REPOSITORY A SCREEN ENVIRONMENT AT ALL.** The lesson below cost the
 * wallet two false alarms and a probe to close; payroll starts with it rather
 * than learning it again in six weeks.
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
 * time — which is the giveaway. **The cost of leaving it is not the failing
 * test. It is what a randomly red suite teaches**: that red means run it again.
 * A project whose people learn that reflex has no suite at all, because the
 * next failure is real and is dismissed in the same breath.
 *
 * Five seconds is chosen to be longer than any wait this suite legitimately
 * needs on a loaded laptop and still far short of `testTimeout`, so a test that
 * is genuinely stuck still fails as a test rather than hanging.
 *
 * ── AND THE DISCIPLINE THAT COMES WITH IT, WHICH IS THE HALF THAT MATTERS ──
 *
 * **THIS NUMBER IS A FLOOR UNDER A MISTAKE, NOT A LICENCE TO POLL.** `X9`, and
 * `C134`'s own closing note: *a race is proved by reproducing it, never by
 * waiting for it.* The wallet still carries **fifty-six `waitFor` and `findBy*`
 * calls in two files**, every one able to lose a race, and every one of them
 * now has to be unpicked. **Payroll starts without them.** Await the thing —
 * the promise, the event, the settled call — and if there is nothing to await,
 * that is the defect rather than the reason to poll.
 *
 * ── WHY IT LOADS FOR EVERY TEST AND NOT ONLY THE SCREEN ONES ──────────────
 *
 * `vitest.config.ts` names it once, centrally, for the same reason the wallet
 * does: a setup file listed per-project is a setup file a new test file forgets
 * to ask for. `configure` touches no DOM, so the node tests — which are almost
 * all of them here — load it and are unaffected. The environment is chosen per
 * file with `// @vitest-environment jsdom`, so a screen test says so on its
 * first line and nothing else pays for jsdom.
 */
import { configure } from '@testing-library/dom';

configure({ asyncUtilTimeout: 5000 });
