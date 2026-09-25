import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from '../keys/derivation.js';
import { addressFor } from '../wallet/address.js';
import { parseAsk } from './request.js';
import type { UnlockRequest } from './request.js';
import {
  HELD_ADDRESS_SLOTS, heldAddressDigest, heldAddressList, listHolds, readHeldAddressList,
} from './held-address.js';
import { readRelease, releaseFor } from './unlock.js';
import { checkShieldedAddress } from '../wallet/address-shape.js';
import { bech32m } from '@scure/base';

/**
 * **THE WALLET SAYS WHICH ADDRESSES IT HOLDS WITHOUT NAMING ONE, AND THE PAGE
 * CAN TEST ONLY ADDRESSES IT ALREADY HAS.**
 */

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';
const COMPANY = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const mine = identityFromWords(TEST_MNEMONIC);
const theirs = identityFromWords(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon '
  + 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art');
const MY_MAIN = addressFor(mine.moneyAt(0).zswap, 'stagenet').bech32;
const MY_SUB = addressFor(mine.moneyAt(2).zswap, 'stagenet').bech32;
const COLLEAGUE = addressFor(theirs.moneyAt(0).zswap, 'stagenet').bech32;
/** The same coin key with the colleague's encryption key: the same "who may spend", another "who may read". */
const swapEncryptionKey = (address: string): string => {
  const mineChecked = checkShieldedAddress(address, 'stagenet');
  const theirsChecked = checkShieldedAddress(COLLEAGUE, 'stagenet');
  const bytes = Uint8Array.from(
    (mineChecked.coinPublicKey + theirsChecked.encryptionPublicKey).match(/../gu)!.map((b) => parseInt(b, 16)));
  return bech32m.encode('mn_shield-addr_stagenet', bech32m.toWords(bytes), false);
};

/** The ask a list answers, as the page holds it: its own nonce, its own origin, the company it asked about. */
const S = (nonce: string, origin = ORIGIN, company = COMPANY) => ({ nonce, origin, company });

const ask = (nonce: string): UnlockRequest => parseAsk({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'unlock',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So we can show you your payslips.',
  company: COMPANY,
  nonce,
  expiresAt: NOW + 60_000,
}, ORIGIN, NOW) as UnlockRequest;

describe('ONE DIGEST, OVER THE ADDRESS AND THE ASK\'S NONCE', () => {
  it('is the same for two spellings of one address and differs by nonce, by address and by network', () => {
    const d = heldAddressDigest(S('n1'), MY_MAIN);
    expect(d).toMatch(/^[0-9a-f]{64}$/u);
    /* RED WHEN the digest is taken over the text rather than the decoded bytes: upper case is the same address. */
    expect(heldAddressDigest(S('n1'), MY_MAIN.toUpperCase())).toBe(d);
    expect(heldAddressDigest(S('n1'), `  ${MY_MAIN} `)).toBe(d);
    /* RED WHEN the nonce is left out: two asks could then be compared. */
    expect(heldAddressDigest(S('n2'), MY_MAIN)).not.toBe(d);
    /* RED WHEN the keys are left out or truncated. */
    expect(heldAddressDigest(S('n1'), MY_SUB)).not.toBe(d);
    /* RED WHEN the network is left out: the same keys on another network are another address. */
    expect(heldAddressDigest(S('n1'), addressFor(mine.moneyAt(0).zswap, 'preview').bech32)).not.toBe(d);
    /*
     * RED WHEN the origin or the company is left out: two sites, or one site
     * asking about two companies, that send the same nonce could then compare
     * their lists and tell they are serving one wallet.
     */
    expect(heldAddressDigest(S('n1', 'https://other-payroll.example'), MY_MAIN)).not.toBe(d);
    expect(heldAddressDigest(S('n1', ORIGIN, '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e'), MY_MAIN))
      .not.toBe(d);
    /* The one spelling a company address has: RED WHEN the company is hashed as it arrived. */
    expect(heldAddressDigest(S('n1', ORIGIN, COMPANY.toUpperCase()), MY_MAIN)).toBe(d);
    /* RED WHEN only the coin key is digested: an address differing in its encryption key alone is another address. */
    expect(heldAddressDigest(S('n1'), swapEncryptionKey(MY_MAIN))).not.toBe(d);
  });

  it('is no digest at all for something that is not a shielded address', () => {
    for (const junk of ['', 'hello', COMPANY, MY_MAIN.slice(0, -1) + (MY_MAIN.endsWith('q') ? 'p' : 'q')]) {
      /* RED WHEN a string that does not decode is hashed as text. */
      expect(heldAddressDigest(S('n1'), junk), junk).toBeNull();
    }
  });
});

describe('THE WALLET\'S LIST', () => {
  it('is always the same length, sorted, and holds exactly the digests of what it was given', () => {
    const list = heldAddressList(S('n1'), [MY_MAIN, MY_SUB]);
    /* RED WHEN the filler is dropped: the length would tell how many accounts the wallet has. */
    expect(list).toHaveLength(HELD_ADDRESS_SLOTS);
    expect(heldAddressList(S('n1'), [])).toHaveLength(HELD_ADDRESS_SLOTS);
    /* RED WHEN the list is left in account order. */
    expect([...list].sort()).toEqual(list);
    expect(list).toContain(heldAddressDigest(S('n1'), MY_MAIN));
    expect(list).toContain(heldAddressDigest(S('n1'), MY_SUB));
    /* RED WHEN an address itself, rather than its digest, goes into the list. */
    expect(list.some((d) => d.includes('shield'))).toBe(false);
  });

  it('fills with fresh randomness, so a digest cannot be told from filler and two lists share only what is real', () => {
    const asked: number[] = [];
    const counting = (n: number) => { asked.push(n); return crypto.getRandomValues(new Uint8Array(n)); };
    heldAddressList(S('n1'), [MY_MAIN, MY_SUB], counting);
    /* RED WHEN the filler is not one fresh 32-byte draw per empty slot. */
    expect(asked).toEqual(Array.from({ length: HELD_ADDRESS_SLOTS - 2 }, () => 32));
    const a = heldAddressList(S('n1'), [MY_MAIN, MY_SUB]);
    const b = heldAddressList(S('n1'), [MY_MAIN, MY_SUB]);
    /* RED WHEN the filler is constant: it would then be told apart from the digests, and so would the count. */
    expect(a.filter((d) => b.includes(d)).sort())
      .toEqual([heldAddressDigest(S('n1'), MY_MAIN), heldAddressDigest(S('n1'), MY_SUB)].sort());
  });

  it('refuses to answer for more addresses than it has room for', () => {
    const many = Array.from({ length: HELD_ADDRESS_SLOTS + 1 }, (_, i) =>
      addressFor(mine.moneyAt(i === 1 ? 40 : i).zswap, 'stagenet').bech32);
    /* RED WHEN a longer list is sent: its length would say how many accounts there are. */
    expect(() => heldAddressList(S('n1'), many)).toThrow(/at most/u);
  });

  it('is read back only as exactly that many digests', () => {
    const list = heldAddressList(S('n1'), [MY_MAIN]);
    expect(readHeldAddressList(list)).toEqual(list);
    /* RED WHEN a list of another length, or holding something that is not a digest, is taken. */
    for (const odd of [undefined, null, 'x', list.slice(1), [...list, list[0]], [...list.slice(1), MY_MAIN]]) {
      expect(readHeldAddressList(odd), JSON.stringify(odd)?.slice(0, 40)).toBeNull();
    }
  });
});

describe('THE RELEASE CARRIES IT, AND THE PAGE TESTS ONLY WHAT IT HAS', () => {
  it('a slip paid to one of the wallet\'s own addresses is confirmed; a colleague\'s is not', () => {
    const released = releaseFor(mine, ask('page-nonce'), NOW, undefined, [MY_MAIN, MY_SUB]);
    const read = readRelease(released, { atOrigin: ORIGIN, expectingNonce: 'page-nonce', forCompany: COMPANY });
    expect(read.ok).toBe(true);
    const held = read.ok ? read.held : null;
    expect(held).not.toBeNull();
    /* RED WHEN the wallet's side and the page's side take different digests. */
    expect(listHolds(held!, S('page-nonce'), MY_MAIN)).toBe(true);
    expect(listHolds(held!, S('page-nonce'), MY_SUB)).toBe(true);
    /* RED WHEN anything other than a digest match confirms. */
    expect(listHolds(held!, S('page-nonce'), COLLEAGUE)).toBe(false);
    /* RED WHEN the check does not use the nonce of the ask it answers. */
    expect(listHolds(held!, S('another-nonce'), MY_MAIN)).toBe(false);
  });

  it('TWO SITES THAT SEND THE SAME NONCE GET LISTS THAT SHARE NOTHING, SO THEY CANNOT TELL THEY SERVE ONE WALLET', () => {
    const at = (origin: string, company: string) => parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'unlock',
      requester: { name: 'A payroll', rdns: 'example.payroll' }, purpose: 'Payslips.',
      company, nonce: 'the-same-nonce', expiresAt: NOW + 60_000,
    }, origin, NOW) as UnlockRequest;
    const OTHER_CO = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
    const first = releaseFor(mine, at(ORIGIN, COMPANY), NOW, undefined, [MY_MAIN, MY_SUB]).held!;
    const otherSite = releaseFor(mine, at('https://other-payroll.example', COMPANY), NOW, undefined, [MY_MAIN, MY_SUB]).held!;
    const otherCompany = releaseFor(mine, at(ORIGIN, OTHER_CO), NOW, undefined, [MY_MAIN, MY_SUB]).held!;
    /* RED WHEN the wallet leaves the observed origin or the company out of the digest. */
    expect(first.filter((d) => otherSite.includes(d))).toEqual([]);
    expect(first.filter((d) => otherCompany.includes(d))).toEqual([]);
    /* Each site can still test the address it has, under its own origin and company. */
    expect(listHolds(otherSite, S('the-same-nonce', 'https://other-payroll.example'), MY_MAIN)).toBe(true);
    expect(listHolds(otherCompany, S('the-same-nonce', ORIGIN, OTHER_CO), MY_MAIN)).toBe(true);
  });

  it('no address, in the clear, is anywhere in the message', () => {
    const released = releaseFor(mine, ask('page-nonce'), NOW, undefined, [MY_MAIN, MY_SUB]);
    const text = JSON.stringify(released);
    /* RED WHEN an address, or either of its keys, is put on the wire. */
    expect(text.includes('shield-addr')).toBe(false);
    expect(text.includes(MY_MAIN)).toBe(false);
    for (const a of [MY_MAIN, MY_SUB]) {
      const keys = checkShieldedAddress(a, 'stagenet');
      expect(text.includes(keys.coinPublicKey)).toBe(false);
      expect(text.includes(keys.encryptionPublicKey)).toBe(false);
    }
  });

  it('a wallet that says nothing reads as nothing, and still releases', () => {
    const read = readRelease(releaseFor(mine, ask('page-nonce'), NOW),
      { atOrigin: ORIGIN, expectingNonce: 'page-nonce', forCompany: COMPANY });
    expect(read.ok).toBe(true);
    /* RED WHEN an absent list reads as an empty list that could be tested. */
    expect(read.ok && read.held).toBeNull();
  });
});
