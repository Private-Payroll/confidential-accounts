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
import { seatDirectoryRoutes, directoryOf, type DirectoryChainRead } from './seat-directory-route.js';
import { companyRecordsRoutes, MemoryCompanyRecordStore } from './company-records-route.js';
import {
  companyRecordKey, directoryChangeMessage, FILING_REFUSAL, type ChainHolders, type DirectoryChange, type DirectoryEntry, type DirectoryFiling,
} from '../midnight/seat-directory.js';
import { signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { HttpCompanyRecordStore, FilingNotBelieved, type FreshJudge, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryJudge, fileTheOwedDirectoryEntry, type OwedDirectoryEntry, type OwedEntryFiled } from 'vaults-web-shared/vault-page-doors.js';

const CO = 'acc_route';
const OTHER = 'acc_other';
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
/** The company's account, as this service records it and every wallet here signs for it. */
const ADDRESS = 'c0'.repeat(32) as never;

interface Seat { person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string } }
const seatOf = (person: string, n: number): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const seat = n.toString(16).padStart(2, '0').repeat(32);
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  return { person, seat, signing, committeeKey, entry: { person, committeeKey, statement: signDirectoryEntry(identity, LABEL, ADDRESS, new Uint8Array(32).fill(n + 100), signing.publicKey, seat) } };
};
const ADA = seatOf('ada', 1);
const BO = seatOf('bo', 2);
const CY = seatOf('cy', 3);
/** Every seat's own records-key statement, signed by its wallet for the key its entry names, as the roster carries it. */
const everySeatAttested = async () => [ADA, BO, CY].map((s, i) => ({
  committeeKey: s.committeeKey,
  statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(i + 1)), LABEL, ADDRESS, new Uint8Array(32).fill(i + 101), s.seat),
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
/** Whether the server's read of the chain fails, as an indexer that is down does. */
let chainDown = false;
/** The server's read of the chain: of the seats asked about, those the test has seated. */
const chainRead: DirectoryChainRead = async (_id, seats) => {
  if (chainDown) throw new Error('indexer down');
  return chain === null ? null : { ...chain, seats: { ...chain.seats, seats: chain.seats.seats.filter((s) => seats.includes(s)) } };
};

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
    chain: chainRead,
  }));
  app.use(companyRecordsRoutes({
    signedIn, member, records, accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, chainRead, id),
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
    expect((await directoryOf(store, chainRead, CO)).dir.seats.find((s) => s.seat === BO.seat)!.role).toBe('approver');
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
    const holders = async () => { reads += 1; const c = seated([ADA, BO]); return { ...c.seats, approvals: c.approvals, adoptedVaults: [], account: ADDRESS }; };
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
    /* RED WHEN: a version is believed from a seat whose own wallet has not attested the records key its entry names. */
    const boUnattested: FreshJudge = directoryJudge({
      accountId: CO, label: LABEL, holders, attested: async () => (await everySeatAttested()).filter((x) => x.statement.seat !== BO.seat),
      filings: async () => store.directoryFilingsOf(CO),
    });
    await expect(new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, boUnattested).get('proposal', 'p3')).rejects.toBeInstanceOf(FilingNotBelieved);
    expect((await new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, judge).get('proposal', 'p3'))!.version).toBe(1);
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

describe('THE SERVER BELIEVES THE DIRECTORY A DEVICE BELIEVES, AGAINST THE CHAIN NOW', () => {
  const reader = newWrappingKeypair();
  const record = (id: string, kind: SealedCompanyRecord['kind'] = 'proposal'): SealedCompanyRecord => {
    const key = newSymmetricKey();
    return {
      company: CO, kind, id, version: 1, keyEpoch: 0,
      sealed: seal(`{"kind":"${kind}"}`, key), wrapped: [{ signerId: reader.publicKey, wrapped: wrapKey(key, reader.publicKey) }],
    };
  };
  const put = (person: string, rec: SealedCompanyRecord, signer: Hex) =>
    sendAs(person)(`/api/accounts/${rec.company}/records/${rec.kind}/${rec.id}/${rec.version}`, {
      method: 'PUT', body: JSON.stringify(toCompanyWire(signCompanyFiling(rec, signer))),
    });
  /** What a device whose wallet reads the chain as the server does now says of a version `seat` filed. */
  const deviceSays = async (seat: Seat, rec: SealedCompanyRecord): Promise<string | null> => {
    const c = chain!;
    const judge = await directoryJudge({
      accountId: CO, label: LABEL, attested: everySeatAttested, filings: async () => store.directoryFilingsOf(CO),
      holders: async () => ({ ...c.seats, approvals: c.approvals, adoptedVaults: [], account: ADDRESS }),
    })();
    return judge(seat.signing.publicKey, rec.kind, companyRecordKey(rec.kind, rec.id), rec.version);
  };
  const before = () => chain;
  let kept: ChainHolders | null = null;
  beforeAll(() => { kept = before(); });
  afterAll(() => { chain = kept; });

  /* RED WHEN: check S does not ask the chain whether the seat's committee key is listed and the seat held now, so the server keeps what no device believes. */
  it('a seat whose committee key the chain no longer lists, or whose seat it no longer holds, files nothing - and no device believes it', async () => {
    const both = [ADA.seat, BO.seat];
    chain = { seats: { committee: [ADA.committeeKey], threshold: 2, seats: both }, approvals: 2 };
    const p = record('t1');
    expect((await put('bo', p, BO.signing.secret)).body).toMatchObject({ refused: 'not-on-the-committee' });
    expect(await deviceSays(BO, p)).toBe(FILING_REFUSAL['not-on-the-committee']);
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: [ADA.seat] }, approvals: 2 };
    expect((await put('bo', p, BO.signing.secret)).body).toMatchObject({ refused: 'seat-not-seated' });
    expect(await deviceSays(BO, p)).toBe(FILING_REFUSAL['seat-not-seated']);
    expect(await records.get(CO, 'proposal', 't1')).toBeNull();
    /* And the seat both still believe files, as both believe it. */
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: both }, approvals: 2 };
    expect((await put('bo', p, BO.signing.secret)).status).toBe(201);
    expect(await deviceSays(BO, p)).toBeNull();
  });

  /* RED WHEN: the server replays the directory without the chain's approvals now, so a role changed under a lower threshold than the account requires today still binds on the server and not on a device. */
  it('a role changed under fewer approvals than the account requires now is not believed, by the server as by a device', async () => {
    const both = [ADA.seat, BO.seat];
    /* Bo was made an approver by two approvals; the account now requires three. */
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: both }, approvals: 3 };
    expect((await directoryOf(store, chainRead, CO)).dir.seats.find((x) => x.seat === BO.seat)!.role).toBeNull();
    const run = record('t2', 'run');
    expect(await deviceSays(BO, run)).toBeNull();
    expect((await put('bo', run, BO.signing.secret)).status).toBe(201);
    /* At two, the change binds again: a run is not an approver's to file, on either side. */
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: both }, approvals: 2 };
    const another = record('t3', 'run');
    expect(await deviceSays(BO, another)).toBe(FILING_REFUSAL['role-may-not-file']);
    expect((await put('bo', another, BO.signing.secret)).body).toMatchObject({ refused: 'role-may-not-file' });
  });

  /* RED WHEN: a record is filed, or a seat believed, when the chain could not be read or shows no account. */
  it('a chain that cannot be read decides nothing, and an account the chain does not show has no seat', async () => {
    chainDown = true;
    try {
      await expect(directoryOf(store, chainRead, CO)).rejects.toThrow(/indexer down/);
      const down = await put('ada', record('t4'), ADA.signing.secret);
      expect([down.status, (down.body as { error: string }).error]).toEqual([503, expect.stringMatching(/could not be decided.*indexer down/)]);
    } finally {
      chainDown = false;
    }
    chain = null;
    const none = await directoryOf(store, chainRead, CO);
    expect([none.dir.seats, none.chain]).toEqual([[], null]);
    expect((await put('ada', record('t4'), ADA.signing.secret)).body).toMatchObject({ refused: 'no-entry' });
    expect(await records.get(CO, 'proposal', 't4')).toBeNull();
  });
});

describe('A SIGNER\'S DIRECTORY ENTRY IS KEPT ON THEIR DEVICE UNTIL THE DIRECTORY TAKES IT, AND FILED THEN WITH NO PRESS', () => {
  /** Cy's device, speaking to the route as the page's `api` does: an answer that is not a success is thrown. */
  const cysApi = async (path: string, init?: RequestInit) => {
    const r = await sendAs('cy')(path, { method: String(init?.method ?? 'GET') as 'GET' | 'PUT', ...(init?.body === undefined ? {} : { body: String(init.body) }) });
    if (r.status >= 300) throw new Error(String((r.body as { error?: unknown }).error ?? r.status));
    return r.body;
  };
  let kept: OwedDirectoryEntry | null = null;
  const owed = { read: () => kept, settle: async () => { kept = null; } };
  let before: ChainHolders | null = null;
  beforeAll(() => { before = chain; });
  afterAll(() => { chain = before; });

  /* RED WHEN: an entry the directory refuses is let go, so it is never filed; or one it takes is kept and filed again; or filing it needs a press. */
  it('a refusal leaves it owed; once the chain lists the seat it is filed and let go', async () => {
    kept = { person: 'cy', company: LABEL, signed: { committeeKey: CY.committeeKey, entry: CY.entry.statement } };
    const filings = store.directoryFilingsOf(CO).length;
    /* Cy is seated and his wallet is not yet on the committee. */
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: [ADA.seat, BO.seat, CY.seat] }, approvals: 2 };
    const notYet: OwedEntryFiled = await fileTheOwedDirectoryEntry(cysApi, CO, owed);
    expect(notYet).toMatchObject({ notYet: expect.stringMatching(/committee/) });
    expect(kept).not.toBeNull();
    expect(store.directoryFilingsOf(CO).length).toBe(filings);
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey, CY.committeeKey], threshold: 2, seats: [ADA.seat, BO.seat, CY.seat] }, approvals: 2 };
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed)).toBe('filed');
    expect(kept).toBeNull();
    expect((await directoryOf(store, chainRead, CO)).dir.seats.find((x) => x.seat === CY.seat)?.person).toBe('cy');
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed)).toBe('nothing-owed');
    /* RED WHEN: an entry already in the directory is filed a second time rather than let go. */
    kept = { person: 'cy', company: LABEL, signed: { committeeKey: CY.committeeKey, entry: CY.entry.statement } };
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed)).toBe('already-there');
    expect(kept).toBeNull();
    expect(store.directoryFilingsOf(CO).length).toBe(filings + 1);
  });
});
