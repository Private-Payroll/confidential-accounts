import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPhrase, keysAskedFor, type Source } from 'vaults-ui/rules/source-rules.test-support';
import { LOCALES } from './english.test-support.js';

/*
 * WHICH FILE EACH WORD IS IN, HELD TO WHERE IT IS ASKED FOR.
 *
 * The first download carries `locales/en.json` and nothing else of the
 * language. A screen's words come with it: `locales/common/en.json`, which
 * every screen loads, and `locales/pages/<page>/en.json`, which only that
 * page's screen does. A word in the wrong one is a key on a person's screen
 * (it is in none of the files the screen loads) or a download for nothing (it
 * is in a file the screen never needs). The files are found by walking the
 * imports of the application's own code the way the bundler does: the first
 * download is what `main.ts` imports without waiting; a screen is what its
 * module imports, waiting or not, beyond that.
 */
const SRC = dirname(LOCALES);

const own = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((p) => /\.tsx?$/.test(p) && !/\.test(-support)?\.tsx?$/.test(p))
  .sort();
const text = new Map(own.map((p) => [p, readFileSync(join(SRC, p), 'utf8')]));

const resolved = (from: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec)).replace(/\.js$/, '');
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => text.has(c)) ?? null;
};
const importsOf = (file: string, pattern: RegExp): string[] =>
  [...text.get(file)!.matchAll(pattern)].map((m) => resolved(file, m[1] ?? m[2]!)).filter((p): p is string => p !== null);
const STATIC = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every file `start` reaches, not going into `stop`; with `waiting`, the imports that wait too. */
function reach(start: string, waiting: boolean, stop: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    if (seen.has(f) || (stop.has(f) && f !== start)) continue;
    seen.add(f);
    todo.push(...importsOf(f, STATIC), ...(waiting ? importsOf(f, DYNAMIC) : []));
  }
  return seen;
}

const FIRST = reach('main.ts', false);
/* What the first download's own code opens later, without a page: its words are the first download's too. */
const OPENED_LATER = [...FIRST].flatMap((f) => importsOf(f, DYNAMIC)).filter((f) => !/^screens\//.test(f));
const EAGER = new Set([...FIRST, ...OPENED_LATER.flatMap((f) => [...reach(f, true, FIRST)])]);

/** Each screen's module and the folder `onDemand` names for its words, read from the page list. */
const SCREENS = [...text.get('pages.ts')!.matchAll(/onDemand\(\(\) => import\('\.\/(screens\/[\w-]+)\.js'\), '\w+', '([\w-]+)'\)/g)]
  .map((m) => ({ module: `${m[1]}.tsx`, folder: m[2]! }));
const CLOSURE = new Map(SCREENS.map((s) => [s.folder, new Set([...reach(s.module, true, EAGER)].filter((f) => !EAGER.has(f)))]));

const KEYS = new Map<string, string[]>();
const keysIn = (f: string): string[] => {
  if (!KEYS.has(f)) KEYS.set(f, keysAskedFor({ path: f, text: text.get(f)! } as Source).map((k) => k.key!));
  return KEYS.get(f)!;
};
const askedBy = (files: Iterable<string>): Set<string> => new Set([...files].flatMap(keysIn));
const FOLDERS = [...new Set(SCREENS.map((s) => s.folder))];
const jsonAt = (path: string): Record<string, string> => (existsSync(join(LOCALES, path)) ? JSON.parse(readFileSync(join(LOCALES, path), 'utf8')) as Record<string, string> : {});
const SHELL = jsonAt('en.json');
const COMMON = jsonAt('common/en.json');
const PAGE = (folder: string): Record<string, string> => jsonAt(`pages/${folder}/en.json`);
/** A key as the code asks for it, and the plural forms it stands for in a file. */
const holds = (words: Record<string, string>, key: string): boolean => hasPhrase(words, key);

describe('the words a screen loads', () => {
  /* RED WHEN: the walk finds no first download or no screens, so every rule below passes over an empty list; or a page is not named by the folder of its screen's own file. */
  it('finds the first download and every screen, each with the folder of its own name', () => {
    expect(FIRST.size).toBeGreaterThan(20);
    expect(SCREENS.length).toBe(22);
    expect(SCREENS.filter((s) => basename(s.module, '.tsx') !== s.folder)).toEqual([]);
    expect([...CLOSURE.values()].every((c) => c.size > 0)).toBe(true);
    expect(readdirSync(join(LOCALES, 'pages')).sort()).toEqual(FOLDERS.sort().filter((f) => Object.keys(PAGE(f)).length > 0));
  });

  /* RED WHEN: code the first download carries asks for a word that is not in `locales/en.json`, so it shows the key until some screen has loaded the word. */
  it('has in the first download every word the first download asks for', () => {
    expect([...askedBy(EAGER)].filter((k) => !holds(SHELL, k))).toEqual([]);
  });

  /* RED WHEN: a screen, or something it opens, asks for a word that is in none of the three files it loads, so a person sees the key. */
  it('has, for every screen, each word it asks for in the first download, the common file or its own', () => {
    for (const [folder, files] of CLOSURE) {
      const missing = [...askedBy(files)].filter((k) => !holds(SHELL, k) && !holds(COMMON, k) && !holds(PAGE(folder), k));
      expect(missing, folder).toEqual([]);
    }
  });

  /* RED WHEN: a page's own file holds a word its screen does not ask for, or one another screen asks for too (it belongs in the common file), or one the first download asks for. */
  it('keeps in a page\'s file only what that page alone asks for', () => {
    const eager = askedBy(EAGER);
    for (const [folder, files] of CLOSURE) {
      const others = askedBy([...CLOSURE].filter(([f]) => f !== folder).flatMap(([, c]) => [...c]));
      const mine = askedBy(files);
      const base = (k: string): string => k.replace(/_(zero|one|two|few|many|other)$/, '');
      const wrong = Object.keys(PAGE(folder)).filter((k) => !mine.has(base(k)) || others.has(base(k)) || eager.has(base(k)));
      expect(wrong, folder).toEqual([]);
    }
  });

  /* RED WHEN: the common file holds a word that fewer than two screens ask for, or one the first download asks for, so it is fetched for screens that do not use it. */
  it('keeps in the common file only what two screens or more ask for', () => {
    const count = new Map<string, number>();
    for (const files of CLOSURE.values()) for (const k of askedBy(files)) count.set(k, (count.get(k) ?? 0) + 1);
    const eager = askedBy(EAGER);
    const base = (k: string): string => k.replace(/_(zero|one|two|few|many|other)$/, '');
    expect(Object.keys(COMMON).filter((k) => (count.get(base(k)) ?? 0) < 2 || eager.has(base(k)))).toEqual([]);
  });

  /* RED WHEN: a word is in two of the files, so changing one changes nothing a person sees. */
  it('has no word in two files', () => {
    const all = [Object.keys(SHELL), Object.keys(COMMON), ...FOLDERS.map((f) => Object.keys(PAGE(f)))].flat();
    expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([]);
  });
});
