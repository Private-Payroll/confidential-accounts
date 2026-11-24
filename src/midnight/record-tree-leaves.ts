/** The company's records as one sparse Merkle tree: each record's leaf, where it sits, and the proofs of a root. */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonical, fromHex, toHex, utf8, type Hex } from '../core/crypto.js';
import { batchHoldersShapeRefusal, MANIFEST_STORES, recordKeyOf, type BatchHolders, type ManifestStore } from './record-manifest.js';

export const HEX64 = /^[0-9a-f]{64}$/u;
export const HEX128 = /^[0-9a-f]{128}$/u;

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
export const HEADER_DOMAIN = 'confidential-accounts/record-tree/header/v1';

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

export const isWhole = (n: unknown, from: number): n is number => Number.isSafeInteger(n) && (n as number) >= from;

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

export const heldOf = (h: BatchHolders) => ({ approvals: h.approvals, signerRoot: h.signerRoot, signers: [...h.signers] });
export const sameHeld = (a: BatchHolders, b: BatchHolders): boolean =>
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

export const nodeOf = (l: Uint8Array, r: Uint8Array): Uint8Array => {
  const b = new Uint8Array(65);
  b[0] = 1;
  b.set(l, 1);
  b.set(r, 33);
  return sha256(b);
};

/** The hash of an empty subtree of each height, from an empty leaf (`ZERO`) up. */
export const EMPTY: readonly Uint8Array[] = (() => {
  const out: Uint8Array[] = [new Uint8Array(32)];
  for (let h = 1; h <= TREE_HEIGHT; h += 1) out.push(nodeOf(out[h - 1]!, out[h - 1]!));
  return out;
})();

/** The root of a tree holding no record. */
export const EMPTY_ROOT: Hex = toHex(EMPTY[TREE_HEIGHT]!);

export const bitAt = (k: Uint8Array, d: number): number => (k[d >> 3]! >> (7 - (d & 7))) & 1;
export const withBit = (p: Uint8Array, d: number): Uint8Array => {
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
export const onAKind = (depth: number, prefix: Uint8Array, kinds: readonly Uint8Array[]): 'inside' | 'above' | null => {
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
