/**
 * **ONE VERSION OF A VAULT'S RECORD THE COMPANY'S RECORDS DO NOT BELIEVE LOSES ONLY ITSELF, FOR A REBUILD**
 * (`HttpSealedPoolStore.versionsBelieved`): the versions believed are kept and the refused one is named with why, while
 * `versions`, which every other reader takes, still refuses the whole list, and `get` still refuses a newest version
 * it does not believe.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, newWrappingKeypair } from '../../../src/core/crypto.js';
import { sealPool } from '../../../src/midnight/vault-pool.js';
import { FilingNotBelieved, HttpSealedPoolStore, type FreshJudge, type WireSend } from './http-sealed-pool-store.js';

const VAULT = 'ab'.repeat(32);
const SIGNING = newSigningKeypair();
const WRAPPING = newWrappingKeypair();

/** The records route in memory: three versions of the pool, as a filing store files them. */
const threeVersionsFiled = async () => {
  const filed: unknown[] = [];
  const send: WireSend = async (path, init) => {
    if (init.method === 'PUT') {
      const wire = JSON.parse(init.body!);
      filed.push(wire);
      return { status: 201, body: { filed: true, record: 'pool', version: wire.version, digest: wire.digest } };
    }
    if (path.endsWith('/versions')) return { status: 200, body: { record: 'pool', versions: filed } };
    return { status: 200, body: { record: 'pool', filed: filed.at(-1) ?? null } };
  };
  const entered = { enter: async () => {} } as never;
  const believeAll: FreshJudge = async () => Object.assign(() => null, {});
  const filer = new HttpSealedPoolStore('pool', send, SIGNING.secret, believeAll, entered);
  for (const version of [1, 2, 3]) {
    await filer.put(VAULT, sealPool(VAULT, { notes: [] } as never, [{ id: 'aa'.repeat(32), wrappingPublicKey: WRAPPING.publicKey }], version, 'pool'));
  }
  /* A store whose company's records refuse the versions named, each with its reason. */
  const refusing = (...versions: number[]) => new HttpSealedPoolStore('pool', send, null, async () => Object.assign(
    (_filer: unknown, _kind: unknown, _key: unknown, read: { version?: number }) => (versions.includes(read.version ?? 0) ? 'its filer was not seated' : null), {}), entered);
  return { refusing };
};

describe('a version the company\'s records do not believe', () => {
  it('IS NAMED WITH WHY FOR A REBUILD, AND EVERY VERSION BELIEVED IS KEPT, IN ORDER', async () => {
    const { refusing } = await threeVersionsFiled();
    const read = await refusing(2).versionsBelieved(VAULT);
    /* RED WHEN: one refused version refuses the whole list, so a rebuild reads no older version at all. */
    expect(read.versions.map((v) => v.version)).toEqual([1, 3]);
    /* RED WHEN: the refused version is dropped without being named. */
    expect(read.refused).toEqual([{ version: 2, why: 'its filer was not seated' }]);
  });

  it('STILL REFUSES THE WHOLE LIST FOR EVERY OTHER READER, NAMING THE FIRST VERSION REFUSED', async () => {
    const { refusing } = await threeVersionsFiled();
    /* RED WHEN: a reader that files or spends on the list is handed a list with a version quietly missing. */
    await expect(refusing(2).versions(VAULT)).rejects.toBeInstanceOf(FilingNotBelieved);
    await expect(refusing(2, 3).versions(VAULT)).rejects.toThrow(/version 2 of this pool is not believed, because its filer was not seated/);
    expect((await refusing().versions(VAULT)).map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('WHEN IT IS THE NEWEST, IS STILL REFUSED BY THE READ OF THE NEWEST, AND NAMED BY THE REBUILD\'S LIST', async () => {
    const { refusing } = await threeVersionsFiled();
    /* RED WHEN: the newest version is read though the company's records do not believe it. */
    await expect(refusing(3).get(VAULT)).rejects.toThrow(/version 3 of this pool is not believed/);
    expect((await refusing(3).versionsBelieved(VAULT)).refused.map((r) => r.version)).toEqual([3]);
  });
});
