/*
 * A read of the company's records says the newest version of each record it asked about that the service gave as
 * waiting, whether the read believed that entry or set it aside: what a check before a write compares the company
 * against, so an entry the read saw is never taken for one made after it.
 */
import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from '../../../src/midnight/record-manifest.js';
import { newestWaitingOf } from './records-held-here.js';

const entry = (kind: string, id: string, version: number) => ({ store: 'company', kind, id, version }) as unknown as ManifestEntry;

describe('THE NEWEST VERSION A READ SAW WAITING', () => {
  it('is the highest waiting version of each record asked, believed or not, and nothing of a record not asked', () => {
    const pending = [entry('proposal', 'p1', 2), entry('proposal', 'p1', 4), entry('proposal', 'p1', 3), entry('person', 'e1', 1)];
    const asked = (e: { readonly kind: string }) => e.kind === 'proposal';
    /* RED WHEN: a waiting version other than the highest is said, or a record the read did not ask about is said at all. */
    expect([...newestWaitingOf(pending, asked)]).toEqual([['company:proposal:p1', 4]]);
  });
});
