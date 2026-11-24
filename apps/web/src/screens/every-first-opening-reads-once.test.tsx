// @vitest-environment jsdom
/*
 * A page's first opening on a device that has not checked the company before is counted on its own, apart from the openings
 * after it. A seat's page opens the People screen for the first time: it reads what the device has not kept (every header of
 * the anchor, the seats' openings and the proposals' identities from its own builder), and its next opening reads what a
 * device that has checked the company reads. Each device has a builder of its own, so what one device has kept is never what
 * another's first opening finds. The first opening is pinned at the company's first size and grown, and what differs
 * between them is named.
 */
import { describe, expect, it } from 'vitest';
import { aCompanyOf, openScreen } from './company-harness.test-support.js';
import { askedBeyondWhatGrew, carriedNotAsHeldIn, type Called } from './screen-carried.test-support.js';
import type { CompanyHeld } from './company-harness.test-support.js';
import { differences, readsOf, type Reads } from './screen-counts.test-support.js';
import { FIRST_OPENING_PINS } from './screen-count-pins.test-support.js';
import { tableHeld, tableSource } from './screen-pins-writer.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const [, SECOND, THIRD] = company.seats().map((s) => s.person) as [string, string, string];

const ABOUT = 'A seat\'s first opening of the People screen on a device that has not checked the company, the next opening on that device, and another seat\'s first opening at the company grown.';

describe('A PAGE OPENED FOR THE FIRST TIME ON A DEVICE IS COUNTED ON ITS OWN, APART FROM THE OPENINGS AFTER IT', { timeout: 160_000 }, () => {
  /* What this run measured, for the pins writer. */
  const measured: Record<string, Reads> = {};
  let callsAtN: readonly Called[] = [];
  let heldAtN: CompanyHeld | null = null;

  it('a seat\'s first opening reads what its device has not kept, and its next opening reads what a device that has checked the company reads', async () => {
    const opened = await openScreen(company, SECOND, 'people');
    const [first, next] = [readsOf(opened), readsOf(await openScreen(company, SECOND, 'people'))];
    callsAtN = opened.calls;
    heldAtN = company.held();
    measured['firstAtN'] = first;
    measured['nextAtN'] = next;
    /* RED WHEN: a first opening reads differently than it did when measured: more or fewer headers, openings or identities asked of its own builder. */
    expect(first).toEqual(FIRST_OPENING_PINS['firstAtN']);
    /* RED WHEN: a first opening is counted as the ones after it, so the reads a new device makes are hidden by what another device kept. */
    expect(Object.keys(first)).toEqual(expect.arrayContaining(['builder seatOpenings', 'builder proposalIdentity']));
    /* RED WHEN: an answer to a first opening carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
    expect(carriedNotAsHeldIn('first opening', opened.calls)).toEqual([]);
    expect(Object.keys(next)).not.toContain('builder seatOpenings');
    /* RED WHEN: the next opening on the same device reads what the first did: nothing is kept. */
    expect(next).toEqual(FIRST_OPENING_PINS['nextAtN']);
  });

  it('a first opening at the company grown reads the same', async () => {
    await company.growTo({ people: 7, vendors: 3, vaults: 5, proposals: 3 });
    const opened = await openScreen(company, THIRD, 'people');
    const first = readsOf(opened);
    measured['firstAt2N'] = first;
    /* RED WHEN: another seat's first opening at the company grown reads differently than it did when measured. */
    expect(first).toEqual(FIRST_OPENING_PINS['firstAt2N']);
    /* RED WHEN: any read of a first opening grows with the company's records. */
    expect(differences('people', FIRST_OPENING_PINS['firstAtN']!, first, ['at the first size', 'grown'])).toEqual([]);
    /* RED WHEN: a read of a first opening asks of one kind of record other than the same number it asked at the first size or one more for each one more of what its kind grows with (`PAGE_ASKED_GROWS_WITH`), or asks a kind it did not, at the company grown. */
    expect(askedBeyondWhatGrew('first opening', callsAtN, opened.calls, [heldAtN!, company.held()], ['at the first size', 'grown'])).toEqual([]);
    /* RED WHEN: at the company grown, an answer to a first opening carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
    expect(carriedNotAsHeldIn('first opening', opened.calls)).toEqual([]);
  });

  it('the pins of the first openings this run measures are the ones the pins writer writes from it', () => {
    const table = { name: 'FIRST_OPENING_PINS', about: ABOUT, of: 'reads', rows: measured } as const;
    /* RED WHEN: a pin of a first opening is not what this run measured, or the pins file was changed by hand away from what its writer writes. */
    expect(tableHeld(table, ['firstAtN', 'nextAtN', 'firstAt2N'].every((n) => Object.hasOwn(measured, n)))).toBe(tableSource(table));
  });
});
