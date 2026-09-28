import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED_ASSETS } from '../../../src/core/assets.js';
import {
  amountsOutsideTheComponent, colourValues, declaredBy, englishSentences, filesUnder, gapsThatDiffer, hasPhrase, isShippingCode,
  keysAskedFor, missingPhrases, paletteClasses, pathsIntoTheKit, physicalClasses, secondCn, undeclaredImports,
  wordingInCode, type Source,
} from 'vaults-ui/rules/source-rules.test-support';

/*
 * THE APPLICATION HELD TO THE KIT'S RULES, AND ITS LANGUAGE FILES TO EACH
 * OTHER. Each rule's function is shown finding what it is for in the kit's
 * `rules/source-rules.test.ts`; here it runs over the application as it is.
 *
 * WHAT IS READ: every file of the application's own source, and every module
 * the page reaches, found by walking the page the way the bundler does
 * (`scripts/browser-graph.ts`). The wording rule reads the whole of that
 * graph, the kit's files and the shared browser code included.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string): Source => ({ path: p, text: readFileSync(ROOT + p, 'utf8') });
const OWN = filesUnder(ROOT, 'apps/web/src', isShippingCode).map(read);
const CONFIG = read('apps/web/vite.config.ts');
const STYLE = filesUnder(ROOT, 'apps/web', (p) => /\.(css|html)$/.test(p) && !p.includes('/dist/')).map(read);
const CODES = new Set(SEED_ASSETS.map((a) => a.code));
const LOCALES = 'apps/web/src/locales';
const languageFiles = () => readdirSync(ROOT + LOCALES).filter((n) => n.endsWith('.json')).sort();
const messagesOf = (name: string) => JSON.parse(readFileSync(`${ROOT}${LOCALES}/${name}`, 'utf8')) as Record<string, string>;

/*
 * The walk is loaded by its address rather than imported by name, so that it
 * is typechecked where it lives, under the scripts' settings, and not a second
 * time under this application's stricter ones. What is used of it is typed here.
 */
interface BuildGraph { entries: string[]; files: string[]; unresolved: { file: string; specifier: string }[] }
interface Walker { BROWSER_BUILDS: { name: string }[]; walkBuild: (build: unknown, root: string) => Promise<BuildGraph> }
const WALKER = new URL('../../../scripts/browser-graph.ts', import.meta.url).href;

let graph: BuildGraph;
let reached: Source[];
beforeAll(async () => {
  const { BROWSER_BUILDS, walkBuild } = (await import(WALKER)) as Walker;
  const web = BROWSER_BUILDS.find((b) => b.name === 'web');
  if (web === undefined) throw new Error('scripts/browser-graph.ts lists no build named web');
  graph = await walkBuild(web, ROOT);
  reached = graph.files.filter(isShippingCode).map(read);
});

describe('the application is read', () => {
  /* RED WHEN: the walk or the file list reads nothing, or stops at an import it cannot follow, so a rule passes over less than the page. */
  it('reads its own code and the whole of what its page reaches', () => {
    expect(OWN.map((f) => f.path)).toContain('apps/web/src/main.ts');
    expect(graph.entries).toEqual(['apps/web/src/main.ts']);
    expect(graph.unresolved).toEqual([]);
    expect(STYLE.map((f) => f.path)).toContain('apps/web/index.html');
  });
});

describe('every rule, over the application', () => {
  /* RED WHEN: an application file imports a package its package.json does not declare. */
  it('declares every package it imports', () => {
    const pkg = readFileSync(ROOT + 'apps/web/package.json', 'utf8');
    expect(undeclaredImports(OWN, declaredBy(pkg))).toEqual([]);
    const withDev = new Set([...declaredBy(pkg), ...Object.keys((JSON.parse(pkg) as { devDependencies?: object }).devDependencies ?? {})]);
    expect(undeclaredImports([CONFIG], withDev).filter((b) => !b.what.startsWith('node:'))).toEqual([]);
  });

  /* RED WHEN: the application reaches into the kit's folder by a path instead of by the kit's name. */
  it('reaches the kit only as vaults-ui', () => {
    expect(pathsIntoTheKit([...OWN, CONFIG], ROOT, 'packages/ui')).toEqual([]);
  });

  /* RED WHEN: the application declares a cn, or imports the cn package or what cn is made of. */
  it('has no cn of its own', () => {
    expect(secondCn(OWN, 'packages/ui/src/lib/utils.ts')).toEqual([]);
  });

  /* RED WHEN: a colour value appears in the application's code, its stylesheets or its page. */
  it('has no colour outside the theme', () => {
    expect(colourValues([...OWN, ...STYLE])).toEqual([]);
    expect(paletteClasses(OWN)).toEqual([]);
  });

  /* RED WHEN: the application spaces or aligns by left and right. */
  it('has no left or right', () => {
    expect(physicalClasses(OWN)).toEqual([]);
  });

  /* RED WHEN: any module the page reaches, the application's or the kit's, shows a word that is not a translation. */
  it('shows no wording that is not in a language file', () => {
    expect(wordingInCode([...new Map([...OWN, ...reached].map((f) => [f.path, f])).values()], CODES)).toEqual([]);
  });

  /* RED WHEN: a module of the shared browser code the page reaches carries an English sentence a screen could show. */
  it('reaches no English sentence in the shared browser code', () => {
    expect(englishSentences(reached.filter((f) => f.path.startsWith('packages/web-shared/')))).toEqual([]);
  });

  /* RED WHEN: the application, or shared browser code its page reaches, turns an amount into text instead of through the kit's amount component. */
  it('shows an amount only through the amount component', () => {
    expect(amountsOutsideTheComponent([...OWN, ...reached.filter((f) => !f.path.startsWith('packages/ui/'))], [])).toEqual([]);
  });

  /* RED WHEN: the application asks for a key the English file lacks, or builds a key at run time. */
  it('asks only for keys the English file has', () => {
    const english = messagesOf('en.json');
    const asked = OWN.flatMap((f) => keysAskedFor(f).map((k) => ({ path: f.path, ...k })));
    expect(asked.filter((k) => k.key === null || !hasPhrase(english, k.key))).toEqual([]);
  });
});

describe('the language files', () => {
  /* RED WHEN: the English file is gone or renamed, so every language would be compared with nothing. */
  it('has the English file', () => {
    expect(languageFiles()).toContain('en.json');
    expect(Object.keys(messagesOf('en.json')).length).toBeGreaterThan(0);
  });

  /* RED WHEN: a language file lacks a phrase or a plural form its language needs, or has one English does not. */
  it('gives every language every phrase', () => {
    const english = messagesOf('en.json');
    expect(languageFiles().flatMap((n) => missingPhrases(english, n.replace(/\.json$/, ''), messagesOf(n)))).toEqual([]);
  });

  /* RED WHEN: a phrase has other gaps in a language than in English. */
  it('gives every phrase the same gaps in every language', () => {
    const english = messagesOf('en.json');
    expect(languageFiles().flatMap((n) => gapsThatDiffer(english, n.replace(/\.json$/, ''), messagesOf(n)))).toEqual([]);
  });

  /* RED WHEN: a phrase is empty, or a value is not text. */
  it('has text for every phrase', () => {
    for (const n of languageFiles()) for (const [k, v] of Object.entries(messagesOf(n))) expect(typeof v === 'string' && v.trim().length > 0, `${n} ${k}`).toBe(true);
  });
});
