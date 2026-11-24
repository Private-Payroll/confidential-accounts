/*
 * Every wallet action reads the same on a company of twice the records anchored in four batches as on the company of the
 * first size; what it reads here is the pins of a company anchored in four batches, which the file of more than 256 people holds to.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { ACTION_PINS, ACTION_PINS_ASKED } from './action-count-pins.test-support.js';
import { actionsCountedOn } from './action-counts.test-support.js';

const company = aCompanyOf({ people: 6, vendors: 4, vaults: 4, proposals: 2, anchoredBatches: 4 });

actionsCountedOn(import.meta.url, company, { reads: ACTION_PINS, asked: ACTION_PINS_ASKED }, ['at the first size', 'over four batches'], {
  name: 'ACTION_PINS_FOUR_BATCHES', about: 'The company at twice its records with its records anchored in four batches.',
});
