/**
 * **A DEPOSIT STILL HAS ITS OWN TRANSACTION IDENTIFIERS AFTER THE SERVICE'S FEE PAYER MERGES ITS FEE INTO IT.**
 * The page finds out whether a public deposit landed by asking the indexer for the identifiers it read from the
 * transaction before it was sent. The service sends a different, merged transaction, so the page's look-up
 * finds the deposit only if the merge keeps the depositor's identifiers. Built here from ledger objects alone:
 * no chain, no network, no proving.
 */
import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';

const MINUTE_MS = 60_000;

const unbound = (segment: number, minutesToLive: number) =>
  L.Transaction.fromParts('undeployed').addIntent(
    { tag: 'specific', value: segment },
    L.Intent.new(new Date(Date.now() + minutesToLive * MINUTE_MS)),
  );

describe('THE FEE PAYER\'S MERGE KEEPS THE DEPOSIT\'S IDENTIFIERS', () => {
  it('a deposit merged with a fee in another segment is still found by its own identifiers', () => {
    /* RED WHEN: a deposit the service sent can no longer be found by the identifiers the page read before
     * sending it, so a deposit that landed reads as never seen. */
    const deposit = unbound(7, 60).bind();
    const fee = unbound(2, 20).bind();
    const merged = deposit.merge(fee);

    expect([...merged.intents!.keys()].sort()).toEqual([2, 7]);
    expect(deposit.identifiers()).toHaveLength(1);
    for (const id of deposit.identifiers()) expect(merged.identifiers()).toContain(id);
    for (const id of fee.identifiers()) expect(merged.identifiers()).toContain(id);
    expect(new Set(merged.identifiers()).size).toBe(2);
    expect(deposit.identifiers()).not.toEqual(fee.identifiers());
  });

  it('the identifiers read before binding are those of the bound deposit and of the merged one', () => {
    /* RED WHEN: the identifiers the page reads from the wallet's unfinished transaction are not the ones the
     * indexer shows for the sent transaction, so the page waits on a name that never appears. */
    const draft = unbound(7, 60);
    const before = draft.identifiers();
    const deposit = draft.bind();
    const merged = deposit.merge(unbound(2, 20).bind());

    expect(before).toHaveLength(1);
    for (const id of before) {
      expect(deposit.identifiers()).toContain(id);
      expect(merged.identifiers()).toContain(id);
    }
  });
});
