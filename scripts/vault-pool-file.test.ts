/**
 * **THE POOL ON DISK, AND THE FOUR THINGS THAT ARE NOT AN EMPTY VAULT.**
 *
 *
 * `vault-pool.ts`'s standing rule is that *"the pool could not be read"* and
 * *"the pool read as empty"* must never become the same answer, because the
 * first is a refusal and recoverable and the second is a claim that a company
 * has no money. A file system is where that rule is easiest to break: a missing
 * file, a truncated write, a record for another vault and a record with no
 * wrapped keys all arrive as bytes, and only the first of them is `null`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileSealedPoolStore, VaultPoolFileUnreadable, vaultPoolFile,
  vaultPoolVersionFile, versionFiledAs, highestVersionFiled, stagingNameFor,
} from './vault-pool-file.js';
import {
  SealedNotePool, sealPool, openPool, MemorySealedPoolStore, VaultPoolUnreadable,
  VaultPoolVersionAlreadyFiled, type PoolSigner,
} from '../src/midnight/vault-pool.js';
import type { VaultNotes } from '../src/midnight/vault-notes.js';
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
    /* And it does not name the address it holds. */
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
    const created = await pool.load(VAULT);
    expect(created.notes).toEqual([]);

    await pool.save(VAULT, { notes: [{ nonce: '01'.repeat(32), token: '02'.repeat(32), value: 7n }] }, created.readAt);
    const back = await pool.load(VAULT);
    /* `M-125`: a value is a bigint, and a plain JSON round trip makes it an object. */
    expect(back.notes[0]!.value).toBe(7n);
    expect(typeof back.notes[0]!.value).toBe('bigint');
  });

  it('carries an ABSENT index across the file, rather than filling it in', async () => {
    /*
     * A note whose place in the commitment tree has never been read
     * records `index: undefined`, and a store that turned that into a zero on
     * the way to disk would hand the contract a merkle path for another leaf.
     */
    const d = dir();
    const { signers: s, secret } = signers();
    const pool = new SealedNotePool(
      storeIn(d), { signerId: 'ada', wrappingSecret: secret }, async () => s);
    await pool.create(VAULT, { notes: [] });
    await pool.save(
      VAULT, { notes: [{ nonce: '01'.repeat(32), token: '02'.repeat(32), value: 7n }] }, (await pool.load(VAULT)).readAt);
    expect((await pool.load(VAULT)).notes[0]!.index).toBeUndefined();
  });

  it('leaves no half-written file behind, and no staging file of ANY name after a write', async () => {
    const d = dir();
    const { signers: s } = signers();
    const store = storeIn(d);
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));
    const f = vaultPoolFile(d, 'stagenet', 'payroll-test-1');
    /*
     * **ANY NAME, NOT ONE NAME.** This used to assert that `${f}.writing` was
     * gone, and that assertion went vacuous the moment the staging name became
     * unique per attempt -- it would have stayed green over a store that left a
     * staged copy of the money behind on every single write.
     */
    /*
     * **THE WHOLE LISTING, NOT A FILTER FOR `.writing`.** A filter is keyed to a
     * substring the code under test chooses, so renaming the staging suffix made
     * this assertion match nothing and pass -- a second reading demonstrated it, together
     * with the loser's cleanup deleted. An exact listing cannot be satisfied by a
     * rename.
     */
    expect(
      readdirSync(d).sort(),
      'RED WHEN: anything at all is left in the state folder besides the record and its unnumbered copy -- a staged, sealed copy of the money in a file nobody reads and nothing lists',
    ).toEqual([
      'stagenet-vault-pool-payroll-test-1.json',
      'stagenet-vault-pool-payroll-test-1.v1.json',
    ]);
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe(1);
  });

  /**
   * **EXACTLY ONE OF TWO WRITERS AT ONE VERSION IS TOLD, AND THE POOL HOLDS THAT
   * WRITER'S NOTES.**
   *
   * **WHAT THIS TEST DOES NOT PIN, SAID HERE BECAUSE IT USED TO CLAIM IT DID.** It
   * was titled *"the version is claimed, not compared"*, and a second reading showed that
   * replacing the claim with `existsSync` followed by a write leaves it green:
   * within one process those two statements cannot interleave, so a comparison
   * behaves exactly like a claim. **Atomicity is not observable from one process**
   * -- the same boundary the staging-name test runs into. What IS pinned here is
   * the outcome that matters either way: one success, one named refusal, and the
   * pool holding the successful writer's notes rather than the refused one's. The
   * claim itself is pinned on the source below, and it was watched across two real
   * processes: before it, two of twelve runs had BOTH writers reporting success.
   *
   * **NOTHING IS STUBBED AND NOTHING IS TIMED.** `put` awaits its read of the
   * store, so a second `put` started before the first resumes reaches its own read
   * first and sees the same version. That is precisely the state two processes are
   * in, reached here by the one thing the language guarantees about an `await`.
   */
  it('lets exactly ONE of two writers at the same version file it, and the pool holds that writer\'s notes', async () => {
    const d = dir();
    const { signers: s, secret } = signers();
    const store = storeIn(d);
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));

    const colour = '9b'.repeat(32);
    const a: VaultNotes = { notes: [{ nonce: 'a1'.repeat(32), token: colour, value: 111n }] };
    const b: VaultNotes = { notes: [{ nonce: 'b2'.repeat(32), token: colour, value: 222n }] };
    const settled = await Promise.allSettled([
      store.put(VAULT, sealPool(VAULT, a, s, 2)),
      store.put(VAULT, sealPool(VAULT, b, s, 2)),
    ]);

    const filed = settled.filter((r) => r.status === 'fulfilled');
    const refused = settled.filter((r) => r.status === 'rejected');
    /*
     * RED WHEN: the claim goes back to being a comparison followed by a write --
     * then BOTH of these report success, the later write silently replaces the
     * earlier, and one of the two notes is money the chain holds that no record
     * names. That is the defect, and it was measured twice in twelve runs of the
     * two-process version before this line existed.
     */
    expect(filed, 'RED WHEN: two writers both file the same version, so one of their notes is lost with no refusal anywhere').toHaveLength(1);
    expect(refused, 'RED WHEN: a writer that lost the race is not told, so it reports success over a write that never happened').toHaveLength(1);
    expect(
      (refused[0] as PromiseRejectedResult).reason,
      'RED WHEN: the loser is told something it cannot act on, instead of the one refusal that means "nothing was written, read again and re-apply"',
    ).toBeInstanceOf(VaultPoolVersionAlreadyFiled);

    /*
     * **AND THE POOL HOLDS THE WINNER'S NOTES.** The half that was wrong before
     * the staging name became unique: both writers staged under one filename, so
     * the pool could end up holding the LOSER's bytes while the winner reported
     * success. Asserting only that one writer failed would not have caught it.
     */
    const stored = await store.get(VAULT);
    const held = openPool(stored!, s[0].id, secret).notes.map((n) => n.nonce);
    const winnerWroteA = settled[0].status === 'fulfilled';
    expect(
      held,
      'RED WHEN: the pool ends up holding the bytes of the writer that was REFUSED, which is what two writers sharing one staging filename did -- the success and the record disagree and both operators are misinformed',
    ).toEqual([winnerWroteA ? 'a1'.repeat(32) : 'b2'.repeat(32)]);
  });

  /**
   * **THE STAGING NAME, ASSERTED ON THE SOURCE, BECAUSE ONE PROCESS CANNOT SEE
   * THIS AND THIS IS THE DEFECT THAT ACTUALLY LOST THE MONEY.**
   *
   * Two writers used to stage their bytes under one shared filename,
   * `<pool>.writing`. Across two real processes that produced the worst outcome
   * in this whole area: **the writer that reported SUCCESS had its write thrown
   * away and the writer that reported FAILURE was the one whose note landed** --
   * measured, once in twenty runs, against these production classes. Both
   * operators are then misinformed, in opposite directions, about a payment's
   * change note. Worse is available: two unrelated `writeFileSync` calls to one
   * path can leave a mixture, and a mixture reads as *"this pool is unreadable"*,
   * which refuses every payment until a rebuild.
   *
   * **A BEHAVIOURAL TEST CANNOT REACH IT HERE.** `writeFileSync` and `linkSync`
   * are synchronous, so within one process nothing can interleave between them --
   * a shared staging name is harmless in one process and ruinous across two. Two
   * mutations that restore the defect (one name for everybody; one name per
   * process, which collides when a process writes twice) leave every behavioural
   * assertion in this file GREEN. That is not a gap in the assertions, it is the
   * boundary of what one process can be asked.
   *
   * **SO THE PROPERTY IS ASSERTED WHERE IT LIVES: IN THE NAME.** Same shape as
   * `vault-pool.test.ts` asserting that its own source contains no viewing key,
   * and for the same reason -- the failure it prevents is somebody simplifying
   * this back and nothing objecting.
   */
  it('stages under a name no other writer and no other attempt could be using', () => {
    const f = vaultPoolFile('/s', 'stagenet', 'payroll-test-1');
    /*
     * **ASSERTED BY CALLING IT TWICE, NOT BY READING ITS SHAPE.** The first version
     * of this test matched the source for `${process.pid}` and `randomBytes` --
     * and a second reading showed that `randomBytes(0)` satisfies both while making the
     * name per-process only, which is the named defect. Two calls differing is the
     * property; the identifiers are how it is currently achieved.
     */
    expect(
      stagingNameFor(f),
      'RED WHEN: two attempts can stage under one name, so one writer publishes the other\'s bytes -- the writer that reports success is then not the writer whose note is in the pool',
    ).not.toBe(stagingNameFor(f));
    expect(
      stagingNameFor(f),
      'RED WHEN: the staging name stops depending on the process, so two PROCESSES collide however unique it is within one',
    ).toContain(`.${process.pid}.`);
    /*
     * And it must be recognisable as staging, because `everyVersionFiled` walks
     * this directory and a staged copy that looked like a filed version would be
     * offered to the chain as a note the pool once held.
     */
    expect(versionFiledAs(f, stagingNameFor(f).split('/').pop()!),
      'RED WHEN: a staged file can be read as a filed version, so a half-written pool joins the union a rebuild proposes')
      .toBeNull();
  });

  /**
   * **A WRITER THAT LOSES THE RACE LEAVES NOTHING BEHIND EITHER.**
   *
   * Found by a second reading of this change: neither failure path removed the staged file,
   * so every lost race left a sealed copy of the money under a name nothing reads
   * and `everyVersionFiled` never lists -- the exact thing the test above forbids
   * after a SUCCESSFUL write. A claim that a loser "changed nothing" was false.
   */
  it('leaves no staged copy of the money behind when a writer LOSES the race', async () => {
    const d = dir();
    const { signers: s } = signers();
    const store = storeIn(d);
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));
    await Promise.allSettled([
      store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 2)),
      store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 2)),
    ]);
    expect(
      readdirSync(d).sort(),
      'RED WHEN: the writer that lost the race leaves its staged, sealed copy of the pool in the state folder for ever -- one per lost race, each one the money in a file nobody reads',
    ).toEqual([
      'stagenet-vault-pool-payroll-test-1.json',
      'stagenet-vault-pool-payroll-test-1.v1.json',
      'stagenet-vault-pool-payroll-test-1.v2.json',
    ]);
  });

  /**
   * **THE VERSION IS CLAIMED BY `link`, PINNED ON THE SOURCE, BECAUSE ONE PROCESS
   * CANNOT SEE THE DIFFERENCE.**
   *
   * `link` creates a name or fails because it exists, in one step the kernel does
   * not divide. A comparison followed by a write has a gap between them, and two
   * PROCESSES were watched walking through it together while every in-process
   * assertion stayed green. Same shape as `vault-pool.test.ts` asserting that its
   * own source contains no viewing key, and for the same reason: the failure this
   * prevents is somebody simplifying it back and nothing objecting.
   */
  it('claims a version with link, and reaches the filed name no other way', () => {
    const src = readFileSync(new URL('./vault-pool-file.ts', import.meta.url), 'utf8');
    const put = src.slice(src.indexOf('async put('));
    expect(
      put,
      'RED WHEN: the version stops being claimed by link -- a comparison followed by a write has a gap between the two, and two processes have been watched both passing the comparison and both writing',
    ).toMatch(/linkSync\(staging, filed\)/);
    /*
     * RED WHEN: any other route reaches the filed name. `writeFileSync(filed, …)`
     * or `renameSync(…, filed)` would publish a version without claiming it, and
     * the claim would then be decoration beside a second path that ignores it.
     */
    for (const other of [/writeFileSync\(\s*filed/, /renameSync\([^)]*,\s*filed/, /appendFileSync\(\s*filed/]) {
      expect(put, `RED WHEN: a version is filed by ${String(other)} rather than claimed, so the claim is decoration beside a path that ignores it`)
        .not.toMatch(other);
    }
  });

  /**
   * **A RECORD WHOSE NAME AND CONTENT DISAGREE IS REFUSED, NOT PREFERRED.**
   *
   * The number in the name is what `link` refused to duplicate, so it is the
   * claim; the number inside is what the claim was about. This store never
   * writes a pair that disagrees, so a pair that does was written by something
   * else -- and trusting the content would let a hand-written file take a number
   * already spoken for, after which the next write is filed on top of a version
   * nobody read.
   */
  it('REFUSES a filed record whose name and version disagree, rather than believing one of them', async () => {
    const d = dir();
    const { signers: s } = signers();
    const store = storeIn(d);
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));
    const f = vaultPoolFile(d, 'stagenet', 'payroll-test-1');
    writeFileSync(vaultPoolVersionFile(f, 9), JSON.stringify(sealPool(VAULT, { notes: [] }, s, 3)));
    await expect(store.get(VAULT),
      'RED WHEN: the record inside a filed file is trusted over the number it is filed under, so one file can occupy a version it never claimed')
      .rejects.toThrow(VaultPoolFileUnreadable);
    await expect(store.get(VAULT)).rejects.toThrow(/filed as version 9 and the record inside it says version 3/);
  });

  /**
   * **A POOL WRITTEN BEFORE VERSIONS WERE FILED SEPARATELY IS STILL READ.**
   *
   * There are real pools on disk under the unnumbered name. A store that could
   * not read one would answer `null` for a vault that has a pool, and
   * `SealedNotePool` turns `null` into *"this vault has never had one, use
   * create()"* -- which is how a treasury gets an empty pool written over it.
   */
  it('reads a pool that exists only under the unnumbered name, and files the next version beside it', async () => {
    const d = dir();
    const { signers: s } = signers();
    const f = vaultPoolFile(d, 'stagenet', 'payroll-test-1');
    mkdirSync(d, { recursive: true });
    writeFileSync(f, JSON.stringify(sealPool(VAULT, { notes: [] }, s, 2)));
    const store = storeIn(d);
    expect(
      (await store.get(VAULT))?.version,
      'RED WHEN: a pool that predates numbered files reads as ABSENT, which SealedNotePool reports as a vault that never had a pool -- and the remedy for that is create(), which writes an empty pool over the record of the money',
    ).toBe(2);

    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 3));
    expect((await store.get(VAULT))?.version).toBe(3);
    expect(
      existsSync(vaultPoolVersionFile(f, 3)),
      'RED WHEN: the write does not file a numbered record, so the claim that makes a write atomic is not made at all',
    ).toBe(true);
  });

  /** The name a version is filed under, and what is NOT one. */
  it('reads a version out of a filename strictly, or not at all', () => {
    const f = vaultPoolFile('/s', 'stagenet', 'payroll-test-1');
    expect(vaultPoolVersionFile(f, 7)).toBe('/s/stagenet-vault-pool-payroll-test-1.v7.json');
    expect(versionFiledAs(f, 'stagenet-vault-pool-payroll-test-1.v7.json')).toBe(7);
    /*
     * RED WHEN: the digits are read with `Number`, which takes every one of
     * these. A version read loosely is a record filed under a number nothing
     * wrote, and `07` and `7` would be two names for one claim -- so `link`
     * would refuse neither and two writers would both file version 7.
     */
    for (const junk of ['.v.json', '.v 7.json', '.v7e2.json', '.v0x7.json', '.v07.json', '.v-7.json', '.v7.5.json', '.v0.json']) {
      expect(
        versionFiledAs(f, `stagenet-vault-pool-payroll-test-1${junk}`),
        `RED WHEN: "${junk}" is read as a version, which gives one claim two spellings and lets both writers file it`,
      ).toBeNull();
    }
    /* Another vault's record, in the same folder. */
    expect(versionFiledAs(f, 'stagenet-vault-pool-payroll-test-2.v7.json')).toBeNull();
    /* The unnumbered record itself is not a numbered one. */
    expect(versionFiledAs(f, 'stagenet-vault-pool-payroll-test-1.json')).toBeNull();
  });

  it('takes the HIGHEST version filed, not the newest file or the first one listed', async () => {
    const d = dir();
    const { signers: s } = signers();
    const store = storeIn(d);
    const f = vaultPoolFile(d, 'stagenet', 'payroll-test-1');
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));
    for (const v of [2, 3, 4]) await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, v));
    expect(highestVersionFiled(f)).toBe(4);
    /*
     * RED WHEN: the highest is found by sorting filenames as text, where `.v10`
     * sorts below `.v9` -- a pool that silently stops advancing at version 9 and
     * every write after it refused as already filed.
     */
    await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 5));
    for (const v of [6, 7, 8, 9, 10]) await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, v));
    expect(
      highestVersionFiled(f),
      'RED WHEN: versions are compared as text, so v10 reads as older than v9 and the pool cannot advance past 9',
    ).toBe(10);
    expect((await store.get(VAULT))?.version).toBe(10);
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
    await expect(store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 4)),
      'RED WHEN: a write of a version that is already filed is accepted, which replaces one record of the money with another')
      .rejects.toThrow(VaultPoolVersionAlreadyFiled);
    await expect(store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 3)),
      'RED WHEN: the refusal stops telling a caller whose write is a WHOLE POOL that there is no correct merge — the half that cannot be answered by re-applying a change')
      .rejects.toThrow(/no correct merge/);
  });

  it('behaves as the memory store does, so an instrument and a test see one contract', async () => {
    /*
     * The in-memory store is what every test of `SealedNotePool` runs
     * against, so a file store with different refusals would mean the tested
     * behaviour and the shipped behaviour were two things.
     */
    const d = dir();
    const { signers: s } = signers();
    const mem = new MemorySealedPoolStore();
    const file = storeIn(d);
    for (const store of [mem, file]) {
      await store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1));
      await expect(
        store.put(VAULT, sealPool(VAULT, { notes: [] }, s, 1)),
        'RED WHEN: the two stores stop raising the SAME refusal for the same fact, so the retry that acts on it is exercised against one of them and taken against the other',
      ).rejects.toThrow(VaultPoolVersionAlreadyFiled);
    }
    const pool = new SealedNotePool(file, { signerId: 'nobody', wrappingSecret: '00'.repeat(32) }, async () => s);
    await expect(pool.load(VAULT)).rejects.toThrow(VaultPoolUnreadable);
  });
});
