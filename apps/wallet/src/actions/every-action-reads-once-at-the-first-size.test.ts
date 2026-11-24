/*
 * Every wallet action this harness runs reads, on a company of the first size, exactly what is pinned for it, step by
 * step: the actions that change what they act on once (a recovery window set, a policy bar raised, a company key repaired)
 * are counted here, on a company of their own, with the ones that can be run again; and each files exactly the records it
 * changes. Every other count file holds its company to these reads, and the pins of them are written from this run.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { ACTION_PINS, ACTION_PINS_ASKED } from './action-count-pins.test-support.js';
import { actionsCountedOn } from './action-counts.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });

actionsCountedOn(import.meta.url, company, { reads: ACTION_PINS, asked: ACTION_PINS_ASKED }, ['pinned', 'now'], {
  name: 'ACTION_PINS', about: 'The company at its first size: three people, two vendors, two vaults and one open proposal, in one anchored batch.',
});
