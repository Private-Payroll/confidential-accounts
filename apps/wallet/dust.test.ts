// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { DustSecretKey } from '@midnightntwrk/ledger-v9';
import { DustAddress, MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import { identityFromWords } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import { NETWORK } from './config.js';
import { dustAddressFor, dustSecretKeyFor, dustWalletFor } from './dust.js';
import { WALLET_ACCOUNTS } from './subwallets.js';

/*
 * THE DUST DOOR, HELD TO THE SAME BAR AS THE OTHER TWO.
 *
 * Same shape as `balance.test.tsx` §1.1 and `unshielded.test.ts`: the wallet
 * that SYNCS and the address the app derives must be the same wallet, proved
 * by asking the SDK wallet for its own address and comparing byte for byte.
 * The trap for DUST is the BYTES — `moneyAt(account).dust`, never the zswap
 * or night key: a wrong role derives a DUST address no chain event will ever
 * credit, and the fee tank reads zero for ever while generation accrues to
 * an address nobody displays.
 *
 * Nothing here touches the network: constructing the dust wallet and asking
 * its address is local, exactly as it is for the other two.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const ours: Identity = identityFromWords(TEST_MNEMONIC);

describe('the right DUST door — the address-agreement test', () => {
  it('the wallet that would sync IS the address the app derives, per account', async () => {
    for (const account of [0, 2, 11]) {
      const wallet = dustWalletFor(ours, account);
      const fromWallet = MidnightBech32m.encode(NETWORK, await wallet.getAddress()).asString();
      await wallet.stop().catch(() => {});
      expect(fromWallet).toBe(dustAddressFor(ours, account));
    }
  }, 60_000);

  it('the address carries the network, and is a DIFFERENT string per account', () => {
    const seen = new Set<string>();
    for (const account of WALLET_ACCOUNTS) {
      const address = dustAddressFor(ours, account);
      expect(address).toMatch(/^mn_dust_stagenet1/);
      seen.add(address);
    }
    expect(seen.size).toBe(WALLET_ACCOUNTS.length);
  });

  it('the wrong BYTES are a different wallet — demonstrated, not described', () => {
    /* One field name away, twice over: the zswap key and the night key each
     * derive a plausible-looking DUST address that is not this wallet's. */
    for (const role of ['zswap', 'night'] as const) {
      const wrong = DustAddress.encodePublicKey(
        NETWORK, DustSecretKey.fromSeed(ours.moneyAt(0)[role]).publicKey);
      expect(wrong).toMatch(/^mn_dust_stagenet1/); /* plausible-looking… */
      expect(wrong).not.toBe(dustAddressFor(ours, 0)); /* …and wrong. */
    }
  });

  it('refuses the reserved account and slots the picker does not offer', () => {
    expect(() => dustSecretKeyFor(ours, 1)).toThrow(/authority/);
    expect(() => dustSecretKeyFor(ours, 12)).toThrow(/not a wallet/);
    expect(() => dustWalletFor(ours, 1)).toThrow(/authority/);
  });
});
