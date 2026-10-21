/**
 * **A COMPANY WITH MORE RECORDS WAITING THAN ONE BATCH HOLDS MAKES ITS FIRST
 * ANCHOR.** Its founding device entered sixty-four records before its first
 * state; a batch holds sixty-four. The first anchor must hold the company's
 * first state and first roster, so they go first in it, and the rest follow in
 * later batches.
 */
import { describe, expect, it } from 'vitest';
import { aCompanyOfTwoSeats, ADA, aRecordFiledBy, CO, sendAs, store } from './a-company-of-two-seats.test-support.js';
import { ACME_STATE } from './a-company-of-two-seats.test-support.js';
import { companyRecordEntry, ENTRIES_AT_ONCE, signManifestEntry, type ManifestEntryBody } from '../midnight/record-manifest.js';
import type { Hex } from '../core/crypto.js';

const enteredByAda = async (bodies: readonly ManifestEntryBody[]) => {
  const r = await sendAs('ada')(`/api/accounts/${CO}/manifest/entries`, {
    method: 'POST', body: JSON.stringify({ entries: bodies.map((b) => signManifestEntry(CO, b, ADA.signingSecret as Hex)) }),
  });
  expect(r.status).toBe(201);
};

let outcome: { readonly anchored: number } | Error | null = null;

aCompanyOfTwoSeats(undefined, {
  beforeTheAnchor: async () => {
    const waiting: ManifestEntryBody[] = [];
    for (let i = 0; i < ENTRIES_AT_ONCE; i += 1) waiting.push(await aRecordFiledBy(ADA, `pol_waiting${String(i).padStart(2, '0')}`));
    await enteredByAda(waiting);
    await enteredByAda([companyRecordEntry(ACME_STATE)]);
  },
  anchored: (o) => { outcome = o; },
});

describe('THE FIRST ANCHOR OF A COMPANY WITH MORE RECORDS WAITING THAN ONE BATCH HOLDS', () => {
  it('holds the company\'s first state and first roster, ahead of the records entered before them', () => {
    /* RED WHEN: a company with a batch's worth of records entered before its first state can never make its first anchor. */
    expect(outcome).not.toBeInstanceOf(Error);
    const first = store.keptTreeOf(CO).headers[0]!;
    expect(first.changes.length).toBe(ENTRIES_AT_ONCE);
    expect([...first.changes.slice(0, 3).map((c) => `${c.leaf.kind}@${c.leaf.version}`)].sort()).toEqual(['directory@1', 'roster@1', 'state@1']);
  });
});
