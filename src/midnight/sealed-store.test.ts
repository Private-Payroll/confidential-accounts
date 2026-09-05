/**
 * The sealed state store.
 *
 * These are written as consequences rather than as method checks, because the
 * failure this component prevents is total and silent: a state that is not
 * stored here is a commitment on chain naming a state nobody can ever produce
 * again. The account looks perfectly healthy and is permanently unreadable.
 *
 * M-73 is the record of it happening for real.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSealedStateStore, MemorySealedStateStore, noSealedStateStore } from './sealed-store.js';
import type { Sealed } from '../core/crypto.js';

const sealed = (body: string): Sealed => ({ iv: 'aa'.repeat(12), tag: '', body });

const ACCOUNT = 'acc_1';
const C1 = 'aa'.repeat(32);
const C2 = 'bb'.repeat(32);

describe('FileSealedStateStore', () => {
  let root: string;
  let store: FileSealedStateStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sealed-'));
    store = new FileSealedStateStore(root);
  });

  it('round-trips a blob under its commitment', async () => {
    await store.put(ACCOUNT, C1, 0, sealed('one'));
    expect(await store.get(ACCOUNT, C1, 0)).toEqual(sealed('one'));
  });

  it('keeps every historical state, not just the newest', async () => {
    // An old blob is how an auditor verifies a historical attestation, and it
    // is what stops a bug that writes the wrong blob destroying the right one.
    await store.put(ACCOUNT, C1, 0, sealed('one'));
    await store.put(ACCOUNT, C2, 0, sealed('two'));
    expect(await store.get(ACCOUNT, C1, 0)).toEqual(sealed('one'));
    expect(await store.get(ACCOUNT, C2, 0)).toEqual(sealed('two'));
  });

  it('never overwrites: the same commitment means the same state', async () => {
    // A commitment is a hash of the state, so a second put under it is either a
    // retry or a bug. Both are better ignored than honoured.
    await store.put(ACCOUNT, C1, 0, sealed('the real one'));
    await store.put(ACCOUNT, C1, 0, sealed('something else'));
    expect(await store.get(ACCOUNT, C1, 0)).toEqual(sealed('the real one'));
  });

  it('is idempotent, because execute writes the blob before submitting', async () => {
    // A retried submission writes the blob again. That must not be an error.
    await store.put(ACCOUNT, C1, 0, sealed('one'));
    await expect(store.put(ACCOUNT, C1, 0, sealed('one'))).resolves.toBeUndefined();
  });

  it('returns null for a state it does not have, rather than inventing one', async () => {
    expect(await store.get(ACCOUNT, C1, 0)).toBeNull();
  });

  it('keeps accounts apart', async () => {
    await store.put('acc_1', C1, 0, sealed('mine'));
    expect(await store.get('acc_2', C1, 0)).toBeNull();
  });

  it('a crash mid-write leaves nothing a read can mistake for a blob', async () => {
    /*
     * The reason writes go through a temp file and a rename.
     *
     * A truncated blob is indistinguishable from a wrong viewing key — AES-GCM
     * fails the tag check either way — so the account reads as "wrong key"
     * forever and the person holding the right key cannot tell. A missing blob
     * at least says what it is.
     *
     * Simulated by leaving the debris a crash would leave: a temp file, mid
     * write, never renamed.
     */
    await store.put(ACCOUNT, C2, 0, sealed('an earlier state'));
    const dir = join(root, ACCOUNT);
    writeFileSync(join(dir, `${C1}.json.9999.tmp`), '{"sealed":{"body":"trunca');

    // Invisible to a read: only the renamed name is a blob.
    expect(await store.get(ACCOUNT, C1, 0)).toBeNull();
    // And the state that did land is untouched.
    expect(await store.get(ACCOUNT, C2, 0)).toEqual(sealed('an earlier state'));

    // The commitment is still writable afterwards, so the debris does not wedge it.
    await store.put(ACCOUNT, C1, 0, sealed('the real one'));
    expect(await store.get(ACCOUNT, C1, 0)).toEqual(sealed('the real one'));
  });

  it('does not create the blob when the write itself fails', async () => {
    /*
     * Forced with EISDIR rather than with permissions: this suite runs as root
     * in CI, where chmod is not enforced, and a test that only fails for
     * non-root users is a test that passes for the wrong reason.
     */
    const dir = join(root, ACCOUNT);
    await store.put(ACCOUNT, C2, 0, sealed('an earlier state'));
    mkdirSync(join(dir, `${C1}.k0.json.${process.pid}.tmp`));

    await expect(store.put(ACCOUNT, C1, 0, sealed('doomed'))).rejects.toThrow();

    // No blob under that commitment, and the earlier state survived.
    expect(await store.get(ACCOUNT, C1, 0)).toBeNull();
    expect(await store.get(ACCOUNT, C2, 0)).toEqual(sealed('an earlier state'));
  });


  it('refuses a path that would escape the directory', async () => {
    // The account id and the commitment both reach the filesystem. Neither is
    // hostile today; both come from outside this module.
    await expect(store.put('../escape', C1, 0, sealed('x'))).rejects.toThrow(/safe path segment/);
    await expect(store.put(ACCOUNT, '../../etc/passwd', 0, sealed('x'))).rejects.toThrow(/safe path segment/);
  });

  it('stores opaque bytes and never the viewing key', async () => {
    // Nothing this module writes should contain anything but the ciphertext it
    // was handed. It cannot decrypt, and holding the key here would undo the
    // product.
    await store.put(ACCOUNT, C1, 0, sealed('ciphertext'));
    const onDisk = readFileSync(join(root, ACCOUNT, `${C1}.k0.json`), 'utf8');
    expect(onDisk).toContain('ciphertext');
    expect(onDisk).not.toMatch(/viewingKey|secret|privateKey/i);
  });
});

describe('MemorySealedStateStore', () => {
  it('keeps the same never-overwrite rule as the file store', async () => {
    // A test that passes against behaviour the real store does not have is
    // worse than no test.
    const store = new MemorySealedStateStore();
    await store.put(ACCOUNT, C1, 0, sealed('one'));
    await store.put(ACCOUNT, C1, 0, sealed('two'));
    expect(await store.get(ACCOUNT, C1, 0)).toEqual(sealed('one'));
  });

  it('retains history', async () => {
    const store = new MemorySealedStateStore();
    await store.put(ACCOUNT, C1, 0, sealed('one'));
    await store.put(ACCOUNT, C2, 0, sealed('two'));
    expect(store.size).toBe(2);
  });
});

/*
 * K-4. The property rotation depends on, asserted against BOTH stores.
 *
 * A commitment covers the balance, the entry digest and the salt — the
 * plaintext — so re-sealing the same state under a new viewing key produces an
 * identical commitment and completely different bytes. If the epoch were not
 * part of the key, the second write would either overwrite the first or be
 * swallowed by the never-overwrite rule, and a rotation would have exactly one
 * readable copy at a moment when it needs two.
 */
describe.each([
  ['FileSealedStateStore', () => new FileSealedStateStore(mkdtempSync(join(tmpdir(), 'sealed-k4-')))],
  ['MemorySealedStateStore', () => new MemorySealedStateStore()],
])('%s and key epochs', (_name, make) => {
  it('holds one blob per key epoch under a single commitment', async () => {
    const store = make();
    await store.put(ACCOUNT, C1, 0, sealed('sealed under the old key'));
    await store.put(ACCOUNT, C1, 1, sealed('sealed under the new key'));

    expect(await store.get(ACCOUNT, C1, 0)).toEqual(sealed('sealed under the old key'));
    expect(await store.get(ACCOUNT, C1, 1)).toEqual(sealed('sealed under the new key'));
  });

  it('does not serve one epoch when another was asked for', async () => {
    // Returning the wrong epoch is worse than returning nothing: the bytes come
    // back, the viewing key fails the tag check, and it reads as a corrupt blob.
    const store = make();
    await store.put(ACCOUNT, C1, 1, sealed('only the new one exists'));
    expect(await store.get(ACCOUNT, C1, 0)).toBeNull();
  });

  it('still refuses to overwrite within one epoch', async () => {
    const store = make();
    await store.put(ACCOUNT, C1, 1, sealed('the real one'));
    await store.put(ACCOUNT, C1, 1, sealed('something else'));
    expect(await store.get(ACCOUNT, C1, 1)).toEqual(sealed('the real one'));
  });
});

describe('noSealedStateStore', () => {
  it('fails loudly at the write rather than silently at the read', async () => {
    /*
     * The deploy path carried `{ put: async () => {}, get: async () => null }`.
     * That store reports success and discards the blob, so the failure surfaces
     * at the first read — possibly months later, possibly to someone else, and
     * as "committed state could not be retrieved" with nothing to recover.
     */
    await expect(noSealedStateStore.put(ACCOUNT, C1, 0, sealed('x')))
      .rejects.toThrow(/refusing to discard|M-73/);
  });
});
