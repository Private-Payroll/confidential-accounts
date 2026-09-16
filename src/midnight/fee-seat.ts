/**
 * WHETHER THE SEAT WHERE A FEE PAYER GOES HAS SOMEBODY IN IT WHO PAYS.
 *
 * A deployment that cannot pay still fills the seat, with a stand-in whose
 * every member refuses, so nothing dereferences an empty one. That stand-in is
 * an object, and an object in the seat is not somebody paying: **a sentence
 * about fees reads this and not the seat's truthiness.**
 */
import type { FeeSponsor } from './ledger.js';

export const paysNoFees = (sponsor: FeeSponsor | null | undefined): boolean =>
  !sponsor || sponsor.paysNothing === true;
