/*
 * Every wallet action reads the same on a company of twice the records with twice the seats as on the company of the
 * first size: the same routes, wallet asks and chain, builder and indexer reads at every step, and the same records filed.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { ACTION_PINS, ACTION_PINS_ASKED } from './action-count-pins.test-support.js';
import { actionsCountedOn } from './action-counts.test-support.js';

const company = aCompanyOf({ people: 6, vendors: 4, vaults: 4, proposals: 2, seats: 6 });

actionsCountedOn(import.meta.url, company, { reads: ACTION_PINS, asked: ACTION_PINS_ASKED }, ['at the first size', 'with twice the seats']);
