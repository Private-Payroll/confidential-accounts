/*
 * The first upkeep a seat's wallet runs after the company grows, counted as an action of its own: once after the company
 * is made, once after it grows to twice its people, vendors, vaults and open proposals. Its reads are the same at both,
 * and what it writes of the vaults' own records is the same for each vault the growth added.
 */
import { describe } from 'vitest';
import { upkeepAfterGrowthCounted } from './actions-set-up-first.test-support.js';

describe('THE FIRST UPKEEP AFTER THE COMPANY GROWS READS THE SAME AT EVERY SIZE', { timeout: 160_000 }, () => {
  upkeepAfterGrowthCounted(import.meta.url);
});
