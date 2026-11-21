// @vitest-environment jsdom
/*
 * Every screen reads the same on a company of twice the records with twice the seats as on the company of the first size: the same routes, wallet asks and chain, builder and indexer reads on every page.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { SCREEN_PINS } from './screen-count-pins.test-support.js';
import { screensCountedOn, STILL_GROWS_WITH_VAULTS } from './screen-counts.test-support.js';


const company = aCompanyOf({ people: 6, vendors: 4, vaults: 4, proposals: 2, seats: 6 });

screensCountedOn(company, { pins: SCREEN_PINS, stillGrows: STILL_GROWS_WITH_VAULTS, labels: ['at the first size', 'with twice the seats'] });
