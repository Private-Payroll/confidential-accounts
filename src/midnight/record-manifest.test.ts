/**
 * **EVERY FILING IS NAMED BY AN ENTRY ITS FILER SIGNED.** An entry is what a
 * leaf of the company's record tree names, so it is believed signed only for
 * exactly the record, version and bytes its filer signed, for this company; and
 * who held the account as a header was judged is refused when it is not named
 * in the shape the account checks.
 */
import { describe, expect, it } from 'vitest';
import { type Hex } from '../core/crypto.js';
import { batchHoldersShapeRefusal, manifestEntryRefusal, runEntry, signManifestEntry, type BatchHolders, type ManifestEntryBody } from './record-manifest.js';
import type { RunToFile } from '../core/run-filing.js';

const COMPANY = 'acct_one';
const A = '11'.repeat(32);

/** Who held the account as a header was judged. */
const HELD: BatchHolders = { approvals: 1, signerRoot: '0a'.repeat(32) as Hex, signers: ['cd'.repeat(32) as Hex] };

const person = (id: string, version: number, digest: string): ManifestEntryBody =>
  ({ store: 'company', kind: 'person', id, version, digest: digest.repeat(64 / digest.length) });
const entered = (e: ManifestEntryBody, by = A) => signManifestEntry(COMPANY, e, by);

describe('AN ENTRY', () => {
  const e = entered(person('p1', 1, 'a1'));
  it('is believed signed only for exactly what its filer signed, for this company', () => {
    expect(manifestEntryRefusal(COMPANY, e)).toBeNull();
    /* RED WHEN: the signature does not cover the version - a server could renumber a stale version as the newest. */
    expect(manifestEntryRefusal(COMPANY, { ...e, version: 2 })).toMatch(/does not cover exactly this entry/u);
    /* RED WHEN: the signature does not cover the digest - a server could swap in other bytes under the filer's name. */
    expect(manifestEntryRefusal(COMPANY, { ...e, digest: 'b2'.repeat(32) })).toMatch(/does not cover exactly this entry/u);
    /* RED WHEN: the company is not in what is signed - another company's entry could be replayed here. */
    expect(manifestEntryRefusal('acct_two', e)).toMatch(/does not cover exactly this entry/u);
  });
  it('names a record its store keeps, and a proposal only at its one version', () => {
    expect(manifestEntryRefusal(COMPANY, entered({ ...person('p1', 1, 'a1'), kind: 'pool' }))).toMatch(/does not name a record its store keeps/u);
    expect(manifestEntryRefusal(COMPANY, entered({ store: 'vault', kind: 'pool', id: 'ab'.repeat(32), version: 3, digest: 'a1'.repeat(32) }))).toBeNull();
    const proposal = { store: 'proposal' as const, kind: 'proposal', id: 'prp_abcdefghijkl', version: 2, digest: 'a1'.repeat(32) };
    /* RED WHEN: a proposal may be entered at a second version - a filing that is never changed would get a newer one. */
    expect(manifestEntryRefusal(COMPANY, entered(proposal))).toMatch(/only version is one/u);
  });
  it('a run\'s entry is the digest of the run as its seat signed it, whatever the service writes beside it', () => {
    const run = { id: 'run_abcdefghijkl', accountId: COMPANY, period: '2026-09', status: 'draft', keyEpoch: 1, payslips: [],
      sealed: { iv: '00', tag: '00', body: '00' } } as unknown as RunToFile;
    /* RED WHEN: the service's own field is in the digest - every run it keeps would read as other bytes than the anchored ones. */
    expect(runEntry(COMPANY, { ...run, wiring: 'stagenet' } as never, 1)).toEqual(runEntry(COMPANY, run, 1));
    expect(runEntry(COMPANY, { ...run, status: 'proposed' } as RunToFile, 2).digest).not.toBe(runEntry(COMPANY, run, 1).digest);
  });
});

describe('WHO HELD THE ACCOUNT, AS A HEADER NAMES THEM', () => {
  it('is refused when it does not name the approvals, the root of the signers or the leaf in each slot', () => {
    expect(batchHoldersShapeRefusal(HELD)).toBeNull();
    /* RED WHEN: a header naming no holders is read - its directory versions would be counted against nothing the chain checked. */
    expect(batchHoldersShapeRefusal(undefined)).toBe('it does not name who held the account as it was judged');
    expect(batchHoldersShapeRefusal({ ...HELD, approvals: 0 })).toBe('it does not name the approvals the account required');
    expect(batchHoldersShapeRefusal({ ...HELD, signerRoot: 'zz' })).toBe('it does not name the root of the account\'s signers');
    expect(batchHoldersShapeRefusal({ ...HELD, signers: [] })).toBe('it does not name the leaf in each of the account\'s signer slots');
  });
});
