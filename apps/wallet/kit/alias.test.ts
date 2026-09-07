import { describe, expect, it } from 'vitest';
/*
 * THE `@/` ALIAS, PINNED.
 *
 * THE DESIGN takes `tsconfig.json`, `vite.config.ts` and
 * `vitest.config.ts` out of the frozen set for exactly one change: `ESNext` +
 * `Bundler` resolution plus a `@/*` path and the two matching bundler aliases.
 * The whole point of it is that shadcn's output — `@/` prefixed and
 * extensionless — compiles here.
 *
 * THREE THINGS HAVE TO BE TRUE AT ONCE and only one of them is obvious:
 *
 *   1. `@/…` resolves, EXTENSIONLESS. This is the new capability.
 *   2. The repository's existing spelling — a relative import with an explicit
 *      `.js` — still resolves. That was the thing assumed to break when the
 *      audit measured this change, and it did not.
 *   3. A SCOPED PACKAGE is untouched. A name beginning `@` would be swallowed
 *      by a careless alias. Vite's matcher only fires on `@` exactly or `@/`,
 *      and this is the test that says so out loud — because the failure mode is
 *      a build that resolves a package import to a file inside `src/app` and
 *      dies somewhere else entirely.
 *
 * WHICH SCOPED PACKAGE STANDS FOR ALL OF THEM CHANGED, and nothing else.
 * It used `@radix-ui/react-dialog`; §2 standardised on the unified
 * `radix-ui` package and dropped the three scoped Radix entries from
 * `package.json`, so that import would now be reaching for a package this repo
 * does not declare — the same shape as the `rollup`/`esbuild`/`@swc/core`
 * accident `vite.config.ts` records, where a build worked because a parent
 * folder happened to have something. `@noble/hashes` is scoped, declared, and
 * already used by `shell/mark.tsx`. **The assertion is unchanged**: a scoped
 * import resolves to the package and `typeof` its export is `'function'`.
 *
 * The imports themselves ARE the assertions: a resolution failure is a
 * collection error, which is a red file, not a silent pass.
 */
import { cn } from '@/kit/cn';
import { cn as cnRelative } from './cn.js';
import { parseRoute } from '@/routes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Tooltip } from 'radix-ui';

describe('the @/ alias the resolution change bought', () => {
  it('resolves an extensionless @/ import — shadcn’s own spelling', () => {
    expect(cn('a', false, 'b')).toBe('a b');
  });

  it('resolves a @/ import that still carries the repo’s .js suffix', () => {
    expect(parseRoute('#/kit').name).toBe('kit');
  });

  it('is the same module the relative import reaches, not a second copy', () => {
    expect(cn).toBe(cnRelative);
  });

  it('leaves scoped packages alone — @noble is not @/', () => {
    expect(typeof sha256).toBe('function');
  });

  /* NEW, and it pins the package the change standardised on. `radix-ui`
   * is unscoped, so it is not at risk from the `@` alias at all; what it is at
   * risk from is being dropped by an `npm install` that tidies "unused"
   * dependencies, because every fetched shadcn component imports it and none of
   * this repo's own code did until this change. */
  it('resolves the unified radix-ui package the fetched components import', () => {
    expect(typeof Tooltip.Root).toBe('function');
  });
});
