/*
 * Issuing a seated person's invitation again reads the same at every size of the company: it is run on a device that has
 * checked the company before, for a person seated for that run, step by step, then again after the company grows to twice
 * its people, vendors and vaults, on a company of its own, as every-action-reads-once.test.ts holds the others. Its pins
 * are written from this run.
 */
import { describe } from 'vitest';
import { reissueCounted } from './actions-set-up-first.test-support.js';

describe('ISSUING AN INVITATION AGAIN READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  reissueCounted(import.meta.url);
});
