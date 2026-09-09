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
  it('WHAT THE PAGE LOADS TODAY: nothing in its graph is WebAssembly, because the scheme it '
    + 'is handed is the simulated one', { timeout: 180_000 }, async () => {
      const page = await built(join('src', 'web'));
      /*
       * **THIS CASE IS A MEASUREMENT OF THE SELECTION, NOT A PROHIBITION ANY
       * MORE, AND THE DIFFERENCE MATTERS TO WHOEVER SEES IT GO RED.**
       *
       * It used to mean *the page must never carry WebAssembly*. The page CAN
       * carry it now — the build handles it, and the case at the foot of this
       * file is what keeps that true. What this case says is narrower and still
       * worth saying: the page is handed a scheme by one selector, that
       * selector holds the simulated scheme, and therefore no circuit reaches
       * the page. **If it goes red, one of two things happened, and they need
       * opposite responses.** Either a chain wiring was deliberately selected —
       * in which case this case is out of date and is rewritten to say what the
       * page now carries — or something reached the contract's circuits from
       * the page by accident, which is a 10 MB module in everybody's browser
       * that nobody decided to send.
       *
       * **THIS MESSAGE USED TO CARRY A SECOND SENTENCE AND IT HAS BEEN
       * REMOVED, BECAUSE IT NAMED A BLOCKER THAT NO LONGER EXISTS.** It said a
       * chain wiring may not be selected until a stored record says which
       * wiring wrote it. Records now say so, the lists refuse a mixture of
       * them and the selection is refused over records that do not — all of
       * it checked rather than written down here. A warning that stays after
       * the thing it warned about is fixed is a warning that sends the next
       * reader to do work already done.
       */
      expect(page.wasmModules,
        'the payroll page is loading WebAssembly. If a chain wiring was just selected, this '
        + 'case is out of date and is rewritten to say what the page now carries. If no wiring '
        + 'was selected, something reached the contract\'s circuits from the page by accident')
        .toEqual([]);
      expect(page.wasmAssets, 'the payroll build emitted a .wasm file').toEqual([]);
      // A build that produced almost nothing would satisfy both of the above.
      expect(page.moduleCount).toBeGreaterThan(40);
    });

  it('and the standalone build through the same configuration does carry it, so the check '
    + 'above can fail', { timeout: 180_000 }, async () => {
      const standalone = await built(join('src', 'standalone'));
      expect(standalone.wasmModules.length,
        'the positive control found no WebAssembly, so the case above proves nothing')
        .toBeGreaterThan(0);
      /*
       * **TWO, AND THE SECOND ONE ARRIVED THE DAY THIS BUILD COULD RAISE A
       * PAYROLL RUN.**
       *
       * The first is the ledger's, reached through the payroll service because
       * an address handed over by an employee has to be re-parsed against the
       * network. The second is the on-chain runtime's, reached through the
       * payout tree: a run's root is that runtime's own merkle hash, and a
       * standalone build that could not compute it would be a build whose
       * propose door refuses where the served one answers.
       *
       * **THE NUMBER IS EXACT ON PURPOSE.** A `greaterThan` here would let a
       * third arrive unnoticed, and the whole subject of this file is that
       * WebAssembly gets into a module graph without anybody deciding it
       * should. If this number changes again, read what changed before changing
       * the number.
       */
      expect(standalone.wasmAssets).toHaveLength(2);
    });

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
