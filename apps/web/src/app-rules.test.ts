import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED_ASSETS } from '../../../src/core/assets.js';
import {
  amountsOutsideTheComponent, arbitraryValues, colourValues, declaredBy, englishSentences, filesUnder, gapsThatDiffer, hasPhrase,
  inlineStyles, isShippingCode, keysAskedFor, missingPhrases, paletteClasses, pathsIntoTheKit, physicalClasses, SCREEN_FORMATTERS,
  secondCn, undeclaredImports, wordingCensus, wordingInCode, type Source,
} from 'vaults-ui/rules/source-rules.test-support';

/*
 * THE APPLICATION HELD TO THE KIT'S RULES, AND ITS LANGUAGE FILES TO EACH
 * OTHER. Each rule's function is shown finding what it is for in the kit's
 * `rules/source-rules.test.ts`; here it runs over the application as it is.
 *
 * WHAT IS READ: every file of the application's own source, and every module
 * the page reaches, found by walking the page the way the bundler does
 * (`scripts/browser-graph.ts`). The wording, amount, colour and left-or-right
 * rules refuse by default, and read the application's own files, its page and
 * stylesheet, and the kit's files the page reaches. The shared browser code the
 * page reaches is not written for this application alone: it is held to no
 * English sentence, and to no call of a number formatter (`formatTokenAmount`,
 * `NumberFormat`, `toLocaleString`, `toFixed`, ...); its other conversions are
 * not read.
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
/** The application's code and the kit's code its page reaches, each once. */
const ownAndKit = () => [...new Map([...OWN, ...reached.filter((f) => f.path.startsWith('packages/ui/'))].map((f) => [f.path, f])).values()];

describe('the application is read', () => {
  /* RED WHEN: the walk or the file list reads nothing, or stops at an import it cannot follow, so a rule passes over less than the page. */
  it('reads its own code and the whole of what its page reaches', () => {
    expect(OWN.map((f) => f.path)).toContain('apps/web/src/main.ts');
    expect(graph.entries).toEqual(['apps/web/src/main.ts']);
    expect(graph.unresolved).toEqual([]);
    expect(STYLE.map((f) => f.path)).toContain('apps/web/index.html');
    /* RED WHEN: the page reaches a file of the application or the kit the rules do not read (a `.jsx`, a `.mjs`). */
    expect(graph.files.filter((p) => /^(apps\/web|packages\/ui)\//.test(p) && !isShippingCode(p))).toEqual([]);
  });

  /* RED WHEN: the refusing rules read nothing of the application, so they pass over it because they saw nothing to refuse. */
  it('reads every string the refusing rules look at, the application\'s own among them', () => {
    const census = wordingCensus(ownAndKit(), CODES);
    expect(census.read).toBeGreaterThan(150);
    const own = wordingCensus(OWN, CODES);
    expect(own.byPosition).toEqual(expect.objectContaining({ module: expect.any(Number), 'translation key': expect.any(Number), 'element id': 1 }));
    expect(ownAndKit().map((f) => f.path)).toEqual(expect.arrayContaining(['apps/web/src/main.ts', 'packages/ui/src/components/amount.tsx']));
  });
});

describe('every rule, over the application', () => {
  /* RED WHEN: an application file imports a package its package.json does not declare. */
  it('declares every package it imports', async () => {
    const pkg = readFileSync(ROOT + 'apps/web/package.json', 'utf8');
    expect(await undeclaredImports(OWN, declaredBy(pkg))).toEqual([]);
    const withDev = new Set([...declaredBy(pkg), ...Object.keys((JSON.parse(pkg) as { devDependencies?: object }).devDependencies ?? {})]);
    expect((await undeclaredImports([CONFIG], withDev)).filter((b) => !b.what.startsWith('node:'))).toEqual([]);
  });

  /* RED WHEN: the application reaches into the kit's folder by a path instead of by the kit's name. */
  it('reaches the kit only as vaults-ui', async () => {
    expect(await pathsIntoTheKit([...OWN, CONFIG], ROOT, 'packages/ui')).toEqual([]);
  });

  /* RED WHEN: the application declares a cn, or imports the cn package or what cn is made of. */
  it('has no cn of its own', async () => {
    expect(await secondCn(OWN, 'packages/ui/src/lib/utils.ts')).toEqual([]);
  });

  /* RED WHEN: a colour value, a palette colour or an arbitrary value that is not a token is written in any string of the application, its stylesheet or its page, or a colour is set inline. */
  it('has no colour outside the theme', () => {
    expect(colourValues([...OWN, ...STYLE])).toEqual([]);
    expect(paletteClasses([...OWN, ...STYLE])).toEqual([]);
    expect(arbitraryValues([...OWN, ...STYLE])).toEqual([]);
    expect(inlineStyles([...OWN, ...STYLE])).toEqual([]);
  });

  /* RED WHEN: the application, its stylesheet or its page spaces, aligns or places by left and right. */
  it('has no left or right', () => {
    expect(physicalClasses([...OWN, ...STYLE])).toEqual([]);
  });

  /* RED WHEN: a string with a letter stands, in the application, its page, its stylesheet or the kit its page reaches, anywhere not named as a position; the page's title included. */
  it('shows no wording that is not in a language file', () => {
    expect(wordingInCode([...ownAndKit(), ...STYLE], CODES)).toEqual([]);
  });

  /* RED WHEN: a module of the shared browser code the page reaches carries an English sentence a screen could show. */
  it('reaches no English sentence in the shared browser code', () => {
    expect(englishSentences(reached.filter((f) => f.path.startsWith('packages/web-shared/')))).toEqual([]);
  });

  /* RED WHEN: the application turns any value into text or a number, or shared browser code its page reaches puts a figure on a screen, anywhere but the kit's amount component. */
  it('shows an amount only through the amount component', () => {
    expect(amountsOutsideTheComponent(ownAndKit())).toEqual([]);
    const shared = reached.filter((f) => f.path.startsWith('packages/web-shared/'));
    expect(amountsOutsideTheComponent(shared).filter((b) => SCREEN_FORMATTERS.has(b.what))).toEqual([]);
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
