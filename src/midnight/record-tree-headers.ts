/** A batch's header, the check of a header against the one before it, and the next header a seat signs. */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonical, fromHex, sign, signingPublicKeyOf, toHex, utf8, verify, type Hex } from '../core/crypto.js';
import { batchHoldersShapeRefusal, EMPTY_HEAD, ENTRIES_AT_ONCE, entryIdOf, manifestEntryRefusal, recordKeyOf, type BatchHolders, type ManifestEntry, type ManifestEntryBody } from './record-manifest.js';
import { EMPTY_ROOT, HEADER_DOMAIN, HEX128, HEX64, type TreeLeaf, type TreeProof, ZERO, heldOf, isWhole, leafHashOf, rootFrom, sameHeld, treeKeyOf, treeLeafRefusal } from './record-tree-leaves.js';

/* ------------------------------------------------------------------ the header */

/** One change a batch makes: the leaf it replaces (null for a record's first), and the new leaf. */
export interface TreeChange { readonly prior: TreeLeaf | null; readonly leaf: TreeLeaf }

/**
 * **WHERE A RECOVERY RESUMES**: the header its approvers' own devices checked,
 * by its seq, the head it left and its root. The batches after it are given up.
 */
export interface ResumesFrom { readonly seq: number; readonly head: Hex; readonly root: Hex }

/** **A BATCH'S HEADER**, as the anchoring seat signs it. */
export interface TreeHeader {
  readonly company: string;
  /**
   * `anchor` moves the head on from the header before it; `recovery`, approved
   * by a quorum, moves it on from `resumesFrom` past batches nobody can check,
   * which it gives up.
   */
  readonly kind: 'anchor' | 'recovery';
  /** The tag of the seat that anchored it, as the account writes it (`anchorTagOf`): the head binds it. */
  readonly tag: Hex;
  /** A recovery's: the header it resumes from, which its approval binds by its head. */
  readonly resumesFrom?: ResumesFrom;
  /** A recovery's: the salt its proposal was raised with, so its identity on chain is made again from the header. */
  readonly salt?: Hex;
  /** 0 for the company's first batch, one more for each after it. */
  readonly seq: number;
  /** The head this batch follows. */
  readonly previous: Hex;
  readonly previousRoot: Hex;
  readonly root: Hex;
  /** The newest directory version anchored through this batch; 0 when none is. */
  readonly dirVersion: number;
  /** In filing order; two versions of one record are two changes, the second's prior the first's leaf. */
  readonly changes: readonly TreeChange[];
  /** The nodes beside the changed positions, which take `previousRoot` to `root`. */
  readonly proof: TreeProof;
  /** Who held the account as the anchoring seat judged the batch; the account's call checks it. */
  readonly held: BatchHolders;
  /** When the anchoring device wrote it, ISO 8601. */
  readonly at: string;
  readonly anchoredBy: { readonly publicKey: Hex; readonly signature: Hex };
}

type Unsigned = Omit<TreeHeader, 'anchoredBy'> & { readonly anchoredBy: { readonly publicKey: Hex } };

/** The exact text the anchoring seat signs, and what the head's batch digest is taken over. */
export const treeHeaderMessage = (h: Unsigned): string => canonical({
  domain: HEADER_DOMAIN, company: h.company, kind: h.kind, tag: h.tag, seq: h.seq, previous: h.previous, previousRoot: h.previousRoot,
  ...(h.kind === 'recovery' ? {
    resumesFrom: h.resumesFrom === undefined || h.resumesFrom === null ? null : { seq: h.resumesFrom.seq, head: h.resumesFrom.head, root: h.resumesFrom.root },
    salt: h.salt ?? null,
  } : {}),
  root: h.root, dirVersion: h.dirVersion, changes: h.changes.map((c) => ({ prior: c.prior === null ? null : leafHashOf(c.prior), leaf: leafHashOf(c.leaf) })),
  proof: h.proof.siblings.map((s) => ({ depth: s.depth, path: s.path, hash: s.hash })), held: heldOf(h.held), at: h.at,
  anchoredBy: h.anchoredBy.publicKey,
});

/** A header, signed by the seat anchoring it. The signing secret stays on the device. */
export const signTreeHeader = (h: Omit<TreeHeader, 'anchoredBy'>, signingSecret: Hex): TreeHeader => {
  const publicKey = signingPublicKeyOf(signingSecret);
  const unsigned = { ...h, anchoredBy: { publicKey } };
  return { ...h, anchoredBy: { publicKey, signature: sign(treeHeaderMessage(unsigned), signingSecret) } };
};

/** **THE BATCH THE ACCOUNT FOLDS INTO ITS HEAD**: the SHA-256 of what the anchoring seat signed. */
export const treeBatchOf = (h: TreeHeader): Hex => toHex(sha256(utf8(treeHeaderMessage(h))));

/** Whether the anchoring seat's signature covers exactly this header. */
export const treeHeaderSigned = (h: TreeHeader): boolean => {
  try { return verify(treeHeaderMessage(h), h.anchoredBy.signature, h.anchoredBy.publicKey); } catch { return false; }
};

/**
 * The stores whose every version is kept and read back in order (a record's
 * versions, one to the newest). A version anchored anywhere need only rise
 * above its leaf; in these stores a version the record's prior chain passes
 * over - between two of its leaves - is a version never entered: its entry
 * never reached a header, a later version was anchored past it, and it is
 * shown as such and never believed (`versionsOf`). Anchoring past it is what
 * keeps one version whose entry is lost from holding every later version of
 * its record unanchored. A run is kept whole and changed in place, so only its
 * newest bytes are kept and its passed-over versions are nothing to show; a
 * proposal has one version.
 */
export const EVERY_VERSION_KEPT: ReadonlySet<string> = new Set(['company', 'vault', 'directory']);

/** Why `value` is not where a recovery resumes, or null. */
const resumesFromRefusal = (value: unknown): string | null => {
  const r = value as Partial<ResumesFrom> | null | undefined;
  if (r === null || r === undefined || typeof r !== 'object' || !isWhole(r.seq, 0)) return 'it does not name the batch it resumes from';
  return [r.head, r.root].every((x) => typeof x === 'string' && HEX64.test(x)) ? null : 'it does not name the head and root it resumes from';
};

/**
 * Whether the head's digest can be taken over `value` and its head worked out:
 * what a header must be for the chain to be known to hold it. One the chain
 * holds and that is otherwise out of shape is the seat's (`transitionRefusal`).
 */
export const treeHeaderReadable = (value: unknown): value is TreeHeader => {
  const h = value as Partial<TreeHeader> | null;
  if (h === null || typeof h !== 'object' || !isWhole(h.seq, 0) || typeof h.previous !== 'string' || !HEX64.test(h.previous)) return false;
  if (typeof h.tag !== 'string' || !HEX64.test(h.tag)) return false;
  if (h.kind === 'recovery' && resumesFromRefusal(h.resumesFrom) !== null) return false;
  if (batchHoldersShapeRefusal(h.held) !== null) return false;
  try { treeBatchOf(h as TreeHeader); return true; } catch { return false; }
};

/**
 * Why `value` is not a header of `company` that can be read at all, or null.
 * A header that cannot be read cannot be folded, so it is never one the chain
 * is known to hold.
 */
export const treeHeaderShapeRefusal = (company: string, value: unknown): string | null => {
  const h = value as Partial<TreeHeader> | null;
  if (h === null || typeof h !== 'object') return 'it is not a header';
  if (h.company !== company) return 'it is a header of another company';
  if (h.kind !== 'anchor' && h.kind !== 'recovery') return 'it is not an anchor\'s or a recovery\'s header';
  if (typeof h.tag !== 'string' || !HEX64.test(h.tag)) return 'it does not name the tag of the seat that anchored it';
  if (h.kind === 'recovery') {
    const r = resumesFromRefusal(h.resumesFrom);
    if (r !== null) return r;
    if (typeof h.salt !== 'string' || !HEX64.test(h.salt)) return 'it does not name the salt its recovery was raised with';
    if (h.resumesFrom!.seq + 1 !== h.seq) return 'it is not the batch after the one it resumes from';
  } else if (h.resumesFrom !== undefined || h.salt !== undefined) return 'an anchor\'s header names no batch it resumes from';
  if (!isWhole(h.seq, 0) || !isWhole(h.dirVersion, 0)) return 'it does not say which batch it is';
  if (![h.previous, h.previousRoot, h.root].every((x) => typeof x === 'string' && HEX64.test(x))) return 'it does not name its head and roots';
  if (!Array.isArray(h.changes) || h.changes.some((c) => c === null || typeof c !== 'object'
    || (c.prior !== null && treeLeafRefusal(c.prior) !== null) || treeLeafRefusal(c.leaf) !== null)) return 'its changes cannot be read';
  if (!Array.isArray(h.proof?.siblings)) return 'it carries no proof';
  if (batchHoldersShapeRefusal(h.held) !== null) return 'it does not name who held the account';
  if (typeof h.at !== 'string' || Number.isNaN(Date.parse(h.at))) return 'it does not say when it was written';
  const by = h.anchoredBy as Partial<TreeHeader['anchoredBy']> | undefined;
  if (typeof by?.publicKey !== 'string' || !HEX64.test(by.publicKey) || typeof by.signature !== 'string' || !HEX128.test(by.signature)) {
    return 'it is not signed';
  }
  return null;
};

/* ------------------------------------------------------------------ the check */

/**
 * **WHAT A DEVICE KEEPS OF A HEADER IT CHECKED**: its seq, the head it left, its
 * root and the directory version through it - all the next header is checked
 * against. Never the header's changes.
 */
export interface CheckedHead { readonly seq: number; readonly head: Hex; readonly root: Hex; readonly dirVersion: number }

/** Before the company's first batch: the empty head and the empty tree. */
export const GENESIS: CheckedHead = Object.freeze({ seq: -1, head: EMPTY_HEAD, root: EMPTY_ROOT, dirVersion: 0 });

const VOUCHED_DOMAIN = 'confidential-accounts/record-tree/vouched-fresh/v1';

/**
 * **WHAT A PAYROLL RUN'S RAISER SEALS BESIDE ITS SALT**: the head of the
 * company's records its device checked last, and a random value. The fresh
 * half of the run's salt is made from the two (`vouchedFreshOf`), so the
 * identity the run's approvers approve on chain binds that head: a run paid
 * with the account's threshold of approvals vouches for it.
 */
export interface Vouched { readonly head: Hex; readonly r: Hex }

/** Why a sealed pair is not one a run can be made from, or null: each half thirty-two bytes, and the head one an anchor left. */
export const vouchedRefusal = (value: unknown): string | null => {
  const v = value as Partial<Vouched> | null | undefined;
  if (v === null || v === undefined || typeof v !== 'object' || typeof v.head !== 'string' || typeof v.r !== 'string') {
    return 'it names no head of the company\'s records and no random value';
  }
  if (!HEX64.test(v.head.toLowerCase()) || !HEX64.test(v.r.toLowerCase())) return 'its head or its random value is not thirty-two bytes';
  if (v.head.toLowerCase() === EMPTY_HEAD) return 'it names the empty head, which no anchor left';
  return null;
};

/**
 * **THE FRESH HALF OF A PAYROLL RUN'S SALT**, made wherever it is needed from
 * what its raiser sealed: SHA-256 over its own domain, the head and the value.
 * The salt is the account's `retrySaltOf(leg, fresh)`, as before.
 */
export const vouchedFreshOf = (head: Hex, r: Hex): Hex => toHex(sha256(new Uint8Array([
  ...utf8(VOUCHED_DOMAIN), ...fromHex(head.toLowerCase() as Hex), ...fromHex(r.toLowerCase() as Hex),
])));

/** What a header checked leaves, once the head it makes is known. */
export const checkedAfter = (h: TreeHeader, head: Hex): CheckedHead =>
  ({ seq: h.seq, head: head.toLowerCase(), root: h.root, dirVersion: h.dirVersion });

/** **WHY A CHECK STOPPED, AND NOTHING PAST IT IS BELIEVED.** `seq` is the batch it stopped at. */
export type TransitionStop =
  /**
   * `movedBy`, where known: the seat whose tag the account wrote beside the
   * head the device could not reach - the last seat to anchor in that head's
   * block, which held `anchorsInBlock` anchors where more than one, since the
   * account's history keeps one state a block. `recovery`: a recovery the
   * quorum approved moved the anchor on after the head reached, so the batches
   * this device cannot follow were given up by the quorum, not withheld by the
   * service.
   */
  | {
    readonly stop: 'not-given'; readonly seq: number; readonly what: string;
    readonly movedBy?: string; readonly anchorsInBlock?: number; readonly recovery?: true;
  }
  /** `anchoredBy` is the key whose signature over the header verifies, or null when none does. */
  | { readonly stop: 'dishonest'; readonly seq: number; readonly anchoredBy: Hex | null; readonly why: string };

export interface TransitionInput {
  readonly company: string;
  /** The header before, as this device checked it. */
  readonly before: CheckedHead;
  /** The header that follows it, as the service gave it, already folded to a head the chain holds; undefined when not given. */
  readonly header: unknown;
  /** An entry by its id, as the service gave it; undefined when it did not. */
  readonly entry: (id: Hex) => unknown;
  /** An older leaf by its hash, as the service gave it; undefined when it did not. */
  readonly priorChain: (hash: Hex) => TreeLeaf | undefined;
  /**
   * The seat the company's directory at `dirVersion` - as anchored - says holds
   * `publicKey`: for an entry, holds it and may file that record at that
   * version; for the header, may anchor. Null when none does; undefined when
   * the directory at that version was not given whole. `header` is the header
   * being checked: a directory version it anchors is counted against the
   * holders it names.
   */
  readonly seatOf: (publicKey: Hex, entry: ManifestEntryBody | undefined, dirVersion: number, header: TreeHeader) => string | null | undefined;
  /**
   * The seat whose tag `tag` is, from the openings of their leaves the
   * company's seats filed for its members; undefined where none this device
   * believes is that tag's. Absent, no header is judged by its tag.
   */
  readonly tagSeat?: (tag: Hex) => string | undefined;
}

/** Why a batch's proof does not take the leaves it replaces to the root it follows, and its new leaves to the root it names; null when it does. */
const rootsRefusal = (h: TreeHeader, first: ReadonlyMap<Hex, Hex>, now: ReadonlyMap<Hex, TreeLeaf>): string | null => {
  if (h.changes.length === 0) {
    return h.root === h.previousRoot ? null : 'it holds no changes and names another root than the one it follows';
  }
  if (rootFrom(first, h.proof) !== h.previousRoot) return 'its proof and the leaves it replaces do not make the root it follows';
  const after = new Map([...now].map(([k, l]) => [k, leafHashOf(l)] as const));
  return rootFrom(after, h.proof) === h.root ? null : 'its proof and its new leaves do not make the root it names';
};

/**
 * **WHY THIS HEADER IS NOT AN HONEST NEXT STEP FROM THE ONE BEFORE IT, OR NULL
 * WHEN IT IS.** See the head of this file. The caller has folded it to a head
 * the chain holds; nothing here reads the chain.
 */
export const transitionRefusal = (input: TransitionInput): TransitionStop | null => {
  const seq = input.before.seq + 1;
  const notGiven = (what: string): TransitionStop => ({ stop: 'not-given', seq, what });
  if (input.header === undefined || input.header === null) return notGiven('its header');
  /* A header whose digest cannot be taken cannot be the one the chain holds: it was not given. */
  if (!treeHeaderReadable(input.header)) return notGiven('its header as given');
  const h = input.header as TreeHeader;
  const by = typeof h.anchoredBy?.publicKey === 'string' ? h.anchoredBy.publicKey : '';
  /*
   * The head binds the header's message, which names the anchoring key, but not
   * its signature: the message is judged first, and the signature decides only
   * whether a failing header names who signed it, or an honest one was given whole.
   */
  const signed = treeHeaderSigned(h);
  const dishonest = (why: string): TransitionStop => ({ stop: 'dishonest', seq, anchoredBy: signed ? by : null, why });
  /* Folded to the head on chain, a header out of shape is the seat's: the head binds every field of it. */
  const shape = treeHeaderShapeRefusal(input.company, h);
  if (shape !== null) return dishonest(`its header is not one a seat may anchor (${shape})`);
  /*
   * First everything the header itself proves or disproves, needing nothing the
   * service holds: so a header whose own message is false is said to be, even
   * when the service also withholds an entry or the directory it would need.
   */
  if (h.seq !== seq) return dishonest(`it says it is batch ${h.seq + 1}, and it follows batch ${seq}`);
  /* A recovery follows the header it resumes from, whatever head the chain held when it was carried out; the head binds both. */
  if (h.kind === 'recovery') {
    if (h.resumesFrom!.head !== input.before.head || h.resumesFrom!.root !== input.before.root) {
      return dishonest('it does not resume from the header before it');
    }
  } else if (h.previous !== input.before.head) return dishonest('it does not follow the head before it');
  if (h.previousRoot !== input.before.root) return dishonest('the root it follows is not the root before it');
  const fewest = h.kind === 'recovery' ? 0 : 1;
  if (h.changes.length < fewest || h.changes.length > ENTRIES_AT_ONCE) {
    return dishonest(`it holds ${h.changes.length} changes, and a batch holds ${fewest} to ${ENTRIES_AT_ONCE}`);
  }
  const dirs = h.changes.filter((c) => c.leaf.store === 'directory').map((c) => c.leaf.version);
  if (h.dirVersion !== Math.max(input.before.dirVersion, ...dirs)) return dishonest('it names another directory version than the one anchored through it');
  /* Per position: the leaf before this batch (the first change's prior) and the leaf now. */
  const first = new Map<Hex, Hex>();
  const now = new Map<Hex, TreeLeaf>();
  /* Each change with the leaf it replaces, in filing order. */
  const steps: { readonly l: TreeLeaf; readonly was: TreeLeaf | null }[] = [];
  for (const c of h.changes) {
    const l = c.leaf;
    const key = treeKeyOf(l);
    const was = now.has(key) ? now.get(key)! : c.prior;
    if (now.has(key) && (c.prior === null || leafHashOf(c.prior) !== leafHashOf(now.get(key)!))) {
      return dishonest('a second change to one record does not follow the first');
    }
    if (!first.has(key)) first.set(key, c.prior === null ? ZERO : leafHashOf(c.prior));
    if (was !== null && recordKeyOf(was) !== recordKeyOf(l)) return dishonest('a change replaces another record\'s leaf');
    if (l.prior !== (was === null ? ZERO : leafHashOf(was))) return dishonest('a leaf does not name the leaf it replaces');
    if (was !== null && l.version <= was.version) {
      return dishonest('a version does not follow the one before it');
    }
    if (l.batch !== h.seq || l.dirVersion !== h.dirVersion) return dishonest('a leaf does not name this batch and the directory through it');
    if (l.store === 'directory' ? !(l.held !== undefined && sameHeld(l.held, h.held)) : l.held !== undefined) {
      return dishonest('a directory version\'s leaf does not name the holders its header names');
    }
    now.set(key, l);
    steps.push({ l, was });
  }
  const roots = rootsRefusal(h, first, now);
  if (roots !== null) return dishonest(roots);
  /* Then what needs the directory, the entries and the older leaves the service gives. */
  const anchoring = input.seatOf(by, undefined, h.dirVersion, h);
  if (anchoring === undefined) return notGiven(`the company's directory at version ${h.dirVersion}`);
  if (anchoring === null) return dishonest('it was anchored by a key no seat that may anchor held, in the directory as anchored with it');
  /* The head binds the tag of the seat whose call moved it: a header naming one seat's key and another seat's tag is false. */
  const tagged = input.tagSeat?.(h.tag);
  if (tagged !== undefined && tagged !== anchoring) {
    return dishonest('it names the key of one seat and was anchored by the call of another, whose tag it names');
  }
  /* The leaves this header itself names, by hash: an older version it holds is on a later version's chain too. */
  const own = new Map<Hex, TreeLeaf>();
  for (const { l, was } of steps) {
    const e = input.entry(l.entryId);
    if (e === undefined || e === null) return notGiven(`the entry of version ${l.version} of ${l.store} record ${l.id}`);
    if (manifestEntryRefusal(input.company, e) !== null || entryIdOf(e as ManifestEntry) !== l.entryId) {
      return dishonest('a leaf names an entry that is not signed by its filer');
    }
    const entry = e as ManifestEntry;
    if (entry.store !== l.store || entry.kind !== l.kind || entry.id !== l.id || entry.version !== l.version || entry.digest !== l.digest
      || entry.filedBy.publicKey.toLowerCase() !== l.filedBy) return dishonest('a leaf does not say what its entry says');
    const filer = input.seatOf(l.filedBy, entry, h.dirVersion, h);
    if (filer === undefined) return notGiven(`the company's directory at version ${h.dirVersion}`);
    if (filer === null) return dishonest('it holds a filing signed by a key no seat that may file it held');
    /* Bytes an older version of the record already names, at a newer version: a record rolled back. */
    for (let p: TreeLeaf | null = was; p !== null;) {
      if (p.digest === l.digest) return dishonest('it holds a record rolled back to the bytes of an older version');
      if (p.prior === ZERO) break;
      const older = own.get(p.prior) ?? input.priorChain(p.prior);
      if (older === undefined || leafHashOf(older) !== p.prior) return notGiven(`an older version of ${l.store} record ${l.id}`);
      p = older;
    }
    own.set(leafHashOf(l), l);
  }
  /* Honest as signed, and the signature beside it fails: the service may have swapped it. */
  if (!signed) return notGiven('its header as its anchoring seat signed it');
  return null;
};

/** A check's stop, in words a person can act on: the service's doing, or the key's. */
export const transitionStopSaid = (s: TransitionStop): string => s.stop === 'not-given'
  ? (s.recovery === true
    ? `the company's signers recovered its records on the chain after batch ${s.seq}, the last this device checked, and this device `
      + 'cannot follow the recovery from what it kept. If the recovery resumed from a batch further back than those this device keeps '
      + 'whole, the quorum gave up the batches after it - its doing, not the service\'s - and checking the company\'s records from the '
      + `first batch reads on from it; if not, the service is withholding ${s.what} of batch ${s.seq + 1}, and a device that kept it files it again`
    : `the service did not give ${s.what} of batch ${s.seq + 1} of the company's records, so nothing from it on can be believed. `
      + 'Reload the page; if it happens again, the service is withholding it, and a device that kept it files it again'
      + (s.movedBy === undefined ? ''
        : s.anchorsInBlock !== undefined && s.anchorsInBlock > 1
          ? `. The seat ${s.movedBy} anchored last in the block that moved the anchor past it, which held ${s.anchorsInBlock} anchors, so the `
            + 'seat that moved it may be another of them; if no device kept it, the company\'s seats can recover past it'
          : `. The seat ${s.movedBy} moved the anchor past it; if no device kept it, the company's seats can recover past it, and if that `
            + 'seat keeps doing so, remove it'))
  : `batch ${s.seq + 1} of the company's records is not honest: ${s.why}. `
    + (s.anchoredBy === null
      ? 'Its signature does not verify, so which seat made it cannot be said'
      : `It was signed by the key ${s.anchoredBy}`)
    + ', and nothing from it on can be believed. Tell the company\'s other seats: the way past it is a recovery they approve';

/* ------------------------------------------------------------------ the next header */

export interface NextHeaderInput {
  readonly company: string;
  /** The header this device checked last, which the new one follows. */
  readonly before: CheckedHead;
  /** The entries to anchor, in filing order, each signed by a seat that may file it now. */
  readonly entries: readonly ManifestEntry[];
  /** The leaf now at each entry's position, null for none, as the service gave it; checked here against `before.root`. */
  readonly current: ReadonlyMap<Hex, TreeLeaf | null>;
  /** The proof for those positions, as the service gave it. */
  readonly proof: TreeProof;
  /** An older leaf by its hash, for the rolled-back check. */
  readonly priorChain: (hash: Hex) => TreeLeaf | undefined;
  readonly held: BatchHolders;
  readonly at: string;
  /** The tag of the anchoring seat, as the account works it out from the seat its call proves (`anchorTagOf`). */
  readonly tag: Hex;
  /**
   * For a recovery approved by a quorum: the head the chain holds now, which the
   * call names, and the salt its proposal was raised with. `before` is then the
   * header it resumes from. A recovery may anchor no entries.
   */
  readonly recovery?: { readonly previous: Hex; readonly salt: Hex };
}

/**
 * **THE NEXT HEADER, AS AN ANCHORING DEVICE MAKES IT**, with the entries it left
 * out: a version no newer than its record's leaf, or naming the bytes of an
 * older version. A version past one never entered is anchored past it, in
 * filing order after any version between that was given. Null when nothing is left to anchor. Throws when the leaves
 * given do not make the root it follows, or an older leaf was not given:
 * nothing is anchored from what the device cannot check.
 */
export const nextTreeHeader = (input: NextHeaderInput, signingSecret: Hex): { readonly header: TreeHeader; readonly leftOut: readonly ManifestEntry[] } | null => {
  if (input.entries.length > ENTRIES_AT_ONCE) throw new Error(`a batch holds at most ${ENTRIES_AT_ONCE} changes; anchor the rest in the next`);
  const before = new Map<Hex, Hex>();
  for (const e of input.entries) {
    const key = treeKeyOf(e);
    if (!input.current.has(key)) throw new Error(`the leaf of ${e.store} record ${e.id} was not given`);
    const l = input.current.get(key)!;
    before.set(key, l === null ? ZERO : leafHashOf(l));
  }
  /* A recovery anchoring nothing needs no leaves: it holds the root it resumes from. */
  if (input.entries.length > 0 && rootFrom(before, input.proof) !== input.before.root) {
    throw new Error('the leaves the service gave do not make the root this device checked last');
  }
  const seq = input.before.seq + 1;
  /* Which entries go in: each newer than its record's leaf, naming no older version's bytes, counting those kept before it. */
  const latest = new Map<Hex, { readonly version: number; readonly digests: readonly Hex[] }>();
  const chainOf = (l: TreeLeaf | null): Hex[] => {
    const out: Hex[] = [];
    for (let p = l; p !== null;) {
      out.push(p.digest);
      if (p.prior === ZERO) break;
      const older = input.priorChain(p.prior);
      if (older === undefined || leafHashOf(older) !== p.prior) throw new Error(`an older version of ${l!.store} record ${l!.id} was not given`);
      p = older;
    }
    return out;
  };
  const kept: ManifestEntry[] = [];
  const leftOut: ManifestEntry[] = [];
  for (const e of input.entries) {
    const key = treeKeyOf(e);
    const was = latest.get(key) ?? (() => { const l = input.current.get(key)!; return { version: l?.version ?? 0, digests: chainOf(l) }; })();
    if (e.version <= was.version || was.digests.includes(e.digest)) { leftOut.push(e); continue; }
    /* A version past one never entered is anchored past it: the one between, entered later, is below the leaf and never anchored. */
    kept.push(e);
    latest.set(key, { version: e.version, digests: [e.digest, ...was.digests] });
  }
  if (kept.length === 0 && input.recovery === undefined) return null;
  const dirVersion = Math.max(input.before.dirVersion, ...kept.filter((e) => e.store === 'directory').map((e) => e.version));
  const now = new Map<Hex, TreeLeaf | null>(input.current);
  const changes: TreeChange[] = kept.map((e) => {
    const key = treeKeyOf(e);
    const was = now.get(key) ?? null;
    const leaf: TreeLeaf = {
      store: e.store, kind: e.kind, id: e.id, version: e.version, digest: e.digest, filedBy: e.filedBy.publicKey.toLowerCase(),
      entryId: entryIdOf(e), batch: seq, dirVersion, prior: was === null ? ZERO : leafHashOf(was),
      ...(e.store === 'directory' ? { held: heldOf(input.held) } : {}),
    };
    now.set(key, leaf);
    return { prior: was, leaf };
  });
  const after = new Map<Hex, Hex>();
  for (const k of before.keys()) { const l = now.get(k) ?? null; after.set(k, l === null ? ZERO : leafHashOf(l)); }
  const root = changes.length === 0 ? input.before.root : rootFrom(after, input.proof)!;
  const proof = changes.length === 0 ? { siblings: [] } : input.proof;
  const r = input.recovery;
  const header = signTreeHeader({
    company: input.company, kind: r === undefined ? 'anchor' : 'recovery', tag: input.tag.toLowerCase() as Hex, seq,
    previous: r === undefined ? input.before.head : r.previous.toLowerCase() as Hex,
    ...(r === undefined ? {} : {
      resumesFrom: { seq: input.before.seq, head: input.before.head, root: input.before.root }, salt: r.salt.toLowerCase() as Hex,
    }),
    previousRoot: input.before.root, root, dirVersion, changes, proof, held: heldOf(input.held), at: input.at,
  }, signingSecret);
  return { header, leftOut };
};

/**
 * **WHAT A DEVICE SAYS OF BATCHES IT CHECKED THAT A RECOVERY GAVE UP**:
 * the quorum's doing, never the service's - from where the recovery resumed to
 * the last batch this device had checked.
 */
export const recoveredSaid = (r: { readonly resumedFrom: CheckedHead; readonly gaveUpTo: number }): string => {
  const first = r.resumedFrom.seq + 1;
  const batches = first === r.gaveUpTo ? `batch ${first}` : `batches ${first} to ${r.gaveUpTo}`;
  return `The company's signers recovered its records from batch ${r.resumedFrom.seq}, giving up ${batches} that this device had checked: `
    + `what was anchored in ${first === r.gaveUpTo ? 'it' : 'them'} is no longer the company's, and what was filed for ${first === r.gaveUpTo ? 'it' : 'them'} waits to be anchored again.`;
};
