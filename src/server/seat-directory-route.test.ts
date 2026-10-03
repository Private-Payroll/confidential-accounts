/**
 * **THE SEAT DIRECTORY AND A COMPANY'S OWN RECORDS, OVER REAL HTTP.** Both
 * routes are mounted in a throwaway app behind a stand-in for the sign-in and
 * the member gate, over a store holding one company; the chain is a stand-in
 * the test sets. Every entry is signed by a real wallet's committee key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, newSymmetricKey, newWrappingKeypair, seal, sign, wrapKey, type Hex } from '../core/crypto.js';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { seatDirectoryRoutes, directoryOf } from './seat-directory-route.js';
import { companyRecordsRoutes, MemoryCompanyRecordStore } from './company-records-route.js';
import {
  directoryChangeMessage, type ChainHolders, type DirectoryChange, type DirectoryEntry, type DirectoryFiling,
} from '../midnight/seat-directory.js';
import { signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { HttpCompanyRecordStore, FilingNotBelieved, type FreshJudge, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryJudge } from 'vaults-web-shared/vault-page-doors.js';

const CO = 'acc_route';
const OTHER = 'acc_other';
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;

interface Seat { person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string } }
const seatOf = (person: string, n: number): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const seat = n.toString(16).padStart(2, '0').repeat(32);
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  return { person, seat, signing, committeeKey, entry: { person, committeeKey, statement: signDirectoryEntry(identity, LABEL, new Uint8Array(32).fill(n + 100), signing.publicKey, seat) } };
};
const ADA = seatOf('ada', 1);
const BO = seatOf('bo', 2);
const CY = seatOf('cy', 3);
/** Every seat's own records-key statement, signed by its wallet for the key its entry names, as the roster carries it. */
const everySeatAttested = async () => [ADA, BO, CY].map((s, i) => ({
  committeeKey: s.committeeKey,
  statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(i + 1)), LABEL, new Uint8Array(32).fill(i + 101), s.seat),
}));

const accountOf = (id: string, members: string[], keyEpoch = 0): SealedAccount => ({
  id, createdAt: 'now', keyEpoch, threshold: 2, signerCount: 3, memberUserIds: members, pendingSigners: [], wrappedKeys: [],
  inboxPublicKey: '00'.repeat(32), sealedRoster: { iv: '', tag: '', body: '' }, sealedPolicy: { iv: '', tag: '', body: '' },
  companyLabel: LABEL as never, contractAddress: 'c0'.repeat(32),
} as SealedAccount);

let base = '';
let server: ReturnType<express.Express['listen']>;
const store = new MemoryStore();
const records = new MemoryCompanyRecordStore();
/* The chain as the server reads it: the test sets who is seated and the approvals. */
let chain: ChainHolders | null = null;

beforeAll(async () => {
  store.putAccount(accountOf(CO, ['ada', 'bo', 'cy']));
  store.putAccount(accountOf(OTHER, ['eve']));
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
  const member: express.RequestHandler = (req, res, next) => (store.getAccount(String(req.params.id))?.memberUserIds.includes(req.userId!)
    ? next() : res.status(404).json({ error: 'account not found' }));
  app.use(seatDirectoryRoutes({
    signedIn, member, store,
    chain: async (_id, seats) => (chain === null ? null : { ...chain, seats: { ...chain.seats, seats: chain.seats.seats.filter((s) => seats.includes(s)) } }),
  }));
  app.use(companyRecordsRoutes({
    signedIn, member, records, accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, id),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const sendAs = (person: string | null): WireSend => async (path, init) => {
  const r = await fetch(base + path, {
    method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
    headers: { 'content-type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const file = (person: string, filing: DirectoryFiling) =>
  sendAs(person)(`/api/accounts/${filing.company}/directory/${filing.version}`, { method: 'PUT', body: JSON.stringify(filing) });
const claimOf = (s: Seat, version: number, company = CO): DirectoryFiling => ({ company, version, change: { kind: 'claim', entry: s.entry } });
const seated = (seats: Seat[], approvals = 2): ChainHolders => ({
  seats: { committee: seats.map((s) => s.committeeKey), threshold: seats.length, seats: seats.map((s) => s.seat) }, approvals,
});

describe('THE SEAT DIRECTORY ROUTE', () => {
  it('A COMPANY WITH NO ACCOUNT ON THE CHAIN, OR ONE ITS SIGNERS\' COMMITTEE DOES NOT HOLD, IS REFUSED WITH WORDS SAYING TO CREATE A NEW ONE', async () => {
    chain = null;
    const none = await file('ada', claimOf(ADA, 1));
    /* RED WHEN: a seat is entered for a company the chain does not show. */
    expect(none.status).toBe(409);
    expect(String((none.body as { error: string }).error)).toMatch(/Create a new company/);
    chain = { seats: { committee: [{ tag: 'schnorr', value: '77'.repeat(32) }], threshold: 1, seats: [ADA.seat] }, approvals: 2 };
    const temporary = await file('ada', claimOf(ADA, 1));
    /* RED WHEN: an entry is filed while the account is held by a key that is not its signers'. */
    expect([temporary.status, (temporary.body as { refused: string }).refused]).toEqual([422, 'not-on-the-committee']);
    expect(String((temporary.body as { error: string }).error)).toMatch(/create a new company/);
    expect(store.directoryFilingsOf(CO)).toEqual([]);
  });

  it('EACH SEAT FILES ITS OWN ENTRY; ANOTHER\'S ENTRY, A SECOND ONE AND ONE FOR A SEAT NOT SEATED ARE REFUSED', async () => {
    chain = seated([ADA, BO, CY]);
    expect((await file('ada', claimOf(ADA, 1))).status).toBe(201);
    /* RED WHEN: a signed-in person files somebody else's entry. */
    expect((await file('ada', claimOf(BO, 2))).body).toMatchObject({ refused: 'not-your-entry' });
    /* RED WHEN: a seat is entered twice. */
    expect((await file('ada', claimOf(ADA, 2))).body).toMatchObject({ refused: 'seat-taken' });
    /* RED WHEN: a filing at a version already taken is filed. */
    expect((await file('bo', claimOf(BO, 1))).status).toBe(409);
    expect((await file('bo', claimOf(BO, 2))).status).toBe(201);
    /* Cy's key is still on the committee, and his seat is no longer held. */
    chain = { seats: { committee: [ADA, BO, CY].map((x) => x.committeeKey), threshold: 3, seats: [ADA.seat, BO.seat] }, approvals: 2 };
    /* RED WHEN: a seat the account does not hold now is entered. */
    expect((await file('cy', claimOf(CY, 3))).body).toMatchObject({ refused: 'seat-not-seated' });
    /* RED WHEN: somebody who is not a member reaches the directory at all. */
    expect((await sendAs('eve')(`/api/accounts/${CO}/directory`, { method: 'GET' })).status).toBe(404);
    const served = await sendAs('bo')(`/api/accounts/${CO}/directory`, { method: 'GET' });
    expect((served.body as { filings: DirectoryFiling[] }).filings.map((f) => f.version)).toEqual([1, 2]);
  });

  it('A CHANGE BY ONE SEAT WHERE THE CHAIN NEEDS TWO IS REFUSED; BY TWO, IT IS FILED', async () => {
    chain = seated([ADA, BO], 2);
    const change = (signers: Seat[], threshold = 2): DirectoryFiling => {
      const unsigned = { kind: 'role', seat: BO.seat, role: 'approver', threshold, signatures: [] } as DirectoryChange;
      const message = directoryChangeMessage(CO, 3, unsigned);
      return { company: CO, version: 3, change: { ...unsigned, signatures: signers.map((s) => ({ publicKey: s.signing.publicKey, signature: sign(message, s.signing.secret) })) } as DirectoryChange };
    };
    /* RED WHEN: one seat is a quorum where the chain requires two. */
    expect((await file('ada', change([ADA]))).body).toMatchObject({ refused: 'below-quorum' });
    /* RED WHEN: the threshold a change names is taken in place of the chain's. */
    expect((await file('ada', change([ADA], 1))).body).toMatchObject({ refused: 'threshold-not-the-chains' });
    expect((await file('ada', change([ADA, BO]))).status).toBe(201);
    expect(directoryOf(store, CO).seats.find((s) => s.seat === BO.seat)!.role).toBe('approver');
  });
});

describe('A COMPANY\'S OWN RECORDS, FILED BY ITS SEATS (CHECK S)', () => {
  const reader = newWrappingKeypair();
  const record = (over: Partial<SealedCompanyRecord> = {}): SealedCompanyRecord => {
    const key = newSymmetricKey();
    return {
      company: CO, kind: 'proposal', id: 'p1', version: 1, keyEpoch: 0,
      sealed: seal('{"kind":"proposal"}', key), wrapped: [{ signerId: reader.publicKey, wrapped: wrapKey(key, reader.publicKey) }], ...over,
    };
  };
  const put = (person: string, rec: SealedCompanyRecord, signer: Hex) =>
    sendAs(person)(`/api/accounts/${rec.company}/records/${rec.kind}/${rec.id}/${rec.version}`, {
      method: 'PUT', body: JSON.stringify(toCompanyWire(signCompanyFiling(rec, signer))),
    });

  it('A SEAT FILES A KIND ITS ROLE FILES, AT THE NEXT VERSION AND THE CURRENT KEY EPOCH', async () => {
    expect((await put('ada', record(), ADA.signing.secret)).status).toBe(201);
    /* RED WHEN: a version that is not the next is filed. */
    /* RED WHEN: a refusal's reason is carried in a field the page's store does not read, so the person sees no reason. */
    expect((await put('ada', record({ version: 3 }), ADA.signing.secret)).body).toMatchObject({ refused: 'not-the-next-version', error: expect.stringMatching(/next version of this record is 2/) });
    expect((await put('ada', record({ version: 1 }), ADA.signing.secret)).body).toMatchObject({ refused: 'version-already-filed', error: expect.stringMatching(/already filed/) });
    /* RED WHEN: a record sealed under a key epoch the company has not reached is filed. */
    expect((await put('ada', record({ version: 2, keyEpoch: 1 }), ADA.signing.secret)).body).toMatchObject({ refused: 'not-the-current-epoch' });
    /* RED WHEN: a record sealed under a key epoch the company has left is filed. */
    store.putAccount(accountOf(CO, ['ada', 'bo', 'cy'], 2));
    try {
      expect((await put('ada', record({ version: 2, keyEpoch: 1 }), ADA.signing.secret)).body).toMatchObject({ refused: 'not-the-current-epoch' });
    } finally {
      store.putAccount(accountOf(CO, ['ada', 'bo', 'cy']));
    }
  });

  it('REFUSES ANOTHER COMPANY\'S MEMBER, A KEY SIGNED IN ANOTHER\'S SESSION, A ROLE THAT MAY NOT FILE IT, AND A SIGNATURE MOVED TO ANOTHER RECORD', async () => {
    /* RED WHEN: a member of another company files into this one. */
    expect((await put('eve', record({ id: 'p2' }), ADA.signing.secret)).status).toBe(404);
    /* RED WHEN: a filing signed by one person is accepted in another's session. */
    expect((await put('bo', record({ id: 'p2' }), ADA.signing.secret)).body).toMatchObject({ refused: 'no-entry' });
    /* RED WHEN: a role files a kind it may not: Bo is an approver now, and a run is not his to file. */
    expect((await put('bo', record({ kind: 'run', id: 'r1' }), BO.signing.secret)).body).toMatchObject({ refused: 'role-may-not-file' });
    expect((await put('bo', record({ id: 'p3' }), BO.signing.secret)).status).toBe(201);
    /* RED WHEN: the signature does not cover the record's id, so it can be moved onto another. */
    const signed = signCompanyFiling(record({ id: 'p4' }), ADA.signing.secret);
    const moved = { ...signed, id: 'p5' };
    const r = await sendAs('ada')(`/api/accounts/${CO}/records/proposal/p5/1`, { method: 'PUT', body: JSON.stringify(toCompanyWire(moved)) });
    expect(r.body).toMatchObject({ refused: 'not-signed' });
    /* RED WHEN: the signature does not cover the company, the kind, the version or the key epoch, so it can be moved onto another of them. */
    expect(verifiedCompanyFiler(signed)).toBe(ADA.signing.publicKey);
    for (const [what, over] of [['company', { company: OTHER }], ['kind', { kind: 'run' }], ['version', { version: 2 }], ['key epoch', { keyEpoch: 1 }]] as const) {
      expect(verifiedCompanyFiler({ ...signed, ...over } as SealedCompanyRecord), what).toBeNull();
    }
  });

  it('THE DEVICE BELIEVES ONLY A VERSION A SEAT IT BELIEVES FILED, CHECKED AFRESH FOR EVERY READ, AND REFUSES TAMPERED BYTES', async () => {
    let reads = 0;
    const holders = async () => { reads += 1; const c = seated([ADA, BO]); return { ...c.seats, approvals: c.approvals, adoptedVaults: [] }; };
    const judge = directoryJudge({
      accountId: CO, label: LABEL, holders, attested: everySeatAttested,
      filings: async () => store.directoryFilingsOf(CO),
    });
    const device = new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, judge);
    expect((await device.get('proposal', 'p1'))!.version).toBe(1);
    expect((await device.versions('proposal', 'p3')).map((v) => v.version)).toEqual([1]);
    /* RED WHEN: one read's view of who holds the company is kept for the next. */
    expect(reads).toBe(2);
    /* A store that hands back a version filed by nobody the directory names is not believed. */
    await records.put(signCompanyFiling(record({ id: 'p9' }), newSigningKeypair().secret));
    /* RED WHEN: a record a seat did not sign is believed because the server served it. */
    await expect(device.get('proposal', 'p9')).rejects.toBeInstanceOf(FilingNotBelieved);
    /* RED WHEN: a check made without a fresh answer from the wallet believes anything. */
    const noAnswer: FreshJudge = directoryJudge({
      accountId: CO, label: LABEL, holders: async () => { throw new Error('the wallet did not answer'); }, attested: everySeatAttested,
      filings: async () => store.directoryFilingsOf(CO),
    });
    await expect(new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, noAnswer).get('proposal', 'p1')).rejects.toThrow(/could not be checked/);
    /* RED WHEN: bytes changed after filing are believed. */
    const tampered: WireSend = async () => {
      const w = toCompanyWire((await records.get(CO, 'proposal', 'p1'))!);
      return { status: 200, body: { kind: 'proposal', id: 'p1', filed: { ...w, body: w.body.replace('"version":1', '"version":1 ') } } };
    };
    await expect(new HttpCompanyRecordStore(CO, tampered, ADA.signing.secret, judge).get('proposal', 'p1')).rejects.toThrow(/digest/);
  });
});
