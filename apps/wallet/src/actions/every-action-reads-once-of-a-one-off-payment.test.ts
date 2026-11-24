/*
 * A one-off payment reads the same at every size of the company: a one-off payment of a vault's public money is raised
 * from the founding seat's own wallet on a company of its own, step by step, then again after the company grows to twice
 * its people, vendors, vaults and open proposals, with the one raised at the first size still open. Its pins are written
 * from this run.
 */
import { describe } from 'vitest';
import { countedOnACompanyOfItsOwn } from './actions-counted-on-a-company-of-their-own.test-support.js';

describe('A ONE-OFF PAYMENT READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  countedOnACompanyOfItsOwn(import.meta.url);
});
