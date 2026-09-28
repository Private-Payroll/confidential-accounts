import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEED_ASSETS } from '../../../../src/core/assets.js';
import {
  amountsMadeOutsideTheAdapters, amountsOutsideTheComponent, arbitraryValues, CODES, codesUnder, colourValues, declaredBy, filesUnder, hasPhrase, inlineStyles, isShippingCode,
  keysAskedFor, namedOutside, paletteClasses, physicalClasses, secondCn, SIDE_NAMES, spansOf, stateVariantsOf, stringWordsOf, undeclaredImports, waysIntoSharedCode, wordingCensus, wordingInCode,
  type Source,
} from './source-rules.test-support.js';

/*
 * THE KIT'S OWN FILES, HELD TO EVERY RULE. Each rule's function is shown
 * finding what it is for in `source-rules.test.ts`; here it is run over the
 * kit as it is, and every list must be empty.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (p: string): Source => ({ path: p, text: readFileSync(ROOT + p, 'utf8') });
const CODE = filesUnder(ROOT, 'packages/ui/src', isShippingCode).map(read);
const STYLES = read('packages/ui/src/styles.css');
const ENGLISH = JSON.parse(readFileSync(ROOT + 'apps/web/src/locales/en.json', 'utf8')) as Record<string, string>;
const ASSET_CODES = new Set(SEED_ASSETS.map((a) => a.code));

describe('the kit is read', () => {
  /* RED WHEN: the walk reads nothing, so every rule below passes over an empty list. */
  it('reads the kit\'s code', () => {
    expect(CODE.map((f) => f.path)).toContain('packages/ui/src/lib/utils.ts');
    expect(CODE.map((f) => f.path)).toContain('packages/ui/src/format/token-amount.ts');
    expect(CODE.every((f) => !/\.test(-support)?\./.test(f.path))).toBe(true);
  });

  /* RED WHEN: a rule that refuses by default reads nothing, so it passes over the kit because it saw nothing to refuse. */
  it('reads every string, class word and conversion the refusing rules look at', () => {
    const census = wordingCensus(CODE, ASSET_CODES);
    expect(census.read).toBeGreaterThan(150);
    expect(census.byPosition.class).toBeGreaterThan(20);
    expect(census.byPosition['translation key']).toBeGreaterThan(5);
    const words = CODE.flatMap(stringWordsOf).map((w) => w.word);
    expect(words.length).toBeGreaterThan(300);
    expect(words).toEqual(expect.arrayContaining(['bg-primary', 'text-muted-foreground', 'rounded-[min(var(--radius-md),10px)]']));
    expect(stringWordsOf(STYLES).map((w) => w.word)).toEqual(expect.arrayContaining(['bg-background', 'text-foreground']));
    /* With no homes, the amount rule finds the conversions the homes make. */
    expect(new Set(amountsOutsideTheComponent(CODE, {}).map((b) => b.path))).toEqual(new Set(['packages/ui/src/components/amount.tsx', 'packages/ui/src/format/token-amount.ts']));
  });

  /* RED WHEN: an entry of CODES for the kit names a declaration that is not there, so it lets through whatever is written under that name later; or CODES names a file outside the kit and the application. */
  it('names, in CODES, only declarations the kit has', () => {
    expect(wordingCensus(CODE, ASSET_CODES).codes).toEqual(codesUnder('packages/ui'));
    expect(Object.keys(CODES).filter((k) => !/^(packages\/ui|apps\/web)\//.test(k))).toEqual([]);
  });
});

describe('every rule, over the kit', () => {
  /* RED WHEN: a kit file imports a package the kit's package.json does not declare. */
  it('declares every package it imports', async () => {
    expect(await undeclaredImports(CODE, declaredBy(readFileSync(ROOT + 'packages/ui/package.json', 'utf8')))).toEqual([]);
  });

  /* RED WHEN: a kit file imports the shared browser package, reaches outside the kit's own source by a path, calls the network or talks to the wallet: the kit reaches none of them, and only the application's adapters do. */
  it('reaches no shared code, no service and no wallet', async () => {
    expect(await waysIntoSharedCode(CODE, ROOT, 'packages/ui/src', null)).toEqual([]);
  });

  /* RED WHEN: a kit file other than the amount's own and the index that re-exports it makes an amount: the kit shows amounts it is given, and makes none. */
  it('makes no amount of its own', () => {
    const own = ['packages/ui/src/format/token-amount.ts', 'packages/ui/src/index.ts'];
    expect(amountsMadeOutsideTheAdapters(CODE.filter((f) => !own.includes(f.path)), ROOT, null)).toEqual([]);
    expect(new Set(amountsMadeOutsideTheAdapters(CODE, ROOT, null).map((b) => b.path))).toEqual(new Set(own));
  });

  /* RED WHEN: a second cn is declared, or the cn package or what cn is made of is imported anywhere but the kit's cn. */
  it('has one cn', async () => {
    expect(await secondCn(CODE, 'packages/ui/src/lib/utils.ts')).toEqual([]);
    const components = JSON.parse(readFileSync(ROOT + 'packages/ui/components.json', 'utf8')) as { aliases: { utils: string } };
    expect(components.aliases.utils.replace(/^vaults-ui\//, 'packages/ui/src/') + '.ts').toBe('packages/ui/src/lib/utils.ts');
  });

  /* RED WHEN: a colour value, a palette colour or an arbitrary value that is not a token is written in any string of a component or in the stylesheet, or a colour is set inline. */
  it('has no colour outside the theme', () => {
    expect(colourValues([...CODE, STYLES])).toEqual([]);
    expect(paletteClasses([...CODE, STYLES])).toEqual([]);
    expect(arbitraryValues([...CODE, STYLES])).toEqual([]);
    expect(inlineStyles([...CODE, STYLES])).toEqual([]);
  });

  /* RED WHEN: a component or the stylesheet spaces, aligns or places by left and right, in a class or any other string. */
  it('has no left or right', () => {
    expect(physicalClasses([...CODE, STYLES])).toEqual([]);
  });

  /* RED WHEN: a string with a letter stands in the kit anywhere not named as a position. */
  it('shows no wording of its own', () => {
    expect(wordingInCode(CODE, ASSET_CODES)).toEqual([]);
  });

  /* RED WHEN: an entry of SIDE_NAMES names a declaration the kit does not have, so it lets through whatever left or right is written under that name later. */
  it('names, in SIDE_NAMES, only declarations the kit has', () => {
    for (const entry of Object.keys(SIDE_NAMES)) {
      const [path] = entry.split('#');
      const file = CODE.find((f) => f.path === path);
      expect(file === undefined ? 0 : spansOf(file, { [entry]: '' }).length, entry).toBe(1);
    }
  });

  /*
   * RED WHEN: the amount's figure without its pill is used anywhere in the kit
   * but the amount component and the balance, where a public amount shown
   * through it would have no pill.
   */
  it('uses the figure without the pill only in the amount and the balance', () => {
    const homes = ['packages/ui/src/components/amount.tsx', 'packages/ui/src/components/balance.tsx'];
    expect(namedOutside(CODE, 'AmountFigure', homes)).toEqual([]);
    expect(new Set(namedOutside(CODE, 'AmountFigure', []).map((b) => b.path))).toEqual(new Set(homes));
  });

  /* RED WHEN: a kit file turns any value into text or a number outside the amount component and its helper. */
  it('turns an amount into text only in the amount component', () => {
    expect(amountsOutsideTheComponent(CODE)).toEqual([]);
  });

  /* RED WHEN: the kit asks for a key the English file lacks, a key outside kit., or a key built at run time. */
  it('asks only for its own keys, and each is in the English file', () => {
    /* The provider hands a caller's key through to the library, so it is the one file whose key is not its own. */
    const asked = CODE.filter((f) => f.path !== 'packages/ui/src/i18n/provider.tsx')
      .flatMap((f) => keysAskedFor(f).map((k) => ({ path: f.path, ...k })));
    expect(asked.length).toBeGreaterThan(5);
    expect(asked.filter((k) => k.key === null || !k.key.startsWith('kit.') || !hasPhrase(ENGLISH, k.key))).toEqual([]);
  });

  /*
   * RED WHEN: a component uses a `data-...:` state variant the stylesheet does
   * not define. Radix marks state as `data-state`, so an undefined one matches
   * nothing and its classes silently never apply.
   */
  it('defines every state variant its components use', () => {
    const defined = new Set([...STYLES.text.matchAll(/@custom-variant\s+([a-z-]+)/g)].map((m) => m[1]!));
    const used = new Set(CODE.flatMap(stateVariantsOf));
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((v) => !defined.has(v))).toEqual([]);
  });
});

describe('the kit owns no English', () => {
  /* RED WHEN: a second English file, or any language file, appears outside the application's locales. */
  it('has one English file, the application\'s', () => {
    const json = [...filesUnder(ROOT, 'packages/ui', (p) => p.endsWith('.json') && !/\/(package|components|tsconfig)\.json$/.test(p)),
      ...filesUnder(ROOT, 'apps/web', (p) => /(^|\/)[a-z]{2,3}(-[A-Za-z0-9]+)*\.json$/.test(p))];
    expect(json).toEqual(['apps/web/src/locales/en.json']);
    expect(existsSync(ROOT + 'packages/ui/src/locales')).toBe(false);
  });
});
