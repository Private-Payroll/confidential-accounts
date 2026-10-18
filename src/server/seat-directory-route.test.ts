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
import { signDirectoryEntry, signRecordsKey, type DirectoryEntryStatement } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, newSymmetricKey, newWrappingKeypair, randomBytes, seal, sign, toHex, wrapKey, type Hex } from '../core/crypto.js';
import { keyCheckOf, sealedPrevious, sealedSeed, wrapsFor } from '../core/company-key.js';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { seatDirectoryRoutes, directoryOf, type DirectoryChainRead } from './seat-directory-route.js';
import { companyRecordsRoutes, MemoryCompanyRecordStore } from './company-records-route.js';
import {
  asAMember, believedDirectory, companyRecordKey, directoryChangeMessage, directoryEntryMade, FILING_REFUSAL, proofsOpenedWith,
  type ChainHolders, type DirectoryChange, type DirectoryEntry, type DirectoryFiling,
} from '../midnight/seat-directory.js';
import { signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { heldFiledBy } from '../testing/record-tree-double.js';
import { HttpCompanyRecordStore, FilingNotBelieved, RecordWithheld, type FreshJudge, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryJudge, fileTheOwedDirectoryEntry, type DirectoryBelieved, type OwedDirectoryEntry, type OwedEntryFiled } from 'vaults-web-shared/vault-page-doors.js';
import { leafOfTheContract, leavesOfTheContract, seatOpenedFor } from '../testing/directory-seats.js';
import { openSeatProof, type SeatOpening } from '../core/seat-opening.js';
import { invitationIdOf, newInvitationToken, signSeatInvitation } from '../core/invitation.js';

const CO = 'acc_route';
const OTHER = 'acc_other';
/** A company where a member enters a seat that is not theirs first. */
const SQUAT = 'acc_squat';
/** A company made with no account on the chain. */
const NONE = 'acc_none';
/** The company's viewing key: every member's device holds it, and the server never does. */
const VIEWING = '5e'.repeat(32) as Hex;
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
/** The company's account, as this service records it and every wallet here signs for it. */
const ADDRESS = 'c0'.repeat(32) as never;

interface Seat {
  person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string };
  opening: SeatOpening; statement: DirectoryEntryStatement;
}
/** `person`'s seat; every seat but the founding one carries the invitation the seat `invitedBy` signed for its person. */
const seatOf = (person: string, n: number, invitedBy?: { signing: { secret: Hex } }): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  /* The seat as a seating device makes it: its leaf commits to this wallet key, and its opening shows that. */
  const { seat, opening } = seatOpenedFor(committeeKey, n);
  const statement = signDirectoryEntry(identity, LABEL, ADDRESS, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  return {
    person, seat, signing, committeeKey, opening, statement,
    entry: directoryEntryMade({
      company: CO, person, committeeKey, signed: statement, opening, signingSecret: signing.secret, viewingKey: VIEWING,
      ...(invitedBy === undefined ? {} : { invited: signSeatInvitation({
        company: CO, invitation: invitationIdOf(newInvitationToken()), person, name: person, role: 'admin', leaf: seat as Hex,
      }, invitedBy.signing.secret) }),
    }),
  };
};
const ADA = seatOf('ada', 1);
const BO = seatOf('bo', 2, ADA);
const CY = seatOf('cy', 3, ADA);
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
/** Every version of the proposals the device reads here, entered by the seat that filed it: nothing anchored yet, each judged by the directory the device reads. */
const filedHere = async (directory: DirectoryBelieved) => heldFiledBy(CO, (await Promise.all(['p1', 'p3', 'p4', 'p9'].map((id) => records.versions(CO, 'proposal', id)))).flat(),
  [ADA, BO, CY].map((s) => s.signing.secret), undefined, directory);
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
  store.putAccount(accountOf(SQUAT, ['ada', 'mal']));
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
/* The account holding `seats`; its committee - the super admins - is the first seat's key alone. */
const seated = (seats: Seat[], approvals = 2, seatBar = approvals): ChainHolders => ({
  seats: { committee: [seats[0]!.committeeKey], threshold: 1, seats: seats.map((s) => s.seat) }, approvals, seatBar,
});

describe('THE SEAT DIRECTORY ROUTE', () => {
  it('A COMPANY WHOSE ACCOUNT THE CHAIN DOES NOT SHOW NOW IS TOLD TO TRY AGAIN; ONE WITH NO ACCOUNT AT ALL, TO CREATE A NEW ONE', async () => {
    chain = null;
    const none = await file('ada', claimOf(ADA, 1));
    /* RED WHEN: a seat is entered for a company the chain does not show. */
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ refused: 'no-account' });
    /* RED WHEN: a person whose account the chain could not be read for just now is told to throw the company away. */
    expect(String((none.body as { error: string }).error)).toMatch(/Try again in a minute/);
    expect(String((none.body as { error: string }).error)).not.toMatch(/Create a new company/);
    expect(store.directoryFilingsOf(CO)).toEqual([]);
    store.putAccount({ ...accountOf(NONE, ['ada']), contractAddress: null } as SealedAccount);
    const noAddress = await file('ada', claimOf(ADA, 1, NONE));
    /* RED WHEN: a company with no account address is not told to create a new company. */
    expect(noAddress.body).toMatchObject({ refused: 'no-account', error: expect.stringMatching(/has no account on the chain.*Create a new company/) });
  });

  it('THE SERVER KEEPS EVERY CLAIM ON A SEAT WITHOUT OPENING ONE: A SQUATTER FILED FIRST KEEPS NOBODY OUT, AND A MEMBER\'S DEVICE BELIEVES THE TRUE HOLDER', async () => {
    /* Mal's key is the account's committee; Mal, a member, enters Ada's seat with her own wallet and filing key and Ada's opening. */
    const MAL = seatOf('mal', 7);
    chain = { seats: { committee: [MAL.committeeKey], threshold: 1, seats: [ADA.seat] }, approvals: 2, seatBar: 2 };
    const malsWallet = identityFromSecret(new Uint8Array(32).fill(7));
    const forAdasSeat = directoryEntryMade({
      company: SQUAT, person: 'mal', committeeKey: MAL.committeeKey, opening: ADA.opening, signingSecret: MAL.signing.secret, viewingKey: VIEWING,
      signed: signDirectoryEntry(malsWallet, LABEL, ADDRESS, new Uint8Array(32).fill(107), MAL.signing.publicKey, ADA.seat),
    });
    const squatted = await file('mal', { company: SQUAT, version: 1, change: { kind: 'claim', entry: forAdasSeat } });
    /* RED WHEN: the server judges an entry's wallet key - it would need the proof opened, which it never holds the key for. */
    expect(squatted.status).toBe(201);
    const adas = directoryEntryMade({ company: SQUAT, person: 'ada', committeeKey: ADA.committeeKey, signed: ADA.statement, opening: ADA.opening, signingSecret: ADA.signing.secret, viewingKey: VIEWING });
    /* RED WHEN: the server refuses the true holder's claim because another claim on the seat came first. */
    expect((await file('ada', { company: SQUAT, version: 2, change: { kind: 'claim', entry: adas } })).status).toBe(201);
    /* RED WHEN: a member's device believes the squatter, or does not believe the true holder filed after it. */
    const member = asAMember(proofsOpenedWith(SQUAT, [VIEWING]), leafOfTheContract, ADA.seat);
    expect(believedDirectory(SQUAT, store.directoryFilingsOf(SQUAT), LABEL, ADDRESS, member).seats.map((x) => [x.seat, x.person])).toEqual([[ADA.seat, 'ada']]);
  });

  it('EACH SEAT FILES ITS OWN ENTRY; ANOTHER\'S ENTRY AND ONE FOR A SEAT NOT SEATED ARE REFUSED', async () => {
    chain = seated([ADA, BO, CY]);
    expect((await file('ada', claimOf(ADA, 1))).status).toBe(201);
    /* RED WHEN: a signed-in person files somebody else's entry. */
    expect((await file('ada', claimOf(BO, 2))).body).toMatchObject({ refused: 'not-your-entry' });
    /* RED WHEN: a filing at a version already taken is filed. */
    expect((await file('bo', claimOf(BO, 1))).status).toBe(409);
    /* RED WHEN: a signer whose wallet key is not on the committee is refused: Bo's is on none. */
    expect((await file('bo', claimOf(BO, 2))).status).toBe(201);
    /* Cy's key is on the committee, and his seat is no longer held. */
    chain = { seats: { committee: [ADA, BO, CY].map((x) => x.committeeKey), threshold: 3, seats: [ADA.seat, BO.seat] }, approvals: 2, seatBar: 2 };
    /* RED WHEN: a seat the account does not hold now is entered. */
    expect((await file('cy', claimOf(CY, 3))).body).toMatchObject({ refused: 'seat-not-seated' });
    /* RED WHEN: somebody who is not a member reaches the directory at all. */
    expect((await sendAs('eve')(`/api/accounts/${CO}/directory`, { method: 'GET' })).status).toBe(404);
    const served = await sendAs('bo')(`/api/accounts/${CO}/directory`, { method: 'GET' });
    expect((served.body as { filings: DirectoryFiling[] }).filings.map((f) => f.version)).toEqual([1, 2]);
  });

  it('THE SERVER FILES A CHANGE AT THE CHAIN\'S THRESHOLD WITHOUT COUNTING ITS SIGNERS; A MEMBER\'S DEVICE BELIEVES IT ONLY WHEN ENOUGH SEATS SIGNED', async () => {
    chain = seated([ADA, BO], 2);
    const change = (version: number, role: 'approver' | 'viewer', signers: Seat[], threshold = 2): DirectoryFiling => {
      const unsigned = { kind: 'role', seat: BO.seat, role, threshold, signatures: [] } as DirectoryChange;
      const message = directoryChangeMessage(CO, version, unsigned);
      return { company: CO, version, change: { ...unsigned, signatures: signers.map((s) => ({ publicKey: s.signing.publicKey, signature: sign(message, s.signing.secret) })) } as DirectoryChange };
    };
    /* RED WHEN: the threshold a change names is taken in place of the chain's. */
    expect((await file('ada', change(3, 'approver', [ADA], 1))).body).toMatchObject({ refused: 'threshold-not-the-chains' });
    expect((await file('ada', change(3, 'approver', [ADA, BO]))).status).toBe(201);
    /* RED WHEN: the server counts a quorum: one seat's change where the chain requires two is refused there. */
    expect((await file('ada', change(4, 'viewer', [ADA]))).status).toBe(201);
    const member = asAMember(proofsOpenedWith(CO, [VIEWING]), leafOfTheContract, ADA.seat);
    const now = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat], committee: [ADA.committeeKey] };
    /* RED WHEN: a member's device believes one seat's change where the chain requires two. */
    expect(believedDirectory(CO, store.directoryFilingsOf(CO), LABEL, ADDRESS, member, now).seats.find((s) => s.seat === BO.seat)!.role).toBe('approver');
  });

  it('THE SERVER FILES A ROLE CHANGE ONLY AT LEAST AT THE SEAT BAR ITS OWN READ OF THE CHAIN GIVES, ABOVE THE THRESHOLD WHERE A POLICY BAR IS STORED', async () => {
    /* One approval is the account's threshold; the policy bar it stores makes a change of who is seated need two. */
    chain = seated([ADA, BO], 1, 2);
    const version = store.directoryFilingsOf(CO).length + 1;
    /* Bo made an approver again, which he already is: nothing a later case reads changes. */
    const roleChange = (threshold: number, signers: Seat[]): DirectoryFiling => {
      const unsigned = { kind: 'role', seat: BO.seat, role: 'approver', threshold, signatures: [] } as DirectoryChange;
      const message = directoryChangeMessage(CO, version, unsigned);
      return { company: CO, version, change: { ...unsigned, signatures: signers.map((s) => ({ publicKey: s.signing.publicKey, signature: sign(message, s.signing.secret) })) } as DirectoryChange };
    };
    /* RED WHEN: the server files a role change signed at the account's threshold, below the seat bar its own read of the chain gives. */
    expect((await file('ada', roleChange(1, [ADA]))).body).toMatchObject({ refused: 'threshold-not-the-chains' });
    expect((await file('ada', roleChange(2, [ADA, BO]))).status).toBe(201);
  });

  it('THE SERVER FILES A RETIREMENT WITH NO STATEMENT, OR WITH ONE IN ITS SHAPE FOR THE LEAVING SEAT, AND JUDGES NOT WHOSE WALLET SIGNED IT', async () => {
    /* Companies of their own, so no other case reads their directory. */
    const LEAVER = 'acc_leaver';
    const NONE_HELD = 'acc_leaver_none';
    store.putAccount(accountOf(LEAVER, ['ada', 'bo']));
    store.putAccount(accountOf(NONE_HELD, ['ada', 'bo']));
    chain = seated([ADA, BO], 1);
    const retirement = (statement: unknown, company = LEAVER): DirectoryFiling => {
      const unsigned = { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1, ...(statement === undefined ? {} : { statement }), signatures: [] } as unknown as DirectoryChange;
      const message = directoryChangeMessage(company, 1, unsigned);
      return { company, version: 1, change: { ...unsigned, signatures: [{ publicKey: ADA.signing.publicKey, signature: sign(message, ADA.signing.secret) }] } as DirectoryChange };
    };
    const signedBy = (n: number, seat: string) => signRecordsKey(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, ADDRESS, new Uint8Array(32).fill(n + 100), seat);
    /* RED WHEN: the server refuses a retirement for a leaving seat no roster holds a statement for, so that signer can never be removed. */
    expect((await file('ada', retirement(undefined, NONE_HELD))).status).toBe(201);
    /* RED WHEN: the server files a retirement whose statement is for another seat, or not in its shape. */
    expect((await file('ada', retirement(signedBy(1, ADA.seat)))).body).toMatchObject({ refused: 'statement-not-the-leavers' });
    expect((await file('ada', retirement({ ...signedBy(2, BO.seat), signature: 'zz' }))).body).toMatchObject({ refused: 'statement-not-the-leavers' });
    /* The control: the server holds no wallet key, so a statement in its shape is filed whoever signed it, and each member's device judges that. */
    expect((await file('ada', retirement(signedBy(1, BO.seat)))).status).toBe(201);
  });

  it('THE SERVER KEEPS A CHANGE OF THE COMPANY\'S KEY IN ITS SHAPE, SIGNED BY ONE SEAT THE CHAIN HOLDS, AT THE NEXT VERSION, AND JUDGES NO EPOCH', async () => {
    /* A company of its own, so no other case reads its directory. */
    const ROT = 'acc_rotate';
    store.putAccount(accountOf(ROT, ['ada', 'bo', 'mal']));
    chain = seated([ADA, BO], 1);
    const entryIn = (s: Seat) => directoryEntryMade({
      company: ROT, person: s.person, committeeKey: s.committeeKey, signed: s.statement, opening: s.opening, signingSecret: s.signing.secret, viewingKey: VIEWING,
    });
    expect((await file('ada', { company: ROT, version: 1, change: { kind: 'claim', entry: entryIn(ADA) } })).status).toBe(201);
    expect((await file('bo', { company: ROT, version: 2, change: { kind: 'claim', entry: entryIn(BO) } })).status).toBe(201);
    const key = newSymmetricKey();
    /* An epoch and a retirement no device would believe: the server judges neither. */
    const rotate = (by: Seat[], over: object = {}, signedFor = 3): DirectoryFiling => {
      const unsigned = {
        kind: 'rotate', epoch: 7, keyCheck: keyCheckOf(ROT, 7, key), after: 1,
        wraps: wrapsFor(key, [ADA, BO].map((s) => ({ seat: s.seat, wrappingKey: s.statement.wrappingKey as Hex }))),
        previous: sealedPrevious(key, VIEWING), seed: { epoch: 7, sealed: sealedSeed(key, toHex(randomBytes(32))) }, waiting: [],
        ...over, signatures: [],
      } as unknown as DirectoryChange;
      const message = directoryChangeMessage(ROT, signedFor, unsigned);
      return { company: ROT, version: 3, change: { ...unsigned, signatures: by.map((s) => ({ publicKey: s.signing.publicKey, signature: sign(message, s.signing.secret) })) } as DirectoryChange };
    };
    /* RED WHEN: the server keeps a change of key whose signature is over another version. */
    expect((await file('ada', rotate([ADA], {}, 4))).body).toMatchObject({ refused: 'not-signed' });
    /* RED WHEN: the server keeps a change of key not in its shape, or signed by more than its one filer. */
    expect((await file('ada', rotate([ADA], { keyCheck: 'zz' }))).body).toMatchObject({ refused: 'not-a-change' });
    expect((await file('ada', rotate([ADA, BO]))).body).toMatchObject({ refused: 'not-a-change' });
    /* RED WHEN: the server keeps a change of key signed by a key that holds no entry, or by a seat the chain no longer holds. */
    expect((await file('mal', rotate([seatOf('mal', 7)]))).body).toMatchObject({ refused: 'filer-not-seated' });
    chain = seated([ADA], 1);
    expect((await file('bo', rotate([BO]))).body).toMatchObject({ refused: 'filer-not-seated' });
    chain = seated([ADA, BO], 1);
    /* RED WHEN: the server has no branch for a change of key, or judges its epoch or the retirement it follows. */
    const kept = await file('bo', rotate([BO]));
    expect(kept.status).toBe(201);
    expect(store.directoryFilingsOf(ROT).map((f) => f.change.kind)).toEqual(['claim', 'claim', 'rotate']);
    /* RED WHEN: a change of key is filed again under the signatures of an earlier version. */
    const again = { ...rotate([ADA]), version: 4, signedAt: 3 };
    expect((await file('ada', again)).body).toMatchObject({ refused: 'not-a-change' });
  });
});

describe('A COMPANY\'S OWN RECORDS, FILED BY ITS SEATS', () => {
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

  it('A SEAT FILES A RECORD AT THE NEXT VERSION, AND THE SERVER JUDGES NO KEY EPOCH', async () => {
    expect((await put('ada', record(), ADA.signing.secret)).status).toBe(201);
    /* RED WHEN: a version that is not the next is filed. */
    /* RED WHEN: a refusal's reason is carried in a field the page's store does not read, so the person sees no reason. */
    expect((await put('ada', record({ version: 3 }), ADA.signing.secret)).body).toMatchObject({ refused: 'not-the-next-version', error: expect.stringMatching(/next version of this record is 2/) });
    expect((await put('ada', record({ version: 1 }), ADA.signing.secret)).body).toMatchObject({ refused: 'version-already-filed', error: expect.stringMatching(/already filed/) });
    /*
     * The server judges no change of the company's key, so its own count of the company's key epoch decides nothing.
     * RED WHEN: a record sealed under a key epoch other than the one the server holds for the company is refused.
     */
    store.putAccount(accountOf(CO, ['ada', 'bo', 'cy'], 2));
    try {
      expect((await put('ada', record({ id: 'p7', keyEpoch: 1 }), ADA.signing.secret)).status).toBe(201);
      expect((await put('ada', record({ id: 'p7', version: 2, keyEpoch: 3 }), ADA.signing.secret)).status).toBe(201);
    } finally {
      store.putAccount(accountOf(CO, ['ada', 'bo', 'cy']));
    }
  });

  it('REFUSES ANOTHER COMPANY\'S MEMBER, A KEY SIGNED IN ANOTHER\'S SESSION, AND A SIGNATURE MOVED TO ANOTHER RECORD; JUDGES NO ROLE', async () => {
    /* RED WHEN: a member of another company files into this one. */
    expect((await put('eve', record({ id: 'p2' }), ADA.signing.secret)).status).toBe(404);
    /* RED WHEN: a filing signed by one person is accepted in another's session. */
    expect((await put('bo', record({ id: 'p2' }), ADA.signing.secret)).body).toMatchObject({ refused: 'no-entry' });
    /* RED WHEN: the server judges a role: Bo is an approver now, and his run is kept; whether a run is his to file is every member's device's to say. */
    expect((await put('bo', record({ kind: 'run', id: 'r1' }), BO.signing.secret)).status).toBe(201);
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
    const holders = async () => { reads += 1; const c = seated([ADA, BO]); return { ...c.seats, approvals: c.approvals, vaultThresholds: [], policyBar: null, seatBar: c.seatBar, adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ADDRESS }; };
    const judge = directoryJudge({
      accountId: CO, label: LABEL, viewingKey: VIEWING, holders, attested: everySeatAttested,
      filings: async () => store.directoryFilingsOf(CO), anchored: filedHere, leaves: leavesOfTheContract,
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
      accountId: CO, label: LABEL, viewingKey: VIEWING, holders, attested: async () => (await everySeatAttested()).filter((x) => x.statement.seat !== BO.seat),
      filings: async () => store.directoryFilingsOf(CO), anchored: filedHere, leaves: leavesOfTheContract,
    });
    await expect(new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, boUnattested).get('proposal', 'p3')).rejects.toBeInstanceOf(FilingNotBelieved);
    expect((await new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, judge).get('proposal', 'p3'))!.version).toBe(1);
    /* RED WHEN: a check made without a fresh answer from the wallet believes anything. */
    const noAnswer: FreshJudge = directoryJudge({
      accountId: CO, label: LABEL, viewingKey: VIEWING, holders: async () => { throw new Error('the wallet did not answer'); }, attested: everySeatAttested,
      filings: async () => store.directoryFilingsOf(CO), anchored: filedHere, leaves: leavesOfTheContract,
    });
    await expect(new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, noAnswer).get('proposal', 'p1')).rejects.toThrow(/could not be checked/);
    /* RED WHEN: bytes changed after filing are believed. */
    const tampered: WireSend = async () => {
      const w = toCompanyWire((await records.get(CO, 'proposal', 'p1'))!);
      return { status: 200, body: { kind: 'proposal', id: 'p1', filed: { ...w, body: w.body.replace('"version":1', '"version":1 ') } } };
    };
    await expect(new HttpCompanyRecordStore(CO, tampered, ADA.signing.secret, judge).get('proposal', 'p1')).rejects.toThrow(/digest/);
  });

  it('EACH READ ASKS ITS JUDGE FOR THE ONE RECORD IT READS, SO THAT RECORD IS WHAT IS PROVEN AGAINST THE ANCHOR', async () => {
    const holders = async () => { const c = seated([ADA, BO]); return { ...c.seats, approvals: c.approvals, vaultThresholds: [], policyBar: null, seatBar: c.seatBar, adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ADDRESS }; };
    const judge = directoryJudge({ accountId: CO, label: LABEL, viewingKey: VIEWING, holders, attested: everySeatAttested, filings: async () => store.directoryFilingsOf(CO), anchored: filedHere, leaves: leavesOfTheContract });
    const asked: unknown[] = [];
    const asking: FreshJudge = async (a) => { asked.push(a); return judge(a); };
    const device = new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, asking);
    await device.get('proposal', 'p1');
    await device.versions('proposal', 'p3');
    /* RED WHEN: a read asks for nothing, or for another record than the one it reads - what it judges was never proven for it. */
    expect(asked).toEqual([
      { records: [{ store: 'company', kind: 'proposal', id: 'p1' }] },
      { records: [{ store: 'company', kind: 'proposal', id: 'p3' }] },
    ]);
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
    const signed = signCompanyFiling(rec, seat.signing.secret);
    const judge = await directoryJudge({
      accountId: CO, label: LABEL, viewingKey: VIEWING, attested: everySeatAttested, filings: async () => store.directoryFilingsOf(CO),
      holders: async () => ({ ...c.seats, approvals: c.approvals, vaultThresholds: [], policyBar: null, seatBar: c.seatBar, adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ADDRESS }),
      /* The version as the seat filed it, entered by that seat: what is asked is only who may file it. */
      anchored: async (directory) => heldFiledBy(CO, [signed], [seat.signing.secret], undefined, directory),
      leaves: leavesOfTheContract,
    })();
    return judge(seat.signing.publicKey, rec.kind, companyRecordKey(rec.kind, rec.id), companyRecordEntry(signed));
  };
  const before = () => chain;
  let kept: ChainHolders | null = null;
  beforeAll(() => { kept = before(); });
  afterAll(() => { chain = kept; });

  /* RED WHEN: the server does not ask the chain whether the filing seat is held now, so it keeps what no device believes. */
  it('a seat the chain no longer holds files nothing - and no device believes it; a seated signer whose key is on no committee files', async () => {
    const both = [ADA.seat, BO.seat];
    const p = record('t1');
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: [ADA.seat] }, approvals: 2, seatBar: 2 };
    expect((await put('bo', p, BO.signing.secret)).body).toMatchObject({ refused: 'seat-not-seated' });
    expect(await deviceSays(BO, p)).toBe(FILING_REFUSAL['seat-not-seated']);
    expect(await records.get(CO, 'proposal', 't1')).toBeNull();
    /* Bo's seat held, his key on no committee. RED WHEN: a signer whose wallet key is not on the committee is refused, by the server or a device. */
    chain = { seats: { committee: [ADA.committeeKey], threshold: 1, seats: both }, approvals: 2, seatBar: 2 };
    expect(await deviceSays(BO, p)).toBeNull();
    expect((await put('bo', p, BO.signing.secret)).status).toBe(201);
  });

  /* RED WHEN: a role changed under a lower threshold than the account requires today binds on a device, or the server judges the role. */
  it('a role changed under fewer approvals than the account requires now is not believed by a device; the server stores the change and judges no role', async () => {
    const both = [ADA.seat, BO.seat];
    /* Bo was made an approver by two approvals; the account now requires three. */
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: both }, approvals: 3, seatBar: 3 };
    expect((await directoryOf(store, chainRead, CO)).dir.seats.find((x) => x.seat === BO.seat)!.role).toBeNull();
    const run = record('t2', 'run');
    expect(await deviceSays(BO, run)).toBeNull();
    expect((await put('bo', run, BO.signing.secret)).status).toBe(201);
    /* At two, the change binds again on a device: a run is not an approver's to file, which only a device judges. */
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: both }, approvals: 2, seatBar: 2 };
    expect((await directoryOf(store, chainRead, CO)).dir.seats.find((x) => x.seat === BO.seat)!.role).toBeNull();
    const another = record('t3', 'run');
    expect(await deviceSays(BO, another)).toBe(FILING_REFUSAL['role-may-not-file']);
    /* RED WHEN: the server refuses a filing for the filer's role. */
    expect((await put('bo', another, BO.signing.secret)).status).toBe(201);
  });

  /** A device reading the chain as the server does now, holding `signed` as entered by `seat`, and a service that keeps nothing of it. */
  const readingWith = (signed: SealedCompanyRecord, seat: Seat) => {
    const c = chain!;
    const judge = directoryJudge({
      accountId: CO, label: LABEL, viewingKey: VIEWING, attested: everySeatAttested, filings: async () => store.directoryFilingsOf(CO),
      holders: async () => ({ ...c.seats, approvals: c.approvals, vaultThresholds: [], policyBar: null, seatBar: c.seatBar, adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ADDRESS }),
      anchored: async (directory) => heldFiledBy(CO, [signed], [seat.signing.secret], undefined, directory),
      leaves: leavesOfTheContract,
    });
    return new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, judge);
  };

  it('A RUN THE SERVICE KEEPS NOTHING OF IS WITHHELD ONLY WHEN A SEAT THAT MAY FILE A RUN ENTERED IT', async () => {
    chain = { seats: { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: [ADA.seat, BO.seat] }, approvals: 2, seatBar: 2 };
    /* Bo is an approver at two approvals: he files proposals and no run. */
    expect((await directoryOf(store, chainRead, CO)).dir.seats.find((x) => x.seat === BO.seat)!.role).toBeNull();
    const byBo = signCompanyFiling(record('t5', 'run'), BO.signing.secret);
    /* RED WHEN: the entry of a seat whose role may not file a run counts as the company naming one - the read judged by a directory where every filer is an admin. */
    await expect(readingWith(byBo, BO).get('run', 't5')).resolves.toBeNull();
    const byAda = signCompanyFiling(record('t6', 'run'), ADA.signing.secret);
    /* RED WHEN: a run Ada's seat entered and the service does not give is read as absent. */
    await expect(readingWith(byAda, ADA).get('run', 't6')).rejects.toBeInstanceOf(RecordWithheld);
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
  /** Cy's filing key and the company's viewing key, as his device holds them once he is admitted. */
  const cysKeys = async () => ({ signingSecret: CY.signing.secret, viewingKey: VIEWING });
  /** The seat the company's account was deployed with, as Cy's wallet reads it: Ada's. */
  const adaFounded = async () => ADA.seat;
  let before: ChainHolders | null = null;
  beforeAll(() => { before = chain; });
  afterAll(() => { chain = before; });

  /* RED WHEN: an entry the directory refuses is let go, so it is never filed; or one it takes is kept and filed again; or filing it needs a press. */
  it('a refusal leaves it owed; once the chain holds the seat it is filed and let go', async () => {
    /* The invitation Cy accepted, kept on his device with his entry. */
    const CYS_INVITATION = openSeatProof(CO, CY.entry.proof, VIEWING)!.invited!;
    /* An entry kept with no opening of its seat is never filed: nothing would prove its key. */
    kept = { person: 'cy', company: LABEL, signed: { committeeKey: CY.committeeKey, entry: CY.statement } };
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed, cysKeys, adaFounded)).toMatchObject({ notYet: expect.stringMatching(/holds no opening of its seat/) });
    kept = { person: 'cy', company: LABEL, signed: { committeeKey: CY.committeeKey, entry: CY.statement }, opening: CY.opening, invited: CYS_INVITATION };
    /* RED WHEN: an entry is filed before this device can seal it for the company's members - an invitee not admitted yet - or let go then. */
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed, async () => null, adaFounded)).toMatchObject({ notYet: expect.stringMatching(/cannot open the company's key yet/) });
    expect(kept).not.toBeNull();
    const filings = store.directoryFilingsOf(CO).length;
    /* Cy's seat is not held yet. */
    chain = { seats: { committee: [ADA.committeeKey], threshold: 1, seats: [ADA.seat, BO.seat] }, approvals: 2, seatBar: 2 };
    const notYet: OwedEntryFiled = await fileTheOwedDirectoryEntry(cysApi, CO, owed, cysKeys, adaFounded);
    expect(notYet).toMatchObject({ notYet: expect.stringMatching(/not one the company's account holds now/) });
    expect(kept).not.toBeNull();
    expect(store.directoryFilingsOf(CO).length).toBe(filings);
    /* Cy's seat held, his wallet on no committee: the entry is filed with the opening that proves his key. */
    chain = { seats: { committee: [ADA.committeeKey], threshold: 1, seats: [ADA.seat, BO.seat, CY.seat] }, approvals: 2, seatBar: 2 };
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed, cysKeys, adaFounded)).toBe('filed');
    expect(kept).toBeNull();
    expect((await directoryOf(store, chainRead, CO)).dir.seats.find((x) => x.seat === CY.seat)?.person).toBe('cy');
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed, cysKeys, adaFounded)).toBe('nothing-owed');
    /* RED WHEN: an entry already in the directory is filed a second time rather than let go. */
    kept = { person: 'cy', company: LABEL, signed: { committeeKey: CY.committeeKey, entry: CY.statement }, opening: CY.opening, invited: CYS_INVITATION };
    expect(await fileTheOwedDirectoryEntry(cysApi, CO, owed, cysKeys, adaFounded)).toBe('already-there');
    expect(kept).toBeNull();
    expect(store.directoryFilingsOf(CO).length).toBe(filings + 1);
  });
});
