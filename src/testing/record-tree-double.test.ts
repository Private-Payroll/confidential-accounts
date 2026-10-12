/**
 * The test double's own rules that no test reading through it would notice
 * broken: a filing waits for the next anchor only when it is newer than what
 * the tree holds of its record and names bytes it does not already hold, and a
 * run entered through the company's records is versioned by its own count of
 * entries.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair } from '../core/crypto.js';
import type { RunToFile } from '../core/run-filing.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { aCompanysRecords, anchoredEntering, heldEntering, type FoundedWith } from './record-tree-double.js';
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
const READER: DirectoryBelieved = {
  dir: { company: CO, version: 1, seats: [{ seat: SEAT, person: 'founder', signingKey: founder.publicKey, wrappingKey: 'ef'.repeat(32) as never, committeeKey: COMMITTEE, role: 'admin', retired: null }] },
  holders: { seats: [SEAT], committee: [COMMITTEE], approvals: 1 } as never,
  another: new Set(), at: () => null,
};

/** A run to file, its sealed bytes standing for `bytes`. */
const run = (id: string, bytes: string): RunToFile => ({
  id, accountId: CO, period: '2026-09', status: 'draft', keyEpoch: 0, payslips: [], sealed: { iv: '00', tag: '00', body: bytes },
} as unknown as RunToFile);

describe('WHAT A TEST\'S RECORDS HOLD AS WAITING FOR THE NEXT ANCHOR', () => {
  it('a version the tree already anchors, filed again with other bytes, does not wait; a newer one does', () => {
    /* RED WHEN: the double's filter of a version at or below the one anchored is dropped, so version 1 waits beside its leaf. */
    const held = heldEntering(CO, [byFounder(person(1, 'b1')), byFounder(person(2, 'a2'))], FOUNDED);
    expect(held.history.get('company:person:emp_1')?.map((v) => v.version)).toEqual([1]);
    expect(held.notYetAnchored.map((e) => [e.id, e.version])).toEqual([['emp_1', 2]]);
  });

  it('a run filed again with the same bytes waits once, under the version first entered', async () => {
    /* RED WHEN: the double's filter of bytes already entered is dropped, so the same run waits as version 1 and version 2. */
    const records = aCompanysRecords(CO);
    const seat = records.enteredBy(founder.secret);
    await seat.enter([{ store: 'run', run: run('run_same', 'r1') }]);
    await seat.enter([{ store: 'run', run: run('run_same', 'r1') }]);
    expect(records.filed.map((f) => f.entry.version)).toEqual([1, 2]);
    const held = await records.anchored(READER, { kinds: [{ store: 'run', kind: 'run' }] });
    expect(held.notYetAnchored.map((e) => [e.id, e.version])).toEqual([['run_same', 1]]);
  });

  it('a run entered through the company\'s records is versioned by its own count of entries, not another run\'s', async () => {
    /* RED WHEN: a run's version is not one more than its own entries - counted over every run, or not counted at all. */
    const records = aCompanysRecords(CO);
    const seat = records.enteredBy(founder.secret);
    await seat.enter([{ store: 'run', run: run('run_a', 'a1') }]);
    await seat.enter([{ store: 'run', run: run('run_a', 'a2') }, { store: 'run', run: run('run_b', 'b1') }]);
    expect(records.filed.map((f) => [f.entry.id, f.entry.version])).toEqual([['run_a', 1], ['run_a', 2], ['run_b', 1]]);
    const held = await records.anchored(READER, { kinds: [{ store: 'run', kind: 'run' }] });
    expect(held.notYetAnchored.map((e) => [e.id, e.version])).toEqual([['run_a', 1], ['run_a', 2], ['run_b', 1]]);
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
