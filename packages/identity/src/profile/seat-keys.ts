import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Purposes } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';
import { readCompanyLabel } from './company-label.js';
import type { CompanyLabel } from './company-label.js';

/*
 * A seat's keys, made in the wallet from the person's words: the seat's
 * signing secret, its wrapping secret and the salt its blinding is made with.
 * Each is an expansion of the wallet's seat parent under the company's label
 * and the seat's number, so the same words always make the same seat again
 * and nothing about a seat has to be kept anywhere to be recovered.
 *
 * They never come from the committee key or the maintenance parent: the page
 * holds a seat's secrets, and a page holding them must hold nothing that
 * changes the company's committee.
 */

const SEAT_SALT = new TextEncoder().encode('midnight-identity/seat/v1');

/* Every seat expands from one parent; the company and the seat number are in each expansion's input. */
const SEAT_PARENT_INDEX = 0;

const KEY_BYTES = 32;

const MAX_SEAT = 2 ** 31;

export interface SeatKeys {
  /** The seat's signing secret: its ed25519 key and the secret its leaf is proved with. */
  readonly signingSecret: Uint8Array;
  /** The seat's x25519 secret, which opens what is wrapped to the seat. */
  readonly wrappingSecret: Uint8Array;
  /** The salt the seat's blinding is made with: the blinding is the hash of the person's wallet key under it. */
  readonly salt: Uint8Array;
}

export class SeatKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatKeysError';
  }
}

/**
 * The keys of seat `n` in the company named by `company`. The founding seat is
 * number 0. Refuses anything that is not a company's label (an account's
 * address included) and a seat number that is not a whole number from 0 to
 * 2^31 - 1, and makes nothing then. Trusts only the words behind `identity`.
 */
export function seatKeysFor(identity: Identity, company: CompanyLabel, n: number): SeatKeys {
  const label = readCompanyLabel(company);
  if (label === null) {
    throw new SeatKeysError(
      'a seat\'s keys belong to one company, named by its label, and what was given is not one. '
      + 'An account\'s address is not a label. No keys were made.');
  }
  if (!Number.isSafeInteger(n) || n < 0 || n >= MAX_SEAT) {
    throw new SeatKeysError(`a seat's number is a whole number from 0 to ${MAX_SEAT - 1}; got ${n}. No keys were made.`);
  }
  const parent = identity.authority(Purposes.Seat, SEAT_PARENT_INDEX);
  const part = (name: string): Uint8Array =>
    hkdf(sha256, parent, SEAT_SALT, new TextEncoder().encode(`${label}/${n}/${name}`), KEY_BYTES);
  return Object.freeze({ signingSecret: part('signing'), wrappingSecret: part('wrapping'), salt: part('salt') });
}
