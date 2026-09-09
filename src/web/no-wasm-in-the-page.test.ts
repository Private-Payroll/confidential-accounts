/**
 * **THE PAYROLL PAGE CARRIES NO WEBASSEMBLY.** `X5` §1 and §2.
 *
 * ── WHAT THIS IS GUARDING, AND WHY IT IS NOT THE OBVIOUS THING ───────────
 *
 * The page was blank in every real browser for four rounds because
 * `@midnightntwrk/ledger-v9`'s wasm-bindgen glue threw while it was still being
 * evaluated — *Cannot access `__wbindgen_start` before initialization*. It was
 * reached from `src/web/wallet-sign-in.ts`, which imported one small function
 * from `wallet-identity.ts` and got the wallet SDK behind it.
 *
 * **THE ROUND EXPECTED A BUILD THAT THROWS AND THERE ISN'T ONE.** `X5` was
 * written believing the defect would show up as a failing build, the way the
 * wallet's own configuration warns it does. It does not, and the reason is the
 * whole trap: **a production build TREE-SHOOK the glue** — nothing in the page
 * used `verify`, so the JavaScript came out byte-for-byte the same size with the
 * wasm module gone — **and emitted the 10 MB `.wasm` file anyway.** The
 * development server does not tree-shake, so it evaluated the glue and died.
 * Measured, both ways round, before this file was written:
 *
 *     page graph, before the split   114 modules, 24 of them ledger-v9, one
 *                                    10,322,794-byte .wasm asset emitted,
 *                                    `__wbindgen` NOT in the JavaScript
 *     page graph, after the split     74 modules, no ledger-v9, no .wasm asset
 *
 * So a check that watched the build's exit status would have passed throughout,
 * and a check that grepped the bundle for `__wbindgen` would have passed
 * throughout too. **The thing that was true and is now false is that the page's
 * MODULE GRAPH contained WebAssembly**, so that is what this asks about.
 *
 * ── IT ASKS THE BUNDLER, BECAUSE READING THE SOURCE GIVES THE WRONG ANSWER ─
 *
 * `X4`'s audit tried a static read first and it named an innocent file:
 * `src/core/types.ts` imports `payee-address` with `import type`, which erases.
 * `moduleParsed` fires for what is actually resolved and loaded, which is the
 * only account of the graph worth having.
 *
 * ── THE SECOND CASE IS A POSITIVE CONTROL AND IT IS NOT DECORATION ───────
 *
 * Without it, "no WebAssembly in the output" would also be true of a build that
 * produced nothing, a pattern that matches nothing, and an `outDir` read from
 * the wrong place. `src/standalone` is a REAL entry point in this repository
 * that reaches the ledger for a real reason — `payeeAddress` — and it is built
 * here through the SAME configuration, so the two cases differ in one thing:
 *
 * **`X11` NOTE: IT REACHES IT TRANSITIVELY NOW, AND THE CONTROL IS UNAFFECTED.**
 * That build used to `import { payeeAddress }` directly, for a door that took a
 * typed address; `X11` §7 closed that door there and the import went with it. It
 * still loads the ledger, through `PayrollService`, which is what `admit` needs
 * in order to rebuild an address from its own string — **so the control's
 * subject is the same code for the same reason, one import further away.**
 * Checked by running this file after the import was removed, rather than by
 * reading the graph.
 *
 * which entry point they start from. **If this case ever goes red because the
 * standalone build stopped importing the ledger, that is not a broken test, it
 * is the news that the control needs a new subject.**
 *
 * ── AND IT BUILDS INTO A TEMPORARY DIRECTORY WITH ITS OWN CACHE ──────────
 *
 * The same reason `sink-not-in-production.test.ts` gives: the build tool clears
 * `node_modules/.vite/deps` when it re-optimises, and a test that did that would
 * corrupt the cache the next real run depends on.
 */
import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * What WebAssembly looks like in a module graph here.
 *
 * The package name AND the extension, because either alone is half an answer:
 * a `.wasm` from somewhere else is still WebAssembly in the page, and
 * `ledger-v9`'s glue is `.js` files that are only meaningful beside the binary.
 */
const WEBASSEMBLY = /@midnightntwrk[/\\]ledger-v9|\.wasm(\?|$)/;

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
  it('THE ONE THAT KEEPS IT OUT OF THE PAGE: nothing the page loads is WebAssembly',
    { timeout: 180_000 }, async () => {
      const page = await built(join('src', 'web'));
      expect(page.wasmModules, 'the payroll page is loading WebAssembly again — C149')
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
       * should. **The case above is what protects the PAGE, and it is
       * untouched: the page talks to a server and holds none of this.** If this
       * number changes again, read what changed before changing the number.
       */
      expect(standalone.wasmAssets).toHaveLength(2);
    });
});
