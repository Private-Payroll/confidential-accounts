import type { AddressesAndBalancesRequest } from './request.js';
import { usableOrigin } from './origin.js';

/**
 * WHAT A WALLET HANDS BACK WHEN A PERSON AGREES TO SHOW A PAGE WHERE ONE OF
 * THEIR WALLETS RECEIVES, AND WHAT IT HOLDS.
 *
 * Two addresses - the private one and the public one - and every token that
 * wallet holds on each side, each amount marked private or public. **Nothing
 * here is signed and nothing here moves money.** It is a reading, taken by the
 * wallet itself, at the moment each side says, and handed over only on the
 * person's press, exactly as the screen showed it.
 *
 * **A SIDE THE WALLET COULD NOT READ IS SAID, NEVER SHOWN AS NONE.** Its moment
 * is `null` and it carries no amounts; a page reads that as "not known", which
 * is a different fact from zero.
 */
export const ADDRESSES_AND_BALANCES_SCHEMA = 'midnight-identity/addresses-and-balances/v1';

/**
 * WHICH SIDE OF THE WALLET AN AMOUNT IS HELD ON. A private amount is held in
 * the wallet's shielded coins and is seen by nobody else; a public amount is
 * held in its unshielded coins and anybody can read it on the network. These
 * are the two words a page's private and public amount types are made from.
 */
export type Visibility = 'private' | 'public';

/** One token's amount on one side. */
export interface HeldAmount {
  /** The token's own identifier as the ledger writes it: sixty-four lower-case hex characters. */
  readonly token: string;
  /** Whole smallest units, as decimal digits. */
  readonly amount: string;
  readonly visibility: Visibility;
}

/** What the screen showed, and so exactly what is handed over. */
export interface AddressesAndBalancesShown {
  /** The wallet's private receiving address and its public one, each in its text form. */
  readonly addresses: { readonly private: string; readonly public: string };
  /** Every amount shown: NIGHT on each side that was read, and every other token held above zero. */
  readonly balances: readonly HeldAmount[];
  /** The moment each side's amounts were true of, or null when that side could not be read. */
  readonly read: { readonly private: number | null; readonly public: number | null };
}

export interface AddressesAndBalances extends AddressesAndBalancesShown {
  readonly schema: typeof ADDRESSES_AND_BALANCES_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  readonly nonce: string;
  readonly at: number;
}

export class AddressesAndBalancesRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressesAndBalancesRefused';
  }
}

const DIGITS = /^(0|[1-9][0-9]{0,38})$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const ADDRESS = /^[\x21-\x7e]{40,200}$/u;
const VISIBILITIES: readonly Visibility[] = ['private', 'public'];

const isMoment = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

/**
 * **WHY WHAT IS ABOUT TO BE SHOWN OR READ IS NOT ONE WHOLE ANSWER**, or null
 * when it is: two different addresses; a moment, or none, for each side; and
 * amounts only for a side that was read, each a token, whole digits and its
 * side, with no token twice on one side. One rule for the wallet that builds an
 * answer and the page that reads one.
 */
export function whyNotAddressesAndBalances(shown: unknown): string | null {
  const s = shown as Partial<AddressesAndBalancesShown> | null;
  if (typeof s !== 'object' || s === null) return 'it is not an answer';
  const addresses = s.addresses as Partial<AddressesAndBalancesShown['addresses']> | undefined;
  if (typeof addresses !== 'object' || addresses === null
    || !ADDRESS.test(String(addresses.private)) || !ADDRESS.test(String(addresses.public))
    || addresses.private === addresses.public) {
    return 'it does not carry a private and a public address';
  }
  const read = s.read as Partial<AddressesAndBalancesShown['read']> | undefined;
  if (typeof read !== 'object' || read === null || !isMoment(read.private) || !isMoment(read.public)) {
    return 'it does not say when each side was read';
  }
  if (!Array.isArray(s.balances)) return 'it carries no balances';
  const seen = new Set<string>();
  for (const b of s.balances as unknown[]) {
    const h = b as Partial<HeldAmount> | null;
    if (typeof h !== 'object' || h === null || !TOKEN.test(String(h.token)) || !DIGITS.test(String(h.amount))
      || !VISIBILITIES.includes(h.visibility as Visibility)) {
      return 'one of its balances is not a token, an amount and a side';
    }
    if (read[h.visibility as Visibility] === null) return 'it carries an amount for a side it says it could not read';
    const key = `${String(h.visibility)}:${String(h.token)}`;
    if (seen.has(key)) return 'it names one token twice on one side';
    seen.add(key);
  }
  return null;
}

/**
 * **THE MESSAGE A PERSON'S PRESS PRODUCES, AND THE ONLY THING THAT BUILDS ONE.**
 * `shown` is the very value the screen rendered: nothing is added to it and
 * nothing is taken out, so the page receives exactly what the person saw.
 */
export function addressesAndBalancesAnswerFor(
  request: AddressesAndBalancesRequest, shown: AddressesAndBalancesShown, at: number,
): AddressesAndBalances {
  if (!usableOrigin(request.requester.origin)) {
    throw new AddressesAndBalancesRefused('This wallet could not tell who asked, so nothing has been shown to them.');
  }
  const why = whyNotAddressesAndBalances(shown);
  if (why !== null) {
    throw new AddressesAndBalancesRefused(`What this wallet read is not whole (${why}), so nothing has been shown to them.`);
  }
  return Object.freeze({
    schema: ADDRESSES_AND_BALANCES_SCHEMA,
    origin: request.requester.origin,
    nonce: request.nonce,
    at,
    addresses: Object.freeze({ private: shown.addresses.private, public: shown.addresses.public }),
    balances: Object.freeze(shown.balances.map((b) => Object.freeze({ token: b.token, amount: b.amount, visibility: b.visibility }))),
    read: Object.freeze({ private: shown.read.private, public: shown.read.public }),
  });
}

export type AddressesAndBalancesRead =
  | { readonly ok: true; readonly shown: AddressesAndBalancesShown; readonly at: number }
  | {
    readonly ok: false;
    readonly code: 'not-an-answer' | 'origin-mismatch' | 'nonce-mismatch';
    readonly says: string;
  };

/**
 * THE PAGE'S SIDE. Every expectation is the page's own: where it is and the
 * nonce it chose. What it gets back is the wallet's reading, as shown.
 */
export function readAddressesAndBalancesAnswer(
  message: unknown,
  expecting: { readonly atOrigin: string; readonly expectingNonce: string },
): AddressesAndBalancesRead {
  const body = message as Partial<AddressesAndBalances> | null;
  if (typeof body !== 'object' || body === null || body.schema !== ADDRESSES_AND_BALANCES_SCHEMA) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a wallet\'s addresses and balances.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return {
      ok: false, code: 'origin-mismatch',
      says: `this was shown to ${String(body.origin)} and arrived at ${expecting.atOrigin}. It is refused.`,
    };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return { ok: false, code: 'nonce-mismatch', says: 'this answers a different request from the one that was sent.' };
  }
  const why = whyNotAddressesAndBalances(body);
  if (why !== null || typeof body.at !== 'number' || !Number.isSafeInteger(body.at)) {
    return { ok: false, code: 'not-an-answer', says: `this answer cannot be read: ${why ?? 'it carries no moment'}.` };
  }
  const shown = body as AddressesAndBalancesShown;
  return {
    ok: true,
    at: body.at,
    shown: {
      addresses: { private: shown.addresses.private, public: shown.addresses.public },
      balances: shown.balances.map((b) => ({ token: b.token, amount: b.amount, visibility: b.visibility })),
      read: { private: shown.read.private, public: shown.read.public },
    },
  };
}
