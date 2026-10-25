/**
 * **THE IDENTITY PACKAGE'S BUILT LIBRARY IS NOT OLDER THAN ITS SOURCE.**
 *
 * Tests outside the wallet reach `midnight-identity` through its built `lib/`, the way the published package is used,
 * so a run after a change to `packages/identity/src` without a rebuild tests the code from before the change and can
 * pass on it. This names every source file whose built file is missing or older than it, so a run can refuse to start
 * on a stale library and say how to rebuild it (`npm run identity:build`). A test file, a declaration and the package's
 * own test setup are not built, and are not asked about.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const NOT_BUILT = /(\.test\.tsx?|\.d\.ts)$/u;

/** Each source file, relative to `src`, whose `lib` file is missing or older than it. */
export function staleIdentityLib(packageRoot: string): string[] {
  const src = join(packageRoot, 'src');
  const lib = join(packageRoot, 'lib');
  const stale: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.ts') || NOT_BUILT.test(name) || relative(src, p) === 'test-setup.ts') continue;
      const built = join(lib, relative(src, p)).replace(/\.ts$/u, '.js');
      if (!existsSync(built) || statSync(built).mtimeMs < statSync(p).mtimeMs) stale.push(relative(src, p));
    }
  };
  if (existsSync(src)) walk(src);
  return stale.sort();
}

/** Throws, naming the files and the rebuild, when the library is stale; returns quietly when it is not. */
export function assertIdentityLibFresh(packageRoot: string): void {
  const stale = staleIdentityLib(packageRoot);
  if (stale.length === 0) return;
  throw new Error(
    `packages/identity/lib is older than its source for ${stale.length} file(s) (${stale.slice(0, 5).join(', ')}`
    + `${stale.length > 5 ? ', ...' : ''}), so these tests would run the code from before the change. Rebuild it with `
    + '`npm run identity:build` and run them again.');
}
