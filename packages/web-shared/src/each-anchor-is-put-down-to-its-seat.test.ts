/**
 * **A MEMBER'S DEVICE MAPS EVERY TAG THE ACCOUNT WRITES TO ITS SEAT, FROM THE
 * OPENINGS IN THE DIRECTORY IT BELIEVES.** A seat's opening travels only in
 * its own directory entry, sealed to the company's members; a tag is mapped
 * only where the account's own `signerLeaf` over the opening is the seat's
 * leaf, and only for a seat the account holds now. The one to read first is
 * "A SEAT'S TAG".
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { newSigningKeypair } from '../../../src/core/crypto.js';
import { seatBlinding, type SeatOpening } from '../../../src/core/seat-opening.js';
import { COMPANY_RECORD_KINDS } from '../../../src/midnight/sealed-record-wire.js';
import { MAY_FILE } from '../../../src/midnight/seat-directory.js';
import { anchorFunctions } from '../../../src/testing/record-tree-double.js';
import { tagSeatsHere } from './seat-openings-here.js';

const ACCOUNT = 'ac'.repeat(32);
/* A seat's material as a seating device makes it: its blinding the hash of the holder's wallet key under a salt. */
const materialOf = (n: number) => {
  const walletKey = { tag: 'schnorr', value: (0x40 + n).toString(16).repeat(32) };
  const salt = (0x60 + n).toString(16).repeat(32);
  return { signingSecret: newSigningKeypair().secret, blinding: seatBlinding(walletKey, salt) as Hex, scope: '33'.repeat(32) as Hex, walletKey, salt };
};
/** The opening the seating device kept beside the material: its public key on the account, as the account's own functions make it. */
const openingOf = async (m: ReturnType<typeof materialOf>): Promise<SeatOpening> => ({
  publicKey: (await anchorFunctions.seatOpenings({ account: ACCOUNT, openings: [], own: m })).own!.publicKey.toLowerCase(),
  scope: m.scope, blinding: m.blinding, walletKey: m.walletKey, salt: m.salt,
});
const leafOf = async (m: ReturnType<typeof materialOf>) => (await anchorFunctions.seatOpenings({ account: ACCOUNT, openings: [], own: m })).own!.leaf;
const doors = { account: ACCOUNT, builder: anchorFunctions };

describe('EVERY TAG THE ACCOUNT WRITES, PUT DOWN TO ITS SEAT', () => {
  it('A SEAT\'S TAG: WORKED OUT FROM THE OPENING ITS BELIEVED ENTRY CARRIES, AND MAPPED TO IT', async () => {
    const m = materialOf(1);
    const seat = await leafOf(m);
    const tag = await anchorFunctions.anchorTag({ account: ACCOUNT, material: m });
    /* RED WHEN: a member does not map the seat's tag, as the account's call works it out, to the seat. */
    expect([...(await tagSeatsHere(doors, [{ seat, opening: await openingOf(m) }], [seat])).entries()]).toEqual([[tag, seat]]);
  });

  it('AN OPENING THAT DOES NOT OPEN ITS SEAT\'S LEAF, A SEAT WITH NONE, AND A SEAT THE ACCOUNT NO LONGER HOLDS MAP NOTHING', async () => {
    const a = materialOf(1);
    const b = materialOf(2);
    const seatA = await leafOf(a);
    const seatB = await leafOf(b);
    /* RED WHEN: an opening is mapped for a seat whose leaf it does not open. */
    expect([...(await tagSeatsHere(doors, [{ seat: seatB, opening: await openingOf(a) }], [seatB])).values()]).toEqual([]);
    /* RED WHEN: a seat with no opening this device believes stops the read of the others. */
    expect([...(await tagSeatsHere(doors, [{ seat: '77'.repeat(32) }, { seat: seatA, opening: await openingOf(a) }], ['77'.repeat(32), seatA])).values()]).toEqual([seatA]);
    /* RED WHEN: a seat the account does not hold now is mapped. */
    expect([...(await tagSeatsHere(doors, [{ seat: seatA, opening: await openingOf(a) }], [seatB])).values()]).toEqual([]);
  });

  it('NO SEAT\'S OPENING IS A RECORD OF ITS OWN: THE ENTRY IS ITS ONE PLACE', () => {
    /* RED WHEN: an opening record can still be filed or read beside the entry - a second copy of the same fact. */
    expect(COMPANY_RECORD_KINDS as readonly string[]).not.toContain('opening');
    for (const kinds of Object.values(MAY_FILE)) expect(kinds as readonly string[]).not.toContain('opening');
  });
});
