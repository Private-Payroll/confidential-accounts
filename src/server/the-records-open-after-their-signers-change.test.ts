/**
 * **THE COMPANY'S RECORDS STILL OPEN AFTER ITS SIGNERS CHANGE.** A batch of the
 * company's records is judged by the directory as it was anchored with that
 * batch: the role each seat held then, and whether it had retired then. So a
 * signer removed from the account, retired from the directory or given another
 * role after it anchored and filed changes nothing about what it anchored, and
 * every device still opens every batch.
 *
 * Over real HTTP with the company's manifest and directory as the service keeps
 * them. The chain is the test's: one head, moved on only by a call naming the
 * head it holds, with the account's own `anchorHeadOf`.
 */
import { describe, expect, it } from 'vitest';
import { sign, type Hex } from '../core/crypto.js';
import type { Role } from '../core/types.js';
import type { ManifestEntryBody } from '../midnight/record-manifest.js';
import { anchoredEntering, anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { directoryChangeMessage, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorServiceFor, anchorTheRecordsHere, recordsHeldHere, seatAsAnchoredHere, type AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import type { RecordsHeld } from '../midnight/records-held.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryWithItsFold, acmeReads, ADA, ADDRESS, apiAs, aRecordFiledBy, BO, chains, CO, heldByMoreThanOneKey, LABEL, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';
import { directoryHere } from 'vaults-web-shared/vault-page-doors.js';

aCompanyOfTwoSeats();

const doorsOf = (s: Seat): AnchorDoors => ({
  accountId: CO,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceFor(apiAs(s.person)),
  tree: treeServiceFor(apiAs(s.person)),
  directory: () => acmeDirectoryWithItsFold(),
  directoryFilings: async () => store.directoryFilingsOf(CO),
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_company, tx) => {
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      acmeChain.move(previous, batch, held, tag);
    },
    sealedProposals: async (company) => store.listProposals(company),
    foundingRecords: anchorServiceFor(apiAs(s.person)).foundingRecords,
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
});
/** A record filed and entered by `s`, as its device does. */
const filed = async (s: Seat, id: string): Promise<ManifestEntryBody> => {
  const entry = await aRecordFiledBy(s, id, s === BO ? 'proposal' : 'policy');
  await s.entered.enter([entry]);
  return entry;
};
/** The next directory version: a change signed by `by` as a quorum of one, the account's approvals. */
const changed = async (
  change: { kind: 'role'; seat: string; role: Role } | { kind: 'retire'; seat: string; filedUpTo: Record<string, number> }, by: Seat,
) => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { ...change, threshold: 1, signatures: [] } as unknown as DirectoryChange;
  const signature = sign(directoryChangeMessage(CO, version, unsigned), by.signingSecret);
  const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: by.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
  const r = await sendAs(by.person)(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};
/** What Ada's device holds now of the three records the seats filed. */
const ASKED = { records: ['prp_filed_by_bo', 'pol_filed_by_ada', 'pol_filed_by_ada_later'].map((id) => ({ store: 'company' as const, kind: id.startsWith('prp') ? 'proposal' : 'policy', id })) };
const heldNow = async () => (await recordsHeldHere(doorsOf(ADA), ASKED)).records;
/** The newest version a read holds of a record, with the digest it holds it at. */
const newestOf = (f: RecordsHeld, key: string) => { const v = f.history.get(key)?.at(-1); return v === undefined ? undefined : { version: v.version, digest: v.digest }; };

describe('A SIGNER REMOVED, RETIRED OR GIVEN ANOTHER ROLE AFTER IT ANCHORED AND FILED', () => {
  it('EVERY BATCH STILL OPENS, AND WHAT EACH ANCHORED IS STILL ANCHORED', async () => {
    const bos = await filed(BO, 'prp_filed_by_bo');
    const adas = await filed(ADA, 'pol_filed_by_ada');
    /* After the batch Ada's seat founded Acme with: Bo, an approver, anchors the next batch; Ada, an admin, the one after. */
    expect((await anchorTheRecordsHere(doorsOf(BO))).anchored).toBeGreaterThan(0);
    const later = await filed(ADA, 'pol_filed_by_ada_later');
    expect((await anchorTheRecordsHere(doorsOf(ADA))).anchored).toBeGreaterThan(0);
    const opensBoth = async (why: string) => {
      const f = await heldNow();
      expect(f.stopped, why).toBeNull();
      expect(f.reached.seq + 1, why).toBe(3);
      expect(newestOf(f, 'company:proposal:prp_filed_by_bo'), why).toEqual({ version: 1, digest: bos.digest });
      expect(newestOf(f, 'company:policy:pol_filed_by_ada'), why).toEqual({ version: 1, digest: adas.digest });
      expect(newestOf(f, 'company:policy:pol_filed_by_ada_later'), why).toEqual({ version: 1, digest: later.digest });
    };
    await opensBoth('before anything changes');

    /* RED WHEN: an entry is judged by its filer's role now - Ada, who filed policies, may now only approve. */
    await changed({ kind: 'role', seat: ADA.seat, role: 'approver' }, ADA);
    await opensBoth('Ada given a role that may not file a policy');

    /* RED WHEN: a batch is judged by the anchoring seat's role now - Bo, who anchored the first batch, may now only view. */
    await changed({ kind: 'role', seat: BO.seat, role: 'viewer' }, ADA);
    await opensBoth('Bo given a role that may not anchor');

    /* RED WHEN: a batch is judged by whether its seat is on the account now - Bo is removed from it. */
    chains.set(CO, { ...chains.get(CO)!, seats: { ...chains.get(CO)!.seats, committee: [ADA.committeeKey], seats: [ADA.seat] } });
    await opensBoth('Bo removed from the account');

    /* RED WHEN: a retired seat's filings are judged by its boundary now - Ada retires naming no last version of anything. */
    await changed({ kind: 'retire', seat: ADA.seat, filedUpTo: {} }, ADA);
    await opensBoth('Ada retired');
  });

  it('A DIRECTORY SERVED WITH OTHER BYTES THAN THE VERSION ANCHORED WITH A BATCH STOPS THE CHECK AT THAT BATCH, AS NOT GIVEN', async () => {
    const served = store.directoryFilingsOf(CO);
    /* The service serves Bo's claim with his role change gone: the directory's version 3 is now another filing. */
    const lying = async () => acmeDirectoryFrom([...served.slice(0, 2), { ...served[3]!, version: 3 }, ...served.slice(3)]);
    /* A device that checks the records from the first header: Acme held by more than one key, none of its runs vouching. */
    const f = (await heldByMoreThanOneKey(() => recordsHeldHere({ ...doorsOf(ADA), directory: lying }, ASKED))).records;
    /*
     * RED WHEN: a batch is judged by a directory whose versions are not the bytes anchored with it: the first batch naming
     * version 3, after Acme's founding batch. The header is honest; the directory it was judged by was not given whole.
     */
    expect(f.stopped).toMatchObject({ stop: 'not-given', seq: 1 });
    /* And a device reading that directory with the company's records checked refuses it outright. */
    await expect(directoryHere({ accountId: CO, label: LABEL, ...acmeReads, filings: async () => [...served.slice(0, 2), { ...served[3]!, version: 3 }, ...served.slice(3)], attested: async () => [] }))
      .rejects.toThrow(/served with other bytes at version 3, which the company's records anchor on chain/u);
  });
});

/** Acme's directory as a device believes it, replayed from these filings rather than the ones the service keeps, before its records are read. */
const acmeDirectoryFrom = (filings: readonly DirectoryFiling[]) =>
  directoryHere({ accountId: CO, label: LABEL, ...acmeReads, anchored: anchoredEntering(CO), filings: async () => filings, attested: async () => [] });

describe('BY THE DIRECTORY AS ANCHORED, A SEAT THAT COULD NOT FILE OR ANCHOR THEN IS NOT BELIEVED', () => {
  /* The directory at the version anchored with a batch: Ada an admin who had retired with policy pol_one at 2 her last, Bo an approver. */
  const ada = '0a'.repeat(32) as Hex;
  const bo = '0b'.repeat(32) as Hex;
  const seat = (s: string, key: Hex, role: Role, retired: Record<string, number> | null) =>
    ({ seat: s, person: s, signingKey: key, wrappingKey: 'ab'.repeat(32), committeeKey: { tag: 'schnorr', value: '7a'.repeat(32) }, role, retired });
  const then = { dir: { company: CO, version: 1, seats: [seat('ada', ada, 'admin', { 'policy:pol_one': 2 }), seat('bo', bo, 'approver', null)] }, digests: ['d1'.repeat(32) as Hex] };
  const here = { at: (v: number) => (v === 1 ? then : null) } as never;
  const asAnchored = { version: 1, digests: new Map([[1, 'd1'.repeat(32) as Hex]]) };
  const entry = (kind: string, id: string, version: number) => ({ store: 'company', kind, id, version, digest: 'ee'.repeat(32) }) as ManifestEntryBody;

  it('A BATCH ANCHORED BY A SEAT ALREADY RETIRED THEN STOPS THE CHECK; ONE BY A SEAT THAT MAY ANCHOR OPENS', () => {
    /* RED WHEN: a seat that had retired when its batch was anchored is believed as its anchor. */
    expect(seatAsAnchoredHere(here, asAnchored, ada)).toBeNull();
    expect(seatAsAnchoredHere(here, asAnchored, bo)).toBe('bo');
  });

  it('AN ENTRY OF A KIND ITS FILER\'S ROLE THEN MAY NOT FILE IS NOT BELIEVED', () => {
    /* RED WHEN: an approver's policy is believed because the key is a seat's - the role it held then files no policy. */
    expect(seatAsAnchoredHere(here, asAnchored, bo, entry('policy', 'pol_two', 1))).toBeNull();
    expect(seatAsAnchoredHere(here, asAnchored, bo, entry('proposal', 'prp_two', 1))).toBe('bo');
  });

  it('A RETIRED SEAT\'S ENTRY PAST THE LAST VERSION ITS RETIREMENT NAMED IS NOT BELIEVED; ONE AT IT IS', () => {
    /* RED WHEN: a retired seat goes on filing a record past the boundary its retirement drew. */
    expect(seatAsAnchoredHere(here, asAnchored, ada, entry('policy', 'pol_one', 3))).toBeNull();
    expect(seatAsAnchoredHere(here, asAnchored, ada, entry('policy', 'pol_one', 2))).toBe('ada');
    /* RED WHEN: a retired seat files a record its retirement named no version of. */
    expect(seatAsAnchoredHere(here, asAnchored, ada, entry('policy', 'pol_three', 1))).toBeNull();
  });
});
