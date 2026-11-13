/**
 * **THE SERVICE KEEPS A COMPANY'S READERS ONLY AS ITS SIGNERS AT THE SEAT BAR SIGNED THEM, AND LETS THEM READ ONLY.**
 * The route counts the signatures of seats the chain holds over the plain list of readers, the change's number and the
 * entries' digest, one key one vote, holds the entries handed in to that digest, and keeps the list apart from the
 * members once they reach the chain's seat bar; the member gate then admits those readers on a read, of a kind of
 * record their grant reads, and on nothing else. Over real HTTP; the directory and the chain the route reads are
 * stand-ins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { connect, type AddressInfo } from 'node:net';
import { newSymmetricKey, sign, signingPublicKeyOf, type Hex } from '../core/crypto.js';
import {
  entriesDigestOf, entriesInOrder, grantEntryOf, kindsAReaderFetches, readersMessage, readersNamedIn, type GrantEntry,
} from '../midnight/grants-record.js';
import type { ReaderRole } from '../core/roles.js';
import type { DirectorySeat } from '../midnight/seat-directory.js';
import { memberOrReaderReading, readersOf, readersRoutes, withoutReaders, type AccountWithReaders } from './readers-route.js';
import type { DirectoryNow } from './seat-directory-route.js';

const CO = 'acc_readers';
const seat = (n: number) => {
  const secret = newSymmetricKey();
  const s: DirectorySeat = { seat: n.toString(16).padStart(64, '0'), person: `s${n}`, signingKey: signingPublicKeyOf(secret).toLowerCase() as Hex, wrappingKey: 'ab'.repeat(32) as Hex, role: null, retired: null };
  return { secret, s };
};
const ADA = seat(1);
const BO = seat(2);
const GONE = seat(3);
let account = { id: CO, memberUserIds: ['ada', 'bo'] } as AccountWithReaders;
const store = { getAccount: (id: string) => (id === CO ? account : null), putAccount: (a: AccountWithReaders) => { account = a; } };
/* The chain holds Ada and Bo at a seat bar of two; the directory also names a seat the chain no longer holds. */
let seatBar = 2;
const directoryOf = async (): Promise<DirectoryNow> => ({
  dir: { company: CO, version: 3, seats: [ADA.s, BO.s, GONE.s] },
  chain: { seats: { committee: [], threshold: 1, seats: [ADA.s.seat, BO.s.seat] }, approvals: 1, seatBar },
});
/* Each reader's entry, with a recipient key of its own; a limited reader by default. */
const ROLES: Readonly<Record<string, ReaderRole>> = { abe: 'accountant' };
const entryOf = (person: string): GrantEntry => grantEntryOf({
  recipient: [...person].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0'), person, role: ROLES[person] ?? 'limited',
});
/* A list as a signer's wallet hands it in: the readers, the entries' digest, the entries, and signatures over the first two. */
const listOf = (sequence: number, persons: readonly string[], by: readonly { secret: Hex }[]) => {
  const granted = entriesInOrder(persons.map(entryOf));
  const readers = readersNamedIn(granted);
  const entries = entriesDigestOf(granted);
  return {
    sequence, readers, entries, granted,
    signatures: by.map((x) => ({ publicKey: signingPublicKeyOf(x.secret).toLowerCase(), signature: sign(readersMessage(CO, sequence, readers, entries), x.secret) })),
  };
};

let base = '';
let server: ReturnType<express.Express['listen']>;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
  const member = memberOrReaderReading((id, user) => store.getAccount(id)?.memberUserIds.includes(user) ?? false, store.getAccount);
  app.use(readersRoutes({ signedIn, member, store, directoryOf }));
  app.get('/api/accounts/:id/records/:kind/:rid/versions', signedIn, member, (_req, res) => { res.json({ read: true }); });
  app.put('/api/accounts/:id/records/:kind/:rid/:version', signedIn, member, (_req, res) => { res.status(201).json({ filed: true }); });
  app.post('/api/accounts/:id/manifest/newest', signedIn, member, (_req, res) => { res.json({ newest: true }); });
  app.get('/api/accounts/:id/invites', signedIn, member, (_req, res) => { res.json([{ name: 'Dana', email: 'dana@acme.co' }]); });
  app.get('/api/accounts/:id/runs', signedIn, member, (_req, res) => { res.json([]); });
  app.get('/api/accounts/:id/proposals', signedIn, member, (_req, res) => { res.json([]); });
  /* Reads served by routers, as the service mounts its route files: one at the root, one under the account's path. */
  const routed = express.Router();
  routed.get('/api/accounts/:id/directory', signedIn, member, (_req, res) => { res.json({ directory: true }); });
  routed.get('/api/accounts/:id/people', signedIn, member, (_req, res) => { res.json([{ name: 'Dana' }]); });
  app.use(routed);
  const underTheAccount = express.Router({ mergeParams: true });
  underTheAccount.get('/tree/headers', signedIn, member, (_req, res) => { res.json({ headers: [] }); });
  underTheAccount.post('/tree/entries', signedIn, member, (_req, res) => { res.status(201).json({ filed: true }); });
  app.use('/api/accounts/:id/manifest', underTheAccount);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
const as = (person: string, method: string, path: string, body?: unknown) => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

/* The status of a request written byte for byte, so its target can be one `fetch` never sends: absolute, or with a `#`. */
const raw = (person: string, method: string, target: string): Promise<number> => new Promise((resolve, reject) => {
  const { port } = server.address() as AddressInfo;
  const socket = connect(port, '127.0.0.1', () => {
    socket.end(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-test-person: ${person}\r\ncontent-length: 0\r\nConnection: close\r\n\r\n`);
  });
  let answer = '';
  socket.on('data', (d) => { answer += d.toString('latin1'); });
  socket.on('end', () => { resolve(Number(/^HTTP\/1\.1 (\d{3})/u.exec(answer)?.[1] ?? 0)); });
  socket.on('error', reject);
});

describe('A COMPANY\'S READERS, AS THE SERVICE KEEPS THEM', () => {
  it('KEEPS A LIST ONLY AT THE SEAT BAR OF HELD SEATS, LETS ITS READERS READ AND NOTHING ELSE, AND NEVER GOES BACK TO AN EARLIER CHANGE', async () => {
    const readers = ['abe', 'rhea'];
    /* RED WHEN: one signer's signature puts a reader in, so one wallet alone could open the company's records to a stranger. */
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(1, readers, [ADA])))
      .toMatchObject({ status: 403, body: { refused: 'below-quorum' } });
    /* RED WHEN: a seat the chain no longer holds counts toward the bar. */
    expect((await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(1, readers, [ADA, GONE]))).status).toBe(403);
    /* RED WHEN: a signature over other readers counts. */
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, { ...listOf(1, readers, []), signatures: listOf(1, ['abe', 'eve'], [ADA, BO]).signatures }))
      .toMatchObject({ status: 422, body: { refused: 'not-signed' } });
    expect((await as('rhea', 'GET', `/api/accounts/${CO}/records/grants/read-grants/versions`)).status).toBe(404);
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(1, readers, [ADA, BO])))
      .toMatchObject({ status: 201, body: { kept: true, sequence: 1 } });
    /* RED WHEN: the readers are kept among the members, where every write route would let them in. */
    expect([account.memberUserIds, readersOf(account)]).toEqual([['ada', 'bo'], readers]);
    /* RED WHEN: the member gate does not admit a reader on a read. */
    expect(await as('rhea', 'GET', `/api/accounts/${CO}/records/grants/read-grants/versions`)).toEqual({ status: 200, body: { read: true } });
    /* RED WHEN: the member gate admits a reader on a write, or a reader may hand in a list of readers. */
    expect((await as('rhea', 'PUT', `/api/accounts/${CO}/records/grants/read-grants/9`, {})).status).toBe(404);
    expect((await as('rhea', 'POST', `/api/accounts/${CO}/readers`, listOf(2, readers, [ADA, BO]))).status).toBe(404);
    expect((await as('eve', 'GET', `/api/accounts/${CO}/records/grants/read-grants/versions`)).status).toBe(404);
    /* The manifest's read that proves a version anchored is a POST a reader may make. */
    expect((await as('rhea', 'POST', `/api/accounts/${CO}/manifest/newest`, {})).status).toBe(200);
    /* RED WHEN: a reader passes the gate on a read that hands names or emails in plain, or on the runs its grant does not read. */
    expect((await as('rhea', 'GET', `/api/accounts/${CO}/invites`)).status).toBe(404);
    expect((await as('rhea', 'GET', `/api/accounts/${CO}/runs`)).status).toBe(404);
    expect((await as('ada', 'GET', `/api/accounts/${CO}/invites`)).status).toBe(200);
    /* RED WHEN: a list of an earlier change, signed when it was in force, is kept again, giving back a reader taken away. */
    const later = ['abe'];
    expect((await as('bo', 'POST', `/api/accounts/${CO}/readers`, listOf(2, later, [ADA, BO]))).status).toBe(201);
    expect(await as('bo', 'POST', `/api/accounts/${CO}/readers`, listOf(1, readers, [ADA, BO])))
      .toMatchObject({ status: 409, body: { refused: 'not-a-later-change' } });
    expect((await as('rhea', 'GET', `/api/accounts/${CO}/records/grants/read-grants/versions`)).status).toBe(404);
  });

  it('JUDGES A READ BY THE PATH IT WAS ROUTED BY, THROUGH A ROUTER AT THE ROOT OR UNDER THE ACCOUNT, WITH OR WITHOUT A QUERY', async () => {
    const readers = ['quill'];
    expect((await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(5, readers, [ADA, BO]))).status).toBe(201);
    /* RED WHEN: the gate does not admit a reader on a read a router at the root serves, or on one whose address carries a query. */
    expect(await as('quill', 'GET', `/api/accounts/${CO}/directory`)).toEqual({ status: 200, body: { directory: true } });
    expect((await as('quill', 'GET', `/api/accounts/${CO}/directory?after=1`)).status).toBe(200);
    /* RED WHEN: the gate judges only the path under a router's mount, so a read under the account's path is refused. */
    expect((await as('quill', 'GET', `/api/accounts/${CO}/manifest/tree/headers?after=0&limit=5`)).status).toBe(200);
    /* RED WHEN: a reader passes the gate, through a router, on a route that hands names in plain or that writes. */
    expect((await as('quill', 'GET', `/api/accounts/${CO}/people`)).status).toBe(404);
    expect((await as('quill', 'POST', `/api/accounts/${CO}/manifest/tree/entries`, {})).status).toBe(404);
    /* RED WHEN: a query that spells a reader's read admits a reader on another route. */
    expect((await as('quill', 'GET', `/api/accounts/${CO}/people?/api/accounts/${CO}/directory`)).status).toBe(404);
    expect((await as('ada', 'GET', `/api/accounts/${CO}/people`)).status).toBe(200);
    expect((await as('ada', 'POST', `/api/accounts/${CO}/manifest/tree/entries`, {})).status).toBe(201);
  });

  it('GIVES A TARGET WRITTEN WITH ITS HOST, OR WITH A #, THE SAME ANSWER AS THE PATH ALONE', async () => {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    /* RED WHEN: a reader is refused a read their grant names because the target names the host or carries a #. */
    expect(await raw('quill', 'GET', `${at}/api/accounts/${CO}/directory`)).toBe(200);
    expect(await raw('quill', 'GET', `/api/accounts/${CO}/directory#f`)).toBe(200);
    expect(await raw('quill', 'GET', `/api/accounts/${CO}/directory`)).toBe(200);
    /* RED WHEN: either form lets a reader past the gate on a route that hands names in plain, or on a write. */
    for (const target of [`${at}/api/accounts/${CO}/people`, `/api/accounts/${CO}/people#f`]) expect(await raw('quill', 'GET', target)).toBe(404);
    for (const target of [`${at}/api/accounts/${CO}/manifest/tree/entries`, `/api/accounts/${CO}/manifest/tree/entries#f`]) {
      expect(await raw('quill', 'POST', target)).toBe(404);
    }
    for (const target of [`${at}/api/accounts/${CO}/records/grants/read-grants/9`, `/api/accounts/${CO}/records/grants/read-grants/9#f`]) {
      expect(await raw('quill', 'PUT', target)).toBe(404);
    }
    /* The same targets admit a member, so a 404 above is the gate and not a route the target missed. */
    expect(await raw('ada', 'GET', `${at}/api/accounts/${CO}/people`)).toBe(200);
    expect(await raw('ada', 'POST', `/api/accounts/${CO}/manifest/tree/entries#f`)).toBe(201);
  });

  it('REFUSES TO COUNT SIGNATURES AGAINST A CHAIN READ WITH NO SEAT BAR, AND KEEPS NOTHING', async () => {
    const readers = ['zed'];
    seatBar = Number.NaN;
    /* RED WHEN: a chain read with no readable bar counts one signature as the bar. */
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(9, readers, [ADA])))
      .toMatchObject({ status: 503 });
    seatBar = 2;
    expect(readersOf(account)).not.toContain('zed');
  });

  it('A LIMITED READER IS REFUSED THE PEOPLE AND THE RUNS, AND AN ACCOUNTANT READS THEM, AS THE SIGNED ENTRIES SAY', async () => {
    expect((await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(11, ['abe', 'rhea'], [ADA, BO]))).status).toBe(201);
    const versions = (kind: string) => `/api/accounts/${CO}/records/${kind}/r1/versions`;
    /* RED WHEN: a limited reader fetches a person record, and learns how many people there are and who has left. */
    expect((await as('rhea', 'GET', versions('person'))).status).toBe(404);
    /* RED WHEN: a reader is refused the grants or the roster, which every reader's wallet reads to open what it is given. */
    for (const kind of ['grants', 'roster', 'spending-policy']) expect((await as('rhea', 'GET', versions(kind))).status).toBe(200);
    /* RED WHEN: a reader fetches a kind of record its grant does not read. */
    for (const kind of ['vault-info', 'state', 'transfer']) expect((await as('rhea', 'GET', versions(kind))).status).toBe(404);
    /* RED WHEN: a limited reader reads the runs, or a reader is refused the proposals its grant reads. */
    expect((await as('rhea', 'GET', `/api/accounts/${CO}/runs`)).status).toBe(404);
    expect((await as('rhea', 'GET', `/api/accounts/${CO}/proposals`)).status).toBe(200);
    /* RED WHEN: an accountant is refused the people or the runs its grant reads. */
    expect((await as('abe', 'GET', versions('person'))).status).toBe(200);
    expect((await as('abe', 'GET', `/api/accounts/${CO}/runs`)).status).toBe(200);
    expect(account.readers?.kinds).toEqual({
      abe: ['grants', 'person', 'policy', 'proposal', 'roster', 'run', 'spending-policy'],
      rhea: ['grants', 'policy', 'proposal', 'roster', 'spending-policy'],
    });
    /* RED WHEN: a reader granted the company's choice of service cannot fetch the policy record it is filed as. */
    expect(kindsAReaderFetches(['company-service'])).toEqual(['grants', 'policy', 'roster']);
  });

  it('KEEPS NOTHING WHEN THE ENTRIES HANDED IN ARE NOT THE ONES THE SIGNATURES NAME', async () => {
    const signedFor = listOf(12, ['abe', 'rhea'], [ADA, BO]);
    const widened = signedFor.granted.map((e) => (e.person === 'rhea' ? { ...e, role: 'accountant' as const, purposes: entryOf('abe').purposes } : e));
    /* RED WHEN: entries other than the signed ones are kept, so a reader's kinds widen with no signer signing it. */
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, { ...signedFor, granted: widened }))
      .toMatchObject({ status: 422, body: { refused: 'not-the-signed-entries' } });
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, { ...signedFor, granted: undefined }))
      .toMatchObject({ status: 400, body: { refused: 'not-a-list' } });
    expect(account.readers?.sequence).toBe(11);
    expect((await as('rhea', 'GET', `/api/accounts/${CO}/runs`)).status).toBe(404);
  });

  it('A LIST KEPT WITHOUT ITS KINDS LETS ITS READERS FETCH NO RECORD UNTIL THE SAME CHANGE IS HANDED IN WITH ITS ENTRIES', async () => {
    account = { ...account, readers: { sequence: 20, userIds: ['rhea'] } };
    const grants = `/api/accounts/${CO}/records/grants/read-grants/versions`;
    expect((await as('rhea', 'GET', grants)).status).toBe(404);
    /* RED WHEN: the same change handed in again is answered as kept, so its readers never gain their kinds. */
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(20, ['rhea'], [ADA, BO]))).toMatchObject({ status: 201, body: { kept: true } });
    expect((await as('rhea', 'GET', grants)).status).toBe(200);
    expect(await as('bo', 'POST', `/api/accounts/${CO}/readers`, listOf(20, ['rhea'], [ADA, BO]))).toMatchObject({ status: 200, body: { kept: true } });
  });

  it('A CHANGE THAT ONLY TAKES READING AWAY COUNTS A SIGNER WHO HAS LEFT, AS EVERY DEVICE DOES; ONE THAT GIVES DOES NOT', async () => {
    expect((await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(30, ['abe', 'rhea'], [ADA, BO]))).status).toBe(201);
    /* RED WHEN: the service keeps an accountant's people and runs that every device's fold holds taken away, because one of its two signers has left. */
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(31, ['rhea'], [ADA, GONE]))).toMatchObject({ status: 201, body: { kept: true } });
    expect((await as('abe', 'GET', `/api/accounts/${CO}/runs`)).status).toBe(404);
    /* RED WHEN: a seat that has left helps give a reader access. */
    expect(await as('ada', 'POST', `/api/accounts/${CO}/readers`, listOf(32, ['abe', 'rhea'], [ADA, GONE]))).toMatchObject({ status: 403, body: { refused: 'below-quorum' } });
    expect(readersOf(account)).toEqual(['rhea']);
  });

  it('SERVES A COMPANY\'S ACCOUNT RECORD WITHOUT THE READERS IT KEEPS OR THE KINDS EACH READS', () => {
    const served = withoutReaders(account);
    /* RED WHEN: the account record a member or a reader is served names the company's readers and what each may read. */
    expect('readers' in served).toBe(false);
    expect(served).toMatchObject({ id: CO, memberUserIds: ['ada', 'bo'] });
    expect(readersOf(account)).toEqual(['rhea']);
  });
});
