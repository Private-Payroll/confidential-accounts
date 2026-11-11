/**
 * **THE READERS THE SERVICE LETS READ A COMPANY'S RECORDS, AND THE ROUTE THAT KEEPS THEM.**
 *
 * A company's read grants are sealed (`grants-record.ts`); the service never opens them. What it keeps is the plain
 * list of person ids or server labels the grants in force name, apart from the company's members (`memberUserIds`,
 * the signers), on the account record (`readers`). It keeps a list only when signatures of seats it holds on the
 * chain now, over that list, the change's number and its entries' digest, reach the chain's seat bar: it counts
 * signatures, one filing key one vote, and judges no role. A list is kept only for a later change than the one kept.
 *
 * The member gate admits those readers on the reads their grant needs and on nothing else (`READER_ROUTES`): every
 * route that writes, and every read that hands names, emails or run details in plain, stays the members'.
 */
import express from 'express';
import type { SealedAccount } from '../core/types.js';
import { HEX64 } from '../midnight/directory-change-shape.js';
import { readersMessage } from '../midnight/grants-record.js';
import type { SeatSignature } from '../midnight/seat-directory.js';
import { barReadable, quorumOf } from '../midnight/seat-quorum.js';
import { CHAIN_UNREAD, type DirectoryNow } from './seat-directory-route.js';

/** The readers the service keeps for a company: the change of the grants they come from, and their ids. */
export interface ReadersKept {
  readonly sequence: number;
  readonly userIds: readonly string[];
}

/** A company's account record as the service keeps it, with its readers beside its members. */
export type AccountWithReaders = SealedAccount & { readonly readers?: ReadersKept };

/** Where the service keeps a company's account record. */
export interface ReadersStore {
  getAccount(id: string): AccountWithReaders | null;
  putAccount(account: SealedAccount): void;
}

/** The readers the service keeps for a company, none when it keeps none. */
export const readersOf = (account: AccountWithReaders | null | undefined): readonly string[] => account?.readers?.userIds ?? [];

/**
 * The reads a reader's device makes to read what its grant names, and nothing else: the account record, the company's
 * sealed records, its directory, and the manifest's reads that prove a version anchored (two of them POSTs that read).
 * Never the invitations, the people, the runs or any route that hands names, emails or run details in plain.
 */
const READER_ROUTES: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/accounts\/[^/]+$/u },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/records\/[^/]+\/[^/]+(?:\/versions|\/[0-9]+)?$/u },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/directory$/u },
  { method: 'POST', path: /^\/api\/accounts\/[^/]+\/manifest\/newest$/u },
  { method: 'POST', path: /^\/api\/accounts\/[^/]+\/manifest\/tree\/proofs$/u },
  { method: 'GET', path: /^\/api\/accounts\/[^/]+\/manifest\/tree\/(?:pending|headers)$/u },
];

/**
 * Whether a request is one of the reads a reader may make, judged on the path it was routed by: where the router it
 * reached is mounted, then the path under it. The query is never part of that path, so nothing is read from it.
 */
const aReadersRead = (req: express.Request): boolean => {
  const path = req.baseUrl + req.path;
  return READER_ROUTES.some((r) => r.method === req.method && r.path.test(path));
};

/**
 * **THE MEMBER GATE, WITH READERS ADMITTED TO READ.** A member of the company passes on every route; a person or server
 * the company's readers name passes only on the reads its grant needs (`READER_ROUTES`). Anyone else is told the
 * account is not found, as a stranger is.
 */
export const memberOrReaderReading = (
  isMember: (accountId: string, userId: string) => boolean, accountOf: (accountId: string) => AccountWithReaders | null,
): express.RequestHandler => (req, res, next) => {
  const id = String(req.params.id);
  const user = req.userId ?? '';
  if (user !== '' && (isMember(id, user) || (aReadersRead(req) && readersOf(accountOf(id)).includes(user)))) {
    next();
    return;
  }
  res.status(404).json({ error: 'account not found' });
};

const NAME = /^[A-Za-z0-9._:@-]{1,128}$/u;
const MOST_READERS = 256;

/** Why a list handed in is not one: a change's number, the readers in order each once, the entries' digest, and signatures. */
const listRefusal = (b: unknown): string | null => {
  const v = b as { sequence?: unknown; readers?: unknown; entries?: unknown; signatures?: unknown } | null;
  if (typeof v !== 'object' || v === null || !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1) return 'it names no change of the read grants';
  if (!Array.isArray(v.readers) || v.readers.length > MOST_READERS || !v.readers.every((r) => typeof r === 'string' && NAME.test(r))
    || v.readers.some((r, i, all) => i > 0 && !(String(all[i - 1]) < String(r)))) return 'its readers are not person ids in order, each once';
  if (typeof v.entries !== 'string' || !HEX64.test(v.entries)) return 'it carries no digest of the grants\' entries';
  if (!Array.isArray(v.signatures)) return 'it carries no signatures';
  return null;
};

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
    const { sequence, readers, entries, signatures } = req.body as { sequence: number; readers: string[]; entries: string; signatures: SeatSignature[] };
    const account = deps.store.getAccount(id);
    if (account === null) { res.status(404).json({ error: 'account not found' }); return; }
    const kept = account.readers;
    if (kept !== undefined && sequence <= kept.sequence) {
      if (sequence === kept.sequence && kept.userIds.join(',') === readers.join(',')) { res.status(200).json({ kept: true, sequence }); return; }
      res.status(409).json({ refused: 'not-a-later-change', error: `the service already keeps the readers of change ${kept.sequence} of the read grants, so an earlier or the same change with other readers is not kept. Hand in the readers of the grants in force now.` });
      return;
    }
    let now: DirectoryNow;
    try { now = await deps.directoryOf(id); } catch (e) { res.status(503).json({ error: CHAIN_UNREAD(e) }); return; }
    const chain = now.chain;
    if (chain === null) { res.status(503).json({ error: CHAIN_UNREAD(new Error('the company has no account on the chain the service can read')) }); return; }
    const n = quorumOf(now.dir.seats, readersMessage(id, sequence, readers, entries.toLowerCase()), signatures, (seat) => chain.seats.seats.includes(seat.seat));
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
    const next: AccountWithReaders = { ...account, readers: { sequence, userIds: [...readers] } };
    deps.store.putAccount(next);
    res.status(201).json({ kept: true, sequence });
  });
  return router;
};
