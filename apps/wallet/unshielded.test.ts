// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { createKeystore } from '@midnightntwrk/wallet-sdk';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import { addressFor, identityFromWords } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import { NETWORK } from './config.js';
import {
  shortUnshielded, unshieldedAddressFor, unshieldedKeystoreFor, unshieldedWalletFor,
} from './unshielded.js';
import { ownedAddressFor } from './owned-address.js';
import { WALLET_ACCOUNTS } from './subwallets.js';

/*
 * THE UNSHIELDED DOOR, HELD TO THE SAME BAR AS THE SHIELDED ONE.
 *
 * The test that decides whether this is safe is the same one that decided it
 * for the shielded side (§1.1 of the balances rules): the wallet that SYNCS
 * and the address that is SHOWN must be the same wallet, proved by asking
 * the SDK wallet for its own address and comparing byte for byte. The traps
 * here are one argument away — a wrong signature KIND, or the wrong
 * thirty-two BYTES — and each is demonstrated below, not described.
 *
 * Nothing here touches the network: constructing the unshielded wallet and
 * asking its address is local, exactly as it is for the shielded one.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const ours: Identity = identityFromWords(TEST_MNEMONIC);

describe('the right unshielded door — the address-agreement test', () => {
  it('the wallet that would sync IS the address the card shows, per account', async () => {
    for (const account of [0, 2, 11]) {
      const wallet = unshieldedWalletFor(ours, account);
      const fromWallet = MidnightBech32m.encode(NETWORK, await wallet.getAddress()).asString();
      await wallet.stop().catch(() => {});
      expect(fromWallet).toBe(unshieldedAddressFor(ours, account));
    }
  }, 60_000);

  it('the address carries the network, and is a DIFFERENT string per account', () => {
    const seen = new Set<string>();
    for (const account of WALLET_ACCOUNTS) {
      const address = unshieldedAddressFor(ours, account);
      expect(address).toMatch(/^mn_addr_stagenet1/);
      seen.add(address);
    }
    /* Eleven wallets, eleven addresses — a repeat would mean two subwallets
     * share money. */
    expect(seen.size).toBe(WALLET_ACCOUNTS.length);
  });

  it('the wrong KIND is a different wallet — demonstrated, not described', () => {
    /* The same thirty-two bytes under `'ecdsa'` produce a different address:
     * money paid there is at an address this interface never shows. */
    const bytes = ours.moneyAt(0).night;
    const wrongKind = createKeystore({ kind: 'ecdsa', secret: bytes }, NETWORK)
      .getBech32Address().asString();
    expect(wrongKind).toMatch(/^mn_addr_stagenet1/); /* plausible-looking… */
    expect(wrongKind).not.toBe(unshieldedAddressFor(ours, 0)); /* …and wrong. */
  });

  it('the wrong BYTES are a different wallet — the zswap key is not the night key', () => {
    /* One field name away: `moneyAt(account).zswap` fed to the unshielded
     * keystore derives an address no route ever pays. */
    const wrongBytes = createKeystore(
      { kind: 'schnorr', secret: ours.moneyAt(0).zswap }, NETWORK,
    ).getBech32Address().asString();
    expect(wrongBytes).not.toBe(unshieldedAddressFor(ours, 0));
  });

  it('is unrelated to the shielded address — two kinds, two strings, one wallet', () => {
    /* Not a trap, a fact worth pinning: the card shows both because neither
     * can be computed from the other by the person holding them. */
    expect(unshieldedAddressFor(ours, 0))
      .not.toBe(addressFor(ours.moneyAt(0).zswap, NETWORK).bech32);
  });

  it('refuses the reserved account and slots the picker does not offer', () => {
    expect(() => unshieldedKeystoreFor(ours, 1)).toThrow(/authority/);
    expect(() => unshieldedKeystoreFor(ours, 12)).toThrow(/not a wallet/);
  });
});

describe('the unshielded address travels with its owner — the OwnedAddress rule', () => {
  it('ownedAddressFor carries the SAME string the unshielded wallet syncs', () => {
    /* The one door from a slot to a renderable address now carries both
     * kinds — so a screen cannot show an unshielded address that is not the
     * synced wallet's own. */
    for (const account of [0, 2, 11]) {
      expect(ownedAddressFor(ours, account, {}, NETWORK).unshieldedBech32)
        .toBe(unshieldedAddressFor(ours, account));
    }
  });

  it('the short form keeps BOTH ends, applied to the unshielded string', () => {
    const address = unshieldedAddressFor(ours, 0);
    const short = shortUnshielded(address);
    const payload = address.slice(address.lastIndexOf('1') + 1);
    expect(short).toBe(
      `${address.slice(0, address.lastIndexOf('1') + 1)}${payload.slice(0, 8)}…${payload.slice(-8)}`);
    expect(short.startsWith('mn_addr_stagenet1')).toBe(true);
    expect(short.endsWith(payload.slice(-8))).toBe(true);
  });
});
