/**
 * **A SEAT FILES THE OPENING OF ITS OWN LEAF, AND NO OTHER SEAT'S.** The
 * service keeps an opening only under the seat whose key signed it: the
 * record's id is that seat. Whether an opening opens the seat's leaf is every
 * member's device's to judge (`tagSeatsHere`); the service never can.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../core/crypto.js';
import { sealSeatOpening } from '../core/seat-opening.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { aCompanyOfTwoSeats, ADA, BO, CO, sendAs } from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

const OPENING = { publicKey: '0d'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex, blinding: '22'.repeat(32) as Hex };
const fileOpening = (as: string, signingSecret: Hex, seat: string) => {
  const rec = signCompanyFiling(sealSeatOpening(CO, seat, OPENING, 1, 0, '5e'.repeat(32) as Hex), signingSecret);
  return sendAs(as)(`/api/accounts/${CO}/records/opening/${seat}/1`, { method: 'PUT' as never, body: JSON.stringify(toCompanyWire(rec)) });
};

describe('A SEAT\'S OPENING, ON THE SERVICE', () => {
  it('is kept under the seat whose key signed it, and refused under another seat', async () => {
    /* RED WHEN: a seat may file an opening under another seat - the service would serve a member a seat's opening its seat never filed. */
    const other = await fileOpening('ada', ADA.signingSecret as Hex, BO.seat);
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ refused: 'not-its-own-opening' });
    /* RED WHEN: a seat cannot file its own opening, as any record it may file. */
    expect((await fileOpening('ada', ADA.signingSecret as Hex, ADA.seat)).status).toBe(201);
  });
});
