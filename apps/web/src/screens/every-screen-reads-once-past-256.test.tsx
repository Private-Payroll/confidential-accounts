// @vitest-environment jsdom
/*
 * Every screen reads one request more of the newest versions for each 256 records it names past the first 256, and nothing else more: a company of 520 people names more than twice 256 records, so every page asks two more requests than the pinned company's, which names far fewer.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { SCREEN_PINS } from './screen-count-pins.test-support.js';
import { inTheSettings, screensCountedOn } from './screen-counts.test-support.js';

/* The records are anchored in eight batches so that none carries more than the 256 the anchor reads in one request. */
const company = aCompanyOf({ people: 520, vendors: 4, vaults: 4, proposals: 2, anchoredBatches: 8 });

screensCountedOn(company, {
  pins: SCREEN_PINS,
  more: { 'route POST /api/accounts/:record/manifest/newest': 2 },
  only: (page) => !inTheSettings(page),
  labels: ['at the first size', 'with 520 people']
});
