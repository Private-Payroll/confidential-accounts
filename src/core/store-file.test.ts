import { describe, it, expect } from 'vitest';
import { mkdtempSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { canonical, parseCanonical } from './crypto.js';
import type { Shape } from './store.js';
import type { User } from './types.js';

/**
 * THE FILE IS EVERY USER'S KEYS, so a half-write is not one bad record.
 *
 * `flush` was a single `writeFileSync`, which truncates and then writes. A crash
 * or a full disk part way through left a file that is not valid JSON, and the
 * constructor parses eagerly — **so the next start failed for every account, not
 * for the one being written.**
 */

/* `authHash: 'aa'` and `authSalt: 'bb'` were here. This file is about
 * whether a write that fails leaves the file readable; the two fields were
 * padding a type that no longer has them. */
const user = (id: string): User => ({
  id, email: id + '@a.co', name: id,
  keyBundle: null, createdAt: '2026-08-17T00:00:00.000Z',
});

/**
 * ROOT IGNORES DIRECTORY PERMISSIONS, so this test cannot fail a write as root.
 *
 * Under a CI image with no `USER` set, `chmod 0500` does not stop the write and
 * the test fails on CORRECT code. Skipping is not the same as passing and is
 * said out loud here — **a suite run as root does not check this property at
 * all**, and the fix is the CI user, not this file.
 */
const canBlockWrites = (process.getuid?.() ?? 0) !== 0;

describe('the store file', () => {
  it.skipIf(!canBlockWrites)('A FAILED WRITE CHANGES NOTHING — not on disk, and not in the process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sf-'));
    const path = join(dir, 'db.json');
    const store = new FileStore(path);
    store.putUser(user('usr_first'));

    /* No writes possible from here. */
    chmodSync(dir, 0o500);
    try {
      expect(() => store.putUser(user('usr_second'))).toThrow();

      /*
       * AND THE PROCESS IS NOT SERVING A CHANGE IT REPORTED AS FAILED.
       *
       * The mutation happens in memory before the write is attempted, so
       * without the rollback the second user is live — and the next successful
       * write of anything at all commits it. A caller that saw an error has to
       * be able to rely on nothing having happened, or a removal that failed
       * halfway leaves keys re-sealed and sessions un-revoked.
       */
      expect(store.getUser('usr_second')).toBeNull();
      expect(store.getUser('usr_first')).not.toBeNull();
    } finally {
      chmodSync(dir, 0o700);
    }

    /* The file on disk is still the last good one, and still parses. */
    const onDisk = parseCanonical<Shape>(readFileSync(path, 'utf8'));
    expect(Object.keys(onDisk.users)).toEqual(['usr_first']);
    expect(new FileStore(path).getUser('usr_first')).not.toBeNull();
  });

  it('AND LEAVES NO TEMPORARY FILE BEHIND when it succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sf-'));
    const path = join(dir, 'db.json');
    const store = new FileStore(path);
    store.putUser(user('usr_first'));
    store.putUser(user('usr_second'));
    expect(readdirSync(dir)).toEqual(['db.json']);
  });
});

describe('a table this store no longer keeps', () => {
  it('THE OLD PER-PERSON TABLE OF WHOSE VAULT KEY IS WHOSE IS DROPPED WHEN A FILE IS LOADED, AND NOT WRITTEN BACK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sf-retired-'));
    const path = join(dir, 'db.json');
    const first = new FileStore(path);
    first.putUser(user('u1'));
    /* A file written before the roster held each signer's keys: a person named beside their committee key. */
    const old = parseCanonical<Record<string, unknown>>(readFileSync(path, 'utf8'));
    old.vaultKeys = { 'acc_1:usr_ada': { accountId: 'acc_1', userId: 'usr_ada', committeeKey: { tag: 'schnorr', value: 'ab'.repeat(32) } } };
    writeFileSync(path, canonical(old));
    const loaded = new FileStore(path);
    /* RED WHEN: the table is carried forward - the file names a person beside their committee key after load. */
    expect(readFileSync(path, 'utf8')).not.toContain('usr_ada');
    expect(Object.keys(parseCanonical<Record<string, unknown>>(readFileSync(path, 'utf8')))).not.toContain('vaultKeys');
    /* And everything else in the file is kept. */
    expect(loaded.getUser('u1')?.email).toBe('u1@a.co');
    void ({} as Shape);
  });
});
