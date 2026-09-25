// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity/keys/derivation';
import { NETWORK } from 'midnight-identity/network';

/**
 * **THE ADDRESSES A RELEASE ANSWERS FOR ARE THE ONES THE RECEIVING-ADDRESS
 * DISCLOSURE WOULD HAND OUT, BECAUSE THEY COME THROUGH THE SAME DOOR.**
 *
 * `ownedAddressFor` is stood in for by one that answers with a DIFFERENT
 * person's account at the same slot. A list worked out through it names that
 * person's addresses; a list worked out any second way names this wallet's own,
 * and this goes red.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const other = identityFromWords(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon '
  + 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art');

const through: number[] = [];
vi.mock('./owned-address.js', async (original) => {
  const real = await original<typeof import('./owned-address.js')>();
  return {
    ...real,
    ownedAddressFor: (_identity: unknown, account: number, names: Record<string, string>, network: typeof NETWORK) => {
      through.push(account);
      return real.ownedAddressFor(other, account, names, network);
    },
  };
});

describe('the addresses a release answers for', () => {
  it('ARE WORKED OUT THROUGH THE WALLET\'S OWN DOOR AND PRODUCER, FOR EVERY ACCOUNT IT OFFERS', async () => {
    const { receivingAddressesOf, derive } = await import('./derived.js');
    const { ownedAddressFor } = await import('./owned-address.js');
    const { WALLET_ACCOUNTS } = await import('./subwallets.js');
    const { REGISTRY, RECEIVING_ADDRESS } = await import('midnight-identity/profile/attributes');
    const mine = identityFromWords(TEST_MNEMONIC);
    through.length = 0;
    const held = receivingAddressesOf(mine, NETWORK);
    /* RED WHEN an account the wallet offers is skipped, or one it does not offer is asked for. */
    expect(through).toEqual([...WALLET_ACCOUNTS]);
    /*
     * RED WHEN the list is worked out a second way - from the identity's keys
     * directly - rather than through `ownedAddressFor` and the disclosure's producer:
     * it then names this wallet's addresses, not the stand-in's.
     */
    const definition = REGISTRY.definitionOf(RECEIVING_ADDRESS)!;
    const expected = WALLET_ACCOUNTS.map((a) => {
      const d = derive(definition, ownedAddressFor(mine, a, {}, NETWORK));
      return d.ok ? d.value : null;
    });
    expect(held).toEqual(expected);
    /* And each is a shielded address - the producer's rule, not the unshielded one beside it. */
    for (const a of held) expect(a.startsWith('mn_shield-addr_')).toBe(true);
    /* RED WHEN the wallet offers more accounts than a release has room for: no key could be released at all. */
    const { HELD_ADDRESS_SLOTS } = await import('midnight-identity/profile/unlock');
    expect(WALLET_ACCOUNTS.length).toBeLessThanOrEqual(HELD_ADDRESS_SLOTS);
  });
});
