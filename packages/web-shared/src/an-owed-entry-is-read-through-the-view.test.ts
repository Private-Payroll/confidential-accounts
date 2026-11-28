/*
 * A seat's owed directory entry reads the directory through the step's view of the company.
 */
import { describe, expect, it } from 'vitest';
import { fileTheOwedDirectoryEntry } from './directory-filed-here.js';

const ENTRY = { seat: 'aa'.repeat(32), signingKey: 'bb'.repeat(32), wrappingKey: 'cc'.repeat(32) };
const OWED = {
  person: 'usr_a',
  company: 'acme',
  signed: { committeeKey: { tag: 'schnorr', value: '11' }, entry: ENTRY }
};
const FILINGS = [{ company: 'acc_1', version: 1, change: { kind: 'claim', entry: { statement: ENTRY } } }];

const owedOnce = () => {
  let owed: unknown = OWED;
  return {
    read: () => owed as never,
    settle: async () => {
      owed = null;
    }
  };
};

describe("AN OWED ENTRY IS READ THROUGH THE STEP'S VIEW", () => {
  it('reads the directory through the view', async () => {
    const asked: string[] = [];
    const view = {
      current: () => ({
        filings: async () => {
          asked.push('view filings');
          return FILINGS as never;
        },
        list: async () => [],
        write: async () => []
      })
    };
    const done = await fileTheOwedDirectoryEntry(
      'acc_1',
      owedOnce(),
      async () => null,
      async () => null,
      view
    );
    /* RED WHEN: an owed entry's read of the directory goes around the view, so its filing is not checked by the view. */
    expect(asked).toEqual(['view filings']);
    expect(done).toBe('already-there');
  });
});
