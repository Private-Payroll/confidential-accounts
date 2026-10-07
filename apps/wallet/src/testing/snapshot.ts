import { ZswapLocalState, ZswapSecretKeys, shieldedToken } from '@midnightntwrk/ledger-v9';
import { NETWORK } from 'midnight-identity/network';

/**
 * **A SNAPSHOT IN THE SDK'S OWN SHAPE, FOR A TEST THAT KEEPS ONE.** The
 * checkpoint store keeps only a snapshot it can read and that holds nothing in
 * flight, so a test that keeps a checkpoint hands it one: the ledger's own local
 * state, serialised, under the keys and network named. `inFlight` sets a coin
 * aside (`spend`) or expects one (`output`), as a transaction built and not yet
 * seen would.
 */
const SEED = new Uint8Array(32).fill(7);
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function snapshotForTest(options: {
  readonly coinPublicKey?: string;
  readonly networkId?: string;
  readonly inFlight?: 'spend' | 'output' | null;
} = {}): string {
  const keys = ZswapSecretKeys.fromSeed(SEED);
  const coin = { type: shieldedToken().raw, nonce: '11'.repeat(32), value: 5n };
  let local = new ZswapLocalState();
  if (options.inFlight === 'output') local = local.watchFor(keys.coinPublicKey, coin);
  if (options.inFlight === 'spend') {
    const holding = local.insertCoin(keys, coin);
    [local] = holding.spend(keys, [...holding.coins][0]!, 0);
  }
  return JSON.stringify({
    publicKeys: { coinPublicKey: options.coinPublicKey ?? keys.coinPublicKey, encryptionPublicKey: keys.encryptionPublicKey },
    state: toHex(local.serialize()),
    protocolVersion: '1',
    networkId: options.networkId ?? NETWORK,
    coinHashes: {},
  });
}

/** A snapshot holding nothing in flight, which the store keeps. */
export const KEPT_SNAPSHOT = snapshotForTest();
