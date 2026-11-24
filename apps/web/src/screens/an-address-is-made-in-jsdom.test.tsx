// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
/* The screen harness puts node's byte types where a jsdom test shares them with the wallet's code, before any code runs (its first lines). */
import './company-harness.test-support.js';
import { addressFor } from '../../../../packages/identity/src/wallet/address.js';
import { NETWORK } from 'midnight-identity/network';

/*
 * The address `addressFor` makes in node's own realm from a seed of thirty-two bytes of 7 on the page's network, made once by running
 * `addressFor(new Uint8Array(32).fill(7), NETWORK).bech32` in a plain node process (no jsdom), and written here as it printed.
 */
const MADE_IN_NODE = 'mn_shield-addr_preprod1r8f3dw9ujvdflvcgxuxvg0rt7lldneyy5kn7jc0vfd50m9fyucp0644ju70w6ppxmwuh8ec5nutzxmd64e0tq4v43st47p07m3c5tyqlxgv3y';

describe('A PRIVATE ADDRESS IS MADE IN A BROWSER-LIKE TEST, AS IT IS IN A NODE ONE (THE SCREEN HARNESS PUTS NODE\'S BYTE TYPES IN PLACE)', () => {
  it('an address made from a seed here is the string node makes from the same seed', () => {
    /* RED WHEN: the bytes a test builds and the bytes the address code builds are of two byte types, so no address is made. */
    const made = addressFor(new Uint8Array(32).fill(7) as never, NETWORK as never).bech32;
    /* RED WHEN: this realm makes another address, well formed or not, from the same seed as node's. */
    expect(made).toBe(MADE_IN_NODE);
    expect(addressFor(Uint8Array.from({ length: 32 }, () => 7) as never, NETWORK as never).bech32).toBe(MADE_IN_NODE);
  });
});
