/**
 * **A WRITE THROUGH A VIEW IS HELD TO THE WAITING ENTRY ITS READ SAW.** A read of the company's records says, for each record it
 * was asked about, the newest version the service gave as waiting, whether the read believed that entry or set it aside as
 * filed by a seat it does not place. The view keeps that as the version served, so an entry the read saw and set aside does not
 * stop the next write, and one entered after the read does. Run through the view over the real held read, with a waiting
 * entry the directory does not place.
 */
import { describe, expect, it } from 'vitest';
import { type Hex } from '../core/crypto.js';
import { signManifestEntry } from '../midnight/record-manifest.js';
import { CompanyChangedMeanwhile } from 'vaults-web-shared/company-view-probe.js';
import { manifestServiceOf, serviceSource, treeServiceOf } from 'vaults-web-shared/records-source.js';
import { type TreeService } from 'vaults-web-shared/record-entered-here.js';
import { throughAView } from '../testing/anchor-doors-through-a-view.js';
import { aRecordFiledBy, apiAs, CO } from './a-company-of-two-seats.test-support.js';
import { aCompanyWhoseSignersChange, ADA, anchorDoorsOf } from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

const NAMED = { store: 'company' as const, kind: 'policy', id: 'pol_seen_s1' };
const KIND = { store: 'company' as const, kind: 'policy' };
/* A key the company's directory does not place. */
const STRANGER = '77'.repeat(32) as Hex;

/** A view of the company whose service lists a version of `NAMED` waiting, filed by the stranger, and says `entered()` is the newest entered of it. */
const viewWhereTheServiceHoldsAStrangersEntry = (entered: () => number) => {
  const all = treeServiceOf(serviceSource(apiAs(ADA.person), CO));
  const manifest = manifestServiceOf(serviceSource(apiAs(ADA.person), CO));
  const waiting = signManifestEntry(CO, { ...NAMED, version: 1, digest: 'cd'.repeat(32) as Hex }, STRANGER);
  const listing: TreeService = { ...all, pending: async (c, root) => [...((await all.pending(c, root)) ?? []), waiting] };
  const service = { ...manifest, newest: async (c: string, names: Parameters<typeof manifest.newest>[1]) => (await manifest.newest(c, names)).map((v, i) => (names[i]!.id === NAMED.id ? entered() : v)) };
  return throughAView({ ...anchorDoorsOf(ADA), tree: listing, manifest: service as typeof manifest }).view.current();
};

describe('A WRITE THROUGH A VIEW IS HELD TO THE WAITING ENTRY ITS READ SAW', () => {
  it('goes ahead past an entry the read saw and set aside, and stops at one entered after the read', async () => {
    const mine = signManifestEntry(CO, await aRecordFiledBy(ADA, 'pol_own_s2'), ADA.signingSecret as Hex);
    const kept = viewWhereTheServiceHoldsAStrangersEntry(() => 1);
    await kept.held({ kinds: [KIND] });
    const read = await kept.held({ records: [NAMED] });
    /* The read saw version 1 waiting and did not hold it as waiting for a seat it places. */
    expect(read.records.notYetAnchored.map((e) => e.id)).not.toContain(NAMED.id);
    /* RED WHEN: a read does not say the waiting version it saw and set aside, so the entry stops every write that names its record. */
    await expect(kept.write([{ to: 'entries', entries: [mine] }])).resolves.toHaveLength(1);
    let entered = 1;
    const moving = viewWhereTheServiceHoldsAStrangersEntry(() => entered);
    await moving.held({ kinds: [KIND] });
    await moving.held({ records: [NAMED] });
    entered = 2;
    const refused = await moving.write([{ to: 'entries', entries: [mine] }]).catch((e: unknown) => e);
    /* RED WHEN: a version entered after the read is not stopped, because the waiting version the read saw is taken for the newest. */
    expect(refused).toBeInstanceOf(CompanyChangedMeanwhile);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['policy pol_seen_s1']);
  });
});
