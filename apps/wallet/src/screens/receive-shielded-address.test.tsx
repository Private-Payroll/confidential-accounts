// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import {
  MidnightBech32m, ShieldedAddress, UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import { identityFromSecret, newSecret } from 'midnight-identity';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { MAIN_ACCOUNT } from '../accounts/subwallets.js';
import { NETWORK } from '../config.js';
import { Home } from './home.js';

/*
 * THE SHIELDED RECEIVING ADDRESS A PERSON COPIES IS THIS WALLET'S OWN, AND IT
 * IS NOT THE PUBLIC ONE.
 *
 * Somebody paid privately gives out the string the Receive popup copies. If
 * that string were the public address, a private payment could not be made to
 * it at all; if it were a valid shielded address for some other key, the
 * payment would settle into a coin this wallet never shows. So the string is
 * read off the copy control itself - what reaches the clipboard - and checked
 * against keys derived here, from the secret, by the ledger directly, rather
 * than against the function the screen used to build it. Comparing the screen
 * with its own helper would agree with itself whatever the helper did.
 */

/* jsdom is its own realm; see `home.test.tsx` for why the polyfill. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

let clipboard: string[] = [];

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { clipboard.push(text); } },
  });
});

/** Opens Receive and presses one of its copy controls; returns what was copied. */
async function copied(kind: 'shielded' | 'unshielded'): Promise<string> {
  const before = clipboard.length;
  fireEvent.click(screen.getByText(`Copy the ${kind} address`));
  await waitFor(() => expect(clipboard.length).toBe(before + 1));
  return clipboard[clipboard.length - 1]!;
}

describe('the shielded receiving address a wallet shows and copies', () => {
  it('decodes as a ShieldedAddress for THIS wallet, and is not the public address', async () => {
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    render(<Home identity={identity} secret={secret} />);
    fireEvent.click(screen.getByText('Receive'));

    const shielded = await copied('shielded');
    const unshielded = await copied('unshielded');

    /* RED WHEN the shielded copy control is handed the public address: the
     * public string is `mn_addr_...` and does not decode as a shield-addr. */
    const decoded = MidnightBech32m.parse(shielded).decode(ShieldedAddress, NETWORK);

    /* RED WHEN the address shown is built from any key but this wallet's own
     * zswap key for the main slot, which is the slot a new wallet opens on:
     * another slot, the authority compartment, the night or dust key. The
     * subwallet case is the next test. Derived here from the secret, not
     * through the helper the screen calls. */
    const keys = ZswapSecretKeys.fromSeed(identity.moneyAt(MAIN_ACCOUNT).zswap);
    expect(decoded.coinPublicKey.toHexString()).toBe(keys.coinPublicKey);
    expect(decoded.encryptionPublicKey.toHexString()).toBe(keys.encryptionPublicKey);

    /* RED WHEN both copy controls are handed the same string. */
    expect(shielded).not.toBe(unshielded);
    /* And the other one really is the public kind, so the two are not merely
     * different but different in kind. */
    expect(() => MidnightBech32m.parse(unshielded).decode(UnshieldedAddress, NETWORK)).not.toThrow();
    expect(() => MidnightBech32m.parse(unshielded).decode(ShieldedAddress, NETWORK)).toThrow();

    /* RED WHEN the full address a person reads differs from the one copied. */
    const full = document.querySelector('[data-addr="shielded"] .address-full');
    expect(full?.textContent).toBe(shielded);
  });

  it('in a subwallet, is that subwallet\'s own address, not the main wallet\'s', async () => {
    /* RED WHEN Receive shows one slot's address whatever slot is open: coins
     * would land in a wallet the person is not looking at. "Subwallet 1" is
     * account 2 (`accounts/subwallets.ts`). */
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    render(<Home identity={identity} secret={secret} />);
    fireEvent.click(screen.getByText('Switch wallet'));
    const row = [...document.querySelectorAll<HTMLElement>('[data-wallet-row]')]
      .find((r) => r.textContent?.includes('Subwallet 1'));
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    fireEvent.click(screen.getByText('Receive'));
    const shielded = await copied('shielded');
    const decoded = MidnightBech32m.parse(shielded).decode(ShieldedAddress, NETWORK);
    const slot = ZswapSecretKeys.fromSeed(identity.moneyAt(2).zswap);
    const main = ZswapSecretKeys.fromSeed(identity.moneyAt(MAIN_ACCOUNT).zswap);
    expect(decoded.coinPublicKey.toHexString()).toBe(slot.coinPublicKey);
    expect(decoded.coinPublicKey.toHexString()).not.toBe(main.coinPublicKey);
  });

  it('is a different address for a different wallet', async () => {
    /* RED WHEN the address shown is a constant, or is derived from something
     * every wallet shares: two wallets made in the wallet app must be two
     * places to send to. */
    const first = newSecret();
    render(<Home identity={identityFromSecret(first)} secret={first} />);
    fireEvent.click(screen.getByText('Receive'));
    const a = await copied('shielded');
    cleanup();
    forgetOpenWallet();

    const second = newSecret();
    render(<Home identity={identityFromSecret(second)} secret={second} />);
    fireEvent.click(screen.getByText('Receive'));
    const b = await copied('shielded');

    expect(a).not.toBe(b);
    const keysB = ZswapSecretKeys.fromSeed(identityFromSecret(second).moneyAt(MAIN_ACCOUNT).zswap);
    expect(MidnightBech32m.parse(b).decode(ShieldedAddress, NETWORK).coinPublicKey.toHexString())
      .toBe(keysB.coinPublicKey);
  });
});
