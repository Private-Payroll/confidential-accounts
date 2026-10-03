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
import { FILING_REFUSAL, filerSeatOf, type Directory } from '../midnight/seat-directory.js';
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

export const companyRecordsRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly records: CompanyRecordStore;
  readonly accountOf: (accountId: string) => SealedAccount | null;
  /** The company's seat directory, as every filing this server holds makes it. */
  readonly directoryOf: (accountId: string) => Directory;
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
    const person = (req as { userId?: unknown }).userId;
    const account = deps.accountOf(n.company);
    if (typeof person !== 'string' || account === null) { res.status(404).json({ error: 'account not found' }); return; }
    let rec: SealedCompanyRecord;
    let digest: string;
    try {
      const version = assertWireVersionNumber(req.params.version);
      const got = fromCompanyWire(req.body, { ...n, version });
      rec = got.sealed;
      digest = got.wire.digest;
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    const filer = verifiedCompanyFiler(rec);
    if (filer === null) {
      res.status(403).json({
        refused: 'not-signed',
        error: 'a company record is signed by the seat that files it, over exactly this record, and this one is not. Nothing was filed.',
      });
      return;
    }
    const seat = filerSeatOf(deps.directoryOf(n.company), person, filer, n.kind);
    if (typeof seat === 'string') {
      const remedy = seat === 'no-entry'
        ? ' Set up your vault keys again on your own device: that enters your seat in the company\'s directory.'
        : '';
      res.status(403).json({ refused: seat, error: `this record was not filed, because ${FILING_REFUSAL[seat]}.${remedy}` });
      return;
    }
    if (rec.keyEpoch !== account.keyEpoch) {
      res.status(422).json({
        refused: 'not-the-current-epoch',
        error: `this record is sealed under key epoch ${rec.keyEpoch} and the company's key is at epoch ${account.keyEpoch}, so nobody could open it with the company's current key. Nothing was filed. Open the company again and file it under its current key.`,
      });
      return;
    }
    let next: number;
    try { next = ((await deps.records.get(n.company, n.kind, n.id))?.version ?? 0) + 1; } catch (e) { unreadable(res, e); return; }
    const taken = `version ${rec.version} of this record is already filed. Read it again and build the change on what it holds now.`;
    if (rec.version < next) { res.status(409).json({ refused: 'version-already-filed', kind: n.kind, id: n.id, version: rec.version, error: taken }); return; }
    if (rec.version > next) {
      res.status(422).json({ refused: 'not-the-next-version', kind: n.kind, id: n.id, version: rec.version, error: `the next version of this record is ${next}. Read it again and build the change on what it holds now.` });
      return;
    }
    try {
      await deps.records.put(rec);
    } catch (e) {
      if ((e as Error)?.name === 'VaultPoolVersionAlreadyFiled') {
        res.status(409).json({ refused: 'version-already-filed', kind: n.kind, id: n.id, version: rec.version, error: taken });
        return;
      }
      res.status(503).json({ error: `version ${rec.version} was not confirmed filed: ${(e as Error)?.message ?? String(e)}` });
      return;
    }
    res.status(201).json({ filed: true, kind: n.kind, id: n.id, version: rec.version, digest });
  });

  return router;
};
