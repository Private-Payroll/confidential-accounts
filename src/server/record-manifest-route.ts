/**
 * **A COMPANY'S MANIFEST AND RECORD TREE ON THE PRODUCT'S SERVER: EVERY FILING
 * ENTERED, EVERY HEADER A SEAT ANCHORED, SERVED A PAGE OR A PROOF AT A TIME.**
 *
 * A company's records are filed in five stores, and each filing is entered here
 * by the seat that filed it: the record, its version and the digest of what the
 * filer signed, signed by that seat (`record-manifest.ts`). A seat anchoring
 * files the next header of the company's record tree here before it sends the
 * anchor to the chain (`record-tree.ts`). This server decides nothing a device
 * believes: every device checks every header against the one before it, up to
 * the head the chain holds, and every leaf against the root that head binds.
 * Before it keeps an entry or a header it makes the checks it can without a
 * key:
 *
 *   · the person is signed in and a member of the company;
 *   · the signature covers exactly that entry, or that header, for this company;
 *   · the key that signed is one an entry in the company's directory names,
 *     for a seat the chain holds now - or, for a header, in the directory as it
 *     stood at the version the header names - whoever hands it in: a device
 *     files again a header or an entry another seat signed, judged by its
 *     signature. Whether its role may file that record, or anchor, and a
 *     retired seat's boundary, are each member's device's to judge;
 *   · **an entry is the record's own filer's, for the bytes kept**: the record it
 *     names is kept here at that version (a run, kept whole, as it is kept now),
 *     its digest is the digest of what that record's filer signed, and the key
 *     that signed the entry is the one that signed the record. So no seat can
 *     enter another seat's record, or other bytes than were filed, first;
 *   · an entry is newer than every version of its record entered, and names no
 *     bytes an earlier version names, and a directory version's entry is the
 *     digest of the directory filing kept here at that version;
 *   · a header follows one kept here, and every check of it that needs no key
 *     holds (`treeHeaderFilingRefusal`).
 *
 * It serves the headers a page at a time, one read's proofs against one root in
 * one answer, the entries not yet anchored at a root, and the newest version
 * entered of each record a filer asks about; a device checks all but the last,
 * which only numbers a filer's next entry.
 */
import express from 'express';
import { z } from 'zod';
import {
  companyRecordEntry, directoryEntry, ENTRIES_AT_ONCE, entryIdOf, MANIFEST_STORES,
  manifestEntryRefusal, proposalEntry, recordKeyOf, runEntry, supersededSaid, vaultRecordEntry,
  type FiledAs, type ManifestEntry, type ManifestEntryBody,
} from '../midnight/record-manifest.js';
import { FILING_REFUSAL, filerSeatIn, type DirectoryFiling } from '../midnight/seat-directory.js';
import {
  HEADERS_AT_ONCE, headersPageOf, pendingAt, PROVEN_AT_ONCE, proofsOf, treeHeaderShapeRefusal, treeHeaderSigned, type KeptTree, type TreeHeader,
} from '../midnight/record-tree.js';
import type { Hex } from '../core/crypto.js';
import type { SealedProposal, SealedRun } from '../core/types.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS, type CompanyRecordKind, type CompanyRecordStore, type WireRecord } from '../midnight/sealed-record-wire.js';
import type { SealedPoolStore } from '../midnight/vault-pool.js';
import { anchoringSeatThen, CHAIN_UNREAD, signerSeatNow, type DirectoryNow } from './seat-directory-route.js';

/** What this route needs of the store. */
export interface ManifestRouteStore {
  enterInManifest(accountId: string, entries: readonly ManifestEntry[]): { readonly entry: ManifestEntry; readonly why: 'not-newer' | 'superseded' | 'rolled-back'; readonly newest: number } | null;
  directoryFilingsOf(accountId: string): readonly DirectoryFiling[];
  keptTreeOf(accountId: string): KeptTree;
  manifestEntryOf(accountId: string, id: string): ManifestEntry | undefined;
  newestEntered(accountId: string, recordKey: string): number;
  /** The entries of every record open at a root (`MemoryStore.entriesOpenAt`); null for a root no header kept makes. */
  entriesOpenAt(accountId: string, root: Hex): readonly ManifestEntry[] | null;
  fileTreeHeader(accountId: string, header: TreeHeader, given?: readonly ManifestEntry[]): string | null;
}

/** Where this service keeps the records an entry can name, other than the directory. */
export interface KeptRecords {
  readonly company: CompanyRecordStore;
  readonly vault: { of(record: WireRecord): SealedPoolStore };
  readonly runs: (company: string) => readonly SealedRun[];
  readonly proposals: (company: string) => readonly SealedProposal[];
}

/**
 * **THE RECORD AN ENTRY NAMES, AS THIS SERVICE KEEPS IT**: the digest of what
 * its filer signed and the filer's key, or null when it keeps no signed record
 * at that version. A run is kept whole and changed in place, so it is the run
 * as kept now; a proposal is filed once.
 */
export const filedAsIn = (kept: KeptRecords) => async (company: string, e: ManifestEntryBody): Promise<FiledAs | null> => {
  const of = (rec: { filedBy?: { publicKey: string } } | null | undefined, digest: (r: never) => string): FiledAs | null =>
    rec?.filedBy === undefined ? null : { digest: digest(rec as never), filedBy: rec.filedBy.publicKey.toLowerCase() };
  switch (e.store) {
    case 'company':
      return of(await kept.company.at(company, e.kind as CompanyRecordKind, e.id, e.version), (r) => companyRecordEntry(r).digest);
    case 'vault': {
      const store = kept.vault.of(e.kind as WireRecord);
      const rec = store.at !== undefined ? await store.at(e.id, e.version)
        : (await store.versions(e.id)).find((v) => v.version === e.version)?.sealed ?? null;
      return of(rec, (r) => vaultRecordEntry(e.kind as WireRecord, r).digest);
    }
    case 'run':
      return of(kept.runs(company).find((r) => r.id === e.id), (r) => runEntry(company, r, e.version).digest);
    case 'proposal':
      return of(kept.proposals(company).find((p) => p.id === e.id), (p) => proposalEntry(company, p).digest);
    case 'directory':
      return null;
  }
};

export const recordManifestRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: ManifestRouteStore;
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
  /** The record an entry names, as this service keeps it (`filedAsIn`). */
  readonly filedAs: (company: string, entry: ManifestEntryBody) => Promise<FiledAs | null>;
}): express.Router => {
  const router = express.Router();
  const base = '/api/accounts/:id/manifest';

  const recordName = z.object({ store: z.enum(MANIFEST_STORES), kind: z.string().max(64), id: z.string().max(128) }).strict();

  /** The newest version entered for each record asked, 0 for none: what a filer numbers its next entry from. */
  router.post(`${base}/newest`, deps.signedIn, deps.member, express.json({ limit: '128kb' }), (req, res) => {
    const company = String(req.params.id);
    const b = z.object({ records: z.array(recordName).max(ENTRIES_AT_ONCE * 4) }).strict().safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: `name at most ${ENTRIES_AT_ONCE * 4} records to read the newest version of. Nothing was read.` });
      return;
    }
    res.json({ versions: b.data.records.map((r) => deps.store.newestEntered(company, recordKeyOf(r))) });
  });

  router.post(`${base}/entries`, deps.signedIn, deps.member, express.json({ limit: '256kb' }), async (req, res) => {
    const company = String(req.params.id);
    const b = z.object({ entries: z.array(z.unknown()).min(1).max(ENTRIES_AT_ONCE) }).strict().safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: `this is not a list of one to ${ENTRIES_AT_ONCE} entries to enter. Nothing was entered.` });
      return;
    }
    for (const value of b.data.entries) {
      const why = manifestEntryRefusal(company, value);
      if (why !== null) {
        res.status(422).json({ refused: 'not-an-entry', error: `this is not an entry of this company's records: ${why}. Nothing was entered.` });
        return;
      }
    }
    const entries = b.data.entries as ManifestEntry[];
    let now: DirectoryNow;
    try {
      now = await deps.directoryOf(company);
    } catch (e) {
      res.status(503).json({ error: CHAIN_UNREAD(e) });
      return;
    }
    const filings = deps.store.directoryFilingsOf(company);
    for (const e of entries) {
      /* Judged by the entry's own signature and its signer's standing, whoever hands it in: a device files again what another seat signed. */
      const seat = signerSeatNow(now, e.filedBy.publicKey);
      if (typeof seat === 'string') {
        res.status(403).json({ refused: seat, error: `this entry is not entered: ${FILING_REFUSAL[seat]}. Nothing was entered.` });
        return;
      }
      const filing = e.store === 'directory' ? filings[e.version - 1] : undefined;
      if (e.store === 'directory' && (filing === undefined || directoryEntry(filing).digest !== e.digest)) {
        res.status(422).json({ refused: 'not-the-directory', error: 'this entry is not the digest of the company\'s directory at the '
          + 'version it names. Reload the page and anchor again. Nothing was entered.' });
        return;
      }
      if (e.store === 'directory') continue;
      const kept = await deps.filedAs(company, e);
      if (kept === null || kept.digest !== e.digest) {
        res.status(422).json({ refused: 'not-the-filed-bytes', error: `this entry names version ${e.version} of ${e.store} record ${e.id}, `
          + 'and this service keeps no signed record with exactly those bytes there. File the record first, then enter it. Nothing was entered.' });
        return;
      }
      if (kept.filedBy !== e.filedBy.publicKey.toLowerCase()) {
        res.status(403).json({ refused: 'not-the-filer', error: `this entry for ${e.store} record ${e.id} is signed by another seat than `
          + 'the one that filed the record. A record is entered by its own filer, from their device. Nothing was entered.' });
        return;
      }
    }
    const notNext = deps.store.enterInManifest(company, entries);
    if (notNext !== null) {
      const { entry, why } = notNext;
      if (why === 'superseded') {
        res.status(409).json({ refused: 'superseded', error: `${supersededSaid(entry, notNext.newest)}. Nothing was entered.` });
        return;
      }
      res.status(409).json(why === 'rolled-back'
        ? { refused: 'rolled-back', error: `the entry for version ${entry.version} of ${entry.store} record ${entry.id} names the bytes an `
          + 'earlier version of it already names, and a record never goes back to older bytes. File it as it is now, then enter that. '
          + 'Nothing was entered.' }
        : { refused: 'not-a-newer-version', error: `the entry for version ${entry.version} of ${entry.store} `
          + `record ${entry.id} is not newer than every version the company's records name. Reload the page and file it again. Nothing was entered.` });
      return;
    }
    res.status(201).json({ entered: entries.map(entryIdOf) });
  });

  router.get(`${base}/tree/headers`, deps.signedIn, deps.member, (req, res) => {
    const company = String(req.params.id);
    const q = z.object({ after: z.coerce.number().int().min(-1), limit: z.coerce.number().int().min(1).max(HEADERS_AT_ONCE).optional() })
      .safeParse({ after: req.query.after, limit: req.query.limit });
    if (!q.success) {
      res.status(400).json({ error: `name the batch to read after (\`after\`, from -1) and at most how many to read (\`limit\`, 1 to ${HEADERS_AT_ONCE}).` });
      return;
    }
    res.json(headersPageOf(deps.store.keptTreeOf(company), (id) => deps.store.manifestEntryOf(company, id), q.data.after, q.data.limit ?? HEADERS_AT_ONCE));
  });

  router.post(`${base}/tree/headers`, deps.signedIn, deps.member, express.json({ limit: '512kb' }), async (req, res) => {
    const company = String(req.params.id);
    const b = z.object({ header: z.unknown(), entries: z.array(z.unknown()).max(ENTRIES_AT_ONCE).optional() }).strict().safeParse(req.body ?? {});
    const why = b.success ? treeHeaderShapeRefusal(company, b.data.header) : 'it carries no header';
    if (why !== null || !treeHeaderSigned(b.data!.header as TreeHeader)) {
      res.status(422).json({ refused: 'not-a-header', error: 'this is not a header of this company\'s records signed by who anchors it: '
        + `${why ?? 'its signature does not cover exactly it'}. Nothing was kept.` });
      return;
    }
    const header = b.data!.header as TreeHeader;
    /*
     * The entries its changes name, handed in by a device that kept them, for where this service no longer holds them:
     * each signed as an entry of this company and named by the header, which binds it - no record bytes are asked for.
     */
    const given = (b.data!.entries ?? []) as ManifestEntry[];
    const named = new Set(header.changes.map((c) => c.leaf.entryId as string));
    for (const e of given) {
      const not = manifestEntryRefusal(company, e) ?? (named.has(entryIdOf(e)) ? null : 'no change of the header names it');
      if (not !== null) {
        res.status(422).json({ refused: 'not-the-headers-entry', error: `an entry handed in with this header is not one of its own: ${not}. Nothing was kept.` });
        return;
      }
    }
    let now: DirectoryNow;
    try {
      now = await deps.directoryOf(company);
    } catch (e) {
      res.status(503).json({ error: CHAIN_UNREAD(e) });
      return;
    }
    /* Judged by the header's own signature and its seat as the directory stood when it was signed, whoever hands it in. */
    const seat = anchoringSeatThen(now, header.anchoredBy.publicKey, header.dirVersion);
    if (typeof seat === 'string') {
      res.status(403).json({ refused: seat, error: `this header is not kept: ${FILING_REFUSAL[seat]}. Nothing was kept.` });
      return;
    }
    /*
     * Each entry handed in with it is judged as an entry entered is - by its own signature and its signer's standing -
     * as the directory stood at the version the header names: a seat that may anchor names in its header only what
     * the seats then could file, so it cannot raise another record's newest version and leave every honest later
     * version of it refused as superseded.
     */
    const then = now.at?.(header.dirVersion) ?? now.dir;
    for (const e of given) {
      const filer = filerSeatIn(then, e.filedBy.publicKey);
      if (typeof filer === 'string') {
        res.status(403).json({ refused: filer, error: `an entry handed in with this header is not kept: ${FILING_REFUSAL[filer]}. Nothing was kept.` });
        return;
      }
    }
    const refused = deps.store.fileTreeHeader(company, header, given);
    if (refused !== null) {
      res.status(422).json({ refused: 'not-the-next-header', error: `this header is not kept: ${refused}. Read the company's records `
        + 'again and anchor again. Nothing was kept.' });
      return;
    }
    res.status(201).json({ kept: true });
  });

  router.get(`${base}/tree/pending`, deps.signedIn, deps.member, (req, res) => {
    const company = String(req.params.id);
    const q = z.object({ root: z.string().regex(/^[0-9a-f]{64}$/u) }).safeParse({ root: req.query.root });
    if (!q.success) {
      res.status(400).json({ error: 'name the root to read the entries not yet anchored at (`root`, 64 lower-case hex digits).' });
      return;
    }
    const open = deps.store.entriesOpenAt(company, q.data.root as Hex);
    const pending = open === null ? null : pendingAt(deps.store.keptTreeOf(company), open, q.data.root as Hex);
    if (pending === null) {
      res.status(200).json({ refused: 'root-not-kept', error: 'this service keeps no header that makes that root, so nothing can be read '
        + 'against it. Reload the page; if it happens again, the service is withholding the company\'s records' });
      return;
    }
    res.json({ entries: pending });
  });

  /* Every kind a company files, in each store, so a device can ask about all of them in one read. */
  const KINDS_AT_ONCE = COMPANY_RECORD_KINDS.length + WIRE_RECORDS.length + 3;
  router.post(`${base}/tree/proofs`, deps.signedIn, deps.member, express.json({ limit: '128kb' }), (req, res) => {
    const company = String(req.params.id);
    const kind = z.object({ store: z.enum(MANIFEST_STORES), kind: z.string().max(64) }).strict();
    const b = z.object({
      root: z.string().regex(/^[0-9a-f]{64}$/u), records: z.array(recordName).max(PROVEN_AT_ONCE), kinds: z.array(kind).max(KINDS_AT_ONCE),
    }).strict().safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: `name the root to prove against and at most ${PROVEN_AT_ONCE} records and ${KINDS_AT_ONCE} kinds. Nothing was read.` });
      return;
    }
    const given = proofsOf(deps.store.keptTreeOf(company), b.data);
    if (given === null) {
      /* Answered, not failed: a root not kept here is an answer the device acts on (it reads the head again). */
      res.status(200).json({ refused: 'root-not-kept', error: 'this service keeps no header that makes that root, so nothing can be proven '
        + 'against it. Reload the page; if it happens again, the service is withholding the company\'s records' });
      return;
    }
    res.json(given);
  });

  return router;
};
