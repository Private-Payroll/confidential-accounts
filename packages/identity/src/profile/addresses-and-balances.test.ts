import { describe, expect, it } from 'vitest';
import { parseAsk, RequestError, type AddressesAndBalancesRequest } from './request.js';
import {
  ADDRESSES_AND_BALANCES_SCHEMA, AddressesAndBalancesRefused, addressesAndBalancesAnswerFor, readAddressesAndBalancesAnswer,
  type AddressesAndBalancesShown,
} from './addresses-and-balances.js';

/*
 * A page asking one of this person's wallets where it receives and what it
 * holds: the ask carries nothing of its own, and the answer is what the screen
 * showed, every amount marked private or public, and a side the wallet could
 * not read said as not known rather than as nothing.
 */

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';
const NIGHT = '00'.repeat(32);
const OTHER = 'ab'.repeat(32);
const PRIVATE = `mn_shield-addr_test1${'q'.repeat(60)}`;
const PUBLIC = `mn_addr_test1${'p'.repeat(60)}`;
const body = (more: Record<string, unknown> = {}) => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'addresses-and-balances',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To show your deposit options.',
  nonce: 'ab1', expiresAt: NOW + 600_000, ...more,
});
const ask = (): AddressesAndBalancesRequest => parseAsk(body(), ORIGIN, NOW) as AddressesAndBalancesRequest;
const refusal = (raw: unknown): RequestError => {
  try { parseAsk(raw, ORIGIN, NOW); } catch (e) { return e as RequestError; }
  throw new Error('it was not refused');
};
const SHOWN: AddressesAndBalancesShown = {
  addresses: { private: PRIVATE, public: PUBLIC },
  balances: [
    { token: NIGHT, amount: '5000000', visibility: 'private' },
    { token: OTHER, amount: '7', visibility: 'private' },
    { token: NIGHT, amount: '12', visibility: 'public' },
  ],
  read: { private: NOW - 5, public: NOW - 3 },
};

describe('THE ASK FOR A WALLET\'S ADDRESSES AND BALANCES', () => {
  it('parses with nothing of its own, and its origin is the one observed', () => {
    const parsed = ask();
    /* RED WHEN: the kind is not answered at all, or the origin is taken from anywhere but the browser. */
    expect(parsed.kind).toBe('addresses-and-balances');
    expect(parsed.requester.origin).toBe(ORIGIN);
  });

  it('REFUSES ANYTHING MORE THAN EVERY ASK CARRIES, BY NAME: THE WALLET THAT ANSWERS IS THE PERSON\'S CHOICE', () => {
    /* RED WHEN: a page can name which wallet answers, or ask to hear the wallet while it works, and the extra is ignored rather than refused. */
    for (const extra of [{ account: 0 }, { wallet: 'main' }, { progress: 'midnight-identity/wallet-progress/v1' }, { tokens: [NIGHT] }]) {
      const e = refusal(body(extra));
      expect(e.code, JSON.stringify(extra)).toBe('more-than-addresses-and-balances');
      expect(e.message).toContain(`'${Object.keys(extra)[0]}'`);
    }
    /* RED WHEN: a page that proposes an address is answered; the rule every kind keeps holds for this one. */
    expect(refusal(body({ address: PUBLIC })).code).toBe('proposes-an-address');
    expect(refusal(body({ company: `co_${'d5'.repeat(32)}` })).code).toBe('more-than-addresses-and-balances');
  });
});

describe('THE ANSWER IS WHAT THE SCREEN SHOWED, AND NOTHING ELSE', () => {
  it('carries the shown addresses, amounts and moments unchanged, with the observed origin and the ask\'s nonce', () => {
    const answer = addressesAndBalancesAnswerFor(ask(), SHOWN, NOW);
    /* RED WHEN: the answer adds, drops or changes anything the screen showed. */
    expect({ addresses: answer.addresses, balances: answer.balances, read: answer.read }).toEqual(SHOWN);
    expect(answer.schema).toBe(ADDRESSES_AND_BALANCES_SCHEMA);
    expect(answer.origin).toBe(ORIGIN);
    expect(answer.nonce).toBe('ab1');
  });

  it('A SIDE THAT WAS NOT READ IS NOT KNOWN: IT CARRIES NO AMOUNT, AND ONE ARRIVING FOR IT IS REFUSED', () => {
    const notRead: AddressesAndBalancesShown = { ...SHOWN, balances: [SHOWN.balances[2]!], read: { private: null, public: NOW } };
    /* RED WHEN: a side the wallet could not read cannot be said at all. */
    expect(addressesAndBalancesAnswerFor(ask(), notRead, NOW).read.private).toBeNull();
    /* RED WHEN: an amount for an unread side is handed over, so "not known" reads as a figure. */
    expect(() => addressesAndBalancesAnswerFor(ask(), { ...notRead, balances: SHOWN.balances }, NOW))
      .toThrow(AddressesAndBalancesRefused);
  });

  it('refuses what is not whole: one address for both sides, a token twice, an amount that is not whole digits', () => {
    for (const [why, bent] of [
      ['one address for both', { ...SHOWN, addresses: { private: PUBLIC, public: PUBLIC } }],
      ['a token twice', { ...SHOWN, balances: [...SHOWN.balances, SHOWN.balances[0]!] }],
      ['not whole digits', { ...SHOWN, balances: [{ token: NIGHT, amount: '1.5', visibility: 'private' }] }],
      ['no side', { ...SHOWN, balances: [{ token: NIGHT, amount: '1', visibility: 'shielded' }] }],
    ] as const) {
      /* RED WHEN: the named defect is handed to a page. */
      expect(() => addressesAndBalancesAnswerFor(ask(), bent as never, NOW), why).toThrow(AddressesAndBalancesRefused);
    }
  });
});

describe('THE PAGE BELIEVES AN ANSWER TO ITS OWN QUESTION, AND NOTHING ELSE', () => {
  const expecting = { atOrigin: ORIGIN, expectingNonce: 'ab1' };
  it('reads the answer whole', () => {
    const read = readAddressesAndBalancesAnswer(JSON.parse(JSON.stringify(addressesAndBalancesAnswerFor(ask(), SHOWN, NOW))), expecting);
    /* RED WHEN: the page reads back anything but what the wallet showed. */
    expect(read).toEqual({ ok: true, shown: SHOWN, at: NOW });
  });
  it('refuses another page\'s, another nonce\'s, and one that is not whole', () => {
    const good = JSON.parse(JSON.stringify(addressesAndBalancesAnswerFor(ask(), SHOWN, NOW)));
    /* RED WHEN: an answer shown to another page, to another ask, or carrying an amount for an unread side is believed. */
    expect(readAddressesAndBalancesAnswer({ ...good, origin: 'https://elsewhere.example' }, expecting)).toMatchObject({ ok: false, code: 'origin-mismatch' });
    expect(readAddressesAndBalancesAnswer({ ...good, nonce: 'ab2' }, expecting)).toMatchObject({ ok: false, code: 'nonce-mismatch' });
    expect(readAddressesAndBalancesAnswer({ ...good, read: { private: null, public: NOW } }, expecting)).toMatchObject({ ok: false, code: 'not-an-answer' });
    expect(readAddressesAndBalancesAnswer({ ...good, schema: 'x' }, expecting)).toMatchObject({ ok: false, code: 'not-an-answer' });
  });
});
