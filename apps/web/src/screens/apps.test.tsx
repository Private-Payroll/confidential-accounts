// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KitProvider } from 'vaults-ui';
import { LANGUAGES } from '../languages.js';
import { Apps } from './apps.js';

/*
 * THE APPS PAGE, AGAINST THE CATALOGUE IT IS TAKEN FROM: the ten apps the
 * earlier application listed, written out below, the page's own locale file,
 * and the category names the earlier application gave them, so a name,
 * summary or category that drifts from them turns this red.
 */

/**
 * THE TEN APPS THE EARLIER APPLICATION LISTED, written out here: each one's
 * id, name, publisher, category and summary, in the order it listed them.
 */
const LEGACY: readonly { id: string; name: string; publisher: string; category: string; summary: string }[] = [
  { id: 'safe-bridge', name: 'Safe Connect', publisher: 'First party', category: 'interop',
    summary: 'Use an existing Safe on another chain as the source of funds. Assets never move. Deliberation and policy run here, the Safe keeps enforcing its own threshold.' },
  { id: 'moneygram-payout', name: 'MoneyGram Payout', publisher: 'MoneyGram', category: 'offramp',
    summary: 'Cash collection in 100+ countries. Employees convert salary without a bank account. Only the aggregate and the recipient reference leave the account.' },
  { id: 'wise-payout', name: 'Wise Transfers', publisher: 'Wise', category: 'offramp',
    summary: 'Multi currency payout to local bank accounts at interbank rates. Handles the leg between settlement and an employee bank account.' },
  { id: 'monument-gbp', name: 'Monument Deposits', publisher: 'Monument Bank', category: 'offramp',
    summary: 'Fund payroll from a UK bank account in tokenised sterling. No stablecoin conversion and no offramp needed, because the asset is already a regulated deposit.' },
  { id: 'treasury-yield', name: 'Treasury Yield', publisher: 'Community', category: 'treasury',
    summary: 'Deploy idle treasury into lending markets without publishing the strategy. Proposes moves inside an allowance you set. It cannot move funds on its own.' },
  { id: 'xero-sync', name: 'Xero Sync', publisher: 'Community', category: 'accounting',
    summary: 'Posts settled payroll to your ledger as a single journal entry. Reads totals only, so your accounting integration never holds individual salaries.' },
  { id: 'hmrc-rti', name: 'HMRC Real Time Information', publisher: 'Community', category: 'compliance',
    summary: 'Files UK payroll submissions from an attestation rather than a spreadsheet of salaries. Issues the proof, submits the return.' },
  { id: 'auditor-portal', name: 'Auditor Portal', publisher: 'First party', category: 'compliance',
    summary: 'Scoped, time boxed access for an external accountant. They verify what they need and see nothing else, and the grant expires on its own.' },
  { id: 'vesting', name: 'Vesting and Cap Table', publisher: 'Community', category: 'treasury',
    summary: 'Scheduled disbursement with shielded amounts on the same engine as payroll. Cliffs are provable without being publicly trackable.' },
  { id: 'contributor-bounties', name: 'Contributor Payouts', publisher: 'Community', category: 'treasury',
    summary: 'Pay contributors and bounty claimants from the same account, confidentially, without adding them to the payroll roster.' },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(readFileSync(resolve(HERE, '../locales/en.json'), 'utf8')) as Record<string, string>;
/** The category names, as the earlier application named them. */
const LABELS: Record<string, string> = {
  offramp: 'Payouts and offramp', treasury: 'Treasury', interop: 'Interoperability',
  compliance: 'Compliance', accounting: 'Accounting', identity: 'Identity',
};

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
