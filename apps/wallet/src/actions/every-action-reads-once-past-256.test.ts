/*
 * Every wallet action reads the same on a company with more than 256 people as on the company of twice the records
 * anchored in four batches, but one more request for each 256 records a request names: the actions name few records one by
 * one, so only the one that reads the whole company's records again (repairing the company key) asks for more, and each of its
 * five asks for the newest versions of the records the company holds is two requests, not one: its first read of the people,
 * then the check before each of the four writes it makes (its filing of the change, the entries, the header and the anchor's
 * send). Each is a check of its own, made before its own write, so none is merged into another.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { ACTION_PINS_FOUR_BATCHES, ACTION_PINS_FOUR_BATCHES_ASKED } from './action-count-pins.test-support.js';
import { actionsCountedOn } from './action-counts.test-support.js';

/* Anchored in four batches, as the company its reads are held to was. */
const company = aCompanyOf({ people: 300, vendors: 4, vaults: 4, proposals: 2, anchoredBatches: 4 });

/* Repairing the company key asks for every record five times (its first read, then the check before each of its four writes), each in parts of 256: one request more each for the 300 people. */
const NEWEST = 'route POST /api/accounts/:record/manifest/newest';
const REPAIR = ACTION_PINS_FOUR_BATCHES['repair-company-key']!.map((step, i) => (i === 2 ? { ...step, [NEWEST]: step[NEWEST]! + 5 } : step));

actionsCountedOn(import.meta.url, company, { reads: { ...ACTION_PINS_FOUR_BATCHES, 'repair-company-key': REPAIR }, asked: ACTION_PINS_FOUR_BATCHES_ASKED }, ['with 6 people', 'with 300 people']);
