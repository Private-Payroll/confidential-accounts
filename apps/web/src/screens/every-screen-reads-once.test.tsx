// @vitest-environment jsdom
/*
 * Every screen a company is read from reads the same at every size of the company: each page of each screen on the
 * inventory is opened twice on a device that has checked the company before, the second opening counted, then again
 * after the company grows its people, vendors, vaults and open proposals each by a number of its own. Every route, wallet ask and chain,
 * builder or indexer read must count the same at both sizes, each kind of record a read asks must be asked the same number of
 * times or one more for each one more of what the kind grows with, and every answer must carry what the service holds and what was asked. A page this harness cannot open is
 * named with why, so no screen on the inventory is passed over unsaid.
 */
import { describe, expect, it } from 'vitest';
import { PAGES } from '../pages.js';
import { aCompanyOf } from './company-harness.test-support.js';
import { SCREEN_PINS } from './screen-count-pins.test-support.js';
import { differences, NOT_OPENED, openedTwice, PAGES_COUNTED, readsOf, type PageId } from './screen-counts.test-support.js';
import { askedBeyondWhatGrew, carriedNotAsHeldIn } from './screen-carried.test-support.js';
import type { CompanyHeld, ScreenCount } from './company-harness.test-support.js';
import { tableHeld, tableSource } from './screen-pins-writer.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const OPENINGS = { timeout: 160_000 };

const ABOUT = 'The pages\' reads when opened twice by the founding seat\'s page, the second opening counted, on the company at its first size.';

/* A page opened twice by the founding seat's page, the second opening counted. */
const counted = (page: string) => openedTwice(company, page);

describe('EVERY SCREEN A COMPANY IS READ FROM READS THE SAME AT EVERY SIZE OF THE COMPANY', OPENINGS, () => {
  const atN = new Map<string, ScreenCount>();
  const heldAtN = new Map<string, CompanyHeld>();
  /* The company is grown once, by the first page counted grown; a page run alone by its name grows it itself. */
  let grown: Promise<void> | null = null;
  const grow = (): Promise<void> => (grown ??= company.growTo({ people: 7, vendors: 3, vaults: 5, proposals: 3 }));

  it('every page of a screen that reads a company is one the company opens, or is named with why it is not opened', () => {
    /* RED WHEN: a screen on the inventory draws a page that is not a company's page, so its reads are counted nowhere. */
    expect(PAGES_COUNTED.filter(({ page }) => !Object.hasOwn(PAGES, page))).toEqual([]);
    const notACompanysPage = PAGES_COUNTED.filter(({ page }) => PAGES[page as PageId].audience !== 'company' && !Object.hasOwn(NOT_OPENED, page));
    expect(notACompanysPage).toEqual([]);
    expect(PAGES_COUNTED.length).toBeGreaterThan(Object.keys(NOT_OPENED).length);
  });

  const opened = PAGES_COUNTED.filter(({ page }) => !Object.hasOwn(NOT_OPENED, page));

  for (const { page } of opened) {
    it(`page ${page} is counted on the company at its first size`, async () => {
      const count = await counted(page);
      const reads = readsOf(count);
      atN.set(page, count);
      heldAtN.set(page, company.held());
      /* RED WHEN: a page reads nothing of the company, so a count of it holds nothing to grow. */
      expect(Object.keys(reads)).not.toEqual([]);
      /* RED WHEN: a page reads differently at the first size than the reads every other count file holds its company to. */
      expect(reads).toEqual(SCREEN_PINS[page]);
      /* RED WHEN: an answer to this page carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
      expect(carriedNotAsHeldIn(page, count.calls)).toEqual([]);
    });
  }

  it('every page the inventory opens has reads pinned, and every pin is of a page it opens', () => {
    /* RED WHEN: a pin is held for a page no test here counts, or a page counted here has no pin. */
    expect(Object.keys(SCREEN_PINS).sort()).toEqual(opened.map(({ page }) => page).sort());
  });

  for (const { screen, page } of opened) {
    it(`page ${page} reads the same at the company grown`, async () => {
      /* RED WHEN: the first size of this page was not counted before it, so there is nothing to hold its growth to. */
      expect(atN.has(page), `page ${page} is counted at its first size before it is counted grown`).toBe(true);
      await grow();
      const [was, now] = [atN.get(page)!, await counted(page)];
      const differing = differences(`${screen} (${page})`, readsOf(was), readsOf(now), ['at the first size', 'grown']);
      /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this page grows with the company's people, vendors, vaults or proposals. */
      expect(differing).toEqual([]);
      /* RED WHEN: a read of this page asks of one kind of record other than the same number it asked at the first size or one more for each one more of what its kind grows with (`PAGE_ASKED_GROWS_WITH`), or asks a kind it did not, at the company grown. */
      expect(askedBeyondWhatGrew(`${screen} (${page})`, was.calls, now.calls, [heldAtN.get(page)!, company.held()], ['at the first size', 'grown'], page)).toEqual([]);
      /* RED WHEN: at the company grown, an answer to this page carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
      expect(carriedNotAsHeldIn(page, now.calls)).toEqual([]);
    });
  }

  it('the pins of the pages this run measures are the ones the pins writer writes from it', () => {
    const table = { name: 'SCREEN_PINS', about: ABOUT, of: 'reads', rows: Object.fromEntries([...atN].map(([page, count]) => [page, readsOf(count)])) } as const;
    /* RED WHEN: a pin of a page counted here is not what this run measured, or the pins file was changed by hand away from what its writer writes. */
    expect(tableHeld(table, opened.every(({ page }) => atN.has(page)))).toBe(tableSource(table));
  });
});
