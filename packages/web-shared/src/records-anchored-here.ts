/**
 * **THE COMPANY'S RECORDS ANCHORED FROM THIS DEVICE: EVERY FILING NOT YET
 * ANCHORED, ONE HEADER OF THE RECORD TREE MOVING THE HEAD THE CHAIN HOLDS IN
 * ONE CALL.**
 *
 * Any seat that may raise or approve may anchor. This device reads every
 * anchor call that landed on the account from the account's own history, at
 * the indexer the person's own wallet names - never from the company's service
 * - and checks every header of the company's record tree from the last head
 * it checked to the head the last of them left (`recordsHeldHere`, in
 * `records-held-here.ts`, through `checkForward`), proving the leaves a read asks against that head's root. It
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
 *     seat's device before the company's first anchor, by their version even
 *     below later versions of them, and no first anchor is made without them,
 *     its batch taking each record's versions in order: the founding seat is
 *     read from that first anchor.
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
import { handedOver, type HandOver } from './hand-over.js';
import type { SealedProposal } from '../../../src/core/types.js';
import { proposalFilingRefusal } from '../../../src/core/proposal-filing.js';
import { FOUNDING_KEY_EPOCH, foundingStateRefusal, stateRecordId } from '../../../src/core/founding-state.js';
import { foundingRosterRefusal, ROSTER_ID } from '../../../src/core/roster-record.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import {
  companyRecordEntry, directoryEntry, EMPTY_HEAD, ENTRIES_AT_ONCE, entryIdOf, proposalEntry, recordKeyOf, signManifestEntry,
  supersededSaid, type BatchHolders, type ManifestEntry,
} from '../../../src/midnight/record-manifest.js';
import type { DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import type { DirectoryBelieved, LeavingBoundaries } from './vault-page-doors.js';
import type { AnchorsOnChain, VouchedRunOnTheWire } from './governed-call-builder.js';
import { enteredOnThisPage, letGoOfEntered, type ManifestService, type TreeService } from './record-entered-here.js';
import { inParts } from './company-view-batch.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import type { SignerMaterial } from './private-state.js';
import { keptWith, type CheckedHeadsStore, type DirectoryChangesKeptStore, type HeadersKeptStore } from './tree-kept-here.js';
import type { VouchedRunHere } from './run-rebuilt-here.js';
import {
  checkForward, GENESIS, headStepOf, leafHashOf, nextTreeHeader, provenRefusal, transitionStopSaid, treeBatchOf, treeKeyOf, type CheckedHead,
  type HeadStep, type TransitionInput, type TransitionStop, type TreeHeader, type TreeLeaf,
} from '../../../src/midnight/record-tree.js';
import { DIRECTORY, newestAnchored } from '../../../src/midnight/records-held.js';
import { chainAfterARace, chainNowOf, freshViewAfter, heldHere, throughTheView } from './anchored-through-the-view.js';
import type { ViewHeld } from './company-view.js';
import { AnchorNotMade, headOn, keptAfter, type ReadHere } from './records-as-anchored.js';

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
  /** Where the proven anchor goes: through the service (the default), or straight to the chain from the person's wallet. */
  readonly handOver?: HandOver;
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
  /**
   * **THE STEP'S ONE READ OF THE COMPANY.** Every door above that reads or writes the company - the manifest,
   * the tree, the directory and its filings, the account's anchors, the stores, the proposals and founding records,
   * the send through the service - is the current view's (`throughTheView`), every write probed first; an attempt after
   * a race reads from a fresh view.
   */
  readonly view: ViewHeld<unknown>;
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

/** What anchoring did: how many entries its header holds, and the head the chain holds after it. */
export interface Anchored {
  readonly anchored: number;
  readonly head: Hex;
  /** This device's own filings superseded by a later version before the anchor held them: said, never entered again. */
  readonly superseded?: readonly string[];
}

export { AnchorNotMade, headOn, keptAfter, seatAsAnchoredHere, type ReadHere } from './records-as-anchored.js';

/** How many times this device reads the head again after another device anchored first, before it says so. */
const ANCHOR_ATTEMPTS = 3;

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
 * covers it as the founding signer's. Offered each time, by version, whatever
 * later versions are entered: the first anchor must hold them, and one entered
 * already is answered as entered. A seat that did not found the company enters
 * nothing here.
 */
async function foundingRecordsEntered(doors: AnchorDoors): Promise<void> {
  const company = doors.accountId;
  const secret = doors.material.signingSecret as Hex;
  const mine = signingPublicKeyOf(secret);
  const founding = await doors.service.foundingRecords(company);
  const owed = [
    founding.state !== null && foundingStateRefusal(founding.state, company, mine) === null ? founding.state : null,
    founding.roster !== null && foundingRosterRefusal(founding.roster, company, mine) === null ? founding.roster : null,
  ].filter((r): r is SealedCompanyRecord => r !== null)
    .map((r) => signManifestEntry(company, companyRecordEntry(r), secret));
  if (owed.length > 0) await doors.manifest.enter(company, owed);
}

/**
 * **WHY THIS DEVICE DOES NOT MAKE THE COMPANY'S FIRST ANCHOR FROM THESE
 * RECORDS**: the first anchor is the founding seat's, so it must hold the
 * company's first state and first roster, each entered by the seat anchoring
 * it. Asked of the records waiting, and again of the batch made from them.
 * Null when they hold both, or when something is anchored already.
 */
const firstAnchorRefusal = (
  doors: AnchorDoors, head: Hex,
  records: ReadonlyArray<{ readonly store: string; readonly kind: string; readonly id: string; readonly version: number; readonly filer: string }>,
): string | null => {
  if (head !== EMPTY_HEAD) return null;
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  const held = (kind: 'state' | 'roster', id: string) => records.some((e) => e.store === 'company' && e.kind === kind
    && e.id === id && e.version === 1 && e.filer.toLowerCase() === mine);
  if (held('state', stateRecordId(FOUNDING_KEY_EPOCH)) && held('roster', ROSTER_ID)) return null;
  return 'the company\'s first anchor holds the records it was founded with - its first state and its first roster - entered by '
    + 'its founding signer\'s device, and this device did not enter them. Nothing was sent. The company\'s founding signer\'s '
    + 'next action in their wallet anchors them';
};

/**
 * The entries a batch is cut from, with the company's directory and its first
 * state and first roster entered by this seat put first while nothing is
 * anchored: the first anchor must hold the founding records, however many
 * entries were entered before them, and its header names the directory version
 * the seat anchoring it is read from.
 */
const foundingFirstWhileNothingIsAnchored = (doors: AnchorDoors, head: Hex, entries: readonly ManifestEntry[]): readonly ManifestEntry[] => {
  if (head !== EMPTY_HEAD) return entries;
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  const founding = (e: ManifestEntry) => e.store === 'company' && e.version === 1 && e.filedBy.publicKey.toLowerCase() === mine
    && ((e.kind === 'state' && e.id === stateRecordId(FOUNDING_KEY_EPOCH)) || (e.kind === 'roster' && e.id === ROSTER_ID));
  const first = (e: ManifestEntry) => e.store === 'directory' || founding(e);
  return [...entries.filter(first), ...entries.filter((e) => !first(e))];
};

/**
 * Puts each record's versions in ascending order, in the places that record's entries already hold, so a batch never
 * takes a later version of a record before an earlier one, even when the earlier one (a founding record entered late)
 * was entered after it.
 */
const eachRecordInVersionOrder = (entries: readonly ManifestEntry[]): ManifestEntry[] => {
  const byRecord = new Map<string, ManifestEntry[]>();
  for (const e of entries) byRecord.set(recordKeyOf(e), [...(byRecord.get(recordKeyOf(e)) ?? []), e]);
  for (const versions of byRecord.values()) versions.sort((a, b) => a.version - b.version);
  const taken = new Map<string, number>();
  return entries.map((e) => {
    const key = recordKeyOf(e);
    const i = taken.get(key) ?? 0;
    taken.set(key, i + 1);
    return byRecord.get(key)![i]!;
  });
};

/**
 * **EVERY ENTRY THIS PAGE SIGNED THAT THE MANIFEST IT IS SERVED DOES NOT NAME,
 * ENTERED AGAIN.** One behind a newer version of the same record was
 * superseded: it is let go of and said, never entered again. Whether the
 * service then gives the rest is asked of the very read the header is made
 * from (`ownFilingsLeftOut`), never of another. The newest versions are asked
 * in parts of `READ_AT_ONCE` records, one request for each. The superseded, said.
 */
async function ownFilingsEntered(doors: AnchorDoors): Promise<string[]> {
  const company = doors.accountId;
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  const own = enteredOnThisPage(company).filter((e) => e.filedBy.publicKey.toLowerCase() === mine);
  if (own.length === 0) return [];
  const names = [...new Map(own.map((e) => [recordKeyOf(e), { store: e.store, kind: e.kind, id: e.id }])).values()];
  const versions = await inParts(names, (part) => doors.manifest.newest(company, part));
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

/** What one attempt came to: what it anchored, nothing to anchor, or raced - another device anchored first or the holders moved. */
type Attempted = Anchored | 'raced';

/**
 * **EVERY FILING NOT YET ANCHORED, ANCHORED FROM THIS DEVICE**, at most a
 * header's worth at a time. Nothing to anchor is an answer, not a refusal.
 * Refused, with nothing sent, when this device cannot check a header up to the
 * head the chain holds, and when other devices kept moving the head on first.
 */
export async function anchorTheRecordsHere(doors: AnchorDoors): Promise<Anchored> {
  for (let attempt = 0; attempt < ANCHOR_ATTEMPTS; attempt += 1) {
    const done = await anchorAttempt(throughTheView(doors), attempt + 1 < ANCHOR_ATTEMPTS);
    if (done !== 'raced') return done;
  }
  throw new AnchorNotMade(`other devices anchored the company's records first, or who holds the company's account changed, ${ANCHOR_ATTEMPTS} times running. `
    + 'What was anchored is believed; reload the page to anchor what is left');
}

/** One attempt: what this device owes entered, the records read, and the batch made, kept, filed and sent. `mayRetry` while attempts are left. */
async function anchorAttempt(doors: AnchorDoors, mayRetry: boolean): Promise<Attempted> {
  const company = doors.accountId;
  await directoryWitnessed(doors);
  if ((await doors.onChain()).landed.length === 0) await foundingRecordsEntered(doors);
  await ownProposalsEntered(doors);
  const superseded = await ownFilingsEntered(doors);
  const told = superseded.length === 0 ? {} : { superseded };
  const own = enteredOnThisPage(company).map((e) => ({ store: e.store, kind: e.kind, id: e.id }));
  const read = await heldHere(doors, { everyPending: true, records: own });
  const { records } = read;
  /* What this page entered is let go of once the anchor holds it, and not before. */
  letGoOfEntered(company, (e) => newestAnchored(records, e) >= e.version);
  if (records.stopped !== null) throw new AnchorNotMade(transitionStopSaid(records.stopped));
  const leftOut = ownFilingsLeftOut(doors, read);
  if (leftOut !== null) throw new AnchorNotMade(leftOut);
  if (records.notYetAnchored.length === 0) return { anchored: 0, head: records.head, ...told };
  const first = firstAnchorRefusal(doors, records.head, records.notYetAnchored.map((e) => ({ ...e, filer: e.filedBy.publicKey })));
  if (first !== null) throw new AnchorNotMade(first);
  /* Who holds the account as this device judges the batch: what the history shows now, which must be what the wallet read. */
  const judged = read.now.now;
  const wallet = new Set(read.here.holders.seats.map((x) => x.toLowerCase()));
  if (judged.approvals !== read.here.holders.approvals || read.now.seatsNow.length !== wallet.size
    || read.now.seatsNow.some((x) => !wallet.has(x.toLowerCase()))) {
    if (mayRetry) { freshViewAfter(doors, 'who holds the company was read otherwise by the wallet and the account\'s history'); return 'raced'; }
    throw new AnchorNotMade('who holds the company\'s account, as your wallet read it, is not what the account\'s history at its '
      + 'indexer shows yet. Nothing was sent. Wait for your wallet to catch up, then reload the page and anchor again');
  }
  const made = await batchMadeHere(doors, read, judged);
  if (made === null) return { anchored: 0, head: records.head, ...told };
  return anchorSent(doors, records.head, made.header, made.batch, judged, told);
}

/** **THE BATCH THIS ATTEMPT ANCHORS**: its header made from the read, kept on this device and filed before anything is sent. */
async function batchMadeHere(
  doors: AnchorDoors, read: ReadHere, judged: BatchHolders,
): Promise<{ readonly header: TreeHeader; readonly batch: ReturnType<typeof treeBatchOf> } | null> {
  const company = doors.accountId;
  const secret = doors.material.signingSecret as Hex;
  const { records } = read;
  /* The tag this seat anchors under, as the account's call will work it out: the header names it, and the head binds it. */
  const tag = await doors.builder.anchorTag({ account: String(read.here.holders.account), material: doors.material }) as Hex;
  const made = await treeHeaderHere({
    accountId: company, tree: doors.tree, signingSecret: secret, held: judged, tag, at: (doors.now ?? (() => new Date()))(),
  }, records.reached, foundingFirstWhileNothingIsAnchored(doors, records.head, eachRecordInVersionOrder(records.notYetAnchored)).slice(0, ENTRIES_AT_ONCE));
  if (made === null) return null;
  const { header } = made;
  const firstBatch = firstAnchorRefusal(doors, records.head, header.changes.map((c) => ({ ...c.leaf, filer: c.leaf.filedBy })));
  if (firstBatch !== null) throw new AnchorNotMade(firstBatch);
  const batch = treeBatchOf(header);
  /* Kept on this device first, with what checking it needs, so a header the service loses is filed again from here. */
  const olderGiven = new Map(made.older.map((l) => [leafHashOf(l), l] as const));
  await doors.headers?.signed(company, keptWith(header, (id) => records.notYetAnchored.find((e) => entryIdOf(e) === id), (h) => olderGiven.get(h)));
  /* Kept before the call is sent, so a header the chain takes is never one no device was given. */
  await doors.tree.fileHeader(company, header);
  return { header, batch };
}

/** **THE ANCHOR CALL PROVEN AND SENT** from the head read, and where the head went: anchored, or raced when the head or the holders moved. */
async function anchorSent(
  doors: AnchorDoors, head: Hex, header: TreeHeader, batch: ReturnType<typeof treeBatchOf>, judged: BatchHolders, told: Pick<Anchored, 'superseded'>,
): Promise<Attempted> {
  const company = doors.accountId;
  const held = { approvals: header.held.approvals, signerRoot: header.held.signerRoot };
  try {
    const chain = await doors.service.callState(company);
    const { tx } = await doors.builder.anchor({ account: chain.account, material: doors.material, chain, previous: head, batch, held });
    const after = await doors.builder.anchorHeads({ after: [headStepOf(header)] });
    const ours = after.after[0]! as Hex;
    /* The send's answer, or where the head went while it gave none: a call the head moved past is not waited on. */
    const settled = { done: false };
    const went = await Promise.race([
      handedOver(doors.handOver, {
        tx, call: { kind: 'account-call', contract: chain.account, circuit: 'anchor' },
        viaService: () => doors.service.sendProven(company, tx),
        after: async () => undefined,
      }).then(() => 'answered' as const),
      whereTheSendWent({ ...doors, onChain: chainNowOf(doors) }, head, ours, settled),
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
    const again = await chainAfterARace(doors, 'the anchor was not sent as it was made, so it is judged again from a fresh read');
    const moved = headOn(again.landed) !== head || again.now.approvals !== judged.approvals
      || again.now.signerRoot !== judged.signerRoot;
    if (!moved) throw new AnchorNotMade(`the anchor was not sent (${(e as Error)?.message ?? String(e)}). Reload the page and anchor again`, { cause: e });
    return 'raced';
  }
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
