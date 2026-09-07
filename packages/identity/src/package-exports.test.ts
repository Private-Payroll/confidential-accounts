import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE `exports` MAP IS THIS PACKAGE'S ONLY PUBLIC CONTRACT, AND NOTHING PINNED
 * IT UNTIL THIS FILE — which is how the defect survived: the map pointed every
 * one of its fifteen entry points at a `.ts` file, so a consumer on a plain
 * Node loader could not import the package AT ALL, and every test here stayed
 * green because `vitest` transpiles TypeScript and never asks the question.
 *
 * WHAT THIS FILE CHECKS AND WHAT IT DELIBERATELY DOES NOT.
 * It checks the STATIC half only: that the map names emitted JavaScript and
 * declarations rather than TypeScript, and that every subpath the package
 * promises is actually declared. **It does not import anything**, because the
 * emitted `lib/` is a build artefact that is not committed — a test that
 * imported it would go red on every clean checkout until somebody ran
 * `npm run build`, which is a test that teaches people to ignore it.
 *
 * THE OTHER HALF HAS ITS OWN DOOR: `npm run check:consumer` builds a consumer
 * OUTSIDE this folder and imports all fifteen specifiers for real. That one
 * needs the build, so it is a door a person runs and not a test.
 *
 * THE PAIR IS THE POINT: this file catches the map ROTTING BACK, which is the
 * cheap and likely failure; the door catches the map being WRONG, which needs
 * the artefact to exist.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string | Record<string, string>>;
  files: string[];
  sideEffects: string[];
};

const targetsOf = (target: string | Record<string, string>): string[] =>
  typeof target === 'string' ? [target] : Object.values(target);

const allTargets = Object.entries(pkg.exports).flatMap(([subpath, target]) =>
  targetsOf(target).map((t) => ({ subpath, target: t })),
);

describe('the exports map', () => {
  it('declares at least one entry point', () => {
    expect(Object.keys(pkg.exports).length).toBeGreaterThan(0);
  });

  /*
   * THE ONE THAT MATTERS. A `.ts` target is the defect exactly: it loads here and
   * fails for everybody who is not us. `.d.ts` is not a `.ts` target for this
   * purpose — it is the declaration a consumer's typechecker reads and is never
   * executed.
   */
  it('never points at raw TypeScript', () => {
    const raw = allTargets.filter(
      ({ target }) => target.endsWith('.ts') && !target.endsWith('.d.ts'),
    );
    expect(raw).toEqual([]);
  });

  it('gives every entry point both a type declaration and a runtime file', () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      expect(typeof target, `${subpath} should map to a conditions object`).toBe('object');
      const conditions = target as Record<string, string>;
      expect(conditions.types, `${subpath} declares no types`).toMatch(/\.d\.ts$/);
      expect(conditions.default, `${subpath} declares no runtime file`).toMatch(/\.js$/);
    }
  });

  /*
   * `files` is what npm puts in the tarball. A map pointing into a directory
   * the tarball does not carry publishes a package whose every import is a
   * 404 — the same failure with an extra step.
   */
  it('only names directories the package actually ships', () => {
    const shipped = new Set(pkg.files);
    for (const { subpath, target } of allTargets) {
      const top = target.replace(/^\.\//, '').split('/')[0];
      expect(shipped.has(top!), `${subpath} -> ${target}: "${top}" is not in package.json files`).toBe(true);
    }
  });

  /*
   * `sideEffects` names the browser shim by path. When the build output moved,
   * this was one of the two places that had to move with it and the only one a
   * bundler reads — a stale entry here silently tree-shakes the `Buffer`
   * install out of a consumer's bundle, which is the failure
   * `packages/identity/src/browser/buffer.ts` was written against.
   */
  it('names side-effecting files that exist in the shipped layout', () => {
    for (const entry of pkg.sideEffects) {
      const top = entry.replace(/^\.\//, '').split('/')[0];
      expect(pkg.files, `sideEffects ${entry} is outside files`).toContain(top);
      expect(entry.endsWith('.ts'), `sideEffects ${entry} names TypeScript`).toBe(false);
    }
  });

  /*
   * Only meaningful once somebody has run the build, and it must SAY it did not
   * run rather than pass. An early `return` inside `it` is a PASS in vitest, not
   * a skip — this test printed a tick on a clean checkout for a check it had not
   * performed, which is the one failure shape this repository's register treats
   * as worse than a red run. `skipIf` reports honestly and costs one word.
   */
  it.skipIf(!existsSync(join(root, 'lib')))(
    'resolves to files on disk once the library has been built',
    () => {
      const missing = allTargets.filter(({ target }) => !existsSync(join(root, target)));
      expect(missing).toEqual([]);
    },
  );
});
