/**
 * **A COMPANY'S SEAT DIRECTORY ON THE PRODUCT'S SERVER: SERVED WHOLE, AND
 * FILED ONE CHECKED VERSION AT A TIME.**
 *
 * The directory says which key each seat files the company's records under
 * (`seat-directory.ts`). This server keeps every filing that made it and
 * serves them all, so a device replays and checks them itself rather than
 * taking a table this server computed. Before it files one it makes the same
 * checks a device makes, against its own read of the chain:
 *
 *   · **an entry** must be filed by the signed-in person it names, who is a
 *     member of the company; signed by that seat's own wallet with a key the
 *     account lists on its committee now; for a seat the account holds now;
 *     and the first for that seat, that key and that person.
 *   · **a change by a quorum** - a role, or a retirement with the last version
 *     of each record the seat filed - must be signed against the account's
 *     approval threshold as the chain holds it now, by that many seats the
 *     account holds now.
 *
 * A company whose account is not held by its signers' committee is refused
 * with words saying what resolves it. Nothing here opens a record or holds a
 * key that could.
 */
import express from 'express';
import { readAccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { SealedAccount } from '../core/types.js';
import { fromHex, type Hex } from '../core/crypto.js';
import { readContractAuthority } from '../midnight/ledger.js';
import {
  applyFiling, believedDirectory, DirectoryRefused, emptyDirectory, filerSeatOf,
  type ChainHolders, type Directory, type DirectoryFiling, type DirectorySeat, type FiledKind, type FilingRefusal,
} from '../midnight/seat-directory.js';

/** What the chain says of a company's account, read by this server: null when it has no contract this server can read. */
export type DirectoryChainRead = (accountId: string, seats: readonly string[]) => Promise<ChainHolders | null>;

/** What the account's contract holds, as the compiled contract reads its public state. */
export interface AccountHolds {
  readonly signerLeaves: { member(leaf: Uint8Array): boolean };
  readonly threshold: bigint;
}

/**
 * **THIS SERVER'S OWN READ OF THE CHAIN FOR A COMPANY'S DIRECTORY**, from one
 * read of the account's contract state: its committee and that committee's
 * threshold as the state's maintenance authority holds them, which of the seats
 * asked about its signers' set holds, and how many approvals it needs. Null when
 * the company has no account on a chain, or the chain holds no state there; a
 * read that fails, or a state with no committee this server can read, throws.
 */
export const directoryChainFromTheContract = (deps: {
  /** The company's account address on the chain, or null when it has none. */
  readonly addressOf: (accountId: string) => Promise<string | null>;
  /** The account's contract state, as the chain's indexer serves it. */
  readonly contractState: (address: string) => Promise<unknown>;
  /** The compiled contract's reader of that state's public data. */
  readonly readLedger: (data: unknown) => AccountHolds;
}): DirectoryChainRead => async (accountId, seats) => {
  const address = await deps.addressOf(accountId);
  if (address === null) return null;
  let state: unknown;
  const read = await readContractAuthority(async (a) => (state = await deps.contractState(a)), address);
  if (read.state === 'absent') return null;
  if (read.state !== 'read') throw new Error(read.why);
  const holds = deps.readLedger((state as { data: unknown }).data);
  return {
    seats: {
      committee: read.authority.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })),
      threshold: read.authority.threshold,
      seats: seats.filter((seat) => holds.signerLeaves.member(fromHex(seat as Hex))),
    },
    approvals: Number(holds.threshold),
  };
};

/** What this route needs of the store. */
export interface DirectoryStore {
  getAccount(accountId: string): SealedAccount | null;
  directoryFilingsOf(accountId: string): readonly DirectoryFiling[];
  fileDirectory(accountId: string, filing: DirectoryFiling): boolean;
}

/** A company's seat directory as this server believes it now, and the read of the chain it was believed against. */
export interface DirectoryNow {
  readonly dir: Directory;
  /** What the chain said of the account for this read; null when it has no account on a chain this server can read. */
  readonly chain: ChainHolders | null;
}

/**
 * **THE DIRECTORY AS EVERY FILING THIS SERVER HOLDS MAKES IT, AGAINST THE
 * CHAIN NOW**: the one place this server reads a seat from. It is replayed the
 * way a device replays it (`vault-page-doors.ts` `directoryJudge`): against
 * this server's own read of the account's committee, the seats it holds and
 * its approval threshold, made afresh for every call, where a device uses its
 * wallet's read. So a role or retirement is believed only at the account's
 * threshold now, and check S (`filerSeatOf`) asks the committee and the seat
 * of the chain as a device's `filingRefusalOf` does: one rule for both. The
 * read covers every seat a filing names, and `also`, so a route can ask of a
 * seat being claimed in the same read. A read that fails throws; nothing is
 * decided on a directory the chain was not asked about.
 */
export const directoryOf = async (
  store: DirectoryStore, chain: DirectoryChainRead, accountId: string, also: readonly string[] = [],
): Promise<DirectoryNow> => {
  const account = store.getAccount(accountId);
  const label = account?.companyLabel ?? null;
  const address = readAccountAddress(account?.contractAddress ?? null);
  /* No label, or no account on a chain: no entry can have been signed for it. */
  if (label === null || address === null) return { dir: emptyDirectory(accountId), chain: null };
  const filings = store.directoryFilingsOf(accountId);
  const named = believedDirectory(accountId, filings, label as CompanyLabel, address).seats.map((x) => x.seat);
  const read = await chain(accountId, [...new Set([...named, ...also])]);
  if (read === null) return { dir: emptyDirectory(accountId), chain: null };
  return {
    dir: believedDirectory(accountId, filings, label as CompanyLabel, address,
      { approvals: read.approvals, seats: read.seats.seats, committee: read.seats.committee }),
    chain: read,
  };
};

/** Check S against `now`: the seat the signed-in person files under, or why they may not. */
export const filerSeatNow = (now: DirectoryNow, person: string, filer: Hex, kind: FiledKind): DirectorySeat | FilingRefusal =>
  filerSeatOf(now.dir, now.chain?.seats ?? null, person, filer, kind);

/** What a route answers when the chain could not be read, so who may file could not be decided. */
export const CHAIN_UNREAD = (e: unknown): string =>
  `whether this filing may be made could not be decided, because the chain could not be read: ${(e as Error)?.message ?? String(e)}`;

export const seatDirectoryRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: DirectoryStore;
  readonly chain: DirectoryChainRead;
}): express.Router => {
  const router = express.Router();
  const base = '/api/accounts/:id/directory';

  router.get(base, deps.signedIn, deps.member, (req, res) => {
    res.status(200).json({ filings: deps.store.directoryFilingsOf(String(req.params.id)) });
  });

  router.put(`${base}/:version`, deps.signedIn, deps.member, express.json({ limit: '64kb' }), async (req, res) => {
    const accountId = String(req.params.id);
    const person = (req as { userId?: unknown }).userId;
    const account = deps.store.getAccount(accountId);
    if (typeof person !== 'string' || account === null) {
      res.status(404).json({ error: 'account not found' });
      return;
    }
    const label = account.companyLabel ?? null;
    if (label === null) {
      res.status(409).json({
        refused: 'no-label',
        error: 'this company was made without a label, so no wallet can sign an entry for it. Create a new company.',
      });
      return;
    }
    const filing = req.body as DirectoryFiling;
    const version = Number(req.params.version);
    if (typeof filing !== 'object' || filing === null || filing.version !== version) {
      res.status(400).json({ refused: 'not-a-change', error: 'the version in the path and the version filed are not the same.' });
      return;
    }
    const claimed = filing.change?.kind === 'claim' && typeof filing.change.entry?.statement?.seat === 'string' ? [filing.change.entry.statement.seat] : [];
    let now: DirectoryNow;
    try {
      now = await directoryOf(deps.store, deps.chain, accountId, claimed);
    } catch (e) {
      res.status(503).json({ error: CHAIN_UNREAD(e) });
      return;
    }
    const { dir, chain } = now;
    if (chain === null) {
      res.status(409).json({
        refused: 'not-on-the-committee',
        error: 'this company has no account on the chain this server can read, so no seat can be entered. Create a new company.',
      });
      return;
    }
    try {
      const address = readAccountAddress(account.contractAddress ?? null);
      if (address === null) throw new DirectoryRefused('not-on-the-committee');
      applyFiling(dir, filing, { label: label as CompanyLabel, account: address, chain, who: { person, members: account.memberUserIds } });
    } catch (e) {
      if (!(e instanceof DirectoryRefused)) throw e;
      res.status(e.code === 'not-the-next-version' ? 409 : 422).json({ refused: e.code, error: e.message });
      return;
    }
    if (!deps.store.fileDirectory(accountId, filing)) {
      res.status(409).json({ refused: 'not-the-next-version', error: 'another filing took that version first. Read the directory again.' });
      return;
    }
    res.status(201).json({ filed: true, version });
  });

  return router;
};
