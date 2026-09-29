// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KitProvider } from 'vaults-ui';
import { CATALOGUE as LEGACY } from '../../../../src/core/plugins.js';
import { LANGUAGES } from '../languages.js';
import { Apps } from './apps.js';

/*
 * THE APPS PAGE, AGAINST THE CATALOGUE IT IS TAKEN FROM: the legacy app's
 * catalogue and its category names, read from the legacy app's own files, so
 * a name, summary or category that drifts from them turns this red.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(readFileSync(resolve(HERE, '../locales/en.json'), 'utf8')) as Record<string, string>;
/** The legacy app's names for its categories, read from its source. */
const LABELS = Object.fromEntries([...readFileSync(resolve(HERE, '../../../../src/web-legacy/App.tsx'), 'utf8')
  .match(/const CATEGORY_LABEL[^{]*\{([^}]*)\}/)![1]!.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1]!, m[2]!]));

const draw = () => render(<KitProvider languages={LANGUAGES} pick="en"><Apps /></KitProvider>).container;
const text = (e: Element | null) => e?.textContent ?? null;
afterEach(cleanup);

/** The cards shown, in order: each app's category, name and summary. */
const cards = (c: Element) => [...c.querySelectorAll('[data-app]')].map((r) => [text(r.querySelector('[data-app-category]')), text(r.querySelector('[data-app-name]')), text(r.querySelector('[data-app-summary]'))]);
const XERO = LEGACY.find((a) => a.id === 'xero-sync')!;
/** The legacy catalogue as the page shows it: grouped by category in the legacy order, QuickBooks straight after Xero, in its shape. */
const GROUPS = [...new Set(LEGACY.map((a) => a.category))];
const EXPECTED = GROUPS.flatMap((g) => LEGACY.filter((a) => a.category === g)
  .flatMap((a) => (a.id === XERO.id ? [[LABELS[g], a.name, a.summary], [LABELS[g], 'QuickBooks Sync', XERO.summary]] : [[LABELS[g], a.name, a.summary]])));
const filters = (c: Element) => [...c.querySelectorAll('[data-app-filters] button')] as HTMLButtonElement[];
const press = async (b: HTMLElement) => { await act(async () => { fireEvent.click(b); }); };

describe('apps', () => {
  /*
   * RED WHEN: an app of the legacy catalogue is missing, renamed, or shown with
   * another summary or category; a category is named other than the legacy app
   * names it; the apps are in another order than the legacy app lists them by
   * category; QuickBooks is missing, not straight after Xero, or not in Xero's
   * shape; any other app is added; or a publisher is shown.
   */
  it('shows the legacy catalogue exactly, one card per app, with QuickBooks beside Xero and no publisher', () => {
    const c = draw();
    expect(cards(c)).toEqual(EXPECTED);
    expect(LEGACY.length).toBe(10);
    expect(GROUPS).toEqual(['interop', 'offramp', 'treasury', 'accounting', 'compliance']);
    /* A publisher that is not also part of an app's name is nowhere on the page. */
    for (const p of new Set(LEGACY.map((a) => a.publisher).filter((p) => !LEGACY.some((a) => a.name.includes(p))))) expect(c.textContent, p).not.toContain(p);
    expect(Object.keys(EN).filter((k) => k.endsWith('.publisher'))).toEqual([]);
  });

  /* RED WHEN: a card has no Coming soon pill, has more than one, or the pill is not at the card's top right; an Install, or any button but the filters, is drawn; or the heading carries a pill. */
  it('marks every card Coming soon at its top right, with no Install and no pill on the heading', () => {
    const c = draw();
    const rows = [...c.querySelectorAll('[data-app]')];
    expect(rows.length).toBe(11);
    /* One grid for every card, with no headings between them. */
    expect([...new Set(rows.map((r) => r.parentElement))]).toEqual([c.querySelector('[data-app-grid]')]);
    expect(c.querySelectorAll('[data-screen=apps] h2').length).toBe(0);
    for (const r of rows) {
      const pills = [...r.querySelectorAll('[data-slot=coming-soon]')];
      expect(pills.length, text(r.querySelector('[data-app-name]'))!).toBe(1);
      expect(pills[0]!.closest('[data-slot=card-action]')?.parentElement?.getAttribute('data-slot')).toBe('card-header');
    }
    expect(c.querySelectorAll('button:not([data-slot=coming-soon]):not([data-app-filter])').length).toBe(0);
    expect(c.textContent).not.toMatch(/install\b/i);
    expect(c.querySelector('[data-slot=page-header] [data-slot=coming-soon]')).toBeNull();
    expect(text(c.querySelector('[data-slot=page-header] h1'))).toBe(EN['page.apps.name']);
  });

  /*
   * RED WHEN: the categories are not tags across the top in the legacy order;
   * with none chosen, not every app is shown; choosing one or several does not
   * show exactly the apps in those, in order; a tag does not say whether it is
   * on; or choosing a tag again does not take it off.
   */
  it('filters by one or several category tags, and shows every app with none chosen', async () => {
    const c = draw();
    expect(filters(c).map((b) => [text(b), b.getAttribute('aria-pressed')])).toEqual(GROUPS.map((g) => [LABELS[g], 'false']));
    expect(c.querySelector('[data-app-filters]')!.compareDocumentPosition(c.querySelector('[data-app]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const only = (...labels: string[]) => EXPECTED.filter((e) => labels.includes(e[0]!));
    /* Chosen out of order, the apps still show in the catalogue's order. */
    await press(filters(c)[4]!);
    expect(cards(c)).toEqual(only(LABELS.compliance!));
    await press(filters(c)[3]!);
    expect(cards(c)).toEqual(only(LABELS.accounting!, LABELS.compliance!));
    expect(filters(c).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'true']);
    await press(filters(c)[3]!);
    expect(cards(c)).toEqual(only(LABELS.compliance!));
    expect(filters(c).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false', 'true']);
    await press(filters(c)[4]!);
    expect(cards(c)).toEqual(EXPECTED);
  });
});
