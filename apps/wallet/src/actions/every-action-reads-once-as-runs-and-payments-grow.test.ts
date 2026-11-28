/*
 * The wallet actions every-action-reads-once.test.ts runs at both sizes (giving vault keys, inviting, changing the
 * approvals asked, admitting and changing a person), and the upkeep after an admission, read the same however
 * many runs, paid runs, one-off payments and spending policies the company holds: each is run on a device that has
 * checked the company before, step by step, on a company with a run raised and paid, a one-off payment open and a
 * spending policy set, then again after the company grows to twice its runs, paid runs, open one-off payments and
 * spending policies set, its vendors, vaults and open changes held as they were. Its people are only the payees admitted: a run is drawn only when
 * everyone on the roster is admitted, so no person is left invited. The tables of the pins this run measures are written
 * from it by the pins writer.
 */
import { describe } from 'vitest';
import { asMoneyGrowsCounted } from './actions-set-up-first.test-support.js';

describe(
  'EVERY WALLET ACTION READS THE SAME HOWEVER MANY RUNS, PAID RUNS, ONE-OFF PAYMENTS AND SPENDING POLICIES THE COMPANY HOLDS',
  { timeout: 160_000 },
  () => {
    asMoneyGrowsCounted(import.meta.url);
  }
);
