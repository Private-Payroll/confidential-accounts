/**
 * A list read of what a company's people handed over answers each person exactly as reading that person's handover
 * alone does, in the order asked. Each person is checked as the read of one person checks them, as on the payroll of a
 * company the signed-in person is a member of, and as this company's: one person who is not refuses the whole list,
 * before anything is read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Invite, SealedAccount } from '../core/types.js';
import { MemoryCompanyRecordStore } from './company-records-route.js';
import { ownsPersonBy, peopleRoutes, personHeldIn, type PeopleRouteStore } from './people-route.js';
import { READ_AT_ONCE } from './read-at-once.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';

const CO = 'acc_handovers';
const OTHER = 'acc_handovers_other';
const MEMBERS: Record<string, string[]> = { [CO]: ['ada', 'eve'], [OTHER]: ['bob', 'eve'] };

const person = (company: string, id: string): SealedCompanyRecord => ({
  company, kind: 'person', id, version: 1, keyEpoch: 0, sealed: { iv: '0a'.repeat(12), tag: '', body: '0b' }, wrapped: [],
});
/* What each person handed over, sealed to the company's inbox: two of this company's have, one has not yet. */
const HANDED: Record<string, Invite['handover']> = {
  p1: { ephemeral: '01'.repeat(32), iv: '0c'.repeat(12), tag: '', body: 'aa' },
  p3: { ephemeral: '03'.repeat(32), iv: '0d'.repeat(12), tag: '', body: 'cc' },
  q1: { ephemeral: '09'.repeat(32), iv: '0e'.repeat(12), tag: '', body: 'ee' },
};
/* What each vendor handed over, by the invitation it waits on: one of this company's vendors has, one of another company's has. */
const vendorInvite = (accountId: string, subjectId: string, handover: Invite['handover']): Invite => ({ accountId, subjectId, kind: 'vendor', handover } as Invite);
const VENDOR_INVITES: Invite[] = [vendorInvite(CO, 'v1', HANDED.p1), vendorInvite(OTHER, 'w1', HANDED.q1)];
let reads = 0;
const store: PeopleRouteStore = {
  getAccount: (id) => (MEMBERS[id] ? { id, memberUserIds: MEMBERS[id] } as SealedAccount : null),
  handoverFor: (id) => { reads += 1; return HANDED[id] ?? null; },
  listInvites: (company) => VENDOR_INVITES.filter((i) => i.accountId === company),
  putInvite: () => undefined,
  setHandover: () => false,
};
const people = new MemoryCompanyRecordStore();

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  for (const rec of [person(CO, 'p1'), person(CO, 'p2'), person(CO, 'p3'), person(OTHER, 'q1')]) await people.put(rec);
  const app = express();
  /* The stand-in for the sign-in: the person is whoever the header names, and nobody without it. */
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
  const member: express.RequestHandler = (req, res, next) => (MEMBERS[String(req.params.id)]?.includes(req.userId!)
    ? next() : res.status(404).json({ error: 'account not found' }));
  /* The service's own person gate, over the company's records as this test keeps them. */
  const heldFor = personHeldIn(() => people, (company, user) => MEMBERS[company]?.includes(user) ?? false);
  const ownsPerson = ownsPersonBy(heldFor);
  app.use(peopleRoutes({
    signedIn, member, ownsPerson, heldFor, store, records: () => people, people: () => people,
    directoryOf: async () => { throw new Error('a read asks nothing of the directory'); },
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const as = async (who: string | null, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-person': who } : {}) },
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
const readList = (who: string | null, named: unknown[], company = CO) => as(who, `/api/accounts/${company}/handovers`, { people: named });
const readVendors = (who: string | null, named: unknown[], company = CO) => as(who, `/api/accounts/${company}/handovers`, { vendors: named });

describe('a list read of what the company\'s people handed over', () => {
  it('answers each of three people exactly as reading that person\'s handover alone answers it, in the order asked', async () => {
    /* RED WHEN: a person in the list is answered other than as their own handover read answers them, or out of order. */
    const named = ['p3', 'p2', 'p1'];
    const alone = await Promise.all(named.map(async (p) => (await as('ada', `/api/employees/${p}/handover`)).body));
    const listed = await readList('ada', named);
    expect(listed.status).toBe(200);
    expect(listed.body.handovers).toEqual(alone);
    expect(alone[1]).toEqual({ inbox: null });
    expect(alone[2]).toEqual({ inbox: HANDED.p1 });
  });

  it('refuses a list naming one person of another company whole, even to a member of both, and reads nothing', async () => {
    /* RED WHEN: a person on another company's payroll is read under this company's account, or the rest of the list is read. */
    expect((await as('eve', '/api/employees/q1/handover')).status).toBe(200);
    reads = 0;
    const listed = await readList('eve', ['p1', 'q1']);
    expect(listed.status).toBe(404);
    expect(reads).toBe(0);
  });

  it('refuses a list naming a person no company holds whole, as reading that person alone refuses it, and reads nothing', async () => {
    /* RED WHEN: a person no company's records hold is answered rather than refused. */
    expect((await as('ada', '/api/employees/nobody/handover')).status).toBe(404);
    reads = 0;
    expect((await readList('ada', ['p1', 'nobody'])).status).toBe(404);
    expect(reads).toBe(0);
  });

  it('refuses one person\'s handover to someone signed out, or not a member of the company that holds them', async () => {
    /* RED WHEN: the read of one person's handover lets through someone signed out, or a signed-in person of another company only. */
    expect((await as(null, '/api/employees/p1/handover')).status).toBe(401);
    expect((await as('ada', '/api/employees/q1/handover')).status).toBe(404);
    expect((await as('bob', '/api/employees/q1/handover')).status).toBe(200);
  });

  it('serves nobody signed out, and a person who is not the company\'s member nothing', async () => {
    /* RED WHEN: someone signed out, or a member of another company only, is served this company's people's handovers. */
    reads = 0;
    expect((await readList(null, ['p1'])).status).toBe(401);
    expect((await readList('bob', ['p1'])).status).toBe(404);
    expect(reads).toBe(0);
  });

  it('refuses a list of more people than one read holds, or of none, or naming what is not a person, whole, and reads nothing', async () => {
    /* RED WHEN: a list longer than the bound, an empty one, or one with a name no person can have is read rather than refused. */
    reads = 0;
    expect((await readList('ada', Array.from({ length: READ_AT_ONCE + 1 }, () => 'p1'))).status).toBe(400);
    expect((await readList('ada', [])).status).toBe(400);
    expect((await readList('ada', ['p1', '../p2'])).status).toBe(400);
    expect(reads).toBe(0);
    expect((await readList('ada', Array.from({ length: READ_AT_ONCE }, () => 'p1'))).status).toBe(200);
  });
});

describe('a list read of what the company\'s vendors handed over', () => {
  it('answers each vendor exactly as reading that vendor\'s handover alone answers it, in the order asked', async () => {
    /* RED WHEN: a vendor in the list is answered other than as its own handover read answers it, or out of order. */
    const named = ['v2', 'v1'];
    const alone = await Promise.all(named.map(async (v) => (await as('ada', `/api/accounts/${CO}/vendors/${v}/handover`)).body));
    const listed = await readVendors('ada', named);
    expect(listed.status).toBe(200);
    expect(listed.body.handovers).toEqual(alone);
    expect(alone).toEqual([{ inbox: null }, { inbox: HANDED.p1 }]);
  });

  it('answers nothing for a vendor another company invited, even to a member of both', async () => {
    /* RED WHEN: what another company's vendor handed over is read under this company's account. */
    expect((await readVendors('eve', ['w1'], OTHER)).body.handovers).toEqual([{ inbox: HANDED.q1 }]);
    expect((await readVendors('eve', ['w1'])).body.handovers).toEqual([{ inbox: null }]);
  });

  it('serves nobody signed out, and a person who is not the company\'s member nothing', async () => {
    /* RED WHEN: someone signed out, or a member of another company only, is served this company's vendors' handovers. */
    expect((await readVendors(null, ['v1'])).status).toBe(401);
    expect((await readVendors('bob', ['v1'])).status).toBe(404);
  });

  it('refuses a list of more vendors than one read holds, or of none, or naming what is not a vendor, or naming people too, whole', async () => {
    /* RED WHEN: a list longer than the bound, an empty one, one with a name no vendor can have, or one of people and vendors together is read. */
    expect((await readVendors('ada', Array.from({ length: READ_AT_ONCE + 1 }, () => 'v1'))).status).toBe(400);
    expect((await readVendors('ada', [])).status).toBe(400);
    expect((await readVendors('ada', ['v1', '../v2'])).status).toBe(400);
    expect((await as('ada', `/api/accounts/${CO}/handovers`, { people: ['p1'], vendors: ['v1'] })).status).toBe(400);
  });
});
