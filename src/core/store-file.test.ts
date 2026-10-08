import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { canonical, parseCanonical } from './crypto.js';
import type { Shape } from './store.js';
import type { SealedProposal, SealedRun, User } from './types.js';

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

  it.skipIf(!canBlockWrites)('A RUN RAISED AND ITS PROPOSAL: A WRITE OF THE TWO THAT FAILS LEAVES NEITHER, ON DISK OR IN THE PROCESS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sf-raise-'));
    const path = join(dir, 'db.json');
    const store = new FileStore(path);
    const drawn = { id: 'run_abcdefghijkl', accountId: 'acc_1', period: '2026-11', status: 'draft', payslips: [], keyEpoch: 0, sealed: { iv: 'a', tag: 'b', body: 'c' } } as unknown as SealedRun;
    store.putRun(drawn);
    const raised = { ...drawn, status: 'proposed', proposalIds: ['prp_1'] } as SealedRun;
    const proposal = { id: 'prp_1', accountId: 'acc_1', status: 'open' } as unknown as SealedProposal;
    chmodSync(dir, 0o500);
    try {
      /* RED WHEN: a failed write of the two is reported as a run that moved on, or leaves either changed in the process or on disk. */
      expect(() => store.putRaisedRunAndProposal(raised, drawn, proposal)).toThrow();
      expect(store.getRun(drawn.id)).toEqual(drawn);
      expect(store.getProposal('prp_1')).toBeNull();
    } finally {
      chmodSync(dir, 0o700);
    }
    const again = new FileStore(path);
    expect(again.getRun(drawn.id)).toEqual(drawn);
    expect(again.getProposal('prp_1')).toBeNull();
    /* And it writes both, once the store can write. */
    expect(store.putRaisedRunAndProposal(raised, drawn, proposal)).toBe(true);
    expect(new FileStore(path).getRun(drawn.id)?.proposalIds).toEqual(['prp_1']);
    expect(new FileStore(path).getProposal('prp_1')).not.toBeNull();
    /* RED WHEN: a run that moved on, or a proposal name already taken, is written over. */
    expect(store.putRaisedRunAndProposal({ ...raised, proposalIds: ['prp_2'] }, drawn, { ...proposal, id: 'prp_2' })).toBe(false);
    expect(store.putRaisedRunAndProposal({ ...raised, proposalIds: ['prp_1'] }, raised, proposal)).toBe(false);
    expect(store.getProposal('prp_2')).toBeNull();
  });

  it.skipIf(!canBlockWrites)('A RUN RAISED AND ITS PROPOSAL GO TO DISK IN ONE WRITE: THE DISK FAILING AFTER ANY WRITE STILL LEAVES BOTH OR NEITHER', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sf-raise-one-'));
    const path = join(dir, 'db.json');
    const store = new FileStore(path);
    const drawn = { id: 'run_abcdefghijkl', accountId: 'acc_1', period: '2026-11', status: 'draft', payslips: [], keyEpoch: 0, sealed: { iv: 'a', tag: 'b', body: 'c' } } as unknown as SealedRun;
    store.putRun(drawn);
    const raised = { ...drawn, status: 'proposed', proposalIds: ['prp_1'] } as SealedRun;
    const proposal = { id: 'prp_1', accountId: 'acc_1', status: 'open' } as unknown as SealedProposal;
    /* The disk stops taking writes the moment one write of the raise has landed. */
    const as = store as unknown as { flush: () => void };
    const write = as.flush.bind(store);
    const writes = vi.spyOn(as, 'flush').mockImplementation(() => { write(); chmodSync(dir, 0o500); });
    try {
      try { store.putRaisedRunAndProposal(raised, drawn, proposal); } catch { /* a later write failing is what is being checked */ }
    } finally {
      writes.mockRestore();
      chmodSync(dir, 0o700);
    }
    const onDisk = new FileStore(path);
    /* RED WHEN: the run as raised reaches the disk in a write of its own, and its proposal's write is the one that fails. */
    expect([onDisk.getRun(drawn.id)?.proposalIds ?? [], onDisk.getProposal('prp_1') !== null])
      .toEqual(onDisk.getProposal('prp_1') !== null ? [['prp_1'], true] : [[], false]);
    expect([store.getRun(drawn.id)?.proposalIds ?? [], store.getProposal('prp_1') !== null])
      .toEqual(store.getProposal('prp_1') !== null ? [['prp_1'], true] : [[], false]);
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

  it('THE PLUG-IN TABLES - EACH INSTALLATION WITH ITS CAPABILITY TOKEN, AND EVERY PLUG-IN EVENT - ARE DROPPED WHEN A FILE IS LOADED, AND NOT WRITTEN BACK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sf-retired-plugins-'));
    const path = join(dir, 'db.json');
    const first = new FileStore(path);
    first.putUser(user('u1'));
    /* A file written while plug-ins could be installed: a token and an allowance in plain text. */
    const old = parseCanonical<Record<string, unknown>>(readFileSync(path, 'utf8'));
    old.installations = { ins_1: { id: 'ins_1', accountId: 'acc_1', pluginId: 'xero-sync', token: 'capability-token-ins-1' } };
    old.pluginEvents = { evt_1: { id: 'evt_1', installationId: 'ins_1', accountId: 'acc_1', action: 'read-plugin-event-1' } };
    writeFileSync(path, canonical(old));
    const loaded = new FileStore(path);
    const after = readFileSync(path, 'utf8');
    /* RED WHEN: `installations` leaves the retired list - the capability token is written back on load. */
    expect(after).not.toContain('capability-token-ins-1');
    /* RED WHEN: `pluginEvents` leaves the retired list - the event is written back on load. */
    expect(after).not.toContain('read-plugin-event-1');
    expect(Object.keys(parseCanonical<Record<string, unknown>>(after))).not.toContain('installations');
    expect(Object.keys(parseCanonical<Record<string, unknown>>(after))).not.toContain('pluginEvents');
    /* And everything else in the file is kept. */
    expect(loaded.getUser('u1')?.email).toBe('u1@a.co');
  });

  it('THE ATTESTATION TABLE IS DROPPED WHEN A FILE IS LOADED, AND NOT WRITTEN BACK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-sf-retired-attestations-'));
    const path = join(dir, 'db.json');
    const first = new FileStore(path);
    first.putUser(user('u1'));
    const old = parseCanonical<Record<string, unknown>>(readFileSync(path, 'utf8'));
    old.attestations = { att_1: { id: 'att_1', accountId: 'acc_1', statement: 'attestation-statement-1' } };
    writeFileSync(path, canonical(old));
    const loaded = new FileStore(path);
    const after = readFileSync(path, 'utf8');
    /* RED WHEN: `attestations` leaves the retired list - the row is written back on load. */
    expect(after).not.toContain('attestation-statement-1');
    expect(Object.keys(parseCanonical<Record<string, unknown>>(after))).not.toContain('attestations');
    expect(loaded.getUser('u1')?.email).toBe('u1@a.co');
  });
});
