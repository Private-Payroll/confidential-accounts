/**
 * **THE ADDRESS A JOINER TAKES THEIR SEAT WITH IS BELIEVED ONLY AS THEIR OWN WALLET SIGNED IT, FOR THAT COMPANY AND
 * THAT LEAF, AND ONLY AS ITS COIN KEY MAKES IT.** The wallet signs its coin key and salt and the address is worked out
 * from them, never handed in. Anything else - another wallet's signature, another coin key, address or salt, another
 * leaf or company, or no address at all - is refused by its reason.
 */
import { describe, it, expect } from 'vitest';
import type { Hex } from './crypto.js';
import { SimulatedCommitments } from './ledger.js';
import { seatAddressSignedFor, signSeatAddress } from './seat-address.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { aJoinersWallet, aWalletSecret } from '../testing/a-joiners-wallet.js';

const COMPANY = 'acc_seat_address';
const LEAF = '1a'.repeat(32) as Hex;
const MADE = (c: Hex, salt: Hex) => MidnightCommitments.inviteAddressOf(c, salt);
const dee = aJoinersWallet(aWalletSecret(), 61);
const other = aJoinersWallet(aWalletSecret(), 62);

describe('THE ADDRESS A JOINER TAKES THEIR SEAT WITH', () => {
  it('is believed as the joiner\'s own wallet signed it for this company and leaf, made from its own coin key', async () => {
    const signed = await dee.seatAddress({ accountId: COMPANY }, LEAF);
    /* RED WHEN: an address its wallet signed for this seat, made from its coin key, is refused. */
    expect(seatAddressSignedFor(signed, dee.walletKey, COMPANY, LEAF, MADE)).toEqual({
      coinPublicKey: dee.holds.coinPublicKey.toLowerCase(), address: dee.at.address.toLowerCase(), salt: dee.at.addressSalt.toLowerCase(), signature: signed.signature,
    });
    /* RED WHEN: case decides whether a signature holds. */
    expect(typeof seatAddressSignedFor({ ...signed, address: signed.address.toUpperCase() }, { ...dee.walletKey, value: dee.walletKey.value.toUpperCase() }, COMPANY, LEAF.toUpperCase(), MADE)).toBe('object');
  });

  it('is refused when another wallet signed it, or it names another coin key, address, salt, leaf or company, or there is none', async () => {
    const signed = await dee.seatAddress({ accountId: COMPANY }, LEAF);
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof seatAddressSignedFor>, string]> = [
      /* RED WHEN: a signature by another wallet than the one the seat's leaf commits to is believed. */
      ['another wallet', seatAddressSignedFor(await other.seatAddress({ accountId: COMPANY }, LEAF), dee.walletKey, COMPANY, LEAF, MADE), 'not-signed'],
      /* RED WHEN: a raising seat can put its own address under the joiner's signature. */
      ['another address', seatAddressSignedFor({ ...signed, address: other.at.address }, dee.walletKey, COMPANY, LEAF, MADE), 'not-made'],
      /* RED WHEN: another wallet's coin key with its own address is put under the joiner's signature. */
      ['another coin key and address', seatAddressSignedFor({ ...signed, coinPublicKey: other.holds.coinPublicKey, address: other.at.address, salt: other.at.addressSalt }, dee.walletKey, COMPANY, LEAF, MADE), 'not-signed'],
      /* RED WHEN: the coin key is not covered by the signature, so a reading that only checks it believes another wallet's key. */
      ['another coin key, signature alone', seatAddressSignedFor({ ...signed, coinPublicKey: other.holds.coinPublicKey }, dee.walletKey, COMPANY, LEAF, null), 'not-signed'],
      /* RED WHEN: the salt is not covered by the signature. */
      ['another salt', seatAddressSignedFor({ ...signed, salt: other.at.addressSalt }, dee.walletKey, COMPANY, LEAF, MADE), 'not-made'],
      /* RED WHEN: an address signed for one seat is believed for another. */
      ['another leaf', seatAddressSignedFor(signed, dee.walletKey, COMPANY, '2b'.repeat(32), MADE), 'not-signed'],
      /* RED WHEN: an address signed for one company is believed in another. */
      ['another company', seatAddressSignedFor(signed, dee.walletKey, 'acc_another', LEAF, MADE), 'not-signed'],
      /* RED WHEN: a request with no signed address is believed. */
      ['no address', seatAddressSignedFor(undefined, dee.walletKey, COMPANY, LEAF, MADE), 'none'],
      /* RED WHEN: a request whose opening names no wallet key is believed. */
      ['no wallet key', seatAddressSignedFor(signed, undefined, COMPANY, LEAF, MADE), 'not-signed'],
      /* RED WHEN: a signature that is not one is read past. */
      ['no signature', seatAddressSignedFor({ ...signed, signature: 'zz' }, dee.walletKey, COMPANY, LEAF, MADE), 'not-signed'],
      /* RED WHEN: an address is believed without working it out again from the coin key, where the reading can. */
      ['made by another scheme', seatAddressSignedFor(signed, dee.walletKey, COMPANY, LEAF, (c, salt) => SimulatedCommitments.inviteAddressOf(c, salt)), 'not-made'],
    ];
    for (const [why, got, reason] of cases) expect([why, got]).toEqual([why, reason]);
  });

  it('works the address out itself from the wallet\'s coin key and salt, and takes no address to sign', () => {
    const coin = MidnightCommitments.coinPublicKeyOf('3c'.repeat(32) as Hex);
    const s = signSeatAddress(aWalletSecret(), COMPANY, LEAF, { coinPublicKey: coin.toUpperCase(), salt: 'CD'.repeat(32) }, MADE);
    /* RED WHEN: the signed address is not the one the account's function makes from the wallet's own coin key and salt. */
    expect([s.coinPublicKey, s.address, s.salt]).toEqual([coin.toLowerCase(), MidnightCommitments.inviteAddressOf(coin, 'cd'.repeat(32) as Hex).toLowerCase(), 'cd'.repeat(32)]);
    /* RED WHEN: an address handed in beside the coin key is signed instead of the one the coin key makes. */
    const handed = signSeatAddress(aWalletSecret(), COMPANY, LEAF, { coinPublicKey: coin, salt: 'cd'.repeat(32), address: 'ee'.repeat(32) } as { coinPublicKey: string; salt: string }, MADE);
    expect(handed.address).toBe(s.address);
    expect(s.signature).toMatch(/^[0-9a-f]{128}$/u);
  });
});
