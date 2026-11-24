/** The tree as the service keeps it: its nodes by hash, the headers it was given, and the proofs and pages it answers. */
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import { type ManifestEntry } from './record-manifest.js';
import { EMPTY, EMPTY_ROOT, type KindAsked, type RecordName, TREE_HEIGHT, type TreeLeaf, type TreeProof, type TreeSibling, ZERO, bitAt, kindPrefixOf, leafHashOf, nodeOf, onAKind, treeKeyOf, withBit } from './record-tree-leaves.js';
import { type CheckedHead, GENESIS, type TreeHeader, transitionRefusal } from './record-tree-headers.js';
import { type HeadersPage } from './record-tree-checked-forward.js';

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
