import { afterEach, describe, expect, it } from 'vitest';
import { NETWORK_IDS, networkRecord } from './networks.js';
import { afterABuildForANetwork, assetsBuiltFor } from '../testing/a-test-network.js';

/**
 * **A BUILD FOR A NETWORK THAT MINTED NO TEST TOKEN STILL KNOWS EVERY OTHER
 * NETWORK'S, AND REFUSES EACH OF THEM.**
 *
 * The registry is built for the network the wallet is compiled for. On a build
 * for a network where real money settles, or a test network nobody has minted
 * on, that network's record names no test token, so a registry that only asked
 * "is this the token my network minted" would find nothing to refuse and admit
 * another network's worthless token as if it were money. This file builds the
 * registry as each such build would, with only the compiled network changed,
 * and offers it every test colour any record names.
 */
const TEST_COLOURS = NETWORK_IDS
  .map(id => ({ minted: id, colour: networkRecord(id).testToken }))
  .filter((c): c is { minted: string; colour: string } => c.colour !== null);

afterEach(afterABuildForANetwork);

describe('a test colour is refused on a build for any network that did not mint it', () => {
  it('there is a test colour to offer and a build that has none of its own', () => {
    /* RED WHEN no record names a test colour, or every network has one, so the
     * builds below would offer nothing or have nothing to refuse. */
    expect(TEST_COLOURS.length).toBeGreaterThan(0);
    expect(NETWORK_IDS.some(id => networkRecord(id).kind === 'real')).toBe(true);
  });

  it('A REAL BUILD REFUSES EVERY TEST COLOUR, AND ITS OWN REGISTRY CARRIES NONE', async () => {
    for (const network of NETWORK_IDS.filter(id => networkRecord(id).kind === 'real')) {
      const { SEED_ASSETS, StaticAssetRegistry, isATestAsset } = await assetsBuiltFor(network);
      /* RED WHEN a real build seeds a test asset. */
      expect(SEED_ASSETS.filter(a => isATestAsset(a.code)), network).toEqual([]);
      for (const { minted, colour } of TEST_COLOURS) {
        const row = { code: colour, symbol: 'tUSD', name: 'Test Dollar', decimals: 6,
          ledger: { shielded: colour, unshielded: null }, enabled: true, sortOrder: 90 };
        /* RED WHEN a test colour is recognised only on the network that
         * minted it, so a build for a real network, which minted none,
         * admits it as money. */
        expect(() => new StaticAssetRegistry([...SEED_ASSETS, row]), `${minted}'s colour on ${network}`)
          .toThrow(`minted on ${minted}`);
      }
    }
  });

  it('A TEST BUILD REFUSES EVERY TEST COLOUR BUT THE ONE ITS OWN NETWORK MINTED', async () => {
    for (const network of NETWORK_IDS.filter(id => networkRecord(id).kind === 'test')) {
      const { SEED_ASSETS, StaticAssetRegistry, testTokenOn } = await assetsBuiltFor(network);
      for (const { minted, colour } of TEST_COLOURS) {
        const row = { code: colour, symbol: 'tUSD', name: 'Test Dollar', decimals: 6,
          ledger: { shielded: colour, unshielded: null }, enabled: true, sortOrder: 90 };
        const others = SEED_ASSETS.filter(a => a.code !== colour);
        if (testTokenOn(network) === colour) {
          /* RED WHEN a build refuses the token its own network minted. */
          expect(() => new StaticAssetRegistry([...others, row]), network).not.toThrow();
        } else {
          /* RED WHEN a build admits a token minted on another network, which
           * names money that does not exist on this one. */
          expect(() => new StaticAssetRegistry([...others, row]), `${minted}'s colour on ${network}`)
            .toThrow(`minted on ${minted}`);
        }
      }
    }
  });
});
