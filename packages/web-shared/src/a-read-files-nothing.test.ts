/**
 * **A READ OF A VAULT'S RECORDS FILES NOTHING** (`recordsReadHere`): the store the page reads a vault's private money
 * through holds no signing key, reads every version as a filing store does, and refuses to file before anything is
 * sent, so no read signs a record with the seat's secret.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../../../src/core/crypto.js';
import { sealPool } from '../../../src/midnight/vault-pool.js';
import { HttpSealedPoolStore, ReadFilesNothing, type WireSend } from './http-sealed-pool-store.js';
import { recordsReadHere } from './vault-page-doors.js';

const VAULT = 'ab'.repeat(32);
const SIGNING = newSigningKeypair();
const WRAPPING = newWrappingKeypair();

describe('a read of a vault\'s records files nothing', () => {
  it('reads the newest version a filing store filed, and refuses to file one before anything is sent', async () => {
    const filed = new Map<string, unknown>();
    const sent: string[] = [];
    const send: WireSend = async (path, init) => {
      sent.push(`${init.method} ${path}`);
      if (init.method === 'PUT') {
        const wire = JSON.parse(init.body!);
        filed.set(path, wire);
        return { status: 201, body: { filed: true, record: 'pool', version: wire.version, digest: wire.digest } };
      }
      const newest = [...filed.values()].at(-1) ?? null;
      return { status: 200, body: { record: 'pool', filed: newest } };
    };
    const entered = { enter: async () => {} } as never;
    const believeAll = async () => Object.assign(() => null, {}) as never;
    const pool = sealPool(VAULT, { notes: [] } as never, [{ id: 'aa'.repeat(32), wrappingPublicKey: WRAPPING.publicKey }], 1, 'pool');
    await new HttpSealedPoolStore('pool', send, SIGNING.secret, believeAll, entered).put(VAULT, pool);
    const reading = recordsReadHere(believeAll, () => 'u1', send)('pool');
    /* RED WHEN: the read's store does not read what a filing store filed. */
    expect((await reading.get(VAULT))?.version).toBe(1);
    sent.length = 0;
    const again = sealPool(VAULT, { notes: [] } as never, [{ id: 'aa'.repeat(32), wrappingPublicKey: WRAPPING.publicKey }], 2, 'pool');
    /* RED WHEN: a read files a version, signed with whatever key it could reach. */
    await expect(reading.put(VAULT, again)).rejects.toThrow(ReadFilesNothing);
    expect(sent).toEqual([]);
    /* RED WHEN: a store built to file can still be built with no signing key. */
    expect(() => new HttpSealedPoolStore('pool', send, '' as Hex, believeAll, entered)).toThrow(/no signing key/);
  });
});
