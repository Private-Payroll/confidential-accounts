/*
 * Every wallet action this harness runs reads, on a company of the first size, exactly what is pinned for it, step by
 * step: the actions that change what they act on once (a recovery window set, a policy bar raised, a company key repaired)
 * are counted here, on a company of their own, with the ones that can be run again; and each files exactly the records it
 * changes. Every other count file holds its company to these reads.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { ACTION_PINS } from './action-count-pins.test-support.js';
import { actionsCountedOn } from './action-counts.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });

actionsCountedOn(company, ACTION_PINS, {}, ['pinned', 'now']);
