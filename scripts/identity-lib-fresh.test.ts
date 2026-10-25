import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertIdentityLibFresh, staleIdentityLib } from './identity-lib-fresh.js';

/*
 * **A RUN AFTER A CHANGE TO THE IDENTITY PACKAGE WITHOUT A REBUILD IS REFUSED**, naming the files and the rebuild, so
 * no test passes on the library from before the change.
 */
const made: string[] = [];
afterEach(() => { made.length = 0; });
const aPackage = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'identity-lib-'));
  made.push(root);
  mkdirSync(join(root, 'src', 'profile'), { recursive: true });
  mkdirSync(join(root, 'lib', 'profile'), { recursive: true });
  return root;
};
const at = (path: string, seconds: number): void => { utimesSync(path, seconds, seconds); };

describe('the identity library is not older than its source', () => {
  it('names a source file whose built file is older, or missing, and nothing else', () => {
    const root = aPackage();
    writeFileSync(join(root, 'src', 'profile', 'unlock.ts'), 'export const a = 1;');
    writeFileSync(join(root, 'lib', 'profile', 'unlock.js'), 'export const a = 1;');
    writeFileSync(join(root, 'src', 'profile', 'unlock.test.ts'), '');
    writeFileSync(join(root, 'src', 'test-setup.ts'), '');
    at(join(root, 'src', 'profile', 'unlock.ts'), 1000);
    at(join(root, 'lib', 'profile', 'unlock.js'), 2000);
    expect(staleIdentityLib(root)).toEqual([]);
    /* RED WHEN: a source file changed after the build is not named, so the run tests the code from before it. */
    at(join(root, 'src', 'profile', 'unlock.ts'), 3000);
    expect(staleIdentityLib(root)).toEqual([join('profile', 'unlock.ts')]);
    /* RED WHEN: a source file never built is not named. */
    writeFileSync(join(root, 'src', 'profile', 'request.ts'), 'export const b = 1;');
    expect(staleIdentityLib(root)).toEqual([join('profile', 'request.ts'), join('profile', 'unlock.ts')]);
    expect(() => assertIdentityLibFresh(root)).toThrow(/npm run identity:build/);
  });

  /* RED WHEN: the refusal is not wired in before the tests run, so a stale library is tested without a word. */
  it('is wired into vitest.config.ts before any test runs, and its wiring refuses a stale package', async () => {
    const config = (await import('../vitest.config.ts')).default as { test?: { globalSetup?: string | string[] } };
    const wired = config.test?.globalSetup;
    expect(Array.isArray(wired) ? wired : [wired]).toContain('./scripts/identity-lib-fresh.globalSetup.ts');
    const mod = await import('./identity-lib-fresh.globalSetup.js');
    const root = aPackage();
    const packageRoot = join(root, 'packages', 'identity');
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export {};');
    expect(() => mod.default(undefined, root)).toThrow(/npm run identity:build/);
  });

  /* RED WHEN: the library this checkout's tests use is older than its source and the run is not refused. */
  it('holds for this checkout', () => {
    expect(staleIdentityLib(join(import.meta.dirname, '..', 'packages', 'identity'))).toEqual([]);
  });
});
