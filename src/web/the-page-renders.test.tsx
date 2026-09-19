// @vitest-environment jsdom
/**
 * **THE PAGE PUTS SOMETHING ON THE SCREEN.**
 *
 * ── THE INJURY, WHICH IS NOT AN ERROR MESSAGE ────────────────────────────
 *
 * The payroll page was blank in every real browser for four rounds. Not an
 * error page, not a broken layout — **nothing at all: no text, no background,
 * no message.** A module on the page's boot path threw while it was still being
 * evaluated, so React was never reached and there was nothing to draw the error
 * with. From the outside it is indistinguishable from a server that is down.
 *
 * `no-wasm-in-the-page.test.ts` measures what the page's build graph CONTAINS.
 * This file asks the other question, which is the one a person actually has:
 * **does anything appear?**
 *
 * ── THE ENTRY AND THE REAL PAGE, NOT A COMPONENT AND A FIXTURE ───────────
 *
 * `main.tsx` installs the error sink, imports React, imports `App`, imports the
 * stylesheet and reads the selected wiring, in that order. Every one of those
 * is a module that can throw while it is being evaluated, and three of the five
 * — the sink, the stylesheet and the wiring — would be skipped by rendering
 * `App` directly. **The entry is the thing that has actually gone blank**, so
 * the entry is what is loaded.
 *
 * **AND THE DOCUMENT IS THE SHIPPED ONE.** The first case takes the page's body
 * from `index.html` rather than writing a mount point of its own, because a
 * test that supplies the element the page mounts into cannot see that element
 * go missing. **Measured, before this was changed: deleting
 * `<div id="root"></div>` from `index.html` left every case in this file and in
 * `no-wasm-in-the-page.test.ts` green, while the real page would throw at
 * `createRoot` and show nothing.**
 *
 * ── WHAT THIS RUNNER CAN AND CANNOT SEE, MEASURED RATHER THAN ASSUMED ────
 *
 * **IT CANNOT SEE THE FAILURE THAT LEAVES A BROWSER BLANK WHILE NODE IS FINE,
 * AND THAT WAS MEASURED HERE RATHER THAN REASONED ABOUT.** The contract's own
 * commitment scheme was wired into the page's entry and this file stayed green,
 * at the same moment the development server served an empty page to Chromium
 * and threw *Cannot read properties of undefined (reading
 * `__wbindgen_export_2`)*. The runner loads modules through Node, where a
 * WebAssembly binding is a file read; the evaluation ordering that breaks a
 * browser never arises. **The check that opens the application in a real
 * browser and reads back the text it rendered is what covers that**, and
 * `no-wasm-in-the-page.test.ts` carries the standing pin on the build setting
 * that makes the browser case work.
 *
 * **WHAT IT CAN SEE is every other way this page has gone blank**, which is
 * most of them: a module that throws on import in any environment, an entry
 * that mounts nothing, a root that renders an empty shell, a document that no
 * longer carries the element the entry mounts into. Those are the cases that
 * arrive by accident, from an ordinary edit, between browser checks.
 *
 * ── ONE `setTimeout(0)`, AND THE REASON IS MEASURED ──────────────────────
 *
 * **A React root does NOT commit in a microtask, and the sentence that stood
 * here said it did.** Measured in this environment: after `render()` the root
 * holds no children synchronously, none after one microtask, none after two,
 * and one after a `setTimeout(0)`. `MessageChannel` exists here, so React
 * schedules the initial mount as a scheduler TASK. **The wait is therefore a
 * task and not a microtask, and "tightening" it to `await Promise.resolve()`
 * would make every case in this file fail.**
 *
 * It is not a poll, which is the thing `wallet-waiting.test.tsx` argues against
 * and which this repository has twice mistaken for a real defect: it waits one
 * turn, not until something appears, so a page that never mounts fails here
 * instead of timing out.
 */
import { describe, it, expect, afterEach } from 'vitest';
/*
 * THE SHIPPED DOCUMENT, READ AS TEXT, so the mount point this file renders
 * into is the one a browser is served rather than one written here.
 *
 * READ WITH `readFileSync` AND NOT WITH A `?raw` IMPORT, and the reason is not
 * style: the import graph walker resolves a specifier to a file on disk, and
 * nothing on disk answers to `./index.html?raw`. A build-tool idiom in one
 * file therefore shows up as an unresolved specifier in a graph that has
 * nothing to do with this page. The bytes are the same bytes either way.
 */
import { readFileSync } from 'node:fs';
/*
 * Read from the working directory rather than from `import.meta.url`: under the
 * test runner's transform that URL is not always a `file:` one, and `new URL`
 * throws `The URL must be of scheme file` when it is not. Every door in this
 * repository runs from the root, which is what makes the plain path safe here.
 */
const indexHtml = readFileSync('src/web/index.html', 'utf8');

/** What is between `<body>` and `</body>` in the page's own document. */
const pageBody = (): string => {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(indexHtml);
  if (body === null) throw new Error('index.html has no <body>, so there is nothing to render into');
  /*
   * The entry's own `<script type="module">` is dropped: jsdom would not run it
   * and the case imports the entry itself, which is the same modules in the
   * same registry and is observable when it throws.
   */
  return body[1].replace(/<script[\s\S]*?<\/script>/gi, '');
};

const roots: { unmount(): void }[] = [];
afterEach(() => {
  // Roots are unmounted rather than orphaned: `innerHTML = ''` detaches the
  // container and leaves React holding it, listeners and all.
  while (roots.length > 0) roots.pop()!.unmount();
  document.body.innerHTML = '';
});

/** One turn of the event loop, which is what React's scheduler needs. */
const mounted = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the payroll page renders', () => {
  it('THE ONE THAT CATCHES A BLANK PAGE: loading the page entry into the shipped document '
    + 'puts something on the screen', { timeout: 60_000 }, async () => {
      document.body.innerHTML = pageBody();
      const root = document.getElementById('root');
      expect(root,
        'index.html no longer carries the element the page mounts into, so the entry throws '
        + 'at createRoot and a person is shown nothing')
        .not.toBeNull();

      const { pageRoot } = await import('./main.js');
      /* Unmounted after the case like every other root here. The page asks the
       * server about its session once it has mounted, and a root left running
       * does that work inside the NEXT case's one-turn wait. */
      roots.push(pageRoot);
      await mounted();

      expect(root!.childElementCount,
        'the page entry mounted nothing into #root — a module threw while it was loading, '
        + 'which is a page that shows a person nothing at all')
        .toBeGreaterThan(0);
      /*
       * TEXT AND NOT ONLY A NODE. A root holding one empty `<div>` satisfies a
       * child count and is the same blank screen to the person looking at it.
       * The threshold is deliberately low: this case is about the difference
       * between SOMETHING and NOTHING, and each screen has its own test for
       * what it says.
       */
      expect((document.body.textContent ?? '').trim().length,
        'the page rendered no text at all, which is what a module throwing while it loads '
        + 'looks like from the outside')
        .toBeGreaterThan(20);
    });

  it('and the contract\'s own circuits load and run in this environment, in the same module '
    + 'registry as the page — which is what the page needs the day it is handed them',
    { timeout: 60_000 }, async () => {
      /*
       * **WHAT THIS CASE MEASURES, STATED NARROWLY BECAUSE ITS FIRST VERSION
       * CLAIMED MORE THAN IT DID.** It was written as *the page renders when
       * the scheme it is handed is the contract's own* — and measured, it
       * passes just as well when the prop is an object that is not a scheme at
       * all. `App` returns the sign-in screen before it reads `commitments`
       * (`src/web/App.tsx`), and every use of the prop is behind a signed-in user. So
       * the render half proves that mounting `App` with the contract's module
       * loaded does not throw, and NOT that the page works under that scheme.
       *
       * **THE HALF THAT DOES THE WORK IS THE CALL.** The compiled circuits are
       * WebAssembly reached through `@midnight-ntwrk/compact-runtime`, and
       * nothing else in this repository measures that they LOAD AND EXECUTE in
       * the same module registry the page's entry lives in. Whether they return
       * the right value is pinned against the circuit itself in
       * `contracts/test/one-definition.test.ts`; a third copy of that
       * comparison here would be a second definition of a rule, which is the
       * most expensive mistake made in this project.
       *
       * **IMPORTED INSIDE THE CASE, NOT AT THE TOP OF THE FILE.** A top-level
       * import would put the contract's circuits into the case above as well,
       * which measures the page's own boot path — and it would still pass,
       * which is exactly what would make the mistake invisible.
       *
       * **AND THIS IS NOT THE PAGE IMPORTING `src/midnight/`.** What the page
       * may not do is pull the contract's circuits into the graph a browser is
       * served; a test file is not in that graph, and
       * `no-wasm-in-the-page.test.ts` measures it and would go red if it were.
       */
      const { MidnightCommitments } = await import('../midnight/commitments.js');
      const React = (await import('react')).default;
      const { createRoot } = await import('react-dom/client');
      const App = (await import('./App.js')).default;

      document.body.innerHTML = pageBody();
      const root = createRoot(document.getElementById('root')!);
      roots.push(root);
      root.render(React.createElement(App, { commitments: MidnightCommitments }));
      await mounted();

      expect(document.getElementById('root')!.childElementCount,
        'mounting the page\'s own root component threw while the contract\'s circuits were '
        + 'loaded in the same registry')
        .toBeGreaterThan(0);
      /*
       * The width and the encoding, not the value — this is the seat a device
       * computes for itself, and the reason the page has to be able to reach
       * the scheme at all: the signing secret never leaves the device, so the
       * derivation happens where the secret is.
       */
      expect(MidnightCommitments.signerPublicKey('11'.repeat(32)),
        'the contract\'s circuits did not run in this environment')
        .toMatch(/^[0-9a-f]{64}$/);
    });
});
