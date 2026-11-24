// @vitest-environment jsdom
/*
 * Every page outside the settings reads the same however many runs, paid runs, one-off payments and spending policies the company holds: each
 * is opened twice on a device that has checked the company before, the second opening counted, on a company with a run
 * raised and paid, a one-off payment open and a spending policy set, then again after it holds more of each, each by a
 * number of its own. The pages are taken apart into two files so that each runs in time.
 */
import { aCompanyOf } from './company-harness.test-support.js';
import { inTheSettings, MONEY_FIRST, screensCountedAsMoneyGrows } from './screen-counts.test-support.js';

const company = aCompanyOf(MONEY_FIRST);

screensCountedAsMoneyGrows(company, (page) => !inTheSettings(page));
