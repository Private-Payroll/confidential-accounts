// @vitest-environment jsdom
/*
 * The pages of the settings read one request more of the newest versions for each 256 records they name past the first 256,
 * and nothing else more: the company of 520 people the other pages are counted on, taken apart so that each file runs in time.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { SCREEN_PINS } from './screen-count-pins.test-support.js';
import { inTheSettings, screensCountedOn, STILL_GROWS_WITH_VAULTS } from './screen-counts.test-support.js';

/* The records are anchored in eight batches so that none carries more than the 256 the anchor reads in one request. */
const company = aCompanyOf({ people: 520, vendors: 4, vaults: 4, proposals: 2, anchoredBatches: 8 });

screensCountedOn(company, {
  pins: SCREEN_PINS, more: { 'route POST /api/accounts/:record/manifest/newest': 2 }, only: inTheSettings, stillGrows: STILL_GROWS_WITH_VAULTS, labels: ['at the first size', 'with 520 people'],
});
