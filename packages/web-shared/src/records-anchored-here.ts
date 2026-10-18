/**
 * **THE COMPANY'S RECORDS ANCHORED FROM THIS DEVICE: EVERY FILING NOT YET
 * ANCHORED, ONE HEADER OF THE RECORD TREE MOVING THE HEAD THE CHAIN HOLDS IN
 * ONE CALL.**
 *
 * Any seat that may raise or approve may anchor. This device reads every
 * anchor call that landed on the account from the account's own history, at
 * the indexer the person's own wallet names - never from the company's service
 * - and checks every header of the company's record tree from the last head
 * it checked to the head the last of them left (`recordsHeldHere`, through
 * `checkForward`), proving the leaves a read asks against that head's root. It
 * anchors what is not yet anchored: it makes the next header
 * (`treeHeaderHere`) and files it first, so the batch can never be lost to a
 * device that stops half way, then proves the account's `anchor` call from
 * that head and sends it. The batch's header names who held the account as this device judged
 * the batch - read from the same history - and the call names them too: the
 * account refuses the call unless they still hold it, so a batch lands only
 * while what it was judged against holds. The account's state the call is
 * built on is the service's; a state that holds another head, or other
 * holders, is refused by the account's own circuit before anything is proved
 * or sent.
 *
 *   · **a directory version** is signed by a wallet or a quorum, not by a
 *     filing key, so this device enters every version the manifest does not yet
 *     name before it makes its header, signed by its own seat as their witness.
 *   · **a proposal this seat wrote down** and whose entry was not kept is
 *     entered again here before it makes its header: a proposal is filed once and never
 *     changed, so nothing else would ever enter it.
 *   · **the records a company is founded with** - its first state and its
 *     first roster, signed by its founding signer's seat - are entered by that
 *     seat's device before the company's first anchor, and no first anchor is
 *     made without them: the founding seat is read from that first anchor.
 *   · **another device anchoring first**, or the account's approvals or signers
 *     changing, moves what this device proved against, and the chain refuses
 *     the call - the whole transaction, fee and all, since the call is sent only
 *     from the transaction's guaranteed section. This device reads the history
 *     again and anchors again, judged against who holds the account then, a few
 *     times, before it says so.
 *   · **a header it cannot check** stops it: it anchors nothing past a header
 *     the service did not give whole (`not-given`) or whose transition is not
 *     honest (`dishonest`), and says which, and which seat anchored it when its
 *     signature says.
 */
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { SealedProposal } from '../../../src/core/types.js';
import { proposalFilingRefusal } from '../../../src/core/proposal-filing.js';
import { FOUNDING_KEY_EPOCH, foundingStateRefusal, stateRecordId } from '../../../src/core/founding-state.js';
import { foundingRosterRefusal, ROSTER_ID } from '../../../src/core/roster-record.js';
import { companyWirePaths, fromCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import {
  boundaryKeyOfEntry, companyRecordEntry, directoryEntry, EMPTY_HEAD, ENTRIES_AT_ONCE, entryIdOf, filedKindOfEntry, manifestEntryRefusal,
  proposalEntry, recordKeyOf, signManifestEntry, supersededSaid, WITNESSED_AS,
  type BatchHolders, type DirectoryAsAnchored, type ManifestEntry, type ManifestEntryBody,
} from '../../../src/midnight/record-manifest.js';
import { filingRefusalOf, mayFile, type AccountHeld, type DirectoryFiling, type QuorumChange, type SignedChange } from '../../../src/midnight/seat-directory.js';
import {
  directoryNotYetAnchored, pastTheRaisedBoundary, type DirectoryBelieved, type HeldAsAnchored, type LeavingBoundaries, type RecordsHeldHere,
} from './vault-page-doors.js';
import type { AnchorLanded, AnchorsOnChain, VouchedRunOnTheWire } from './governed-call-builder.js';
import { enteredOnThisPage, letGoOfEntered, type ManifestService, type TreeService } from './record-entered-here.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import type { SignerMaterial } from './private-state.js';
import { governedCallServiceFor } from './governed-call-on-device.js';
import { provenPathOf } from './proving-runner.js';
import {
  keptWith, RECENT_KEPT, type CheckedHeads, type CheckedHeadsStore, type DirectoryChangesKeptStore, type HeadersKeptStore, type KeptDirectoryChange, type StartedFrom,
} from './tree-kept-here.js';
import type { VouchedRunHere } from './run-rebuilt-here.js';
import {
  checkedAfter, checkForward, GENESIS, headStepOf, HEADERS_AT_ONCE, leafHashOf, nextTreeHeader, PROVEN_AT_ONCE, provenRefusal, transitionRefusal, transitionStopSaid, treeBatchOf, treeHeaderReadable,
  treeKeyOf, treeLeafRefusal, type CheckedHead, type HeadStep, type KindAsked, type RecordName, type TransitionInput, type TransitionStop, type TreeHeader, type TreeLeaf,
} from '../../../src/midnight/record-tree.js';
import {
  DIRECTORY, directoryVersionsOf, FOUNDING_RECORDS, kindKeyOf, newestAnchored, recordsProvenFor, versionsOf,
  type DirectoryVersionHeld, type HeldVersion, type RecordsAsked, type RecordsHeld,
} from '../../../src/midnight/records-held.js';

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** What anchoring the company's records asks of this device. */
export interface AnchorDoors {
  readonly accountId: string;
  /** This seat's material: its filing key signs the batch, and its signer's three prove the call. */
  readonly material: SignerMaterial;
  /** The company's manifest: entries entered, and the newest version entered of a record. */
  readonly manifest: ManifestService;
  /** The company's record tree as the service serves it: headers, proofs, the entries not yet anchored. */
  readonly tree: TreeService;
  /** Where this device keeps the heads it checked; absent, nothing is kept and every read checks from the company's first header. */
  readonly checked?: CheckedHeadsStore;
  /** Where this device keeps the headers it signed and the last it checked, to file again; absent, none is kept. */
  readonly headers?: HeadersKeptStore;
  /**
   * **THE RUNS THAT MAY VOUCH FOR A HEAD, FOR A DEVICE NEW TO THE COMPANY**: the
   * payroll runs among those the account's history shows vouching, opened here
   * from the proposals the service serves (`vouchedRunsHere`), and the identity
   * each would have raised over the head it seals, made with the account's own
   * functions (`vouchedRunIdentityOf`). Absent, a device new to a company held
   * by more than one key checks from its first header.
   */
  readonly vouching?: {
    readonly runs: (chainIds: readonly string[]) => Promise<readonly VouchedRunHere[]>;
    readonly identity: (run: VouchedRunOnTheWire) => Promise<string | null>;
  };
  /** The company's directory as this device believes it, read afresh. */
  readonly directory: () => Promise<DirectoryBelieved>;
  /**
   * **THE SEATS AN APPROVED REMOVAL IS ABOUT AND THE BOUNDARY EACH KEEPS**,
   * read afresh for each read (`leavingBoundariesHere`, from a read of the
   * company's records that is not given this door): no entry such a seat filed
   * past its boundary is anchored from this device or believed by it. Absent,
   * no removal is known to this read, and only a retirement anchored stops a
   * seat's filings.
   */
  readonly leaving?: () => Promise<LeavingBoundaries>;
  /** Every filing of the company's directory, as the service serves them. */
  readonly directoryFilings: () => Promise<readonly DirectoryFiling[]>;
  /** Files a change to the company's directory at the version it names; absent, this device files none. */
  readonly fileDirectory?: (filing: DirectoryFiling) => Promise<void>;
  /** Where this device keeps the quorum's changes it filed again until a version carrying each is anchored; absent, none is kept. */
  readonly changes?: DirectoryChangesKeptStore;
  /**
   * **EVERY HEAD THE ACCOUNT'S HISTORY SHOWS, OLDEST FIRST, AND WHO HOLDS IT
   * NOW**, read from the account's history at the indexer the person's own
   * wallet names (`VaultBuilderClient.anchorsOnChain`), never from the
   * company's service: the head the last anchor call of each block left, the
   * committee after that block, and the block - the last is the head the
   * account holds; none, the empty head - and who holds the account in its
   * latest state, as a batch's header names them.
   */
  readonly onChain: () => Promise<AnchorsOnChain>;
  readonly service: {
    /**
     * The account's state and the ledger's parameters at one block, as the
     * company's service read them: what an anchor call is built on, and nothing
     * a device believes. A state holding another head than the one this device
     * read is refused by the account's own circuit before anything is proved.
     */
    callState(accountId: string): Promise<AccountCallChainOnTheWire & { readonly account: string }>;
    /** A call this device proved, sent. */
    sendProven(accountId: string, tx: string): Promise<unknown>;
    /** The company's proposals, as the service keeps them. */
    sealedProposals(accountId: string): Promise<readonly SealedProposal[]>;
    /** The first version of the company's state and of its roster, as the service keeps them; null for one it keeps none of. */
    foundingRecords(accountId: string): Promise<{ readonly state: SealedCompanyRecord | null; readonly roster: SealedCompanyRecord | null }>;
  };
  readonly builder: Pick<VaultBuilderClient, 'anchorHeads' | 'anchor' | 'anchorTag'>;
  /**
   * **WHICH SEAT EACH TAG IS**, from the openings in the entries of the
   * directory this device believes (`tagSeatsHere`): a header naming one seat's
   * key and another seat's tag is false, and a head nobody gave a header for is
   * said with the seat that moved it. Absent, no tag is mapped.
   */
  readonly tagSeats?: (here: DirectoryBelieved) => Promise<ReadonlyMap<string, string>>;
  readonly now?: () => Date;
  /**
   * How often the account's history is read again while a send has not
   * answered, and how this device waits between reads; absent, every
   * `ANCHOR_SEND_WATCH_MS` on the page's own clock.
   */
  readonly watch?: { readonly everyMs: number; readonly sleep: (ms: number) => Promise<void> };
}

/** How often, while an anchor's send has not answered, the account's history is read again for where its head went. */
const ANCHOR_SEND_WATCH_MS = 5_000;

/**
 * **WHERE A SENT ANCHOR WENT, READ FROM THE ACCOUNT'S HISTORY WHILE ITS SEND
 * HAS NOT ANSWERED**: `landed` once the head the account holds is the one this
 * batch makes, `superseded` once it is any other head than the one the call
 * names - a call naming an old head can never land then; that may also be
 * this very call landed and another after it, which reading again shows -
 * and never resolved
 * while the head is the one it names. The service relays a send to the node
 * and answers when the node does; a call the node drops for another anchor of
 * the same head may never be answered, so the head is what this device waits
 * on. `settled` stops the reads.
 */
const whereTheSendWent = (
  doors: Pick<AnchorDoors, 'onChain' | 'watch'>, from: string, to: string, settled: { done: boolean },
): Promise<'landed' | 'superseded'> => {
  const everyMs = doors.watch?.everyMs ?? ANCHOR_SEND_WATCH_MS;
  const sleep = doors.watch?.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  return (async () => {
    for (;;) {
      await sleep(everyMs);
      if (settled.done) return new Promise<never>(() => {});
      const head = headOn((await doors.onChain()).landed);
      if (head === to.toLowerCase()) return 'landed';
      if (head !== from.toLowerCase()) return 'superseded';
    }
  })();
};

/**
 * **THE ACCOUNT'S HISTORY, READ IN THE PAGE'S VAULT WORKER AT THE INDEXER THE
 * PERSON'S OWN WALLET NAMED** (`indexer`), and from nowhere else; refused,
 * saying what resolves it, when the wallet named none.
 */
export const anchorsOnChainAt = async (
  builder: Pick<VaultBuilderClient, 'anchorsOnChain'>, account: string,
  indexer: { readonly indexerUri: string; readonly indexerWsUri: string } | null,
): Promise<AnchorsOnChain> => {
  if (indexer === null) {
    throw new Error('your wallet did not name the indexer it reads the chain through, so the company\'s anchor on chain was not read. '
      + 'Open your wallet, check its network, and reload the page');
  }
  return builder.anchorsOnChain({ account, indexer });
};

/** The service's routes an anchor goes through, over this page's own sign-in. */
export const anchorServiceFor = (api: Api): AnchorDoors['service'] => ({
  callState: (accountId) => governedCallServiceFor(api).callState(accountId),
  sendProven: (accountId, tx) => api(provenPathOf(accountId), { method: 'POST', body: JSON.stringify({ tx }) }),
  sealedProposals: (accountId) => governedCallServiceFor(api).sealedProposals!(accountId),
  foundingRecords: async (accountId) => {
    const first = async (kind: 'state' | 'roster', id: string): Promise<SealedCompanyRecord | null> => {
      const b = await api(companyWirePaths.one(accountId, kind, id, 1));
      return b?.filed == null ? null : fromCompanyWire(b.filed, { company: accountId, kind, id, version: 1 }).sealed;
    };
    const [state, roster] = await Promise.all([first('state', stateRecordId(FOUNDING_KEY_EPOCH)), first('roster', ROSTER_ID)]);
    return { state, roster };
  },
});

/** What anchoring did: how many entries its header holds, and the head the chain holds after it. */
export interface Anchored {
  readonly anchored: number;
  readonly head: Hex;
  /** This device's own filings superseded by a later version before the anchor held them: said, never entered again. */
  readonly superseded?: readonly string[];
}

/** Thrown when this device anchored nothing; the reason, and what resolves it, are in the message. */
export class AnchorNotMade extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`the company's records were not anchored: ${why}.`, options);
    this.name = 'AnchorNotMade';
  }
}

/** How many times this device reads the head again after another device anchored first, before it says so. */
const ANCHOR_ATTEMPTS = 3;

/**
 * **WHICH SEAT SIGNED A BATCH ALREADY ANCHORED, OR AN ENTRY IN IT, BY THE
 * DIRECTORY AS IT WAS ANCHORED WITH THAT BATCH.** The directory this device
 * was served is replayed up to the version anchored with the batch, and every
 * version of it must be the bytes the anchor holds for that version. The seat
 * holding the key is then judged by the role it held and whether it had
 * retired, at that version: what a seat may file is `mayFile`'s. The chain's
 * own check when the batch landed is only that a signer sent the call; nothing
 * on chain ties the header's filing key to that signer. Each version of that
 * directory is counted against who held the account as the batch that first
 * anchored it named them and its call checked them (`held`). Nothing of who
 * holds the account now, or of the seat's role now, enters into it.
 */
export const seatAsAnchoredHere = (
  here: DirectoryBelieved, asAnchored: DirectoryAsAnchored, publicKey: Hex, entry?: ManifestEntryBody, held?: HeldAsAnchored,
): string | null => {
  const then = here.at(asAnchored.version, held);
  if (then === null) return null;
  for (const [version, digest] of asAnchored.digests) {
    if (version <= asAnchored.version && then.digests[version - 1] !== digest) return null;
  }
  const seat = then.dir.seats.find((x) => x.signingKey === publicKey.toLowerCase());
  if (seat === undefined) return null;
  const may = mayFile(seat);
  if (entry === undefined) return seat.retired === null && may.includes(WITNESSED_AS) ? seat.seat : null;
  if (!may.includes(filedKindOfEntry(entry))) return null;
  if (seat.retired === null) return seat.seat;
  const last = seat.retired[boundaryKeyOfEntry(entry)];
  return last !== undefined && entry.version <= last ? seat.seat : null;
};

/**
 * **WHICH SEAT THIS DEVICE BELIEVES SIGNED, AS IT BELIEVES EVERY FILING.** In a
 * batch already anchored, by the directory as it was anchored with the batch
 * (`seatAsAnchoredHere`). An entry not yet anchored: the seat holding the key,
 * if it may file that record at that version now (`filingRefusalOf`). Whether that
 * seat's own wallet attested its records key is asked of the record when it is
 * read, by the reader that knows which statements it holds.
 */
const seatOfHere = (here: DirectoryBelieved, held: HeldAsAnchored) => {
  /* The directory now, each version anchored counted against who held the account as it was anchored. */
  const now = here.at(here.dir.version, held)?.dir ?? here.dir;
  return (publicKey: Hex, entry?: ManifestEntryBody, asAnchored?: DirectoryAsAnchored): string | null => {
    if (asAnchored !== undefined) return seatAsAnchoredHere(here, asAnchored, publicKey, entry, held);
    const seat = now.seats.find((x) => x.signingKey === publicKey.toLowerCase());
    if (seat === undefined || entry === undefined) return null;
    return filingRefusalOf(now, here.holders, publicKey, filedKindOfEntry(entry), boundaryKeyOfEntry(entry), entry.version) === null
      ? seat.seat : null;
  };
};

/** What one read gave: every anchor call that landed and who holds the account now, and the company's records as the head the last of them left holds them. */
interface ReadHere {
  readonly landed: readonly AnchorLanded[];
  readonly now: AnchorsOnChain;
  /** The directory this read believed, and who holds the account as the person's own wallet read it. */
  readonly here: DirectoryBelieved;
  readonly records: RecordsHeldHere;
  /** Every entry the service gave as not yet anchored at the root checked, well formed, by id. */
  readonly pending: ReadonlySet<Hex>;
}

/** The head the account holds, as its history read here holds it: the head the last anchor call left, or the empty head. */
const headOn = (landed: readonly AnchorLanded[]): Hex => (landed.length === 0 ? EMPTY_HEAD : landed[landed.length - 1]!.head.toLowerCase() as Hex);

/** What reading the company's records asks of this device. */
type HeldDoors = Pick<AnchorDoors, 'accountId' | 'directory' | 'builder' | 'onChain' | 'tree' | 'checked' | 'headers'> & Partial<Pick<AnchorDoors, 'manifest' | 'vouching' | 'tagSeats' | 'leaving'>>;

/** A holders list as one key, so the seats it names are read once. */
const heldKey = (h: BatchHolders): string => `${h.approvals}|${h.signerRoot}|${h.signers.join(',')}`;

/** What this device keeps once a header is checked: the head, and every head before it from the first when it checked from there. */
const keptAfter = (kept: CheckedHeads | null, c: CheckedHead, fromZero: boolean): CheckedHeads => {
  const heads = kept?.heads.includes(c.head) ? kept.heads : [...(kept?.heads ?? []), c.head];
  /* The heads checked last, whole, oldest first: a recovery resuming from one before the latest gives up what came after it. */
  const recent = [...(kept?.recent ?? []).filter((r) => r.seq < c.seq), c].slice(-RECENT_KEPT);
  return {
    ...(kept?.base === undefined ? {} : { base: kept.base }), ...(kept?.from === undefined ? {} : { from: kept.from }),
    latest: kept !== null && kept.latest.seq > c.seq ? kept.latest : c, fromZero: fromZero ? c : (kept?.fromZero ?? null), heads, recent,
  };
};

/** **WHERE A DEVICE NEW TO THE COMPANY STARTS CHECKING**, and, for a vouched head, the record the run's approvers vouched with: it must prove into the root reached. */
interface StartHere {
  readonly from: CheckedHead;
  readonly said: StartedFrom;
  readonly holds?: { readonly name: RecordName; readonly digest: Hex };
}

/** What a device keeps from the moment it starts at `start`: that head alone, its seq the first of its heads. */
const keptAt = (start: StartHere): CheckedHeads =>
  ({ latest: start.from, fromZero: null, heads: [start.from.head], base: start.from.seq, from: start.said });

/** A start a device passed over: the record its run vouched with does not prove into the root reached from it. */
class PassedOver extends Error {}

/** How many pages of headers a device reads looking for the header at a head it starts from, before it gives that head up. */
const START_PAGES_AT_MOST = 16;

/**
 * **THE HEADER WHOSE HEAD IS `head`**, among the headers the service keeps from
 * the seq after `after`: believed only as the account's own functions make
 * `head` from it and the head it names before it, so it is the one the chain
 * took. Null when none of the pages read holds it.
 */
const headerAtHead = async (doors: HeldDoors, head: Hex, after: number): Promise<TreeHeader | null> => {
  let seq = Math.max(-1, after);
  for (let pages = 0; pages < START_PAGES_AT_MOST; pages += 1) {
    const page = await doors.tree.headersAfter(doors.accountId, seq, HEADERS_AT_ONCE);
    const given = (page.headers ?? []).filter((h): h is TreeHeader => treeHeaderReadable(h) && h.seq > seq);
    if (given.length === 0) return null;
    const a = await doors.builder.anchorHeads({ after: given.map(headStepOf) });
    const i = given.findIndex((_, k) => String(a?.after?.[k] ?? '').toLowerCase() === head);
    if (i >= 0) return given[i]!;
    seq = Math.max(...given.map((h) => h.seq));
  }
  return null;
};

/**
 * **WHERE A DEVICE NEW TO THE COMPANY MAY START, NEWEST FIRST**, never from what
 * the service says alone:
 *   - a company whose account requires one approval (its threshold 1), so that
 *     one key is a whole quorum: from the header before the
 *     latest, so the latest is checked against it - one key is the whole
 *     quorum, so the company trusts its latest header;
 *   - otherwise: each head a payroll run vouches for, newest on the chain
 *     first - a run the account's history shows paid or charged with its
 *     threshold of approvals (`AnchorsOnChain.vouching`), whose sealed proposal
 *     makes its identity again with the head it seals - from the header whose
 *     head that is. A head the account's history does not show is passed over.
 * Nothing - a company of more than one key whose runs vouch for nothing, or
 * none of whose vouched heads can be reached - means checking from its first
 * header.
 */
async function* startsHere(doors: HeldDoors, now: AnchorsOnChain): AsyncGenerator<StartHere> {
  const landed = now.landed.map((l) => l.head.toLowerCase() as Hex);
  if (landed.length === 0) return;
  if (now.now.approvals <= 1) {
    const latest = await headerAtHead(doors, landed[landed.length - 1]!, landed.length - 2);
    if (latest === null || latest.seq === 0) return;
    const before = await headerAtHead(doors, latest.previous, latest.seq - 2);
    if (before === null || before.seq !== latest.seq - 1) return;
    const from = checkedAfter(before, latest.previous);
    yield { from, said: { by: 'latest', seq: from.seq, head: from.head } };
    return;
  }
  if (doors.vouching === undefined || (now.vouching ?? []).length === 0) return;
  const at = new Map(now.vouching.map((v) => [v.chainId.toLowerCase(), v.at]));
  const order = new Map(landed.map((h, i) => [h, i]));
  const claims = (await doors.vouching.runs([...at.keys()]))
    .filter((c) => at.has(c.chainId) && order.has(c.run.vouched.head))
    .sort((a, b) => order.get(b.run.vouched.head)! - order.get(a.run.vouched.head)!);
  for (const c of claims) {
    const { run } = c;
    const id = await doors.vouching.identity({
      root: run.root, payees: String(run.payees), opensAt: String(run.opensAt), closesAt: String(run.closesAt), required: String(run.required),
      vault: run.vault, head: run.vouched.head, r: run.vouched.r,
    });
    if (id === null || id.toLowerCase() !== c.chainId) continue;
    const header = await headerAtHead(doors, run.vouched.head, order.get(run.vouched.head)! - 1);
    if (header === null) continue;
    const from = checkedAfter(header, run.vouched.head);
    yield {
      from, said: { by: 'vouched', seq: from.seq, head: from.head, run: c.chainId, ...(at.get(c.chainId) === undefined ? {} : { at: at.get(c.chainId)! }) },
      holds: { name: { store: 'proposal', kind: 'proposal', id: c.proposal }, digest: c.entryDigest },
    };
  }
}

/**
 * **THE COMPANY'S RECORDS AS THE HEAD ON CHAIN HOLDS THEM, FOR WHAT ONE READ
 * ASKED, READ HERE NOW.** The head is the one the account's history holds at
 * the indexer the person's own wallet names. Every header from the last head
 * this device checked (kept in its own storage; from the company's first
 * header when it kept none) up to that head is checked against the one before
 * it (`checkForward`): a header's filings and its anchoring seat are judged by
 * the company's directory as anchored with it, each version of which is
 * counted against who held the account as the batch that first anchored it
 * named them - the approvals and the seats its signer tree's leaves name,
 * which the call checked; a claim is believed by its own opening, never by the
 * committee. Then, in one request each, the
 * entries not yet anchored at the root reached, and the leaves of every record
 * and kind asked - with the directory always, and the founding records when
 * founding is asked - proven against that root, each with every older version.
 */
export async function recordsHeldHere(doors: HeldDoors, asked: RecordsAsked): Promise<ReadHere> {
  const [now, here] = await Promise.all([doors.onChain(), doors.directory()]);
  let kept = (await doors.checked?.read(doors.accountId)) ?? null;
  /* Only heads checked from the company's first header, or from a start this device chose, say which head each batch left. */
  if (kept !== null && kept.fromZero === null && kept.from === undefined) kept = null;
  if (kept !== null) return heldFrom(doors, asked, now, here, kept, null);
  /*
   * **A DEVICE NEW TO THE COMPANY** starts where `startsHere` says, newest
   * first, and keeps nothing until the read from that start holds what it must;
   * with no start, it checks from the company's first header.
   */
  for await (const start of startsHere(doors, now)) {
    try {
      return await heldFrom(doors, asked, now, here, keptAt(start), start);
    } catch (e) {
      if (!(e instanceof PassedOver)) throw e;
    }
  }
  return heldFrom(doors, asked, now, here, null, null);
}

/** **THE READ ITSELF**, from what this device kept (`kept`), or from a start it chose (`start`), or from the company's first header. */
async function heldFrom(
  doors: HeldDoors, asked: RecordsAsked, now: AnchorsOnChain, here: DirectoryBelieved, keptBefore: CheckedHeads | null, chosen: StartHere | null,
): Promise<ReadHere> {
  const company = doors.accountId;
  const { landed } = now;
  const head = headOn(landed);
  const landedBy = new Map(landed.map((l) => [l.head.toLowerCase(), l]));
  let kept = keptBefore;
  const from: CheckedHead = kept?.latest ?? GENESIS;
  /* Every head this device checked, by the seq of the batch that left it. */
  const base = kept?.base ?? 0;
  const headsBySeq = new Map<number, Hex>((kept?.heads ?? []).map((h, i) => [base + i, h.toLowerCase() as Hex]));
  /* The chain as the wallet's indexer shows it, behind a head this device already checked: nobody's doing yet, and nothing is read. */
  if (from.seq >= 0 && head !== from.head && (head === EMPTY_HEAD || [...headsBySeq].some(([seq, h]) => h === head && seq < from.seq))) {
    throw new AnchorNotMade(INDEXER_BEHIND);
  }

  /* The company's directory as anchored, version by version: what each header's seats are judged by. */
  const dirAt = new Map<number, DirectoryVersionHeld>();
  const seatsByHeld = new Map<string, readonly string[] | null>();
  const readSeats = async (helds: readonly BatchHolders[]): Promise<void> => {
    const missing = [...new Map(helds.filter((h) => !seatsByHeld.has(heldKey(h))).map((h) => [heldKey(h), h])).values()];
    if (missing.length === 0) return;
    const a = await doors.builder.anchorHeads({ after: [], holders: missing });
    if (!Array.isArray(a?.holderSeats) || a.holderSeats.length !== missing.length) {
      throw new AnchorNotMade('this device could not read which seats the company\'s headers name. Reload the page');
    }
    missing.forEach((h, i) => seatsByHeld.set(heldKey(h), a.holderSeats[i] ?? null));
  };
  /**
   * The first head the account's history shows from the batch on: the block the batch's anchor landed in. Null for a
   * batch whose header no landed head follows, which was never anchored as shown.
   */
  const landedFrom = (batch: number): AnchorLanded | null => {
    for (let k = batch; headsBySeq.has(k); k += 1) {
      const l = landedBy.get(headsBySeq.get(k)!);
      if (l !== undefined) return l;
    }
    return null;
  };
  /*
   * Who held the account as a version was anchored: the approvals and seats its batch's header names, which the anchor
   * call checked, and the seat bar of the state the block that call landed in left. A bar that was not read is refused.
   */
  const accountHeldOf = (d: Pick<DirectoryVersionHeld, 'held' | 'batch'>): AccountHeld | null => {
    const seats = seatsByHeld.get(heldKey(d.held));
    const landedIn = landedFrom(d.batch);
    if (seats === undefined || seats === null || landedIn === null) return null;
    if (!Number.isSafeInteger(landedIn.seatBar) || landedIn.seatBar < 1) {
      throw new AnchorNotMade('this device could not read the approvals a change of who is seated needed as the company\'s records '
        + 'were anchored. Reload the page');
    }
    return { approvals: d.held.approvals, seats, seatBar: landedIn.seatBar };
  };
  const directoryOfLeaf = async (root: Hex): Promise<void> => {
    const given = await doors.tree.proofs(company, { root, records: [DIRECTORY], kinds: [] });
    if (given === null) throw new AnchorNotMade(ROOT_NOT_KEPT);
    const leaf = given.records[0] ?? null;
    if (provenRefusal(root, { records: [{ name: DIRECTORY, leaf }] }, given.proof) !== null) throw new AnchorNotMade(NOT_PROVEN);
    const versions = leaf === null ? new Map<number, DirectoryVersionHeld>() : directoryVersionsOf(leaf, olderOf(given.older));
    if (versions === null) throw new AnchorNotMade(NOT_PROVEN);
    for (const [v, d] of versions) dirAt.set(v, d);
    await readSeats([...versions.values()].map((d) => d.held));
  };
  /*
   * **THE HEAD EACH BATCH BEFORE THIS DEVICE'S START LEFT**, for a directory
   * version one of them anchored: the committee after its block is read from the
   * account's history at that head. A header is taken only as the account's own
   * functions make a head the history shows from it, or the one this device
   * started from, through the headers after it.
   */
  const headsBefore = async (batches: readonly number[]): Promise<void> => {
    for (const b of [...new Set(batches)].sort((x, y) => x - y)) {
      if (b >= base || headsBySeq.has(b)) continue;
      const previousOf = new Map<number, Map<Hex, Hex>>();
      let heads = new Set<Hex>();
      for (let k = b; k <= base; k += 1) {
        const page = await doors.tree.headersAfter(company, k - 1, 1);
        const at = (page.headers ?? []).filter((h): h is TreeHeader => treeHeaderReadable(h) && h.seq === k && (k === b || heads.has(h.previous)));
        if (at.length === 0) break;
        const a = await doors.builder.anchorHeads({ after: at.map(headStepOf) });
        const made = new Map<Hex, Hex>(at.map((h, i) => [String(a?.after?.[i] ?? '').toLowerCase() as Hex, h.previous]));
        previousOf.set(k, made);
        const shown = [...made.keys()].find((h) => landedBy.has(h) || h === headsBySeq.get(k));
        if (shown !== undefined) {
          let h: Hex | undefined = shown;
          for (let j = k; j >= b && h !== undefined; j -= 1) { if (j < base) headsBySeq.set(j, h); h = previousOf.get(j)?.get(h); }
          break;
        }
        heads = new Set(made.keys());
      }
    }
  };
  if (from.head !== head && from.dirVersion > 0) {
    await directoryOfLeaf(from.root);
    await headsBefore([...dirAt.values()].map((d) => d.batch));
  }

  /** The first directory version a header on the chain's path anchors that the service did not serve, or served as other bytes. */
  let servedShort: { readonly version: number; readonly without: boolean } | undefined;
  /** Which seat held a key, by the directory as anchored at `dirVersion` - each version counted against who held the account as it was anchored. */
  const seatOf = (publicKey: Hex, entry: ManifestEntryBody | undefined, dirVersion: number, header: TreeHeader): string | null | undefined => {
    const inHeader = new Map(header.changes.filter((c) => c.leaf.store === 'directory').map((c) => [c.leaf.version, c.leaf]));
    /* Every version anchored up to `dirVersion` is in `dirAt` or this header; one in neither was passed over, never entered. */
    const digests = new Map<number, Hex>();
    for (let v = 1; v <= dirVersion; v += 1) {
      const d = dirAt.get(v)?.digest ?? inHeader.get(v)?.digest;
      if (d !== undefined) digests.set(v, d);
    }
    const asAnchoredHere: HeldAsAnchored = (v) => {
      const d = dirAt.get(v) ?? (inHeader.has(v) ? { held: header.held, batch: header.seq } : undefined);
      if (d !== undefined) return accountHeldOf(d);
      /* A version the anchor passed over was never entered: its change is not applied. */
      return v <= dirVersion ? null : undefined;
    };
    const then = here.at(dirVersion, asAnchoredHere);
    if (then === null) {
      /* The first version not served: the directory served is replayed to one version per filing, so it is the one after its own. */
      servedShort ??= { version: here.dir.version + 1, without: true };
      return undefined;
    }
    const other = [...digests].find(([v, d]) => then.digests[v - 1] !== d);
    if (other !== undefined) {
      servedShort ??= { version: other[0], without: false };
      return undefined;
    }
    return seatAsAnchoredHere(here, { version: dirVersion, digests }, publicKey, entry, asAnchoredHere);
  };
  let first: TreeHeader | undefined;
  let fromZero = kept === null;
  /* What the pages gave beside their headers: what the last header checked is kept with. */
  const givenEntries = new Map<Hex, ManifestEntry>();
  const givenLeaves = new Map<Hex, TreeLeaf>();
  let lastChecked: TreeHeader | undefined;
  /*
   * Which seat each tag is, read only when the chain holds a head to map: a
   * seat whose entry this device did not believe leaves its tag unmapped, and
   * the check goes on without it.
   */
  const tagged = doors.tagSeats === undefined || landed.length === 0 ? undefined : await doors.tagSeats(here).catch(() => undefined);
  /* A head this device checked before the one it checks from, whole: what a recovery the quorum approved may resume from. */
  const earlier = (h: Hex): CheckedHead | undefined => kept?.recent?.find((r) => r.head === h.toLowerCase());
  const forwardFrom = (start: CheckedHead) => checkForward({
    company, from: start, landed: new Set(landed.map((l) => l.head.toLowerCase() as Hex)), chainHead: head,
    ...(kept?.recent === undefined || kept.recent.length === 0 ? {} : { earlier, earliestSeq: kept.recent[0]!.seq }),
    ...(tagged === undefined ? {} : { tagSeat: (t: Hex) => tagged.get(t.toLowerCase()) }),
    headersAfter: async (seq, limit) => {
      const page = await doors.tree.headersAfter(company, seq, limit);
      for (const e of page.entries ?? []) if (manifestEntryRefusal(company, e) === null) givenEntries.set(entryIdOf(e as ManifestEntry), e as ManifestEntry);
      for (const l of page.leaves ?? []) if (treeLeafRefusal(l) === null) givenLeaves.set(leafHashOf(l as TreeLeaf), l as TreeLeaf);
      return page;
    },
    headsOf: async (steps) => {
      const a = await doors.builder.anchorHeads({ after: steps });
      if (!Array.isArray(a?.after) || a.after.length !== steps.length) {
        throw new AnchorNotMade('this device could not read the anchor\'s heads. Reload the page');
      }
      if (a.after.some((h) => typeof h !== 'string')) throw new AnchorNotMade('the anchor\'s heads were not read for every batch. Reload the page');
      return a.after as Hex[];
    },
    seatOf,
    confirmed: async (path) => {
      for (const s of path) headsBySeq.set(s.header.seq, s.head);
      await readSeats(path.map((s) => s.header.held));
    },
    keep: async (c, header) => {
      for (const ch of header.changes) {
        if (ch.leaf.store === 'directory') dirAt.set(ch.leaf.version, { digest: ch.leaf.digest, batch: header.seq, held: header.held });
      }
      if (header.seq === 0) first = header;
      for (const ch of header.changes) if (ch.prior !== null) givenLeaves.set(leafHashOf(ch.prior), ch.prior);
      lastChecked = header;
      kept = keptAfter(kept, c, fromZero);
      /* From a start this device chose, nothing is kept until the read holds what it must (below). */
      if (chosen === null) await doors.checked?.write(company, kept);
    },
  });
  let forward = await forwardFrom(from);
  /*
   * **A HEADER THE SERVICE DID NOT GIVE, FILED AGAIN FROM THIS DEVICE**: where the
   * check stops `not-given` at a batch this device kept a header of - one it
   * signed, or the last it checked - it files that header again with its entries
   * in one request, the header judged by its own signature and each entry by the
   * header naming it - so an entry whose record's bytes the service lost is kept
   * again and that record read as withheld, never a header every device stops
   * at - and checks on from where it stopped. Whether it is the one the chain
   * holds is the check's, as for any header.
   */
  if (forward.stop?.stop === 'not-given' && doors.headers !== undefined) {
    const keptAt = await doors.headers.at(company, forward.stop.seq);
    for (const k of keptAt) {
      try { await doors.tree.fileHeader(company, k.header, k.entries.slice(0, ENTRIES_AT_ONCE)); } catch { /* the service would not keep it: the check says */ }
    }
    if (keptAt.length > 0) forward = await forwardFrom(forward.reached);
  }
  fromZero = false;
  const { reached } = forward;
  /*
   * A head no header was given for is said as the quorum's recovery where one moved the anchor on after the head reached
   * - the batches this device cannot follow were given up, not withheld - and otherwise with the seat that moved the
   * anchor past it, where its tag maps to one: the block's last anchoring seat, said so where the block held several.
   */
  const stop = forward.stop?.stop !== 'not-given' ? forward.stop : (() => {
    const after = landed.slice(landed.findIndex((l) => l.head.toLowerCase() === reached.head) + 1);
    if (after.some((l) => l.recovered === true)) return { ...forward.stop, recovery: true as const };
    const next = after[0];
    const by = next?.tag === undefined ? undefined : tagged?.get(next.tag.toLowerCase());
    if (by === undefined) return forward.stop;
    return { ...forward.stop, movedBy: by, ...((next!.anchorsInBlock ?? 1) > 1 ? { anchorsInBlock: next!.anchorsInBlock } : {}) };
  })();
  /* The last header this device checked, kept with what checking it needs, so this device can file it again. */
  if (lastChecked !== undefined) {
    await doors.headers?.checked(company, keptWith(lastChecked, (id) => givenEntries.get(id), (h) => givenLeaves.get(h)));
  }

  /* The entries not yet anchored at the root reached, then every leaf this read needs, proven against that root. */
  const pendingGiven = await doors.tree.pending(company, reached.root);
  if (pendingGiven === null) throw new AnchorNotMade(ROOT_NOT_KEPT);
  const pending = pendingGiven.filter((e) => manifestEntryRefusal(company, e) === null) as ManifestEntry[];
  const names = recordsProvenFor(asked);
  /* From a vouched head: the proposal its run's approvers approved, which must prove into the root reached. */
  if (chosen?.holds !== undefined && !names.some((n) => recordKeyOf(n) === recordKeyOf(chosen.holds!.name))) names.push(chosen.holds.name);
  const wanted = new Set(names.map(recordKeyOf));
  const kinds = asked.kinds ?? [];
  const kindKeys = new Set(kinds.map(kindKeyOf));
  const ofAsked = (e: ManifestEntryBody) => asked.everyPending === true || wanted.has(recordKeyOf(e)) || kindKeys.has(kindKeyOf(e));
  for (const e of pending) {
    if (asked.everyPending === true && !wanted.has(recordKeyOf(e))) { wanted.add(recordKeyOf(e)); names.push({ store: e.store, kind: e.kind, id: e.id }); }
  }
  /*
   * One request for what the read asked; an anchoring read asking every
   * pending entry's record asks in parts of what one request may hold, each
   * part proven against the same root.
   */
  const leaves: { readonly name: RecordName; readonly leaf: TreeLeaf | null }[] = [];
  let kindLeaves: { readonly kind: KindAsked; readonly leaves: TreeLeaf[] }[] = [];
  const olderGiven: unknown[] = [];
  for (let i = 0; i === 0 || i < names.length; i += PROVEN_AT_ONCE) {
    const part = names.slice(i, i + PROVEN_AT_ONCE);
    const partKinds = i === 0 ? kinds : [];
    const given = await doors.tree.proofs(company, { root: reached.root, records: part, kinds: partKinds });
    if (given === null) throw new AnchorNotMade(ROOT_NOT_KEPT);
    const partLeaves = part.map((name, k) => ({ name, leaf: given.records[k] ?? null }));
    const partKindLeaves = partKinds.map((kind, k) => ({ kind, leaves: [...(given.kinds[k] ?? [])] }));
    if (provenRefusal(reached.root, { records: partLeaves, kinds: partKindLeaves }, given.proof) !== null) throw new AnchorNotMade(NOT_PROVEN);
    leaves.push(...partLeaves);
    if (i === 0) kindLeaves = partKindLeaves;
    olderGiven.push(...given.older);
  }
  const older = olderOf(olderGiven);
  const history = new Map<string, readonly HeldVersion[]>();
  for (const l of [...leaves.map((x) => x.leaf), ...kindLeaves.flatMap((k) => k.leaves)]) {
    if (l === null) continue;
    const versions = versionsOf(l, older);
    if (versions === null) throw new AnchorNotMade(NOT_PROVEN);
    history.set(recordKeyOf(l), versions);
  }
  if (chosen?.holds !== undefined && !(history.get(recordKeyOf(chosen.holds.name)) ?? []).some((v) => v.digest === chosen.holds!.digest)) {
    throw new PassedOver();
  }
  const dirLeaf = leaves.find((x) => recordKeyOf(x.name) === recordKeyOf(DIRECTORY))!.leaf;
  const directory = dirLeaf === null ? new Map<number, DirectoryVersionHeld>() : directoryVersionsOf(dirLeaf, older);
  if (directory === null) throw new AnchorNotMade(NOT_PROVEN);
  for (const [v, d] of directory) dirAt.set(v, d);
  await readSeats([...directory.values()].map((d) => d.held));
  await headsBefore([...directory.values()].map((d) => d.batch));
  const maxAnchored = Math.max(0, ...directory.keys());
  const held: HeldAsAnchored = (version) => {
    const d = directory.get(version);
    if (d !== undefined) return accountHeldOf(d);
    /* A version below the newest anchored that no leaf holds was passed over, never entered: its change is never applied. */
    if (version < maxAnchored) return null;
    /* Past a header this device could not check, a version may be anchored by a batch whose holders are not known. */
    return stop !== null && version > maxAnchored ? null : undefined;
  };

  const leaving = await doors.leaving?.();
  const notYetAnchored = waitingAmong(pending, history, ofAsked, seatOfHere(here, held), leaving);

  /* Who founded the company: the first header, checked against the empty tree and folded to the first head this device checked. */
  let founding: { first?: TreeHeader | null; firstSeats?: readonly string[] | null } = {};
  if (asked.founding === true) {
    if (reached.seq < 0) {
      founding = { first: null };
    } else {
      const h0 = first ?? await firstHeaderHere(doors, seatOf, headsBySeq.get(0) ?? (landed[0]?.head.toLowerCase() as Hex | undefined));
      await readSeats([h0.held]);
      founding = { first: h0, firstSeats: seatsByHeld.get(heldKey(h0.held)) ?? null };
    }
  }
  /* A start this device chose is kept only now, the read from it holding what it must. */
  if (chosen !== null && kept !== null) await doors.checked?.write(company, kept);
  const records: RecordsHeldHere = {
    ...(kept?.from === undefined ? {} : { checkedFrom: kept.from }),
    ...(forward.recovered === undefined ? {} : { recovered: forward.recovered }),
    head, reached, stopped: stop,
    asked: { records: wanted, kinds: kindKeys },
    history, notYetAnchored, directory, held, deployed: now.deployed ?? null, ...founding,
    ...(leaving === undefined ? {} : { leaving }),
    seqOfHead: (h: string) => {
      const asked = h.toLowerCase();
      if (asked === EMPTY_HEAD) return -1;
      for (const [seq, checked] of headsBySeq) if (checked === asked) return seq;
      return null;
    },
    newestLandedBy: (cutoff: number) => {
      let at = -1;
      for (let i = landed.length - 1; i >= 0 && at < 0; i -= 1) {
        const t = landed[i]!.at;
        if (Number.isSafeInteger(t) && t > 0 && t <= cutoff) at = i;
      }
      if (at < 0) return 'none';
      const wanted = landed[at]!.head.toLowerCase();
      for (const [seq, checked] of headsBySeq) if (checked === wanted) return { seq };
      /*
       * Not checked here. This device checked every head from where it started (`base`) to the one it reached, so a head
       * that landed before the start is older than any head a raise it can judge names; any other is past its check.
       */
      const started = landedFrom(base);
      return started !== null && at < landed.indexOf(started) ? 'none' : 'unread';
    },
    ...(stop !== null && servedShort !== undefined ? { directoryServed: servedShort } : {}),
  };
  return { landed, now, here, records, pending: new Set(pending.map(entryIdOf)) };
}

/**
 * **WHAT IS NOT YET ANCHORED**, of the entries a service lists as waiting: each
 * of a record the read asked, newer than its leaf (`history`), entered by a seat
 * `seatNow` says may file it now, naming no older version's bytes - the first
 * at each version. An entry a seat under an approved removal filed past the
 * boundary the raise names (`leaving`) is never one: no device anchors it. A
 * directory version is judged by its own replay, never by a boundary.
 */
const waitingAmong = (
  pending: readonly ManifestEntry[], history: ReadonlyMap<string, readonly HeldVersion[]>,
  ofAsked: (e: ManifestEntryBody) => boolean, seatNow: (publicKey: Hex, entry: ManifestEntryBody) => string | null,
  leaving?: LeavingBoundaries,
): ManifestEntry[] => {
  const out: ManifestEntry[] = [];
  const named = new Set<string>();
  const seen = new Map<string, Hex[]>([...history].map(([k, v]) => [k, v.map((x) => x.digest)]));
  for (const e of pending) {
    const key = recordKeyOf(e);
    const at = history.get(key);
    const anchored = at === undefined || at.length === 0 ? 0 : at[at.length - 1]!.version;
    if (!ofAsked(e) || anchored >= e.version || named.has(`${key}@${e.version}`)) continue;
    if (seatNow(e.filedBy.publicKey, e) === null || (seen.get(key) ?? []).includes(e.digest)) continue;
    if (e.store !== 'directory' && pastTheRaisedBoundary(leaving, e.filedBy.publicKey, boundaryKeyOfEntry(e), e.version)) continue;
    named.add(`${key}@${e.version}`);
    seen.set(key, [...(seen.get(key) ?? []), e.digest]);
    out.push(e);
  }
  return out;
};

const INDEXER_BEHIND = 'the account\'s history at your wallet\'s indexer is behind what this device has already checked, so nothing is '
  + 'read from it now. Wait a minute and reload the page; if it stays behind, your wallet\'s indexer is serving an older chain';
const ROOT_NOT_KEPT = 'the service keeps no header that makes the root this device checked, so nothing can be read against it. Reload '
  + 'the page; if it happens again, the service is withholding the company\'s records';
const NOT_PROVEN = 'the leaves the service gave do not prove into the root the anchor on chain holds, or an older version of one was '
  + 'not given. Reload the page; if it happens again, the service is changing the company\'s records';

/** The older leaves a service gave, by their hash. */
const olderOf = (given: readonly unknown[]): ((hash: Hex) => TreeLeaf | undefined) => {
  const by = new Map<Hex, TreeLeaf>();
  for (const l of given) if (treeLeafRefusal(l) === null) by.set(leafHashOf(l as TreeLeaf), l as TreeLeaf);
  return (hash) => by.get(hash);
};

/**
 * **THE COMPANY'S FIRST HEADER**, asked of the service and believed only once it
 * is an honest first step from the empty tree and the head after it is the
 * first head this device checked.
 */
async function firstHeaderHere(doors: HeldDoors, seatOf: TransitionInput['seatOf'], firstHead: Hex | undefined): Promise<TreeHeader> {
  const company = doors.accountId;
  const page = await doors.tree.headersAfter(company, -1, 1);
  /* Every first header the service keeps - one filed before a call the chain refused among them - and the one whose head the chain took. */
  const candidates = (page.headers ?? []).filter((h) => treeHeaderReadable(h) && h.seq === 0 && h.previous === EMPTY_HEAD) as TreeHeader[];
  const heads = candidates.length === 0 || firstHead === undefined ? []
    : (await doors.builder.anchorHeads({ after: candidates.map(headStepOf) })).after;
  const h0 = candidates.find((_, i) => String(heads[i] ?? '').toLowerCase() === firstHead);
  const entries = new Map((page.entries ?? []).filter((e) => manifestEntryRefusal(company, e) === null).map((e) => [entryIdOf(e as ManifestEntry), e]));
  const refused = h0 === undefined ? null
    : transitionRefusal({ company, before: GENESIS, header: h0, entry: (id) => entries.get(id), priorChain: () => undefined, seatOf });
  if (h0 === undefined || refused !== null) {
    throw new AnchorNotMade('the service did not give the company\'s first header as the chain holds it, so who founded the company '
      + 'cannot be said. Reload the page; if it happens again, the service is withholding it');
  }
  return h0;
}

/**
 * **THE ONE WAY A DEVICE'S READS BELIEVE THE COMPANY'S RECORDS**: for a
 * directory just believed and what a read asked, the records as the head on
 * chain holds them, read now. What every reader is handed with the directory
 * (`DirectoryHereDeps.anchored`).
 */
export const heldFor = (
  doors: Omit<HeldDoors, 'directory'>,
) => async (directory: DirectoryBelieved, asked: RecordsAsked): Promise<RecordsHeldHere> =>
  (await recordsHeldHere({ ...doors, directory: async () => directory }, asked)).records;

/** Every directory version the manifest does not name yet, entered by this seat as their witness. */
async function directoryWitnessed(doors: AnchorDoors): Promise<void> {
  const [filings, [named]] = await Promise.all([doors.directoryFilings(), doors.manifest.newest(doors.accountId, [DIRECTORY])]);
  const owed = filings.filter((f) => f.version > (named ?? 0)).sort((a, b) => a.version - b.version)
    .map((f) => signManifestEntry(doors.accountId, directoryEntry(f), doors.material.signingSecret as Hex));
  for (let i = 0; i < owed.length; i += ENTRIES_AT_ONCE) await doors.manifest.enter(doors.accountId, owed.slice(i, i + ENTRIES_AT_ONCE));
}

/**
 * Every proposal this seat wrote down that the manifest does not name, entered
 * by this seat, its filer: only one whose filing this seat's own signature
 * covers, so nothing the service made up under this seat's key is entered.
 */
async function ownProposalsEntered(doors: AnchorDoors): Promise<void> {
  const secret = doors.material.signingSecret as Hex;
  const mine = signingPublicKeyOf(secret);
  const proposals = (await doors.service.sealedProposals(doors.accountId))
    .filter((p) => p.accountId === doors.accountId && p.filedBy?.publicKey.toLowerCase() === mine)
    .filter((p) => proposalFilingRefusal(doors.accountId, p) === null);
  const owed: ManifestEntry[] = [];
  for (let i = 0; i < proposals.length; i += ENTRIES_AT_ONCE * 4) {
    const some = proposals.slice(i, i + ENTRIES_AT_ONCE * 4);
    const versions = await doors.manifest.newest(doors.accountId, some.map((p) => ({ store: 'proposal' as const, kind: 'proposal', id: p.id })));
    some.forEach((p, j) => { if ((versions[j] ?? 0) === 0) owed.push(signManifestEntry(doors.accountId, proposalEntry(doors.accountId, p), secret)); });
  }
  for (let i = 0; i < owed.length; i += ENTRIES_AT_ONCE) await doors.manifest.enter(doors.accountId, owed.slice(i, i + ENTRIES_AT_ONCE));
}

/**
 * **THE RECORDS THIS SEAT FOUNDED THE COMPANY WITH, ENTERED BY THIS SEAT**: its
 * first state and its first roster, each only when this seat's own signature
 * covers it as the founding signer's, and only when the manifest does not name
 * it yet. A seat that did not found the company enters nothing here.
 */
async function foundingRecordsEntered(doors: AnchorDoors): Promise<void> {
  const company = doors.accountId;
  const secret = doors.material.signingSecret as Hex;
  const mine = signingPublicKeyOf(secret);
  const [founding, versions] = await Promise.all([doors.service.foundingRecords(company), doors.manifest.newest(company, FOUNDING_RECORDS)]);
  const named = new Set(FOUNDING_RECORDS.filter((_, i) => (versions[i] ?? 0) > 0).map(recordKeyOf));
  const owed = [
    founding.state !== null && foundingStateRefusal(founding.state, company, mine) === null ? founding.state : null,
    founding.roster !== null && foundingRosterRefusal(founding.roster, company, mine) === null ? founding.roster : null,
  ].filter((r): r is SealedCompanyRecord => r !== null)
    .map((r) => companyRecordEntry(r))
    .filter((e) => !named.has(recordKeyOf(e)))
    .map((e) => signManifestEntry(company, e, secret));
  if (owed.length > 0) await doors.manifest.enter(company, owed);
}

/**
 * **WHY THIS DEVICE DOES NOT MAKE THE COMPANY'S FIRST ANCHOR FROM THIS BATCH**:
 * the first anchor is the founding seat's, so it must hold the company's first
 * state and first roster, each entered by the seat anchoring it. Null when it
 * does, or when something is anchored already.
 */
const firstAnchorRefusal = (doors: AnchorDoors, records: RecordsHeld): string | null => {
  if (records.head !== EMPTY_HEAD) return null;
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  const held = (kind: 'state' | 'roster', id: string) => records.notYetAnchored.some((e) => e.store === 'company' && e.kind === kind
    && e.id === id && e.version === 1 && e.filedBy.publicKey.toLowerCase() === mine);
  if (held('state', stateRecordId(FOUNDING_KEY_EPOCH)) && held('roster', ROSTER_ID)) return null;
  return 'the company\'s first anchor holds the records it was founded with - its first state and its first roster - entered by '
    + 'its founding signer\'s device, and this device did not enter them. Nothing was sent. The company\'s founding signer '
    + 'opens the company on their own device to anchor them';
};

/**
 * **EVERY ENTRY THIS PAGE SIGNED THAT THE MANIFEST IT IS SERVED DOES NOT NAME,
 * ENTERED AGAIN.** One behind a newer version of the same record was
 * superseded: it is let go of and said, never entered again. Whether the
 * service then gives the rest is asked of the very read the header is made
 * from (`ownFilingsLeftOut`), never of another. The superseded, said.
 */
async function ownFilingsEntered(doors: AnchorDoors): Promise<string[]> {
  const company = doors.accountId;
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  const own = enteredOnThisPage(company).filter((e) => e.filedBy.publicKey.toLowerCase() === mine);
  if (own.length === 0) return [];
  const names = [...new Map(own.map((e) => [recordKeyOf(e), { store: e.store, kind: e.kind, id: e.id }])).values()];
  const versions = await doors.manifest.newest(company, names);
  const newest = new Map(names.map((r, i) => [recordKeyOf(r), versions[i] ?? 0] as const));
  const superseded = own.filter((e) => (newest.get(recordKeyOf(e)) ?? 0) > e.version)
    .map((e) => supersededSaid(e, newest.get(recordKeyOf(e))!));
  letGoOfEntered(company, (e) => (newest.get(recordKeyOf(e)) ?? 0) > e.version);
  const missing = own.filter((e) => (newest.get(recordKeyOf(e)) ?? 0) < e.version);
  if (missing.length === 0) return superseded;
  try {
    for (let i = 0; i < missing.length; i += ENTRIES_AT_ONCE) await doors.manifest.enter(company, missing.slice(i, i + ENTRIES_AT_ONCE));
  } catch (e) {
    throw new AnchorNotMade(`${missing.length} filing(s) this device made were not in the company's records and could not be entered `
      + `again (${(e as Error)?.message ?? String(e)}). Reload the page and anchor again`, { cause: e });
  }
  return superseded;
}

/**
 * Why this device does not anchor from a read that leaves out a filing of its
 * own seat's that the anchor does not hold yet: the header made from it would
 * leave that record at its last anchored version. Null when none is.
 */
const ownFilingsLeftOut = (doors: AnchorDoors, read: ReadHere): string | null => {
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  const still = enteredOnThisPage(doors.accountId).filter((e) => e.filedBy.publicKey.toLowerCase() === mine
    && !read.pending.has(entryIdOf(e)) && newestAnchored(read.records, e) < e.version);
  if (still.length === 0) return null;
  const e = still[0]!;
  return `the service keeps leaving version ${e.version} of ${e.store} record ${e.id}, which this device filed and entered, out of `
    + `the company's records${still.length > 1 ? `, and ${still.length - 1} more` : ''}, so it would never be anchored. Nothing was `
    + 'sent. Reload the page; if it happens again, the service is withholding it';
};

/**
 * **EVERY FILING NOT YET ANCHORED, ANCHORED FROM THIS DEVICE**, at most a
 * header's worth at a time. Nothing to anchor is an answer, not a refusal.
 * Refused, with nothing sent, when this device cannot check a header up to the
 * head the chain holds, and when other devices kept moving the head on first.
 */
export async function anchorTheRecordsHere(doors: AnchorDoors): Promise<Anchored> {
  const company = doors.accountId;
  const secret = doors.material.signingSecret as Hex;
  let raced = false;
  for (let attempt = 0; attempt < ANCHOR_ATTEMPTS; attempt += 1) {
    await directoryWitnessed(doors);
    if ((await doors.onChain()).landed.length === 0) await foundingRecordsEntered(doors);
    await ownProposalsEntered(doors);
    const superseded = await ownFilingsEntered(doors);
    const told = superseded.length === 0 ? {} : { superseded };
    const own = enteredOnThisPage(company).map((e) => ({ store: e.store, kind: e.kind, id: e.id }));
    const read = await recordsHeldHere(doors, { everyPending: true, records: own });
    const { records } = read;
    /* What this page entered is let go of once the anchor holds it, and not before. */
    letGoOfEntered(company, (e) => newestAnchored(records, e) >= e.version);
    if (records.stopped !== null) throw new AnchorNotMade(transitionStopSaid(records.stopped));
    const leftOut = ownFilingsLeftOut(doors, read);
    if (leftOut !== null) throw new AnchorNotMade(leftOut);
    if (records.notYetAnchored.length === 0) return { anchored: 0, head: records.head, ...told };
    const first = firstAnchorRefusal(doors, records);
    if (first !== null) throw new AnchorNotMade(first);
    /* Who holds the account as this device judges the batch: what the history shows now, which must be what the wallet read. */
    const judged = read.now.now;
    const wallet = new Set(read.here.holders.seats.map((x) => x.toLowerCase()));
    if (judged.approvals !== read.here.holders.approvals || read.now.seatsNow.length !== wallet.size
      || read.now.seatsNow.some((x) => !wallet.has(x.toLowerCase()))) {
      if (attempt + 1 < ANCHOR_ATTEMPTS) { raced = true; continue; }
      throw new AnchorNotMade('who holds the company\'s account, as your wallet read it, is not what the account\'s history at its '
        + 'indexer shows yet. Nothing was sent. Wait for your wallet to catch up, then reload the page and anchor again');
    }
    /* The tag this seat anchors under, as the account's call will work it out: the header names it, and the head binds it. */
    const tag = await doors.builder.anchorTag({ account: String(read.here.holders.account), material: doors.material }) as Hex;
    const made = await treeHeaderHere({
      accountId: company, tree: doors.tree, signingSecret: secret, held: judged, tag, at: (doors.now ?? (() => new Date()))(),
    }, records.reached, records.notYetAnchored.slice(0, ENTRIES_AT_ONCE));
    if (made === null) return { anchored: 0, head: records.head, ...told };
    const { header } = made;
    const batch = treeBatchOf(header);
    /* Kept on this device first, with what checking it needs, so a header the service loses is filed again from here. */
    const olderGiven = new Map(made.older.map((l) => [leafHashOf(l), l] as const));
    await doors.headers?.signed(company, keptWith(header, (id) => records.notYetAnchored.find((e) => entryIdOf(e) === id), (h) => olderGiven.get(h)));
    /* Kept before the call is sent, so a header the chain takes is never one no device was given. */
    await doors.tree.fileHeader(company, header);
    const held = { approvals: header.held.approvals, signerRoot: header.held.signerRoot };
    try {
      const chain = await doors.service.callState(company);
      const { tx } = await doors.builder.anchor({ account: chain.account, material: doors.material, chain, previous: records.head, batch, held });
      const after = await doors.builder.anchorHeads({ after: [headStepOf(header)] });
      const ours = after.after[0]! as Hex;
      /* The send's answer, or where the head went while it gave none: a call the head moved past is not waited on. */
      const settled = { done: false };
      const went = await Promise.race([
        doors.service.sendProven(company, tx).then(() => 'answered' as const),
        whereTheSendWent(doors, records.head, ours, settled),
      ]).finally(() => { settled.done = true; });
      if (went === 'superseded') throw new Error('the head moved on while this anchor was being sent: another anchor of its head landed, or this one did and another after it');
      const sent = new Set(header.changes.map((c) => c.leaf.entryId));
      letGoOfEntered(company, (e) => sent.has(entryIdOf(e)));
      return { anchored: header.changes.length, head: ours, ...told };
    } catch (e) {
      /*
       * Read again: the head moved on by another device, or the account's approvals or signers changed since this
       * device judged the batch - either way the account refused the call with no change, and this device reads again
       * and anchors again. Neither moved: the refusal is something else, and it is said.
       */
      const again = await doors.onChain();
      const moved = headOn(again.landed) !== records.head || again.now.approvals !== judged.approvals
        || again.now.signerRoot !== judged.signerRoot;
      if (!moved) throw new AnchorNotMade(`the anchor was not sent (${(e as Error)?.message ?? String(e)}). Reload the page and anchor again`, { cause: e });
      raced = true;
    }
  }
  throw new AnchorNotMade(raced
    ? `other devices anchored the company's records first, or who holds the company's account changed, ${ANCHOR_ATTEMPTS} times running. `
      + 'What was anchored is believed; reload the page to anchor what is left'
    : 'nothing was anchored. Reload the page and anchor again');
}

/** How long a company's records may wait, with filings not yet anchored, before a device entering it anchors them. */
export const ANCHORED_AT_LEAST_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * What entering the company did about the anchor: anchored now (none when
 * nothing was waiting), left for later and why, or not anchored and why - in
 * words that say what resolves it. Never thrown: entering the company does
 * not wait on the anchor, and a filing left waiting is anchored by the next.
 */
export type OnTheWayIn =
  | (Anchored & FiledAgainOnTheWayIn)
  | { readonly waits: 'anchored-within-a-day' | 'this-seat-does-not-anchor' }
  | ({ readonly notAnchored: string } & FiledAgainOnTheWayIn);

/** What the way in filed again before it anchored at once: this seat's own entry, or signed changes passed over. */
interface FiledAgainOnTheWayIn { readonly filedAgain?: 'own-entry' | 'directory-changes' }

/**
 * **THIS SEAT'S OWN DIRECTORY ENTRY, PASSED OVER BY THE COMPANY'S RECORDS, FILED
 * AGAIN AS A NEW VERSION**: its entry was filed and never entered while a later
 * version was anchored, so no device applies it and this seat is not believed.
 * Its wallet's statement does not name a version, so the same entry is filed as
 * the directory's next version and is anchored like any other. Only an entry
 * whose statement names this seat's own signing key, and only while the
 * directory this device believes holds no seat for that key. True when filed.
 */
async function ownEntryFiledAgain(doors: AnchorDoors, here: DirectoryBelieved): Promise<boolean> {
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  if (doors.fileDirectory === undefined || here.dir.seats.some((x) => x.signingKey === mine)) return false;
  const own = (here.passedOver ?? []).filter((f) => f.change.kind === 'claim' && f.change.entry.statement.signingKey.toLowerCase() === mine);
  if (own.length === 0) return false;
  const filings = await doors.directoryFilings();
  await doors.fileDirectory({ company: doors.accountId, version: filings.length + 1, change: own[own.length - 1]!.change });
  return true;
}

/**
 * **A SIGNED CHANGE TO THE COMPANY'S DIRECTORY, FILED FROM THIS DEVICE AND
 * ANCHORED AT ONCE** - a quorum's role or retirement, or one seat's change of
 * the company's key - carrying its signatures over `signedFor`, the version it
 * was signed for. A quorum's change is kept in this device's database before it is
 * filed, and let go of only once a version carrying it is anchored, so a
 * change the service drops, passes over or stops serving is filed again from
 * here on a later way in (`quorumChangesFiledAgain`) without being signed
 * again. A change of key is never kept: one lost or passed over is made again
 * on the key the directory holds. Refused, with nothing filed or kept, when the directory already holds
 * that version: the signatures bind it, so the change is signed again as the
 * directory stands. The anchor is said, not thrown: a change filed and not yet
 * anchored is anchored by the next anchor, and a quorum's is kept until it is.
 */
export async function directoryChangeFiledHere(
  doors: AnchorDoors, change: SignedChange, signedFor: number,
): Promise<{ readonly version: number; readonly anchor: Anchored | { readonly notAnchored: string } }> {
  if (doors.fileDirectory === undefined) {
    throw new AnchorNotMade('this page cannot file a change to the company\'s directory. Nothing was filed. Reload the page to get the '
      + 'current version');
  }
  const filings = await doors.directoryFilings();
  if (filings.length + 1 !== signedFor) {
    throw new AnchorNotMade(`the change was signed for version ${signedFor} of the company's directory, and the directory holds `
      + `${filings.length} version${filings.length === 1 ? '' : 's'} now, so its signatures do not fit the next one. Nothing was filed. `
      + 'Have it signed again as the directory stands now');
  }
  /* A quorum's change is kept before it is filed, so a filing that fails, or that the service later drops, is filed again from here. */
  if (change.kind !== 'rotate') await doors.changes?.keep(doors.accountId, { signedAt: signedFor, change });
  await doors.fileDirectory({ company: doors.accountId, version: signedFor, change });
  try {
    return { version: signedFor, anchor: await anchorTheRecordsHere(doors) };
  } catch (e) {
    if (!(e instanceof AnchorNotMade)) throw e;
    return { version: signedFor, anchor: { notAnchored: e.message } };
  }
}

/**
 * **EVERY QUORUM'S CHANGE TO THE DIRECTORY NOT APPLIED, FILED AGAIN UNDER
 * ITS OWN SIGNATURES**, by a device whose seat may anchor: each change the company's
 * records passed over - or that rests on a seat one passed over - and each this
 * device kept from filing it again before, oldest version signed for first, as
 * the directory's next versions, each only when the replay would believe it
 * there (`refiledRefusalOf`). Each is kept in this device's database before it
 * is filed, and let go of once a version carrying it is anchored, so a change
 * the service passes over again or stops serving is filed again on a later way
 * in. What the replay refuses is said by `passedOverSaid`. How many it filed.
 */
async function quorumChangesFiledAgain(doors: AnchorDoors, here: DirectoryBelieved): Promise<number> {
  if (doors.fileDirectory === undefined || here.refiled === undefined) return 0;
  /* Only a quorum's change is filed again: a change of key a store hands back is never a candidate. */
  const all = (await doors.changes?.all(doors.accountId) ?? [])
    .filter((k): k is { readonly signedAt: number; readonly change: QuorumChange } => k.change.kind === 'role' || k.change.kind === 'retire');
  for (const k of all) if (here.anchoredAgain?.has(k.signedAt) === true) await doors.changes!.letGo(doors.accountId, k.signedAt);
  const kept = all.filter((k) => here.anchoredAgain?.has(k.signedAt) !== true);
  /* One kept before its first filing reached the service: its version is still the next, so it is filed as that version. */
  const next = kept.find((k) => k.signedAt === here.dir.version + 1);
  if (next !== undefined) {
    try { await doors.fileDirectory({ company: doors.accountId, version: next.signedAt, change: next.change }); } catch { return 0; }
    return 1;
  }
  const waiting = new Map<number, { readonly signedAt: number; readonly change: QuorumChange }>((here.notApplied ?? []).map((n) => [n.signedAt, n]));
  /* A change this device kept is a candidate too - one the service no longer serves included; the replay refuses one already applied. */
  for (const k of kept) if (!waiting.has(k.signedAt)) waiting.set(k.signedAt, k);
  const { filed } = here.refiled([...waiting.values()].sort((a, b) => a.signedAt - b.signedAt));
  let n = 0;
  for (const f of filed) {
    await doors.changes?.keep(doors.accountId, { signedAt: f.signedAt!, change: f.change as KeptDirectoryChange['change'] });
    /* One the service refuses, or another filing raced, stays kept for a later way in; the anchor is not held back by it. */
    try { await doors.fileDirectory(f); } catch { break; }
    n += 1;
  }
  return n;
}

/** Anchors what the way in just filed again, saying what it filed; a refusal is said, never thrown. */
async function anchoredAtOnce(doors: AnchorDoors, filedAgain: NonNullable<FiledAgainOnTheWayIn['filedAgain']>): Promise<OnTheWayIn> {
  try {
    return { ...(await anchorTheRecordsHere(doors)), filedAgain };
  } catch (e) {
    return { notAnchored: (e as Error)?.message ?? String(e), filedAgain };
  }
}

/* One anchor on the way in at a time per company, on this page: a second read of the company while one runs waits on it. */
const onTheWayIn = new Map<string, Promise<OnTheWayIn>>();

/**
 * **THE ONE-A-DAY ANCHOR, ON THE WAY INTO THE COMPANY.** A seat whose role may
 * anchor, entering the company, anchors every filing not yet anchored when the
 * account's last anchor call landed a day ago or more - or never - and at once
 * whenever a directory version is applied and not yet anchored, since a rise
 * of the account's threshold waits for it (`directoryNotYetAnchored`). When it
 * landed is the time the author of its block set, as the account's history at
 * the indexer the person's own wallet names holds it, never a time a seat
 * wrote; a time ahead of this device's clock holds nothing off. A directory version
 * no entry names yet is witnessed then, as every anchor witnesses it, so a
 * change of seats waits no longer than a filing. Nothing waiting sends nothing.
 * Between raises - each of which anchors as it files - the records are so
 * anchored at least once a day by whichever seat enters first.
 */
export function anchoredOnTheWayIn(doors: AnchorDoors): Promise<OnTheWayIn> {
  const running = onTheWayIn.get(doors.accountId);
  if (running !== undefined) return running;
  const now = doors.now ?? (() => new Date());
  const attempt = (async (): Promise<OnTheWayIn> => {
    try {
      const here = await doors.directory();
      /* A change filed is anchored at once by the device that filed it, so a later change of who holds the account cannot leave it unanchored under a threshold it was not signed at. */
      if (await ownEntryFiledAgain(doors, here)) return await anchoredAtOnce(doors, 'own-entry');
      const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
      const seat = here.dir.seats.find((x) => x.signingKey === mine);
      if (seat === undefined || seat.retired !== null || !mayFile(seat).includes(WITNESSED_AS)) {
        return { waits: 'this-seat-does-not-anchor' };
      }
      /*
       * Filing changes again holds nothing back: the way in goes on to anchor when one is due, with the directory read
       * again, so a service that passes a change over again and again cannot put the company's anchor off with it.
       */
      if (await quorumChangesFiledAgain(doors, here) > 0) return await anchoredAtOnce(doors, 'directory-changes');
      const { landed, records } = await recordsHeldHere({ ...doors, directory: async () => here }, {});
      /* When the account's last anchor call landed: the time its block's author set, as the account's history holds it. */
      const last = landed.length === 0 ? Number.NaN : landed[landed.length - 1]!.at;
      const since = now().getTime() - last;
      if (records.stopped === null && Number.isFinite(since) && since >= 0 && since < ANCHORED_AT_LEAST_EVERY_MS
        && directoryNotYetAnchored({ dir: here.dir, records, refusedAt: here.refusedAt }).length === 0) {
        return { waits: 'anchored-within-a-day' };
      }
      return await anchorTheRecordsHere(doors);
    } catch (e) {
      return { notAnchored: (e as Error)?.message ?? String(e) };
    }
  })().finally(() => { onTheWayIn.delete(doors.accountId); });
  onTheWayIn.set(doors.accountId, attempt);
  return attempt;
}

/* ------------------------------------------------------------------ the full check */

/** What the full check asks of this device. */
export interface FullCheckDoors {
  readonly accountId: string;
  readonly tree: TreeService;
  /** The account's history at the indexer the person's own wallet names. */
  readonly onChain: () => Promise<Pick<AnchorsOnChain, 'landed'>>;
  /** The head after each step, by the account's own functions in the page's worker. */
  readonly headsOf: (steps: readonly HeadStep[]) => Promise<readonly Hex[]>;
  /** Which seat the directory as anchored at a version says holds a key, for a filing or for anchoring. */
  readonly seatOf: TransitionInput['seatOf'];
  readonly checked: CheckedHeadsStore;
  readonly pageSize?: number;
}

/**
 * **THE FULL CHECK: EVERY HEADER OF THE COMPANY'S RECORDS FROM THE FIRST,
 * CHECKED ON THIS DEVICE** against the one before it, up to the head the
 * account's history shows at the indexer the person's own wallet names. It
 * carries on from the last head it checked from the first, a page at a time,
 * keeping each head as it goes and nothing else; it stops `not-given` where the
 * service withholds what the chain holds, and `dishonest` at a header given
 * whole that fails, naming the key that signed it.
 */
export async function fullCheckHere(doors: FullCheckDoors): Promise<{ readonly reached: CheckedHead; readonly stop: TransitionStop | null }> {
  const company = doors.accountId;
  const { landed } = await doors.onChain();
  const kept = await doors.checked.read(company);
  /*
   * A device that started from a later head (`CheckedHeads.from`) keeps what
   * that start gave it while this check runs, its progress kept apart, and
   * holds this check's heads in their place only once it reaches the head on
   * chain whole.
   */
  const own = kept === null || kept.from === undefined;
  const where = own ? company : `${company}${FULL_CHECK_APART}`;
  let progress = own ? kept : await doors.checked.read(where);
  const chainHead = landed.length === 0 ? GENESIS.head : landed[landed.length - 1]!.head.toLowerCase();
  const r = await checkForward({
    company, from: progress?.fromZero ?? GENESIS, landed: new Set(landed.map((l) => l.head.toLowerCase())), chainHead,
    headersAfter: (seq, limit) => doors.tree.headersAfter(company, seq, limit),
    headsOf: doors.headsOf, seatOf: doors.seatOf, pageSize: doors.pageSize,
    keep: async (c) => {
      progress = keptAfter(progress, c, true);
      await doors.checked.write(where, progress);
    },
  });
  if (!own && r.stop === null && r.reached.head === chainHead && progress !== null) await doors.checked.write(company, progress);
  return r;
}

/** Where a full check's progress is kept beside the heads a device that started from a later head keeps. */
const FULL_CHECK_APART = '#checked-from-the-first';

/**
 * **THE NEXT HEADER OF THE COMPANY'S RECORDS, MADE ON THIS DEVICE**, following
 * the head it checked last (`before`), for `entries` in filing order: the
 * service proves each record's leaf against that head's root in one request,
 * and this device checks the proof before it builds on it. A version no newer
 * than its record's leaf, or naming an older version's bytes, is left out.
 * Null when nothing is left to anchor; refused when the service keeps no
 * header making that root, or its leaves do not prove into it.
 */
export async function treeHeaderHere(
  doors: {
    readonly accountId: string; readonly tree: TreeService; readonly signingSecret: Hex; readonly held: BatchHolders; readonly at: Date;
    /** The tag this seat anchors under (`anchorTagOf`): the header names it, and the head the call makes binds it. */
    readonly tag: Hex;
    /** For a recovery: the head the chain holds now and the salt its proposal was raised with; `before` is where it resumes. */
    readonly recovery?: { readonly previous: Hex; readonly salt: Hex };
  },
  before: CheckedHead, entries: readonly ManifestEntry[],
): Promise<{ readonly header: TreeHeader; readonly leftOut: readonly ManifestEntry[]; readonly older: readonly TreeLeaf[] } | null> {
  const records = [...new Map(entries.map((e) => [treeKeyOf(e), { store: e.store, kind: e.kind, id: e.id }])).values()];
  const given = await doors.tree.proofs(doors.accountId, { root: before.root, records, kinds: [] });
  if (given === null) {
    throw new AnchorNotMade('the service keeps no header that makes the root this device checked last. Nothing was sent. Reload the page; '
      + 'if it happens again, the service is withholding the company\'s records');
  }
  const leaves = records.map((r, i) => ({ name: r, leaf: given.records[i] ?? null }));
  const why = provenRefusal(before.root, { records: leaves }, given.proof);
  if (why !== null) throw new AnchorNotMade(`${why}. Nothing was sent. Reload the page; if it happens again, the service is changing the company's records`);
  const older = new Map(given.older.map((l) => [leafHashOf(l), l] as const));
  const made = nextTreeHeader({
    company: doors.accountId, before, entries, current: new Map(leaves.map((l) => [treeKeyOf(l.name), l.leaf])), proof: given.proof,
    priorChain: (h) => older.get(h), held: doors.held, at: doors.at.toISOString(), tag: doors.tag,
    ...(doors.recovery === undefined ? {} : { recovery: doors.recovery }),
  }, doors.signingSecret);
  return made === null ? null : { ...made, older: [...older.values()] };
}
