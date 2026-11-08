/**
 * THE ACCOUNT'S COUNT OF REMOVALS, READ ON THIS DEVICE AT ONE BLOCK THROUGH THE WALLET'S INDEXER.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import { removalsOnTheChainHere } from './removals-on-the-chain.js';

const VAULT = 'ab'.repeat(32) as never;
const doorsWith = (removals: unknown, asked: unknown[] = []) => ({
  account: 'ac'.repeat(32) as never,
  indexer: async () => ({ indexerUri: 'http://i', indexerWsUri: 'ws://i' }),
  clock: () => 5_000,
  builder: {
    chainAtOneBlock: async () => ({ blockHash: 'B', vaultState: 'V', zswapState: 'Z', parameters: 'P', accountState: 'A' }),
    eventsOf: async () => [], createdBy: async () => null,
    startStanding: async (i: unknown) => { asked.push(i); return { standing: { adopted: true, removals } } as never; },
  },
}) as never;

describe('the account\'s count of removals', () => {
  it('IS READ FROM THE ACCOUNT\'S STATE AT THE BLOCK THE WALLET\'S INDEXER SHOWS', async () => {
    const asked: unknown[] = [];
    expect(await removalsOnTheChainHere(doorsWith(2, asked), VAULT), 'RED WHEN: the count is not the account\'s').toBe(2);
    /* RED WHEN: the count is read from another state than the account's at that block, or a secret is handed to the read. */
    expect(asked).toEqual([{ vault: VAULT, account: 'ac'.repeat(32), accountState: 'A', vaultState: 'V', now: '5' }]);
  });

  it('REFUSES A COUNT IT COULD NOT READ, rather than taking it for none', async () => {
    for (const bad of [undefined, -1, 1.5]) {
      /* RED WHEN: a missing count is read as zero, so a deposit goes ahead under a secret a leaver may open. */
      await expect(removalsOnTheChainHere(doorsWith(bad), VAULT), String(bad)).rejects.toThrow(/could not read how many signers/);
    }
  });
});
