/**
 * **ONE COMPANY, TWO SEATS AND A STRANGER, OVER REAL HTTP**, for the tests of
 * what people do on their own devices. The directory, record, invitation and
 * people routes are mounted in a throwaway app behind a stand-in for the
 * sign-in and the member gate, over a store holding two companies. Ada is an
 * admin of Acme, Bo an approver of it; Eve holds the only seat of another
 * company. Every entry is signed by a real wallet's committee key, and every
 * request a device sends is recorded.
 */
import { aDevicesRosterMemory } from '../testing/a-roster-a-seat-filed.js';
import { expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import { directoryHere, type DirectoryHere } from 'vaults-web-shared/vault-page-doors.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { newSigningKeypair, newSymmetricKey, sign, type Hex } from '../core/crypto.js';
import { MemoryStore } from '../core/store.js';
import { inboxPublicKey } from '../core/sealed-records.js';
import type { SealedAccount } from '../core/types.js';
import { seatDirectoryRoutes, directoryOf, type DirectoryChainRead } from './seat-directory-route.js';
import { companyRecordsRoutes, MemoryCompanyRecordStore, withTheRosterIn } from './company-records-route.js';
import type { PersonStanding, SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { invitationRoutes } from './invitations-route.js';
import { ownsPersonIn, peopleRoutes } from './people-route.js';
import type { ChainHolders, DirectoryEntry, DirectoryFiling } from '../midnight/seat-directory.js';
import { directoryChangeMessage } from '../midnight/seat-directory.js';
import type { InvitationSend, InvitingCompany, InvitingSeat } from 'vaults-web-shared/invitation-on-device.js';

export const CO = 'acc_invites';
export const OTHER = 'acc_invites_other';
export const LABEL = `co_${'a7'.repeat(32)}` as CompanyLabel;
export const OTHER_LABEL = `co_${'a8'.repeat(32)}` as CompanyLabel;
export const ADDRESS = 'b7'.repeat(32) as never;
export const OTHER_ADDRESS = 'b8'.repeat(32) as never;
export const KEY = newSymmetricKey();
export const ORIGIN = 'https://payroll.example';

export interface Seat extends InvitingSeat { person: string; seat: string; entry: DirectoryEntry; n: number }
export const seatOf = (person: string, n: number, label = LABEL, address = ADDRESS): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const seat = n.toString(16).padStart(2, '0').repeat(32);
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  const statement = signDirectoryEntry(identity, label, address, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  return { n, person, seat, signingSecret: signing.secret, committeeKey, statement, entry: { person, committeeKey, statement } };
};
export const ADA = seatOf('ada', 1);
export const BO = seatOf('bo', 2);
export const EVE = seatOf('eve', 9, OTHER_LABEL, OTHER_ADDRESS);

const accountOf = (id: string, members: string[], label: CompanyLabel, address: string): SealedAccount => ({
  id, createdAt: 'now', keyEpoch: 0, threshold: 1, signerCount: 2, memberUserIds: members, pendingSigners: [], wrappedKeys: [],
  inboxPublicKey: inboxPublicKey(KEY, id), sealedRoster: { iv: '', tag: '', body: '' }, sealedPolicy: { iv: '', tag: '', body: '' },
  companyLabel: label as never, contractAddress: address,
} as SealedAccount);

export const ACME: InvitingCompany = { id: CO, name: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: inboxPublicKey(KEY, CO), keyEpoch: 0, viewingKey: KEY };

export const store = new MemoryStore();
/** The company's records other than its roster - its people among them - as the server keeps them. */
export const peopleRecords = new MemoryCompanyRecordStore();
/** The person `id` as the company's records hold them now: their newest version, or null. */
export const newestPerson = async (id: string): Promise<SealedCompanyRecord | null> => {
  const company = await peopleRecords.companyOfPerson(id);
  return company === null ? null : peopleRecords.get(company, 'person', id);
};
/** Every version of the person `id` the company's records hold, oldest first. */
export const personVersions = async (id: string): Promise<readonly SealedCompanyRecord[]> => {
  const company = await peopleRecords.companyOfPerson(id);
  return company === null ? [] : peopleRecords.versions(company, 'person', id);
};
/** The next version of the person `id`, written by the service itself and signed by no seat: what no device may believe. */
export const aVersionNoSeatSigned = async (id: string, status: PersonStanding): Promise<void> => {
  const newest = (await newestPerson(id))!;
  const { filedBy: _signature, ...unsigned } = newest;
  await peopleRecords.put({ ...unsigned, version: newest.version + 1, facts: { ...newest.facts!, status } });
};
export const metered: string[] = [];
export const refusals: string[] = [];
/** Every request any device sent: its method, its path and its body. */
export const wire: string[] = [];
let base = '';
let chain: ChainHolders | null = null;
/** The chain as the server reads it, each company's account on its own once both are set up; `chain` while they are. */
export const chains = new Map<string, ChainHolders | null>();
const chainRead: DirectoryChainRead = async (id) => (chains.has(id) ? chains.get(id)! : chain);

/** A device signed in as `person`; the directory route takes PUT, so a POST to it is sent as one. */
export function sendAs(person: string | null): InvitationSend {
  return async (path, init) => {
    const method = path.includes('/directory/') ? 'PUT' : init.method;
    wire.push(`${method} ${path} ${init.body ?? ''}`);
    const r = await fetch(base + path, {
      method, ...(init.body === undefined ? {} : { body: init.body }),
      headers: { 'content-type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}
export const fromAda = sendAs('ada');

/**
 * What a seat's device reads of Acme, afresh at each call, to believe its
 * records: every directory filing the service holds, and the chain as the test
 * sets it, read in place of the person's own wallet. Ada's seat is the one the
 * account was deployed with.
 */
export const acmeReads = {
  /** A device that has read none of Acme's roster before: a fresh memory at every read. */
  get believed() { return aDevicesRosterMemory(); },
  filings: async () => store.directoryFilingsOf(CO),
  holders: async () => {
    const c = await chainRead(CO, [ADA.seat, BO.seat]);
    if (c === null) throw new Error('the test has the company on no chain');
    return { ...c.seats, approvals: c.approvals, adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ADDRESS };
  },
};

/**
 * Acme's seat directory as a seat's device believes it, read afresh at each
 * call: every filing the service holds, the chain as the test sets it, and Ada's
 * and Bo's wallets' own statements of their records keys.
 */
export const acmeDirectory = (attestedBy: readonly Seat[] = [ADA, BO]): Promise<DirectoryHere> => directoryHere({
  accountId: CO, label: LABEL,
  ...acmeReads,
  attested: async () => attestedBy.map((s) => ({
    committeeKey: s.committeeKey,
    statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat),
  })),
});

export const DANAS_ADDRESS = `mn_shield-addr_test1${'q'.repeat(60)}`;
/** Dana's payee code, as her own wallet signs it for a company. */
export const danasCode = (label: CompanyLabel = LABEL, person = 'dana', address = DANAS_ADDRESS): JoinCode =>
  signJoinCode(identityFromSecret(new Uint8Array(32).fill(77)), label, person, { kind: 'payee', address, payslipKey: 'ab'.repeat(32) });
export const DANA = { name: 'Dana Whitfield', email: 'dana@acme.co', title: 'Engineer', asset: 'TEST', baseAmount: 620000n, startDate: '2026-10-01' };

/** What a file mounting routes of its own beside these is handed: the same gates, records and directory. */
export interface MountedBeside {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly records: ReturnType<typeof withTheRosterIn>;
  readonly directoryOf: (accountId: string) => ReturnType<typeof directoryOf>;
}

/**
 * Mounts the routes before the file's tests run, enters the three seats, and
 * closes the server after. `beside` mounts a file's own routes on the same app,
 * behind the same gates.
 */
export function aCompanyOfTwoSeats(beside?: (app: express.Express, deps: MountedBeside) => void): void {
  let server: ReturnType<express.Express['listen']>;
  beforeAll(async () => {
    store.putAccount(accountOf(CO, ['ada', 'bo'], LABEL, ADDRESS));
    store.putAccount(accountOf(OTHER, ['eve'], OTHER_LABEL, OTHER_ADDRESS));
    const app = express();
    app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
    const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
    const member: express.RequestHandler = (req, res, next) => (store.getAccount(String(req.params.id))?.memberUserIds.includes(req.userId!)
      ? next() : res.status(404).json({ error: 'account not found' }));
    /* The service's own person gate, over the company's records as this test keeps them. */
    const ownsPerson = ownsPersonIn(() => peopleRecords, (company, person) => store.getAccount(company)?.memberUserIds.includes(person) ?? false);
    const records = withTheRosterIn(store, peopleRecords);
    app.use(seatDirectoryRoutes({ signedIn, member, store, chain: chainRead }));
    app.use(companyRecordsRoutes({ signedIn, member, records, accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, chainRead, id) }));
    app.use(invitationRoutes({
      signedIn, member, store, records: () => records, directoryOf: (id) => directoryOf(store, chainRead, id),
      meterOffer: async (req) => { metered.push(String(req.params.id)); return true; },
      recordRefusal: (method, path, status, kind) => { refusals.push(`${status} ${method} ${path} ${kind}`); },
    }));
    app.use(peopleRoutes({
      signedIn, member, ownsPerson, store, records: () => records, people: () => peopleRecords, directoryOf: (id) => directoryOf(store, chainRead, id),
    }));
    /* The handover and the invitation list, as the whole server serves them, for an admitting device. */
    app.get('/api/employees/:id/handover', signedIn, ownsPerson, (req, res) => { res.json({ inbox: store.handoverFor(String(req.params.id)) }); });
    app.get('/api/accounts/:id/invites', signedIn, member, (req, res) => {
      res.json(store.listInvites(String(req.params.id)).map(({ token: _t, acceptanceHash: _a, offer: _o, handover: _h, ...rest }) => rest));
    });
    beside?.(app, { signedIn, member, records, directoryOf: (id) => directoryOf(store, chainRead, id) });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const seated = (seats: Seat[]): ChainHolders => ({ seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1 });
    chain = seated([ADA, BO]);
    for (const [s, v] of [[ADA, 1], [BO, 2]] as const) {
      expect((await sendAs(s.person)(`/api/accounts/${CO}/directory/${v}`, { method: 'POST', body: JSON.stringify({ company: CO, version: v, change: { kind: 'claim', entry: s.entry } } satisfies DirectoryFiling) })).status).toBe(201);
    }
    /* Bo is an approver: a quorum of one, the chain's approvals, names his role. */
    const unsigned = { kind: 'role', seat: BO.seat, role: 'approver', threshold: 1, signatures: [] } as const;
    const message = directoryChangeMessage(CO, 3, unsigned as never);
    expect((await sendAs('ada')(`/api/accounts/${CO}/directory/3`, { method: 'POST', body: JSON.stringify({ company: CO, version: 3, change: { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature: sign(message, ADA.signingSecret) }] } }) })).status).toBe(201);
    chain = seated([EVE]);
    expect((await sendAs('eve')(`/api/accounts/${OTHER}/directory/1`, { method: 'POST', body: JSON.stringify({ company: OTHER, version: 1, change: { kind: 'claim', entry: EVE.entry } }) })).status).toBe(201);
    chain = seated([ADA, BO]);
    chains.set(CO, seated([ADA, BO]));
    chains.set(OTHER, seated([EVE]));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
}
