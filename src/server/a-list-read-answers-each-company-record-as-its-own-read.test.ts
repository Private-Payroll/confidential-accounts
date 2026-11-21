/**
 * A list read of a company's records answers each record exactly as reading that record alone does, in the order
 * asked, behind the same sign-in and membership, and holds a reader of the company to the kinds its grant reads on
 * every record it names. Anything it refuses, it refuses whole, before any record is read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { SealedAccount } from '../core/types.js';
import { ROSTER_ID } from '../core/roster-record.js';
import { FOUNDING_KEY_EPOCH, stateRecordId } from '../core/founding-state.js';
import { companyRecordsRoutes, MemoryCompanyRecordStore } from './company-records-route.js';
import { memberOrReaderReading, type AccountWithReaders } from './readers-route.js';
import { READ_AT_ONCE } from './read-at-once.js';
import type { CompanyRecordKind, CompanyRecordStore, SealedCompanyRecord } from '../midnight/sealed-record-wire.js';

const CO = 'acc_list';
const OTHER = 'acc_list_other';

/* A version as a seat's device files it: sealed bytes this service cannot open, no reader wrapped. */
const version = (company: string, kind: CompanyRecordKind, id: string, v: number): SealedCompanyRecord => ({
  company, kind, id, version: v, keyEpoch: 0, sealed: { iv: '0a'.repeat(12), tag: '', body: '0b'.repeat(v) }, wrapped: [],
});

const accountOf = (id: string, members: string[], readers?: AccountWithReaders['readers']): AccountWithReaders => ({
  id, createdAt: 'now', keyEpoch: 0, threshold: 1, signerCount: 1, memberUserIds: members, pendingSigners: [], wrappedKeys: [],
  inboxPublicKey: '00'.repeat(32), sealedRoster: { iv: '', tag: '', body: '' }, sealedPolicy: { iv: '', tag: '', body: '' },
  ...(readers === undefined ? {} : { readers }),
} as SealedAccount as AccountWithReaders);

const accounts = new Map<string, AccountWithReaders>([
  /* Rita reads the company under a grant of its runs; the roster and the grants every reader reads. */
  [CO, accountOf(CO, ['ada'], { sequence: 1, userIds: ['rita'], kinds: { rita: ['grants', 'roster', 'run'] } })],
  [OTHER, accountOf(OTHER, ['bob'])],
]);

const kept = new MemoryCompanyRecordStore();
/* How many records were read, so a refusal can be shown to read nothing. */
let reads = 0;
const counted: CompanyRecordStore = {
  get: async (c, k, i) => { reads += 1; return kept.get(c, k, i); },
  versions: async (c, k, i) => { reads += 1; return kept.versions(c, k, i); },
  at: async (c, k, i, v) => { reads += 1; return kept.at(c, k, i, v); },
  put: (rec) => kept.put(rec),
};

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  for (const rec of [
    version(CO, 'policy', 'p1', 1), version(CO, 'policy', 'p1', 2), version(CO, 'run', 'r1', 1),
    version(CO, 'vendor', 'v1', 1), version(CO, 'vendor', 'v1', 2), version(CO, 'vendor', 'v1', 3), version(OTHER, 'run', 'r1', 1),
  ]) await kept.put(rec);
  const app = express();
  /* The stand-in for the sign-in: the person is whoever the header names, and nobody without it. */
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
  /* The service's own membership gate, which lets a company's readers through on the reads their grant needs. */
  const member = memberOrReaderReading((id, user) => accounts.get(id)?.memberUserIds.includes(user) ?? false, (id) => accounts.get(id) ?? null);
  app.use(companyRecordsRoutes({
    signedIn, member, records: counted, accountOf: (id) => accounts.get(id) ?? null,
    directoryOf: async () => { throw new Error('a read asks nothing of the directory'); },
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const as = async (person: string | null, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
const readList = (person: string | null, records: unknown[], company = CO) => as(person, `/api/accounts/${company}/records/read`, { records });

describe('a list read of the company\'s records', () => {
  it('answers each of three records exactly as reading that record alone answers it, in the order asked', async () => {
    /* RED WHEN: a record in the list is answered other than as its own read answers it, or the answers come in another order. */
    const asked = [{ kind: 'vendor', id: 'v1' }, { kind: 'policy', id: 'p1' }, { kind: 'run', id: 'r1' }];
    const alone = await Promise.all(asked.map(async (r) => (await as('ada', `/api/accounts/${CO}/records/${r.kind}/${r.id}`)).body));
    const listed = await readList('ada', asked);
    expect(listed.status).toBe(200);
    expect(listed.body.records).toEqual(alone);
    expect((alone[0] as { filed: { version: number } }).filed.version).toBe(3);
  });

  it('answers every version of a record, when asked for every one, exactly as reading its versions alone answers them', async () => {
    /* RED WHEN: a record asked for with every version is answered with its newest only, or with versions its own read does not answer. */
    const versions = (await as('ada', `/api/accounts/${CO}/records/vendor/v1/versions`)).body;
    const newest = (await as('ada', `/api/accounts/${CO}/records/policy/p1`)).body;
    const listed = await readList('ada', [{ kind: 'vendor', id: 'v1', every: true }, { kind: 'policy', id: 'p1', every: false }]);
    expect(listed.status).toBe(200);
    expect(listed.body.records).toEqual([versions, newest]);
    expect((versions as { versions: unknown[] }).versions).toHaveLength(3);
  });

  it('answers a record never filed in its place as its own read answers it, and still reads the rest', async () => {
    /* RED WHEN: a record never filed fails the whole list, or is answered other than as its own read answers it. */
    const missing = (await as('ada', `/api/accounts/${CO}/records/vendor/nobody`)).body;
    const missingEvery = (await as('ada', `/api/accounts/${CO}/records/vendor/nobody/versions`)).body;
    const listed = await readList('ada', [{ kind: 'run', id: 'r1' }, { kind: 'vendor', id: 'nobody' }, { kind: 'vendor', id: 'nobody', every: true }]);
    expect(listed.status).toBe(200);
    expect(missing).toEqual({ kind: 'vendor', id: 'nobody', filed: null });
    expect((listed.body.records as unknown[]).slice(1)).toEqual([missing, missingEvery]);
  });

  it('refuses a list of more records than one read holds, or of none, whole, and reads nothing', async () => {
    /* RED WHEN: a list longer than the bound, or an empty one, is read rather than refused before any record is read. */
    reads = 0;
    const tooMany = await readList('ada', Array.from({ length: READ_AT_ONCE + 1 }, (_, i) => ({ kind: 'run', id: `r${i}` })));
    const none = await readList('ada', []);
    expect(tooMany.status).toBe(400);
    expect(none.status).toBe(400);
    expect(reads).toBe(0);
    expect(READ_AT_ONCE).toBe(256);
    const most = await readList('ada', Array.from({ length: READ_AT_ONCE }, (_, i) => ({ kind: 'run', id: `r${i}` })));
    expect(most.status).toBe(200);
  });

  it('refuses a list naming a record that is not one the company keeps, whole, and reads nothing', async () => {
    /* RED WHEN: a list with one entry of a kind the company does not keep is read in part rather than refused. */
    reads = 0;
    const listed = await readList('ada', [{ kind: 'run', id: 'r1' }, { kind: 'not-a-kind', id: 'x' }]);
    expect(listed.status).toBe(400);
    expect(reads).toBe(0);
  });

  it('serves nobody signed out, and a person who is not the company\'s member nothing', async () => {
    /* RED WHEN: someone signed out, or a member of another company only, is served this company's records. */
    reads = 0;
    expect((await readList(null, [{ kind: 'run', id: 'r1' }])).status).toBe(401);
    expect((await readList('bob', [{ kind: 'run', id: 'r1' }])).status).toBe(404);
    expect(reads).toBe(0);
  });

  it('serves a reader of the company only the kinds its grant reads, and refuses a list with one record beyond them whole', async () => {
    /* RED WHEN: a reader is served a record of a kind its grant does not read, or a list with one is read in part. */
    const runs = await readList('rita', [{ kind: 'run', id: 'r1' }, { kind: 'roster', id: ROSTER_ID, every: true }]);
    expect(runs.status).toBe(200);
    reads = 0;
    const beyond = await readList('rita', [{ kind: 'run', id: 'r1' }, { kind: 'policy', id: 'p1' }]);
    expect(beyond.status).toBe(403);
    expect(beyond.body.refused).toBe('not-a-kind-read');
    expect(reads).toBe(0);
  });

  it('refuses a reader the company\'s founding state, which reading that record alone refuses it too', async () => {
    /* RED WHEN: the list serves a reader a record its own read would refuse that reader. */
    const founding = stateRecordId(FOUNDING_KEY_EPOCH);
    expect((await as('rita', `/api/accounts/${CO}/records/state/${founding}`)).status).toBe(404);
    reads = 0;
    expect((await readList('rita', [{ kind: 'state', id: founding }])).status).toBe(403);
    expect(reads).toBe(0);
  });
});
