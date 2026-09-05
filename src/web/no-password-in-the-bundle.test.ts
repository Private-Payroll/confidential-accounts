/**
 * **A BUILT APP CONTAINS NO PASSWORD FIELD AND NO STRETCHING.** `PI4b`,
 * `C129`.
 *
 * ── WHY THIS BUILDS THE APP INSTEAD OF READING THE SOURCE ────────────────
 *
 * `sink-not-in-production.test.ts`'s shape, and its argument applies here word
 * for word: **reading the source is a different claim.** A grep over
 * `src/web/*` says the text is not in one tree; it says nothing about a
 * dependency that still pulls argon2 in, a component still imported by
 * something else, or a field behind a flag that a build would keep. **The claim
 * is that the code is not in the file the browser downloads**, and the only
 * thing that can answer it is the bundler.
 *
 * ── AND IT ASSERTS A PRESENCE, WHICH IS WHAT MAKES THE ABSENCE MEAN ANYTHING ──
 *
 * *The marker is not in the bundle* is also true of a build that failed, a
 * marker that was misspelled, and a grep pointed at the wrong directory —
 * three ways to pass while proving nothing. So the same build is searched for
 * the WALLET's markers, which must all be present. If the sign-in path itself
 * ever dropped out of the bundle, this file would say so instead of quietly
 * congratulating itself.
 *
 * ── AND IT BUILDS INTO A TEMPORARY DIRECTORY WITH ITS OWN CACHE ──────────
 *
 * `cacheDir` is moved out of the repository on purpose. The build tool clears
 * `node_modules/.vite/deps` when it re-optimises, and a test that did that
 * would corrupt the cache the next real run depends on — which has already cost
 * this project two attempts once.
 */
import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * **WHAT ONLY THE PASSWORD PUT IN A BUNDLE.** String literals, every one of
 * them, and not names: a production build renames everything and rewrites
 * nothing inside quotes, so a marker that is an identifier proves nothing.
 *
 * Each is chosen to have exactly one source, and each is named:
 *
 *   · `/api/auth/register` and `/api/auth/login` — the two addresses
 *     `keyring.register` and `keyring.signIn` posted to. **Nothing else in this
 *     application knows these strings.**
 *   · `At least 10 characters` — the placeholder on the password input. It is
 *     the FIELD rather than the key material: a form could come back with the
 *     stretching still deleted, and that is still a password field.
 *   · ` (memory) must be at least 8*p bytes` — argon2's own parameter check,
 *     from `@noble/hashes/argon2`. **This is the stretching**, and it is the
 *     module's text rather than ours, so it survives a rename of everything we
 *     wrote and is present if and only if that module is in the graph.
 *
 * **THE WORD "PASSWORD" IS DELIBERATELY NOT A MARKER.** `AccountPicker` tells a
 * person their company's key is made by their wallet *"not from a password"*,
 * which is prose about an absence, and a test that forbade the word would forbid
 * explaining the change to the person it was made for.
 *
 * **AND ONE MARKER WAS DROPPED BEFORE THIS FILE WAS FINISHED, WATCHED FAILING.**
 * The first draft listed `midnight-accounts:` — the domain `deriveAuthMaterial`
 * prefixed an email with before hashing it into the argon2id salt — and it
 * **failed against a correct build, in both modes.** That prefix is this
 * project's general domain-separator: `ledger.ts` builds
 * `midnight-accounts:add-signer:` and four others with it, and
 * `sealed-records.ts` builds `midnight-accounts:fingerprint:`. The literal in
 * the source was the prefix and the unique part was concatenated at runtime, so
 * there was never a marker there to find. **A test that fires on correct code
 * is worse than one that always fails**, because the failure gets waved through
 * as flakiness — `M-101`, and this is the same lesson from the other side. The
 * stretching is covered by argon2's own text, which has exactly one source.
 */
const PASSWORD_MARKERS = [
  '/api/auth/register',
  '/api/auth/login',
  'At least 10 characters',
  ' (memory) must be at least 8*p bytes',
];

/**
 * **AND WHAT THE WALLET PATH PUTS THERE, WHICH MUST ALL BE PRESENT.**
 *
 * The other half of the split. These are the two addresses the sign-in posts
 * to and the sentence the button sits under — enough that a build which had
 * lost the sign-in screen could not pass the check above by accident.
 */
const WALLET_MARKERS = [
  '/api/auth/wallet/challenge',
  '/api/auth/wallet',
  'Sign in with your wallet',
];

/**
 * Builds the web app and returns which of the markers the bundle contains.
 *
 * **`NODE_ENV` IS SET AND PUT BACK, AND THAT IS NOT HOUSEKEEPING.** The build
 * tool decides whether a build is a production one from `NODE_ENV` FIRST and
 * the mode only second — and the runner sets `NODE_ENV=test`, so a build asked
 * for in production mode inside a test is a DEVELOPMENT build.
 *
 * It returns the markers found rather than the bundle, because a failure that
 * prints ten megabytes of application is a failure nobody reads.
 */
const markersIn = async (
  mode: 'production' | 'development',
  looking: readonly string[],
): Promise<string[]> => {
  const out = mkdtempSync(join(tmpdir(), `mn-pw-${mode}-`));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mn-pw-cache-'));
  const wasEnv = process.env.NODE_ENV;

  try {
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
  }

  const assets = join(out, 'assets');
  const bundle = readdirSync(assets)
    .filter(name => name.endsWith('.js') || name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8'))
    .join('\n');
  return looking.filter(marker => bundle.includes(marker));
};

describe('the password and the built application', () => {
  it('THE ONE THAT SAYS IT SHIPS NOTHING: a production bundle carries no password field, '
    + 'no route that took one, and no stretching',
  { timeout: 300_000 }, async () => {
    expect(
      await markersIn('production', PASSWORD_MARKERS),
      'a production bundle still carries part of the password path')
      .toEqual([]);
  });

  it('AND THE SAME BUILD DOES CARRY THE WALLET, so the check above can fail',
    { timeout: 300_000 }, async () => {
      /*
       * Without this, an empty result above would also be produced by a build
       * that emitted nothing, a wrong output directory, or five misspelled
       * markers. This is the control.
       */
      expect(
        await markersIn('production', WALLET_MARKERS),
        'the wallet sign-in is missing from the bundle — the absence above proves nothing')
        .toEqual(WALLET_MARKERS);
    });

  it('and a DEVELOPMENT build carries no password path either — this was not a mode flag',
    { timeout: 300_000 }, async () => {
      /*
       * **THE DIFFERENCE FROM `sink-not-in-production.test.ts`, AND IT IS THE
       * WHOLE POINT OF THIS ROUND.** That file asserts the sink is absent in
       * production and PRESENT in development, because it is guarded rather
       * than deleted. **A password is not a thing to be absent in production.**
       * If a development build still had one, this would have been a round that
       * hid a door instead of removing it.
       */
      expect(
        await markersIn('development', PASSWORD_MARKERS),
        'a development build still has a password path — it was hidden, not deleted')
        .toEqual([]);
    });
});
