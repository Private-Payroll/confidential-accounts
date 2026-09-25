/**
 * **THE RULE THE APP'S START DOOR USES TO DECIDE WHETHER TO BUILD THE WALLET
 * LIBRARY FIRST.** Each case is a tree of file times, and each names the
 * change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtPathOf, isBuiltSource, libraryIsCurrent, stampedUnder } from './wallet-library-is-current.js';

const at = (path: string, mtimeMs: number) => ({ path, mtimeMs });
const SOURCES = [at('index.ts', 100), at('profile/unlock.ts', 100), at('profile/unlock.test.ts', 900)];
const BUILT = [at('index.js', 200), at('index.d.ts', 200), at('profile/unlock.js', 200)];
const SETTINGS = [at('tsconfig.build.json', 50)];

describe('whether the wallet library is older than its source', () => {
  it('BUILT AFTER EVERY SOURCE AND EVERY SETTING IS CURRENT, AND A TEST FILE DOES NOT COUNT', () => {
    /* RED WHEN a test file's time is compared: it is newer and is never built. */
    expect(libraryIsCurrent(SOURCES, BUILT, SETTINGS)).toEqual({ current: true });
  });

  it('A SOURCE CHANGED AFTER ITS OWN BUILT FILE IS OUT OF DATE', () => {
    const edited = [at('index.ts', 100), at('profile/unlock.ts', 300)];
    /* RED WHEN only the newest file overall, or only one file, is compared. */
    expect(libraryIsCurrent(edited, BUILT, SETTINGS))
      .toEqual({ current: false, why: 'profile/unlock.ts changed after it was built' });
  });

  it('A SOURCE WITH NO BUILT FILE IS OUT OF DATE', () => {
    const added = [...SOURCES, at('profile/inbox.ts', 10)];
    /* RED WHEN a missing built file is skipped rather than refused. */
    expect(libraryIsCurrent(added, BUILT, SETTINGS))
      .toEqual({ current: false, why: 'profile/inbox.ts has not been built' });
  });

  it('NO BUILT FILES AT ALL IS OUT OF DATE, AND SO IS NO SOURCE', () => {
    /* RED WHEN an empty lib/ reads as current, or is reported as one file missing. */
    expect(libraryIsCurrent(SOURCES, [], SETTINGS))
      .toEqual({ current: false, why: 'the library has never been built here' });
    expect(libraryIsCurrent(SOURCES, [at('index.d.ts', 999)], SETTINGS).current).toBe(false);
    expect(libraryIsCurrent([], BUILT, SETTINGS).current).toBe(false);
  });

  it('A BUILD SETTING CHANGED AFTER THE OLDEST BUILT FILE IS OUT OF DATE', () => {
    const mixed = [at('index.js', 200), at('profile/unlock.js', 400)];
    /* RED WHEN the settings are ignored, or compared with the newest built file. */
    expect(libraryIsCurrent(SOURCES, mixed, [at('tsconfig.build.json', 300)]))
      .toEqual({ current: false, why: 'tsconfig.build.json changed after the library was built' });
  });

  it('WHICH FILES ARE BUILT, AND WHERE', () => {
    expect(['a.ts', 'a.d.ts', 'a.test.ts', 'a.test.tsx', 'a.js'].filter(isBuiltSource)).toEqual(['a.ts']);
    expect(builtPathOf('profile/unlock.ts')).toBe('profile/unlock.js');
  });

  it('THE WALK READS A REAL TREE, NESTED, WITH / BETWEEN PARTS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wallet-lib-'));
    mkdirSync(join(dir, 'profile'));
    writeFileSync(join(dir, 'index.ts'), '');
    writeFileSync(join(dir, 'profile', 'unlock.ts'), '');
    utimesSync(join(dir, 'profile', 'unlock.ts'), 1_000, 1_000);
    const seen = stampedUnder(dir).sort((a, b) => a.path.localeCompare(b.path));
    /* RED WHEN nested files are missed. */
    expect(seen.map(s => s.path)).toEqual(['index.ts', 'profile/unlock.ts']);
    expect(seen[1].mtimeMs).toBe(1_000_000);
    expect(stampedUnder(join(dir, 'not-there'))).toEqual([]);
  });
});
