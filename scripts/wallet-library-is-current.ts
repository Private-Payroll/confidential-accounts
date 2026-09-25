/**
 * **WHETHER THE WALLET LIBRARY'S BUILT FILES ARE OLDER THAN THE SOURCE THEY ARE
 * BUILT FROM.**
 *
 * The app imports `midnight-identity` through `packages/identity/lib/`, which
 * is built from `packages/identity/src/` and is not kept in the repository. A
 * machine that pulled a change to the source and did not build again serves
 * the page the old library, and nothing says so: the page simply lacks what
 * the change added. The door that starts the app asks this first and builds
 * the library when the answer is no.
 *
 * **WHAT IS COMPARED.** Every `.ts` file under `src/` that is not a test has a
 * built `.js` of the same name under `lib/`. The library is out of date when
 * one of those is missing, when a source file is newer than its own built
 * file, or when a build setting is newer than the oldest built file. File
 * against file, so a source edited after the last build is caught whichever
 * file it is.
 *
 * The rule is `libraryIsCurrent`, and it reads nothing; the walk that feeds it
 * is below it and runs only when this file is run.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One file and when it was last written, in milliseconds. */
export interface Stamped { path: string; mtimeMs: number }

export type Verdict =
  | { current: true }
  | { current: false; why: string };

/** The source files the build compiles: every `.ts` that is not a test and not a declaration. */
export const isBuiltSource = (path: string): boolean =>
  path.endsWith('.ts') && !path.endsWith('.d.ts')
  && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx');

/** Where the build writes a source file's JavaScript, relative to `lib/`. */
export const builtPathOf = (sourcePath: string): string => sourcePath.replace(/\.ts$/u, '.js');

/**
 * @param sources every file under `src/`, paths relative to `src/`
 * @param built every file under `lib/`, paths relative to `lib/`; empty when there is no `lib/`
 * @param settings the build's own settings files
 */
export function libraryIsCurrent(sources: Stamped[], built: Stamped[], settings: Stamped[]): Verdict {
  const compiled = sources.filter(s => isBuiltSource(s.path));
  if (compiled.length === 0) return { current: false, why: 'the library has no source files to compare' };
  const out = new Map(built.filter(b => b.path.endsWith('.js')).map(b => [b.path, b.mtimeMs]));
  if (out.size === 0) return { current: false, why: 'the library has never been built here' };
  for (const s of compiled) {
    const at = out.get(builtPathOf(s.path));
    if (at === undefined) return { current: false, why: `${s.path} has not been built` };
    if (s.mtimeMs > at) return { current: false, why: `${s.path} changed after it was built` };
  }
  const oldest = Math.min(...compiled.map(s => out.get(builtPathOf(s.path))!));
  const newerSetting = settings.find(f => f.mtimeMs > oldest);
  if (newerSetting) return { current: false, why: `${newerSetting.path} changed after the library was built` };
  return { current: true };
}

/** Every file under `dir`, relative to it, with `/` between parts. Nothing when `dir` is not there. */
export function stampedUnder(dir: string): Stamped[] {
  let entries;
  try { entries = readdirSync(dir, { recursive: true, withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isFile())
    .map(e => {
      const full = join(e.parentPath, e.name);
      return { path: relative(dir, full).split(sep).join('/'), mtimeMs: statSync(full).mtimeMs };
    });
}

/*
 * Run as a program: exit 0 when the library is current, 1 with the reason when
 * it is not. The door decides what to do about it.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('..', import.meta.url)), 'packages', 'identity');
  const settings = ['tsconfig.build.json', 'tsconfig.json', 'package.json'].flatMap((f) => {
    try { return [{ path: f, mtimeMs: statSync(join(root, f)).mtimeMs }]; } catch { return []; }
  });
  const verdict = libraryIsCurrent(stampedUnder(join(root, 'src')), stampedUnder(join(root, 'lib')), settings);
  if (verdict.current === false) {
    console.log(`  The wallet library is out of date: ${verdict.why}.`);
    process.exit(1);
  }
  console.log('  The wallet library is up to date.');
  process.exit(0);
}
