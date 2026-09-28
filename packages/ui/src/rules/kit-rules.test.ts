import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEED_ASSETS } from '../../../../src/core/assets.js';
import {
  amountsOutsideTheComponent, colourValues, declaredBy, filesUnder, hasPhrase, isShippingCode, keysAskedFor,
  paletteClasses, physicalClasses, secondCn, stateVariantsOf, undeclaredImports, wordingInCode, type Source,
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
const CODES = new Set(SEED_ASSETS.map((a) => a.code));

describe('the kit is read', () => {
  /* RED WHEN: the walk reads nothing, so every rule below passes over an empty list. */
  it('reads the kit\'s code', () => {
    expect(CODE.map((f) => f.path)).toContain('packages/ui/src/lib/utils.ts');
    expect(CODE.map((f) => f.path)).toContain('packages/ui/src/format/token-amount.ts');
    expect(CODE.every((f) => !/\.test(-support)?\./.test(f.path))).toBe(true);
  });
});

describe('every rule, over the kit', () => {
  /* RED WHEN: a kit file imports a package the kit's package.json does not declare. */
  it('declares every package it imports', () => {
    expect(undeclaredImports(CODE, declaredBy(readFileSync(ROOT + 'packages/ui/package.json', 'utf8')))).toEqual([]);
  });

  /* RED WHEN: a second cn is declared, or the cn package or what cn is made of is imported anywhere but the kit's cn. */
  it('has one cn', () => {
    expect(secondCn(CODE, 'packages/ui/src/lib/utils.ts')).toEqual([]);
    const components = JSON.parse(readFileSync(ROOT + 'packages/ui/components.json', 'utf8')) as { aliases: { utils: string } };
    expect(components.aliases.utils.replace(/^vaults-ui\//, 'packages/ui/src/') + '.ts').toBe('packages/ui/src/lib/utils.ts');
  });

  /* RED WHEN: a colour value appears in a component or in the stylesheet outside the theme blocks. */
  it('has no colour outside the theme', () => {
    expect(colourValues([...CODE, STYLES])).toEqual([]);
    expect(paletteClasses(CODE)).toEqual([]);
  });

  /* RED WHEN: a component spaces or aligns by left and right. */
  it('has no left or right', () => {
    expect(physicalClasses(CODE)).toEqual([]);
  });

  /* RED WHEN: a component shows a word that does not come from a language file. */
  it('shows no wording of its own', () => {
    expect(wordingInCode(CODE, CODES)).toEqual([]);
  });

  /* RED WHEN: a kit file turns an amount into text itself instead of through the amount component. */
  it('turns an amount into text only in the amount component', () => {
    expect(amountsOutsideTheComponent(CODE, ['packages/ui/src/components/amount.tsx', 'packages/ui/src/format/token-amount.ts', 'packages/ui/src/format/intl.ts'])).toEqual([]);
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
