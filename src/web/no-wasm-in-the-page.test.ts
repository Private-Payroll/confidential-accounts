/**
 * **WHAT THE PAYROLL PAGE LOADS, AND WHETHER IT COULD LOAD THE CONTRACT'S OWN
 * CIRCUITS IF IT WERE ASKED TO.**
 *
 * ── WHAT THIS IS GUARDING, AND WHY IT IS NOT THE OBVIOUS THING ───────────
 *
 * The page was blank in every real browser for four rounds because
 * `@midnightntwrk/ledger-v9`'s wasm-bindgen glue threw while it was still being
 * evaluated — *Cannot access `__wbindgen_start` before initialization*. It was
 * reached from `src/web/wallet-sign-in.ts`, which imported one small function
 * from `wallet-identity.ts` and got the wallet SDK behind it. **Nothing
 * rendered: no text, no background, no error on the screen**, because the
 * failure happened before React was reached. **THAT is the injury this file and
 * `the-page-renders.test.tsx` exist for**, and the absence of WebAssembly was
 * only ever one way of arriving at it.
 *
 * ── NEITHER A BUILD NOR A SEARCH OF THE OUTPUT IS EVIDENCE HERE ──────────
 *
 * Measured twice, in opposite directions:
 *
 *     page graph, before the split   114 modules, 24 of them ledger-v9, one
 *                                    10,322,794-byte .wasm asset emitted,
 *                                    `__wbindgen` NOT in the JavaScript
 *     page graph, after the split     74 modules, no ledger-v9, no .wasm asset
 *
 * A production build TREE-SHOOK the glue — nothing in the page used `verify`,
 * so the JavaScript came out byte-for-byte the same size with the WebAssembly
 * module gone — and emitted the 10 MB `.wasm` file anyway. **So a check on the
 * build's exit status passed throughout, and so did a search of the output for
 * `__wbindgen`.**
 *
 * And measured again the day the build was taught to handle WebAssembly, with
 * the contract's own scheme in the page's graph: **`vite build` SUCCEEDS
 * without that handling, and the BUILT page renders correctly — while the
 * development server on the same source renders nothing at all.** The build is
 * the weaker evaluator of the two, in both directions.
 *
 * **SO THE EVIDENCE THAT SETTLES IT IS THE PAGE OPENED IN A REAL BROWSER WITH
 * THE TEXT IT RENDERED READ BACK.** The check that drives a browser at the
 * running application and reports every console message, every uncaught error,
 * every failed request and the rendered text is where that evidence lives, and
 * a person runs it. **Nothing in this file is a substitute for it.**
 *
 * ── IT ASKS THE BUNDLER, BECAUSE READING THE SOURCE GIVES THE WRONG ANSWER ─
 *
 * A static read of the source names an innocent file: `src/core/types.ts`
 * imports `payee-address` with `import type`, which erases. `moduleParsed`
 * fires for what is actually resolved and loaded, which is the only account of
 * the graph worth having.
 *
 * ── THE POSITIVE CONTROL IS NOT DECORATION ───────────────────────────────
 *
 * Without it, "no WebAssembly in the output" would also be true of a build that
 * produced nothing, a pattern that matches nothing, and an `outDir` read from
 * the wrong place. `src/standalone` is a REAL entry point in this repository
 * that reaches the ledger for a real reason, and it is built here through the
 * SAME configuration, so the two cases differ in one thing: which entry point
 * they start from. **If that case ever goes red because the standalone build
 * stopped importing the ledger, that is not a broken test, it is the news that
 * the control needs a new subject.**
 *
 * ── AND IT BUILDS INTO A TEMPORARY DIRECTORY WITH ITS OWN CACHE ──────────
 *
 * The same reason `sink-not-in-production.test.ts` gives: the build tool clears
 * `node_modules/.vite/deps` when it re-optimises, and a test that did that would
 * corrupt the cache the next real run depends on.
 */
import { describe, it, expect } from 'vitest';
import { build, resolveConfig } from 'vite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * What WebAssembly looks like in a module graph here.
 *
 * The extension AND the packages, because either alone is half an answer: a
 * `.wasm` from somewhere else is still WebAssembly in the page, and a
 * wasm-bindgen package's glue is `.js` files that are only meaningful beside
 * the binary.
 *
 * **THE TWO HALVES DO NOT BOTH FIRE ON BOTH ROUTES, WHICH THE EARLIER WORDING
 * HERE CLAIMED.** Measured: on the WALLET-SDK route the package half matches 23
 * glue modules the extension half never sees. On the CONTRACT route — the page
 * reaching its own circuits — the package half matched NOTHING until
 * `onchain-runtime-v4` was named here, because that route goes
 * `src/midnight/commitments.ts` -> the compiled contract ->
 * `@midnight-ntwrk/compact-runtime` -> `@midnightntwrk/onchain-runtime-v4`,
 * and only the last of those is wasm-bindgen. **Note the scopes are spelled
 * differently and that is not a typo here:** the two runtime packages have no
 * hyphen, `compact-runtime` does. `compact-runtime` is deliberately absent — it
 * is ordinary JavaScript that REACHES WebAssembly, and naming it would report
 * WebAssembly where there is none.
 */
const WEBASSEMBLY =
  /@midnightntwrk[/\\](?:ledger-v9|onchain-runtime-v4)|\.wasm(\?|$)/;

interface Built {
  readonly wasmModules: readonly string[];
  readonly wasmAssets: readonly string[];
  readonly moduleCount: number;
}

/**
 * Builds one entry point through the real `vite.config.ts` and reports what
 * WebAssembly went into it.
 *
 * `NODE_ENV` is set and put back for the reason the sibling file documents at
 * length: the build tool reads it FIRST and the runner sets it to `test`, so a
 * production-mode build asked for inside a test is otherwise a development one.
 */
const built = async (root: string): Promise<Built> => {
  const out = mkdtempSync(join(tmpdir(), 'mn-wasm-out-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mn-wasm-cache-'));
  const wasEnv = process.env.NODE_ENV;
  const modules = new Set<string>();

  try {
    process.env.NODE_ENV = 'production';
    await build({
      configFile: join(REPO, 'vite.config.ts'),
      root: join(REPO, root),
      mode: 'production',
      cacheDir,
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
      plugins: [{
        name: 'record-the-graph',
        moduleParsed(info: { id: string }) { modules.add(info.id); },
      }],
    });
  } finally {
    process.env.NODE_ENV = wasEnv;
  }

  const assets = join(out, 'assets');
  return {
    // Names only. A failure that prints ten megabytes of application is a
    // failure nobody reads.
    wasmModules: [...modules]
      .filter(id => WEBASSEMBLY.test(id))
      .map(id => id.replace(REPO, '').replace(/^.*node_modules[/\\]/, '')),
    wasmAssets: readdirSync(assets).filter(name => name.endsWith('.wasm')),
    moduleCount: modules.size,
  };
};

describe('WebAssembly and the payroll page', () => {
  /**
   * **THIS CASE USED TO SAY THE PAGE CARRIES NO WEBASSEMBLY. THE PRODUCT
   * SELECTS THE CHAIN, SO IT DOES, AND THE CASE SAYS WHAT INSTEAD.**
   *
   * Its own message predicted this moment: *if a chain wiring was just
   * selected, this case is out of date and is rewritten to say what the page
   * now carries.* That is what happened, and rewriting it rather than deleting
   * it is the point - **the injury underneath was never *WebAssembly is
   * present*.** It was a blank page: `@midnightntwrk/ledger-v9`'s wasm-bindgen
   * glue threw while it was still being evaluated, reached from the WALLET SDK,
   * and nothing rendered - no text, no background, no error.
   *
   * ── SO THE GUARD IS NOW ABOUT WHICH ROUTE, NOT WHETHER ───────────────────
   *
   * There are two ways WebAssembly reaches this page and they are not the same
   * risk:
   *
   *     THE CONTRACT ROUTE   src/wiring/selection.ts -> src/midnight/commitments.ts
   *                          -> the compiled contract -> @midnight-ntwrk/compact-runtime
   *                          -> @midnightntwrk/onchain-runtime-v4
   *
   *     THE WALLET ROUTE     any import that reaches the wallet SDK
   *                          -> @midnightntwrk/ledger-v9
   *
   * **THE CONTRACT ROUTE IS DELIBERATE AND IS WHAT A DEVICE DERIVES ITS OWN
   * SEAT WITH.** A signing secret never leaves the device, the leaf built from
   * it must be the one the contract computes, and that derivation IS the
   * contract's circuit. There is no third option that does not restate the
   * contract's hash in TypeScript, which is the most expensive mistake
   * available here.
   *
   * **THE WALLET ROUTE IS THE ONE THAT BROKE THE PAGE FOR FOUR ROUNDS** and
   * nothing in the page needs it. It stays banned, by name.
   *
   * ── THE COUNT IS EXACT ON PURPOSE ────────────────────────────────────────
   *
   * A `greaterThan` would let a fifth module arrive unnoticed, and the whole
   * subject of this file is that WebAssembly gets into a module graph without
   * anybody deciding it should. **If this number changes, read what changed
   * before changing the number.**
   */
  it('WHAT THE PAGE LOADS TODAY: the contract\'s own runtime, and nothing from the wallet '
    + 'SDK', { timeout: 180_000 }, async () => {
      const page = await built(join('src', 'web'));

      expect(page.wasmModules.slice().sort(),
        'the payroll page\'s WebAssembly is not the four modules of the contract runtime it '
        + 'is supposed to carry. Read what arrived before changing this list')
        .toEqual([
          '@midnightntwrk/onchain-runtime-v4/midnight_onchain_runtime_wasm.js',
          '@midnightntwrk/onchain-runtime-v4/midnight_onchain_runtime_wasm_bg.js',
          '@midnightntwrk/onchain-runtime-v4/midnight_onchain_runtime_wasm_bg.wasm',
          '@midnightntwrk/onchain-runtime-v4/midnight_onchain_runtime_wasm_bg.wasm?url',
        ]);

      /*
       * **THE BAN THAT SURVIVES, AND IT IS THE ORIGINAL INJURY.** `ledger-v9`
       * is the wallet SDK's, it is what threw during evaluation, and nothing
       * the page does needs it. Asserted separately from the list above so that
       * whoever meets it is told which of the two routes opened.
       */
      expect(page.wasmModules.filter(id => id.includes('ledger-v9')),
        'the page has reached the WALLET SDK. That is the import that left this page blank '
        + 'in every real browser for four rounds - it throws while it is still being '
        + 'evaluated, so nothing renders and no error is shown')
        .toEqual([]);

      // A build that produced almost nothing would satisfy everything above.
      expect(page.moduleCount).toBeGreaterThan(40);
    });

  /**
   * **THE POSITIVE CONTROL FOR THE CASE ABOVE MOVED OUT OF THIS FILE, AND WHY
   * THAT IS NOT A WEAKENING.**
   *
   * It built `src/standalone` through this same configuration and asserted that
   * WebAssembly turned up - so that *the page carries none* could be shown to
   * be a claim that could fail. **The case above no longer says *none*.** It
   * names the four modules exactly, so it fails on its own if that list moves
   * in either direction, and `moduleCount` catches a build that produced
   * nothing.
   *
   * The measurement itself is kept, unchanged, in the test that travels with
   * the browser-only build rather than with this set. **It moved because that
   * build is no longer part of what this project publishes**, and a
   * shipped test that builds an entry point a clone does not have is red in
   * that clone before a single assertion runs - which is the failure this
   * repository has already paid for once.
   */

  it('THE ONE THAT KEEPS THE PAGE LOADABLE: the build handles WebAssembly at a target that '
    + 'can carry it, so the day the page is handed the contract\'s own scheme it is not a '
    + 'blank screen', { timeout: 60_000 }, async () => {
      /*
       * **WHY A CONFIGURATION AND NOT A RENDER.** The injury this guards is a
       * page that renders nothing under the DEVELOPMENT SERVER while the
       * production build of the same source is fine — so neither the build
       * cases above nor anything this runner can execute reaches it. The runner
       * loads modules through Node, where the WebAssembly binding is a file
       * read and the evaluation ordering that breaks a browser never arises.
       * **The page rendering under the contract\'s scheme was measured in a real
       * browser, and the check that drives a browser at the running application
       * is what repeats that measurement.**
       *
       * **SO THIS IS A PIN AND IT SAYS SO.** It is here because deleting one
       * line from the build configuration is a change nothing else in this
       * runner would notice, and the injury it causes is a blank screen with no
       * error on it.
       *
       * **NO INLINE `root`, AND THAT IS THE CORRECTION RATHER THAN A DETAIL.**
       * The first version of this case passed a root of its own, which meant it
       * resolved a configuration the build tool never resolves and could not
       * see `root` at all — measured: pointing `vite.config.ts` at a directory
       * that does not exist left this case green. What is read here is what the
       * configuration says on its own.
       */
      const resolved = await resolveConfig({ configFile: join(REPO, 'vite.config.ts') }, 'serve');

      expect(resolved.plugins.map(plugin => plugin.name),
        'the page build no longer handles WebAssembly, so a page that reaches the contract\'s '
        + 'circuits will serve a blank screen with nothing on it and no error')
        .toContain('vite-plugin-wasm');

      expect(resolved.root.replace(/\\/g, '/'),
        'the page build no longer points at the page')
        .toMatch(/\/src\/web$/);

      /*
       * **THE PLUGIN IS NECESSARY AND NOT SUFFICIENT, AND THIS IS THE OTHER
       * HALF.** The glue it generates instantiates the module with a top-level
       * `await`, so every browser the build targets has to support one. The
       * targets below were measured to carry it; a narrower target is a page
       * that goes blank again with the plugin still in the list above, which is
       * why the two are asserted together rather than separately.
       *
       * If this goes red because the target was deliberately widened, the
       * answer is not to change this line: it is to add the plugin that
       * rewrites top-level await for older targets, and to re-measure the page
       * in a browser before believing either.
       */
      expect(resolved.build.target,
        'the page build targets a browser that cannot carry the top-level await the '
        + 'WebAssembly glue is generated with')
        .toEqual(['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']);
    });
});
