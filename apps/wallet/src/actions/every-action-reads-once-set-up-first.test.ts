/*
 * Withdrawing, raising and admitting a person waiting for a seat each reads the same at every size of the company: each is run on a device that has checked the company before, on
 * what was set up for that run, step by step, then again after the company grows to twice its people, vendors, vaults
 * and open proposals, as every-action-reads-once.test.ts holds the others. Its pins are written from this run.
 */
import { describe } from 'vitest';
import { setUpActionsCounted } from './actions-set-up-first.test-support.js';

describe('WITHDRAWING, RAISING AND ADMITTING A SIGNER EACH READ THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  setUpActionsCounted(import.meta.url);
});
