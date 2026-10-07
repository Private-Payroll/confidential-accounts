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
import { canonical } from '../core/crypto.js';
import {
  assertCompanyRecordId, assertCompanyRecordKind, assertWireVersionNumber, CompanyRecordIdTaken, fromCompanyWire, toCompanyWire,
  verifiedCompanyFiler, type CompanyRecordKind, type CompanyRecordStore, type PeopleRecords, type SealedCompanyRecord,
} from '../midnight/sealed-record-wire.js';
import { FILING_REFUSAL } from '../midnight/seat-directory.js';
import { CHAIN_UNREAD, filerSeatNow, type DirectoryNow } from './seat-directory-route.js';
import { assertTheNextVersion, VaultPoolVersionAlreadyFiled } from '../midnight/vault-pool.js';
import { ROSTER_ID } from '../core/roster-record.js';

export { CompanyRecordIdTaken, type PeopleRecords };

/** The largest body one company record may be. */
export const COMPANY_RECORD_BODY_LIMIT = '16mb';

/**
 * **A COMPANY'S RECORDS KEPT IN THIS PROCESS ONLY**, for development and tests:
 * every version in order, nothing changed, and the same named refusals every
 * store raises.
 */
export class MemoryCompanyRecordStore implements CompanyRecordStore, PeopleRecords {
  private readonly filed = new Map<string, SealedCompanyRecord[]>();
  private key = (company: string, kind: CompanyRecordKind, id: string) => `${company}\u0000${kind}\u0000${id}`;
  async peopleOf(company: string) {
    return [...this.filed.values()]
      .map((all) => all[all.length - 1]!)
      .filter((r) => r.company === company && r.kind === 'person')
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async companyOfPerson(id: string) { return this.holderOf(id); }
  private holderOf(id: string): string | null {
    for (const all of this.filed.values()) if (all[0]!.kind === 'person' && all[0]!.id === id) return all[0]!.company;
    return null;
  }
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
    /* Checked and filed with nothing awaited between, so two companies cannot both take one person's id. */
    if (rec.kind === 'person') {
      const holder = this.holderOf(rec.id);
      if (holder !== null && holder !== rec.company) throw new CompanyRecordIdTaken(rec.kind, rec.id);
    }
    const k = this.key(rec.company, rec.kind, rec.id);
    const all = this.filed.get(k) ?? [];
    const newest = all[all.length - 1]?.version ?? null;
    if (newest !== null && rec.version <= newest) throw new VaultPoolVersionAlreadyFiled(rec.id, rec.version);
    assertTheNextVersion(rec.id, newest, rec.version);
    this.filed.set(k, [...all, rec]);
  }
}


/**
 * What the service's main store keeps of each company's roster (`store.ts`):
 * every version, filed one at a time.
 */
export interface RosterStore {
  rosterVersions(company: string): SealedCompanyRecord[];
  fileRoster(rec: SealedCompanyRecord): 'version-already-filed' | 'not-the-next-version' | 'another-company' | null;
}

/**
 * **ONE STORE OF A COMPANY'S RECORDS, WITH ITS ROSTER KEPT IN THE SERVICE'S
 * MAIN STORE** and every other kind, its people among them, in `others`. The
 * roster is kept there because the service's own account record reads its
 * signers without waiting, and that store is its only copy: nothing here copies
 * it anywhere else. A roster is served only to its own company.
 */
export const withTheRosterIn = (roster: RosterStore, others: CompanyRecordStore): CompanyRecordStore => {
  const ofCompany = (company: string, id: string): SealedCompanyRecord[] =>
    (id === ROSTER_ID ? roster.rosterVersions(company) : []).filter((r) => r.company === company);
  return {
    get: async (c, k, i) => (k !== 'roster' ? others.get(c, k, i) : ofCompany(c, i).at(-1) ?? null),
    versions: async (c, k, i) => (k !== 'roster' ? others.versions(c, k, i) : ofCompany(c, i)),
    at: async (c, k, i, v) => (k !== 'roster' ? others.at(c, k, i, v) : ofCompany(c, i).find((r) => r.version === v) ?? null),
    put: async (rec) => {
      if (rec.kind !== 'roster') return others.put(rec);
      const refused = roster.fileRoster(rec);
      if (refused === 'another-company') throw new CompanyRecordIdTaken(rec.kind, rec.id);
      if (refused !== null) throw new VaultPoolVersionAlreadyFiled(rec.id, rec.version);
    },
  };
};

/** What the service's main store still holds of people filed before they moved: every version, and letting each go. */
export interface PeopleHeldElsewhere {
  peopleHeld(): Array<readonly SealedCompanyRecord[]>;
  /** Names the person's payslip key on their slips sealed before slips named one, which were found through the person. */
  nameTheKeyOnOlderSlipsOf(id: string): void;
  letGoOfPerson(id: string): void;
}

/**
 * **EVERY PERSON THE MAIN STORE STILL HOLDS, MOVED TO WHERE A COMPANY'S RECORDS
 * ARE KEPT**, one person at a time: each version filed there, or found there
 * already as exactly that version, and only then let go of here, so a person is
 * held in one place once each move finishes. A version filed there that is not
 * the one held here stops the move with the person still here, named.
 */
export const movePeopleToTheirRecords = async (from: PeopleHeldElsewhere, to: CompanyRecordStore): Promise<number> => {
  let moved = 0;
  for (const versions of from.peopleHeld()) {
    for (const rec of versions) {
      const there = await to.at(rec.company, 'person', rec.id, rec.version);
      if (there === null) await to.put(rec);
      else if (canonical(there) !== canonical(rec)) {
        throw new Error(`person ${rec.id}'s version ${rec.version} is filed with the company's records as something other than the `
          + 'version this service held, so the person was left where they were. Compare the two before moving them.');
      }
    }
    if (versions[0] !== undefined) {
      from.nameTheKeyOnOlderSlipsOf(versions[0].id);
      from.letGoOfPerson(versions[0].id);
      moved += 1;
    }
  }
  return moved;
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
    /*
     * The same for the company's roster: it changes only as a signer is admitted
     * or gives their vault keys (`signer-routes.ts`), each of which changes what
     * the service keeps in plain text of the signers with it.
     */
    if (n.kind === 'roster') {
      res.status(405).json({ refused: 'not-this-route', error: 'the company\'s roster is filed as a signer is admitted or gives their vault keys, and never here. Nothing was filed.' });
      return;
    }
    const answer = await fileCompanyRecord(deps, (req as { userId?: unknown }).userId, n, req.params.version, req.body);
    res.status(answer.status).json(answer.body);
  });

  return router;
};
