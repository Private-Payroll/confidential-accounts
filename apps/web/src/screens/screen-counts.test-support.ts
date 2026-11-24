/*
 * How a screen's reads are counted and compared, for every file that counts them: the pages the inventory names and the
 * ones this harness cannot open, what a page read when opened twice by the founding seat's page (the second opening
 * counted), and the comparison of that with the pinned reads, each difference named by its screen, page and route or ask.
 * A file for one size of the company makes the company, then calls `screensCountedOn` once. Each page is a test of its own, so
 * a page that is red is named, and one page is run alone by its name (`-t 'page vault '`).
 */
import { describe, expect, it } from 'vitest';
import { COMPANY_VIEW_INVENTORY } from 'vaults-web-shared/company-view-inventory.js';
import { PAGES } from '../pages.js';
import { openScreen, type CompanyHeld, type CompanyOpened, type CompanySize, type ScreenCount } from './company-harness.test-support.js';
import { askedBeyondWhatGrew, carriedNotAsHeldIn } from './screen-carried.test-support.js';

export type PageId = keyof typeof PAGES;
/** What one opening read: each route and wallet ask by name, and each read through a door by door and ask, with its count. */
export type Reads = Readonly<Record<string, number>>;

/* The pages the harness does not open, and why: each is still on the inventory, and its count is owed. */
export const NOT_OPENED: Readonly<Record<string, string>> = Object.freeze({
  run: 'this company raises no runs, so no run has a page to open',
  superAdminsByLink: 'it is opened from the link a super admin is sent, by a person who is not yet one of the company\'s pages\' viewers',
});

/** Every page of every screen on the inventory that reads a company. */
export const PAGES_COUNTED = COMPANY_VIEW_INVENTORY.filter((p) => p.kind === 'screen' && p.reads === 'company')
  .flatMap((p) => (p.pages ?? []).map((page) => ({ screen: p.name, page })));
/** Every page the harness opens. */
export const PAGES_OPENED = PAGES_COUNTED.filter(({ page }) => !Object.hasOwn(NOT_OPENED, page));
/** The pages of the settings, which a count file for a company too large to open them all in one run takes apart from the rest. */
export const inTheSettings = (page: string): boolean => page.startsWith('settings');

export const paramsOf = (company: CompanyOpened, page: string): Record<string, string> => (page === 'vault' ? { vault: company.vaults()[0]! } : {});
export const readsOf = (c: ScreenCount): Reads => ({
  ...Object.fromEntries(Object.entries(c.routes).map(([r, n]) => [`route ${r}`, n])),
  ...Object.fromEntries(Object.entries(c.wallet).map(([a, n]) => [`wallet ${a}`, n])),
  ...c.asks,
});

/** Each read that differs between two counts of one page, named by its screen, page and route or ask. */
export const differences = (where: string, was: Reads, now: Reads, labels: readonly [string, string]): string[] =>
  [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((k) => (was[k] ?? 0) !== (now[k] ?? 0))
    .map((k) => `${where}: ${k} ${was[k] ?? 0} ${labels[0]}, ${now[k] ?? 0} ${labels[1]}`);
/** A page opened twice by the founding seat's page, the second opening counted. */
export const openedTwice = async (company: CompanyOpened, page: string): Promise<ScreenCount> => {
  const founder = company.seats()[0]!.person;
  await openScreen(company, founder, page as PageId, paramsOf(company, page));
  return openScreen(company, founder, page as PageId, paramsOf(company, page));
};

/** What this company asks of each page beyond the pinned reads: `more`, by read, is what every page asks more than the pinned count. */
export interface SeedHeld {
  readonly pins: Readonly<Record<string, Reads>>;
  readonly more?: Reads;
  /** The pages this file opens, where it opens only some of them; the files that do together open every page. */
  readonly only?: (page: string) => boolean;
  readonly labels: readonly [string, string];
}

/**
 * Opens every page on the inventory on `company` and holds each to its pinned reads, with `more` added to the pinned count
 * of each read it names.
 */
export function screensCountedOn(company: CompanyOpened, held: SeedHeld): void {
  const opened = PAGES_OPENED.filter(({ page }) => held.only?.(page) ?? true);
  describe('EVERY SCREEN READS THE SAME ON THIS COMPANY AS ON THE PINNED ONE (FLAT BY SIZE: A MEASURED COUNT, NOT A BUDGET)', { timeout: 160_000 }, () => {
    it('every page on the inventory has reads pinned, or is named as not opened', () => {
      /* RED WHEN: a page that reads a company is opened here with no pinned reads to hold it to. */
      expect(opened.map(({ page }) => page).filter((p) => !Object.hasOwn(held.pins, p))).toEqual([]);
      /* RED WHEN: reads are pinned for a page the inventory does not draw. */
      expect(Object.keys(held.pins).filter((p) => !PAGES_OPENED.some(({ page }) => page === p))).toEqual([]);
      /* RED WHEN: this file opens no page. */
      expect(opened.length).toBeGreaterThan(0);
    });

    for (const { screen, page } of opened) {
      it(`page ${page} is opened on a device that has checked the company before, and every read of it is held to the pinned one`, async () => {
        const pinned = Object.fromEntries(Object.entries(held.pins[page]!).map(([k, n]) => [k, n + (held.more?.[k] ?? 0)]));
        const count = await openedTwice(company, page);
        /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this page differs from the pinned reads. */
        expect(differences(`${screen} (${page})`, pinned, readsOf(count), held.labels)).toEqual([]);
        /* RED WHEN: an answer to this page carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
        expect(carriedNotAsHeldIn(`${screen} (${page})`, count.calls)).toEqual([]);
      });
    }
  });
}

/*
 * The company the pages are counted on as its money grows: no person only invited (a run is drawn only when everyone on the
 * roster is admitted), a run raised and paid, a one-off payment open and a spending policy set at its first size; then more
 * of each, each by a number of its own, so a page that reads one record more for each run, paid run, one-off payment or
 * policy is told apart.
 */
export const MONEY_FIRST: CompanySize = { people: 0, vendors: 2, vaults: 4, proposals: 1, runs: 1, payments: 1, oneOffs: 1, policies: 1 };
export const MONEY_GROWN: CompanySize = { ...MONEY_FIRST, runs: 5, payments: 4, oneOffs: 2, policies: 3 };

/**
 * Opens every page this file opens (`only`) on `company`, made at `MONEY_FIRST`, then again after it grows its runs, paid
 * runs, one-off payments and spending policies (`MONEY_GROWN`): every read counts the same at both, each kind of record a
 * read asks is asked the same number of times or one more for each one more of what the kind grows with, and every answer
 * carries what the service holds and what was asked.
 */
export function screensCountedAsMoneyGrows(company: CompanyOpened, only: (page: string) => boolean): void {
  const opened = PAGES_OPENED.filter(({ page }) => only(page));
  describe('EVERY SCREEN READS THE SAME HOWEVER MANY RUNS, PAID RUNS, ONE-OFF PAYMENTS AND SPENDING POLICIES THE COMPANY HOLDS', { timeout: 160_000 }, () => {
    const atN = new Map<string, { readonly count: ScreenCount; readonly held: CompanyHeld }>();
    let grown: Promise<void> | null = null;
    for (const { page } of opened) {
      it(`page ${page} is counted on the company at its first size`, async () => {
        const count = await openedTwice(company, page);
        atN.set(page, { count, held: company.held() });
        /* RED WHEN: a page reads nothing of the company, so a count of it holds nothing to grow. */
        expect(Object.keys(readsOf(count))).not.toEqual([]);
        /* RED WHEN: an answer to this page carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked. */
        expect(carriedNotAsHeldIn(page, count.calls)).toEqual([]);
      });
    }
    for (const { screen, page } of opened) {
      it(`page ${page} reads the same with more runs, paid runs, one-off payments and spending policies`, async () => {
        /* RED WHEN: the first size of this page was not counted before it, so there is nothing to hold its growth to. */
        expect(atN.has(page), `page ${page} is counted at its first size before it is counted grown`).toBe(true);
        await (grown ??= company.growTo(MONEY_GROWN));
        const was = atN.get(page)!;
        const now = await openedTwice(company, page);
        const labels = ['at the first size', 'grown'] as const;
        /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this page grows with the company's runs, paid runs, one-off payments or spending policies. */
        expect(differences(`${screen} (${page})`, readsOf(was.count), readsOf(now), labels)).toEqual([]);
        /* RED WHEN: a read of this page asks of a kind of record other than the same number or one more for each one more of what its kind grows with (`PAGE_ASKED_GROWS_WITH`), or asks a kind it did not. */
        expect(askedBeyondWhatGrew(`${screen} (${page})`, was.count.calls, now.calls, [was.held, company.held()], labels, page)).toEqual([]);
        /* RED WHEN: grown, an answer to this page carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
        expect(carriedNotAsHeldIn(page, now.calls)).toEqual([]);
      });
    }
  });
}
