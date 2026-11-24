/**
 * **A READER IS ANSWERED BY ONE RULE, WHICHEVER ROUTE ASKS.** What a reader of a company may read is decided in one place
 * (`aReaderMay`), asked either for a proof of a record (its entry in the manifest) or for its body. The proofs and the
 * newest versions of the directory and of the records the company was founded with are served to every reader, because
 * its wallet judges the roster by them; every other name, and every body, is served only for a kind its grant reads. This
 * table holds what the single read, the list read and the manifest's reads answer for each reader and each name, over
 * real HTTP on the real routes, so moving the rule never widens or narrows what a reader is served.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { stateRecordId, FOUNDING_KEY_EPOCH } from '../core/founding-state.js';
import { ROSTER_ID } from '../core/roster-record.js';
import { MemoryStore } from '../core/store.js';
import { DIRECTORY_RECORD, type ManifestEntryBody } from '../midnight/record-manifest.js';
import { aReaderMay, memberOrReaderReading, type AccountWithReaders, type ReadersKept } from './readers-route.js';
import { companyRecordsRoutes } from './company-records-route.js';
import { recordManifestRoutes } from './record-manifest-route.js';
import { COMPANY_RECORD_KINDS, type CompanyRecordKind } from '../midnight/sealed-record-wire.js';

const CO = 'acc_one_rule';
const ROOT = '00'.repeat(32);
/* Each reader's kinds: none, grants and roster, the founding state's kind alone, people, runs and proposals, and every kind. */
const KINDS: Readonly<Record<string, readonly CompanyRecordKind[]>> = {
  none: [], grants: ['grants', 'roster'], state: ['state'], person: ['person'], payroll: ['run', 'proposal'], every: [...COMPANY_RECORD_KINDS],
};
const READERS: ReadersKept = { sequence: 1, userIds: Object.keys(KINDS), kinds: KINDS };
const account = { id: CO, memberUserIds: ['ada'], readers: READERS } as AccountWithReaders;
const FOUNDING_STATE = stateRecordId(FOUNDING_KEY_EPOCH);

type Name = Pick<ManifestEntryBody, 'store' | 'kind' | 'id'>;
const NAMES: readonly Name[] = [
  ...COMPANY_RECORD_KINDS.flatMap((kind) => [FOUNDING_STATE, ROSTER_ID, 'rec_other01'].map((id) => ({ store: 'company' as const, kind, id }))),
  { store: 'run', kind: 'run', id: 'run_other01' }, { store: 'proposal', kind: 'proposal', id: 'prp_other01' },
  { store: 'run', kind: 'person', id: 'run_other01' }, { store: 'directory', kind: DIRECTORY_RECORD, id: DIRECTORY_RECORD },
  { store: 'vault', kind: 'pool', id: 'ab'.repeat(32) },
];
const COMPANY_NAMES = NAMES.filter((n) => n.store === 'company');

/* Today's answers, as rules: a proof of the directory and of the founding records by name for every reader, and every other name, and every body, by the kind. */
const FOUNDING = new Set([`company ${'state'} ${FOUNDING_STATE}`, `company roster ${ROSTER_ID}`]);
const byKind = (kinds: readonly string[], n: Name): boolean => n.store !== 'vault' && (n.store === 'company' || n.kind === n.store) && kinds.includes(n.kind);
const proofMay = (kinds: readonly string[], n: Name): boolean => n.store === 'directory' || FOUNDING.has(`${n.store} ${n.kind} ${n.id}`) || byKind(kinds, n);

const store = new MemoryStore();
let base = '';
let server: ReturnType<express.Express['listen']>;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const signedIn: express.RequestHandler = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'sign in' }));
  const member = memberOrReaderReading((id, user) => id === CO && user === 'ada', (id) => (id === CO ? account : null));
  const nothing = { get: async () => null, versions: async () => [], at: async () => null, put: async () => undefined };
  app.use(companyRecordsRoutes({ signedIn, member, records: nothing as never, accountOf: () => null, directoryOf: async () => { throw new Error('not read here'); } } as never));
  app.use(recordManifestRoutes({ signedIn, member, store, directoryOf: async () => { throw new Error('not read here'); }, filedAs: async () => null }));
  app.get('/api/accounts/:id/runs', signedIn, member, (_req, res) => { res.json([]); });
  app.get('/api/accounts/:id/proposals', signedIn, member, (_req, res) => { res.json([]); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); }); });

const status = async (person: string, method: string, path: string, body?: unknown): Promise<number> => (await fetch(`${base}/api/accounts/${CO}${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})).status;

/** The readers and names a read answers wrongly, each as `reader: name`. */
const wrongly = async (answer: (reader: string, n: Name) => Promise<boolean>, may: (kinds: readonly string[], n: Name) => boolean, names: readonly Name[]): Promise<string[]> => {
  const wrong: string[] = [];
  for (const reader of Object.keys(KINDS)) {
    for (const n of names) if (await answer(reader, n) !== may(KINDS[reader]!, n)) wrong.push(`${reader}: ${n.store} ${n.kind} ${n.id}`);
  }
  return wrong;
};

describe('A READER ASKING FOR THE BODY OF A RECORD', () => {
  it('is answered the single read of a company record, its versions and one version, only for a kind its grant reads, the founding records too', async () => {
    /* RED WHEN: the single read of a record's body is served by a rule other than the grant's kinds, so a reader reads a body its grant does not name. */
    for (const rest of ['', '/versions', '/1']) {
      expect(await wrongly(async (r, n) => (await status(r, 'GET', `/records/${n.kind}/${n.id}${rest}`)) === 200, byKind, COMPANY_NAMES), rest).toEqual([]);
    }
  });

  it('is answered the list read of company records only for the kinds its grant reads, the founding records too', async () => {
    /* RED WHEN: the list read serves a body of a kind the grant does not read, or refuses one it does. */
    expect(await wrongly(async (r, n) => (await status(r, 'POST', '/records/read', { records: [{ kind: n.kind, id: n.id }] })) === 200, byKind, COMPANY_NAMES)).toEqual([]);
  });

  it('is answered the lists of runs and proposals only when its grant reads that kind', async () => {
    /* RED WHEN: a reader is served the list of runs or proposals without the grant's kind for it. */
    const lists: readonly [string, Name][] = [['/runs', NAMES.find((n) => n.store === 'run' && n.kind === 'run')!], ['/proposals', NAMES.find((n) => n.store === 'proposal')!]];
    for (const [path, n] of lists) {
      expect(await wrongly(async (r) => (await status(r, 'GET', path)) === 200, byKind, [n]), path).toEqual([]);
    }
  });

  it('is told the founding state\'s body is not served to it, though its proof is, by the same reader', async () => {
    /* RED WHEN: the body of the founding state is served by the rule that serves its proof to every reader. */
    expect(await status('grants', 'GET', `/records/state/${FOUNDING_STATE}`)).toBe(404);
    expect(await status('grants', 'POST', '/records/read', { records: [{ kind: 'state', id: FOUNDING_STATE }] })).toBe(403);
    expect(await status('grants', 'POST', '/manifest/newest', { records: [{ store: 'company', kind: 'state', id: FOUNDING_STATE }] })).toBe(200);
  });
});

describe('A READER ASKING FOR THE PROOF OF A RECORD', () => {
  it('is answered the newest version entered of a name, and its proof, for the directory and the founding records and otherwise by the kind', async () => {
    /* RED WHEN: the manifest serves a name by a rule other than the proof's: the directory and the founding records for every reader, any other by its kind. */
    expect(await wrongly(async (r, n) => (await status(r, 'POST', '/manifest/newest', { records: [n] })) !== 403, proofMay, NAMES)).toEqual([]);
    expect(await wrongly(async (r, n) => (await status(r, 'POST', '/manifest/tree/proofs', { root: ROOT, records: [n], kinds: [] })) !== 403, proofMay, NAMES)).toEqual([]);
  });

  it('is answered a whole kind of proofs only for a kind its grant reads, the founding state\'s kind included', async () => {
    /* RED WHEN: a reader asking every record of a kind is served it because its founding record is served by name. */
    const kinds = NAMES.map((n) => ({ ...n, id: '' }));
    expect(await wrongly(async (r, n) => (await status(r, 'POST', '/manifest/tree/proofs', { root: ROOT, records: [], kinds: [{ store: n.store, kind: n.kind }] })) !== 403,
      (k, n) => n.store === 'directory' || byKind(k, n), kinds)).toEqual([]);
  });
});

describe('THE ONE RULE ANSWERS AS EACH ROUTE DOES', () => {
  it('says a proof is served by name for the directory and the founding records, and a body only by its kind', () => {
    /* RED WHEN: the rule and the routes disagree: a route serves what the rule refuses, or refuses what it serves. */
    for (const kinds of Object.values(KINDS)) {
      for (const n of NAMES) {
        expect(aReaderMay(kinds, n, 'proof'), `${n.store} ${n.kind} ${n.id}`).toBe(proofMay(kinds, n));
        expect(aReaderMay(kinds, n, 'body'), `${n.store} ${n.kind} ${n.id}`).toBe(byKind(kinds, n));
      }
    }
  });
});
