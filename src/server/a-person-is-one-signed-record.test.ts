/**
 * **A PERSON ON A PAYROLL IS ONE SIGNED RECORD, AND THE SERVICE'S OLDER CODE
 * READS THAT RECORD.** Every version of a person is a `person` company record
 * in the service's main store, filed through the company-record route by a seat
 * the directory names, and the employee row the older payroll code reads is
 * made from the newest one. What a payee hands over waits on their invitation.
 */
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
import { openEmployeeRow, openPerson, sealPerson } from '../core/person-record.js';
import { seatDirectoryRoutes, directoryOf, type DirectoryChainRead } from './seat-directory-route.js';
import { companyRecordsRoutes, fileCompanyRecord, MemoryCompanyRecordStore, withPeopleIn } from './company-records-route.js';
import type { ChainHolders, DirectoryEntry, DirectoryFiling } from '../midnight/seat-directory.js';
import { fromCompanyWire, signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { HttpCompanyRecordStore, FilingNotBelieved, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryJudge } from 'vaults-web-shared/vault-page-doors.js';

const CO = 'acc_people';
const OTHER = 'acc_people_other';
const LABEL = `co_${'d1'.repeat(32)}` as CompanyLabel;
const OTHER_LABEL = `co_${'d2'.repeat(32)}` as CompanyLabel;
const ADDRESS = 'd0'.repeat(32) as never;
const OTHER_ADDRESS = 'e0'.repeat(32) as never;
const KEY = newSymmetricKey();
const OTHER_KEY = newSymmetricKey();

interface Seat { person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string }; n: number }
const seatOf = (person: string, n: number, label = LABEL, address = ADDRESS): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const seat = n.toString(16).padStart(2, '0').repeat(32);
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  return { n, person, seat, signing, committeeKey, entry: { person, committeeKey, statement: signDirectoryEntry(identity, label, address, new Uint8Array(32).fill(n + 100), signing.publicKey, seat) } };
};
const ADA = seatOf('ada', 1);
const BO = seatOf('bo', 2);
const EVE = seatOf('eve', 9, OTHER_LABEL, OTHER_ADDRESS);

const accountOf = (id: string, members: string[], label: CompanyLabel, address: string): SealedAccount => ({
  id, createdAt: 'now', keyEpoch: 0, threshold: 1, signerCount: 2, memberUserIds: members, pendingSigners: [], wrappedKeys: [],
  inboxPublicKey: '00'.repeat(32), sealedRoster: { iv: '', tag: '', body: '' }, sealedPolicy: { iv: '', tag: '', body: '' },
  companyLabel: label as never, contractAddress: address,
} as SealedAccount);

let base = '';
let server: ReturnType<express.Express['listen']>;
const store = new MemoryStore();
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
    signedIn, member, records: withPeopleIn(store, new MemoryCompanyRecordStore()),
    accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, chainRead, id),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seated = (seats: Seat[]): ChainHolders => ({ seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1 });
  chain = seated([ADA, BO]);
  for (const [s, v] of [[ADA, 1], [BO, 2]] as const) {
    const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${v}`, { method: 'PUT', body: JSON.stringify({ company: CO, version: v, change: { kind: 'claim', entry: s.entry } } satisfies DirectoryFiling) });
    expect(r.status).toBe(201);
  }
  chain = seated([EVE]);
  expect((await sendAs('eve')(`/api/accounts/${OTHER}/directory/1`, { method: 'PUT', body: JSON.stringify({ company: OTHER, version: 1, change: { kind: 'claim', entry: EVE.entry } }) })).status).toBe(201);
  /* Bo is an approver: a quorum of one names his role. */
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
  { records: withPeopleIn(store, new MemoryCompanyRecordStore()), accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, chainRead, id) },
  person, { company: rec.company, kind: 'person', id: rec.id }, rec.version,
  JSON.parse(JSON.stringify(toCompanyWire(signer === null ? rec : signCompanyFiling(rec, signer)))));

describe('A PERSON IS FILED FROM A SEAT\'S DEVICE, AND THE SERVICE READS THAT ONE COPY', () => {
  it('A PERSON A SEAT FILED IS THE EMPLOYEE ROW THE OLDER CODE READS, AND THE NEXT VERSION REPLACES IT', async () => {
    expect((await put('ada', sealPerson(dana(), 1, 0, KEY), ADA.signing.secret)).status).toBe(201);
    const row = store.getEmployee('emp_dana')!;
    /* RED WHEN: the older code's reader still reads a table nothing files into. */
    expect(row).toMatchObject({ id: 'emp_dana', accountId: CO, status: 'pending', wrappingPublicKey: null, inbox: null });
    expect(openEmployeeRow(row, KEY).name).toBe('Dana Whitfield');
    expect(store.listEmployees(CO).map((e) => e.id)).toEqual(['emp_dana']);
    /* The payslip key index is built here, before the next version is filed. */
    expect(store.employeeIdsWithKey('ab'.repeat(32))).toEqual([]);
    const key = newWrappingKeypair().publicKey;
    expect((await put('ada', sealPerson(dana({ wrappingPublicKey: key, title: 'Lead' }), 2, 0, KEY), ADA.signing.secret)).status).toBe(201);
    /* RED WHEN: a reader takes the first version, not the newest. */
    expect(store.getEmployee('emp_dana')!.wrappingPublicKey).toBe(key);
    expect(openEmployeeRow(store.getEmployee('emp_dana')!, KEY).title).toBe('Lead');
    /* RED WHEN: a version filed after the payslip key index was built is not indexed. */
    expect(store.employeeIdsWithKey(key)).toEqual(['emp_dana']);
    /* Nothing readable about the person is kept beside the seal; the salary by its field's name, since its digits are hex and could match ciphertext by chance. */
    const held = canonical(store.personVersions('emp_dana'));
    for (const text of ['Dana Whitfield', 'dana@acme.co', 'Lead', 'baseAmount']) expect(held).not.toContain(text);
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
    expect(store.personVersions('emp_dana').map((r) => r.version)).toEqual([1, 2]);
  });

  it('A PERSON RECORD IS SEALED UNDER THE PAYROLL KEY, CARRIES ITS TWO FACTS AND NO WRAPS, AND SAYS NOTHING ELSE IN PLAIN TEXT', () => {
    const rec = sealPerson(dana(), 1, 0, KEY);
    const wire = (r: unknown) => () => fromCompanyWire({ ...toCompanyWire(r as SealedCompanyRecord) }, { company: CO, kind: 'person', id: 'emp_dana' });
    expect(wire(rec)).not.toThrow();
    /* RED WHEN: a person record may carry per-reader wraps beside the purpose key it is sealed under. */
    const k = newSymmetricKey();
    expect(wire({ ...rec, wrapped: [{ signerId: 'x', wrapped: wrapKey(k, newWrappingKeypair().publicKey) }] })).toThrow(/no wrapped keys/);
    /* RED WHEN: a person record without its standing, or with a fact beyond the two, is taken. */
    expect(wire({ ...rec, facts: undefined })).toThrow(/says where the person stands/);
    expect(wire({ ...rec, facts: { ...rec.facts, name: 'Dana' } })).toThrow(/says where the person stands/);
    expect(wire({ ...rec, facts: { status: 'hired', wrappingPublicKey: null } })).toThrow(/says where the person stands/);
    /* RED WHEN: another kind may carry plain facts. */
    expect(() => fromCompanyWire(toCompanyWire({ ...rec, kind: 'run', wrapped: [{ signerId: 'x', wrapped: wrapKey(k, newWrappingKeypair().publicKey) }] } as SealedCompanyRecord), { company: CO, kind: 'run', id: 'emp_dana' })).toThrow(/carries no plain facts/);
    /* The seal is the payroll key's, as a payroll entry always was. */
    expect(openPerson(rec, KEY).name).toBe('Dana Whitfield');
    expect(() => openPerson(rec, OTHER_KEY)).toThrow(/will not open/);
  });

  it('THE DEVICE BELIEVES A PERSON A SEAT IT BELIEVES FILED, AND NOT ONE THE SERVICE WROTE', async () => {
    const holders = async () => ({ committee: [ADA.committeeKey, BO.committeeKey], threshold: 1, seats: [ADA.seat, BO.seat], approvals: 1, adoptedVaults: [], account: ADDRESS });
    const attested = async () => [ADA, BO].map((s) => ({
      committeeKey: s.committeeKey,
      statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat),
    }));
    const device = new HttpCompanyRecordStore(CO, sendAs('ada'), ADA.signing.secret, directoryJudge({
      accountId: CO, label: LABEL, holders: holders as never, attested, filings: async () => store.directoryFilingsOf(CO),
    }));
    expect((await device.get('person', 'emp_dana'))!.version).toBe(2);
    /* The older code writes a version with no seat's signature. */
    const row = store.getEmployee('emp_dana')!;
    store.putEmployee({ ...row, status: 'leaver' });
    /* RED WHEN: a person version no seat signed is believed because the service served it. */
    await expect(device.get('person', 'emp_dana')).rejects.toBeInstanceOf(FilingNotBelieved);
  });
});

describe('THE OLDER CODE\'S ROW, WRITTEN AS THE NEXT VERSION OF THE SAME RECORD', () => {
  const s = new MemoryStore();
  const SAM = sealRecord('payroll', CO, { name: 'Sam' }, KEY);
  const row = (over: Partial<SealedEmployee> = {}): SealedEmployee => ({
    id: 'emp_sam', accountId: CO, inbox: null, wrappingPublicKey: null, status: 'pending', keyEpoch: 0, sealed: SAM, ...over,
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
