/*
 * The upkeep a seat's wallet runs after a signer is admitted, counted on a company that grows one kind of record at a
 * time: first its vaults alone, then its people alone. It writes two of the vaults' own records for each vault at every
 * size, and its reads are the same at each, so a write made for each person or vendor cannot pass as one for each vault.
 */
import { describe } from 'vitest';
import { upkeepAfterAnAdmissionCountedByWhatGrows } from './actions-set-up-first.test-support.js';

describe(
  'THE UPKEEP AFTER AN ADMISSION WRITES FOR EACH VAULT AND READS THE SAME AS VAULTS OR PEOPLE GROW ALONE',
  { timeout: 160_000 },
  () => {
    upkeepAfterAnAdmissionCountedByWhatGrows(import.meta.url);
  }
);
