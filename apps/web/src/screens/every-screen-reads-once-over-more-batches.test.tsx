// @vitest-environment jsdom
/*
 * Every screen reads the same on a company of twice the records anchored in four batches as on the company of the first size, opened on a device that has checked the company before.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { SCREEN_PINS } from './screen-count-pins.test-support.js';
import { screensCountedOn } from './screen-counts.test-support.js';


const company = aCompanyOf({ people: 6, vendors: 4, vaults: 4, proposals: 2, anchoredBatches: 4 });

screensCountedOn(company, { pins: SCREEN_PINS, labels: ['at the first size', 'over four batches'] });
