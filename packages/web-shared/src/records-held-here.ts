/**
 * **THE COMPANY'S RECORDS AS THE ANCHOR ON CHAIN HOLDS THEM, READ ON THIS
 * DEVICE.** It reads the account's history at the indexer the person's own
 * wallet names, then checks every header of the company's record tree from the
 * last head this device checked to the head the chain holds, and proves the
 * leaves a read asks against that head's root. What a read gives back is what
 * the anchor holds and nothing the service only says.
 */
import type { Hex } from '../../../src/core/crypto.js';
import {
  boundaryKeyOfEntry, EMPTY_HEAD, entryIdOf, filedKindOfEntry, manifestEntryRefusal, recordKeyOf,
  type DirectoryAsAnchored, type ManifestEntry, type ManifestEntryBody,
} from '../../../src/midnight/record-manifest.js';
import { filingRefusalOf } from '../../../src/midnight/seat-directory.js';
import {
  pastTheRaisedBoundary, type DirectoryBelieved, type HeldAsAnchored, type LeavingBoundaries, type RecordsHeldHere,
} from './vault-page-doors.js';
import type { AnchorsOnChain } from './governed-call-builder.js';
import type { CheckedHeads, StartedFrom } from './tree-kept-here.js';
import {
  checkedAfter, GENESIS, headStepOf, HEADERS_AT_ONCE, PROVEN_AT_ONCE, provenRefusal, transitionRefusal,
  treeHeaderReadable, type CheckedHead, type KindAsked, type RecordName, type TransitionInput, type TreeHeader,
  type TreeLeaf,
} from '../../../src/midnight/record-tree.js';
import {
  DIRECTORY, directoryVersionsOf, kindKeyOf, recordsProvenFor, versionsOf, type DirectoryVersionHeld, type HeldVersion, type RecordsAsked,
} from '../../../src/midnight/records-held.js';
import { checkedForwardHere, seatOfAsAnchored } from './held-checked-forward.js';
import {
  directoryAsAnchoredHere, headsHere, heldKey, NOT_PROVEN, olderOf, ROOT_NOT_KEPT, seatsHere,
  type DirectoryAsAnchoredHere, type HeadsHere, type HeldDoors, type SeatsHere,
} from './held-heads-here.js';
import { AnchorNotMade, seatAsAnchoredHere, headOn, type ReadHere } from './records-as-anchored.js';

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

/** **WHERE A DEVICE NEW TO THE COMPANY STARTS CHECKING**, and, for a vouched head, the record the run's approvers vouched with: it must prove into the root reached. */
export interface StartHere {
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

/**
 * Every record and kind asked for, proven against one anchored root in parts the service answers at once, and each
 * record's versions as that proof holds them. A part the service does not keep, or does not prove, refuses the read.
 */
async function provenAt(doors: HeldDoors, root: Hex, names: readonly RecordName[], kinds: readonly KindAsked[]) {
  const company = doors.accountId;
  const leaves: { readonly name: RecordName; readonly leaf: TreeLeaf | null }[] = [];
  let kindLeaves: { readonly kind: KindAsked; readonly leaves: TreeLeaf[] }[] = [];
  const olderGiven: unknown[] = [];
  for (let i = 0; i === 0 || i < names.length; i += PROVEN_AT_ONCE) {
    const part = names.slice(i, i + PROVEN_AT_ONCE);
    const partKinds = i === 0 ? kinds : [];
    const given = await doors.tree.proofs(company, { root: root, records: part, kinds: partKinds });
    if (given === null) throw new AnchorNotMade(ROOT_NOT_KEPT);
    const partLeaves = part.map((name, k) => ({ name, leaf: given.records[k] ?? null }));
    const partKindLeaves = partKinds.map((kind, k) => ({ kind, leaves: [...(given.kinds[k] ?? [])] }));
    if (provenRefusal(root, { records: partLeaves, kinds: partKindLeaves }, given.proof) !== null) throw new AnchorNotMade(NOT_PROVEN);
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
  return { leaves, older, history };
}

/** **THE READ ITSELF**, from what this device kept (`kept`), or from a start it chose (`start`), or from the company's first header. */
async function heldFrom(
  doors: HeldDoors, asked: RecordsAsked, now: AnchorsOnChain, here: DirectoryBelieved, keptBefore: CheckedHeads | null, chosen: StartHere | null,
): Promise<ReadHere> {
  const company = doors.accountId;
  const { landed } = now;
  const head = headOn(landed);
  let kept = keptBefore;
  const from: CheckedHead = kept?.latest ?? GENESIS;
  const heads = headsHere(doors, landed, kept);
  const { headsBySeq, headsBefore } = heads;
  /* The chain as the wallet's indexer shows it, behind a head this device already checked: nobody's doing yet, and nothing is read. */
  if (from.seq >= 0 && head !== from.head && (head === EMPTY_HEAD || [...headsBySeq].some(([seq, h]) => h === head && seq < from.seq))) {
    throw new AnchorNotMade(INDEXER_BEHIND);
  }
  const seats = seatsHere(doors);
  const anchored = directoryAsAnchoredHere(doors, seats, heads);
  const { dirAt, directoryOfLeaf } = anchored;
  if (from.head !== head && from.dirVersion > 0) {
    await directoryOfLeaf(from.root);
    await headsBefore([...dirAt.values()].map((d) => d.batch));
  }
  const { seatOf, servedShort: shortOf } = seatOfAsAnchored(here, anchored);
  const checked = await checkedForwardHere({ doors, landed, head, here, kept, chosen, heads, seats, anchored, seatOf }, from);
  const { forward, reached, stop, first } = checked;
  kept = checked.kept;
  const { pending, wanted, kindKeys, history, directory, held, leaving, notYetAnchored, seenWaiting } = await heldAtTheRoot(
    doors, asked, chosen, reached, stop, here, anchored, seats, heads,
  );
  const founding = await foundingAsked(doors, asked, reached, first, seatOf, heads, seats, landed);
  const servedShort = shortOf();
  /* A start this device chose is kept only now, the read from it holding what it must. */
  /* The heads before the start this read found are kept with the rest, so the next read does not read their headers again. */
  const before = heads.beforeToKeep();
  if (before !== null && kept !== null) kept = { ...kept, before };
  if ((chosen !== null || before !== null) && kept !== null) await doors.checked?.write(company, kept);
  const records: RecordsHeldHere = {
    ...(kept?.from === undefined ? {} : { checkedFrom: kept.from }),
    ...(forward.recovered === undefined ? {} : { recovered: forward.recovered }),
    head, reached, stopped: stop,
    asked: { records: wanted, kinds: kindKeys },
    history, notYetAnchored, seenWaiting, directory, held, deployed: now.deployed ?? null, ...founding,
    ...(leaving === undefined ? {} : { leaving }),
    seqOfHead: heads.seqOfHead,
    newestLandedBy: heads.newestLandedBy,
    ...(stop !== null && servedShort !== undefined ? { directoryServed: servedShort } : {}),
  };
  return { landed, now, here, records, pending: new Set(pending.map(entryIdOf)) };
}

/** **WHAT THE ROOT REACHED HOLDS** of what the read asked: the entries not yet anchored at it, and every leaf the read needs, proven. */
async function heldAtTheRoot(
  doors: HeldDoors, asked: RecordsAsked, chosen: StartHere | null, reached: CheckedHead, stop: RecordsHeldHere['stopped'],
  here: DirectoryBelieved, anchored: DirectoryAsAnchoredHere, seats: SeatsHere, heads: HeadsHere,
) {
  const company = doors.accountId;
  const { dirAt, accountHeldOf } = anchored;
  const { readSeats } = seats;
  const { headsBefore } = heads;
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
  const { leaves, older, history } = await provenAt(doors, reached.root, names, kinds);
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
  return { pending, wanted, kindKeys, history, directory, held, leaving, notYetAnchored, seenWaiting: newestWaitingOf(pending, ofAsked) };
}

/** The newest version of each asked record the service gave as waiting, whether this read believed that entry or left it out. */
export const newestWaitingOf = (pending: readonly ManifestEntry[], ofAsked: (e: ManifestEntryBody) => boolean): ReadonlyMap<string, number> => {
  const newest = new Map<string, number>();
  for (const e of pending) if (ofAsked(e)) newest.set(recordKeyOf(e), Math.max(e.version, newest.get(recordKeyOf(e)) ?? 0));
  return newest;
};

/** Who founded the company, when the read asked it. */
async function foundingAsked(
  doors: HeldDoors, asked: RecordsAsked, reached: CheckedHead, first: TreeHeader | undefined, seatOf: TransitionInput['seatOf'],
  heads: HeadsHere, seats: SeatsHere, landed: ReadHere['landed'],
) {
  const { headsBySeq } = heads;
  const { readSeats, seatsByHeld } = seats;
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
  return founding;
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
