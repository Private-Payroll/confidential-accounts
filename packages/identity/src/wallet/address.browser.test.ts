import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from '../keys/derivation.js';
import { addressFor } from './address.js';

/**
 * THE TEST THAT WOULD HAVE CAUGHT IT, and it works by taking something away.
 *
 * `@midnightntwrk/wallet-sdk-address-format` is written against Node's
 * `Buffer`. In Node that is a global and nobody notices; **in a browser it does
 * not exist**, so the standalone wallet threw `ReferenceError: Buffer is not
 * defined` the first time it tried to show somebody their own address — with
 * the entire suite green, because vitest runs in Node.
 *
 * Deriving the keys was fine: that is all `@noble` and `@scure`, which are
 * written for both. **Only the step that turns keys into an address failed**,
 * which is the one thing a wallet must do.
 *
 * So this test removes `Buffer`, shows the failure, and then shows the
 * `browser/` polyfill fixing it. It is the only test in the repository that
 * cares what runtime it is in, and it says why in its own name.
 */

const held = globalThis.Buffer;

afterEach(() => {
  (globalThis as { Buffer?: unknown }).Buffer = held;
});

describe('the address, in a runtime that has no Buffer', () => {
  const who = identityFromWords(TEST_MNEMONIC);

  it('IS THE THING THAT BREAKS — the keys are fine and the address is not', async () => {
    delete (globalThis as { Buffer?: unknown }).Buffer;

    /* Derivation is untouched: no Buffer anywhere near it. */
    const again = identityFromWords(TEST_MNEMONIC);
    expect(again.money.zswap).toHaveLength(32);

    /* And the address cannot be produced at all. */
    expect(() => addressFor(again.money.zswap, 'testnet')).toThrow(/Buffer/u);
  });

  it('works again once `midnight-identity/browser` has been imported', async () => {
    delete (globalThis as { Buffer?: unknown }).Buffer;
    const { ensureBuffer } = await import('../browser/buffer.js');
    ensureBuffer();

    const address = addressFor(who.money.zswap, 'testnet');
    expect(address.bech32).toMatch(/^mn_shield-addr_testnet1/u);
    expect(address.coinPublicKey).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('never replaces a Buffer the host already had', async () => {
    const marker = { theHostsOwn: true };
    (globalThis as { Buffer?: unknown }).Buffer = marker;
    const { ensureBuffer } = await import('../browser/buffer.js');
    ensureBuffer();
    expect((globalThis as { Buffer?: unknown }).Buffer).toBe(marker);
  });
});
