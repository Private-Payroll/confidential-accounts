// @vitest-environment jsdom
/*
 * Every screen a company is read from reads the same at every size of the company: each page of each screen on the
 * inventory is opened twice on a device that has checked the company before, the second opening counted, then again
 * after the company grows to twice its people, vendors, vaults and open proposals. Every route, wallet ask and chain,
 * builder or indexer read must count the same at both sizes, but a read named as still growing, with why. A page this
 * harness cannot open is named with why, so no screen on the inventory is passed over unsaid.
 */
import { describe, expect, it } from 'vitest';
import { PAGES } from '../pages.js';
import { aCompanyOf } from './company-harness.test-support.js';
import { SCREEN_PINS } from './screen-count-pins.test-support.js';
import { differences, grownAs, NOT_OPENED, openedTwice, PAGES_COUNTED, STILL_GROWS_WITH_VAULTS, type PageId } from './screen-counts.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const OPENINGS = { timeout: 160_000 };

/*
 * The reads that still grow with the company, each named by the screen, page and ask, with why. Each must still be
 * found growing, so once it is made flat its line is taken off here.
 */
const STILL_GROWS: Readonly<Record<string, string>> = STILL_GROWS_WITH_VAULTS;

/* A page opened twice by the founding seat's page, the second opening counted. */
const counted = (page: string) => openedTwice(company, page);

describe('EVERY SCREEN A COMPANY IS READ FROM READS THE SAME AT EVERY SIZE OF THE COMPANY', OPENINGS, () => {
  const atN = new Map<string, Record<string, number>>();
  /* The company is grown once, by the first page counted at twice its size; a page run alone by its name grows it itself. */
  let grown: Promise<void> | null = null;
  const grow = (): Promise<void> => (grown ??= company.growTo({ people: 6, vendors: 4, vaults: 4, proposals: 2 }));

  it('every page of a screen that reads a company is one the company opens, or is named with why it is not opened', () => {
    /* RED WHEN: a screen on the inventory draws a page that is not a company's page, so its reads are counted nowhere. */
    expect(PAGES_COUNTED.filter(({ page }) => !Object.hasOwn(PAGES, page))).toEqual([]);
    const notACompanysPage = PAGES_COUNTED.filter(({ page }) => PAGES[page as PageId].audience !== 'company' && !Object.hasOwn(NOT_OPENED, page));
    expect(notACompanysPage).toEqual([]);
    expect(PAGES_COUNTED.length).toBeGreaterThan(Object.keys(NOT_OPENED).length);
  });

  const opened = PAGES_COUNTED.filter(({ page }) => !Object.hasOwn(NOT_OPENED, page));
  const changed: string[] = [];

  for (const { page } of opened) {
    it(`page ${page} is counted on the company at its first size`, async () => {
      const reads = await counted(page);
      atN.set(page, reads);
      /* RED WHEN: a page reads nothing of the company, so a count of it holds nothing to grow. */
      expect(Object.keys(reads)).not.toEqual([]);
      /* RED WHEN: a page reads differently at the first size than the reads every other count file holds its company to. */
      expect(reads).toEqual(SCREEN_PINS[page]);
    });
  }

  it('every page the inventory opens has reads pinned, and every pin is of a page it opens', () => {
    /* RED WHEN: a pin is held for a page no test here counts, or a page counted here has no pin. */
    expect(Object.keys(SCREEN_PINS).sort()).toEqual(opened.map(({ page }) => page).sort());
  });

  for (const { screen, page } of opened) {
    it(`page ${page} reads the same at twice the company's records`, async () => {
      /* RED WHEN: the first size of this page was not counted before it, so there is nothing to hold its growth to. */
      expect(atN.has(page), `page ${page} is counted at its first size before it is counted at twice it`).toBe(true);
      await grow();
      const differing = differences(`${screen} (${page})`, atN.get(page)!, await counted(page), ['at the first size', 'at twice it']);
      changed.push(...differing);
      /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this page grows with the company's people, vendors, vaults or proposals. */
      expect(differing.filter((d) => grownAs(STILL_GROWS, d) === undefined)).toEqual([]);
    });
  }

  it('every read named as still growing is still found growing', () => {
    /* RED WHEN: a read named as still growing no longer grows, and is still named here. */
    expect(Object.keys(STILL_GROWS).filter((k) => !changed.some((d) => grownAs(STILL_GROWS, d) === k))).toEqual([]);
  });
});
