/*
 * A TEST COMPANY'S SEATS, AS THE WALLET'S WORDS MAKE THEM, AND ITS PIN. A test company seats its signers with fixed
 * secrets, while every reach of a company holds the seat it signs with to the one the wallet's words make for the
 * pinned company (`seatOfThePin`). A test seating a wallet on such a company names the seat here (`madeByTheWords`)
 * and stands `seatKeysFor` in with `seatKeysAsSeated`, so the wallet's words make that seat; and pins the company's
 * account in the saved keys it hands the action (`pinnedIn`), sealed when the action runs over the runner (`handedInFor`).
 */
import type { Identity } from 'midnight-identity';
import type { SeatKeys } from 'midnight-identity/profile/seat-keys';
import { sealKeyring, withPin, type Keyring, type PinFrom } from '../../../../packages/web-shared/src/keyring-blob.js';
import { toHex } from '../../../../src/core/crypto.js';
import { keyringSealKeyFor } from '../keyring/seal-key.js';

/** Each seat named, by the wallet's own committee key for the company and the seat's number. */
const named = new Map<string, Uint8Array>();
/** The wallet's committee key for a company, as the identity library makes it; set by the stand-in below. */
let keyOf: ((identity: Identity, label: string) => string) | null = null;

const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu)!.map((b) => Number.parseInt(b, 16)));

/** The seat `n` of `identity`'s words for `label` is the one signing with `signingSecret`. */
export function madeByTheWords(identity: Identity, label: string, signingSecret: string, n = 0): void {
  if (keyOf === null) throw new Error('seatKeysFor is not stood in: mock midnight-identity/profile/seat-keys with seatKeysAsSeated');
  named.set(`${keyOf(identity, label)}|${n}`, fromHex(signingSecret.toLowerCase()));
}

/** The seat-keys module with `seatKeysFor` giving each seat named here its named signing secret. */
export function seatKeysAsSeated<T extends { readonly seatKeysFor: (identity: Identity, company: never, n: number) => SeatKeys }>(
  real: T, committeeKeyFor: (identity: Identity, label: never) => { readonly value: string },
): T {
  keyOf = (identity, label) => String(committeeKeyFor(identity, label as never).value).toLowerCase();
  return {
    ...real,
    seatKeysFor: (identity: Identity, company: never, n: number): SeatKeys => {
      const keys = real.seatKeysFor(identity, company, n);
      const secret = named.get(`${keyOf!(identity, company)}|${n}`);
      return secret === undefined ? keys : { ...keys, signingSecret: Uint8Array.from(secret) };
    },
  };
}

/** `kept` with `label` pinned to `account`, as this wallet would have pinned it. */
export const pinnedIn = (kept: Keyring, label: string, account: string, from: PinFrom = 'created'): Keyring =>
  withPin(kept, label, account, from, '2026-01-01T00:00:00.000Z');

/** `kept` sealed as the service hands an action the person's saved keys, for `person` signed in at `requester`. */
export const handedInFor = (identity: Identity, requester: { readonly origin: string; readonly name: string; readonly rdns: string }, person: string, kept: Keyring) => ({
  sealed: sealKeyring(kept, toHex(keyringSealKeyFor(identity, { requester, person }))).sealed,
  version: 1,
});

/** Marks of saved keys opened, kept in memory: a run that opens saved keys in a test reads no browser storage. */
export const marksInMemory = () => ({ markOf: () => null, raise: () => {} });
