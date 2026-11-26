import * as L from '@midnightntwrk/ledger-v9';

/**
 * **A VERIFIER KEY FILE, AND A LEDGER OPERATION HOLDING IT**, for a test that
 * hands a contract's state to a key check without compiling anything. The key
 * checks read every key slot from an operation's serialized bytes, so a fake
 * operation must carry the bytes the ledger itself writes; this one is the
 * ledger's own operation.
 *
 * The body is not a real key: the ledger reads a key's body only when it checks
 * a proof, and nothing that uses these checks one.
 */
const HEADER = { older: 'midnight:verifier-key[v6]:', newer: 'midnight:verifier-key[v7]:' } as const;

/** A key file around `body`, of the newer proving system unless `older` is asked for. Bodies under 16384 bytes. */
export function keyFileAround(body: Uint8Array | string, system: keyof typeof HEADER = 'newer'): Uint8Array {
  const b = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const length = b.length < 64 ? [b.length << 2] : [((b.length & 0x3f) << 2) | 1, b.length >> 6];
  return Uint8Array.from([...new TextEncoder().encode(HEADER[system]), ...length, ...b]);
}

/** The ledger's operation holding each key file given, each in the slot its header names. */
export function operationHolding(...keys: Uint8Array[]): L.ContractOperation {
  const op = new L.ContractOperation();
  for (const key of keys) op.verifierKey = key;
  return op;
}
