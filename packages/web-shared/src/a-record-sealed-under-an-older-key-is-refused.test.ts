/**
 * **A RECORD SEALED UNDER THE COMPANY'S KEY IS BELIEVED ONLY UNDER THE KEY IN
 * FORCE WHEN ITS BATCH WAS ANCHORED** (`judgeIn`). Once a change of the key is
 * anchored, a signer who left holds only the older keys, so a record a stale
 * device sealed under one of them afterwards is refused on every device. The
 * company's records here are a double: the directory every device believes,
 * with its changes of the key, and the batch that anchored each version.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, type Hex } from '../../../src/core/crypto.js';
import { proposalEntry, recordKeyOf, runEntry } from '../../../src/midnight/record-manifest.js';
import { keptRunHere, proposalsListedHere, runRebuiltHere } from './run-rebuilt-here.js';
import { openTheRoundHere } from './round-opened-here.js';
import { emptyDirectory, type Directory, type DirectorySeat } from '../../../src/midnight/seat-directory.js';
import { filingRefusalCodeOf, judgeIn, listedHere, RecordSealedUnderAnOlderKey, refusedForItsKey, type DirectoryHere } from './vault-page-doors.js';
import { HttpCompanyRecordStore } from './http-sealed-pool-store.js';
import { signCompanyFiling, toCompanyWire } from '../../../src/midnight/sealed-record-wire.js';

const ACC = 'acc_older_key';
const ADA = newSigningKeypair();
const ADA_SEAT: DirectorySeat = { seat: 'a1'.repeat(32), person: 'ada', signingKey: ADA.publicKey, wrappingKey: 'b1'.repeat(32) as Hex, role: 'admin', retired: null };
const ROSTER = { store: 'company' as const, kind: 'roster', id: 'roster' };
const digestOf = (n: number): Hex => n.toString(16).padStart(2, '0').repeat(32) as Hex;

/**
 * The company with one change of the key, its version 3 anchored in batch `rotatedIn`, and each record version given
 * anchored in the batch named (or waiting to be anchored, with `batch` null).
 */
const aCompany = (rotatedIn: number, versions: readonly { read: typeof ROSTER; version: number; batch: number | null }[]): DirectoryHere => {
  const dir: Directory = {
    ...emptyDirectory(ACC), version: 3, seats: [ADA_SEAT],
    rotations: [{ version: 3, epoch: 1, keyCheck: 'cc'.repeat(32) as Hex, after: 2 }],
  };
  const history = new Map<string, { version: number; digest: Hex; filedBy: Hex; batch: number; dirVersion: number }[]>();
  const notYetAnchored: unknown[] = [];
  for (const v of versions) {
    if (v.batch === null) {
      notYetAnchored.push({ ...v.read, version: v.version, digest: digestOf(v.version), filedBy: { publicKey: ADA.publicKey } });
      continue;
    }
    const key = recordKeyOf(v.read);
    history.set(key, [...(history.get(key) ?? []), { version: v.version, digest: digestOf(v.version), filedBy: ADA.publicKey.toLowerCase() as Hex, batch: v.batch, dirVersion: 3 }]);
  }
  return {
    dir,
    holders: { seats: [ADA_SEAT.seat], approvals: 1, seatBar: 1 } as never,
    leafOf: () => null,
    another: new Set(),
    at: () => null,
    records: {
      head: '00'.repeat(32), reached: {} as never, stopped: null,
      asked: { records: new Set([recordKeyOf(ROSTER)]), kinds: new Set() },
      history, notYetAnchored: notYetAnchored as never,
      directory: new Map([1, 2, 3].map((v) => [v, { digest: digestOf(v), batch: v === 3 ? rotatedIn : 0, held: {} as never }])),
    },
  } as unknown as DirectoryHere;
};

const judged = (here: DirectoryHere, read: typeof ROSTER, version: number, sealedAt?: number) =>
  judgeIn(here)(ADA.publicKey, read.kind as never, `${read.kind}:${read.id}`, { ...read, version, digest: digestOf(version) }, false, sealedAt);

describe('a record sealed under an older company key than the one in force at its batch', () => {
  it('is refused when its batch came after the change of the key was anchored', () => {
    const here = aCompany(2, [{ read: ROSTER, version: 1, batch: 0 }, { read: ROSTER, version: 2, batch: 3 }]);
    /* RED WHEN: a record sealed under the key a removed signer holds, entered after the change of the key, is believed. */
    expect(judged(here, ROSTER, 2, 0)).toMatch(/sealed under the company's key at epoch 0, and the key at epoch 1 was already in force/u);
    /* The control: the same record sealed under the key in force is believed. */
    expect(judged(here, ROSTER, 2, 1)).toBeNull();
    /* RED WHEN: a record sealed and anchored before the change of the key is refused once the key changes. */
    expect(judged(here, ROSTER, 1, 0)).toBeNull();
  });

  it('is named in a log by the code of its reason alone, as is a record no filer signed', () => {
    const here = aCompany(2, [{ read: ROSTER, version: 1, batch: 0 }, { read: ROSTER, version: 2, batch: 3 }]);
    /* RED WHEN: a roster refused for being sealed under an older key is logged under another code, or under its sentence. */
    expect(filingRefusalCodeOf(judged(here, ROSTER, 2, 0)!)).toBe('sealed-under-an-older-key');
    const unsigned = judgeIn(here)(null, ROSTER.kind as never, `${ROSTER.kind}:${ROSTER.id}`, { ...ROSTER, version: 2, digest: digestOf(2) }, false, 1);
    /* RED WHEN: a record that carries no filer's signature is logged under another code. */
    expect(filingRefusalCodeOf(unsigned!)).toBe('no-signature');
    /* RED WHEN: a reason this does not know is given a code it is not. */
    expect(filingRefusalCodeOf('a sentence nothing here says')).toBe('other');
  });

  it('is believed in the very batch that anchored the change, since it was sealed before it', () => {
    const here = aCompany(3, [{ read: ROSTER, version: 2, batch: 3 }]);
    /* RED WHEN: the change of the key counts against records anchored in its own batch. */
    expect(judged(here, ROSTER, 2, 0)).toBeNull();
  });

  it('is refused while waiting to be anchored when a change of the key is already anchored', () => {
    const here = aCompany(2, [{ read: ROSTER, version: 2, batch: null }]);
    /* RED WHEN: a record not yet anchored, sealed under a key older than the newest anchored change, is believed. */
    expect(judged(here, ROSTER, 2, 0)).toMatch(/already in force/u);
    expect(judged(here, ROSTER, 2, 1)).toBeNull();
  });

  /* Proposals listed for the company, each entered in batch 3, after the change of the key anchored in batch 2. */
  const proposal = (id: string, keyEpoch: number) => ({
    id, accountId: ACC, keyEpoch, digest: 'dd'.repeat(32), chainId: 'ee'.repeat(32), createdAt: 'now',
    sealed: { iv: '11'.repeat(12), tag: '22'.repeat(16), body: '33' }, filedBy: { publicKey: ADA.publicKey, signature: '00'.repeat(64) },
  });
  const listing = (proposals: readonly ReturnType<typeof proposal>[], served = proposals) => {
    const here = aCompany(2, []);
    const at: DirectoryHere = {
      ...here,
      records: {
        ...here.records,
        asked: { records: new Set(), kinds: new Set(['proposal:proposal:']) },
        history: new Map(proposals.map((p) => [recordKeyOf({ store: 'proposal', kind: 'proposal', id: p.id }),
          [{ version: 1, digest: proposalEntry(ACC, p as never).digest, filedBy: ADA.publicKey.toLowerCase() as Hex, batch: 3, dirVersion: 3 }]])),
      },
    } as never;
    return () => listedHere(at, 'proposal', served as never, 'proposal');
  };

  it('is left out of a list of proposals, each other one listed, and refused for itself alone, to be raised again', () => {
    const honest = proposal('prop_good', 1);
    const stale = proposal('prop_stale', 0);
    const listed = listing([honest, stale])();
    /* RED WHEN: one proposal sealed under an older key than the one in force at its batch refuses the company's whole list. */
    expect(listed.map((p) => p.id)).toEqual(['prop_good']);
    /* RED WHEN: the proposal left out is not said for itself, or is said to be filed again, which a proposal never is. */
    expect(listed.leftOut.get('prop_stale')).toMatch(/already in force.*raises it again/su);
    expect(listed.leftOut.get('prop_stale')).not.toMatch(/files? it again/u);
    expect(() => refusedForItsKey(listed, 'prop_stale', 'proposal')).toThrow(RecordSealedUnderAnOlderKey);
    expect(refusedForItsKey(listed, 'prop_good', 'proposal')).toBeUndefined();
  });

  it('is refused by name when a device looks for it alone, as the run or the proposal it is, never as one the company does not hold', async () => {
    const stale = proposal('prop_stale', 0);
    const here = (store: 'run' | 'proposal', id: string, digest: Hex) => {
      const base = aCompany(2, []);
      return { ...base, records: { ...base.records, asked: { records: new Set(), kinds: new Set([`${store}:${store}:`]) },
        history: new Map([[recordKeyOf({ store, kind: store, id }), [{ version: 1, digest, filedBy: ADA.publicKey.toLowerCase() as Hex, batch: 3, dirVersion: 3 }]]]) } } as never;
    };
    const run = { id: 'run_stale', accountId: ACC, keyEpoch: 0, proposalIds: ['prop_stale'], sealed: { iv: '11'.repeat(12), tag: '22'.repeat(16), body: '33' },
      filedBy: { publicKey: ADA.publicKey, signature: '00'.repeat(64) }, period: '2030-01', status: 'draft' };
    const runs = { runs: async () => [run], directory: async () => here('run', 'run_stale', runEntry(ACC, run as never, 1).digest) };
    /* RED WHEN: a run looked for alone and left out for its key is said to be one the company's records do not hold. */
    await expect(keptRunHere(runs as never, ACC, 'run_stale', '00'.repeat(32))).rejects.toThrow(RecordSealedUnderAnOlderKey);
    await expect(runRebuiltHere(runs as never, ACC, 'prop_stale', '00'.repeat(32))).rejects.toThrow(RecordSealedUnderAnOlderKey);
    const proposals = { directory: async () => here('proposal', 'prop_stale', proposalEntry(ACC, stale as never).digest) };
    /* RED WHEN: the list of proposals a payment is made from drops what it left out, so the one looked for reads as never held. */
    const listed = await proposalsListedHere({ ...proposals, proposals: async () => [stale], roundsOnChain: async () => ({}) } as never);
    expect(() => refusedForItsKey(listed, 'prop_stale', 'proposal')).toThrow(RecordSealedUnderAnOlderKey);
    /* RED WHEN: a proposal opened to be approved and left out for its key is said to be withdrawn or never held. */
    await expect(openTheRoundHere({ sealedProposals: async () => [stale] } as never, ACC, 'prop_stale', '00'.repeat(32), false, proposals as never))
      .rejects.toThrow(/proposal \(prop_stale\) is not believed.*raises it again/su);
  });

  it('still refuses the whole list for a proposal served as other bytes than the records name', () => {
    const honest = proposal('prop_good', 1);
    const changed = { ...proposal('prop_other', 1), digest: 'ab'.repeat(32) };
    /* RED WHEN: a proposal the service served as other bytes is left out quietly instead of refusing the list. */
    expect(listing([honest, proposal('prop_other', 1)], [honest, changed])).toThrow(/other bytes than the company's records name/u);
  });

  it('is held to it only for a record sealed under the company\'s key, never a spending policy sealed to each reader', async () => {
    const asked: { kind: string; sealedAt: number | undefined }[] = [];
    const judge = Object.assign((_f: unknown, kind: string, _k: string, _r: unknown, _n?: boolean, sealedAt?: number) => {
      asked.push({ kind, sealedAt });
      return null;
    }, {});
    const filed = (kind: string, id: string) => signCompanyFiling({
      company: ACC, kind: kind as never, id, version: 1, keyEpoch: 0, sealed: { iv: '11'.repeat(12) as Hex, tag: '22'.repeat(16) as Hex, body: '33' as Hex },
      wrapped: kind === 'roster' ? [] : [{ signerId: 'ada', ephemeral: '44'.repeat(32) as Hex, iv: '55'.repeat(12) as Hex, tag: '66'.repeat(16) as Hex, body: '77'.repeat(32) as Hex }],
    } as never, ADA.secret);
    const store = new HttpCompanyRecordStore(ACC, async (path) => {
      const kind = path.includes('roster') ? 'roster' : 'spending-policy';
      return { status: 200, body: { kind, id: kind === 'roster' ? 'roster' : 'pol_1', filed: toCompanyWire(filed(kind, kind === 'roster' ? 'roster' : 'pol_1')) } };
    }, ADA.secret, async () => judge as never);
    await store.get('roster', 'roster');
    await store.get('spending-policy' as never, 'pol_1');
    /* RED WHEN: a roster is judged without the epoch it names, or a spending policy's version is held to the key in force. */
    expect(asked).toEqual([{ kind: 'roster', sealedAt: 0 }, { kind: 'spending-policy', sealedAt: undefined }]);
  });
});
