import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Purposes, identityFromWords } from '../keys/derivation.js';
import { committeeSigningKeyFor } from './committee-key.js';
import type { CompanyLabel } from './company-label.js';
import { SeatKeysError, seatKeysFor } from './seat-keys.js';

/*
 * A seat's keys, checked against an expansion through `@noble/hashes` from the
 * wallet's seat parent, whose own path other tests walk independently. Another
 * wallet's words stand in for another person.
 */
const CO_A = 'co_dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as CompanyLabel;
const CO_B = 'co_54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e' as CompanyLabel;
const OTHER_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon '
  + 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const text = (s: string) => new TextEncoder().encode(s);
const identity = identityFromWords(TEST_MNEMONIC);

const independent = (label: string, n: number, part: string): string =>
  hex(hkdf(sha256, identity.authority('seat', 0), text('midnight-identity/seat/v1'), text(`${label}/${n}/${part}`), 32));

const all = (k: { signingSecret: Uint8Array; wrappingSecret: Uint8Array; salt: Uint8Array }): string[] =>
  [hex(k.signingSecret), hex(k.wrappingSecret), hex(k.salt)];

describe('A SEAT\'S KEYS', () => {
  it('are expansions of the seat parent under the company\'s label and the seat\'s number, byte for byte', () => {
    /* RED WHEN: the salt is not the seat's own, the parent is not the seat purpose, or the label or number is left out of an expansion. */
    expect(all(seatKeysFor(identity, CO_A, 0))).toEqual(
      [independent(CO_A, 0, 'signing'), independent(CO_A, 0, 'wrapping'), independent(CO_A, 0, 'salt')]);
    expect(all(seatKeysFor(identity, CO_B, 7))).toEqual(
      [independent(CO_B, 7, 'signing'), independent(CO_B, 7, 'wrapping'), independent(CO_B, 7, 'salt')]);
  });

  it('are the same every time for the same words, company and seat number, and after a rebuild from the words', () => {
    /* RED WHEN: anything random enters a seat's keys, so a wallet rebuilt from its words could not make its seat again. */
    expect(all(seatKeysFor(identity, CO_A, 0))).toEqual(all(seatKeysFor(identityFromWords(TEST_MNEMONIC), CO_A, 0)));
  });

  it('differ for another company, another seat number and another person, and the three never repeat each other', () => {
    const a0 = all(seatKeysFor(identity, CO_A, 0));
    /* RED WHEN: the label is left out, so one person's seats in two companies share their keys. */
    const b0 = all(seatKeysFor(identity, CO_B, 0));
    /* RED WHEN: the seat number is left out, so a second seat in the same company reuses the first one's keys. */
    const a1 = all(seatKeysFor(identity, CO_A, 1));
    /* RED WHEN: the words are left out, so two people's seats in one company share their keys. */
    const other = all(seatKeysFor(identityFromWords(OTHER_WORDS), CO_A, 0));
    const every = [...a0, ...b0, ...a1, ...other];
    expect(new Set(every).size).toBe(every.length);
  });

  it('are not the committee key, nor the key of any other purpose this wallet holds', () => {
    const seat = all(seatKeysFor(identity, CO_A, 0));
    /* RED WHEN: a seat's keys come from the committee key, so the page would hold the key that changes the company's committee. */
    const committee = committeeSigningKeyFor(identity, CO_A).value;
    expect(seat).not.toContain(committee);
    /* RED WHEN: a seat's keys are any other purpose's key itself, so handing them to the page hands that key too. */
    const others = Object.values(Purposes).flatMap((p) => [hex(identity.authority(p, 0)), hex(identity.authority(p, 1))]);
    for (const s of seat) expect(others).not.toContain(s);
  });

  it('are thirty-two bytes each, the size a seat\'s signing secret, wrapping secret and blinding salt are read at', () => {
    const keys = seatKeysFor(identity, CO_A, 0);
    /* RED WHEN: a secret or the salt is cut short, so the seat's public keys or its blinding are made from fewer bytes than the leaf commits to. */
    expect([keys.signingSecret.length, keys.wrappingSecret.length, keys.salt.length]).toEqual([32, 32, 32]);
  });

  it('refuse anything that is not a company\'s label, and a seat number that is not a whole number in range', () => {
    /* RED WHEN: a seat's keys are made for an account's address, an upper-case label or a zero label. */
    for (const bad of [CO_A.slice(3), CO_A.toUpperCase(), `co_${'0'.repeat(64)}`, '', null]) {
      expect(() => seatKeysFor(identity, bad as CompanyLabel, 0)).toThrow(SeatKeysError);
    }
    /* RED WHEN: a negative, fractional or out-of-range seat number makes keys. */
    for (const n of [-1, 0.5, 2 ** 31, Number.NaN]) expect(() => seatKeysFor(identity, CO_A, n)).toThrow(SeatKeysError);
    expect(all(seatKeysFor(identity, CO_A, 2 ** 31 - 1))).toHaveLength(3);
  });
});
