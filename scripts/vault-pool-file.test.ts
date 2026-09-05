/**
 * **THE POOL ON DISK, AND THE FOUR THINGS THAT ARE NOT AN EMPTY VAULT.**
 * `S6f`, `C242`.
 *
 * `vault-pool.ts`'s standing rule is that *"the pool could not be read"* and
 * *"the pool read as empty"* must never become the same answer, because the
 * first is a refusal and recoverable and the second is a claim that a company
 * has no money. A file system is where that rule is easiest to break: a missing
 * file, a truncated write, a record for another vault and a record with no
 * wrapped keys all arrive as bytes, and only the first of them is `null`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileSealedPoolStore, VaultPoolFileUnreadable, vaultPoolFile,
} from './vault-pool-file.js';
import {
  SealedNotePool, sealPool, MemorySealedPoolStore, VaultPoolUnreadable, type PoolSigner,
} from '../src/midnight/vault-pool.js';
import { newWrappingKeypair } from '../src/core/crypto.js';

const VAULT = 'd0'.repeat(32);
const OTHER = 'e1'.repeat(32);

const dir = () => mkdtempSync(join(tmpdir(), 'vault-pool-'));
const storeIn = (d: string, vault = VAULT) =>
  new FileSealedPoolStore(vaultPoolFile(d, 'stagenet', 'payroll-test-1'), vault);

const signers = (): { signers: PoolSigner[]; secret: string } => {
  const k = newWrappingKeypair();
  return { signers: [{ id: 'ada', wrappingPublicKey: k.publicKey }], secret: k.secret };
};

describe('C236: the file is named after the vault, never addressed by it', () => {
  it('puts the NAME in the path and the address nowhere in it', () => {
    const path = vaultPoolFile('/state', 'stagenet', 'payroll-test-1');
    expect(path).toContain('payroll-test-1');
    expect(path).not.toContain(VAULT);
    /*
     * A filename is a screen. A file called `vault-pool-<64 hex>.json` puts the
     * one value that destroys money in front of somebody every time they open a
     * folder — and it looks exactly like a thing to paste.
     */
    expect(path).not.toMatch(/[0-9a-f]{16}/);
  });

  it('REFUSES a name that could escape the directory, through the one validator', () => {
    expect(() => vaultPoolFile('/state', 'stagenet', '../../etc/passwd')).toThrow();
    expect(() => vaultPoolFile('/state', 'stagenet', 'a/b')).toThrow();
  });
});

describe('C242: absent is null, and everything else present is a refusal', () => {
  it('answers null when there is no file, so SealedNotePool can say create() is how', async () => {
    /*
     * The one case that is NOT an error. `SealedNotePool.load` turns it into a
     * refusal naming `create`, and `save` turns it into a different refusal —
     * *"a pool that begins mid-history is a pool missing every note before
     * it"*. Both distinctions are lost if this throws.
     */
    const d = dir();
    expect(await storeIn(d).get(VAULT)).toBeNull();
  });

  it('REFUSES a truncated write rather than reading it as a vault with no notes', async () => {
    const d = dir();
    const f = vaultPoolFile(d, 'stagenet', 'payroll-test-1');
    writeFileSync(f, '{"vault":"d0d0d0","version":1,"sea');
    await expect(storeIn(d).get(VAULT)).rejects.toThrow(VaultPoolFileUnreadable);
    await expect(storeIn(d).get(VAULT)).rejects.toThrow(/truncated write looks exactly like this/);
    await expect(storeIn(d).get(VAULT)).rejects.toThrow(/not an empty vault/i);
  });

  it('REFUSES a record for another vault, which would describe the wrong money', async () => {
    const d = dir();
    const { signers: s } = signers();
    writeFileSync(
      vaultPoolFile(d, 'stagenet', 'payroll-test-1'),
      JSON.stringify(sealPool(OTHER, { notes: [] }, s, 1)));
    await expect(storeIn(d).get(VAULT)).rejects.toThrow(/DIFFERENT vault/);
  });

  it('REFUSES a record wrapped to nobody — ciphertext with no key in the world', async () => {
    /*
     * `V-91`: `sealPool` refuses to CREATE one, so a record that reads back this
     * way means the FILE is wrong, and answering `null` for it would let
     * `create` write a fresh empty pool over a treasury.
     */
    const d = dir();
    const { signers: s } = signers();
    const rec = { ...sealPool(VAULT, { notes: [] }, s, 1), wrapped: [] };
    writeFileSync(vaultPoolFile(d, 'stagenet', 'payroll-test-1'), JSON.stringify(rec));
    await expect(storeIn(d).get(VAULT)).rejects.toThrow(/no device anywhere that could open it/);
    await expect(storeIn(d).get(VAULT)).rejects.toThrow(/not a pool with no notes in it/);
  });

  it('REFUSES to answer about a vault it was not built for', async () => {
    const d = dir();
    await expect(storeIn(d).get(OTHER)).rejects.toThrow(/built for a different vault/);
    /* And it does not name the address it holds. C236. */
    await expect(storeIn(d).get(OTHER)).rejects.not.toThrow(new RegExp(VAULT));
  });
});

describe('the pool is written whole or not at all', () => {
  it('round-trips through SealedNotePool: created once, opened, advanced', async () => {
    const d = dir();
    const { signers: s, secret } = signers();
    const pool = new SealedNotePool(
      storeIn(d), { signerId: 'ada', wrappingSecret: secret }, async () => s);

    await pool.create(VAULT, { notes: [] });
    expect(await pool.load(VAULT)).toEqual({ notes: [] });

    await pool.save(VAULT, { notes: [{ nonce: '01'.repeat(32), token: '02'.repeat(32), value: 7n }] });
    const back = await pool.load(VAULT);
    /* `M-125`: a value is a bigint, and a plain JSON round trip makes it an object. */
    expect(back.notes[0]!.value).toBe(7n);
    expect(typeof back.notes[0]!.value).toBe('bigint');
  });

  it('carries an ABSENT index across the file, rather than filling it in', async () => {
    /*
     * `S6f`: a note whose place in the commitment tree has never been read
     * records `index: undefined`, and a store that turned that into a zero on
     * the way to disk would hand the contract a merkle path for another leaf.
     */
    const d = dir();
    const { signers: s, secret } = signers();
    const pool = new SealedNotePool(
      storeIn(d), { signerId: 'ada', wrappingSecret: secret }, async () => s);
    await pool.create(VAULT, { notes: [] });
    await pool.save(VAULT, { notes: [{ nonce: '01'.repeat(32), token: '02'.repeat(32), value: 7n }] });
    expect((await pool.load(VAULT)).notes[0]!.index).toBeUndefined();
  });

  it('leaves no half-written file behind, and no staging file after a write', async () => {
    const d = dir();
    const { signers: s } = signers();
    const store = storeIn(d);
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));
    const f = vaultPoolFile(d, 'stagenet', 'payroll-test-1');
    expect(existsSync(`${f}.writing`)).toBe(false);
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe(1);
  });

  it('REFUSES to write a version over a later one, rather than merging', async () => {
    /*
     * `B3`: two operators reconciling one vault at once. There is no correct
     * merge of two beliefs about which notes exist — the union invents notes
     * the chain never had and the intersection drops ones it does.
     */
    const d = dir();
    const { signers: s } = signers();
    const store = storeIn(d);
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 4));
    await expect(store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 4)))
      .rejects.toThrow(/refusing to write version 4 .* over version 4/);
    await expect(store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 3)))
      .rejects.toThrow(/no correct merge/);
  });

  it('behaves as the memory store does, so an instrument and a test see one contract', async () => {
    /*
     * `T-34`: the in-memory store is what every test of `SealedNotePool` runs
     * against, so a file store with different refusals would mean the tested
     * behaviour and the shipped behaviour were two things.
     */
    const d = dir();
    const { signers: s } = signers();
    const mem = new MemorySealedPoolStore();
    const file = storeIn(d);
    for (const store of [mem, file]) {
      await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));
      await expect(store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1))).rejects.toThrow(/refusing to write/);
    }
    const pool = new SealedNotePool(file, { signerId: 'nobody', wrappingSecret: '00'.repeat(32) }, async () => s);
    await expect(pool.load(VAULT)).rejects.toThrow(VaultPoolUnreadable);
  });
});
