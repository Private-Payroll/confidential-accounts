/**
 * **A COMPANY'S SEAT DIRECTORY ON THE PRODUCT'S SERVER: SERVED WHOLE, AND
 * FILED ONE CHECKED VERSION AT A TIME.**
 *
 * The directory says which key each seat files the company's records under
 * (`seat-directory.ts`). This server keeps every filing that made it and
 * serves them all, so a device replays and checks them itself rather than
 * taking a table this server computed. **It is a store**: it holds no roster
 * key, so it never opens an entry's proof, never learns a seat's wallet key,
 * and judges no seat's role and no quorum. Before it files a filing it checks:
 *
 *   · **an entry** must be filed by the signed-in person it names, who is a
 *     member of the company; in its shape, for this company's account, and
 *     signed by the filing key it names; for a seat the account holds now.
 *     Whether the wallet that signed an entry is the one the seat was made for
 *     is judged by each member's device, which opens the entry with the
 *     company's key and believes the first claim whose proof proves; this
 *     server keeps every claim and judges none.
 *   · **a change by a quorum** - a role, or a retirement with the last version
 *     of each record the seat filed - must be in its shape, every signature
 *     verifying, signed against the account's approval threshold as the chain
 *     holds it now. Who signed it, and whether enough did, each member's device
 *     counts; this server counts nothing and keeps no role or retirement.
 *
 * The super admins are not filed here: they are the keys on the account's
 * committee as the chain holds it, and this server judges no one by them.
 *
 * A change filed again under the signatures of an earlier version is filed
 * only as a device's replay would believe it (`refiledRefusalOf`): the same
 * one rule, so this server decides nothing a device does not decide again.
 *
 * A company with no account on a chain this server can read is refused with
 * words saying what resolves it. Nothing here opens a record or holds a key
 * that could.
 */
import express from 'express';
import { readAccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { SealedAccount } from '../core/types.js';
import { fromHex, type Hex } from '../core/crypto.js';
import { readContractAuthority } from '../midnight/ledger.js';
import {
  applyFiling, AT_THE_SERVER, believedDirectory, DIRECTORY_REFUSAL, directoryReplayed, DirectoryRefused, emptyDirectory, filerSeatOf, refiledRefusalOf, signerSeatOf,
  type ChainHolders, type Directory, type DirectoryFiling, type DirectoryRefusalCode, type DirectorySeat, type ServerSeatRefusal,
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
 * threshold as the state's maintenance authority holds them, which of the
 * seats asked about its signers' set holds, and how many approvals it needs. Null when
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
  /**
   * The directory versions the company's record headers kept here passed over:
   * below the newest version any of them anchors, anchored by none. Absent, none.
   */
  directoryPassedOver?(accountId: string): ReadonlySet<number>;
}

/** A company's seat directory as this server believes it now, and the read of the chain it was believed against. */
export interface DirectoryNow {
  readonly dir: Directory;
  /**
   * The directory as filed up to `version`, replayed with no read of the chain
   * and with every version the company's records passed over left out: who a
   * seat was when a header naming that directory version was signed.
   */
  readonly at?: (version: number) => Directory;
  /** What the chain said of the account for this read; null when it has no account on a chain this server can read. */
  readonly chain: ChainHolders | null;
  /**
   * Whether a quorum's change filed again as the next version is believed after
   * every filing held here, against who holds the account on chain now, or why not
   * (`refiledRefusalOf`): the same rule a device's replay applies.
   */
  readonly refiledRefusal?: (filing: DirectoryFiling) => DirectoryRefusalCode | null;
}

/**
 * **THE DIRECTORY AS EVERY FILING THIS SERVER HOLDS MAKES IT, AGAINST THE
 * CHAIN NOW**: the one place this server reads a seat from. It is replayed the
 * way a device replays it (`vault-page-doors.ts` `directoryJudge`): against
 * this server's own read of the seats the account holds and its approval
 * threshold, made afresh for every call, where a device uses its wallet's
 * read. Each entry is kept on what this server can read of it
 * (`AT_THE_SERVER`), every entry for a seat beside the others, where a device
 * opens its proof and believes the first that proves. No role or retirement is
 * kept here, and the seat a filing is kept under (`filerSeatOf`) is asked of
 * the chain alone. The
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
  /* A version the company's records passed over is replayed as no change here too, so its seat may file its entry again. */
  const passed = store.directoryPassedOver?.(accountId) ?? new Set<number>();
  const skipped = (v: number) => (passed.has(v) ? null : undefined);
  /* Every seat an entry names, believed or not: which seats the chain is asked about, and nothing more. */
  const named = filings.flatMap((f) => (f?.change?.kind === 'claim' && typeof f.change.entry?.statement?.seat === 'string'
    ? [f.change.entry.statement.seat] : []));
  const read = await chain(accountId, [...new Set([...named, ...also])]);
  if (read === null) return { dir: emptyDirectory(accountId), chain: null };
  const at = (version: number) => believedDirectory(
    accountId, filings.slice(0, Math.max(0, version)), label as CompanyLabel, address, AT_THE_SERVER, undefined, skipped);
  const replayed = directoryReplayed(accountId, filings, label as CompanyLabel, address, AT_THE_SERVER, {
    approvals: read.approvals, seats: read.seats.seats,
  }, skipped);
  return {
    at,
    dir: replayed.dir,
    chain: read,
    refiledRefusal: (filing) => refiledRefusalOf(replayed.replay, filing, { approvals: read.approvals, seats: read.seats.seats }),
  };
};

/** The seat the signed-in person files under against `now`, or why not (`filerSeatOf`). No role is judged. */
export const filerSeatNow = (now: DirectoryNow, person: string, filer: Hex): DirectorySeat | ServerSeatRefusal =>
  filerSeatOf(now.dir, now.chain?.seats ?? null, person, filer);

/** The seat whose key signed an entry, judged by that signature and the chain now, never by who hands it in (`signerSeatOf`). */
export const signerSeatNow = (now: DirectoryNow, signer: Hex): DirectorySeat | ServerSeatRefusal =>
  signerSeatOf(now.dir, now.chain?.seats ?? null, signer);

/**
 * **THE SEAT THAT ANCHORED A HEADER, AS THE DIRECTORY STOOD WHEN IT WAS SIGNED**:
 * an entry kept for the header's anchoring key in the directory as filed up to
 * the version the header names - whoever hands the header in. Whether its role
 * could anchor, whether it had retired, and the chain then, are each device's
 * to judge, against the holders the header names.
 */
export const anchoringSeatThen = (now: DirectoryNow, anchoredBy: Hex, dirVersion: number): DirectorySeat | ServerSeatRefusal =>
  (now.at?.(dirVersion) ?? now.dir).seats.find((x) => x.signingKey === anchoredBy.toLowerCase()) ?? 'no-entry';

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
    const address = readAccountAddress(account.contractAddress ?? null);
    if (address === null) {
      res.status(409).json({ refused: 'no-account', error: DIRECTORY_REFUSAL['no-account'] });
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
        refused: 'no-account',
        error: 'this server could not read this company\'s account on the chain just now, so no seat can be entered. Try again in a minute; '
          + 'if it keeps happening, contact support.',
      });
      return;
    }
    try {
      /* A quorum's change filed again is filed only as a device's replay would believe it. */
      const again = filing.signedAt === undefined ? null : now.refiledRefusal === undefined ? 'not-a-change' : now.refiledRefusal(filing);
      if (again !== null) throw new DirectoryRefused(again);
      applyFiling(dir, filing, { label: label as CompanyLabel, account: address, chain, judge: AT_THE_SERVER, who: { person, members: account.memberUserIds } });
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
