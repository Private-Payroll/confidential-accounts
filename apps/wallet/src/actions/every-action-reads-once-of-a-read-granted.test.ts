/*
 * Giving a reader the accountant's read of the company reads the same at every size of the company: a reader's own
 * wallet signs its code, and the founding seat's wallet gives the read on a company of its own, step by step, then again
 * for another reader after the company grows to twice its people, vendors, vaults and open proposals. Its pins are
 * written from this run.
 */
import { describe } from 'vitest';
import { countedOnACompanyOfItsOwn } from './actions-counted-on-a-company-of-their-own.test-support.js';

describe('GIVING A READER THE COMPANY\'S READ READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  countedOnACompanyOfItsOwn(import.meta.url);
});
