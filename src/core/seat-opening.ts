/**
 * **A SEAT'S OPENING OF ITS OWN LEAF: ITS PUBLIC KEY ON THE ACCOUNT, ITS SCOPE,
 * ITS BLINDING, AND THE WALLET KEY AND SALT THE BLINDING IS MADE FROM.**
 *
 * A seat's leaf is the account's own `signerLeaf(publicKey, blinding, scope)`,
 * and its blinding is the hash of the wallet key of the person who holds it
 * under a salt made for that leaf alone (`seatBlinding`). The signers approve
 * the leaf when they seat it, so the leaf commits to that wallet key, and the
 * opening is what shows it: a device believes a seat's wallet key only where
 * `walletKeyProvedBy` says the opening makes that seat's leaf on the chain.
 * Without the salt nobody can tell from the leaf whose key it holds.
 *
 * **THE SERVICE NEVER SEES IT.** The opening travels in one place only: the
 * seat's own entry in the company's directory, sealed with the wallet key and
 * the wallet's signature under the company's roster key (`sealSeatProof`), so
 * only a member's device opens it (`openSeatProof`). The service keeps the
 * entry as it is handed in and can tell from it neither which wallet key a seat
 * holds nor which seat moved an anchor; the chain holds only the leaf.
 *
 * Pure: the page and the service both import it.
 */
import { newBlinding, type Hex, type Sealed } from './crypto.js';
import { openRecord, sealRecord } from './sealed-records.js';
import {
  seatBlinding, walletKeyProvedBy, type LeafOf, type SeatOpening, type WalletKey,
} from 'midnight-identity/profile/records-key';

export { seatBlinding, walletKeyProvedBy, type LeafOf, type SeatOpening, type WalletKey };

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * **A NEW SEAT'S SALT AND BLINDING, FOR THE WALLET KEY OF THE PERSON TAKING
 * IT**, made on the device that makes the seat: 32 fresh random bytes of salt,
 * and the blinding `seatBlinding` makes of that key under it. Every leaf a
 * device makes for a seat is made with these.
 */
export const newSeatBlinding = (walletKey: WalletKey): { readonly salt: Hex; readonly blinding: Hex } => {
  const salt = newBlinding();
  return { salt, blinding: seatBlinding({ tag: walletKey.tag, value: walletKey.value.toLowerCase() }, salt) as Hex };
};

/** Why `value` is not an opening in its shape, or null. Whether it opens its seat's leaf is `walletKeyProvedBy`'s to say. */
export const seatOpeningRefusal = (value: unknown): string | null => {
  const o = value as Partial<SeatOpening> | null | undefined;
  if (o === null || o === undefined || typeof o !== 'object') return 'it is not a seat\'s opening';
  if (![o.publicKey, o.scope, o.blinding, o.salt].every((x) => typeof x === 'string' && HEX64.test(x))) {
    return 'its public key, scope, blinding or salt is not thirty-two bytes of lower-case hex';
  }
  const k = o.walletKey;
  return typeof k === 'object' && k !== null && k.tag === 'schnorr' && typeof k.value === 'string' && HEX64.test(k.value)
    ? null : 'its wallet key is not a schnorr key of thirty-two bytes of lower-case hex';
};

/** The opening's own fields and nothing else, each lower-case. */
const onlyTheOpening = (o: SeatOpening): SeatOpening => ({
  publicKey: o.publicKey.toLowerCase(), scope: o.scope.toLowerCase(), blinding: o.blinding.toLowerCase(),
  walletKey: { tag: o.walletKey.tag, value: o.walletKey.value.toLowerCase() }, salt: o.salt.toLowerCase(),
});

/**
 * **WHAT A SEAT'S DIRECTORY ENTRY SEALS FROM THE SERVICE**: the seat's wallet
 * key, the wallet's signature over the entry's statement (which only that key
 * checks, so it would name the key to anyone holding a list of keys to try),
 * and the seat's opening of its own leaf.
 */
export interface SeatProof {
  readonly committeeKey: WalletKey;
  /** The wallet's BIP-340 signature over the entry's statement, 128 lower-case hex characters. */
  readonly signature: string;
  readonly opening: SeatOpening;
}

const HEX128 = /^[0-9a-f]{128}$/u;

/** A seat's proof sealed under the company's roster key: only a member's device opens it. */
export const sealSeatProof = (company: string, proof: SeatProof, viewingKey: Hex): Sealed =>
  sealRecord<SeatProof>('roster', company, {
    committeeKey: { tag: proof.committeeKey.tag, value: proof.committeeKey.value.toLowerCase() },
    signature: proof.signature.toLowerCase(),
    opening: onlyTheOpening(proof.opening),
  }, viewingKey);

/**
 * A seat's proof, opened with the company's viewing key; null when it does not
 * open under that key or is not one in its shape. Whether it proves anything is
 * the directory's to say.
 */
export const openSeatProof = (company: string, sealed: Sealed, viewingKey: Hex): SeatProof | null => {
  let p: Partial<SeatProof> | null;
  try {
    p = openRecord<Partial<SeatProof>>('roster', company, sealed, viewingKey);
  } catch {
    return null;
  }
  if (typeof p !== 'object' || p === null || seatOpeningRefusal(p.opening) !== null || typeof p.signature !== 'string'
    || !HEX128.test(p.signature) || typeof p.committeeKey !== 'object' || p.committeeKey === null
    || p.committeeKey.tag !== 'schnorr' || typeof p.committeeKey.value !== 'string' || !HEX64.test(p.committeeKey.value)) return null;
  return { committeeKey: { tag: 'schnorr', value: p.committeeKey.value }, signature: p.signature, opening: onlyTheOpening(p.opening!) };
};
