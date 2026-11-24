/*
 * The upkeep a seat's wallet runs after a signer is admitted, which gives the new seat each vault's secret, reads the same
 * at every size of the company: it is run on a device that has checked the company before, after an admission set up for
 * that run, step by step, then again after the company grows to twice its people, vendors, vaults and open proposals, as
 * every-action-reads-once.test.ts holds the actions. Its writes to the vaults' own records are the same records for each
 * vault, sent as one batch after one check, so they are held as the number filed for each vault. Its pins are written
 * from this run.
 */
import { describe } from 'vitest';
import { setUpActionsCounted } from './actions-set-up-first.test-support.js';

describe('THE UPKEEP AFTER AN ADMISSION READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  setUpActionsCounted(import.meta.url);
});
