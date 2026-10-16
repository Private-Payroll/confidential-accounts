/**
 * The test double's own rules that no test reading through it would notice
 * broken: a filing waits for the next anchor only when it is newer than what
 * the tree holds of its record and names bytes it does not already hold, and a
 * run entered through the company's records is versioned by its own count of
 * entries.
 */
import { describe, it, expect } from 'vitest';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import { newSigningKeypair } from '../core/crypto.js';
import type { RunToFile } from '../core/run-filing.js';
import { companyRecordEntry, signManifestEntry } from '../midnight/record-manifest.js';
import { pendingAt, TreeKept } from '../midnight/record-tree.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { aCompanysRecords, anchoredEntering, firstBatchOf, heldEntering, heldFiledBy, heldServing, type FoundedWith } from './record-tree-double.js';
import type { DirectoryBelieved } from 'vaults-web-shared/vault-page-doors.js';

const CO = 'acct_tree_double';
const founder = newSigningKeypair();
const SEAT = 'ab'.repeat(32);

/** A person record at `version`, its sealed bytes standing for `bytes`. */
const person = (version: number, bytes: string): SealedCompanyRecord => ({
  company: CO, kind: 'person', id: 'emp_1', version, keyEpoch: 0, sealed: { iv: '00', tag: '00', body: bytes } as never, wrapped: [],
});
const FOUNDED: FoundedWith = { seat: SEAT, signingSecret: founder.secret, records: [person(1, 'a1')] };
const byFounder = (r: SealedCompanyRecord) => ({ entry: companyRecordEntry(r), signingSecret: founder.secret });

/** The directory a reader of the company believes: the founding seat alone, an admin, seated on chain with its committee key. */
const COMMITTEE = { tag: 'cardano-ed25519', value: 'cd'.repeat(32) };
const READER_DIR: Omit<DirectoryBelieved, 'at'> = {
  dir: { company: CO, version: 1, seats: [{ seat: SEAT, person: 'founder', signingKey: founder.publicKey, wrappingKey: 'ef'.repeat(32) as never, committeeKey: COMMITTEE, role: 'admin' as const, retired: null, opening: {} as never }] },
  holders: { seats: [SEAT], committee: [COMMITTEE], approvals: 1 } as never,
  another: new Set(), leafOf: () => null,
};
/**
 * The reader's directory at every version the read asks, with no version anchored: the founding seat alone, which the
 * read needs to judge the header it anchored and each filing waiting beside it.
 */
const READER: DirectoryBelieved = { ...READER_DIR, at: (version) => (version < 0 || version > 1 ? null : { dir: READER_DIR.dir, digests: [] }) };

/** A run to file, its sealed bytes standing for `bytes`. */
const run = (id: string, bytes: string): RunToFile => ({
  id, accountId: CO, period: '2026-09', status: 'draft', keyEpoch: 0, payslips: [], sealed: { iv: '00', tag: '00', body: bytes },
} as unknown as RunToFile);

describe('WHAT A TEST\'S RECORDS HOLD IS WHAT A DEVICE\'S OWN READ HOLDS', () => {
  it('A COMPANY WHOSE FIRST HEADER NO SEAT OF THE DIRECTORY AS ANCHORED MAY HAVE ANCHORED IS NOT READ PAST IT', async () => {
    const nobodyYet: DirectoryBelieved = { ...READER, at: (version) => (version < 0 || version > 1 ? null : { dir: { ...READER.dir, version, seats: [] }, digests: [] }) };
    const held = await heldEntering(CO, [], FOUNDED, nobodyYet);
    /* RED WHEN: the double serves a company's records though no seat of the directory as anchored with its first header may have anchored it. */
    expect(held.stopped).toMatchObject({ stop: 'dishonest' });
    expect(held.reached.seq).toBe(-1);
    expect(held.history.size).toBe(0);
    /* RED WHEN: the same records are not served once a seat that may anchor held the account then. */
    const served = await heldEntering(CO, [], FOUNDED, READER);
    expect(served.stopped).toBeNull();
    expect(served.history.get('company:person:emp_1')?.map((v) => v.version)).toEqual([1]);
  });
});

describe('WHO HOLDS THE ACCOUNT NOW IS READ FROM THE CHAIN', () => {
  it('A COMPANY HELD BY TWO SEATS AT TWO APPROVALS IS CHECKED FROM ITS FIRST HEADER, AND ONE HELD BY ONE KEY FROM THE HEADER BEFORE ITS LATEST', async () => {
    const two = { ...FOUNDED, thenAnchored: [person(2, 'a2')] };
    const byOneKey = await heldEntering(CO, [], two, READER);
    expect(byOneKey.checkedFrom).toMatchObject({ by: 'latest' });
    /* RED WHEN: a read ignores the seats and approvals the account is held by, so a company of two seats trusts its latest header as one key does. */
    const bySeats = await heldEntering(CO, [], { ...two, account: { approvals: 2, seatBar: seatBarOf(2, null), seats: [SEAT, 'cd'.repeat(32)] } }, READER);
    expect(bySeats.checkedFrom).toBeUndefined();
    expect(bySeats.reached.seq).toBe(1);
  });
});

describe('WHAT A TEST\'S RECORDS HOLD AS WAITING FOR THE NEXT ANCHOR', () => {
  it('a version the tree already anchors, filed again with other bytes, does not wait; a newer one does', async () => {
    /* RED WHEN: the tree stops leaving out an entry at or below its record's anchored version, so version 1 waits beside its leaf. */
    const held = await heldEntering(CO, [byFounder(person(1, 'b1')), byFounder(person(2, 'a2'))], FOUNDED, READER);
    expect(held.history.get('company:person:emp_1')?.map((v) => v.version)).toEqual([1]);
    expect(held.notYetAnchored.map((e) => [e.id, e.version])).toEqual([['emp_1', 2]]);
  });

  it('THE TREE LISTS AS WAITING ONLY AN ENTRY NEWER THAN ITS RECORD\'S ANCHORED LEAF', () => {
    /* RED WHEN: the tree lists an entry at or below the version its record is anchored at as waiting for the next anchor. */
    const first = firstBatchOf(CO, FOUNDED);
    const entries = [person(1, 'b1'), person(2, 'a2')].map((r) => signManifestEntry(CO, companyRecordEntry(r), founder.secret));
    expect(pendingAt(new TreeKept([first.header]), entries, first.header.root)?.map((e) => e.version)).toEqual([2]);
  });

  it('A SERVICE THAT LISTS AN ENTRY ALREADY ANCHORED AS WAITING IS NOT BELIEVED: THE READ DROPS IT', async () => {
    /* RED WHEN: a read lists as waiting an entry at or below the version its record is anchored at, because the service listed it. */
    const lying = (_honest: readonly unknown[], every: readonly unknown[]) => every as never;
    const held = await heldEntering(CO, [byFounder(person(1, 'b1')), byFounder(person(2, 'a2'))], FOUNDED, READER, lying);
    expect(held.notYetAnchored.map((e) => [e.id, e.version])).toEqual([['emp_1', 2]]);
  });

  it('A VERSION FILED TWICE WITH OTHER BYTES WAITS ONCE, AS THE FIRST FILED', async () => {
    /* RED WHEN: a read lists the same version of a record twice, once for each set of bytes filed at it. */
    const held = await heldEntering(CO, [byFounder(person(2, 'a2')), byFounder(person(2, 'c2'))], FOUNDED, READER);
    expect(held.notYetAnchored.map((e) => [e.id, e.version, e.digest])).toEqual([['emp_1', 2, companyRecordEntry(person(2, 'a2')).digest]]);
  });

  it('a run filed again with the same bytes waits once, under the version first entered', async () => {
    /* RED WHEN: a read lists a run filed again with bytes it already holds as a second waiting version. */
    const records = aCompanysRecords(CO);
    const seat = records.enteredBy(founder.secret);
    await seat.enter([{ store: 'run', run: run('run_same00000001', 'r1') }]);
    await seat.enter([{ store: 'run', run: run('run_same00000001', 'r1') }]);
    expect(records.filed.map((f) => f.entry.version)).toEqual([1, 2]);
    const held = await records.anchored(READER, { kinds: [{ store: 'run', kind: 'run' }] });
    expect(held.notYetAnchored.map((e) => [e.id, e.version])).toEqual([['run_same00000001', 1]]);
  });

  it('a run entered through the company\'s records is versioned by its own count of entries, not another run\'s', async () => {
    /* RED WHEN: a run's version is not one more than its own entries - counted over every run, or not counted at all. */
    const records = aCompanysRecords(CO);
    const seat = records.enteredBy(founder.secret);
    await seat.enter([{ store: 'run', run: run('run_a00000000001', 'a1') }]);
    await seat.enter([{ store: 'run', run: run('run_a00000000001', 'a2') }, { store: 'run', run: run('run_b00000000001', 'b1') }]);
    expect(records.filed.map((f) => [f.entry.id, f.entry.version])).toEqual([['run_a00000000001', 1], ['run_a00000000001', 2], ['run_b00000000001', 1]]);
    const held = await records.anchored(READER, { kinds: [{ store: 'run', kind: 'run' }] });
    expect(held.notYetAnchored.map((e) => [e.id, e.version])).toEqual([['run_a00000000001', 1], ['run_a00000000001', 2], ['run_b00000000001', 1]]);
  });

  it('A FILING WAITS ONLY WHEN A SEAT THE READER\'S DIRECTORY LETS FILE IT NOW SIGNED IT: THE READ\'S OWN RULE, NOT THE DOUBLE\'S', async () => {
    const stranger = newSigningKeypair();
    const filed = [{ entry: companyRecordEntry(person(2, 'a2')), signingSecret: stranger.secret }, byFounder(person(3, 'a3'))];
    const held = await anchoredEntering(CO, () => filed, FOUNDED)(READER, { records: [{ store: 'company', kind: 'person', id: 'emp_1' }] });
    /* RED WHEN: the double holds a filing as waiting that no seat the reader believes signed - a reader judged against a copy of the read. */
    expect(held.notYetAnchored.map((e) => e.version)).toEqual([3]);
    /* RED WHEN: a lower version entered after a higher one is dropped by the double where the read keeps it, both newer than the leaf. */
    const later = [byFounder(person(3, 'a3')), byFounder(person(2, 'a2'))];
    expect((await anchoredEntering(CO, () => later, FOUNDED)(READER, { records: [{ store: 'company', kind: 'person', id: 'emp_1' }] }))
      .notYetAnchored.map((e) => e.version)).toEqual([3, 2]);
  });
});

describe('THE DIRECTORY A READ IS JUDGED BY IS THE ONE A TEST HANDS, NEVER ONE THE DOUBLE MAKES', () => {
  it('A READ OF FILINGS, OR OF A FOUNDED COMPANY, WITH NO DIRECTORY IS REFUSED; A READ WITH NEITHER NEEDS NONE', async () => {
    /* RED WHEN: the double again makes up a directory for filings it was handed no directory to judge - every filer an admin, seated, believed. */
    await expect(heldEntering(CO, [byFounder(person(2, 'a2'))])).rejects.toThrow(/hands its directory/u);
    await expect(heldEntering(CO, [byFounder(person(2, 'a2'))], FOUNDED)).rejects.toThrow(/hands its directory/u);
    await expect(heldFiledBy(CO, [], [], FOUNDED)).rejects.toThrow(/hands its directory/u);
    await expect(heldServing(CO, {}, [], FOUNDED)).rejects.toThrow(/hands its directory/u);
    /* RED WHEN: a read with no filing and no founded company is refused too - the records of a test with nothing in them. */
    const none = await heldEntering(CO);
    expect([none.stopped, none.notYetAnchored, none.reached.seq]).toEqual([null, [], -1]);
  });

  it('A FILING WAITS ONLY WHEN ITS SEAT\'S ROLE IN THE HANDED DIRECTORY MAY FILE ITS KIND', async () => {
    const asRole = (role: 'admin' | 'approver'): DirectoryBelieved => {
      const seats = READER_DIR.dir.seats.map((x) => ({ ...x, role }));
      return { ...READER, dir: { ...READER_DIR.dir, seats }, at: (version) => (version < 0 || version > 1 ? null : { dir: { ...READER_DIR.dir, version, seats }, digests: [] }) };
    };
    const filed = [byFounder(person(2, 'a2'))];
    const waiting = async (role: 'admin' | 'approver') => (await heldEntering(CO, filed, FOUNDED, asRole(role))).notYetAnchored.map((e) => e.id);
    /* RED WHEN: the double judges every filer an admin whatever role the directory it was handed gives the seat - an approver's person waits. */
    expect(await waiting('approver')).toEqual([]);
    /* RED WHEN: the double leaves out a filing its seat's role may file. */
    expect(await waiting('admin')).toEqual(['emp_1']);
  });
});
