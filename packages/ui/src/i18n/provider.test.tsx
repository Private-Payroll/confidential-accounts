// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider, useLanguage, useText } from './provider.js';
import { chooseLanguage, directionOf, languagesFrom } from './languages.js';

afterEach(cleanup);

/* Two languages, as an application's files would give them. French lacks one phrase on purpose. */
const FILES = {
  './locales/en.json': { 'x.hello': 'Hello {name}', 'x.people_one': '{count} person', 'x.people_other': '{count} people', 'x.only.english': 'Only in English' },
  './locales/fr.json': { 'x.hello': 'Bonjour {name}', 'x.people_one': '{count} personne', 'x.people_many': '{count} de personnes', 'x.people_other': '{count} personnes' },
};

function Show({ k, values }: { k: string; values?: Record<string, unknown> }) {
  const t = useText();
  return <p data-testid="p" data-lang={useLanguage()}>{t(k, values)}</p>;
}
const shown = (tag: string, k: string, values?: Record<string, unknown>) => {
  cleanup();
  render(<LanguageProvider languages={languagesFrom(FILES)} pick={tag}><Show k={k} values={values} /></LanguageProvider>);
  return screen.getByTestId('p').textContent;
};

describe('the language provider', () => {
  /* RED WHEN: a named gap is not filled, so a person reads `{name}`. */
  it('fills named gaps', () => {
    expect(shown('en', 'x.hello', { name: 'Ana' })).toBe('Hello Ana');
    expect(shown('fr', 'x.hello', { name: 'Ana' })).toBe('Bonjour Ana');
  });

  /* RED WHEN: the plural form is not the one the language needs for the count. */
  it('takes the plural form the language needs', () => {
    expect([1, 2].map((count) => shown('en', 'x.people', { count }))).toEqual(['1 person', '2 people']);
    expect([1, 2, 1_000_000].map((count) => shown('fr', 'x.people', { count }))).toEqual(['1 personne', '2 personnes', '1000000 de personnes']);
  });

  /* RED WHEN: a phrase missing from a language shows its key instead of the English. */
  it('falls back to English for a missing phrase', () => {
    expect(shown('fr', 'x.only.english')).toBe('Only in English');
  });

  /* RED WHEN: the page's lang or dir does not follow the language shown. */
  it('sets the page\'s language and direction', () => {
    const files = { ...FILES, './locales/ar.json': { 'x.hello': 'مرحبا {name}' } };
    render(<LanguageProvider languages={languagesFrom(files)} pick="ar"><Show k="x.hello" values={{ name: 'Ana' }} /></LanguageProvider>);
    expect([document.documentElement.lang, document.documentElement.dir]).toEqual(['ar', 'rtl']);
    cleanup();
    render(<LanguageProvider languages={languagesFrom(files)} pick="fr"><Show k="x.hello" /></LanguageProvider>);
    expect([document.documentElement.lang, document.documentElement.dir]).toEqual(['fr', 'ltr']);
  });
});

describe('the languages', () => {
  /* RED WHEN: a new file is not offered, so a language needs code to appear; or English is not first. */
  it('offers every file, English first, and a new file with no code change', () => {
    expect(languagesFrom(FILES).map((l) => l.tag)).toEqual(['en', 'fr']);
    const more = { './locales/pt-BR.json': { 'x.hello': 'Olá {name}' }, ...FILES, './locales/de.json': {} };
    expect(languagesFrom(more).map((l) => l.tag)).toEqual(['en', 'de', 'fr', 'pt-BR']);
  });

  /* RED WHEN: a file not named by a tag, a nested file, or a set with no English is taken. */
  it('refuses what is not a language file', () => {
    expect(() => languagesFrom({ ...FILES, './locales/en_GB.json': {} })).toThrow(/not named by a language tag/);
    expect(() => languagesFrom({ ...FILES, './locales/pt-br.json': {} })).toThrow(/the tag is written pt-BR/);
    expect(() => languagesFrom({ ...FILES, './locales/de.json': { a: { b: 'c' } } })).toThrow(/each a string/);
    expect(() => languagesFrom({ './locales/fr.json': {} })).toThrow(/there is no en\.json/);
  });

  /* RED WHEN: the person's pick is overridden, the browser's language is ignored, or a missing one is not English. */
  it('chooses the pick, else the browser\'s, else English', () => {
    const offered = languagesFrom({ ...FILES, './locales/pt.json': {} });
    expect(chooseLanguage(offered, 'fr', ['pt'])).toBe('fr');
    expect(chooseLanguage(offered, 'xx', ['de', 'pt-BR'])).toBe('pt');
    expect(chooseLanguage(offered, null, ['de'])).toBe('en');
  });

  /* RED WHEN: a right-to-left language is written left to right, or the reverse. */
  it('knows which way a language is written', () => {
    expect(['ar', 'he', 'fa', 'ur', 'en', 'fr', 'ja', 'ar-EG'].map(directionOf)).toEqual(['rtl', 'rtl', 'rtl', 'rtl', 'ltr', 'ltr', 'ltr', 'rtl']);
  });
});
