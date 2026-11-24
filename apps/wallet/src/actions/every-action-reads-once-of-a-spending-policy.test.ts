/*
 * Raising a spending policy reads the same at every size of the company: it is run on a device that has checked the
 * company before, for a vault of its own at each size, step by step, then again after the company grows to twice its people, vendors, vaults
 * and open proposals, as every-action-reads-once.test.ts holds the others. Its pins are written from this run.
 */
import { describe } from 'vitest';
import { setUpActionsCounted } from './actions-set-up-first.test-support.js';

describe('RAISING A SPENDING POLICY READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  setUpActionsCounted(import.meta.url);
});
