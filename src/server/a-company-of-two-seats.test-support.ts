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
import { directoryHere, directoryWithItsRecordsHere, type DirectoryHere, type DirectoryHereDeps, type DirectoryRead } from 'vaults-web-shared/vault-page-doors.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { aChainAnchor, anchoredOver, anchorFunctions, heldBy, anchorSentInATest } from '../testing/record-tree-double.js';
import { anchorServiceFor, anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { sealRoster } from '../core/roster-record.js';
import { signedFoundingState } from '../core/founding-state.js';
import { newStateBlinding, sealState } from '../core/account.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { newSigningKeypair, newSymmetricKey, sign, type Hex } from '../core/crypto.js';
import { MemoryStore } from '../core/store.js';
import { inboxPublicKey } from '../core/sealed-records.js';
import type { SealedAccount } from '../core/types.js';
import { seatDirectoryRoutes, directoryOf, type DirectoryChainRead } from './seat-directory-route.js';
import { companyRecordsRoutes, MemoryCompanyRecordStore, withTheRosterIn } from './company-records-route.js';
import {
  signCompanyFiling, toCompanyWire, type CompanyRecordKind, type PersonStanding, type SealedCompanyRecord, type WireRecord,
} from '../midnight/sealed-record-wire.js';
import { companyRecordEntry, type ManifestEntryBody } from '../midnight/record-manifest.js';
import { invitationRoutes } from './invitations-route.js';
import { ownsPersonIn, peopleRoutes } from './people-route.js';
import type { ChainHolders, DirectoryEntry, DirectoryFiling } from '../midnight/seat-directory.js';
import { directoryChangeMessage, directoryEntryMade } from '../midnight/seat-directory.js';
import { invitationIdOf, newInvitationToken, signSeatInvitation } from '../core/invitation.js';
import type { InvitationSend, InvitingCompany, InvitingSeat } from 'vaults-web-shared/invitation-on-device.js';
import { manifestServiceFor, recordsEnteredFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { filedAsIn, recordManifestRoutes } from './record-manifest-route.js';
import { MemorySealedPoolStore, type SealedPoolStore } from '../midnight/vault-pool.js';
import { leavesOfTheContract, seatOpenedFor } from '../testing/directory-seats.js';

export const CO = 'acc_invites';
export const OTHER = 'acc_invites_other';
export const LABEL = `co_${'a7'.repeat(32)}` as CompanyLabel;
export const OTHER_LABEL = `co_${'a8'.repeat(32)}` as CompanyLabel;
export const ADDRESS = 'b7'.repeat(32) as never;
export const OTHER_ADDRESS = 'b8'.repeat(32) as never;
export const KEY = newSymmetricKey();
export const ORIGIN = 'https://payroll.example';

export interface Seat extends InvitingSeat { person: string; seat: string; entry: DirectoryEntry; n: number }
/** Every header a device asked a request to carry, with its address: the transport here sends fixed headers, so what a device asked for is read here. */
export const headersAsked: Array<{ readonly path: string; readonly headers: string }> = [];

/**
 * A device signed in as `person`, reading the service's answers as the page's
 * own `api` does: a refusal throws, with the service's words.
 */
export const apiAs = (person: string) => async (path: string, init?: RequestInit): Promise<any> => {
  if (init?.headers !== undefined) headersAsked.push({ path, headers: JSON.stringify(init.headers) });
  const r = await sendAs(person)(path, { method: (init?.method ?? 'GET') as never, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
  if (r.status >= 300) throw Object.assign(new Error(String((r.body as { error?: string }).error ?? r.status)), { status: r.status, body: r.body });
  return r.body;
};

/** A seat of `company`, invited by the seat `invitedBy` signs with; a company's founding seat is invited by nobody. */
export const seatOf = (person: string, n: number, label = LABEL, address = ADDRESS, company = CO, invitedBy?: { readonly signingSecret: string }): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  /* The seat as a seating device makes it: its leaf commits to this wallet key, and its opening shows that. */
  const { seat, opening } = seatOpenedFor(committeeKey, n);
  const statement = signDirectoryEntry(identity, label, address, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  return {
    n, person, seat, signingSecret: signing.secret, committeeKey, statement, opening, held: { role: 'admin', retired: false },
    /* Its proof sealed under the company's viewing key, which every member's device here holds. */
    entry: directoryEntryMade({
      company, person, committeeKey, signed: statement, opening, signingSecret: signing.secret, viewingKey: KEY,
      ...(invitedBy === undefined ? {} : { invited: signSeatInvitation({
        company, invitation: invitationIdOf(newInvitationToken()), person, name: person, role: 'admin', leaf: seat as Hex,
      }, invitedBy.signingSecret as Hex) }),
    }),
    /* Every filing this seat makes is entered in its company's records, over the manifest route mounted below. */
    entered: recordsEnteredFor(manifestServiceFor(apiAs(person)), company, signing.secret),
  };
};
export const ADA = seatOf('ada', 1);
export const BO = seatOf('bo', 2, LABEL, ADDRESS, CO, ADA);
export const EVE = seatOf('eve', 9, OTHER_LABEL, OTHER_ADDRESS, OTHER);

const accountOf = (id: string, members: string[], label: CompanyLabel, address: string): SealedAccount => ({
  id, createdAt: 'now', keyEpoch: 0, threshold: 1, signerCount: 2, memberUserIds: members, pendingSigners: [], wrappedKeys: [],
  inboxPublicKey: inboxPublicKey(KEY, id), sealedRoster: { iv: '', tag: '', body: '' }, sealedPolicy: { iv: '', tag: '', body: '' },
  companyLabel: label as never, contractAddress: address,
} as SealedAccount);

export const ACME: InvitingCompany = { id: CO, name: 'Acme', label: LABEL, account: ADDRESS, keyEpoch: 0, viewingKey: KEY };
/** The company's inbox under its only key: what an offer made here names, worked out on the device. */
export const ACME_INBOX = inboxPublicKey(KEY, CO);

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
/**
 * **A COMPANY RECORD FILED BY `seat`, AS ITS DEVICE FILES ONE**: the next
 * version of `id`, signed by the seat and kept where the service keeps the
 * company's records, and the entry that names it for the seat to enter. A
 * `policy` by default, which an admin files; an approver files a `proposal`.
 */
export const aRecordFiledBy = async (seat: Seat, id: string, kind: CompanyRecordKind = 'policy', company = CO): Promise<ManifestEntryBody> => {
  const version = (await peopleRecords.versions(company, kind, id)).length + 1;
  const rec = signCompanyFiling({
    company, kind, id, version, keyEpoch: 0, sealed: { iv: id, tag: String(version), body: seat.person }, wrapped: [],
  }, seat.signingSecret as Hex);
  await peopleRecords.put(rec);
  return companyRecordEntry(rec);
};
/**
 * **A VERSION OF A PERSON A SEAT'S DEVICE FILES AT `path` AND ENTERS** in the
 * company's records once the service keeps it, as a device's own filing does:
 * the service's answer.
 */
export const personFiledBy = async (seat: Seat, path: string, rec: SealedCompanyRecord) => {
  const r = await sendAs(seat.person)(path, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) });
  if (r.status === 201) await seat.entered.enter([companyRecordEntry(rec)]);
  return r;
};
/** The next version of the person `id`, written by the service itself and signed by no seat: what no device may believe. */
export const aVersionNoSeatSigned = async (id: string, status: PersonStanding): Promise<void> => {
  const newest = (await newestPerson(id))!;
  const { filedBy: _signature, ...unsigned } = newest;
  await peopleRecords.put({ ...unsigned, version: newest.version + 1, facts: { ...newest.facts!, status } });
};
/** Each vault's records as the server keeps them, one store per kind of vault record. */
const vaultStores = new Map<WireRecord, SealedPoolStore>();
export const vaultRecords = { of: (record: WireRecord): SealedPoolStore => vaultStores.get(record) ?? vaultStores.set(record, new MemorySealedPoolStore()).get(record)! };
export const metered: string[] = [];
export const refusals: string[] = [];
/** Every request any device sent: its method, its path and its body. */
export const wire: string[] = [];
let base = '';
let chain: ChainHolders | null = null;
/** The chain as the server reads it, each company's account on its own once both are set up; `chain` while they are. */
export const chains = new Map<string, ChainHolders | null>();
/* The server's read of who holds each account: the server never opens an entry, so it needs no leaf of anybody's. */
const chainRead: DirectoryChainRead = async (id) => {
  const c = chains.has(id) ? chains.get(id)! : chain;
  return c === null ? null : { ...c };
};

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
 * The anchor Acme's account holds on the test's chain: one head, moved on by
 * the account's own `anchorHeadOf`, each call kept with who held the account
 * as the test's chain holds it when the call lands.
 */
export const acmeHeldNow = () => {
  const c = chains.has(CO) ? chains.get(CO)! : chain;
  if (c === null) throw new Error('the test has the company on no chain');
  return heldBy(c);
};
/**
 * **ACME HELD BY MORE THAN ONE KEY WHILE `go` RUNS**: its account requiring two
 * approvals, and none of its runs vouching for a head, so a device new to it
 * checks its records from the first header. Put back as it was after.
 */
export const heldByMoreThanOneKey = async <T>(go: () => Promise<T>): Promise<T> => {
  const was = chains.get(CO)!;
  chains.set(CO, { ...was, approvals: 2, seatBar: 2 });
  try {
    return await go();
  } finally {
    chains.set(CO, was);
  }
};
/** The time the test's chain sets for the next block: the test's own clock unless a test sets another. */
export const acmeClock = { now: (): number => Date.now() };
export const acmeChain = aChainAnchor(acmeHeldNow, () => acmeClock.now());
/** Acme's records as a seat's device holds them: the test chain's anchors, and the tree the service serves. */
const acmeAnchored: DirectoryHereDeps['anchored'] = (directory, asked) => anchoredOver(apiAs('ada'), CO, acmeChain.read)(directory, asked);

/**
 * What a seat's device reads of Acme, afresh at each call, to believe its
 * records: every directory filing the service holds, and the chain as the test
 * sets it, read in place of the person's own wallet. Ada's seat is the one the
 * account was deployed with.
 */
export const acmeReads = {
  /** Acme's records as the head the test's chain holds them, over the tree routes mounted below. */
  get anchored() { return acmeAnchored; },
  /* Acme's viewing key, which every member's device here holds and opens each entry's proof with. */
  viewingKey: KEY,
  filings: async () => store.directoryFilingsOf(CO),
  /* What a device's vault worker makes of each entry's opening, with the account's own compiled `signerLeaf`. */
  leaves: leavesOfTheContract,
  holders: async () => {
    const c = await chainRead(CO, [ADA.seat, BO.seat]);
    if (c === null) throw new Error('the test has the company on no chain');
    return {
      ...c.seats, approvals: c.approvals, vaultThresholds: [], policyBar: c.seatBar > c.approvals ? c.seatBar : null, seatBar: c.seatBar,
      adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ADDRESS,
    };
  },
};

/* A seat's wallet statement of its records key is a fixed fact of the seat, so it is made the first time it is read and kept: deriving the wallet identity costs seconds over a test's many directory reads. */
const recordsKeyStatements = new Map<string, ReturnType<typeof signRecordsKey>>();
const recordsKeyStatementOf = (s: Seat): ReturnType<typeof signRecordsKey> => {
  let made = recordsKeyStatements.get(s.seat);
  if (made === undefined) {
    made = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat);
    recordsKeyStatements.set(s.seat, made);
  }
  return made;
};

/**
 * Acme's seat directory as a seat's device believes it, read afresh at each
 * call: every filing the service holds, the chain as the test sets it, and Ada's
 * and Bo's wallets' own statements of their records keys.
 */
export const acmeDirectoryDeps = (attestedBy: readonly Seat[] = [ADA, BO]): DirectoryHereDeps => ({
  accountId: CO, label: LABEL,
  ...acmeReads,
  anchored: acmeAnchored,
  attested: async () => attestedBy.map((s) => ({
    committeeKey: s.committeeKey,
    statement: recordsKeyStatementOf(s),
  })),
});
/** Acme's directory, with its records for what a read asks, as a device whose roster carries the statements of `attestedBy` reads it. */
export const acmeDirectoryAttestedBy = (attestedBy: readonly Seat[]): DirectoryRead => (asked) => directoryHere(acmeDirectoryDeps(attestedBy), asked);
export const acmeDirectory: DirectoryRead = acmeDirectoryAttestedBy([ADA, BO]);
/** Acme's directory with the records it was replayed with, stopped or not: what an anchoring device reads (`directoryWithItsRecordsHere`). */
export const acmeDirectoryWithItsFold = (asked?: RecordsAsked, attestedBy: readonly Seat[] = [ADA, BO]): Promise<DirectoryHere> =>
  directoryWithItsRecordsHere(acmeDirectoryDeps(attestedBy), asked);

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

/** What Acme is founded with: its first roster and first state, each signed by Ada's seat; a file may give its own of either. */
export interface AcmeFounding {
  readonly roster?: () => SealedCompanyRecord;
  readonly state?: () => SealedCompanyRecord;
  /** What a file does with Acme's first roster and state kept and not yet anchored, as a device may before its first anchor. */
  readonly beforeTheAnchor?: () => Promise<void>;
  /** Given, Acme's first anchor is attempted and what came of it handed here, instead of failing the file's setup when it is refused. */
  readonly anchored?: (outcome: { readonly anchored: number } | Error) => void;
}

/** Acme's first state, as Ada's founding device made and signed it. */
export const ACME_STATE = signedFoundingState(CO, sealState({ entries: [] }, newStateBlinding(), KEY, 0), ADA.signingSecret as Hex);

/**
 * **ACME FOUNDED ON THE TEST'S CHAIN FROM ADA'S DEVICE**, while her seat is
 * the account's only one: her first roster and first state kept where the
 * service keeps them, entered by her seat with her directory entry, and
 * anchored as the company's first batch, as her device anchors on its way in.
 */
const foundAcme = async (founding: AcmeFounding): Promise<void> => {
  const roster = founding.roster?.() ?? signCompanyFiling(sealRoster(CO, {
    name: 'Acme',
    signers: [{ id: 'sig_ada', leafCommitment: ADA.seat as Hex, userId: 'ada', name: 'ada', status: 'active', signingPublicKey: ADA.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin' } as never],
  }, 1, 0, KEY), ADA.signingSecret as Hex);
  expect(store.fileRoster(roster)).toBeNull();
  await peopleRecords.put(founding.state?.() ?? ACME_STATE);
  await founding.beforeTheAnchor?.();
  const anchoring = anchorTheRecordsHere({
    accountId: CO,
    material: { signingSecret: ADA.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
    manifest: manifestServiceFor(apiAs('ada')),
    tree: treeServiceFor(apiAs('ada')),
    directory: () => acmeDirectoryWithItsFold({}, [ADA]),
    directoryFilings: async () => store.directoryFilingsOf(CO),
    onChain: acmeChain.onChain,
    service: {
      foundingRecords: anchorServiceFor(apiAs('ada')).foundingRecords,
      sealedProposals: async (company) => store.listProposals(company),
      callState: async () => ({ account: ADDRESS }) as never,
      sendProven: async (_company, tx) => {
        const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
        acmeChain.move(previous, batch, held, tag);
      },
    },
    builder: { ...anchorFunctions, anchor: anchorSentInATest },
  });
  if (founding.anchored === undefined) {
    await anchoring;
    return;
  }
  founding.anchored(await anchoring.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
};

/**
 * Mounts the routes before the file's tests run, enters the three seats, and
 * closes the server after. `beside` mounts a file's own routes on the same app,
 * behind the same gates. Acme is founded from Ada's device before Bo's seat is
 * held (`foundAcme`), with `founding`'s roster when a file gives one.
 */
export function aCompanyOfTwoSeats(beside?: (app: express.Express, deps: MountedBeside) => void, founding: AcmeFounding = {}): void {
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
    app.use(recordManifestRoutes({
      signedIn, member, store, directoryOf: (id) => directoryOf(store, chainRead, id),
      filedAs: filedAsIn({ company: records, vault: vaultRecords, runs: (c) => store.listRuns(c), proposals: (c) => store.listProposals(c) }),
    }));
    beside?.(app, { signedIn, member, records, directoryOf: (id) => directoryOf(store, chainRead, id) });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const seated = (seats: Seat[]): ChainHolders => ({
      seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1, seatBar: 1,
    });
    /* Ada founds Acme alone: her entry, then her first roster and state anchored while hers is the account's only seat. */
    chain = seated([ADA]);
    expect((await sendAs('ada')(`/api/accounts/${CO}/directory/1`, { method: 'POST', body: JSON.stringify({ company: CO, version: 1, change: { kind: 'claim', entry: ADA.entry } } satisfies DirectoryFiling) })).status).toBe(201);
    await foundAcme(founding);
    chain = seated([ADA, BO]);
    expect((await sendAs('bo')(`/api/accounts/${CO}/directory/2`, { method: 'POST', body: JSON.stringify({ company: CO, version: 2, change: { kind: 'claim', entry: BO.entry } } satisfies DirectoryFiling) })).status).toBe(201);
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
