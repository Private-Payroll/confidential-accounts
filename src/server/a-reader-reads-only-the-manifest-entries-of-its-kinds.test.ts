/**
 * **A READER OF A COMPANY SEES ONLY THE MANIFEST ENTRIES OF THE KINDS ITS GRANT READS.** The newest versions entered,
 * the proofs against a root and the entries not yet anchored are served to a reader through the member gate
 * (`memberOrReaderReading`); a reader is refused a name of another kind, and the entries waiting are served to it
 * without those of other kinds. The directory and the records the company was founded with stay readable, because a
 * reader's own wallet proves them to judge the roster. A member's answers do not change. Over real HTTP, on the real
 * manifest routes and a store holding one anchored header.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { MemoryStore } from '../core/store.js';
import { kindsAReaderFetches } from '../midnight/grants-record.js';
import { signManifestEntry, type ManifestEntry, type ManifestEntryBody } from '../midnight/record-manifest.js';
import { DIRECTORY, FOUNDING_RECORDS } from '../midnight/records-held.js';
import { EMPTY_ROOT, GENESIS, nextTreeHeader, provenRefusal, treeKeyOf, type TreeLeaf, type TreeProof } from '../midnight/record-tree.js';
import { tagInATest } from '../testing/record-tree-double.js';
import { recordManifestRoutes } from './record-manifest-route.js';
import { memberOrReaderReading, type AccountWithReaders, type ReadersKept } from './readers-route.js';

const CO = 'acc_reader_manifest';
const SEAT = newSigningKeypair();
const entry = (store: ManifestEntryBody['store'], kind: string, id: string, n: number): ManifestEntry =>
  signManifestEntry(CO, { store, kind, id, version: 1, digest: n.toString(16).padStart(2, '0').repeat(32) }, SEAT.secret);
/* What the header anchors: the directory and the records the company was founded with. */
const ANCHORED = [DIRECTORY, ...FOUNDING_RECORDS].map((r, i) => entry(r.store, r.kind, r.id, i + 1));
/* What waits to be anchored: one record a reader of grants and roster may read, and one of each kind it may not. */
const WAITING = [
  entry('company', 'grants', 'grants', 11), entry('company', 'person', 'emp_waiting', 12),
  entry('run', 'run', 'run_waiting01', 13), entry('proposal', 'proposal', 'prp_waiting01', 14),
];
const PERSON = { store: 'company', kind: 'person', id: 'emp_waiting' } as const;
const RUN = { store: 'run', kind: 'run', id: 'run_waiting01' } as const;
const PROPOSAL = { store: 'proposal', kind: 'proposal', id: 'prp_waiting01' } as const;
/* The remedy a refusal names only when some purpose a reader can be granted reads the kind asked. */
const GRANT_A_PURPOSE = /signers grant a purpose/u;

const store = new MemoryStore();
const READERS: ReadersKept = {
  sequence: 1, userIds: ['abe', 'mia', 'rhea'],
  kinds: { rhea: ['grants', 'roster'], abe: kindsAReaderFetches(['payroll', 'proposals', 'people']), mia: ['grants', 'roster'] },
};
const account = { id: CO, memberUserIds: ['ada', 'mia'], readers: READERS } as AccountWithReaders;
let root: Hex = EMPTY_ROOT;
let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  expect(store.enterInManifest(CO, ANCHORED)).toBeNull();
  const made = nextTreeHeader({
    company: CO, before: GENESIS, entries: ANCHORED, current: new Map(ANCHORED.map((e) => [treeKeyOf(e), null])), proof: { siblings: [] },
    priorChain: () => undefined, held: { approvals: 1, signerRoot: 'ab'.repeat(32) as Hex, signers: ['cd'.repeat(32) as Hex] },
    at: '2026-11-12T00:00:00.000Z', tag: tagInATest(SEAT.secret),
  }, SEAT.secret)!;
  expect(store.fileTreeHeader(CO, made.header, ANCHORED)).toBeNull();
  root = made.header.root;
  expect(store.enterInManifest(CO, WAITING)).toBeNull();
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
  const member = memberOrReaderReading((id, user) => id === CO && account.memberUserIds.includes(user), (id) => (id === CO ? account : null));
  app.use(recordManifestRoutes({
    signedIn, member, store, directoryOf: async () => { throw new Error('not read here'); }, filedAs: async () => null,
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); }); });

/** What the manifest's reads answer, each field present on the read that gives it. */
interface Answer {
  readonly entries?: ManifestEntry[]; readonly records?: (TreeLeaf | null)[]; readonly kinds?: TreeLeaf[][]; readonly proof?: TreeProof;
  readonly versions?: number[]; readonly refused?: string; readonly error?: string;
}
const as = async (person: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Answer }> => {
  const r = await fetch(`${base}/api/accounts/${CO}/manifest${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() as Answer };
};
const pending = async (person: string) => ((await as(person, 'GET', `/tree/pending?root=${root}`)).body.entries ?? []).map((e) => e.kind);
const proofs = (person: string, records: readonly object[], kinds: readonly object[] = []) => as(person, 'POST', '/tree/proofs', { root, records, kinds });
const newest = (person: string, records: readonly object[]) => as(person, 'POST', '/newest', { records });

describe('A READER OF GRANTS AND ROSTER, ASKING THE COMPANY\'S MANIFEST', () => {
  it('is served no waiting entry of a person, a run or a proposal, and is still served the waiting grants', async () => {
    /* RED WHEN: a reader is served the entries waiting of kinds its grant does not read - who is paid and what is proposed, seen. */
    expect(await pending('rhea')).toEqual(['grants']);
  });

  it('is refused proofs of a person record, or of every person record, and told what clears it', async () => {
    /* RED WHEN: a reader is proven a person record's leaf - its digest, version and filer - which its grant does not read. */
    const one = await proofs('rhea', [PERSON]);
    expect(one.status).toBe(403);
    expect(one.body).toMatchObject({ refused: 'not-a-kind-read', error: expect.stringMatching(/grant[\s\S]*signers/u) });
    /* RED WHEN: a reader asking a whole kind is served every leaf of a kind its grant does not read. */
    expect((await proofs('rhea', [], [{ store: 'company', kind: 'person' }])).status).toBe(403);
    expect((await proofs('rhea', [RUN])).status).toBe(403);
    expect((await proofs('rhea', [], [{ store: 'vault', kind: 'pool' }])).status).toBe(403);
    /* RED WHEN: a reader asking every state record is served them because the founding state is readable by name. */
    expect((await proofs('rhea', [], [{ store: 'company', kind: 'state' }])).status).toBe(403);
  });

  it('is told the signers can grant a purpose only for a kind some purpose reads, and otherwise only to ask for its own kinds', async () => {
    /* RED WHEN: a reader refused a person record is not told the signers can grant the purpose that reads it. */
    expect((await proofs('rhea', [PERSON])).body.error).toMatch(GRANT_A_PURPOSE);
    for (const asked of [
      { store: 'vault', kind: 'pool', id: 'ab'.repeat(32) }, { store: 'company', kind: 'state', id: 'state_later' },
      { store: 'run', kind: 'person', id: 'run_waiting01' },
    ]) {
      const refused = (await proofs('rhea', [asked])).body;
      /* RED WHEN: a reader is sent to ask the signers for a grant no purpose gives - a vault record, a later state, a mismatched kind. */
      expect(refused.error).not.toMatch(GRANT_A_PURPOSE);
      expect(refused).toMatchObject({ refused: 'not-a-kind-read', error: expect.stringMatching(/Ask only for the kinds the grant names/u) });
    }
    expect((await proofs('rhea', [], [{ store: 'company', kind: 'state' }])).body.error).not.toMatch(GRANT_A_PURPOSE);
  });

  it('is refused the newest version entered of a person record, a run or a proposal', async () => {
    /* RED WHEN: a reader learns how far a person record, a run or a proposal it may not read has been changed. */
    for (const r of [PERSON, RUN, PROPOSAL]) {
      expect((await newest('rhea', [r])).status).toBe(403);
    }
    expect((await newest('rhea', [{ store: 'company', kind: 'grants', id: 'grants' }])).body).toEqual({ versions: [1] });
  });

  it('is still proven the directory and the records the company was founded with, which its wallet judges the roster by', async () => {
    const asked = [DIRECTORY, ...FOUNDING_RECORDS].map((r) => ({ store: r.store, kind: r.kind, id: r.id }));
    const given = await proofs('rhea', asked, [{ store: 'company', kind: 'grants' }]);
    /* RED WHEN: a reader's own wallet cannot prove the directory or the founding records, so it can never take its read keys. */
    expect(given.status).toBe(200);
    const leaves = given.body.records ?? [];
    expect(leaves.map((l) => l?.kind)).toEqual(asked.map((r) => r.kind));
    expect(provenRefusal(root, {
      records: asked.map((name, i) => ({ name, leaf: leaves[i] ?? null })),
      kinds: [{ kind: { store: 'company', kind: 'grants' }, leaves: given.body.kinds?.[0] ?? [] }],
    }, given.body.proof ?? { siblings: [] })).toBeNull();
  });
});

describe('A READER WHOSE GRANT READS PAYROLL, PROPOSALS AND PEOPLE', () => {
  it('is served its waiting run, proposal and person entries, proven them by name and by kind, and told their newest versions', async () => {
    /* RED WHEN: a payroll, proposals or people reader is cut off from the entries its grant reads, and its device's reads stall. */
    expect((await pending('abe')).sort()).toEqual(['grants', 'person', 'proposal', 'run']);
    const given = await proofs('abe', [PERSON, RUN, PROPOSAL], [{ store: 'run', kind: 'run' }, { store: 'company', kind: 'person' }]);
    /* RED WHEN: such a reader is refused the proofs of a run, a proposal or a person record its grant reads. */
    expect(given.status).toBe(200);
    expect((await newest('abe', [PERSON, RUN, PROPOSAL])).body).toEqual({ versions: [1, 1, 1] });
  });
});

describe('A MEMBER, ASKING THE SAME', () => {
  it('is served everything a member is when the company also names them a reader', async () => {
    /* RED WHEN: a member whom the readers also name is narrowed to the reader's kinds. */
    expect((await pending('mia')).sort()).toEqual(['grants', 'person', 'proposal', 'run']);
    expect((await proofs('mia', [PERSON], [{ store: 'company', kind: 'state' }])).status).toBe(200);
    expect((await newest('mia', [PERSON, RUN])).body).toEqual({ versions: [1, 1] });
  });

  it('is served every waiting entry, every proof and every newest version, as before', async () => {
    /* RED WHEN: the gate for readers narrows what a member of the company is served. */
    expect((await pending('ada')).sort()).toEqual(['grants', 'person', 'proposal', 'run']);
    expect((await proofs('ada', [PERSON], [{ store: 'company', kind: 'person' }, { store: 'company', kind: 'state' }])).status).toBe(200);
    expect((await newest('ada', [PERSON, RUN])).body).toEqual({ versions: [1, 1] });
  });
});
