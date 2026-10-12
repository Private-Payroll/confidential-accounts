/**
 * **THE COMPANY'S RECORDS AS ONE TREE, AND EVERY BATCH CHECKED AGAINST THE ONE
 * BEFORE IT.**
 *
 * Each record a company files - in any of the five stores its manifest enters
 * - has one leaf: its latest anchored version, with the entry its filer signed,
 * the batch that anchored it, the directory version anchored through that
 * batch and the hash of the record's previous leaf, so every older version is
 * on a chain behind the newest. The leaves sit in a sparse Merkle tree of
 * height 256 over SHA-256. A leaf's position is the first eight bytes of the
 * hash of its store and kind, then the first twenty-four of the hash of its
 * id: every record of one kind sits under one subtree, so a kind's whole list
 * is proven by recomputing that subtree.
 *
 * A batch's header names the head it follows, the root before it, the root
 * after it, the changes it makes in filing order - each with the leaf it
 * replaces - and the proof that takes the one root to the other. It is signed
 * by the anchoring seat, and the account's `anchor` call folds its digest
 * (`treeBatchOf`) into the head on chain, so a header is the one the chain
 * holds exactly when it folds to that head.
 *
 * **A HEADER IS CHECKED AGAINST THE ONE BEFORE IT, NEVER BY REPLAYING EVERY
 * BATCH (`transitionRefusal`).** It stops in one of two ways, never confused:
 *   · `dishonest` - the header's own message fails against the one before
 *     it: its seat, a filing no seat may file, a version that does not follow
 *     the one before it, bytes rolled back, or roots its changes do not make.
 *     The head binds that message whatever signature is beside it, so it is
 *     dishonest whatever the signature. It names the key that signed it when
 *     the signature verifies; when it does not, it names no key, since a seat
 *     can name another seat's key and nothing then proves who signed.
 *   · `not-given` - a header, an entry or an older leaf the header needs was
 *     not given, or a header whose message holds came with a signature that
 *     fails. That is the service's doing, and blames no seat: the head binds
 *     what the seat signed, not the signature itself, so the service may have
 *     swapped it, and a device that kept the header files it again.
 *
 * Pure, and loads no WebAssembly: the server and the page both import it. The
 * one function of the account a device needs - the head after a header - is
 * the caller's.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonical, fromHex, sign, signingPublicKeyOf, toHex, utf8, verify, type Hex } from '../core/crypto.js';
import {
  batchHoldersShapeRefusal, EMPTY_HEAD, ENTRIES_AT_ONCE, entryIdOf, MANIFEST_STORES, manifestEntryRefusal, recordKeyOf,
  type BatchHolders, type ManifestEntry, type ManifestEntryBody, type ManifestStore,
} from './record-manifest.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;

/** The tree's height: one level per bit of a position. */
export const TREE_HEIGHT = 256;

/** How many seqs one page of headers covers at most: what a device asks for, and what the service gives. */
export const HEADERS_AT_ONCE = 64;

/** How many records one proofs request may name at most; a read asking for more asks in parts. */
export const PROVEN_AT_ONCE = 256;
/** The bytes of a position that name a record's store and kind. */
const KIND_BYTES = 8;

/** An empty position, and the hash an empty leaf stands for. */
export const ZERO: Hex = '00'.repeat(32);

const KIND_DOMAIN = 'confidential-accounts/record-tree/kind/v1';
const ID_DOMAIN = 'confidential-accounts/record-tree/id/v1';
const LEAF_DOMAIN = 'confidential-accounts/record-tree/leaf/v1';
const HEADER_DOMAIN = 'confidential-accounts/record-tree/header/v1';

/** A record, in any of the five stores. */
export interface RecordName { readonly store: ManifestStore; readonly kind: string; readonly id: string }

/** The first sixteen hex digits of every position of one store and kind: the root of that kind's subtree. */
export const kindPrefixOf = (store: ManifestStore, kind: string): Hex =>
  toHex(sha256(utf8(`${KIND_DOMAIN}|${store}:${kind}`)).slice(0, KIND_BYTES));

/** **WHERE A RECORD SITS IN THE TREE**: its kind's prefix, then the first twenty-four bytes of the hash of its id. */
export const treeKeyOf = (r: Pick<RecordName, 'store' | 'kind' | 'id'>): Hex =>
  kindPrefixOf(r.store, r.kind) + toHex(sha256(utf8(`${ID_DOMAIN}|${r.id}`)).slice(0, 32 - KIND_BYTES));

/**
 * **ONE RECORD'S LATEST ANCHORED VERSION.** `entryId` names the entry its filer
 * signed (`entryIdOf`), `batch` the header that anchored it (its `seq`),
 * `dirVersion` the newest directory version anchored through that batch, and
 * `prior` the hash of the record's previous leaf, or `ZERO` for its first. A
 * directory version's leaf also names who held the account as that batch was
 * judged (`held`), which every version of the directory is counted against.
 */
export interface TreeLeaf extends RecordName {
  readonly version: number;
  readonly digest: Hex;
  readonly filedBy: Hex;
  readonly entryId: Hex;
  readonly batch: number;
  readonly dirVersion: number;
  readonly prior: Hex;
  readonly held?: BatchHolders;
}

const isWhole = (n: unknown, from: number): n is number => Number.isSafeInteger(n) && (n as number) >= from;

/** Why `value` is not a leaf in its shape, or null. Whether it is honest is the header's check. */
export const treeLeafRefusal = (value: unknown): string | null => {
  const l = value as Partial<TreeLeaf> | null;
  if (l === null || typeof l !== 'object') return 'it is not a leaf';
  if (!(MANIFEST_STORES as readonly unknown[]).includes(l.store) || typeof l.kind !== 'string' || typeof l.id !== 'string') return 'it names no record';
  if (!isWhole(l.version, 1)) return 'its version is not a whole number from one';
  if (![l.digest, l.filedBy, l.entryId, l.prior].every((x) => typeof x === 'string' && HEX64.test(x))) return 'its digest, filer, entry or prior leaf is not thirty-two bytes of lower-case hex';
  if (!isWhole(l.batch, 0) || !isWhole(l.dirVersion, 0)) return 'it does not name the batch that anchored it and the directory then';
  if (l.store === 'directory') return batchHoldersShapeRefusal(l.held);
  return l.held === undefined ? null : 'only a directory version\'s leaf names who held the account';
};

const heldOf = (h: BatchHolders) => ({ approvals: h.approvals, signerRoot: h.signerRoot, signers: [...h.signers] });
const sameHeld = (a: BatchHolders, b: BatchHolders): boolean =>
  a.approvals === b.approvals && a.signerRoot === b.signerRoot && a.signers.length === b.signers.length && a.signers.every((x, i) => x === b.signers[i]);

/** **A LEAF'S HASH**: what its position holds. Tagged apart from every inner node. */
export const leafHashOf = (l: TreeLeaf): Hex => {
  const body = canonical({
    domain: LEAF_DOMAIN, store: l.store, kind: l.kind, id: l.id, version: l.version, digest: l.digest, filedBy: l.filedBy,
    entryId: l.entryId, batch: l.batch, dirVersion: l.dirVersion, prior: l.prior, ...(l.held === undefined ? {} : { held: heldOf(l.held) }),
  });
  const b = utf8(body);
  const tagged = new Uint8Array(b.length + 1);
  tagged.set(b, 1);
  return toHex(sha256(tagged));
};

const nodeOf = (l: Uint8Array, r: Uint8Array): Uint8Array => {
  const b = new Uint8Array(65);
  b[0] = 1;
  b.set(l, 1);
  b.set(r, 33);
  return sha256(b);
};

/** The hash of an empty subtree of each height, from an empty leaf (`ZERO`) up. */
const EMPTY: readonly Uint8Array[] = (() => {
  const out: Uint8Array[] = [new Uint8Array(32)];
  for (let h = 1; h <= TREE_HEIGHT; h += 1) out.push(nodeOf(out[h - 1]!, out[h - 1]!));
  return out;
})();

/** The root of a tree holding no record. */
export const EMPTY_ROOT: Hex = toHex(EMPTY[TREE_HEIGHT]!);

const bitAt = (k: Uint8Array, d: number): number => (k[d >> 3]! >> (7 - (d & 7))) & 1;
const withBit = (p: Uint8Array, d: number): Uint8Array => {
  const q = Uint8Array.from(p);
  q[d >> 3] = q[d >> 3]! | (1 << (7 - (d & 7)));
  return q;
};
const nodeId = (depth: number, prefix: Uint8Array): string => `${depth}:${toHex(prefix)}`;

/** One inner node a proof gives: its depth from the root (1 to 256), its position's first `depth` bits (the rest zero), and its hash. */
export interface TreeSibling { readonly depth: number; readonly path: Hex; readonly hash: Hex }

/** **A PROOF**: every non-empty node beside the paths asked for. A node it does not give is empty. */
export interface TreeProof { readonly siblings: readonly TreeSibling[] }

/** A kind asked for whole: its every leaf is given, so nothing inside its subtree is taken from the proof. */
export interface KindAsked { readonly store: ManifestStore; readonly kind: string }

/** Whether the node at `depth` with `prefix` lies inside, or on the way to, one of `kinds`' subtrees. */
const onAKind = (depth: number, prefix: Uint8Array, kinds: readonly Uint8Array[]): 'inside' | 'above' | null => {
  for (const k of kinds) {
    const bits = Math.min(depth, KIND_BYTES * 8);
    let same = true;
    for (let d = 0; d < bits && same; d += 1) same = bitAt(prefix, d) === bitAt(k, d);
    if (same) return depth >= KIND_BYTES * 8 ? 'inside' : 'above';
  }
  return null;
};

/**
 * **THE ROOT THESE LEAVES MAKE WITH THIS PROOF**, or null when the proof is not
 * a proof (a node outside the tree, a position with bits past its depth, a node
 * given twice). `leaves` maps each position asked to its leaf's hash, `ZERO`
 * for an empty one; inside a kind asked whole, a node no leaf given falls under
 * is empty, whatever the proof says.
 */
export const rootFrom = (leaves: ReadonlyMap<Hex, Hex>, proof: TreeProof, kinds: readonly KindAsked[] = []): Hex | null => {
  const given = new Map<string, Uint8Array>();
  if (!Array.isArray(proof?.siblings)) return null;
  for (const s of proof.siblings) {
    if (!isWhole(s?.depth, 1) || s.depth > TREE_HEIGHT || typeof s.path !== 'string' || !HEX64.test(s.path)
      || typeof s.hash !== 'string' || !HEX64.test(s.hash)) return null;
    const p = fromHex(s.path);
    for (let d = s.depth; d < TREE_HEIGHT; d += 1) if (bitAt(p, d) !== 0) return null;
    const id = nodeId(s.depth, p);
    if (given.has(id)) return null;
    given.set(id, fromHex(s.hash));
  }
  const kindKeys = kinds.map((k) => fromHex(kindPrefixOf(k.store, k.kind).padEnd(64, '0')));
  const keys = [...leaves.keys()].map((k) => fromHex(k));
  const at = (depth: number, prefix: Uint8Array, under: Uint8Array[]): Uint8Array => {
    if (under.length === 0) {
      if (onAKind(depth, prefix, kindKeys) === 'inside') return EMPTY[TREE_HEIGHT - depth]!;
      return given.get(nodeId(depth, prefix)) ?? EMPTY[TREE_HEIGHT - depth]!;
    }
    if (depth === TREE_HEIGHT) return fromHex(leaves.get(toHex(under[0]!))!);
    const left = under.filter((k) => bitAt(k, depth) === 0);
    const right = under.filter((k) => bitAt(k, depth) === 1);
    return nodeOf(at(depth + 1, prefix, left), at(depth + 1, withBit(prefix, depth), right));
  };
  /* A kind asked whole with no leaf given still needs its subtree computed as empty: walk to it. */
  const atWithKinds = (depth: number, prefix: Uint8Array, under: Uint8Array[]): Uint8Array => {
    const kind = onAKind(depth, prefix, kindKeys);
    if (kind !== 'above' || depth === TREE_HEIGHT) return at(depth, prefix, under);
    const left = under.filter((k) => bitAt(k, depth) === 0);
    const right = under.filter((k) => bitAt(k, depth) === 1);
    return nodeOf(atWithKinds(depth + 1, prefix, left), atWithKinds(depth + 1, withBit(prefix, depth), right));
  };
  return toHex(atWithKinds(0, new Uint8Array(32), keys));
};

/** What a read asks the tree to prove: records, each with the leaf it was given or null for none, and kinds whole. */
export interface ProvenAsk {
  readonly records: readonly { readonly name: RecordName; readonly leaf: TreeLeaf | null }[];
  readonly kinds?: readonly { readonly kind: KindAsked; readonly leaves: readonly TreeLeaf[] }[];
}

/**
 * **WHY THESE LEAVES ARE NOT WHAT THE ROOT HOLDS FOR THE RECORDS AND KINDS
 * ASKED, OR NULL WHEN THEY ARE.** A record given no leaf is proven absent: its
 * position empty. A kind's leaves must be every record of that kind.
 */
export const provenRefusal = (root: Hex, ask: ProvenAsk, proof: TreeProof): string | null => {
  const leaves = new Map<Hex, Hex>();
  for (const r of ask.records) {
    if (r.leaf !== null) {
      const why = treeLeafRefusal(r.leaf);
      if (why !== null) return `the leaf given ${why}`;
      if (recordKeyOf(r.leaf) !== recordKeyOf(r.name)) return 'the leaf given names another record than the one asked';
    }
    const key = treeKeyOf(r.name);
    const hash = r.leaf === null ? ZERO : leafHashOf(r.leaf);
    if (leaves.has(key) && leaves.get(key) !== hash) return 'two leaves were given for one record';
    leaves.set(key, hash);
  }
  for (const k of ask.kinds ?? []) {
    for (const l of k.leaves) {
      const why = treeLeafRefusal(l);
      if (why !== null) return `a leaf of the list ${why}`;
      if (l.store !== k.kind.store || l.kind !== k.kind.kind) return 'the list holds a record of another kind';
      const key = treeKeyOf(l);
      if (leaves.has(key) && leaves.get(key) !== leafHashOf(l)) return 'two leaves were given for one record';
      leaves.set(key, leafHashOf(l));
    }
  }
  const made = rootFrom(leaves, proof, (ask.kinds ?? []).map((k) => k.kind));
  if (made === null) return 'the proof given is not a proof';
  return made === root ? null : 'the leaves given, with the proof given, do not make the root the anchor holds';
};

/** Why `leaves` are not every record of one kind the root holds, or null when they are. */
export const kindListRefusal = (root: Hex, kind: KindAsked, leaves: readonly TreeLeaf[], proof: TreeProof): string | null =>
  provenRefusal(root, { records: [], kinds: [{ kind, leaves }] }, proof);

/**
 * **THE TREE AS THE SERVICE AND THE ANCHORING DEVICE HOLD IT**: every leaf's
 * hash by position, and every non-empty node, so a proof for any records or
 * kinds is read off it.
 */
export class SparseTree {
  private readonly leaves = new Map<Hex, Hex>();
  private nodes: Map<string, Uint8Array> | null = null;
  private top: Hex = EMPTY_ROOT;

  constructor(leaves: Iterable<readonly [Hex, Hex]> = []) { for (const [k, h] of leaves) this.set(k, h); }

  /** Puts a leaf's hash at a position; null or `ZERO` empties it. */
  set(key: Hex, hash: Hex | null): void {
    if (hash === null || hash === ZERO) this.leaves.delete(key); else this.leaves.set(key, hash);
    this.nodes = null;
  }

  /** The leaf hash at a position, or `ZERO`. */
  at(key: Hex): Hex { return this.leaves.get(key) ?? ZERO; }

  /** Every position of one kind that holds a leaf. */
  keysOfKind(kind: KindAsked): Hex[] {
    const p = kindPrefixOf(kind.store, kind.kind);
    return [...this.leaves.keys()].filter((k) => k.startsWith(p)).sort();
  }

  private built(): Map<string, Uint8Array> {
    if (this.nodes !== null) return this.nodes;
    const nodes = new Map<string, Uint8Array>();
    const walk = (depth: number, prefix: Uint8Array, under: Uint8Array[]): Uint8Array => {
      if (under.length === 0) return EMPTY[TREE_HEIGHT - depth]!;
      const h = depth === TREE_HEIGHT ? fromHex(this.leaves.get(toHex(under[0]!))!)
        : nodeOf(
          walk(depth + 1, prefix, under.filter((k) => bitAt(k, depth) === 0)),
          walk(depth + 1, withBit(prefix, depth), under.filter((k) => bitAt(k, depth) === 1)),
        );
      nodes.set(nodeId(depth, prefix), h);
      return h;
    };
    this.top = toHex(walk(0, new Uint8Array(32), [...this.leaves.keys()].map((k) => fromHex(k))));
    this.nodes = nodes;
    return nodes;
  }

  root(): Hex { this.built(); return this.top; }

  /** **THE PROOF FOR THESE POSITIONS AND THESE KINDS WHOLE**: every non-empty node beside their paths, and none inside a kind asked. */
  proofFor(ask: { readonly keys: readonly Hex[]; readonly kinds?: readonly KindAsked[] }): TreeProof {
    const nodes = this.built();
    const kindKeys = (ask.kinds ?? []).map((k) => fromHex(kindPrefixOf(k.store, k.kind).padEnd(64, '0')));
    const wanted = [...new Set(ask.keys)].map((k) => fromHex(k));
    const siblings: TreeSibling[] = [];
    const walk = (depth: number, prefix: Uint8Array, under: Uint8Array[]): void => {
      const kind = onAKind(depth, prefix, kindKeys);
      if (under.length === 0 && kind === null) {
        const h = nodes.get(nodeId(depth, prefix));
        if (h !== undefined && depth > 0) siblings.push({ depth, path: toHex(prefix), hash: toHex(h) });
        return;
      }
      if (depth === TREE_HEIGHT) return;
      /* Inside a kind asked whole, an empty node needs nothing below it. */
      if (kind === 'inside' && under.length === 0 && !nodes.has(nodeId(depth, prefix))) return;
      walk(depth + 1, prefix, under.filter((k) => bitAt(k, depth) === 0));
      walk(depth + 1, withBit(prefix, depth), under.filter((k) => bitAt(k, depth) === 1));
    };
    walk(0, new Uint8Array(32), wanted);
    return { siblings };
  }
}

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
  if (h.changes.length === 0) {
    if (h.root !== h.previousRoot) return dishonest('it holds no changes and names another root than the one it follows');
  } else {
    if (rootFrom(first, h.proof) !== h.previousRoot) return dishonest('its proof and the leaves it replaces do not make the root it follows');
    const after = new Map([...now].map(([k, l]) => [k, leafHashOf(l)] as const));
    if (rootFrom(after, h.proof) !== h.root) return dishonest('its proof and its new leaves do not make the root it names');
  }
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

/* ------------------------------------------------------------------ checked forward */

/** One page of headers the service gives, with the entries their changes name and the older leaves their records' chains need. */
export interface HeadersPage {
  readonly headers: readonly unknown[];
  readonly entries: readonly unknown[];
  readonly leaves: readonly unknown[];
}

/**
 * One step of the account's head: the head before, a header's digest, who held
 * the account as it was judged, the tag of the seat that anchored it, and - for
 * a recovery - the head it resumes from.
 */
export interface HeadStep {
  readonly previous: Hex; readonly batch: Hex; readonly held: BatchHolders; readonly tag: Hex; readonly resumesFrom?: Hex;
}

/** **THE STEP OF THE ACCOUNT'S HEAD A HEADER MAKES**: the one way a header's head is asked of the account's own functions. */
export const headStepOf = (h: TreeHeader): HeadStep => ({
  previous: h.previous, batch: treeBatchOf(h), held: h.held, tag: h.tag,
  ...(h.kind === 'recovery' ? { resumesFrom: h.resumesFrom!.head } : {}),
});

export interface ForwardInput {
  readonly company: string;
  /** The head this device checked last; `GENESIS` to check from the company's first batch. */
  readonly from: CheckedHead;
  /** Every head the account's history shows (the last of each block), at the indexer the person's own wallet names. */
  readonly landed: ReadonlySet<Hex>;
  /** The head the account holds now. */
  readonly chainHead: Hex;
  /** Headers with a seq above `seq`, in seq order, at most about `limit`, with what they need. */
  readonly headersAfter: (seq: number, limit: number) => Promise<HeadersPage>;
  /** The head after each step, by the account's own functions. */
  readonly headsOf: (steps: readonly HeadStep[]) => Promise<readonly Hex[]>;
  readonly seatOf: TransitionInput['seatOf'];
  readonly tagSeat?: TransitionInput['tagSeat'];
  /** Keeps a head this device checked, with the header that made it, before the next is checked, so a check cut short carries on from it. */
  readonly keep: (checked: CheckedHead, header: TreeHeader) => Promise<void>;
  /**
   * A head this device checked before the one it checks from, by its head, or
   * undefined: a recovery resuming from one gives up the batches after it that
   * this device had checked, and the check goes on from it.
   */
  readonly earlier?: (head: Hex) => CheckedHead | undefined;
  /**
   * With `earlier`: the seq of the oldest such head. Where no header past the
   * head checked last is given, the headers after it are read once more, for
   * a recovery resuming from one of them.
   */
  readonly earliestSeq?: number;
  /**
   * Told, before any header of it is checked, each path of headers found to
   * reach a head the chain shows, with the head after each: what `seatOf`
   * needs of a directory version those headers anchor is read then.
   */
  readonly confirmed?: (path: readonly { readonly header: TreeHeader; readonly head: Hex }[]) => Promise<void>;
  readonly pageSize?: number;
}

/** How many headers a device holds unconfirmed - read, but not yet folded to a head the chain shows - before it says they are not the chain's. */
const UNCONFIRMED_AT_MOST = 1024;

/**
 * **EVERY HEADER FROM A HEAD THIS DEVICE CHECKED TO THE HEAD THE CHAIN HOLDS,
 * CHECKED ONE AGAINST THE ONE BEFORE IT, A PAGE AT A TIME.** A header is
 * believed to be the chain's only once it folds, with those before it, to a
 * head the account's history shows; then each is checked (`transitionRefusal`)
 * and kept (`keep`), so nothing of the history is held but the heads. A header
 * that lost a race to the same head is passed over. Headers that never reach
 * a head the chain shows, or none given past a head, stop `not-given`.
 */
export async function checkForward(input: ForwardInput): Promise<{
  readonly reached: CheckedHead; readonly stop: TransitionStop | null;
  /** Where a recovery the check went through resumed from, and the last batch this device had checked that it gave up. */
  readonly recovered?: { readonly resumedFrom: CheckedHead; readonly gaveUpTo: number };
}> {
  const target = input.chainHead.toLowerCase();
  let at = input.from;
  let recovered: { resumedFrom: CheckedHead; gaveUpTo: number } | undefined;
  /* The head a header follows: a recovery's is the one it resumes from. */
  const fromOf = (h: TreeHeader): Hex => (h.kind === 'recovery' ? h.resumesFrom!.head : h.previous);
  /* A head this device checked before the one it checks from, that only a recovery may resume from. */
  const earlierOf = (head: Hex): CheckedHead | undefined => (head === at.head ? undefined : input.earlier?.(head));
  if (at.head === target) return { reached: at, stop: null };
  const landed = new Set([...input.landed].map((h) => h.toLowerCase()));
  landed.add(target);
  /* Where each head sits in the account's history, oldest first, the head it holds now last: a recovery's head lands after the heads it gives up. */
  const landedAt = new Map([...landed].map((h, i) => [h, h === target ? Number.MAX_SAFE_INTEGER : i] as const));
  const limit = Math.max(1, input.pageSize ?? HEADERS_AT_ONCE);
  const entries = new Map<Hex, unknown>();
  const leaves = new Map<Hex, TreeLeaf>();
  const headAfter = new Map<string, Hex>();
  let seen: TreeHeader[] = [];
  let asked = at.seq;
  /* Whether the headers from before the head checked last were read once more, for a recovery resuming from an earlier head. */
  let lookedBack = input.earlier === undefined;
  /* A recovery resuming from a head this device checked before its last: one it may follow from there. */
  const resumesEarlier = (h: TreeHeader) => h.kind === 'recovery' && earlierOf(h.resumesFrom!.head) !== undefined;
  for (;;) {
    const page = await input.headersAfter(asked, limit);
    for (const e of page.entries ?? []) if (manifestEntryRefusal(input.company, e) === null) entries.set(entryIdOf(e as ManifestEntry), e);
    for (const l of page.leaves ?? []) if (treeLeafRefusal(l) === null) leaves.set(leafHashOf(l as TreeLeaf), l as TreeLeaf);
    const given = (page.headers ?? []).filter(treeHeaderReadable);
    const above = given.filter((h) => h.seq > asked);
    if (above.length === 0) {
      if (!lookedBack) {
        lookedBack = true;
        asked = Math.max(-1, (input.earliestSeq ?? 0) - 1);
        continue;
      }
      return { reached: at, stop: { stop: 'not-given', seq: at.seq + 1, what: 'its header' }, ...(recovered === undefined ? {} : { recovered }) };
    }
    asked = Math.max(...above.map((h) => h.seq));
    seen.push(...above.filter((h) => (h.seq > at.seq || resumesEarlier(h)) && !seen.includes(h)));
    /* Every head reachable from the last one checked, through the headers seen, each by the header that made it. */
    const reach = new Map<Hex, { readonly header: TreeHeader; readonly from: Hex }>();
    const seqOf = (head: Hex) => (head === at.head ? at.seq : reach.has(head) ? reach.get(head)!.header.seq : earlierOf(head)!.seq);
    /* Followed from the head checked last, one reached, or - a recovery only - one this device checked before it. */
    const follows = (h: TreeHeader): boolean => {
      const from = fromOf(h);
      if (from === at.head || reach.has(from)) return h.seq === seqOf(from) + 1;
      return h.kind === 'recovery' && earlierOf(from) !== undefined && h.seq === earlierOf(from)!.seq + 1
        && h.resumesFrom!.root === earlierOf(from)!.root;
    };
    for (let grew = true; grew;) {
      grew = false;
      const ready = seen.filter((h) => follows(h) && !headAfter.has(`${h.previous}${treeBatchOf(h)}`));
      if (ready.length > 0) {
        const heads = await input.headsOf(ready.map(headStepOf));
        ready.forEach((h, i) => headAfter.set(`${h.previous}${treeBatchOf(h)}`, String(heads[i] ?? '').toLowerCase()));
      }
      for (const h of seen) {
        if (!follows(h)) continue;
        const head = headAfter.get(`${h.previous}${treeBatchOf(h)}`);
        if (head === undefined || head === at.head || reach.has(head)) continue;
        reach.set(head, { header: h, from: fromOf(h) });
        grew = true;
      }
    }
    /* The furthest head the chain shows that these headers reach: the path to it is the chain's. */
    const confirmed = [...reach.keys()].filter((h) => landed.has(h)).sort((a, b) => landedAt.get(b)! - landedAt.get(a)! || seqOf(b) - seqOf(a))[0];
    if (confirmed !== undefined) {
      const path: { header: TreeHeader; head: Hex }[] = [];
      let h = confirmed;
      for (; h !== at.head && reach.has(h); h = reach.get(h)!.from) path.unshift({ header: reach.get(h)!.header, head: h });
      /*
       * The path begins at a head this device checked before the one it checked last: a recovery the company's quorum
       * approved gave up the batches after it, and this device checks on from it.
       */
      if (h !== at.head) {
        const resumed = earlierOf(h)!;
        recovered = { resumedFrom: resumed, gaveUpTo: at.seq };
        at = resumed;
      }
      await input.confirmed?.(path);
      for (const step of path) {
        const stop = transitionRefusal({
          company: input.company, before: at, header: step.header, entry: (id) => entries.get(id), priorChain: (hash) => leaves.get(hash), seatOf: input.seatOf,
          ...(input.tagSeat === undefined ? {} : { tagSeat: input.tagSeat }),
        });
        if (stop !== null) return { reached: at, stop, ...(recovered === undefined ? {} : { recovered }) };
        at = checkedAfter(step.header, step.head);
        await input.keep(at, step.header);
      }
      if (at.head === target) return { reached: at, stop: null, ...(recovered === undefined ? {} : { recovered }) };
      seen = seen.filter((h) => h.seq > at.seq);
      if (seen.length === 0) { entries.clear(); leaves.clear(); headAfter.clear(); }
    }
    /*
     * Let go of every header that can no longer be on the chain's path, so
     * headers that will never land cannot crowd out the chain's own: one that
     * follows no head reachable from the last one checked, and one at a seq the
     * pages have passed whose head the chain does not show and no header seen
     * follows - it lost a race, or was never sent.
     */
    const madeBy = (h: TreeHeader) => headAfter.get(`${h.previous}${treeBatchOf(h)}`);
    const reachable = new Set<Hex>([at.head, ...seen.map(madeBy).filter((x): x is Hex => x !== undefined)]);
    const followed = new Set(seen.map(fromOf));
    seen = seen.filter((h) => {
      if (!reachable.has(fromOf(h)) && !(h.kind === 'recovery' && earlierOf(fromOf(h)) !== undefined)) return false;
      const made = madeBy(h);
      return made === undefined || h.seq >= asked || landed.has(made) || followed.has(made);
    });
    /* Counted only below the last seq paged: what is at it cannot be judged until the page after it is read. */
    if (seen.filter((h) => h.seq < asked).length > UNCONFIRMED_AT_MOST) {
      return { reached: at, stop: { stop: 'not-given', seq: at.seq + 1, what: 'a header that reaches the head on chain' } };
    }
  }
}

/* ------------------------------------------------------------------ as the service keeps it */

/**
 * One node of the tree as the service keeps it, by its hash: two children's
 * hashes, or a subtree holding one leaf - that leaf's position and hash - so a
 * lone leaf costs one node, not one per level.
 */
export type TreeNode = { readonly l: Hex; readonly r: Hex } | { readonly key: Hex; readonly leaf: Hex };

/**
 * **WHAT THE SERVICE KEEPS OF A COMPANY'S TREE**, looked up rather than
 * rebuilt: the headers kept at each seq, the header making a root, every leaf
 * any header names by its hash, and every node of the tree at every root kept,
 * by its hash. A read reaches what it asks for from its root down; nothing is
 * replayed from the first header.
 */
export interface KeptTree {
  /** Every header kept at `seq`, in the order kept (more than one only where anchors raced). */
  readonly headersAt: (seq: number) => readonly TreeHeader[];
  /** The first header kept whose root is `root`. */
  readonly makingRoot: (root: Hex) => TreeHeader | undefined;
  readonly leaf: (hash: Hex) => TreeLeaf | undefined;
  readonly node: (hash: Hex) => TreeNode | undefined;
}

/** The leaves a header names - each change's prior and new leaf - by hash. */
export const leavesNamedBy = (h: TreeHeader): [Hex, TreeLeaf][] =>
  h.changes.flatMap((c) => [...(c.prior === null ? [] : [c.prior]), c.leaf]).map((l) => [leafHashOf(l), l]);

const emptyAt = (depth: number): Hex => EMPTY_HEX[TREE_HEIGHT - depth]!;
const EMPTY_HEX: readonly Hex[] = EMPTY.map((e) => toHex(e));

/** The hash at every depth of a subtree holding one leaf at `key`: index `d` is the node at depth `d`. */
const loneChain = (key: Hex, leaf: Hex): Hex[] => {
  const k = fromHex(key);
  const out: Uint8Array[] = new Array(TREE_HEIGHT + 1);
  out[TREE_HEIGHT] = fromHex(leaf);
  for (let d = TREE_HEIGHT - 1; d >= 0; d -= 1) {
    out[d] = bitAt(k, d) === 1 ? nodeOf(EMPTY[TREE_HEIGHT - 1 - d]!, out[d + 1]!) : nodeOf(out[d + 1]!, EMPTY[TREE_HEIGHT - 1 - d]!);
  }
  return out.map((x) => toHex(x));
};

/**
 * **A COMPANY'S TREE AS THE SERVICE KEEPS IT, GROWN ONE HEADER AT A TIME**
 * (`keep`): each header's changes are put into the tree at the root it follows,
 * which adds only the nodes along their paths and shares every other node with
 * the trees before it - so every root kept stays readable, and nothing is
 * rebuilt for a read.
 */
export class TreeKept implements KeptTree {
  private readonly bySeq: TreeHeader[][] = [];
  private readonly byRoot = new Map<Hex, TreeHeader>();
  private readonly leaves = new Map<Hex, TreeLeaf>();
  private readonly nodes = new Map<Hex, TreeNode>();
  private readonly all: TreeHeader[] = [];
  private readonly dirs = new Set<number>();
  /** The newest version any header kept anchors, per record (by its key in the tree). */
  private readonly newestLeaf = new Map<Hex, number>();
  /** The seqs at which more than one header is kept: anchors that raced. */
  private readonly raced = new Set<number>();

  constructor(headers: Iterable<TreeHeader> = []) { for (const h of headers) this.keep(h); }

  /** Every directory version a header kept here anchors, gathered as each is kept. */
  get directoryAnchored(): ReadonlySet<number> { return this.dirs; }

  /** Every header kept, in the order kept. */
  get headers(): readonly TreeHeader[] { return this.all; }

  headersAt = (seq: number): readonly TreeHeader[] => this.bySeq[seq] ?? [];
  makingRoot = (root: Hex): TreeHeader | undefined => this.byRoot.get(root);
  leaf = (hash: Hex): TreeLeaf | undefined => this.leaves.get(hash);
  node = (hash: Hex): TreeNode | undefined => this.nodes.get(hash);

  /** The newest version of the record at `key` any header kept here anchors; 0 for none. */
  anchoredVersion = (key: Hex): number => this.newestLeaf.get(key) ?? 0;

  /**
   * **THE RECORDS THAT MAY HAVE AN ENTRY WAITING AT `root`**, by their key in the
   * tree: `waiting` - every record with an entry newer than any header kept here
   * anchors - and every record a header after `root`'s seq changes, or a header
   * at a seq where anchors raced. Any other record's leaf at `root` is the newest
   * any header anchors, so no entry of it waits there. Null for a root no header
   * kept makes. Reads the headers after `root` and those that raced, never every
   * header or every entry.
   */
  openAt(root: Hex, waiting: Iterable<Hex>): Set<Hex> | null {
    const at = root === EMPTY_ROOT ? -1 : this.makingRoot(root)?.seq;
    if (at === undefined) return null;
    const open = new Set(waiting);
    const changed = (seq: number) => { for (const h of this.bySeq[seq] ?? []) for (const c of h.changes) open.add(treeKeyOf(c.leaf)); };
    for (let seq = at + 1; seq < this.bySeq.length; seq += 1) changed(seq);
    for (const seq of this.raced) if (seq <= at) changed(seq);
    return open;
  }

  /**
   * Keeps a header: its leaves, and the nodes its changes make from the root it
   * follows. Only a header that follows a root kept here (or the empty tree)
   * and whose changes make the root it names makes that root readable; any
   * other is kept as given, and no proof is read at its root. The service
   * refuses such a header before keeping it (`treeHeaderFilingRefusal`).
   */
  keep(h: TreeHeader): void {
    for (const [hash, l] of leavesNamedBy(h)) this.leaves.set(hash, l);
    for (const c of h.changes) if (c.leaf.store === 'directory') this.dirs.add(c.leaf.version);
    for (const c of h.changes) {
      const key = treeKeyOf(c.leaf);
      this.newestLeaf.set(key, Math.max(this.newestLeaf.get(key) ?? 0, c.leaf.version));
    }
    (this.bySeq[h.seq] ??= []).push(h);
    if (this.bySeq[h.seq]!.length > 1) this.raced.add(h.seq);
    this.all.push(h);
    let root = h.seq === 0 ? EMPTY_ROOT : h.previousRoot;
    if (this.byRoot.has(h.root) || (root !== EMPTY_ROOT && !this.byRoot.has(root))) return;
    for (const c of h.changes) root = this.put(0, root, treeKeyOf(c.leaf), leafHashOf(c.leaf));
    if (root === h.root) this.byRoot.set(h.root, h);
  }

  private lone(depth: number, key: Hex, leaf: Hex): Hex {
    const h = loneChain(key, leaf)[depth]!;
    this.nodes.set(h, { key, leaf });
    return h;
  }

  /** The hash of the subtree at `depth` whose hash is `at`, with the leaf at `key` set to `leaf`. */
  private put(depth: number, at: Hex, key: Hex, leaf: Hex): Hex {
    if (at === emptyAt(depth)) return this.lone(depth, key, leaf);
    const n = this.nodes.get(at);
    if (n === undefined) throw new Error('a node of a root kept here is missing');
    let l: Hex;
    let r: Hex;
    if ('key' in n) {
      if (n.key === key) return this.lone(depth, key, leaf);
      /* Two leaves under one node: the one there moves a level down, on its own side. */
      const down = this.lone(depth + 1, n.key, n.leaf);
      [l, r] = bitAt(fromHex(n.key), depth) === 1 ? [emptyAt(depth + 1), down] : [down, emptyAt(depth + 1)];
    } else {
      ({ l, r } = n);
    }
    if (bitAt(fromHex(key), depth) === 1) r = this.put(depth + 1, r, key, leaf); else l = this.put(depth + 1, l, key, leaf);
    const h = toHex(nodeOf(fromHex(l), fromHex(r)));
    this.nodes.set(h, { l, r });
    return h;
  }
}

/** The header this one follows, among those kept: one seq before it, its root this one's previous root. */
const parentIn = (kept: KeptTree, h: Pick<TreeHeader, 'seq' | 'previousRoot'>): TreeHeader | undefined =>
  kept.headersAt(h.seq - 1).find((x) => x.root === h.previousRoot);

/**
 * **WHY THE SERVICE DOES NOT KEEP THIS HEADER, OR NULL**: the checks it can make
 * without a key or the chain - it follows a header kept (or is a first one, from
 * the empty tree), its changes follow the leaves they replace, every entry it
 * names is entered and signed, and its roots are the ones its changes make.
 * Whose seat anchored it, and whether the chain holds it, are every device's to
 * judge; this keeps nothing a device must believe.
 */
export const treeHeaderFilingRefusal = (kept: KeptTree, entries: (id: Hex) => unknown, header: TreeHeader): string | null => {
  const parent = header.seq === 0 ? null : parentIn(kept, header);
  if (header.seq > 0 && parent === undefined) return 'it does not follow a header this service keeps';
  const before: CheckedHead = parent === null
    ? GENESIS
    : { seq: parent!.seq, head: header.kind === 'recovery' ? header.resumesFrom!.head : header.previous, root: parent!.root, dirVersion: parent!.dirVersion };
  const stop = transitionRefusal({
    company: header.company, before, header, entry: entries, priorChain: (hash) => kept.leaf(hash), seatOf: () => 'judged by each device',
  });
  if (stop === null) return null;
  return stop.stop === 'not-given' ? `it needs ${stop.what}, which this service does not hold` : stop.why;
};

/** Every older leaf of the records `ls` are the newest of, from the leaves kept, each once. */
const olderOf = (kept: KeptTree, ls: Iterable<TreeLeaf | null>, into = new Map<Hex, TreeLeaf>()): Map<Hex, TreeLeaf> => {
  for (const l of ls) {
    for (let p = l; p !== null && p.prior !== ZERO;) {
      const o = kept.leaf(p.prior);
      if (o === undefined || into.has(p.prior)) break;
      into.set(p.prior, o);
      p = o;
    }
  }
  return into;
};

/** **A PAGE OF HEADERS AFTER `seq`**, every one filed at each seq it covers, with the entries they name and their records' older leaves. */
export const headersPageOf = (kept: KeptTree, entries: (id: Hex) => unknown, seq: number, limit: number): HeadersPage => {
  const headers: TreeHeader[] = [];
  for (let s = seq + 1; s <= seq + Math.max(1, limit); s += 1) {
    const at = kept.headersAt(s);
    if (at.length === 0) break;
    headers.push(...at);
  }
  const named = new Map<Hex, unknown>();
  for (const h of headers) {
    for (const c of h.changes) {
      const e = entries(c.leaf.entryId);
      if (e !== undefined) named.set(c.leaf.entryId, e);
    }
  }
  const leaves = olderOf(kept, headers.flatMap((h) => h.changes.map((c) => c.prior)));
  return { headers, entries: [...named.values()], leaves: [...leaves.values()] };
};

/** What one read asks the service to prove against one root, in one request. */
export interface ProofsAsk {
  readonly root: Hex;
  readonly records: readonly RecordName[];
  readonly kinds: readonly KindAsked[];
}

/** **THE SERVICE'S ANSWER TO ONE READ**: each record's leaf (null for none), each kind's leaves, the older leaves of every record given, and one proof for all. */
export interface ProofsGiven {
  readonly records: readonly (TreeLeaf | null)[];
  readonly kinds: readonly (readonly TreeLeaf[])[];
  readonly older: readonly TreeLeaf[];
  readonly proof: TreeProof;
}

/** A subtree reached on the way down: its hash, and the lone leaf it holds when its node is one. */
interface Reached { readonly h: Hex; readonly lone?: { readonly key: Hex; readonly leaf: Hex; readonly chain: readonly Hex[] } }

/**
 * **THE PROOFS ONE READ ASKS FOR, READ DOWN FROM ITS ROOT**: every non-empty
 * node beside the paths asked, none inside a kind asked whole, and the leaves
 * at the positions asked; null for a root this service keeps no header making.
 */
export const proofsOf = (kept: KeptTree, ask: ProofsAsk): ProofsGiven | null => {
  if (ask.root !== EMPTY_ROOT && kept.makingRoot(ask.root) === undefined) return null;
  const kindKeys = ask.kinds.map((k) => fromHex(kindPrefixOf(k.store, k.kind).padEnd(64, '0')));
  const siblings: TreeSibling[] = [];
  const found = new Map<Hex, Hex>();
  const below = (depth: number, at: Reached): [Reached, Reached] => {
    const empty: Reached = { h: emptyAt(depth + 1) };
    if (at.h === emptyAt(depth)) return [empty, empty];
    let lone = at.lone;
    if (lone === undefined) {
      const n = kept.node(at.h);
      if (n === undefined) throw new Error('a node of a root kept here is missing');
      if (!('key' in n)) return [{ h: n.l }, { h: n.r }];
      lone = { key: n.key, leaf: n.leaf, chain: loneChain(n.key, n.leaf) };
    }
    const down: Reached = { h: lone.chain[depth + 1]!, lone };
    return bitAt(fromHex(lone.key), depth) === 1 ? [empty, down] : [down, empty];
  };
  const walk = (depth: number, prefix: Uint8Array, at: Reached, under: Uint8Array[]): void => {
    const kind = onAKind(depth, prefix, kindKeys);
    const isEmpty = at.h === emptyAt(depth);
    if (under.length === 0 && kind === null) {
      if (!isEmpty && depth > 0) siblings.push({ depth, path: toHex(prefix), hash: at.h });
      return;
    }
    if (depth === TREE_HEIGHT) {
      if (!isEmpty) found.set(toHex(prefix), at.h);
      return;
    }
    if (isEmpty && (kind === 'inside' || under.length === 0)) return;
    const [l, r] = below(depth, at);
    walk(depth + 1, prefix, l, under.filter((k) => bitAt(k, depth) === 0));
    walk(depth + 1, withBit(prefix, depth), r, under.filter((k) => bitAt(k, depth) === 1));
  };
  walk(0, new Uint8Array(32), { h: ask.root }, [...new Set(ask.records.map(treeKeyOf))].map((k) => fromHex(k)));
  const leafAt = (key: Hex): TreeLeaf | null => {
    const h = found.get(key);
    if (h === undefined) return null;
    const l = kept.leaf(h);
    if (l === undefined) throw new Error('a leaf of a root kept here is missing');
    return l;
  };
  const records = ask.records.map((r) => leafAt(treeKeyOf(r)));
  const kinds = ask.kinds.map((k) => {
    const p = kindPrefixOf(k.store, k.kind);
    return [...found.keys()].filter((key) => key.startsWith(p)).sort().map((key) => leafAt(key)!);
  });
  return { records, kinds, older: [...olderOf(kept, [...records, ...kinds.flat()]).values()], proof: { siblings } };
};

/**
 * **EVERY ENTRY NOT YET ANCHORED AT `root`**, of `entries`: each entry newer than
 * its record's leaf in the tree at that root, in the order entered; null for a
 * root this service keeps no header making. The service hands it only the
 * entries of the records open at that root (`TreeKept.openAt`). A device
 * believes none of it until it has checked each against the leaves it had proven.
 */
export const pendingAt = (kept: KeptTree, entries: readonly ManifestEntry[], root: Hex): ManifestEntry[] | null => {
  if (root !== EMPTY_ROOT && kept.makingRoot(root) === undefined) return null;
  const versions = new Map<Hex, number>();
  const versionAt = (key: Hex): number => {
    let v = versions.get(key);
    if (v === undefined) {
      const h = leafHashAt(kept, root, key);
      const l = h === null ? undefined : kept.leaf(h);
      if (h !== null && l === undefined) throw new Error('a leaf of a root kept here is missing');
      v = l?.version ?? 0;
      versions.set(key, v);
    }
    return v;
  };
  return entries.filter((e) => versionAt(treeKeyOf(e)) < e.version);
};

/** The hash of the leaf at `key` in the tree at `root`, looked up down from that root; null for an empty position. */
const leafHashAt = (kept: KeptTree, root: Hex, key: Hex): Hex | null => {
  const k = fromHex(key);
  let at = root;
  for (let depth = 0; depth < TREE_HEIGHT; depth += 1) {
    if (at === emptyAt(depth)) return null;
    const n = kept.node(at);
    if (n === undefined) throw new Error('a node of a root kept here is missing');
    if ('key' in n) return n.key === key ? n.leaf : null;
    at = bitAt(k, depth) === 1 ? n.r : n.l;
  }
  return at === emptyAt(TREE_HEIGHT) ? null : at;
};
