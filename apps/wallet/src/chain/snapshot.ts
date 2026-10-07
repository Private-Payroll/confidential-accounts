import { ZswapLocalState } from '@midnightntwrk/ledger-v9';

/**
 * **WHAT A SAVED SNAPSHOT OF A WALLET'S PRIVATE PART SAYS ABOUT ITSELF**, read
 * from the snapshot and from nothing else: whose it is, which network it was
 * read from, and whether it holds anything in flight.
 *
 * A snapshot is the SDK's own serialised state: the wallet's public keys, the
 * network's name and the ledger's local coin state, which carries the coins the
 * wallet has set aside for a transaction it has not seen land and the coins
 * such a transaction would pay back to it. **A snapshot taken with either keeps
 * them in every wallet restored from it**: the ledger's own way of letting
 * set-aside coins go after their deadline does nothing (`clearPending` in
 * `ledger-v9.d.ts` says so), letting them go by hand needs the transaction,
 * which does not outlive the screen that built it, and every later snapshot
 * writes them back. The person's money would read as gone on this device for
 * good. So the checkpoint store keeps none that holds anything in flight, and
 * gives none back.
 *
 * `null` when the snapshot cannot be read: a snapshot whose contents cannot be
 * read cannot be shown to hold nothing in flight, or to be anybody's.
 */
export interface SnapshotFacts {
  /** The coin public key of the wallet the snapshot was taken of. */
  readonly coinPublicKey: string;
  /** The network the snapshot was read from, as the wallet was configured with it. */
  readonly networkId: string;
  /** Whether the snapshot holds coins set aside, or coins expected, for a transaction not yet seen. */
  readonly inFlight: boolean;
}

const HEX = /^(?:[0-9a-fA-F]{2})+$/u;

const bytesOf = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export function snapshotFacts(serialized: string): SnapshotFacts | null {
  try {
    const snapshot = JSON.parse(serialized) as {
      publicKeys?: { coinPublicKey?: unknown }; networkId?: unknown; state?: unknown;
    } | null;
    const coinPublicKey = snapshot?.publicKeys?.coinPublicKey;
    const networkId = snapshot?.networkId;
    const state = snapshot?.state;
    if (typeof coinPublicKey !== 'string' || typeof networkId !== 'string' || typeof state !== 'string' || !HEX.test(state)) {
      return null;
    }
    const local = ZswapLocalState.deserialize(bytesOf(state));
    return { coinPublicKey, networkId, inFlight: local.pendingSpends.size > 0 || local.pendingOutputs.size > 0 };
  } catch {
    return null;
  }
}

/**
 * **WHETHER A SNAPSHOT MAY BE RESTORED AS THIS WALLET'S PRIVATE PART**: it can
 * be read, it is this wallet's own (its coin public key), it was read from this
 * network, and it holds nothing in flight. Anything else is a cache miss, and
 * the part is read from the start.
 */
export const restorableAs = (serialized: string, coinPublicKey: string, networkId: string): boolean => {
  const facts = snapshotFacts(serialized);
  return facts !== null && !facts.inFlight && facts.coinPublicKey === coinPublicKey && facts.networkId === networkId;
};
