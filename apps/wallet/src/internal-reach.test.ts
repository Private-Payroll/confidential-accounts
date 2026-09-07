// @vitest-environment node

/**
 * **WHAT THIS APPLICATION REACHES THAT THE LIBRARY DOES NOT PUBLISH.**
 *
 * The wallet imports the library by its package name. Its own config aliases
 * that name at the library's SOURCE, so an import here resolves whether or not
 * the library's `exports` map publishes it - and an outside consumer, who has
 * only `exports`, gets a bare failure for the same line.
 *
 * **THAT ASYMMETRY IS CORRECT AND IT IS INVISIBLE, WHICH IS THE WHOLE REASON
 * FOR THIS FILE.** `midnight-identity/keys/derivation` and
 * `midnight-identity/profile/model` read identically at the import site and
 * one of them is public API. Somebody meeting the first later, with a consumer
 * that cannot resolve it, fixes it the obvious way - by widening `exports` -
 * and publishes the key derivation, the passkey verification and the recovery
 * pieces as library API without ever deciding to.
 *
 * So the set is written down in `packages/identity/internal-subpaths.json` and
 * this file refuses when the code and that record disagree, IN BOTH
 * DIRECTIONS. A reach that is not recorded is a red suite; a record that names
 * something nothing imports any more is also a red suite, because a list
 * nobody prunes stops describing anything.
 *
 * **WHAT TURNS EACH ASSERTION RED**, and each was watched doing so against a
 * copy of this tree held outside the repository:
 *
 *   1. *found imports at all* - point the walk at a directory with no source
 *      in it. Without this, everything below is vacuously true over an empty
 *      set, which is how a check of this shape stops checking and says nothing.
 *   2. *nothing published is on the internal list* - put `profile/model`, a
 *      published subpath, on the record.
 *   3. *every reach is recorded* - reach `profile/store` with the record not
 *      naming it.
 *   4. *every record is reached* - record `keys/vanished` with nothing
 *      importing it.
 *
 * **AND THE THREE VERDICTS ARE A PURE FUNCTION SO THAT EACH RED CAN BE WATCHED
 * WITHOUT TOUCHING THIS TREE.** The assertions below run `verdict` over the
 * real application; the block at the foot runs the same `verdict` over named
 * mutations of its inputs and watches each of the three lists fill. Mutating
 * the repository to watch a check fail is how a killed run leaves a repository
 * that is quietly wrong, and the fixture directory the first assertion needs
 * is made under the system temporary directory, outside this repository
 * altogether.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/* THE APPLICATION'S OWN FOLDER, WHICH IS ONE ABOVE THIS FILE AND NOT THIS
 * FILE'S OWN. The walk has to cover everything the application is built
 * from, and the node programs beside its source are part of that; pointing
 * it at the source folder alone would narrow the guard without saying so,
 * and the direction it narrows in is a reach nobody records. */
const HERE = fileURLToPath(new URL('..', import.meta.url));
const LIB = fileURLToPath(new URL('../../../packages/identity/', import.meta.url));

const SKIP = new Set(['node_modules', 'dist', 'public', '.vite-cache']);

/** Every source file of the application, wherever the walk is pointed. */
export const sourceFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name)); }
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(join(dir, e.name));
    }
  };
  walk(root);
  return out;
};

/**
 * The subpath of every `midnight-identity/...` IMPORT, as the library spells
 * it. The bare package name is the root export and is never internal, so it is
 * not collected.
 *
 * **IT MATCHES AN IMPORT POSITION AND NOT THE STRING, AND THAT IS A
 * MEASUREMENT RATHER THAN CAUTION.** The first version of this matched any
 * quoted `midnight-identity/...` anywhere in a file, and it reported six
 * subpaths this application has never imported: `authority/v1`,
 * `wallet-ready/v1`, `join-acceptance/v1`, `inbox-answer/v1`,
 * `disclosure-request/v1` and `disclosure-refused/v1`. **They are the wire
 * protocol's own message kinds**, which are namespaced under the same name on
 * purpose. Left as it was, this check would have demanded that six message
 * kinds be recorded as library modules - and the record it exists to keep
 * honest would have been the first thing it made dishonest.
 */
export const reachedSubpaths = (files: string[]): Set<string> => {
  const out = new Set<string>();
  const IMPORTS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]midnight-identity\/([^'"]+)['"]/g;
  for (const f of files)
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORTS))
      out.add(m[1] as string);
  return out;
};

/** What an outside consumer can resolve: the `exports` map, minus the root. */
export const published = (pkg: { exports?: Record<string, unknown> }): Set<string> =>
  new Set(Object.keys(pkg.exports ?? {}).filter(k => k !== '.').map(k => k.replace(/^\.\//, '')));

/**
 * THE THREE QUESTIONS, AS ONE PURE FUNCTION. Sets in, three lists out, no
 * filesystem and no clock - so the block at the foot of this file can watch
 * each list fill against inputs it builds itself.
 */
export const verdict = (
  { reached, published: pub, record }: { reached: Set<string>; published: Set<string>; record: Set<string> },
): { publishedOnRecord: string[]; unrecorded: string[]; stale: string[] } => {
  const internalReach = [...reached].filter(s => !pub.has(s)).sort();
  return {
    publishedOnRecord: [...record].filter(s => pub.has(s)).sort(),
    unrecorded: internalReach.filter(s => !record.has(s)),
    stale: [...record].filter(s => !reached.has(s)).sort(),
  };
};

describe('what the wallet reaches that the library does not publish', () => {
  const files = sourceFiles(HERE);
  const reached = reachedSubpaths(files);
  const pkg = JSON.parse(readFileSync(join(LIB, 'package.json'), 'utf8')) as { exports?: Record<string, unknown> };
  const pub = published(pkg);
  const record = new Set<string>(
    (JSON.parse(readFileSync(join(LIB, 'internal-subpaths.json'), 'utf8')) as { internal: string[] }).internal,
  );
  const found = verdict({ reached, published: pub, record });
  const internalReach = [...reached].filter(s => !pub.has(s)).sort();

  console.log(
    `internal reach: ${files.length} application files, ${reached.size} distinct library subpaths, `
    + `${pub.size} published, ${internalReach.length} internal, ${record.size} recorded`,
  );

  it('read an application that actually has imports in it', () => {
    expect(files.length, 'no source files found - the walk is looking in the wrong place, and every assertion below would pass over nothing')
      .toBeGreaterThan(50);
    expect(reached.size, 'no midnight-identity subpath imports found - the matcher no longer matches how this application imports the library')
      .toBeGreaterThan(5);
    expect(pub.size, 'the library published nothing - the exports map was not read')
      .toBeGreaterThan(5);
  });

  it('records nothing that the library does publish', () => {
    const wrong = found.publishedOnRecord;
    expect(
      wrong,
      `these are named as internal and the library PUBLISHES them:\n  ${wrong.join('\n  ')}\n`
      + 'A published subpath on this list reads as a private reach that has to be justified, '
      + 'and it is the opposite: anybody may import it.',
    ).toEqual([]);
  });

  it('records every unpublished subpath the application reaches', () => {
    const unrecorded = found.unrecorded;
    expect(
      unrecorded,
      `the application imports these and the library does not publish them, and they are on no record:\n  ${unrecorded.join('\n  ')}\n`
      + 'Either the import belongs to public API - add it to the exports map - or it is a '
      + 'deliberate internal reach and it goes in packages/identity/internal-subpaths.json '
      + 'with the rest. What it may not be is unremarked.',
    ).toEqual([]);
  });

  it('reaches every subpath it records', () => {
    const stale = found.stale;
    expect(
      stale,
      `the record names these and nothing imports them any more:\n  ${stale.join('\n  ')}\n`
      + 'A list nobody prunes stops describing anything, and the next reader takes it for '
      + 'the current answer. Remove the line in the same change that removed the import.',
    ).toEqual([]);
  });
});

/**
 * **THE SAME THREE QUESTIONS, WATCHED GOING RED.**
 *
 * Each case names the change and asserts exactly which list fills and with
 * what. A test that only checks *something failed* passes when the wrong thing
 * fails, which is the failure mode the assertions above exist to prevent in
 * the first place.
 */
describe('each verdict, watched failing against inputs built here', () => {
  const REACHED = new Set(['profile/model', 'profile/store', 'keys/derivation']);
  const PUBLISHED = new Set(['profile/model', 'browser', 'network']);
  const RECORD = new Set(['profile/store', 'keys/derivation']);

  it('is green on inputs that agree, or every red below proves nothing', () => {
    expect(verdict({ reached: REACHED, published: PUBLISHED, record: RECORD }))
      .toEqual({ publishedOnRecord: [], unrecorded: [], stale: [] });
  });

  it('RED when the record names something the library publishes', () => {
    const { publishedOnRecord } = verdict({
      reached: REACHED, published: PUBLISHED, record: new Set([...RECORD, 'profile/model']),
    });
    expect(publishedOnRecord).toEqual(['profile/model']);
  });

  it('RED when the application reaches an unpublished subpath nothing recorded', () => {
    const { unrecorded } = verdict({
      reached: REACHED, published: PUBLISHED, record: new Set(['keys/derivation']),
    });
    expect(unrecorded).toEqual(['profile/store']);
  });

  it('RED when the record names a subpath nothing imports any more', () => {
    const { stale } = verdict({
      reached: REACHED, published: PUBLISHED, record: new Set([...RECORD, 'keys/vanished']),
    });
    expect(stale).toEqual(['keys/vanished']);
  });

  /**
   * THE FLOOR, WATCHED THE ONLY WAY IT CAN BE: over a directory with no source
   * in it. Made under the system temporary directory - OUTSIDE this repository,
   * a real directory and not a link to one - because the thing being proved is
   * that an empty walk is caught rather than passed over in silence.
   */
  it('RED when the walk finds no source files', () => {
    const empty = mkdtempSync(join(tmpdir(), 'internal-reach-'));
    try {
      expect(sourceFiles(empty)).toEqual([]);
      expect(reachedSubpaths(sourceFiles(empty)).size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
