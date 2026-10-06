/**
 * **ONE COMPANY, TWO SEATS AND A STRANGER, OVER REAL HTTP**, for the tests of
 * what people do on their own devices. The directory, record, invitation and
 * people routes are mounted in a throwaway app behind a stand-in for the
 * sign-in and the member gate, over a store holding two companies. Ada is an
 * admin of Acme, Bo an approver of it; Eve holds the only seat of another
 * company. Every entry is signed by a real wallet's committee key, and every
 * request a device sends is recorded.
 */
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
import { companyRecordsRoutes, MemoryCompanyRecordStore, withPeopleIn } from './company-records-route.js';
import { invitationRoutes } from './invitations-route.js';
import { peopleRoutes } from './people-route.js';
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
 * Acme's seat directory as a seat's device believes it, read afresh at each
 * call: every filing the service holds, the chain as the test sets it, and Ada's
 * and Bo's wallets' own statements of their records keys.
 */
export const acmeDirectory = (attestedBy: readonly Seat[] = [ADA, BO]): Promise<DirectoryHere> => directoryHere({
  accountId: CO, label: LABEL,
  filings: async () => store.directoryFilingsOf(CO),
  holders: async () => {
    const c = await chainRead(CO, [ADA.seat, BO.seat]);
    if (c === null) throw new Error('the test has the company on no chain');
    return { ...c.seats, approvals: c.approvals, adoptedVaults: [], account: ADDRESS };
  },
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

/** Mounts the routes before the file's tests run, enters the three seats, and closes the server after. */
export function aCompanyOfTwoSeats(): void {
  let server: ReturnType<express.Express['listen']>;
  beforeAll(async () => {
    store.putAccount(accountOf(CO, ['ada', 'bo'], LABEL, ADDRESS));
    store.putAccount(accountOf(OTHER, ['eve'], OTHER_LABEL, OTHER_ADDRESS));
    const app = express();
    app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
    const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
    const member: express.RequestHandler = (req, res, next) => (store.getAccount(String(req.params.id))?.memberUserIds.includes(req.userId!)
      ? next() : res.status(404).json({ error: 'account not found' }));
    const ownsPerson: express.RequestHandler = (req, res, next) => {
      const p = store.getEmployee(String(req.params.id));
      return p !== null && store.getAccount(p.accountId)?.memberUserIds.includes(req.userId!) ? next() : res.status(404).json({ error: 'not found' });
    };
    const records = withPeopleIn(store, new MemoryCompanyRecordStore());
    app.use(seatDirectoryRoutes({ signedIn, member, store, chain: chainRead }));
    app.use(companyRecordsRoutes({ signedIn, member, records, accountOf: (id) => store.getAccount(id), directoryOf: (id) => directoryOf(store, chainRead, id) }));
    app.use(invitationRoutes({
      signedIn, member, store, records: () => records, directoryOf: (id) => directoryOf(store, chainRead, id),
      meterOffer: async (req) => { metered.push(String(req.params.id)); return true; },
      recordRefusal: (method, path, status, kind) => { refusals.push(`${status} ${method} ${path} ${kind}`); },
    }));
    app.use(peopleRoutes({ signedIn, member, ownsPerson, store, records: () => records, directoryOf: (id) => directoryOf(store, chainRead, id) }));
    /* The handover and the invitation list, as the whole server serves them, for an admitting device. */
    app.get('/api/employees/:id/handover', signedIn, ownsPerson, (req, res) => { res.json({ inbox: store.getEmployee(String(req.params.id))?.inbox ?? null }); });
    app.get('/api/accounts/:id/invites', signedIn, member, (req, res) => {
      res.json(store.listInvites(String(req.params.id)).map(({ token: _t, acceptanceHash: _a, offer: _o, handover: _h, ...rest }) => rest));
    });
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
