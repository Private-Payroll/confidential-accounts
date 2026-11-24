/*
 * A recovery of the company's records reads the same at every size of the company: it is raised from the founding
 * seat's own wallet on a company of its own whose records stop for its devices, step by step, then again after the
 * company grows to twice its people, vendors, vaults and open proposals. It calls no route of the service, so it is
 * counted by its reads of the chain, the builder and the indexer. Its pins are written from this run.
 */
import { describe } from 'vitest';
import { countedOnACompanyOfItsOwn } from './actions-counted-on-a-company-of-their-own.test-support.js';

describe('A RECOVERY READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  countedOnACompanyOfItsOwn(import.meta.url);
});
