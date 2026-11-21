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
import { openScreen, type CompanyOpened, type ScreenCount } from './company-harness.test-support.js';

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
const readNamed = (difference: string): string => difference.replace(/^[^:]*: /u, '');
/** A difference named by its page first (`vaults: route ...`), so a read that grows on one page only is named for that page. */
const onItsPage = (difference: string): string => difference.replace(/^[^(]*\(([^)]*)\): /u, '$1: ');
/** The line of `stillGrows` that names a difference, if one does: each names a read, for every page that makes it, or a page and a read (`vaults: route ...`). */
export const grownAs = (stillGrows: Readonly<Record<string, string>>, difference: string): string | undefined =>
  Object.keys(stillGrows).find((k) => readNamed(difference).startsWith(`${k} `) || onItsPage(difference).startsWith(`${k} `));

/**
 * What still grows with the company's vaults, each named by its page and read, with why: nothing today. A page that
 * draws every vault's name declares them all to its view first, so the tree's proofs stay the same however many vaults.
 */
export const STILL_GROWS_WITH_VAULTS: Readonly<Record<string, string>> = Object.freeze({});

/** A page opened twice by the founding seat's page, the second opening counted. */
export const openedTwice = async (company: CompanyOpened, page: string): Promise<Reads> => {
  const founder = company.seats()[0]!.person;
  await openScreen(company, founder, page as PageId, paramsOf(company, page));
  return readsOf(await openScreen(company, founder, page as PageId, paramsOf(company, page)));
};

/** What this company asks of each page beyond the pinned reads: `more`, by read, is what every page asks more than the pinned count. */
export interface SeedHeld {
  readonly pins: Readonly<Record<string, Reads>>;
  readonly more?: Reads;
  /** The pages this file opens, where it opens only some of them; the files that do together open every page. */
  readonly only?: (page: string) => boolean;
  readonly stillGrows: Readonly<Record<string, string>>;
  readonly labels: readonly [string, string];
}

/**
 * Opens every page on the inventory on `company` and holds each to its pinned reads, with `more` added to the pinned count
 * of each read it names, but the reads named in `stillGrows`, each with why; each of those must still be found differing.
 */
export function screensCountedOn(company: CompanyOpened, held: SeedHeld): void {
  const opened = PAGES_OPENED.filter(({ page }) => held.only?.(page) ?? true);
  describe('EVERY SCREEN READS THE SAME ON THIS COMPANY AS ON THE PINNED ONE (FLAT BY SIZE: A MEASURED COUNT, NOT A BUDGET)', { timeout: 160_000 }, () => {
    const changed: string[] = [];
    const counted = new Set<string>();
    /* A read named for a page this file does not open cannot be found growing here. */
    const onAPageOpenedHere = (key: string): boolean => { const page = /^(\w+): /u.exec(key)?.[1]; return page === undefined || opened.some((o) => o.page === page); };

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
        const differing = differences(`${screen} (${page})`, pinned, await openedTwice(company, page), held.labels);
        changed.push(...differing);
        counted.add(page);
        /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this page differs from the pinned reads, apart from those named as still growing. */
        expect(differing.filter((d) => grownAs(held.stillGrows, d) === undefined)).toEqual([]);
      });
    }

    it('every read named as still growing is still found growing', () => {
      /* RED WHEN: this file counted no page, so what it names as still growing was held to nothing. */
      expect([...counted].length).toBe(opened.length);
      /* RED WHEN: a read named as still growing no longer differs, and is still named here. */
      expect(Object.keys(held.stillGrows).filter(onAPageOpenedHere).filter((k) => !changed.some((d) => grownAs(held.stillGrows, d) === k))).toEqual([]);
    });
  });
}
