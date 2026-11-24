/*
 * Creating a vault reads the same at every size of the company: a new vault is built, deployed through the service and
 * its adoption raised from the founding seat's own wallet on a company of its own, step by step, then again after the
 * company grows to twice its people, vendors, vaults and open proposals. Its pins are written from this run.
 */
import { describe } from 'vitest';
import { countedOnACompanyOfItsOwn } from './actions-counted-on-a-company-of-their-own.test-support.js';

describe('CREATING A VAULT READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  countedOnACompanyOfItsOwn(import.meta.url);
});
