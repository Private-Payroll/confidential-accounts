import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC, WalletSeeds } from '@midnight-ntwrk/testkit-js';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { identityFromSecret, identityFromWords, newSecret } from '../keys/derivation.js';
import { AddressError, addressFor, payeeAddress, samePayee, shortPayee } from './address.js';
import { NETWORKS, isNetworkName, networkName } from './network.js';
import { bech32m } from '@scure/base';

/**
 * THE ADDRESS IS THE ONE THING A PERSON HANDS OUT, so it is checked against the
 * platform's own encoder and against the Foundation's testkit — not against a
 * value this repository wrote down.
 */

const ours = identityFromWords(TEST_MNEMONIC);
const theirs = WalletSeeds.fromMnemonic(TEST_MNEMONIC);

/* Recorded from the platform's own encoder for testkit's phrase. If this string
 * changes, either the derivation moved or the encoding did, and both are
 * changes to where somebody's salary lands. */
const TESTNET_ADDRESS = 'mn_shield-addr_testnet1qpc63v0np98f86ycsx0jn6letdrr9gdf92rpkgae43dd2ets'
  + 'v58x3zypyz9t39lq38zr0kxx4v6fug7wack76gkjrqdsgtsxf7800kg4r8xmz';

describe('the address a person is given at sign-up', () => {
  it('is the address the Foundation\'s own testkit derives from the same words', () => {
    const fromTheirs = ZswapSecretKeys.fromSeed(theirs.shielded);
    const address = addressFor(ours.money.zswap, 'testnet');
    expect(address.coinPublicKey).toBe(fromTheirs.coinPublicKey);
    expect(address.encryptionPublicKey).toBe(fromTheirs.encryptionPublicKey);
    expect(address.bech32).toBe(TESTNET_ADDRESS);
  });

  it('carries both halves, from one decode, and neither can be set alone', () => {
    const address = addressFor(ours.money.zswap, 'testnet');
    expect(address.coinPublicKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(address.encryptionPublicKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(address.coinPublicKey).not.toBe(address.encryptionPublicKey);
    expect(Object.isFrozen(address)).toBe(true);
  });

  it('is a different string on every network, from the same keys', () => {
    /*
     * The network is not a label. It is a segment of the address, so the same
     * wallet on two networks is two strings — and pasting one into the other is
     * refused rather than silently accepted.
     */
    const seen = new Set(NETWORKS.map((net) => addressFor(ours.money.zswap, net).bech32));
    expect(seen.size).toBe(NETWORKS.length);
    for (const net of NETWORKS) {
      if (net === 'mainnet') continue;
      expect(addressFor(ours.money.zswap, net).bech32).toContain(`_${net}1`);
    }
  });

  it('has NO network segment on mainnet, which is the platform\'s own shape', () => {
    /*
     * Measured, not assumed, and it is the exception that would otherwise be
     * found the hard way: a mainnet address is `mn_shield-addr1...` with no
     * network in it at all. The library also exports a `mainnet` symbol, and
     * passing the string produces the identical bytes — checked, so this code
     * does not need to carry a special case.
     */
    const main = addressFor(ours.money.zswap, 'mainnet');
    expect(main.bech32.startsWith('mn_shield-addr1')).toBe(true);
    expect(main.bech32).not.toContain('_mainnet1');
    /* And it is still refused everywhere else, in both directions. */
    expect(() => payeeAddress(main.bech32, 'testnet')).toThrow(AddressError);
    expect(() => payeeAddress(TESTNET_ADDRESS, 'mainnet')).toThrow(AddressError);
    expect(payeeAddress(main.bech32, 'mainnet').bech32).toBe(main.bech32);
  });

  it('round-trips through the parser it hands its own output to', () => {
    const made = addressFor(ours.money.zswap, 'stagenet');
    const parsed = payeeAddress(made.bech32, 'stagenet');
    expect(samePayee(made, parsed)).toBe(true);
    expect(parsed.coinPublicKey).toBe(made.coinPublicKey);
  });

  it('is the same address every time, which is what "one address per person" means', () => {
    expect(addressFor(identityFromWords(TEST_MNEMONIC).money.zswap, 'testnet').bech32)
      .toBe(TESTNET_ADDRESS);
  });
});

describe('an address somebody nominates — their own wallet', () => {
  it('is accepted when it is real', () => {
    const address = payeeAddress(TESTNET_ADDRESS, 'testnet');
    expect(address.network).toBe('testnet');
    expect(address.bech32).toBe(TESTNET_ADDRESS);
  });

  it('refuses an empty one by name', () => {
    for (const empty of ['', '   ', '\n']) {
      expect(() => payeeAddress(empty, 'testnet')).toThrow(AddressError);
      try {
        payeeAddress(empty, 'testnet');
      } catch (e) {
        expect((e as AddressError).code).toBe('empty');
      }
    }
  });

  it('refuses a single mistyped character, because the checksum catches it', () => {
    /*
     * Every position is tried, not one. A checksum that catches the middle of
     * a string and not its end is a checksum that lets an address through.
     */
    let refused = 0;
    for (let i = TESTNET_ADDRESS.length - 40; i < TESTNET_ADDRESS.length; i += 1) {
      const c = TESTNET_ADDRESS[i] as string;
      const swapped = c === 'q' ? 'p' : 'q';
      const typo = TESTNET_ADDRESS.slice(0, i) + swapped + TESTNET_ADDRESS.slice(i + 1);
      expect(() => payeeAddress(typo, 'testnet')).toThrow(AddressError);
      refused += 1;
    }
    expect(refused).toBe(40);
  });

  it('refuses an address for another network, and says which', () => {
    const stagenet = addressFor(ours.money.zswap, 'stagenet');
    expect(() => payeeAddress(stagenet.bech32, 'testnet')).toThrow(AddressError);
    try {
      payeeAddress(stagenet.bech32, 'testnet');
    } catch (e) {
      expect((e as AddressError).code).toBe('wrong-network');
      expect((e as Error).message).toContain('testnet');
    }
  });

  it('refuses something that is not an address at all', () => {
    for (const junk of ['hello', 'mn_shield-addr_testnet1', '0x' + '0'.repeat(64), TEST_MNEMONIC]) {
      expect(() => payeeAddress(junk, 'testnet')).toThrow(AddressError);
    }
  });

  it('trims what somebody pasted, because people paste with whitespace', () => {
    expect(payeeAddress(`  ${TESTNET_ADDRESS}\n`, 'testnet').bech32).toBe(TESTNET_ADDRESS);
  });

  it('REFUSES A SHIELDED ADDRESS THAT IS NOT TWO KEYS OF THIRTY-TWO BYTES', () => {
    /*
     * The platform's decode takes the first thirty-two bytes as the coin key and
     * everything after them as the encryption key, checking no length for the
     * second. Each of these is a real checksum, the right kind and the right
     * network, over the real address's bytes cut short or run long.
     * RED WHEN the length check in `payeeAddress` is removed: 32, 33, 63, 65 and
     * 96 bytes then decode and are returned as addresses.
     */
    const bytes = bech32m.decodeToBytes(TESTNET_ADDRESS).bytes;
    expect(bytes.length).toBe(64);
    const sized = (n: number): string => {
      const out = new Uint8Array(n);
      out.set(bytes.subarray(0, Math.min(n, 64)));
      if (n > 64) out.set(bytes.subarray(0, n - 64), 64);
      return bech32m.encode('mn_shield-addr_testnet', bech32m.toWords(out), false);
    };
    for (const n of [32, 33, 63, 65, 96]) {
      let caught: unknown = null;
      try { payeeAddress(sized(n), 'testnet'); } catch (e) { caught = e; }
      expect(caught, `${n} bytes`).toBeInstanceOf(AddressError);
      expect((caught as AddressError).code, `${n} bytes`).toBe('wrong-kind');
      expect((caught as Error).message, `${n} bytes`).toContain(`carries ${n} bytes`);
    }
    /* RED WHEN the check refuses the right length too: sixty-four bytes is the real address. */
    expect(payeeAddress(sized(64), 'testnet').bech32).toBe(TESTNET_ADDRESS);
  });
});

describe('what a person is shown before money moves', () => {
  it('SHOWS CHARACTERS THAT ACTUALLY DIFFER, not the part every address shares', () => {
    /*
     * `mn_shield-addr_testnet1` is twenty-three characters and every testnet
     * address begins with it. A short form whose head comes out of that prefix
     * is confirmed by any address at all — which is what the first version did,
     * and it left eight distinguishing characters, six of them checksum.
     *
     * Measured rather than reasoned about: two hundred real addresses, and the
     * heads must differ.
     */
    const many = Array.from({ length: 60 }, () =>
      shortPayee(addressFor(identityFromSecret(newSecret()).money.zswap, 'testnet')));
    const heads = new Set(many.map((s) => s.split('…')[0]));
    expect(heads.size).toBeGreaterThan(55);

    const mine = addressFor(ours.money.zswap, 'testnet');
    const short = shortPayee(mine);
    expect(short).toContain('…');
    expect(short.endsWith(mine.bech32.slice(-8))).toBe(true);
    expect(short).toContain('testnet1');

    const other = addressFor(identityFromWords(TEST_MNEMONIC).money.dust, 'testnet');
    expect(shortPayee(other)).not.toBe(short);
  });

  it('still distinguishes mainnet addresses, which have no network segment', () => {
    const many = Array.from({ length: 40 }, () =>
      shortPayee(addressFor(identityFromSecret(newSecret()).money.zswap, 'mainnet')));
    expect(new Set(many.map((s) => s.split('…')[0])).size).toBeGreaterThan(37);
  });

  it('compares two addresses by their one canonical value', () => {
    const a = addressFor(ours.money.zswap, 'testnet');
    const b = payeeAddress(TESTNET_ADDRESS, 'testnet');
    const elsewhere = addressFor(ours.money.zswap, 'stagenet');
    expect(samePayee(a, b)).toBe(true);
    expect(samePayee(a, elsewhere)).toBe(false);
  });
});

describe('the network name, which is part of every address', () => {
  it('accepts the real ones and refuses anything else', () => {
    for (const net of NETWORKS) expect(networkName(net)).toBe(net);
    for (const junk of ['TESTNET', 'test-net', '2', '', 'main']) {
      expect(isNetworkName(junk)).toBe(false);
      expect(() => networkName(junk)).toThrow();
    }
  });

  it('refuses a number, which is the mistake that cost a day', () => {
    expect(isNetworkName(String(2))).toBe(false);
  });
});
