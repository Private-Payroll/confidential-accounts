/**
 * A list read of a company's vault records, made under the company's account, answers each record exactly as reading
 * that vault record alone does, in the order asked. Who may read is decided as it is for one record, from the chain's
 * pin of each vault to its company's account and that company's members, for every vault and record named, and each
 * vault must be the company's own: one that is not refuses the whole list, before any record is read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Hex } from '../core/crypto.js';
import { vaultRecordsRoutes, type MayTouchVaultRecords } from './vault-records-route.js';
import { mountVaultRecords, signersOfTheVaultsCompany, type CompanyRoster } from './vault-records-authority.js';
import { READ_AT_ONCE } from './read-at-once.js';
import { MemorySealedPoolStore, type SealedPool, type SealedPoolStore } from '../midnight/vault-pool.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';

const OURS = 'a1'.repeat(32);
const OURS_TOO = 'a2'.repeat(32);
const THEIRS = 'b1'.repeat(32);
const NOBODYS = 'c1'.repeat(32);
const CO = 'acc_vaults';
const OTHER = 'acc_vaults_other';
/* Each vault's account as the chain pins it: two of this company's, one of the other company's, one of no company's. */
const ACCOUNT: Record<string, Hex> = { [OURS]: 'e1'.repeat(32), [OURS_TOO]: 'e1'.repeat(32), [THEIRS]: 'e2'.repeat(32) };
/* Eve is a member of both companies, so only the company named in the path tells her two companies' vaults apart. */
const COMPANIES: CompanyRoster[] = [
  { id: CO, contractAddress: 'e1'.repeat(32), memberUserIds: ['ada', 'eve'] },
  { id: OTHER, contractAddress: 'e2'.repeat(32), memberUserIds: ['bob', 'eve'] },
];

const version = (vault: string, v: number): SealedPool => ({ vault, version: v, sealed: { iv: '0a'.repeat(12), tag: '', body: '0b'.repeat(v) }, wrapped: [] });

const stores: Record<WireRecord, MemorySealedPoolStore> = {
  pool: new MemorySealedPoolStore(), 'deposit-journal': new MemorySealedPoolStore(),
  'payment-journal': new MemorySealedPoolStore(), 'nonce-secret': new MemorySealedPoolStore(),
};
/*
 * How many records were read, who was asked about which records, and how often each vault's pin was read from the
 * chain, so a refusal can be shown to read nothing, to ask about every record, and to read each vault's pin once.
 */
let reads = 0;
const asked: Array<{ vault: string; records: readonly WireRecord[]; ofCompany?: string }> = [];
const pinsRead: string[] = [];
const counted = (inner: SealedPoolStore): SealedPoolStore => ({
  get: async (v) => { reads += 1; return inner.get(v); },
  versions: async (v) => { reads += 1; return inner.versions(v); },
  at: async (v, n) => { reads += 1; return inner.at!(v, n); },
  put: (v, rec) => inner.put(v, rec),
});
const pinOf = async (vault: Hex): Promise<Hex | null> => { pinsRead.push(vault); return ACCOUNT[vault] ?? null; };
const decided = signersOfTheVaultsCompany({ accountOf: pinOf, companies: () => COMPANIES, mayFileUnder: () => true });
const mayTouch: MayTouchVaultRecords = async (person, vault, records, act, filer, ofCompany) => {
  asked.push({ vault, records, ...(ofCompany === undefined ? {} : { ofCompany }) });
  return decided(person, vault, records, act, filer, ofCompany);
};

let base = '';
let server: ReturnType<express.Express['listen']>;
let mounted = '';
let mountedServer: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  for (const [vault, record, n] of [[OURS, 'pool', 3], [OURS, 'deposit-journal', 1], [OURS_TOO, 'pool', 2], [THEIRS, 'pool', 1]] as const) {
    for (let v = 1; v <= n; v += 1) await stores[record].put(vault, version(vault, v));
  }
  const app = express();
  /* The stand-in for the sign-in: the person is whoever the header names, and nobody without it. */
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  app.use(express.json());
  app.use(vaultRecordsRoutes({ records: { of: (r) => counted(stores[r]) }, mayTouch }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /* The same records as the server mounts them: behind its sign-in, which is the only thing here that names the person. */
  const whole = express();
  mountVaultRecords(whole, {
    signedIn: (req, res, next) => {
      const p = req.headers['x-test-person'];
      if (typeof p !== 'string') { res.status(401).json({ error: 'sign in' }); return; }
      req.userId = p;
      next();
    },
    records: { of: (r) => stores[r] }, accountOf: pinOf, companies: () => COMPANIES, mayFileUnder: () => true,
  });
  await new Promise<void>((resolve) => { mountedServer = whole.listen(0, '127.0.0.1', () => resolve()); });
  mounted = `http://127.0.0.1:${(mountedServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => mountedServer.close(() => resolve()));
});

const as = async (person: string | null, path: string, body?: unknown, at = base) => {
  const r = await fetch(at + path, {
    method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
const readList = (person: string | null, records: unknown[], company = CO, at = base) => as(person, `/api/accounts/${company}/vault-records/read`, { records }, at);

describe('a list read of the company\'s vault records', () => {
  it('answers each of three vault records exactly as reading that record alone answers it, in the order asked', async () => {
    /* RED WHEN: a vault record in the list is answered other than as its own read answers it, or the answers come in another order. */
    const named = [{ vault: OURS_TOO, record: 'pool' }, { vault: OURS, record: 'deposit-journal' }, { vault: OURS, record: 'pool' }];
    const alone = await Promise.all(named.map(async (r) => (await as('ada', `/api/vaults/${r.vault}/records/${r.record}`)).body));
    const listed = await readList('ada', named);
    expect(listed.status).toBe(200);
    expect(listed.body.records).toEqual(alone);
    expect((alone[2] as { filed: { version: number } }).filed.version).toBe(3);
  });

  it('answers every version of a vault record, when asked for every one, exactly as reading its versions alone answers them', async () => {
    /* RED WHEN: a vault record asked for with every version is answered with its newest only, or otherwise than its own read of versions. */
    const versions = (await as('ada', `/api/vaults/${OURS}/records/pool/versions`)).body;
    const listed = await readList('ada', [{ vault: OURS, record: 'pool', every: true }, { vault: OURS_TOO, record: 'pool' }]);
    expect(listed.status).toBe(200);
    expect((listed.body.records as unknown[])[0]).toEqual(versions);
    expect((versions as { versions: unknown[] }).versions).toHaveLength(3);
  });

  it('answers a vault record never filed in its place as its own read answers it', async () => {
    /* RED WHEN: a record never filed fails the whole list, or is answered other than as its own read answers it. */
    const missing = (await as('ada', `/api/vaults/${OURS_TOO}/records/nonce-secret`)).body;
    const listed = await readList('ada', [{ vault: OURS, record: 'pool' }, { vault: OURS_TOO, record: 'nonce-secret' }]);
    expect(listed.status).toBe(200);
    expect(missing).toEqual({ record: 'nonce-secret', filed: null });
    expect((listed.body.records as unknown[])[1]).toEqual(missing);
  });

  it('asks who may read once for each vault named, over every record of it named, as this company\'s', async () => {
    /* RED WHEN: who may read is asked without a record named, once per record, or without the company the list is read under. */
    asked.length = 0;
    await readList('ada', [{ vault: OURS, record: 'pool' }, { vault: OURS, record: 'deposit-journal' }, { vault: OURS_TOO, record: 'pool' }, { vault: OURS, record: 'pool', every: true }]);
    expect(asked).toEqual([
      { vault: OURS, records: ['pool', 'deposit-journal'], ofCompany: CO }, { vault: OURS_TOO, records: ['pool'], ofCompany: CO },
    ]);
  });

  it('reads each vault\'s pin from the chain once, however many of its records the list names', async () => {
    /* RED WHEN: what the list reads of the chain grows with the records of one vault rather than with the vaults named. */
    pinsRead.length = 0;
    const listed = await readList('ada', [{ vault: OURS, record: 'pool' }, { vault: OURS, record: 'deposit-journal' }]);
    expect(listed.status).toBe(200);
    expect(pinsRead).toEqual([OURS]);
    pinsRead.length = 0;
    expect((await readList('ada', [{ vault: OURS, record: 'pool' }, { vault: OURS_TOO, record: 'pool' }, { vault: OURS_TOO, record: 'deposit-journal' }])).status).toBe(200);
    expect([...pinsRead].sort()).toEqual([OURS, OURS_TOO].sort());
  });

  it('refuses a list naming one vault of another company whole, even to a member of both, and reads nothing', async () => {
    /* RED WHEN: a vault another company's account holds is read under this company's account, or the rest of the list is read. */
    reads = 0;
    expect((await as('eve', `/api/vaults/${THEIRS}/records/pool`)).status).toBe(200);
    reads = 0;
    const listed = await readList('eve', [{ vault: OURS, record: 'pool' }, { vault: THEIRS, record: 'pool' }]);
    expect(listed.status).toBe(403);
    expect(reads).toBe(0);
  });

  it('refuses a list naming a vault no company holds, or a vault this person may not read, whole, and reads nothing', async () => {
    /* RED WHEN: a vault no company's account holds, or one of a company this person is not a member of, is read. */
    reads = 0;
    expect((await readList('ada', [{ vault: OURS, record: 'pool' }, { vault: NOBODYS, record: 'pool' }])).status).toBe(403);
    expect((await readList('bob', [{ vault: OURS, record: 'pool' }])).status).toBe(403);
    expect(reads).toBe(0);
  });

  it('refuses a list of more records than one read holds, or of none, or naming what no vault keeps, whole, and reads nothing', async () => {
    /* RED WHEN: a list longer than the bound, an empty one, or one with a record no vault keeps is read rather than refused. */
    reads = 0;
    asked.length = 0;
    const tooMany = await readList('ada', Array.from({ length: READ_AT_ONCE + 1 }, () => ({ vault: OURS, record: 'pool' })));
    expect(tooMany.status).toBe(400);
    expect((await readList('ada', [])).status).toBe(400);
    expect((await readList('ada', [{ vault: OURS, record: 'not-a-record' }])).status).toBe(400);
    expect(reads).toBe(0);
    expect(asked).toEqual([]);
    expect((await readList('ada', Array.from({ length: READ_AT_ONCE }, () => ({ vault: OURS, record: 'pool' })))).status).toBe(200);
  });

  it('serves nobody signed out, as the server mounts it behind its sign-in', async () => {
    /* RED WHEN: the list read is reached on the server without the sign-in in front of it. */
    expect((await readList(null, [{ vault: OURS, record: 'pool' }], CO, mounted)).status).toBe(401);
    const listed = await readList('ada', [{ vault: OURS, record: 'pool' }, { vault: THEIRS, record: 'pool' }], CO, mounted);
    expect(listed.status).toBe(403);
    expect((await readList('ada', [{ vault: OURS, record: 'pool' }], CO, mounted)).status).toBe(200);
  });
});
