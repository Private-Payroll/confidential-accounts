/**
 * **WHERE THE PRODUCT'S SERVER KEEPS A COMPANY'S OWN SEALED RECORDS, FILED BY
 * ITS SEATS - AND NOTHING HERE CAN OPEN ONE.**
 *
 * The vault records route, generalised to a company's records: each kind
 * (`COMPANY_RECORD_KINDS`) and id has versions in order, every version sealed on
 * a device under a fresh key wrapped to each signer, and signed by the seat
 * that filed it (`signCompanyFiling`). Before it files one, this server checks
 * what it can without a key (check S):
 *
 *   · the person is signed in and a member of the company;
 *   · the signature covers exactly this company, kind, id, version, key epoch
 *     and bytes;
 *   · the key that signed is the one the company's seat directory holds for
 *     this person, in an entry their own wallet signed, and their seat's role
 *     may file this kind (`filerSeatOf`);
 *   · the key epoch is the company's current one, so a device still holding a
 *     key rotated away cannot file a record nobody can open;
 *   · the version is the next.
 *
 * **A DEVICE MAKES ITS OWN CHECK ON EVERY READ** (`HttpCompanyRecordStore`),
 * against the chain its own wallet read: this server is not taken at its word.
 */
import express from 'express';
import type { SealedAccount } from '../core/types.js';
import {
  assertCompanyRecordId, assertCompanyRecordKind, assertWireVersionNumber, fromCompanyWire, toCompanyWire,
  verifiedCompanyFiler, type CompanyRecordKind, type CompanyRecordStore, type SealedCompanyRecord,
} from '../midnight/sealed-record-wire.js';
import { FILING_REFUSAL } from '../midnight/seat-directory.js';
import { CHAIN_UNREAD, filerSeatNow, type DirectoryNow } from './seat-directory-route.js';
import { assertTheNextVersion, VaultPoolVersionAlreadyFiled } from '../midnight/vault-pool.js';

/** The largest body one company record may be. */
export const COMPANY_RECORD_BODY_LIMIT = '16mb';

/**
 * **A COMPANY'S RECORDS KEPT IN THIS PROCESS ONLY**, for development and tests:
 * every version in order, nothing changed, and the same named refusals every
 * store raises.
 */
export class MemoryCompanyRecordStore implements CompanyRecordStore {
  private readonly filed = new Map<string, SealedCompanyRecord[]>();
  private key = (company: string, kind: CompanyRecordKind, id: string) => `${company}\u0000${kind}\u0000${id}`;
  async get(company: string, kind: CompanyRecordKind, id: string) {
    const all = this.filed.get(this.key(company, kind, id));
    return all?.[all.length - 1] ?? null;
  }
  async versions(company: string, kind: CompanyRecordKind, id: string) {
    return [...(this.filed.get(this.key(company, kind, id)) ?? [])];
  }
  async at(company: string, kind: CompanyRecordKind, id: string, version: number) {
    return (this.filed.get(this.key(company, kind, id)) ?? []).find((r) => r.version === version) ?? null;
  }
  async put(rec: SealedCompanyRecord) {
    const k = this.key(rec.company, rec.kind, rec.id);
    const all = this.filed.get(k) ?? [];
    const newest = all[all.length - 1]?.version ?? null;
    if (newest !== null && rec.version <= newest) throw new VaultPoolVersionAlreadyFiled(rec.id, rec.version);
    assertTheNextVersion(rec.id, newest, rec.version);
    this.filed.set(k, [...all, rec]);
  }
}

/** Thrown by a store asked to file a record under an id another company's record already has. */
export class CompanyRecordIdTaken extends Error {
  constructor(readonly kind: CompanyRecordKind, readonly id: string) {
    super(`${kind} ${id} is another company's, so nothing was filed`);
    this.name = 'CompanyRecordIdTaken';
  }
}

/** What the service's main store keeps of people (`store.ts`): every version of each, filed one at a time. */
export interface PeopleStore {
  personVersions(id: string): SealedCompanyRecord[];
  filePerson(rec: SealedCompanyRecord): 'version-already-filed' | 'not-the-next-version' | 'another-company' | null;
}

/**
 * **ONE STORE OF A COMPANY'S RECORDS, WITH ITS PEOPLE KEPT IN THE SERVICE'S
 * MAIN STORE** and every other kind in `others`. People are kept there because
 * the service's older payroll code reads a person without waiting, and that
 * store is the only copy of each: nothing here copies a person anywhere else.
 * A person is served only to the company whose payroll they are on.
 */
export const withPeopleIn = (people: PeopleStore, others: CompanyRecordStore): CompanyRecordStore => {
  const ofCompany = (company: string, id: string) => people.personVersions(id).filter((r) => r.company === company);
  return {
    get: async (c, k, i) => (k !== 'person' ? others.get(c, k, i) : ofCompany(c, i).at(-1) ?? null),
    versions: async (c, k, i) => (k !== 'person' ? others.versions(c, k, i) : ofCompany(c, i)),
    at: async (c, k, i, v) => (k !== 'person' ? others.at(c, k, i, v) : ofCompany(c, i).find((r) => r.version === v) ?? null),
    put: async (rec) => {
      if (rec.kind !== 'person') return others.put(rec);
      const refused = people.filePerson(rec);
      if (refused === 'another-company') throw new CompanyRecordIdTaken(rec.kind, rec.id);
      if (refused !== null) throw new VaultPoolVersionAlreadyFiled(rec.id, rec.version);
    },
  };
};

/** What filing a company record answered: the status and the body a route sends. */
export interface FilingAnswer { readonly status: number; readonly body: Record<string, unknown> }

/** What filing a company record needs of the service. */
export interface FilingDeps {
  readonly records: CompanyRecordStore;
  readonly accountOf: (accountId: string) => SealedAccount | null;
  /** The company's seat directory against the chain now (`seat-directory-route.ts` `directoryOf`). */
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
}

/**
 * **ONE COMPANY RECORD VERSION, CHECKED AND FILED, OR REFUSED** - check S, the
 * key epoch and the next version, as the record route makes them. Every route
 * that files a company record files it through here, so there is one check.
 */
export const fileCompanyRecord = async (
  deps: FilingDeps, person: unknown, n: { company: string; kind: CompanyRecordKind; id: string }, pathVersion: unknown, message: unknown,
): Promise<FilingAnswer> => {
  const account = deps.accountOf(n.company);
  if (typeof person !== 'string' || account === null) return { status: 404, body: { error: 'account not found' } };
  let rec: SealedCompanyRecord;
  let digest: string;
  try {
    const version = assertWireVersionNumber(pathVersion);
    const got = fromCompanyWire(message, { ...n, version });
    rec = got.sealed;
    digest = got.wire.digest;
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
  const filer = verifiedCompanyFiler(rec);
  if (filer === null) {
    return { status: 403, body: {
      refused: 'not-signed',
      error: 'a company record is signed by the seat that files it, over exactly this record, and this one is not. Nothing was filed.',
    } };
  }
  let now: DirectoryNow;
  try { now = await deps.directoryOf(n.company); } catch (e) { return { status: 503, body: { error: CHAIN_UNREAD(e) } }; }
  const seat = filerSeatNow(now, person, filer, n.kind);
  if (typeof seat === 'string') {
    const remedy = seat === 'no-entry'
      ? ' Set up your vault keys again on your own device: that enters your seat in the company\'s directory.'
      : '';
    return { status: 403, body: { refused: seat, error: `this record was not filed, because ${FILING_REFUSAL[seat]}.${remedy}` } };
  }
  if (rec.keyEpoch !== account.keyEpoch) {
    return { status: 422, body: {
      refused: 'not-the-current-epoch',
      error: `this record is sealed under key epoch ${rec.keyEpoch} and the company's key is at epoch ${account.keyEpoch}, so nobody could open it with the company's current key. Nothing was filed. Open the company again and file it under its current key.`,
    } };
  }
  const unreadable = (e: unknown): FilingAnswer => ({ status: 502, body: { error: `the record could not be read: ${(e as Error)?.message ?? String(e)}` } });
  let next: number;
  try { next = ((await deps.records.get(n.company, n.kind, n.id))?.version ?? 0) + 1; } catch (e) { return unreadable(e); }
  const taken = `version ${rec.version} of this record is already filed. Read it again and build the change on what it holds now.`;
  if (rec.version < next) return { status: 409, body: { refused: 'version-already-filed', kind: n.kind, id: n.id, version: rec.version, error: taken } };
  if (rec.version > next) {
    return { status: 422, body: { refused: 'not-the-next-version', kind: n.kind, id: n.id, version: rec.version, error: `the next version of this record is ${next}. Read it again and build the change on what it holds now.` } };
  }
  try {
    await deps.records.put(rec);
  } catch (e) {
    if (e instanceof CompanyRecordIdTaken) {
      return { status: 409, body: { refused: 'another-companys-record', kind: n.kind, id: n.id, error: `${e.message}. Choose another id for a new ${n.kind}.` } };
    }
    if ((e as Error)?.name === 'VaultPoolVersionAlreadyFiled') {
      return { status: 409, body: { refused: 'version-already-filed', kind: n.kind, id: n.id, version: rec.version, error: taken } };
    }
    return { status: 503, body: { error: `version ${rec.version} was not confirmed filed: ${(e as Error)?.message ?? String(e)}` } };
  }
  return { status: 201, body: { filed: true, kind: n.kind, id: n.id, version: rec.version, digest } };
};

export const companyRecordsRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly records: CompanyRecordStore;
  readonly accountOf: (accountId: string) => SealedAccount | null;
  /** The company's seat directory, as every filing this server holds makes it against the chain now. */
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
}): express.Router => {
  const router = express.Router();
  const base = '/api/accounts/:id/records/:kind/:rid';

  const named = (req: express.Request, res: express.Response): { company: string; kind: CompanyRecordKind; id: string } | null => {
    try {
      return { company: String(req.params.id), kind: assertCompanyRecordKind(req.params.kind), id: assertCompanyRecordId(req.params.rid) };
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return null;
    }
  };
  const unreadable = (res: express.Response, e: unknown) =>
    res.status(502).json({ error: `the record could not be read: ${(e as Error)?.message ?? String(e)}` });

  router.get(base, deps.signedIn, deps.member, async (req, res) => {
    const n = named(req, res);
    if (!n) return;
    try {
      const rec = await deps.records.get(n.company, n.kind, n.id);
      res.status(200).json({ kind: n.kind, id: n.id, filed: rec === null ? null : toCompanyWire(rec) });
    } catch (e) { unreadable(res, e); }
  });

  router.get(`${base}/versions`, deps.signedIn, deps.member, async (req, res) => {
    const n = named(req, res);
    if (!n) return;
    try {
      res.status(200).json({ kind: n.kind, id: n.id, versions: (await deps.records.versions(n.company, n.kind, n.id)).map(toCompanyWire) });
    } catch (e) { unreadable(res, e); }
  });

  router.get(`${base}/:version`, deps.signedIn, deps.member, async (req, res) => {
    const n = named(req, res);
    if (!n) return;
    let version: number;
    try { version = assertWireVersionNumber(req.params.version); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    try {
      const rec = await deps.records.at(n.company, n.kind, n.id, version);
      res.status(200).json({ kind: n.kind, id: n.id, version, filed: rec === null ? null : toCompanyWire(rec) });
    } catch (e) { unreadable(res, e); }
  });

  router.put(`${base}/:version`, deps.signedIn, deps.member, express.json({ limit: COMPANY_RECORD_BODY_LIMIT }), async (req, res) => {
    const n = named(req, res);
    if (!n) return;
    /*
     * A person is filed only through the routes that say what each change of a
     * person is - an invitation, a status, an admission, making yourself
     * payable (`people-route.ts`, `invitations-route.ts`) - so no second door
     * files one past their rules. A person is still read here like any record.
     */
    if (n.kind === 'person') {
      res.status(405).json({ refused: 'not-this-route', error: 'a person is filed through the people routes, as an invitation, a status, an admission or making yourself payable, and never here. Nothing was filed.' });
      return;
    }
    const answer = await fileCompanyRecord(deps, (req as { userId?: unknown }).userId, n, req.params.version, req.body);
    res.status(answer.status).json(answer.body);
  });

  return router;
};
