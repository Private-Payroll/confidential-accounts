/**
 * **A COMPANY RECORD'S LOST ENTRY IS ENTERED FROM ANY SEAT'S DEVICE, ONLY AS ITS FILER SIGNED IT.**
 *
 * Every version a seat files carries that seat's own signed entry in the company's records. A device that reads a
 * version the records do not name posts that entry, and nothing else: never a first version, never one the records
 * already name or pass, never one carrying another seat's signature or other bytes, and nothing before the company's
 * first anchor. A refusal by the service is handed back, never thrown, so the read that follows refuses as before.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { carriedEntryRefusal } from '../../../src/midnight/carried-entry.js';
import { companyRecordEntry, EMPTY_HEAD, recordKeyOf, signedWithItsEntry, signManifestEntry, type ManifestEntry } from '../../../src/midnight/record-manifest.js';
import { FOUNDING_RECORDS, type RecordsHeld } from '../../../src/midnight/records-held.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { carriedEntriesEntered, readAfterEntering } from './carried-entries-entered.js';

const CO = 'acc_lost';
const ADA = '01'.repeat(32) as Hex;
const BO = '02'.repeat(32) as Hex;
const NAMED = { store: 'company' as const, kind: 'vault-info', id: 'vlt_1' };

const versionOf = (version: number, by: Hex = ADA, company = CO): SealedCompanyRecord => signedWithItsEntry({
  company, kind: 'vault-info', id: 'vlt_1', version, keyEpoch: 0, sealed: { iv: 'iv', tag: String(version), body: 'b' } as never, wrapped: [],
}, by);
const heldWith = (o: { seq?: number; stopped?: boolean; pending?: readonly ManifestEntry[] } = {}): RecordsHeld => ({
  head: EMPTY_HEAD, reached: { seq: o.seq ?? 0, head: EMPTY_HEAD, root: EMPTY_HEAD, dirVersion: 1 },
  stopped: o.stopped === true ? { why: 'stopped' } as never : null,
  asked: { records: new Set([NAMED, ...FOUNDING_RECORDS].map(recordKeyOf)), kinds: new Set() }, history: new Map(), notYetAnchored: o.pending ?? [], directory: new Map(),
});
const service = (refuse: string | null = null) => {
  const posted: ManifestEntry[][] = [];
  return { posted, doors: { accountId: CO, manifest: { enter: async (_c: string, e: readonly ManifestEntry[]) => {
    if (refuse !== null) throw new Error(refuse);
    posted.push([...e]);
  } } } };
};

describe('THE ENTRY A VERSION CARRIES', () => {
  it('is its own filer\'s signature over exactly that version, and nothing else passes', () => {
    const own = versionOf(2);
    expect(carriedEntryRefusal(own)).toBeNull();
    /* RED WHEN: a version carrying no entry is taken as carrying one a device could enter. */
    expect(carriedEntryRefusal({ ...own, entry: undefined })).toMatch(/carries no entry/u);
    /* RED WHEN: an entry another seat signed over the same version is entered as the filer's. */
    expect(carriedEntryRefusal({ ...own, entry: signManifestEntry(CO, companyRecordEntry(own), BO) })).toMatch(/not signed by the seat that filed it/u);
    /* RED WHEN: the entry of another version, or of other bytes, is entered for this one. */
    expect(carriedEntryRefusal({ ...own, entry: versionOf(3).entry })).toMatch(/another record, another version or other bytes/u);
    expect(carriedEntryRefusal({ ...own, sealed: { ...own.sealed, body: 'c' } as never, filedBy: signCompanyFiling({ ...own, sealed: { ...own.sealed, body: 'c' } as never }, ADA).filedBy }))
      .toMatch(/another record, another version or other bytes/u);
    /* RED WHEN: an entry whose signature covers another company's records is entered here. */
    expect(carriedEntryRefusal({ ...own, entry: { ...own.entry!, filedBy: signManifestEntry('acc_other', companyRecordEntry(own), ADA).filedBy } }))
      .toMatch(/not one: its signature does not cover exactly this entry/u);
  });

  it('is never carried over from an earlier version when the next is signed', () => {
    /* RED WHEN: re-signing a version made from an earlier one keeps the earlier version's entry, which names other bytes. */
    expect(signCompanyFiling({ ...versionOf(2), version: 3 }, ADA).entry).toBeUndefined();
  });
});

describe('THE SWEEP', () => {
  it('enters each owed version, in version order, as its filer signed it', async () => {
    const s = service();
    const [v2, v3] = [versionOf(2), versionOf(3)];
    expect(await carriedEntriesEntered(s.doors, heldWith(), [v3, v2])).toEqual({ entered: 2, refused: null });
    /* RED WHEN: a later version's entry is posted before an earlier one's, which the records refuse as not the next. */
    expect(s.posted).toEqual([[v2.entry, v3.entry]]);
  });

  it('enters nothing it must not', async () => {
    const s = service();
    /* RED WHEN: a record the company was founded with is entered, as founded, from a device other than its founding seat's. */
    const founding = FOUNDING_RECORDS.map((r) => signedWithItsEntry({
      company: CO, kind: r.kind as 'state' | 'roster', id: r.id, version: 1, keyEpoch: 0, sealed: { iv: 'iv', tag: 't', body: 'b' } as never, wrapped: [],
    }, ADA));
    expect((await carriedEntriesEntered(s.doors, heldWith(), founding.slice(0, 1))).entered).toBe(0);
    expect((await carriedEntriesEntered(s.doors, heldWith(), founding.slice(1))).entered).toBe(0);
    /* RED WHEN: another seat's entry is entered before the company's first anchor, ahead of the records it was founded with. */
    expect((await carriedEntriesEntered(s.doors, heldWith({ seq: -1 }), [versionOf(2)])).entered).toBe(0);
    /* RED WHEN: an entry is entered past a stop the company's records came to. */
    expect((await carriedEntriesEntered(s.doors, heldWith({ stopped: true }), [versionOf(2)])).entered).toBe(0);
    /* RED WHEN: a version the records already name, or pass, is entered again. */
    expect((await carriedEntriesEntered(s.doors, heldWith({ pending: [versionOf(2).entry!] }), [versionOf(2)])).entered).toBe(0);
    expect((await carriedEntriesEntered(s.doors, heldWith({ pending: [versionOf(3).entry!] }), [versionOf(2)])).entered).toBe(0);
    /* RED WHEN: a version carrying another seat's entry, or another company's version, is entered. */
    const forged = { ...versionOf(2), entry: signManifestEntry(CO, companyRecordEntry(versionOf(2)), BO) };
    expect((await carriedEntriesEntered(s.doors, heldWith(), [forged])).entered).toBe(0);
    expect((await carriedEntriesEntered(s.doors, heldWith(), [versionOf(2, ADA, 'acc_other')])).entered).toBe(0);
    expect(s.posted).toEqual([]);
  });

  it('enters the first version of any other record, such as a person\'s invitation or a vault\'s first name', async () => {
    const s = service();
    /* RED WHEN: a lost first version of a record the company was not founded with is left to its own filer, so every device refuses it for good. */
    expect(await carriedEntriesEntered(s.doors, heldWith(), [versionOf(1)])).toEqual({ entered: 1, refused: null });
    expect(s.posted).toEqual([[versionOf(1).entry]]);
  });

  it('hands back a refusal by the service and throws nothing', async () => {
    /* RED WHEN: a refused entry is thrown, so a read that could follow an older version stops instead. */
    expect(await carriedEntriesEntered(service('the signer holds no seat now').doors, heldWith(), [versionOf(2)]))
      .toEqual({ entered: 0, refused: 'the signer holds no seat now' });
  });

  it('a read is made again only when the sweep lifted what refused it', async () => {
    let reads = 0;
    const read = async () => { reads += 1; if (reads === 1) throw new Error('unentered'); return reads; };
    expect(await readAfterEntering(read, () => true, async () => ({ entered: 1, refused: null }))).toBe(2);
    reads = 0;
    /* RED WHEN: a read is made again though the sweep entered nothing, or for a refusal the sweep cannot lift. */
    await expect(readAfterEntering(read, () => true, async () => ({ entered: 0, refused: null }))).rejects.toThrow('unentered');
    reads = 0;
    await expect(readAfterEntering(read, () => false, async () => ({ entered: 1, refused: null }))).rejects.toThrow('unentered');
  });
});
