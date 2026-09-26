/**
 * **A DEPOSIT SENT FROM THIS BROWSER, KEPT IN THIS BROWSER UNTIL IT LANDS.**
 * The record the next deposit into the same vault reads first, over the
 * browser's own database, and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { browserDepositsInFlight } from './vault-page-doors.js';

const VAULT = 'AB'.repeat(32) as never;
const deposit = {
  coin: { nonce: '11'.repeat(32) as never, token: '22'.repeat(32) as never, value: '700' },
  recordedAt: 1_700_000_000_000, txRef: 'p-1', transactionHash: '33'.repeat(32),
};

describe('a deposit in flight, in this browser', () => {
  it('IS READ BACK AS IT WAS KEPT, UNDER ANY SPELLING OF THE VAULT, UNTIL IT IS FORGOTTEN', async () => {
    const factory = new IDBFactory();
    const kept = browserDepositsInFlight(factory);
    expect(await kept.get(VAULT)).toBeNull();
    await kept.put(VAULT, deposit);
    /* RED WHEN: a field is dropped on the way in, so the follow-up asks the chain for the wrong coin or transaction. */
    expect(await browserDepositsInFlight(factory).get(('ab'.repeat(32)) as never), 'RED WHEN: a second page open reads nothing, or one spelling of the vault misses the other')
      .toEqual(deposit);
    await kept.put(VAULT, { ...deposit, txRef: 'p-2', transactionHash: null });
    expect(await kept.get(VAULT), 'RED WHEN: a later write does not replace the earlier one').toMatchObject({ txRef: 'p-2', transactionHash: null });
    await kept.forget(VAULT);
    expect(await kept.get(VAULT), 'RED WHEN: a deposit that is settled is still kept').toBeNull();
  });
});
