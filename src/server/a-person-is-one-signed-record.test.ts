/**
 * **A PERSON ON A PAYROLL IS ONE SIGNED RECORD, KEPT WITH THE COMPANY'S OTHER
 * RECORDS.** Every version of a person is a `person` company record, filed
 * through the company-record route by a seat the directory names, into the store
 * that keeps the company's records and nowhere else. What a payee hands over
 * waits on their invitation. A person the service's main store still held from
 * before is moved there, and let go of here.
 */
import { leavesOfTheContract, seatOpenedFor } from '../testing/directory-seats.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { canonical, newSigningKeypair, newSymmetricKey, newWrappingKeypair, wrapKey, type Hex } from '../core/crypto.js';
import { MemoryStore } from '../core/store.js';
import { FileStore } from '../core/store-file.js';
import { sealRecord } from '../core/sealed-records.js';
import type { Invite, RosterEmployee, SealedAccount, SealedEmployee } from '../core/types.js';
import { openPerson, peopleOnTheWire, peopleServed, sealPerson } from '../core/person-record.js';
import { seatDirectoryRoutes, directoryOf, type DirectoryChainRead } from './seat-directory-route.js';
import { companyRecordsRoutes, fileCompanyRecord, MemoryCompanyRecordStore, movePeopleToTheirRecords, withTheRosterIn } from './company-records-route.js';
import type { ChainHolders, DirectoryEntry, DirectoryFiling } from '../midnight/seat-directory.js';
import { directoryEntryMade } from '../midnight/seat-directory.js';
import { fromCompanyWire, signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { HttpCompanyRecordStore, FilingNotBelieved, RecordWithheld, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryJudge } from 'vaults-web-shared/vault-page-doors.js';
import { heldEntering } from '../testing/record-tree-double.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';

const CO = 'acc_people';
const OTHER = 'acc_people_other';
const LABEL = `co_${'d1'.repeat(32)}` as CompanyLabel;
const OTHER_LABEL = `co_${'d2'.repeat(32)}` as CompanyLabel;
const ADDRESS = 'd0'.repeat(32) as never;
const OTHER_ADDRESS = 'e0'.repeat(32) as never;
const KEY = newSymmetricKey();
const OTHER_KEY = newSymmetricKey();

interface Seat { person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string }; n: number }
const seatOf = (person: string, n: number, label = LABEL, address = ADDRESS, company = CO, viewingKey = KEY): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  /* The seat as a seating device makes it: its leaf commits to this wallet key, and its opening shows that. */
  const { seat, opening } = seatOpenedFor(committeeKey, n);
  const signed = signDirectoryEntry(identity, label, address, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  return { n, person, seat, signing, committeeKey, entry: directoryEntryMade({ company, person, committeeKey, signed, opening, signingSecret: signing.secret, viewingKey }) };
};
const ADA = seatOf('ada', 1);
const BO = seatOf('bo', 2);
const EVE = seatOf('eve', 9, OTHER_LABEL, OTHER_ADDRESS, OTHER, OTHER_KEY);

const accountOf = (id: string, members: string[], label: CompanyLabel, address: string): SealedAccount => ({
  id, createdAt: 'now', keyEpoch: 0, threshold: 1, signerCount: 2, memberUserIds: members, pendingSigners: [], wrappedKeys: [],
  inboxPublicKey: '00'.repeat(32), sealedRoster: { iv: '', tag: '', body: '' }, sealedPolicy: { iv: '', tag: '', body: '' },
  companyLabel: label as never, contractAddress: address,
} as SealedAccount);

let base = '';
let server: ReturnType<express.Express['listen']>;
const store = new MemoryStore();
/** The company's records other than its roster, its people among them, as the service keeps them. */
const records = new MemoryCompanyRecordStore();
let chain: ChainHolders | null = null;
/** The chain as the server reads it, each company's account on its own once both are set up; `chain` while they are. */
const chains = new Map<string, ChainHolders | null>();
const chainRead: DirectoryChainRead = async (id) => (chains.has(id) ? chains.get(id)! : chain);

beforeAll(async () => {
  store.putAccount(accountOf(CO, ['ada', 'bo'], LABEL, ADDRESS));
  store.putAccount(accountOf(OTHER, ['eve'], OTHER_LABEL, OTHER_ADDRESS));
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
  const member: express.RequestHandler = (req, res, next) => (store.getAccount(String(req.params.id))?.memberUserIds.includes(req.userId!)
    ? next() : res.status(404).json({ error: 'account not found' }));
  app.use(seatDirectoryRoutes({ signedIn, member, store, chain: chainRead }));
  app.use(companyRecordsRoutes({
    signedIn, member, records: withTheRosterIn(store, records),
    accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, chainRead, id),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seated = (seats: Seat[]): ChainHolders => ({
    seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1, seatBar: 1,
  });
  chain = seated([ADA, BO]);
  for (const [s, v] of [[ADA, 1], [BO, 2]] as const) {
    const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${v}`, { method: 'PUT', body: JSON.stringify({ company: CO, version: v, change: { kind: 'claim', entry: s.entry } } satisfies DirectoryFiling) });
    expect(r.status).toBe(201);
  }
  chain = seated([EVE]);
  expect((await sendAs('eve')(`/api/accounts/${OTHER}/directory/1`, { method: 'PUT', body: JSON.stringify({ company: OTHER, version: 1, change: { kind: 'claim', entry: EVE.entry } }) })).status).toBe(201);
  /* Bo is seated on the chain; his claim carries no invitation, so no device believes his seat. */
  chain = seated([ADA, BO]);
  chains.set(CO, seated([ADA, BO]));
  chains.set(OTHER, seated([EVE]));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const sendAs = (person: string | null): WireSend => async (path, init) => {
  const r = await fetch(base + path, {
    method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
    headers: { 'content-type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const dana = (over: Partial<RosterEmployee> = {}): RosterEmployee => ({
  id: 'emp_dana', accountId: CO, name: 'Dana Whitfield', email: 'dana@acme.co', title: 'Engineer', asset: 'TEST' as never,
  baseAmount: 620000n, startDate: '2026-10-01', status: 'pending', wrappingPublicKey: null,
  handedOverBy: null, admittedBy: null, admittedAt: null, selfRaised: false, address: null, ...over,
});
/** A person version filed through the one filing check every people route files through (`fileCompanyRecord`), in `person`'s session. */
const put = (person: string, rec: SealedCompanyRecord, signer: Hex | null) => fileCompanyRecord(
  { records: withTheRosterIn(store, records), accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, chainRead, id) },
  person, { company: rec.company, kind: 'person', id: rec.id }, rec.version,
  JSON.parse(JSON.stringify(toCompanyWire(signer === null ? rec : signCompanyFiling(rec, signer)))));

describe('A PERSON IS FILED FROM A SEAT\'S DEVICE, AND THE SERVICE KEEPS THAT ONE COPY WITH THE COMPANY\'S RECORDS', () => {
  it('A PERSON A SEAT FILED IS KEPT WITH THE COMPANY\'S OTHER RECORDS AND NOWHERE ELSE, AND THE NEXT VERSION REPLACES IT', async () => {
    expect((await put('ada', sealPerson(dana(), 1, 0, KEY), ADA.signing.secret)).status).toBe(201);
    /* RED WHEN: a person is filed anywhere but the store of the company's records. */
    expect((await records.peopleOf(CO)).map((r) => [r.id, r.version, r.facts?.status])).toEqual([['emp_dana', 1, 'pending']]);
    expect(await records.companyOfPerson('emp_dana')).toBe(CO);
    /* RED WHEN: the service's main store keeps a second copy of the person. */
    expect(store.personVersions('emp_dana')).toEqual([]);
    expect(store.getEmployee('emp_dana')).toBeNull();
    const key = newWrappingKeypair().publicKey;
    expect((await put('ada', sealPerson(dana({ wrappingPublicKey: key, title: 'Lead' }), 2, 0, KEY), ADA.signing.secret)).status).toBe(201);
    /* RED WHEN: a reader takes the first version, not the newest. */
    const [newest] = await records.peopleOf(CO);
    expect(openPerson(newest!, KEY).title).toBe('Lead');
    /* RED WHEN: the payslip key the person's slips are sealed to is kept beside the seal, where the service reads it. */
    expect(newest!.facts).toEqual({ status: 'pending' });
    expect(openPerson(newest!, KEY).wrappingPublicKey).toBe(key);
    /* Nothing readable about the person is kept beside the seal; the salary by its field's name, since its digits are hex and could match ciphertext by chance. */
    const held = canonical(await records.versions(CO, 'person', 'emp_dana'));
    for (const text of ['Dana Whitfield', 'dana@acme.co', 'Lead', 'baseAmount', key]) expect(held).not.toContain(text);
  });

  it('REFUSES AN UNSIGNED PERSON, ONE SIGNED IN ANOTHER\'S SESSION, A ROLE THAT MAY NOT FILE ONE, AND ANOTHER COMPANY\'S ID', async () => {
    const next = sealPerson(dana({ title: 'Staff' }), 3, 0, KEY);
    /* RED WHEN: a person record nobody signed is filed. */
    expect((await put('ada', next, null)).body).toMatchObject({ refused: 'not-signed' });
    /* RED WHEN: a person record signed by one seat is filed in another person's session. */
    expect((await put('bo', next, ADA.signing.secret)).body).toMatchObject({ refused: 'no-entry' });
    /* RED WHEN: a member of another company files a person into this one: their seat has no entry here. */
    expect((await put('eve', next, EVE.signing.secret)).body).toMatchObject({ refused: 'no-entry' });
    /* RED WHEN: the general record route files a person past the people routes' rules - a second door for the same record. */
    const twin = await sendAs('ada')(`/api/accounts/${CO}/records/person/emp_dana/3`, { method: 'PUT', body: JSON.stringify(toCompanyWire(signCompanyFiling(next, ADA.signing.secret))) });
    expect([twin.status, (twin.body as { refused?: string }).refused]).toEqual([405, 'not-this-route']);
    /* RED WHEN: an id already on another company's payroll is taken over by this one. */
    const theirs = sealPerson(dana({ id: 'emp_dana', accountId: OTHER }), 1, 0, OTHER_KEY);
    expect((await put('eve', theirs, EVE.signing.secret)).body).toMatchObject({ refused: 'another-companys-record' });
    /* RED WHEN: a person is served to another company by id. */
    expect((await sendAs('eve')(`/api/accounts/${OTHER}/records/person/emp_dana`, { method: 'GET' })).body).toMatchObject({ filed: null });
    expect((await records.versions(CO, 'person', 'emp_dana')).map((r) => r.version)).toEqual([1, 2]);
    expect(await records.peopleOf(OTHER)).toEqual([]);
  });

  it('THE PEOPLE READ REFUSES A VERSION WITH THE PAYSLIP KEY BESIDE ITS SEAL FOR THAT PERSON ALONE, AND READS EVERYBODY ELSE', () => {
    const now = signCompanyFiling(sealPerson(dana(), 1, 0, KEY), ADA.signing.secret);
    const old = signCompanyFiling({ ...sealPerson(dana({ id: 'emp_old' }), 1, 0, KEY), facts: { status: 'active', wrappingPublicKey: newWrappingKeypair().publicKey } } as never, ADA.signing.secret);
    const answer = { people: [{ filed: toCompanyWire(now) }, { filed: toCompanyWire(old) }] };
    /* RED WHEN: one such version refuses the company's whole list where a run is drawn from. */
    expect(peopleServed(answer, CO).people.map((p) => p.rec.id)).toEqual(['emp_dana']);
    /* The reader that shows the people as one table says it could not read them, naming whom. */
    expect(() => peopleOnTheWire(answer, CO)).toThrow(/person emp_old does not read as a person record/u);
    /* RED WHEN: the person refused is left out unseen, or named without why. */
    expect(peopleServed(answer, CO).refused).toEqual([{ id: 'emp_old', why: expect.stringMatching(/where the person stands and nothing else beside its seal/u) }]);
    /* A list that is not a list, or a person with no name, is still not read at all. */
    expect(() => peopleServed({}, CO)).toThrow(/did not send the company's people/u);
    expect(() => peopleServed({ people: [{ filed: {} }] }, CO)).toThrow(/not named/u);
  });

  it('A PERSON RECORD IS SEALED UNDER THE PAYROLL KEY, CARRIES ONLY WHERE THE PERSON STANDS AND NO WRAPS, AND SAYS NOTHING ELSE IN PLAIN TEXT', () => {
    const rec = sealPerson(dana(), 1, 0, KEY);
    const wire = (r: unknown) => () => fromCompanyWire({ ...toCompanyWire(r as SealedCompanyRecord) }, { company: CO, kind: 'person', id: 'emp_dana' });
    expect(wire(rec)).not.toThrow();
    /* RED WHEN: a person record may carry per-reader wraps beside the purpose key it is sealed under. */
    const k = newSymmetricKey();
    expect(wire({ ...rec, wrapped: [{ signerId: 'x', wrapped: wrapKey(k, newWrappingKeypair().publicKey) }] })).toThrow(/no wrapped keys/);
    /* RED WHEN: a person record without its standing, or with any fact beside it, is taken. */
    expect(wire({ ...rec, facts: undefined })).toThrow(/says where the person stands/);
    expect(wire({ ...rec, facts: { ...rec.facts, name: 'Dana' } })).toThrow(/says where the person stands/);
    expect(wire({ ...rec, facts: { status: 'hired' } })).toThrow(/says where the person stands/);
    /* RED WHEN: a person record may carry the payslip key beside the seal, where the service reads it. */
    expect(wire({ ...rec, facts: { status: 'active', wrappingPublicKey: null } })).toThrow(/says where the person stands/);
    expect(wire({ ...rec, facts: { status: 'active', wrappingPublicKey: newWrappingKeypair().publicKey } })).toThrow(/says where the person stands/);
    expect(rec.facts).toEqual({ status: 'pending' });
    /* RED WHEN: another kind may carry plain facts. */
    expect(() => fromCompanyWire(toCompanyWire({ ...rec, kind: 'run', wrapped: [{ signerId: 'x', wrapped: wrapKey(k, newWrappingKeypair().publicKey) }] } as SealedCompanyRecord), { company: CO, kind: 'run', id: 'emp_dana' })).toThrow(/carries no plain facts/);
    /* The seal is the payroll key's, as a payroll entry always was. */
    expect(openPerson(rec, KEY).name).toBe('Dana Whitfield');
    expect(() => openPerson(rec, OTHER_KEY)).toThrow(/will not open/);
  });

  /** A device's judge of the company's people: `named` are the entries it holds besides every version Ada's seat filed, each entered by its own filer. */
  const personJudge = (named: readonly { readonly entry: ReturnType<typeof companyRecordEntry>; readonly signingSecret: string }[] = []) => {
    const holders = async () => ({ committee: [ADA.committeeKey, BO.committeeKey], threshold: 1, seats: [ADA.seat, BO.seat], approvals: 1, adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ADDRESS });
    const attested = async () => [ADA, BO].map((s) => ({
      committeeKey: s.committeeKey,
      statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat),
    }));
    return directoryJudge({
      accountId: CO, label: LABEL, viewingKey: KEY, holders: holders as never, attested, filings: async () => store.directoryFilingsOf(CO), leaves: leavesOfTheContract,
      /* Every version Ada's seat filed, entered by her seat; nothing anchored yet. Each is judged by the directory this device reads. */
      anchored: async (directory) => heldEntering(CO, [
        ...(await records.versions(CO, 'person', 'emp_dana'))
          .filter((r) => r.filedBy?.publicKey === ADA.signing.publicKey).map((r) => ({ entry: companyRecordEntry(r), signingSecret: ADA.signing.secret })),
        ...named,
      ] as never, undefined, directory),
    });
  };

  it('AN ENTRY FOR A PERSON FROM A SEAT NO DEVICE BELIEVES IS NOT THE COMPANY NAMING A VERSION; ONE FROM A SEAT THAT IS BELIEVED IS', async () => {
    const v2 = (await records.get(CO, 'person', 'emp_dana'))!;
    const next = (body: string): SealedCompanyRecord => ({ ...v2, version: v2.version + 1, sealed: { ...v2.sealed, body } });
    /* Bo's claim carries no invitation from a seat the directory holds, so no device believes his seat; the service serves nothing past version 2. */
    const byBo = [{ entry: companyRecordEntry(next('bo')), signingSecret: BO.signing.secret }];
    /* RED WHEN: the entries a device holds are judged by a directory that makes every filer a believed, seated admin, so an entry of a seat nobody believes counts as the company naming a version the service withheld. */
    expect((await new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, personJudge(byBo)).get('person', 'emp_dana'))!.version).toBe(2);
    /* RED WHEN: Ada's seat, an admin who may file a person, naming a version the service does not give is read as the newest. */
    const byAda = [{ entry: companyRecordEntry(next('ada')), signingSecret: ADA.signing.secret }];
    await expect(new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, personJudge(byAda)).get('person', 'emp_dana')).rejects.toThrow(/a newer version of it is in the company's records and the service did not give it/u);
  });

  it('THE DEVICE BELIEVES A PERSON A SEAT IT BELIEVES FILED, AND NOT ONE THE SERVICE WROTE', async () => {
    const judge = personJudge();
    const device = new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, judge);
    expect((await device.get('person', 'emp_dana'))!.version).toBe(2);
    /* The service writes a version with no seat's signature. */
    const { filedBy: _signature, ...unsigned } = (await records.get(CO, 'person', 'emp_dana'))!;
    await records.put({ ...unsigned, version: 3, facts: { ...unsigned.facts!, status: 'leaver' } });
    /* RED WHEN: a person version no seat signed is believed because the service served it. */
    await expect(device.get('person', 'emp_dana')).rejects.toBeInstanceOf(FilingNotBelieved);
    /* The service answers that it holds no version of Dana, and no list of her versions, while her seat's entries name two. */
    const withholding: WireSend = async (path, init) => (path.includes('emp_dana')
      ? { status: 200, body: path.endsWith('/versions') ? { versions: [] } : { kind: 'person', id: 'emp_dana', filed: null } }
      : sendAs('ada')(path, init));
    const withheld = new HttpCompanyRecordStore(CO, withholding, ADA.signing.secret, judge);
    /* RED WHEN: a person the company's records name, answered as never filed, is read as absent. */
    await expect(withheld.get('person', 'emp_dana')).rejects.toBeInstanceOf(RecordWithheld);
    await expect(withheld.versions('person', 'emp_dana')).rejects.toThrow(/name version 2 of it and the service did not give it/u);
    /* RED WHEN: a person nothing names is refused as withheld - a record never filed could never be read. */
    const nobody: WireSend = async (path) => ({ status: 200, body: path.endsWith('/versions') ? { versions: [] } : { kind: 'person', id: 'emp_nobody', filed: null } });
    await expect(new HttpCompanyRecordStore(CO, nobody, ADA.signing.secret, judge).get('person', 'emp_nobody')).resolves.toBeNull();
    await expect(new HttpCompanyRecordStore(CO, nobody, ADA.signing.secret, judge).versions('person', 'emp_nobody')).resolves.toEqual([]);
  });
});

describe('THE OLDER CODE\'S ROW, WRITTEN AS THE NEXT VERSION OF THE SAME RECORD', () => {
  const s = new MemoryStore();
  const SAM = sealRecord('payroll', CO, { name: 'Sam' }, KEY);
  const row = (over: Partial<SealedEmployee> = {}): SealedEmployee => ({
    id: 'emp_sam', accountId: CO, inbox: null, status: 'pending', keyEpoch: 0, sealed: SAM, ...over,
  });
  const invite = (token: string, createdAt: string, over: Partial<Invite> = {}): Invite => ({ token, accountId: CO, kind: 'employee', createdAt, subjectId: 'emp_sam', ...over });
  const box = (n: number) => ({ ephemeral: n.toString(16).padStart(64, '0'), iv: 'aa', tag: 'bb', body: `b${n}` });

  it('A ROW THAT CHANGES THE PERSON IS A NEW VERSION; ONE THAT CHANGES NOTHING ABOUT THEM IS NONE', () => {
    s.putEmployee(row());
    s.putInvite(invite('t1', '2026-10-01'));
    s.putEmployee(row());
    /* RED WHEN: a row identical to the person writes another version. */
    expect(s.personVersions('emp_sam').map((r) => r.version)).toEqual([1]);
    s.putEmployee(row({ status: 'leaver' }));
    expect(s.personVersions('emp_sam').map((r) => [r.version, r.facts!.status, r.filedBy])).toEqual([[1, 'pending', undefined], [2, 'leaver', undefined]]);
    /* RED WHEN: a row naming another company is written over this company's person. */
    expect(() => s.putEmployee(row({ accountId: OTHER }))).toThrow(/another company's payroll/);
  });

  it('WHAT A PAYEE HANDS OVER WAITS ON THEIR NEWEST INVITATION, AND AN INVITATION WRITTEN BACK NEVER BRINGS IT BACK OR LOSES IT', () => {
    s.putInvite(invite('t2', '2026-10-02'));
    const read = s.getInvite('t2' as never) ?? Object.values((s as unknown as { data: { invites: Record<string, Invite> } }).data.invites).find((i) => i.token === 't2')!;
    s.putEmployee({ ...s.getEmployee('emp_sam')!, inbox: box(1) });
    /* RED WHEN: the handover is kept on the person rather than on the invitation the payee accepted. */
    expect(s.personVersions('emp_sam')).toHaveLength(2);
    expect(s.getEmployee('emp_sam')!.inbox).toEqual(box(1));
    /* RED WHEN: an invitation read before the payee accepted, written back after, empties what they handed over. */
    s.putInvite({ ...read, acceptedAt: 'now' });
    expect(s.getEmployee('emp_sam')!.inbox).toEqual(box(1));
    /* Admitted: the box is emptied. */
    const withBox = s.listInvites(CO).find((i) => i.token === 't2')!;
    s.putEmployee({ ...s.getEmployee('emp_sam')!, inbox: null });
    /* RED WHEN: an invitation read while it held the handover, written back after it was emptied, brings it back. */
    s.putInvite({ ...withBox, acceptedAt: undefined });
    expect(s.getEmployee('emp_sam')!.inbox).toBeNull();
  });

  it('A HANDOVER WITH NO INVITATION TO KEEP IT ON IS REFUSED, NOT DROPPED', () => {
    const lone = new MemoryStore();
    /* RED WHEN: what a payee handed over is dropped because there was nowhere to keep it. */
    expect(() => lone.putEmployee(row({ id: 'emp_lone', inbox: box(3) }))).toThrow(/no invitation to keep it on/);
  });

  it('A FILE WRITTEN WHEN PEOPLE WERE ROWS LOADS AS RECORDS, WITH WHAT WAS WAITING ON THE INVITATION', () => {
    const dir = mkdtempSync(join(tmpdir(), 's292-people-'));
    const path = join(dir, 'data.json');
    writeFileSync(path, canonical({
      accounts: {}, proposals: {}, runs: {}, users: {}, writtenBy: [], companyVaults: {}, vaultKeyIndex: {}, directories: {}, committeeSignatures: {},
      employees: { emp_old: row({ id: 'emp_old', inbox: box(7), status: 'pending' }) },
      invites: { k1: invite('k1', '2026-09-01', { subjectId: 'emp_old' }), k0: invite('k0', '2026-08-01', { subjectId: 'emp_old' }) },
    }));
    const loaded = new FileStore(path);
    /* RED WHEN: a person stored as a row is lost when the file is read as records. */
    expect(loaded.personVersions('emp_old').map((r) => [r.version, r.facts!.status])).toEqual([[1, 'pending']]);
    /* RED WHEN: what was waiting to be admitted is lost, or kept on an older invitation. */
    expect(loaded.getEmployee('emp_old')!.inbox).toEqual(box(7));
    expect(loaded.listInvites(CO).find((i) => i.token === 'k0')!.handover ?? null).toBeNull();
    /* RED WHEN: the old table is written back beside the records. */
    expect('employees' in loaded.snapshot()).toBe(false);
  });
});

describe('A PERSON THE MAIN STORE STILL HOLDS IS MOVED TO THE COMPANY\'S RECORDS, AND LET GO OF THERE', () => {
  const row = (over: Partial<SealedEmployee> = {}): SealedEmployee => {
    const rec = sealPerson(dana({ id: 'emp_moved', accountId: CO }), 1, 0, KEY);
    return { id: 'emp_moved', accountId: CO, keyEpoch: 0, status: 'pending', wrappingPublicKey: null, sealed: rec.sealed, inbox: null, ...over } as SealedEmployee;
  };

  it('EVERY VERSION IS FILED THERE AS IT WAS HELD, THE MAIN STORE LETS THE PERSON GO, AND MOVING AGAIN CHANGES NOTHING', async () => {
    const held = new MemoryStore();
    held.putEmployee(row());
    held.putEmployee(row({ status: 'leaver' }));
    const kept = held.personVersions('emp_moved');
    const to = new MemoryCompanyRecordStore();
    /* RED WHEN: a person held in the main store is not moved, or not every version of them. */
    expect(await movePeopleToTheirRecords(held, to)).toBe(1);
    expect(canonical(await to.versions(CO, 'person', 'emp_moved'))).toBe(canonical(kept));
    /* RED WHEN: the main store keeps the person it moved, so they are held in two places. */
    expect(held.personVersions('emp_moved')).toEqual([]);
    expect(held.getEmployee('emp_moved')).toBeNull();
    expect(await movePeopleToTheirRecords(held, to)).toBe(0);
    expect((await to.versions(CO, 'person', 'emp_moved')).length).toBe(2);
  });

  it('A PAYSLIP KEY A ROW FROM AN OLDER FILE HOLDS IN THE CLEAR IS NOT CARRIED BESIDE THE SEAL WHEN THE PERSON MOVES', async () => {
    const key = newWrappingKeypair().publicKey;
    const held = new MemoryStore();
    held.putEmployee({ ...row({ id: 'emp_keyed', status: 'active' }), wrappingPublicKey: key } as SealedEmployee);
    const to = new MemoryCompanyRecordStore();
    expect(await movePeopleToTheirRecords(held, to)).toBe(1);
    const moved = await to.versions(CO, 'person', 'emp_keyed');
    /* RED WHEN: the person's record keeps the payslip key beside its seal, where the service reads it. */
    expect(moved.map((r) => r.facts)).toEqual([{ status: 'active' }]);
    expect(canonical(moved)).not.toContain(key);
  });

  it('A VERSION ALREADY FILED THERE IS TAKEN AS MOVED ONLY WHEN IT IS EXACTLY THE ONE HELD; OTHERWISE THE PERSON STAYS, NAMED', async () => {
    const held = new MemoryStore();
    held.putEmployee(row());
    const to = new MemoryCompanyRecordStore();
    /* A move that filed the version and stopped before letting go is finished by the next. */
    await to.put(held.personVersions('emp_moved')[0]!);
    expect(await movePeopleToTheirRecords(held, to)).toBe(1);
    expect(held.personVersions('emp_moved')).toEqual([]);
    const other = new MemoryStore();
    other.putEmployee(row({ status: 'active' }));
    const there = new MemoryCompanyRecordStore();
    await there.put(held.personVersions('emp_moved')[0] ?? (await to.versions(CO, 'person', 'emp_moved'))[0]!);
    /* RED WHEN: a person is let go of here though what is filed there under the same version says otherwise. */
    await expect(movePeopleToTheirRecords(other, there)).rejects.toThrow(/person emp_moved's version 1 is filed with the company's records as something other/);
    expect(other.personVersions('emp_moved').length).toBe(1);
  });
});
