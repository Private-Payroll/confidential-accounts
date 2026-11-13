/**
 * **THE READERS THE SERVICE LETS READ A COMPANY'S RECORDS, AND THE ROUTE THAT KEEPS THEM.**
 *
 * A company's read grants are sealed (`grants-record.ts`); the service never opens them. What it keeps is the plain
 * list of person ids or server labels the grants in force name, apart from the company's members (`memberUserIds`,
 * the signers), on the account record (`readers`), and for each reader the kinds of record its grant reads. It keeps
 * a list only when signatures of seats it holds on the chain now, over that list, the change's number and its
 * entries' digest, reach the chain's seat bar, as every device's fold counts them (`grantsChangeCounted`: a change that
 * only narrows the list kept also counts seats that signed it and have left since), and only when the entries handed
 * in with it are the ones that digest names: it counts signatures, one filing key one vote, reads each reader's kinds off the purposes the signers signed
 * (`kindsAReaderFetches`), and judges no role. A list is kept only for a later change than the one kept, or for the
 * same change when the kinds were not yet kept with it.
 *
 * The member gate admits those readers on the reads their grant needs and on nothing else (`READER_ROUTES`): a
 * record, a run or a proposal only of a kind its grant reads; every route that writes, and every read that hands
 * names or emails in plain, stays the members'. On the manifest's reads a reader is refused a name of another kind and
 * served the entries waiting without those of other kinds (`aReaderMay`, `readerKindsOf`).
 */
import express from 'express';
import type { SealedAccount } from '../core/types.js';
import { READER_PURPOSES } from '../core/roles.js';
import { HEX64 } from '../midnight/directory-change-shape.js';
import {
  entriesDigestOf, grantsChangeCounted, grantsChangeRefusal, kindsAReaderFetches, narrowsOnly, readersMessage, readersNamedIn, type GrantEntry,
} from '../midnight/grants-record.js';
import { recordKeyOf, type ManifestEntryBody } from '../midnight/record-manifest.js';
import { DIRECTORY, FOUNDING_RECORDS } from '../midnight/records-held.js';
import type { CompanyRecordKind } from '../midnight/sealed-record-wire.js';
import type { SeatSignature } from '../midnight/seat-directory.js';
import { barReadable } from '../midnight/seat-quorum.js';
import { CHAIN_UNREAD, type DirectoryNow } from './seat-directory-route.js';
import type {} from './signed-in-request.js';

/**
 * The readers the service keeps for a company: the change of the grants they come from, their ids, the kinds of record
 * each may fetch, and the entries they were read from, which a later change that only narrows them is judged against.
 * A list kept without kinds lets its readers fetch no record of any kind until it is handed in again with its entries.
 */
export interface ReadersKept {
  readonly sequence: number;
  readonly userIds: readonly string[];
  readonly kinds?: Readonly<Record<string, readonly CompanyRecordKind[]>>;
  readonly granted?: readonly GrantEntry[];
}

/** A company's account record as the service keeps it, with its readers beside its members. */
export type AccountWithReaders = SealedAccount & { readonly readers?: ReadersKept };

/** Where the service keeps a company's account record. */
export interface ReadersStore {
  getAccount(id: string): AccountWithReaders | null;
  putAccount(account: SealedAccount): void;
}

/** A company's account record as it is served, without the readers the gate keeps or the kinds each reads. */
export const withoutReaders = <T extends object>(account: T) => {
  const { readers: _kept, ...served } = account as T & { readers?: unknown };
  return served;
};

/** The readers the service keeps for a company, none when it keeps none. */
export const readersOf = (account: AccountWithReaders | null | undefined): readonly string[] => account?.readers?.userIds ?? [];

/**
 * The reads a reader's device makes to read what its grant names, and nothing else: the account record, the company's
 * sealed records of a kind its grant reads (the kind is the path's first group), its sealed runs and proposals when its
 * grant reads them, its directory, and the manifest's reads that prove a version anchored (two of them POSTs that
 * read). Never the invitations, the people or any route that hands names or emails in plain.
 */
const READER_ROUTES: readonly { readonly method: string; readonly path: RegExp; readonly kind?: CompanyRecordKind }[] = [
  { method: 'GET', path: /^\/api\/accounts\/[^/]+$/u },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/records\/([^/]+)\/[^/]+(?:\/versions|\/[0-9]+)?$/u },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/runs$/u, kind: 'run' },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/proposals$/u, kind: 'proposal' },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/directory$/u },
  { method: 'POST', path: /^\/api\/accounts\/[^/]+\/manifest\/newest$/u },
  { method: 'POST', path: /^\/api\/accounts\/[^/]+\/manifest\/tree\/proofs$/u },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/manifest\/tree\/(?:pending|headers)$/u },
];

/**
 * Whether a request is one of the reads this reader may make, judged on the path it was routed by: where the router it
 * reached is mounted, then the path under it. The query is never part of that path, so nothing is read from it. A read
 * of a record, a run or a proposal passes only when the kind it reads is one the reader's kept kinds name.
 */
const aReadersRead = (req: express.Request, kinds: readonly string[]): boolean => {
  const path = req.baseUrl + req.path;
  return READER_ROUTES.some((r) => {
    if (r.method !== req.method) return false;
    const m = r.path.exec(path);
    if (m === null) return false;
    const kind = r.kind ?? m[1];
    return kind === undefined || kinds.includes(kind);
  });
};

/** The kinds of record a company's reader may fetch, none when the service keeps none for it. */
export const kindsOf = (account: AccountWithReaders | null | undefined, userId: string): readonly string[] => {
  const kinds = account?.readers?.kinds;
  return kinds !== undefined && Object.hasOwn(kinds, userId) ? kinds[userId] ?? [] : [];
};

/** Where the member gate leaves the kinds of an admitted reader for the route it passes to; a member has none left. */
const READER_KINDS = 'readerKinds';

/** The kinds the reader this request was admitted for may fetch, or null when a member of the company asks. */
export const readerKindsOf = (res: express.Response): readonly string[] | null => {
  const kinds: unknown = res.locals[READER_KINDS];
  return Array.isArray(kinds) ? kinds as string[] : null;
};

/* The records every reader's wallet proves to judge the company's roster, by exact name, whatever its grant reads. */
const PROVEN_BY_EVERY_READER: ReadonlySet<string> = new Set([DIRECTORY, ...FOUNDING_RECORDS].map(recordKeyOf));

/**
 * **WHETHER A READER WHOSE GRANT READS THESE KINDS MAY BE SERVED THIS MANIFEST NAME**: an entry, a record asked, or a
 * whole kind asked (its id empty). The company's directory and the records it was founded with pass by exact name,
 * because a reader's wallet proves them to judge the roster; a company record, a run or a proposal passes when its kind
 * is one the grant reads; a vault record never does, since no read of a reader fetches one.
 */
type ManifestName = Pick<ManifestEntryBody, 'store' | 'kind' | 'id'>;
export const aReaderMay = (kinds: readonly string[], r: ManifestName): boolean => {
  if (r.store === 'directory' || PROVEN_BY_EVERY_READER.has(recordKeyOf(r))) return true;
  return r.store !== 'vault' && (r.store === 'company' || r.kind === r.store) && kinds.includes(r.kind);
};

/* Every kind some purpose a reader can be granted reads: a name outside it is never served to any reader. */
const KINDS_A_GRANT_CAN_READ: readonly string[] = kindsAReaderFetches([...new Set(Object.values(READER_PURPOSES).flat())]);

/**
 * Refuses a reader that asks the manifest for any name outside its grant's kinds, saying what clears it, and answers
 * whether it did. The signers granting a purpose is named as a remedy only when some grant would serve that name. A
 * member is never refused here.
 */
export const readerAskedBeyondItsKinds = (
  res: express.Response, asked: readonly (Omit<ManifestName, 'id'> & { readonly id?: string })[],
): boolean => {
  const kinds = readerKindsOf(res);
  const beyond = kinds === null ? undefined : asked.find((r) => !aReaderMay(kinds, { ...r, id: r.id ?? '' }));
  if (beyond === undefined) return false;
  res.status(403).json({
    refused: 'not-a-kind-read',
    error: `a reader of this company is served only records of the kinds its grant reads, and this asks for ${beyond.store} records `
      + `of kind ${beyond.kind}. Nothing was read. Ask only for the kinds the grant names`
      + (aReaderMay(KINDS_A_GRANT_CAN_READ, { ...beyond, id: beyond.id ?? '' })
        ? ', or the company\'s signers grant a purpose that reads this kind, from their wallets.' : '.'),
  });
  return true;
};

/**
 * **THE MEMBER GATE, WITH READERS ADMITTED TO READ.** A member of the company passes on every route; a person or server
 * the company's readers name passes only on the reads its grant needs (`READER_ROUTES`), and on a record, a run or a
 * proposal only of a kind kept for it, with its kinds left for the route (`readerKindsOf`). Anyone else is told the
 * account is not found, as a stranger is.
 */
export const memberOrReaderReading = (
  isMember: (accountId: string, userId: string) => boolean, accountOf: (accountId: string) => AccountWithReaders | null,
): express.RequestHandler => (req, res, next) => {
  const id = String(req.params.id);
  const user = req.userId ?? '';
  if (user !== '' && isMember(id, user)) { next(); return; }
  const account = user === '' ? null : accountOf(id);
  const kinds = kindsOf(account, user);
  if (readersOf(account).includes(user) && aReadersRead(req, kinds)) { res.locals[READER_KINDS] = [...kinds]; next(); return; }
  res.status(404).json({ error: 'account not found' });
};

const NAME = /^[A-Za-z0-9._:@-]{1,128}$/u;
const MOST_READERS = 256;

/**
 * Why a list handed in is not one: a change's number, the readers in order each once, the entries' digest, the entries
 * themselves in the one shape a grant is held in, and signatures.
 */
const listRefusal = (b: unknown): string | null => {
  const v = b as { sequence?: unknown; readers?: unknown; entries?: unknown; granted?: unknown; signatures?: unknown } | null;
  if (typeof v !== 'object' || v === null || !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1) return 'it names no change of the read grants';
  if (!Array.isArray(v.readers) || v.readers.length > MOST_READERS || !v.readers.every((r) => typeof r === 'string' && NAME.test(r))
    || v.readers.some((r, i, all) => i > 0 && !(String(all[i - 1]) < String(r)))) return 'its readers are not person ids in order, each once';
  if (typeof v.entries !== 'string' || !HEX64.test(v.entries)) return 'it carries no digest of the grants\' entries';
  if (!Array.isArray(v.granted) || v.granted.length > MOST_READERS
    || grantsChangeRefusal({ sequence: v.sequence as number, entries: v.granted as GrantEntry[] }) !== null) return 'it carries no entries of the grants in the one shape a grant is held in';
  if (!Array.isArray(v.signatures)) return 'it carries no signatures';
  return null;
};

/** Whether the entries handed in are the ones the signed digest and the list of readers name. */
const theSignedEntries = (granted: readonly GrantEntry[], readers: readonly string[], entries: string): boolean =>
  entriesDigestOf(granted) === entries.toLowerCase() && readersNamedIn(granted).join(',') === readers.join(',');

/** The route a signer's wallet hands the readers of the grants in force to, with the signatures that put them in force. */
export const readersRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: ReadersStore;
  /** The company's seat directory against the chain now (`seat-directory-route.ts` `directoryOf`). */
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
}): express.Router => {
  const router = express.Router();
  router.post('/api/accounts/:id/readers', deps.signedIn, deps.member, express.json({ limit: '128kb' }), async (req, res) => {
    const id = String(req.params.id);
    const bad = listRefusal(req.body);
    if (bad !== null) {
      res.status(400).json({ refused: 'not-a-list', error: `this list of readers was not kept, because ${bad}. Hand it in again from a signer's wallet.` });
      return;
    }
    const { sequence, readers, entries, granted, signatures } = req.body as {
      sequence: number; readers: string[]; entries: string; granted: GrantEntry[]; signatures: SeatSignature[];
    };
    if (!theSignedEntries(granted, readers, entries)) {
      res.status(422).json({ refused: 'not-the-signed-entries', error: 'the entries handed in with this list of readers are not the ones its signatures name, so it was not kept. Hand it in again from a signer\'s wallet, as the wallet files it.' });
      return;
    }
    const account = deps.store.getAccount(id);
    if (account === null) { res.status(404).json({ error: 'account not found' }); return; }
    const kept = account.readers;
    const sameList = kept !== undefined && sequence === kept.sequence && kept.userIds.join(',') === readers.join(',');
    if (sameList && kept?.kinds !== undefined) { res.status(200).json({ kept: true, sequence }); return; }
    if (kept !== undefined && sequence <= kept.sequence && !sameList) {
      res.status(409).json({ refused: 'not-a-later-change', error: `the service already keeps the readers of change ${kept.sequence} of the read grants, so an earlier or the same change with other readers is not kept. Hand in the readers of the grants in force now.` });
      return;
    }
    let now: DirectoryNow;
    try { now = await deps.directoryOf(id); } catch (e) { res.status(503).json({ error: CHAIN_UNREAD(e) }); return; }
    const chain = now.chain;
    if (chain === null) { res.status(503).json({ error: CHAIN_UNREAD(new Error('the company has no account on the chain the service can read')) }); return; }
    const narrows = kept?.granted !== undefined && sequence > kept.sequence && narrowsOnly(kept.granted, granted);
    const n = grantsChangeCounted(now.dir.seats, readersMessage(id, sequence, readers, entries.toLowerCase()), signatures, (seat) => chain.seats.seats.includes(seat.seat), narrows);
    if (typeof n === 'string') {
      res.status(422).json({ refused: 'not-signed', error: 'a signature on this list of readers does not verify, or one key signed it twice, so it was not kept. Each signer signs the change again from their wallet.' });
      return;
    }
    if (!barReadable(chain)) {
      res.status(503).json({ error: 'the chain was read without the approvals a change of who is seated needs, so no signature on this list of readers was counted and it was not kept. Hand it in again.' });
      return;
    }
    const bar = Number(chain.seatBar);
    if (n < bar) {
      res.status(403).json({ refused: 'below-quorum', error: `this list of readers is signed by ${n} of the seats the account holds, and a change of who reads needs ${bar}, as a change of who is seated does. It is kept once the other signers sign it in their own wallets.` });
      return;
    }
    const kinds = Object.fromEntries(granted.map((e) => [e.person, kindsAReaderFetches(e.purposes)]));
    const next: AccountWithReaders = { ...account, readers: { sequence, userIds: [...readers], kinds, granted: [...granted] } };
    deps.store.putAccount(next);
    res.status(201).json({ kept: true, sequence });
  });
  return router;
};
