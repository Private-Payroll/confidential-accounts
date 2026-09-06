/**
 * **A PRODUCTION BUILD DOES NOT CONTAIN THE SINK.** `X4` §1, rule 1.
 *
 * ── WHY THIS BUILDS THE APP INSTEAD OF READING THE SOURCE ────────────────
 *
 * The claim is not "the sink does not run in production" — that would be a
 * claim about a condition, and a condition can be flipped by a stale `.env`, a
 * name on a command line, or a refactor that hoists it. **The claim is that the
 * code is not in the file**, and the only thing that can answer it is the
 * bundler.
 *
 * So this runs the real `vite.config.ts` twice over the real entry point,
 * changing ONE thing between the two: the mode. Both runs are given
 * `VITE_DEV_ERROR_SINK=1` — the same way `npm run dev` gives it — so the
 * difference in what comes out cannot be the flag. **It is `import.meta.env.DEV`
 * going to `false`, which makes the guard a constant, which lets the bundler
 * drop everything behind it.**
 *
 * The development build is not decoration. Without it, "the marker is not in
 * the bundle" would also be true of a build that failed, a marker that was
 * misspelled, or a grep pointed at the wrong file — three ways to pass while
 * proving nothing.
 *
 * ── AND IT BUILDS INTO A TEMPORARY DIRECTORY WITH ITS OWN CACHE ──────────
 *
 * `cacheDir` is moved out of the repository on purpose. The build tool clears
 * `node_modules/.vite/deps` when it re-optimises, and a test that did that
 * would corrupt the cache the next real run depends on — which has already
 * cost this project two attempts once.
 */
import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * What only the sink puts in a bundle. String literals, not names: a production
 * build renames everything and rewrites nothing inside quotes.
 */
const MARKERS = ['/api/dev/web-console'];

/**
 * **THE REDACTOR SHIPS IN PRODUCTION SINCE `X11` §5, AND THAT IS A DECISION.**
 *
 *
 * These two markers used to be in the list above, because the ONLY thing that
 * reached `redactSecrets` from the page was the sink — so a production build
 * dropped the sink and the redactor went with it. **`X11` §5 changed what is
 * true.** `shown-error.ts` is the one function every screen turns an error into
 * a sentence with, it is ordinary production code, and it redacts.
 *
 * **THE SPLIT IS THE POINT AND THE TEST IS NOT WEAKER FOR IT.** What must not
 * ship is the thing that TALKS TO A DEVELOPMENT ENDPOINT, and that is exactly
 * what `MARKERS` still holds — `/api/dev/web-console` is the sink's own address
 * and nothing else puts it in a bundle. What now ships is a pure function that
 * REMOVES secrets from strings, which is not a leak in any direction; it costs
 * a few hundred bytes.
 *
 * **AND BOTH HALVES ARE ASSERTED**, because *the redactor may be absent* and
 * *the redactor must be present* are different claims and only one of them is
 * true. If a future change puts the redaction back behind the sink's guard, a
 * person in production would be shown a raw key in an error message and nothing
 * would say so — so the presence is pinned rather than merely tolerated.
 */
const REDACTOR_MARKERS = ['<redacted:seed>', '<redacted:seed-phrase>'];

/**
 * Builds the web app and returns which of the markers the bundle contains.
 *
 * **`NODE_ENV` IS SET AND PUT BACK, AND THAT IS NOT HOUSEKEEPING.** The build
 * tool decides whether a build is a production one from `NODE_ENV` FIRST and
 * the mode only second — and the runner sets `NODE_ENV=test`, so a build asked
 * for in production mode inside a test is a DEVELOPMENT build and ships the
 * sink. This case failed exactly that way when it was written, which is the
 * best argument there is for building the thing rather than reading the source.
 *
 * It returns the markers found rather than the bundle, because a failure that
 * prints ten megabytes of application is a failure nobody reads.
 */
const markersIn = async (
  mode: 'production' | 'development',
  looking: readonly string[] = MARKERS,
): Promise<string[]> => {
  const out = mkdtempSync(join(tmpdir(), `mn-build-${mode}-`));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mn-vite-cache-'));
  const wasEnv = process.env.NODE_ENV;
  const wasFlag = process.env.VITE_DEV_ERROR_SINK;

  try {
    // Supplied the way the dev script supplies it, so the flag is never the
    // difference between the two builds. The mode is.
    process.env.VITE_DEV_ERROR_SINK = '1';
    process.env.NODE_ENV = mode;

    await build({
      configFile: join(REPO, 'vite.config.ts'),
      root: join(REPO, 'src', 'web'),
      mode,
      cacheDir,
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
    });
  } finally {
    process.env.NODE_ENV = wasEnv;
    if (wasFlag === undefined) delete process.env.VITE_DEV_ERROR_SINK;
    else process.env.VITE_DEV_ERROR_SINK = wasFlag;
  }

  const assets = join(out, 'assets');
  const bundle = readdirSync(assets)
    .filter(name => name.endsWith('.js') || name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8'))
    .join('\n');
  return looking.filter(marker => bundle.includes(marker));
};

describe('the browser error sink and the production build', () => {
  it('THE ONE THAT SAYS IT SHIPS NOTHING: a production bundle contains none of it',
    { timeout: 180_000 }, async () => {
      expect(await markersIn('production'), 'a production bundle still carries the sink')
        .toEqual([]);
    });

  it('AND THE REDACTOR DOES SHIP, BECAUSE A SHOWN ERROR IS REDACTED — X11 §5',
    { timeout: 180_000 }, async () => {
      /*
       * The other half of the split above. `shown-error.ts` is production code
       * and it redacts what a person is shown, so a production bundle that had
       * dropped the redactor would be a bundle showing raw keys in error
       * messages — silently, and only to real users.
       */
      expect(
        await markersIn('production', REDACTOR_MARKERS),
        'a shown error is no longer redacted in a production build')
        .toEqual(REDACTOR_MARKERS);
    });

  it('and the same build in development does contain it, so the check above can fail',
    { timeout: 180_000 }, async () => {
      expect(await markersIn('development'), 'a development bundle is missing the sink')
        .toEqual(MARKERS);
    });
});
