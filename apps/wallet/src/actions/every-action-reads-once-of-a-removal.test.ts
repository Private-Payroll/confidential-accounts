/*
 * Raising the removal of a signer reads the same at every size of the company: each is run on a device that has checked the company before, on
 * what was set up for that run, step by step, then again after the company grows to twice its people, vendors, vaults
 * and open proposals, as every-action-reads-once.test.ts holds the others. Its pins are written from this run.
 */
import { describe } from 'vitest';
import { setUpActionsCounted } from './actions-set-up-first.test-support.js';

describe('RAISING A SIGNER\'S REMOVAL READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  setUpActionsCounted(import.meta.url);
});
