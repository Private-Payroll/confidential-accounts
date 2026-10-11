/**
 * **A SEAT'S OPENING OF ITS OWN LEAF: ITS PUBLIC KEY ON THE ACCOUNT, ITS SCOPE
 * AND ITS BLINDING, AS ONE OF THE COMPANY'S OWN RECORDS.**
 *
 * The account's record anchor names, per anchor, the tag of the seat that moved
 * it: a hash of the account, the seat's public key and its blinding, so only
 * someone who holds the blinding can say whose it is. Each seat files its own
 * opening, sealed under the company's roster key and signed by its filing key,
 * so the company's own members - who already hold every seat's leaf beside its
 * name - can map each tag to a seat; the service and the chain never can. A
 * device believes an opening only where the account's own `signerLeaf` over it
 * is the seat's leaf, so an opening for any other seat is never believed,
 * whoever filed it.
 *
 * Pure: the page and the service both import it.
 */
import type { Hex } from './crypto.js';
import { openRecord, sealRecord } from './sealed-records.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';

/** What a seat's leaf is made from, but its secret: `signerLeaf(publicKey, blinding, scope)`. */
export interface SeatOpening {
  readonly publicKey: Hex;
  readonly scope: Hex;
  readonly blinding: Hex;
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** Why `value` is not an opening in its shape, or null. Whether it opens its seat's leaf is the account's own `signerLeaf`'s to say. */
export const seatOpeningRefusal = (value: unknown): string | null => {
  const o = value as Partial<SeatOpening> | null | undefined;
  if (o === null || o === undefined || typeof o !== 'object') return 'it is not a seat\'s opening';
  return [o.publicKey, o.scope, o.blinding].every((x) => typeof x === 'string' && HEX64.test(x))
    ? null : 'its public key, scope or blinding is not thirty-two bytes of lower-case hex';
};

/** One version of a seat's opening, sealed under the company's roster key and not yet signed. Its id is the seat. */
export const sealSeatOpening = (
  company: string, seat: string, opening: SeatOpening, version: number, keyEpoch: number, viewingKey: Hex,
): SealedCompanyRecord => ({
  company, kind: 'opening', id: seat, version, keyEpoch,
  sealed: sealRecord<SeatOpening>('roster', company, { publicKey: opening.publicKey, scope: opening.scope, blinding: opening.blinding }, viewingKey),
  wrapped: [],
});

/** A seat's opening, opened with the company's viewing key; refused when it is not one in its shape. */
export const openSeatOpening = (rec: Pick<SealedCompanyRecord, 'company' | 'sealed'>, viewingKey: Hex): SeatOpening => {
  const o = openRecord<SeatOpening>('roster', rec.company, rec.sealed, viewingKey);
  const why = seatOpeningRefusal(o);
  if (why !== null) throw new Error(`the seat's opening could not be read: ${why}`);
  return { publicKey: o.publicKey, scope: o.scope, blinding: o.blinding };
};
