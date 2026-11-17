import { vi } from 'vitest';
import type { AssetId } from '../core/assets.js';
import { networkRecord } from '../core/networks.js';

/**
 * **THE TEST NETWORK A TEST PAYS ON WHEN IT NEEDS A MINTED COLOUR.** The build is
 * compiled for the network the company runs on, and that network's record carries
 * no test colour until its mint is run. A test that pays in a test token names a
 * test network whose record does, here, once, and reads the colour off that record.
 */
export const TEST_NETWORK = 'stagenet' as const;

/** The colour `TEST_NETWORK`'s record names; a record with none is refused, so a test never pays in nothing. */
export const TEST_NETWORK_COLOUR: AssetId = ((): AssetId => {
  const colour = networkRecord(TEST_NETWORK).testToken;
  if (colour === null) {
    throw new Error(`the record for ${TEST_NETWORK} names no test colour, so a test cannot pay in it. Name a test network whose record carries one in src/testing/a-test-network.ts.`);
  }
  return colour;
})();

/**
 * The factory a test file hands `vi.mock('midnight-identity/network', ...)` when
 * the service or the registry it runs must be the build for `TEST_NETWORK`:
 * the wallet's address vocabulary and the registry's test row then agree on one
 * network for the whole file, as they do in a build compiled for it.
 */
export async function aBuildForTheTestNetwork(
  original: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return { ...(await original()), NETWORK: TEST_NETWORK };
}

/**
 * The asset registry module as a build compiled for `network` loads it, with
 * only the compiled network changed. Call `afterABuildForANetwork` when the
 * test is done so no other test sees the substitute.
 */
export async function assetsBuiltFor(network: string): Promise<typeof import('../core/assets.js')> {
  vi.resetModules();
  vi.doMock('midnight-identity/network', async (original) => ({
    ...(await original<typeof import('midnight-identity/network')>()),
    NETWORK: network,
  }));
  return import('../core/assets.js');
}

/** Puts the compiled network back and forgets every module loaded for a substitute one. */
export function afterABuildForANetwork(): void {
  vi.doUnmock('midnight-identity/network');
  vi.resetModules();
}
