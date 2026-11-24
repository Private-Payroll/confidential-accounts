// @vitest-environment jsdom
/*
 * Raising a run from its panel on the payroll page reads the same at every size of the company: the panel is opened inside the
 * screen that draws it and a press on it is taken, counted apart, on a company of no person only invited (the wallet draws a run
 * only when every person on the roster is admitted, so each press admits a payee first), then again after the company grows its
 * vendors, vaults and open proposals each by a number of its own. Each press raises a run for a month of its own, paid in public from the first vault.
 */
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { untilShown } from '../page-shown.test-support.js';
import { aCompanyOf, openScreenAnd, payeeAdmittedBy, type ScreenCount } from './company-harness.test-support.js';
import { buttonNamed, joined, opensOnTheRoot, rootOf } from './panel-steps.test-support.js';
import { askedBeyondWhatGrew, askedKindsChanged, carriedNotAsHeldIn } from './screen-carried.test-support.js';
import type { CompanyHeld } from './company-harness.test-support.js';
import { RUN_PANEL_PINS } from './screen-count-pins.test-support.js';
import { differences, readsOf } from './screen-counts.test-support.js';
import { tableHeld, tableSource, type PinnedOpening } from './screen-pins-writer.test-support.js';

const company = aCompanyOf({ people: 0, vendors: 2, vaults: 2, proposals: 1 });
const FOUNDER = company.seats()[0]!.person;
const ABOUT = 'The run panel opened inside the payroll screen, and pressed, on a company of no person only invited, at the company\'s first size.';
const LABELS = ['at the first size', 'grown'] as const;

/* A month of its own for each press, so no press raises a run for a month that already has one. */
let months = 0;
const day = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);
const choose = async (find: () => HTMLElement | null, what: string, value?: string): Promise<void> => {
  const field = await untilShown(find, what, 30_000);
  if (value === undefined) fireEvent.click(field); else fireEvent.change(field, { target: { value } });
};
const raisesTheRun = joined([
  async () => {
    months += 1;
    await choose(() => document.querySelector<HTMLElement>('[data-field="month"]'), 'the month', `2027-${String(months).padStart(2, '0')}`);
    await choose(() => document.querySelector<HTMLElement>('[data-form="unshielded"]'), 'pay in public');
    await choose(() => document.querySelector<HTMLElement>('[data-field="opens"]'), 'when the window opens', day(1));
    await choose(() => document.querySelector<HTMLElement>('[data-field="closes"]'), 'when the window closes', day(2));
  },
  async () => {
    await choose(() => document.querySelector<HTMLElement>('[data-action="raise-run"]:not([disabled])'), 'raise the run');
    await untilShown(() => document.querySelector('[data-acted]'), 'the run raised', 60_000);
    return () => rootOf('raise-run-panel')?.textContent ?? '';
  },
]);

/* The panel opened inside the payroll screen and pressed, each counted on the company as it stands: a payee is admitted before each, and the first of the two is not counted. */
const counted = async (): Promise<{ readonly opened: ScreenCount; readonly pressed: ScreenCount; readonly held: CompanyHeld }> => {
  const run = async () => {
    await payeeAdmittedBy(company, FOUNDER);
    return openScreenAnd(company, FOUNDER, 'payroll', {}, [opensOnTheRoot(buttonNamed(/^New run$/u), 'New run', 'raise-run-panel'), raisesTheRun]);
  };
  await run();
  const [, opened, pressed] = await run();
  return { opened: opened!, pressed: pressed!, held: company.held() };
};

describe('RAISING A RUN FROM ITS PANEL READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  let atN: { readonly opened: ScreenCount; readonly pressed: ScreenCount; readonly held: CompanyHeld } | null = null;

  it('the run panel is opened inside the payroll screen and pressed, and counted on the company at its first size', async () => {
    const c = await counted();
    atN = c;
    /* RED WHEN: the panel opened in its screen reads differently at the first size than it did when pinned, more or fewer. */
    expect(readsOf(c.opened)).toEqual(RUN_PANEL_PINS['raise-run']?.opened);
    /* RED WHEN: a press on the panel reads differently at the first size than it did when pinned, more or fewer, in the page or in the wallet's steps. */
    expect(readsOf(c.pressed)).toEqual(RUN_PANEL_PINS['raise-run']?.pressed);
    /* RED WHEN: the panel does not draw the words only it draws, so the count is of another screen. */
    expect(c.opened.text).toContain('Vault to pay from');
    /* RED WHEN: an answer to the panel's opening or to a press on it carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
    expect(carriedNotAsHeldIn('run panel opening', c.opened.calls)).toEqual([]);
    expect(carriedNotAsHeldIn('run panel press', c.pressed.calls)).toEqual([]);
  });

  it('the run panel, opened inside its screen and pressed, reads the same at the company grown', async () => {
    /* RED WHEN: the first size was not counted before this, so there is nothing to hold its growth to. */
    expect(atN, 'the run panel is counted at its first size before it is counted grown').not.toBeNull();
    await company.growTo({ people: 0, vendors: 3, vaults: 5, proposals: 3 });
    const now = await counted();
    /* RED WHEN: any route, wallet ask or chain, builder or indexer read of the panel's opening or of a press on it grows with the company's vendors, vaults or proposals. */
    expect(differences('run panel opening', readsOf(atN!.opened), readsOf(now.opened), LABELS)).toEqual([]);
    expect(differences('run panel press', readsOf(atN!.pressed), readsOf(now.pressed), LABELS)).toEqual([]);
    /* RED WHEN: a read of the panel's opening asks of one kind of record other than the same number it asked at the first size or one more for each one more of what its kind grows with (`PAGE_ASKED_GROWS_WITH`), or asks a kind it did not. */
    expect(askedBeyondWhatGrew('run panel opening', atN!.opened.calls, now.opened.calls, [atN!.held, now.held], LABELS)).toEqual([]);
    /* RED WHEN: a read of a press on the panel asks a kind of record at the company grown that it did not ask at the first size, or does not ask one it did. */
    expect(askedKindsChanged('run panel press', atN!.pressed.calls, now.pressed.calls, LABELS)).toEqual([]);
    /* RED WHEN: at the company grown, an answer to the panel's opening or to a press on it carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
    expect(carriedNotAsHeldIn('run panel opening', now.opened.calls)).toEqual([]);
    expect(carriedNotAsHeldIn('run panel press', now.pressed.calls)).toEqual([]);
  });

  it('the pins of the run panel this run measures are the ones the pins writer writes from it', () => {
    const rows: Record<string, PinnedOpening> = atN === null ? {} : { 'raise-run': { opened: readsOf(atN.opened), pressed: readsOf(atN.pressed) } };
    const table = { name: 'RUN_PANEL_PINS', about: ABOUT, of: 'openings', rows } as const;
    /* RED WHEN: a pin of the run panel is not what this run measured, or the pins file was changed by hand away from what its writer writes. */
    expect(tableHeld(table, atN !== null)).toBe(tableSource(table));
  });
});
