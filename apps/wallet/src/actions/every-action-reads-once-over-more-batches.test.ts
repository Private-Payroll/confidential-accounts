/*
 * Every wallet action reads the same on a company of twice the records anchored in four batches as on the company of the
 * first size, apart from the reads named here as still growing with the anchored batches.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { ACTION_PINS } from './action-count-pins.test-support.js';
import { actionsCountedOn } from './action-counts.test-support.js';

const company = aCompanyOf({ people: 6, vendors: 4, vaults: 4, proposals: 2, anchoredBatches: 4 });

/* The reads that still grow with the anchored batches, by ask, in every step that makes them; each must still be found growing. */
const STILL_GROWS: Readonly<Record<string, string>> = Object.freeze({
});

actionsCountedOn(company, ACTION_PINS, STILL_GROWS, ['at the first size', 'over four batches']);
