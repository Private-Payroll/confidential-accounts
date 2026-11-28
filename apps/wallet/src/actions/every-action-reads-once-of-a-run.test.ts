/*
 * Raising a run reads the same at every size of the company: it is run on a device that has checked the company before,
 * for the payees admitted for that run, step by step, then again after the company grows to twice its vendors, vaults and
 * open proposals, as every-action-reads-once.test.ts holds the others. Its pins are written from this run.
 */
import { describe } from 'vitest';
import { setUpActionsCounted } from './actions-set-up-first.test-support.js';

describe('RAISING A RUN READS THE SAME AT EVERY SIZE OF THE COMPANY', { timeout: 160_000 }, () => {
  /*
   * A company of no person only invited: the wallet draws a run only when everyone on the roster is admitted, so its
   * people are the payees each run admits, one at the first size and two at twice it. The run raised at the first size
   * is still open at twice it, and the company grows its other open proposals beside it, as a change of the approvals is
   * raised while a run is open.
   */
  setUpActionsCounted(import.meta.url, {
    first: { people: 0, vendors: 2, vaults: 2, proposals: 1 },
    grown: { people: 0, vendors: 4, vaults: 4, proposals: 2 }
  });
});
