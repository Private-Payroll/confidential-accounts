/**
 * **A SEAT'S OPENING IS NEVER A RECORD OF ITS OWN ON THE SERVICE.** It travels
 * in one place only, sealed inside the seat's own directory entry, so the
 * service keeps no second copy beside it: a record of that kind is refused, and
 * nothing is kept or served.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../core/crypto.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { aCompanyOfTwoSeats, ADA, CO, sendAs } from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

describe('A SEAT\'S OPENING, ON THE SERVICE', () => {
  it('is refused as a record of its own, filed or read', async () => {
    const rec = signCompanyFiling({
      company: CO, kind: 'opening' as never, id: ADA.seat, version: 1, keyEpoch: 0, sealed: { iv: '00'.repeat(12), tag: '', body: 'ab' }, wrapped: [],
    }, ADA.signingSecret as Hex);
    /* RED WHEN: the service keeps a seat's opening as a record beside its entry - a second copy of the same fact. */
    const filed = await sendAs('ada')(`/api/accounts/${CO}/records/opening/${ADA.seat}/1`, { method: 'PUT' as never, body: JSON.stringify(toCompanyWire(rec)) });
    expect([filed.status, (filed.body as { error?: string }).error]).toEqual([400, expect.stringMatching(/is not a record a company keeps/)]);
    /* RED WHEN: the service serves one. */
    const read = await sendAs('ada')(`/api/accounts/${CO}/records/opening/${ADA.seat}`, { method: 'GET' });
    expect(read.status).toBe(400);
  });
});
