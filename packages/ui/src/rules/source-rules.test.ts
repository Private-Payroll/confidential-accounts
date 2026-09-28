import { describe, expect, it } from 'vitest';
import {
  amountsOutsideTheComponent, classWordsOf, colourValues, declaredBy, englishSentences, gapsOf, gapsThatDiffer,
  hasPhrase, keysAskedFor, missingPhrases, paletteClasses, pathsIntoTheKit, physicalClasses, pluralOf, secondCn,
  stateVariantsOf, undeclaredImports, utilityOf, wordingInCode, type Source,
} from './source-rules.test-support.js';

/*
 * EACH RULE AGAINST TEXT WRITTEN TO BREAK IT, AND TEXT WRITTEN TO PASS. The
 * tests that hold the kit and the application run these same functions over
 * the real files; these show each function finds what it is for.
 */
const src = (path: string, text: string): Source => ({ path, text });
const whats = (b: { what: string }[]) => b.map((x) => x.what);

describe('imports', () => {
  const declared = declaredBy(JSON.stringify({ name: 'kit', dependencies: { 'radix-ui': '1' }, peerDependencies: { react: '1' } }));

  /* RED WHEN: a package the file's own package does not declare, or a Node built-in, is let through. */
  it('names every package imported and not declared', () => {
    const f = src('a.tsx', `import * as React from 'react';
      import { Slot } from 'radix-ui';
      import { cva } from 'class-variance-authority';
      import { x } from 'kit/lib/utils';
      import { y } from './near.js';
      export { z } from '@scope/pkg/sub';
      const m = await import('i18next');
      import { readFileSync } from 'node:fs';
      import path from 'path';`);
    expect(whats(undeclaredImports([f], declared))).toEqual(['class-variance-authority', 'node:fs', 'path', '@scope/pkg/sub', 'i18next']);
  });

  /* RED WHEN: a path into the kit's folder, however spelled, is let through, or the package name is refused. */
  it('names every path into the kit', () => {
    const f = src('apps/web/src/main.ts', `import 'vaults-ui/styles.css';
      import { a } from '../../../packages/ui/src/index.js';
      import { b } from '../../../packages/uix/x.js';
      import { c } from '/packages/ui/src/lib/utils';
      import { e } from '../../../packages/UI/src/x.js';
      import { d } from './own.js';`);
    expect(whats(pathsIntoTheKit([f], '/repo', 'packages/ui'))).toEqual(['../../../packages/ui/src/index.js', '/packages/ui/src/lib/utils', '../../../packages/UI/src/x.js']);
  });
});

describe('one cn', () => {
  /* RED WHEN: the cn package, clsx or tailwind-merge is imported outside the kit's own cn, or a second cn is declared. */
  it('names every second cn', () => {
    const home = src('lib/utils.ts', "import { clsx } from 'clsx'; export function cn() {}");
    const other = src('components/x.tsx', `import { cn as c } from 'cn';
      import { twMerge } from 'tailwind-merge';
      import { cn } from 'vaults-ui/lib/utils';
      import { cva, cx } from 'class-variance-authority';
      const cn2 = 1; function cn() {} const f = () => { const cn = 2; };`);
    expect(whats(secondCn([home, other], 'lib/utils.ts'))).toEqual(['imports cn', 'imports tailwind-merge', 'imports cx', 'declares cn', 'declares cn']);
  });
});

describe('colours', () => {
  /* RED WHEN: a colour value in any of these spellings is let through, or a token or a colour-space name is taken for one. */
  it('names every colour value', () => {
    const f = src('x.tsx', `const a = '#fff'; const b = "#A1B2C3"; const c = 'rgb(0 0 0)'; const d = 'hsl(1 2% 3%)';
      const e = 'oklch(0.5 0 0)'; const g = "bg-[#123456]"; const h = 'rgba(0,0,0,.5)';
      const ok = 'bg-primary hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] #main';`);
    expect(whats(colourValues([f]))).toEqual(['#fff', '#A1B2C3', 'rgb(', 'hsl(', 'oklch(', '#123456', 'rgba(']);
  });

  /* RED WHEN: a palette colour in a class is let through behind a variant, an opacity or an arbitrary variant, or a token is refused. */
  it('names every palette colour in a class', () => {
    const f = src('x.tsx', `const a = cn('bg-red-500 hover:text-white dark:border-zinc-200/50 ring-black', x && 'fill-sky-100');
      const b = <div className="text-muted-foreground bg-primary text-sm border-transparent shadow-md" />;
      const c = cva('[&>svg]:text-slate-400', { variants: { v: { a: 'bg-background' } } });`);
    expect(whats(paletteClasses([f]))).toEqual(['bg-red-500', 'hover:text-white', 'dark:border-zinc-200/50', 'ring-black', 'fill-sky-100', '[&>svg]:text-slate-400']);
  });
});

describe('start and end, not left and right', () => {
  /* RED WHEN: a physical class is let through behind any variant or as a negative, or a logical one, or a side prop, is refused. */
  it('names every left or right class', () => {
    const f = src('x.tsx', `const a = cn('ml-2 hover:pr-1.5 -mr-px has-data-[icon=inline-start]:pl-2', 'text-left rounded-tl-lg left-0 border-r');
      const b = <div side="left" className={\`ms-2 pe-1 text-start rounded-lg rounded-s-md start-0 border-e \${x} float-right\`} />;
      const c = cn('data-[side=left]:slide-in-from-right-2 placeholder:text-muted-foreground prose');`);
    expect(whats(physicalClasses([f]))).toEqual(['ml-2', 'hover:pr-1.5', '-mr-px', 'has-data-[icon=inline-start]:pl-2', 'text-left', 'rounded-tl-lg', 'left-0', 'border-r', 'float-right']);
  });

  /* RED WHEN: a variant with a colon inside brackets is cut there, so the utility is misread. */
  it('reads the utility after the last variant', () => {
    expect(utilityOf('has-data-[icon=inline-start]:pl-2')).toBe('pl-2');
    expect(utilityOf('[&_svg:not([class*=size-])]:size-4')).toBe('size-4');
    expect(utilityOf('hover:-ml-2!')).toBe('ml-2');
  });

  /* RED WHEN: a string that is not a class, a key of a variants object, is read as one. */
  it('reads classes only where classes are written', () => {
    const f = src('x.tsx', "const v = cva('a', { variants: { 'pl-9': { x: 'b' } } }); const s = 'ml-2'; const o = { className: 'mr-1' };");
    expect(classWordsOf(f).map((w) => w.word)).toEqual(['a', 'b']);
  });
});

describe('state variants', () => {
  /* RED WHEN: a bare data- variant, grouped, named or multi-word, is missed, or a bracketed one is returned. */
  it('finds every bare data- variant a class uses', () => {
    const f = src('x.tsx', "cn('data-open:a group-data-foo/button:bg-muted peer-data-checked:b data-state-open:c data-[side=top]:d has-data-[icon=x]:e')");
    expect(stateVariantsOf(f)).toEqual(['data-checked', 'data-foo', 'data-open', 'data-state-open']);
  });
});

describe('wording', () => {
  const allowed = new Set(['USDC', 'NIGHT']);

  /* RED WHEN: a word reaches a screen as JSX text, a child string, a template or a read prop, or a translation or a code is refused. */
  it('names every word put on a screen that is not a translation', () => {
    const f = src('x.tsx', `const a = <div title="Hello" aria-label={'Close'} className="px-2" data-x="word">
      Pay now {'Cancel'} {ok ? 'Yes' : t('kit.no')} {\`Sent \${n}\`} {t('kit.yes')} USDC {' '} {'—'}
      <img alt={t('kit.alt')} /> <input placeholder={t('kit.p')} /> <b>{name}</b> 42</div>;
      const s = 'Not on a screen';`);
    expect(whats(wordingInCode([f], allowed))).toEqual(['Hello', 'Close', 'Pay now', 'Cancel', 'Yes', 'Sent', '']
      .filter(Boolean));
  });

  /* RED WHEN: a word reaches a screen through createElement or a component's text prop, or a translated one is refused. */
  it('names words put on a screen by createElement or a text prop', () => {
    const f = src('x.tsx', `createElement('p', null, 'Payroll is coming');
      React.createElement('img', { alt: 'Logo', className: 'px-2' }, t('kit.ok'));
      createElement(Thing, { explanation: t('kit.why') });
      const a = <ComingSoon explanation="Export arrives in May" variant="outline" />;`);
    expect(whats(wordingInCode([f], allowed))).toEqual(['Payroll is coming', 'Logo', 'Export arrives in May']);
  });

  /* RED WHEN: a sentence in a shared module is missed, or a code or a key is taken for one. */
  it('names every English sentence in a module', () => {
    const f = src('shared.ts', `export const a = 'The vault has no signers.';
      throw new Error(\`Could not reach \${x}\`);
      const k = 'kit.public.label'; const c = 'USDC'; const w = 'word'; const i = 'Content-Type';
      // A comment is not code`);
    const lower = src('lower.ts', "throw new Error('a vault is pinned to its company'); const two = 'two words';");
    expect(whats(englishSentences([f]))).toEqual(['The vault has no signers.', 'Could not reach  ']);
    expect(whats(englishSentences([lower]))).toEqual(['a vault is pinned to its company']);
  });

  /* RED WHEN: a key asked for is missed, or a key built at run time is reported as a key. */
  it('finds every key asked for', () => {
    const f = src('x.tsx', "t('kit.a'); i18n.t(\"kit.b\"); t(`kit.c`); t(`kit.${x}`); t(key); other('kit.z');");
    expect(keysAskedFor(f).map((k) => k.key)).toEqual(['kit.a', 'kit.b', 'kit.c', null, null]);
    const renamed = src('y.tsx', "const say = useText(); say('kit.d'); const { t: tr } = useTranslation(); tr('kit.e'); const again = say; again('kit.f');");
    expect(keysAskedFor(renamed).map((k) => k.key)).toEqual(['kit.d', 'kit.e', 'kit.f']);
  });

  /* RED WHEN: a key that is only the start of another key, or a plural form asked for by name, counts as present. */
  it('finds a phrase by its key or its plural forms, and nothing else', () => {
    const en = { 'run.total_paid': 'x', 'run.people_one': 'x', 'run.people_other': 'x', 'kit.a': 'x' };
    expect(['kit.a', 'run.people', 'run.total_paid'].map((k) => hasPhrase(en, k))).toEqual([true, true, true]);
    expect(['run.total', 'run.people_one', 'kit'].map((k) => hasPhrase(en, k))).toEqual([false, false, false]);
  });
});

describe('amounts', () => {
  /* RED WHEN: an amount is turned into text anywhere but the amount component. */
  it('names every other way an amount becomes text', () => {
    const home = src('components/amount.tsx', "import { formatTokenAmount } from '../format/token-amount.js'; formatTokenAmount(1n, 2, 'en');");
    const other = src('apps/web/src/x.tsx', `import { formatTokenAmount } from 'vaults-ui/format/token-amount';
      const a = new Intl.NumberFormat('en').format(5n); const b = (5n).toLocaleString();
      const c = new Intl['NumberFormat']('en'); const { NumberFormat } = Intl; const d = n.toFixed(2);`);
    expect(whats(amountsOutsideTheComponent([home, other], ['components/amount.tsx'])))
      .toEqual(['formatTokenAmount', 'NumberFormat', 'toLocaleString', 'NumberFormat', 'NumberFormat', 'toFixed']);
  });
});

describe('language files', () => {
  const en = { 'kit.a': 'A {name}', 'x.count_one': '{count} person', 'x.count_other': '{count} people' };

  /* RED WHEN: a missing phrase, a missing plural form, a form the language does not have, or a stray key is let through. */
  it('names what a language file lacks or has too much of', () => {
    expect(missingPhrases(en, 'en', en)).toEqual([]);
    expect(missingPhrases(en, 'fr', { 'kit.a': 'A {name}', 'x.count_one': '', 'x.count_other': '' })).toEqual(['fr: x.count_many is missing']);
    expect(missingPhrases(en, 'ar', { 'x.count_one': '', 'x.count_other': '', 'x.count_few': '', 'x.count_many': '', 'x.count_two': '', 'x.count_zero': '', 'old': '' }))
      .toEqual(['ar: kit.a is missing', 'ar: old is not in the English file']);
    expect(missingPhrases(en, 'ja', { 'kit.a': '', 'x.count_other': '', 'x.count_one': '' })).toEqual(['ja: x.count_one is a plural form ja does not have']);
    expect(missingPhrases(en, 'de', { 'kit.a': '', 'x.count': '', 'x.count_one': '', 'x.count_other': '' })).toEqual(['de: x.count is plural in English and has no plural forms here']);
  });

  /* RED WHEN: a phrase whose gaps differ from English, in any plural form, is let through. */
  it('names every phrase whose gaps differ', () => {
    expect(gapsThatDiffer(en, 'de', { 'kit.a': 'B {name}', 'x.count_one': '{count} Person', 'x.count_other': '{count} Leute' })).toEqual([]);
    expect(gapsThatDiffer(en, 'de', { 'kit.a': 'B {nom}', 'x.count_one': 'eine Person', 'x.count_other': '{count} Leute' }).length).toBe(2);
    expect(gapsThatDiffer({ 'y_one': '{a}', 'y_other': '{b}' }, 'de', {})).toEqual(['en: the plural forms of y have different gaps']);
  });

  it('reads plural keys and gaps', () => {
    expect(pluralOf('a.b_few')).toEqual({ base: 'a.b', category: 'few' });
    expect(pluralOf('a.b_fewer')).toEqual({ base: 'a.b_fewer', category: null });
    expect(gapsOf('{b} and {a} and {b}')).toEqual(['a', 'b']);
  });
});
