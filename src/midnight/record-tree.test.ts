/**
 * **A COMPANY'S RECORDS ARE ONE TREE, AND EACH BATCH IS CHECKED AGAINST THE ONE BEFORE IT.**
 *
 * Every record's latest anchored version is one leaf of a sparse Merkle tree;
 * a batch's header names the root before it and after it, the changes it
 * makes and the proof that takes one root to the other. A device checks a
 * header against the one before it and stops in one of two ways: `not-given`,
 * when something the header needs was not given (the service's doing), and
 * `dishonest`, when the header was given whole and fails (the anchoring key's
 * doing). The one to read first is "A HEADER IS CHECKED AGAINST THE ONE BEFORE IT".
 */
import { tagInATest } from '../testing/record-tree-double.js';
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { directoryEntry, entryIdOf, signManifestEntry, type BatchHolders, type ManifestEntry, type ManifestEntryBody } from './record-manifest.js';
import {
  checkedAfter, checkForward, EMPTY_ROOT, GENESIS, kindListRefusal, kindPrefixOf, leafHashOf, nextTreeHeader, provenRefusal, signTreeHeader,
  SparseTree, transitionRefusal, transitionStopSaid, treeBatchOf, treeHeaderShapeRefusal, treeHeaderSigned, treeKeyOf, ZERO,
  headersPageOf, pendingAt, proofsOf, rootFrom, treeHeaderFilingRefusal, TreeKept, type CheckedHead, type KeptTree, type TreeHeader, type TreeLeaf,
  vouchedFreshOf, vouchedRefusal,
} from './record-tree.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex as bytesOfHex, toHex as hexOfBytes, utf8 } from '../core/crypto.js';
import { EMPTY_HEAD } from './record-manifest.js';

const COMPANY = 'acct_tree';
const A = newSigningKeypair();
const B = newSigningKeypair();
const STRANGER = newSigningKeypair();
const SEATS = new Map<Hex, string>([[A.publicKey, 'seat-a'], [B.publicKey, 'seat-b']]);
const HELD: BatchHolders = { approvals: 1, signerRoot: '0a'.repeat(32), signers: ['cd'.repeat(32)] };
const AT = '2026-10-10T00:00:00.000Z';

const person = (id: string, version: number, digest: string): ManifestEntryBody =>
  ({ store: 'company', kind: 'person', id, version, digest: digest.repeat(64 / digest.length) });
const entered = (e: ManifestEntryBody, by = A): ManifestEntry => signManifestEntry(COMPANY, e, by.secret);
/** A chain double: the head after a header is a hash of the head before it and the header's digest. */
const headOf = (previous: Hex, batch: Hex): Hex => leafHashOf({ store: 'run', kind: 'run', id: 'h', version: 1, digest: batch, filedBy: previous, entryId: ZERO, batch: 0, dirVersion: 0, prior: ZERO });

/** A service that keeps every header, entry and leaf, and a device that checks them, as the tree's two ends. */
const aCompany = () => {
  const tree = new SparseTree();
  const byHash = new Map<Hex, TreeLeaf>();
  const entries = new Map<Hex, ManifestEntry>();
  const current = new Map<Hex, TreeLeaf>();
  let head: CheckedHead = GENESIS;
  const headers: TreeHeader[] = [];
  /** Anchors `es` from the device of `by`, as an honest anchoring device builds the header. */
  const anchor = (es: readonly ManifestEntry[], by = A, held = HELD): TreeHeader => {
    for (const e of es) entries.set(entryIdOf(e), e);
    const keys = [...new Set(es.map((e) => treeKeyOf(e)))];
    const made = nextTreeHeader({
      company: COMPANY, before: head, entries: es,
      current: new Map(keys.map((k) => [k, current.get(k) ?? null])), proof: tree.proofFor({ keys }),
      priorChain: (h) => byHash.get(h), held, at: AT, tag: tagInATest(by.secret),
    }, by.secret);
    if (made === null) throw new Error('nothing to anchor');
    accept(made.header);
    return made.header;
  };
  const accept = (h: TreeHeader) => {
    for (const c of h.changes) {
      const k = treeKeyOf(c.leaf);
      current.set(k, c.leaf); byHash.set(leafHashOf(c.leaf), c.leaf); tree.set(k, leafHashOf(c.leaf));
    }
    head = checkedAfter(h, headOf(head.head, treeBatchOf(h)));
    headers.push(h);
    checked.push(head);
  };
  const checked: CheckedHead[] = [];
  return { tree, byHash, entries, current, headers, anchor, checkedAt: (i: number) => checked[i]!, get head() { return head; } };
};

const seatOf = (key: Hex) => SEATS.get(key) ?? null;
const check = (c: ReturnType<typeof aCompany>, before: CheckedHead, header: unknown, over: Partial<Parameters<typeof transitionRefusal>[0]> = {}) =>
  transitionRefusal({
    company: COMPANY, before, header,
    entry: (id) => c.entries.get(id), priorChain: (h) => c.byHash.get(h), seatOf: (k) => seatOf(k), ...over,
  });
/** Re-signs a header changed by `f`, so only what `f` changed is wrong. */
const resigned = (h: TreeHeader, f: (x: any) => void, by = A): TreeHeader => {
  const x = structuredClone(h) as any;
  f(x);
  const { anchoredBy: _drop, ...unsigned } = x;
  return signTreeHeader(unsigned, by.secret);
};

/** `resigned`, with the header's root made again from its new leaves: a header whose roots hold, false only where `f` makes it. */
const rerooted = (h: TreeHeader, f: (x: any) => void, by = A): TreeHeader => resigned(h, (x) => {
  f(x);
  const now = new Map<Hex, Hex>();
  for (const ch of x.changes) now.set(treeKeyOf(ch.leaf), leafHashOf(ch.leaf));
  x.root = rootFrom(now, x.proof)!;
}, by);

describe('WHERE A RECORD SITS IN THE TREE', () => {
  it('one kind shares its first eight bytes, so its whole list is one subtree; another kind or id sits elsewhere', () => {
    /* RED WHEN: a position is the id's hash alone - a kind's list is then no subtree. */
    const p1 = treeKeyOf({ store: 'run', kind: 'run', id: 'r1' });
    const p2 = treeKeyOf({ store: 'run', kind: 'run', id: 'r2' });
    const q = treeKeyOf({ store: 'proposal', kind: 'proposal', id: 'r1' });
    expect(p1.slice(0, 16)).toBe(kindPrefixOf('run', 'run'));
    expect(p2.slice(0, 16)).toBe(kindPrefixOf('run', 'run'));
    expect(p1).not.toBe(p2);
    expect(q.slice(0, 16)).not.toBe(p1.slice(0, 16));
    expect(p1).toMatch(/^[0-9a-f]{64}$/u);
  });
  it('an empty tree has the empty root, and a leaf changes it', () => {
    /* RED WHEN: emptying a position keeps its leaf. */
    const t = new SparseTree();
    expect(t.root()).toBe(EMPTY_ROOT);
    t.set(treeKeyOf({ store: 'run', kind: 'run', id: 'r1' }), 'ab'.repeat(32));
    expect(t.root()).not.toBe(EMPTY_ROOT);
    t.set(treeKeyOf({ store: 'run', kind: 'run', id: 'r1' }), null);
    expect(t.root()).toBe(EMPTY_ROOT);
  });
});

describe('ONE PROOF PER RECORD READ', () => {
  const c = aCompany();
  c.anchor([entered(person('p1', 1, 'a1')), entered(person('p2', 1, 'b2')), entered({ store: 'run', kind: 'run', id: 'r1', version: 1, digest: 'c3'.repeat(32) })]);
  const root = c.tree.root();
  const p1 = c.current.get(treeKeyOf(person('p1', 1, 'a1')))!;
  const absent = { store: 'company' as const, kind: 'person', id: 'nobody' };
  it('a leaf proves into the root, and so does an empty position for a record no batch holds', () => {
    /* RED WHEN: a proof's nodes are not used - every proof would make another root. */
    const proof = c.tree.proofFor({ keys: [treeKeyOf(p1), treeKeyOf(absent)] });
    expect(provenRefusal(root, { records: [{ name: p1, leaf: p1 }, { name: absent, leaf: null }] }, proof)).toBeNull();
  });
  it('a record said absent when its leaf is there, another leaf, or a sibling left out, does not prove', () => {
    /* RED WHEN: a leaf's hash leaves out its version - a stale version proves as the newest. */
    const proof = c.tree.proofFor({ keys: [treeKeyOf(p1)] });
    /* RED WHEN: an empty position is taken from the proof rather than computed - a record could be said absent. */
    expect(provenRefusal(root, { records: [{ name: p1, leaf: null }] }, proof)).toMatch(/make the root/u);
    expect(provenRefusal(root, { records: [{ name: p1, leaf: { ...p1, version: 2 } }] }, proof)).toMatch(/make the root/u);
    expect(provenRefusal(root, { records: [{ name: p1, leaf: p1 }] }, { siblings: proof.siblings.slice(1) })).toMatch(/make the root/u);
  });
  it('a leaf for another record than the one asked does not prove it', () => {
    /* RED WHEN: the leaf given is not checked to name the record asked. */
    const p2 = c.current.get(treeKeyOf(person('p2', 1, 'b2')))!;
    const proof = c.tree.proofFor({ keys: [treeKeyOf(p1)] });
    expect(provenRefusal(root, { records: [{ name: p1, leaf: p2 }] }, proof)).toMatch(/names another record/u);
  });
  it('a kind\'s whole list proves by its subtree, and a list missing one, or holding another kind, does not', () => {
    /* RED WHEN: a node inside the kind's subtree is taken from the proof, or a list of another kind is not refused. */
    const people = [...c.current.values()].filter((l) => l.kind === 'person');
    const proof = c.tree.proofFor({ keys: [], kinds: [{ store: 'company', kind: 'person' }] });
    expect(kindListRefusal(root, { store: 'company', kind: 'person' }, people, proof)).toBeNull();
    expect(kindListRefusal(root, { store: 'company', kind: 'person' }, people.slice(1), proof)).toMatch(/make the root/u);
    const run = [...c.current.values()].find((l) => l.kind === 'run')!;
    expect(kindListRefusal(root, { store: 'company', kind: 'person' }, [...people, run], proof)).toMatch(/another kind/u);
    /* RED WHEN: a node inside the kind's subtree is taken from the proof - the service could stand one in for a record it left out. */
    const p1Only = c.tree.proofFor({ keys: [treeKeyOf(p1)] });
    expect(kindListRefusal(root, { store: 'company', kind: 'person' }, [p1], p1Only)).toMatch(/make the root/u);
  });
  it('a kind with no records proves empty, and one said empty when it holds a record does not', () => {
    /* RED WHEN: an empty kind is taken from the proof rather than computed. */
    const proof = c.tree.proofFor({ keys: [], kinds: [{ store: 'proposal', kind: 'proposal' }] });
    expect(kindListRefusal(root, { store: 'proposal', kind: 'proposal' }, [], proof)).toBeNull();
    const runs = c.tree.proofFor({ keys: [], kinds: [{ store: 'run', kind: 'run' }] });
    expect(kindListRefusal(root, { store: 'run', kind: 'run' }, [], runs)).toMatch(/make the root/u);
  });
});

describe('A HEADER IS CHECKED AGAINST THE ONE BEFORE IT', () => {
  const c = aCompany();
  const h0 = c.anchor([entered(person('p1', 1, 'a1')), entered(person('p2', 1, 'b2'))]);
  const at0 = c.checkedAt(0);
  const h1 = c.anchor([entered(person('p1', 2, 'a2')), entered(person('p1', 3, 'a3'), B)], B);
  it('an honest first header and the one after it pass, the second holding two versions of one record in filing order', () => {
    /* RED WHEN: any check refuses an honest header (every mutation of the check leaves this green). */
    expect(check(c, GENESIS, h0)).toBeNull();
    expect(check(c, at0, h1)).toBeNull();
    expect(h1.changes[1]!.leaf.prior).toBe(leafHashOf(h1.changes[0]!.leaf));
    expect(treeHeaderSigned(h1)).toBe(true);
    expect(treeHeaderShapeRefusal(COMPANY, h1)).toBeNull();
  });
  it('the digest the head binds changes with anything in the header', () => {
    /* RED WHEN: the signed message leaves out a field. */
    expect(treeBatchOf(h1)).not.toBe(treeBatchOf(resigned(h1, (x) => { x.at = '2026-10-11T00:00:00.000Z'; }, B)));
    /* RED WHEN: the holders are outside what the anchoring seat signs - a service could swap other holders into its header. */
    expect(treeBatchOf(h1)).not.toBe(treeBatchOf(resigned(h1, (x) => { x.held = { ...x.held, approvals: 2 }; }, B)));
    /* RED WHEN: the anchoring key is outside the digest - the same changes anchored by another seat would make the same head. */
    expect(treeBatchOf(h1)).not.toBe(treeBatchOf(resigned(h1, () => undefined, A)));
  });
  it('a header not given, an entry not given, or an older leaf not given stops `not-given`, never naming a seat', () => {
    /* RED WHEN: a missing entry or older leaf is said `dishonest`, or the chain is not walked. */
    expect(check(c, at0, undefined)).toMatchObject({ stop: 'not-given', seq: 1 });
    expect(check(c, at0, h1, { entry: () => undefined })).toMatchObject({ stop: 'not-given', seq: 1 });
    const c2 = aCompany();
    const g0 = c2.anchor([entered(person('p1', 1, 'a1'))]);
    c2.anchor([entered(person('p1', 2, 'a2'))]);
    const g2 = c2.anchor([entered(person('p1', 3, 'a3'))]);
    expect(check(c2, c2.checkedAt(1), g2, { priorChain: () => undefined }))
      .toMatchObject({ stop: 'not-given', seq: 2 });
    expect(g0.seq).toBe(0);
  });
  it('a directory this device cannot read at the header\'s version stops `not-given`', () => {
    /* RED WHEN: a directory not given is said `dishonest`. */
    expect(check(c, at0, h1, { seatOf: () => undefined })).toMatchObject({ stop: 'not-given' });
  });
  it('a header given whole and failing stops `dishonest`, naming the key that signed it', () => {
    /* Each case is RED WHEN the check its words name is taken out: the header then passes, or fails for another reason. */
    const cases: [RegExp, TreeHeader][] = [
      [/follows batch/u, resigned(h1, (x) => { x.seq = 2; }, B)],
      [/not the root before it/u, resigned(h1, (x) => { x.previousRoot = 'ee'.repeat(32); }, B)],
      [/make the root it names/u, resigned(h1, (x) => { x.root = 'ee'.repeat(32); }, B)],
      [/does not name the leaf it replaces/u, resigned(h1, (x) => { x.changes[1].leaf.prior = ZERO; }, B)],
      [/name this batch/u, resigned(h1, (x) => { x.changes[0].leaf.batch = 7; }, B)],
      [/another directory version/u, resigned(h1, (x) => { x.dirVersion = 3; for (const ch of x.changes) ch.leaf.dirVersion = 3; }, B)],
      [/does not follow the one before it/u, resigned(h1, (x) => { x.changes[0].leaf.version = 1; }, B)],
      /* On the last change, so no later change's prior names the leaf changed: what the leaf says is read against its entry. */
      [/does not say what its entry says/u, rerooted(h1, (x) => { x.changes[1].leaf.digest = 'ff'.repeat(32); }, B)],
      [/does not say what its entry says/u, rerooted(h1, (x) => { x.changes[1].leaf.filedBy = A.publicKey; }, B)],
      [/second change to one record/u, resigned(h1, (x) => { x.changes[1].prior = x.changes[0].prior; }, B)],
      [/holds 0 changes/u, resigned(h1, (x) => { x.changes = []; }, B)],
    ];
    for (const [why, h] of cases) {
      expect(check(c, at0, h), String(why)).toMatchObject({ stop: 'dishonest', seq: 1, anchoredBy: B.publicKey, why: expect.stringMatching(why) });
    }
  });
  it('a leaf naming an entry its filer did not sign stops `dishonest`, though the leaf says what the entry says', () => {
    /* RED WHEN: the entry's own signature is not checked - a device would believe a filing forged in a seat's name. */
    const e3 = c.entries.get(h1.changes[1]!.leaf.entryId)!;
    const other = c.entries.get(h1.changes[0]!.leaf.entryId)!;
    const forged = { ...e3, filedBy: { publicKey: e3.filedBy.publicKey, signature: other.filedBy.signature } };
    const h = rerooted(h1, (x) => { x.changes[1].leaf.entryId = entryIdOf(forged); }, B);
    const entry = (id: Hex) => (id === entryIdOf(forged) ? forged : c.entries.get(id));
    expect(check(c, at0, h, { entry })).toMatchObject({ stop: 'dishonest', anchoredBy: B.publicKey, why: expect.stringMatching(/not signed by its filer/u) });
  });
  it('a header anchoring past a version never entered is honest, the gap on the prior chain; a version that does not rise is `dishonest`', () => {
    /* RED WHEN: the check requires a company, vault or directory version to follow its leaf by exactly one again. */
    const past = rerooted(h1, (x) => {
      const [two, three] = x.changes;
      x.changes = [{ prior: two.prior, leaf: { ...three.leaf, prior: leafHashOf(two.prior) } }];
    }, B);
    expect(past.changes[0]!.leaf.version).toBe(3);
    expect(past.changes[0]!.leaf.prior).toBe(leafHashOf(h0.changes[0]!.leaf));
    expect(check(c, at0, past)).toBeNull();
    /* RED WHEN: the check lets a version stay at, or fall below, the leaf it replaces. */
    const same = rerooted(h1, (x) => {
      const [two] = x.changes;
      x.changes = [{ prior: two.prior, leaf: { ...two.leaf, version: 1 } }];
    }, B);
    expect(check(c, at0, same)).toMatchObject({ stop: 'dishonest', why: expect.stringMatching(/does not follow the one before it/u) });
  });
  it('a header out of shape that the chain holds is the seat\'s, and one whose digest cannot be taken was not given', () => {
    /* RED WHEN: the header's own shape check is dropped, or blames the service for a field the seat signed and the head binds. */
    expect(treeHeaderShapeRefusal('acct_other', h1)).toBe('it is a header of another company');
    expect(treeHeaderShapeRefusal(COMPANY, { ...h1, held: undefined })).toBe('it does not name who held the account');
    expect(check(c, at0, resigned(h1, (x) => { x.at = 'not a time'; }, B)))
      .toMatchObject({ stop: 'dishonest', anchoredBy: B.publicKey, why: expect.stringMatching(/not one a seat may anchor/u) });
    expect(check(c, at0, { ...h1, held: undefined })).toMatchObject({ stop: 'not-given' });
  });
  it('a header whose own roots are false is `dishonest` even when the service also withholds its entries or the directory', () => {
    /* RED WHEN: what the service withholds is asked for before the header's own message is judged - its seat escapes blame. */
    const h = resigned(h1, (x) => { x.root = 'ee'.repeat(32); }, B);
    expect(check(c, at0, h, { entry: () => undefined })).toMatchObject({ stop: 'dishonest', anchoredBy: B.publicKey });
    expect(check(c, at0, h, { seatOf: () => undefined })).toMatchObject({ stop: 'dishonest', anchoredBy: B.publicKey });
  });
  it('a header of more than one batch\'s worth of changes stops `dishonest`', () => {
    /* RED WHEN: the upper bound on a batch's changes is taken out of the check. */
    const h = resigned(h1, (x) => { x.changes = Array.from({ length: 65 }, () => x.changes[0]); }, B);
    expect(check(c, at0, h)).toMatchObject({ stop: 'dishonest', why: expect.stringMatching(/holds 65 changes/u) });
  });
  it('a header whose transition fails is `dishonest` whatever its signature: it names the key only when the signature verifies', () => {
    /*
     * RED WHEN: the signature is judged before the transition (a failing one is then `not-given`, and a seat whose header
     * fails escapes blame by spoiling its own signature); or a failing signature still names the key (a seat can name
     * another seat's key, and nothing proves who signed).
     */
    const bad = resigned(h1, (x) => { x.previousRoot = 'ee'.repeat(32); }, B);
    expect(check(c, at0, bad)).toEqual({ stop: 'dishonest', seq: 1, anchoredBy: B.publicKey, why: expect.stringMatching(/not the root before it/u) });
    const unsigned = { ...bad, anchoredBy: { publicKey: B.publicKey, signature: h1.anchoredBy.signature } };
    expect(treeHeaderSigned(unsigned)).toBe(false);
    expect(check(c, at0, unsigned)).toEqual({ stop: 'dishonest', seq: 1, anchoredBy: null, why: expect.stringMatching(/not the root before it/u) });
    expect(transitionStopSaid(check(c, at0, unsigned)!)).toMatch(/signature does not verify, so which seat made it cannot be said/u);
    expect(transitionStopSaid(check(c, at0, unsigned)!)).not.toMatch(new RegExp(B.publicKey, 'u'));
  });
  it('a header whose transition holds and whose signature fails stops `not-given`: the service may have swapped it', () => {
    /* RED WHEN: a failing signature on an honest header is `dishonest` (blaming a seat for what the service can do), or is believed. */
    const swapped = { ...h1, anchoredBy: { ...h1.anchoredBy, signature: resigned(h1, (x) => { x.at = '2026-10-12T00:00:00.000Z'; }).anchoredBy.signature } };
    expect(treeHeaderSigned(swapped)).toBe(false);
    expect(check(c, at0, swapped)).toEqual({ stop: 'not-given', seq: 1, what: 'its header as its anchoring seat signed it' });
    expect(check(c, at0, { ...h1, at: '2026-10-12T00:00:00.000Z' })).toMatchObject({ stop: 'not-given', seq: 1 });
    expect(check(c, at0, h1)).toBeNull();
  });
  it('a header anchored by a key no seat holds, or holding a filing no seat may file, stops `dishonest`', () => {
    /* RED WHEN: the anchoring key, or a filing key, is not judged by the directory. */
    expect(check(c, at0, resigned(h1, () => {}, STRANGER))).toMatchObject({ stop: 'dishonest', anchoredBy: STRANGER.publicKey });
    const c3 = aCompany();
    c3.anchor([entered(person('p1', 1, 'a1'))]);
    const forged = c3.anchor([entered(person('p1', 2, 'a2'), STRANGER)]);
    expect(check(c3, c3.checkedAt(0), forged)).toMatchObject({ stop: 'dishonest', why: expect.stringMatching(/no seat that may file it/u) });
  });
  it('a header naming one seat\'s key and another seat\'s tag stops `dishonest`; a tag no seat\'s opening maps judges nothing', () => {
    const c = aCompany();
    const h = c.anchor([entered(person('p1', 1, 'a1'))]);
    const tagSeat = (t: Hex) => new Map([[tagInATest(A.secret), 'seat-a'], [tagInATest(B.secret), 'seat-b']]).get(t);
    expect(check(c, GENESIS, h, { tagSeat })).toBeNull();
    /* RED WHEN: a header's tag is not held to the seat its key names - one seat's anchors could be put down to another. */
    const other = resigned(h, (x) => { x.tag = tagInATest(B.secret); });
    expect(check(c, GENESIS, other, { tagSeat })).toMatchObject({ stop: 'dishonest', why: 'it names the key of one seat and was anchored by the call of another, whose tag it names' });
    /* RED WHEN: a tag no opening maps is taken for another seat's - a seat that has not filed its opening is never blamed for it. */
    expect(check(c, GENESIS, resigned(h, (x) => { x.tag = 'ee'.repeat(32); }), { tagSeat })).toBeNull();
  });
  it('a header holding three versions of one record is checked whole: the middle one is found among its own changes', () => {
    /* RED WHEN: the rolled-back check looks for a version this very header holds among the older leaves alone - an honest header is refused. */
    const c6 = aCompany();
    c6.anchor([entered(person('p1', 1, 'a1'))]);
    /* The older leaves a device is given: those the headers before this one name, and none of this one's own. */
    const before = new Map(c6.byHash);
    const h = c6.anchor([entered(person('p1', 2, 'a2')), entered(person('p1', 3, 'a3')), entered(person('p1', 4, 'a4'))]);
    expect(h.changes.map((x) => x.leaf.version)).toEqual([2, 3, 4]);
    expect(check(c6, c6.checkedAt(0), h, { priorChain: (x) => before.get(x) })).toBeNull();
  });
  it('a version naming the bytes of one before it is a record rolled back, and stops `dishonest`', () => {
    /* RED WHEN: the rolled-back check is taken out. */
    const c4 = aCompany();
    c4.anchor([entered(person('p1', 1, 'a1'))]);
    c4.anchor([entered(person('p1', 2, 'a2'))]);
    const before = c4.checkedAt(1);
    const leaf1 = c4.headers[0]!.changes[0]!.leaf;
    const back = entered(person('p1', 3, 'a1'));
    c4.entries.set(entryIdOf(back), back);
    const cur = c4.current.get(treeKeyOf(leaf1))!;
    const rolled = signTreeHeader({
      ...structuredClone(c4.headers[1]!), seq: 2, previous: before.head, previousRoot: c4.tree.root(),
      changes: [{ prior: cur, leaf: { ...cur, version: 3, digest: 'a1'.repeat(32), entryId: entryIdOf(back), batch: 2, prior: leafHashOf(cur) } }],
      proof: c4.tree.proofFor({ keys: [treeKeyOf(leaf1)] }),
      root: (() => { const t = new SparseTree(); for (const [k, l] of c4.current) t.set(k, leafHashOf(l)); t.set(treeKeyOf(leaf1), leafHashOf({ ...cur, version: 3, digest: 'a1'.repeat(32), entryId: entryIdOf(back), batch: 2, prior: leafHashOf(cur) })); return t.root(); })(),
    } as any, A.secret);
    expect(check(c4, before, rolled)).toMatchObject({ stop: 'dishonest', why: expect.stringMatching(/rolled back/u) });
  });
  it('a directory version\'s leaf carries the holders its header names, and one that does not stops `dishonest`', () => {
    /* RED WHEN: the directory leaf's holders are not set, or not checked equal to the header's. */
    const c5 = aCompany();
    const dir = signManifestEntry(COMPANY, directoryEntry({ version: 1 } as any), A.secret);
    const h = c5.anchor([dir]);
    expect(h.dirVersion).toBe(1);
    expect(h.changes[0]!.leaf.held).toEqual(HELD);
    expect(check(c5, GENESIS, h)).toBeNull();
    const other = resigned(h, (x) => { x.held = { ...HELD, approvals: 2 }; });
    expect(check(c5, GENESIS, other)).toMatchObject({ stop: 'dishonest', why: expect.stringMatching(/holders/u) });
  });
  it('the two stops are said in words that blame the service or the key, and say what resolves each', () => {
    /* RED WHEN: the words stop saying who is at fault or what resolves it. */
    expect(transitionStopSaid({ stop: 'not-given', seq: 4, what: 'its header' })).toMatch(/service.*withhold/u);
    expect(transitionStopSaid({ stop: 'dishonest', seq: 4, anchoredBy: STRANGER.publicKey, why: 'x' })).toMatch(new RegExp(STRANGER.publicKey.slice(0, 16), 'u'));
  });
});

describe('THE NEXT HEADER, AS AN ANCHORING DEVICE MAKES IT', () => {
  it('a version no newer than the leaf, or naming an older version\'s bytes, is left out; nothing left is no header', () => {
    /* RED WHEN: either the version check or the rolled-back check is taken out of the header maker. */
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1'))]);
    const key = treeKeyOf(person('p1', 1, 'a1'));
    const made = nextTreeHeader({
      company: COMPANY, before: c.head, entries: [entered(person('p1', 1, 'b9')), entered(person('p1', 2, 'a1'))],
      current: new Map([[key, c.current.get(key)!]]), proof: c.tree.proofFor({ keys: [key] }),
      priorChain: (h) => c.byHash.get(h), held: HELD, at: AT, tag: tagInATest(A.secret),
    }, A.secret);
    expect(made).toBeNull();
  });
  it('a company record\'s version past one never entered is anchored past it; given, the one between goes first; a run\'s need only rise', () => {
    /* RED WHEN: the header maker leaves a version past a gap waiting for good, which holds every later version unanchored. */
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1'))]);
    const key = treeKeyOf(person('p1', 1, 'a1'));
    const made = (es: readonly ManifestEntry[]) => nextTreeHeader({
      company: COMPANY, before: c.head, entries: es,
      current: new Map([[key, c.current.get(key)!]]), proof: c.tree.proofFor({ keys: [key] }),
      priorChain: (h) => c.byHash.get(h), held: HELD, at: AT, tag: tagInATest(A.secret),
    }, A.secret);
    const past = made([entered(person('p1', 3, 'a3'))])!;
    expect(past.header.changes.map((ch) => ch.leaf.version)).toEqual([3]);
    for (const e of [entered(person('p1', 3, 'a3'))]) c.entries.set(entryIdOf(e), e);
    expect(check(c, c.head, past.header)).toBeNull();
    /* RED WHEN: the header maker skips a version between whose entry it was given. */
    expect(made([entered(person('p1', 2, 'a2')), entered(person('p1', 3, 'a3'))])!.header.changes.map((ch) => ch.leaf.version)).toEqual([2, 3]);
    /* A run is kept whole and changed in place, so only its newest bytes can be entered: its version need only rise. */
    const run = (version: number, d: string): ManifestEntryBody => ({ store: 'run', kind: 'run', id: 'run_abcdefghijkl', version, digest: d.repeat(32) });
    c.anchor([entered(run(1, 'b1'))]);
    const rk = treeKeyOf(run(1, 'b1'));
    const r3 = entered(run(3, 'b3'));
    c.entries.set(entryIdOf(r3), r3);
    const runMade = nextTreeHeader({
      company: COMPANY, before: c.head, entries: [r3],
      current: new Map([[rk, c.current.get(rk)!]]), proof: c.tree.proofFor({ keys: [rk] }),
      priorChain: (h) => c.byHash.get(h), held: HELD, at: AT, tag: tagInATest(A.secret),
    }, A.secret)!;
    expect(runMade.header.changes.map((ch) => ch.leaf.version)).toEqual([3]);
    expect(check(c, c.head, runMade.header)).toBeNull();
  });
  it('refuses current leaves that do not make the root it follows', () => {
    /* RED WHEN: the header maker builds on leaves it did not check. */
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1'))]);
    const key = treeKeyOf(person('p1', 1, 'a1'));
    expect(() => nextTreeHeader({
      company: COMPANY, before: c.head, entries: [entered(person('p1', 2, 'a2'))],
      current: new Map([[key, null]]), proof: c.tree.proofFor({ keys: [key] }),
      priorChain: (h) => c.byHash.get(h), held: HELD, at: AT, tag: tagInATest(A.secret),
    }, A.secret)).toThrow(/do not make the root/u);
  });
  it('more than one batch\'s worth of changes is refused', () => {
    /* RED WHEN: a header may hold more than 64 changes. */
    const c = aCompany();
    const many = Array.from({ length: 65 }, (_, i) => entered(person(`p${i}`, 1, 'a1')));
    expect(() => c.anchor(many)).toThrow(/at most 64/u);
  });
});

/** The quorum's recovery from `from`, carried out while the chain held `chainHead`, anchoring `es` (none, by default). */
const recoveryFrom = (from: CheckedHead, chainHead: Hex, es: readonly ManifestEntry[], salt: Hex = '5a'.repeat(32), by = A): TreeHeader =>
  nextTreeHeader({
    company: COMPANY, before: from, entries: es, current: new Map(), proof: { siblings: [] }, priorChain: () => undefined,
    held: HELD, at: AT, tag: tagInATest(by.secret), recovery: { previous: chainHead, salt },
  }, by.secret)!.header;

describe('A RECOVERY RESUMES FROM A HEADER ITS APPROVERS CHECKED, PAST ONE NOBODY CAN CHECK', () => {
  it('the anchoring seat\'s tag, and a recovery\'s header and salt, are in the digest the head binds', () => {
    const c = aCompany();
    const h = c.anchor([entered(person('p1', 1, 'a1'))]);
    /* RED WHEN: the tag is left out of what the anchoring seat signs: a header could name another seat's tag and fold to the same head. */
    expect(treeBatchOf(resigned(h, (x) => { x.tag = 'ee'.repeat(32); }))).not.toBe(treeBatchOf(h));
    const rec = recoveryFrom(c.checkedAt(0), '77'.repeat(32), []);
    /* RED WHEN: where a recovery resumes, or its salt, is outside the digest: the head would not bind what its quorum approved. */
    expect(treeBatchOf(resigned(rec, (x) => { x.resumesFrom.head = 'ee'.repeat(32); }))).not.toBe(treeBatchOf(rec));
    expect(treeBatchOf(resigned(rec, (x) => { x.salt = 'ee'.repeat(32); }))).not.toBe(treeBatchOf(rec));
  });
  it('a header names its tag; a recovery names where it resumes and its salt and is the batch after it; an anchor names neither', () => {
    const c = aCompany();
    const h = c.anchor([entered(person('p1', 1, 'a1'))]);
    const rec = recoveryFrom(c.checkedAt(0), '77'.repeat(32), []);
    expect(treeHeaderShapeRefusal(COMPANY, rec)).toBeNull();
    /* RED WHEN: a header with no tag is one a seat may anchor. */
    expect(treeHeaderShapeRefusal(COMPANY, resigned(h, (x) => { delete x.tag; }))).toMatch(/tag of the seat/u);
    /* RED WHEN: a recovery that names no place it resumes from, or no salt, is read as one. */
    expect(treeHeaderShapeRefusal(COMPANY, resigned(rec, (x) => { delete x.resumesFrom; }))).toMatch(/batch it resumes from/u);
    expect(treeHeaderShapeRefusal(COMPANY, resigned(rec, (x) => { delete x.salt; }))).toMatch(/salt/u);
    expect(treeHeaderShapeRefusal(COMPANY, resigned(rec, (x) => { x.seq = 5; }))).toMatch(/the batch after the one it resumes from/u);
    /* RED WHEN: an anchor may carry a recovery's fields - a plain anchor read as one its quorum approved. */
    expect(treeHeaderShapeRefusal(COMPANY, resigned(h, (x) => { x.salt = '5a'.repeat(32); }))).toMatch(/resumes from/u);
  });
  it('is checked against the header it resumes from, whatever head the chain held; resuming from another, or a root it does not hold, is `dishonest`', () => {
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1'))]);
    c.anchor([entered(person('p2', 1, 'a2'))]);
    const rec = recoveryFrom(c.checkedAt(0), c.checkedAt(1).head, []);
    /* RED WHEN: a recovery is checked as an anchor, against the head before it - it never follows the header it resumes from. */
    expect(check(c, c.checkedAt(0), rec)).toBeNull();
    /* RED WHEN: a recovery claiming to resume from a header this device did not check is believed. */
    expect(check(c, c.checkedAt(1), resigned(rec, (x) => { x.seq = 2; x.resumesFrom = { ...c.checkedAt(1) }; delete x.resumesFrom.dirVersion; })))
      .toMatchObject({ stop: 'dishonest' });
    expect(check(c, c.checkedAt(0), resigned(rec, (x) => { x.resumesFrom.head = 'ee'.repeat(32); }))).toMatchObject({ stop: 'dishonest', why: 'it does not resume from the header before it' });
    /* RED WHEN: a recovery with no changes may name another root than the one it follows. */
    expect(check(c, c.checkedAt(0), resigned(rec, (x) => { x.root = 'ee'.repeat(32); })))
      .toMatchObject({ stop: 'dishonest', why: 'it holds no changes and names another root than the one it follows' });
    /* RED WHEN: an anchor may hold no changes, as a recovery may. */
    expect(check(c, c.checkedAt(0), resigned(rec, (x) => { x.kind = 'anchor'; delete x.resumesFrom; delete x.salt; x.previous = c.checkedAt(0).head; })))
      .toMatchObject({ stop: 'dishonest', why: 'it holds 0 changes, and a batch holds 1 to 64' });
  });
  it('a recovery may anchor what its device has waiting, checked as any header\'s changes', () => {
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1'))]);
    const e = entered(person('p3', 1, 'a3'));
    c.entries.set(entryIdOf(e), e);
    const k = treeKeyOf(e);
    const rec = nextTreeHeader({
      company: COMPANY, before: c.checkedAt(0), entries: [e], current: new Map([[k, null]]), proof: c.tree.proofFor({ keys: [k] }),
      priorChain: (h) => c.byHash.get(h), held: HELD, at: AT, tag: tagInATest(A.secret), recovery: { previous: '77'.repeat(32), salt: '5a'.repeat(32) },
    }, A.secret)!.header;
    /* RED WHEN: a recovery's changes are not proven from the root it resumes from. */
    expect(rec.changes).toHaveLength(1);
    expect(check(c, c.checkedAt(0), rec)).toBeNull();
  });
});

describe('CHECKED FORWARD FROM A HEAD, A PAGE AT A TIME', () => {
  const built = (n: number) => {
    const c = aCompany();
    const heads: Hex[] = [];
    let at: Hex = GENESIS.head;
    for (let i = 0; i < n; i += 1) {
      const h = c.anchor([entered(person(`p${i % 3}`, Math.floor(i / 3) + 1, (i + 16).toString(16).padStart(2, '0')))]);
      at = headOf(at, treeBatchOf(h));
      heads.push(at);
    }
    return { c, heads };
  };
  const forward = (c: ReturnType<typeof aCompany>, heads: readonly Hex[], over: Partial<Parameters<typeof checkForward>[0]> = {}) => {
    const kept: CheckedHead[] = [];
    const asked: number[] = [];
    const run = checkForward({
      company: COMPANY, from: GENESIS, landed: new Set(heads), chainHead: heads[heads.length - 1] ?? GENESIS.head,
      headersAfter: async (seq, limit) => { asked.push(seq); return { headers: c.headers.filter((h) => h.seq > seq).slice(0, limit), entries: [...c.entries.values()], leaves: [...c.byHash.values()] }; },
      headsOf: async (steps) => steps.map((s) => headOf(s.previous, s.batch)),
      seatOf: (k) => seatOf(k), keep: async (x) => { kept.push(x); }, pageSize: 2, ...over,
    });
    return { run, kept, asked };
  };
  it('reaches the head on chain, keeping every head it checked and asking a page at a time', async () => {
    /* RED WHEN: a head checked is not kept, or the pages asked for skip or repeat. */
    const { c, heads } = built(5);
    const { run, kept, asked } = forward(c, heads);
    const r = await run;
    expect(r.stop).toBeNull();
    expect(r.reached.head).toBe(heads[4]);
    expect(kept.map((k) => k.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(asked).toEqual([-1, 1, 3]);
  });
  it('carries on from a head it checked before, asking only for what follows it', async () => {
    /* RED WHEN: the check starts from the first batch whatever it was given. */
    const { c, heads } = built(5);
    const from = { ...checkedAfter(c.headers[2]!, heads[2]!) };
    const { run, kept, asked } = forward(c, heads, { from });
    expect((await run).reached.head).toBe(heads[4]);
    expect(kept.map((k) => k.seq)).toEqual([3, 4]);
    expect(asked[0]).toBe(2);
  });
  it('a header the chain holds and the service does not give stops `not-given` at it, keeping what was checked', async () => {
    /* RED WHEN: a page with nothing past a head is read as the end. */
    const { c, heads } = built(4);
    const { run, kept } = forward(c, heads, {
      headersAfter: async (seq, limit) => ({ headers: c.headers.filter((h) => h.seq > seq && h.seq !== 2).slice(0, limit), entries: [...c.entries.values()], leaves: [...c.byHash.values()] }),
    });
    const r = await run;
    expect(r.stop).toMatchObject({ stop: 'not-given', seq: 2 });
    expect(r.reached.seq).toBe(1);
    expect(kept.map((k) => k.seq)).toEqual([0, 1]);
  });
  it('headers that never reach a head the chain holds are not the chain\'s, and stop `not-given`, never `dishonest`', async () => {
    /* RED WHEN: headers are checked before they fold to a head the chain shows. */
    const { c, heads } = built(3);
    const { run } = forward(c, heads, { landed: new Set(['ab'.repeat(32)]), chainHead: 'ab'.repeat(32) });
    expect((await run).stop).toMatchObject({ stop: 'not-given', seq: 0 });
  });
  it('a header that loses a race to the same head is passed over for the one the chain holds', async () => {
    /* RED WHEN: only the first header at a seq is followed. */
    const { c, heads } = built(3);
    const loser = signTreeHeader({ ...structuredClone(c.headers[1]!), at: '2026-10-11T00:00:00.000Z' } as any, A.secret);
    const { run } = forward(c, heads, {
      headersAfter: async (seq, limit) => ({ headers: [loser, ...c.headers].filter((h) => h.seq > seq).sort((x, y) => x.seq - y.seq).slice(0, limit + 1), entries: [...c.entries.values()], leaves: [...c.byHash.values()] }),
    });
    const r = await run;
    expect(r.stop).toBeNull();
    expect(r.reached.head).toBe(heads[2]);
  });
  /** Every header kept at each seq a page covers, as the service serves a page: losers of a race beside the chain's. */
  const pagedWith = (c: ReturnType<typeof aCompany>, extra: readonly TreeHeader[]) => async (seq: number, limit: number) => ({
    headers: [...extra, ...c.headers].filter((h) => h.seq > seq && h.seq <= seq + limit).sort((x, y) => x.seq - y.seq),
    entries: [...c.entries.values()], leaves: [...c.byHash.values()],
  });
  it('a racing loser holding other records is passed over: every head kept is the chain\'s, with its own root', async () => {
    /* RED WHEN: the device keeps the loser's root, or checks the loser, at the seq they raced at. */
    const { c, heads } = built(3);
    const loser = rerooted(c.headers[1]!, (x) => { x.changes[0].leaf.digest = 'ee'.repeat(32); }, A);
    expect(loser.root).not.toBe(c.headers[1]!.root);
    const roots: Hex[] = [];
    const { run } = forward(c, heads, { keep: async (x) => { roots.push(x.root); }, headersAfter: pagedWith(c, [loser]) });
    const r = await run;
    expect(r.stop).toBeNull();
    expect(roots).toEqual(c.headers.map((h) => h.root));
  });
  it('more headers at one seq than a device holds unconfirmed do not stop it: those the chain never took are let go of', async () => {
    /* RED WHEN: the cap on headers held unconfirmed is counted before the chain's own header is found and the losers dropped. */
    const { c, heads } = built(3);
    const variants = Array.from({ length: 1100 }, (_, i) => resigned(c.headers[1]!, (x) => { x.at = new Date(Date.UTC(2026, 9, 11, 0, 0, i)).toISOString(); }, A));
    const { run } = forward(c, heads, { headersAfter: pagedWith(c, variants) });
    const r = await run;
    expect(r.stop).toBeNull();
    expect(r.reached.head).toBe(heads[2]);
    /* Two anchors in one block: the chain shows no head between them, so the variants are judged only once the next seq is read. */
    const oneBlock = forward(c, heads, { landed: new Set([heads[0]!, heads[2]!]), pageSize: 1, headersAfter: pagedWith(c, variants) });
    const b = await oneBlock.run;
    expect(b.stop).toBeNull();
    expect(b.reached.head).toBe(heads[2]);
    /* Three anchors in one block: the losers at the first are let go of once the seq after them is read and none follows them. */
    const four = built(4);
    const losers = Array.from({ length: 1100 }, (_, i) => resigned(four.c.headers[1]!, (x) => { x.at = new Date(Date.UTC(2026, 9, 11, 0, 0, i)).toISOString(); }, A));
    const threeInOne = forward(four.c, four.heads, { landed: new Set([four.heads[0]!, four.heads[3]!]), pageSize: 1, headersAfter: pagedWith(four.c, losers) });
    expect((await threeInOne.run).reached.head).toBe(four.heads[3]);
    /* Headers that follow no head this device can reach are let go of at once. */
    const orphans = Array.from({ length: 1100 }, (_, i) => resigned(four.c.headers[1]!, (x) => { x.previous = (i + 1).toString(16).padStart(64, '0'); }, A));
    const strays = forward(four.c, four.heads, { landed: new Set([four.heads[0]!, four.heads[3]!]), pageSize: 1, headersAfter: pagedWith(four.c, orphans) });
    expect((await strays.run).reached.head).toBe(four.heads[3]);
  });
  it('a dishonest header the chain holds stops `dishonest` there, after keeping every head before it', async () => {
    /* RED WHEN: a head is kept before its header passes. */
    const { c, heads } = built(3);
    const bad = resigned(c.headers[1]!, (x) => { x.changes[0].leaf.batch = 9; });
    const at1 = headOf(heads[0]!, treeBatchOf(bad));
    const { run, kept } = forward(c, [heads[0]!, at1], {
      chainHead: at1,
      headersAfter: async (seq) => ({ headers: [c.headers[0]!, bad].filter((h) => h.seq > seq), entries: [...c.entries.values()], leaves: [...c.byHash.values()] }),
    });
    const r = await run;
    expect(r.stop).toMatchObject({ stop: 'dishonest', seq: 1, anchoredBy: A.publicKey });
    expect(kept.map((k) => k.seq)).toEqual([0]);
  });
  it('A RECOVERY: A DEVICE STOPPED AT A DISHONEST HEADER FOLLOWS THE QUORUM\'S RECOVERY FROM THE HEADER BEFORE IT TO THE HEAD ON CHAIN', async () => {
    const { c, heads } = built(3);
    const bad = resigned(c.headers[1]!, (x) => { x.changes[0].leaf.batch = 9; });
    const at1 = headOf(heads[0]!, treeBatchOf(bad));
    /* The quorum recovers from the first header, past the dishonest second, carried out while the chain held its head. */
    const rec = recoveryFrom(c.checkedAt(0), at1, []);
    const atR = headOf(at1, treeBatchOf(rec));
    const pages = async (seq: number) => ({ headers: [c.headers[0]!, bad, rec].filter((h) => h.seq > seq), entries: [...c.entries.values()], leaves: [...c.byHash.values()] });
    const { run, kept } = forward(c, [heads[0]!, at1, atR], { chainHead: atR, headersAfter: pages });
    const r = await run;
    /* RED WHEN: a recovery is followed only from the head before it - every device stopped at the dishonest header stays stopped for good. */
    expect(r.stop).toBeNull();
    expect(r.reached).toEqual({ seq: 1, head: atR, root: c.checkedAt(0).root, dirVersion: c.checkedAt(0).dirVersion });
    /* RED WHEN: the dishonest header, landed before the recovery, is taken as the path to the head on chain. */
    expect(kept.map((k) => k.head)).toEqual([heads[0], atR]);
  });
  it('A RECOVERY RESUMING FROM A HEAD THIS DEVICE CHECKED BEFORE ITS LAST GIVES UP WHAT IT CHECKED SINCE, AND SAYS SO', async () => {
    const { c, heads } = built(3);
    /* This device checked all three; the quorum, whose devices could not check the third, recovers from the second. */
    const rec = recoveryFrom(c.checkedAt(1), heads[2]!, []);
    const atR = headOf(heads[2]!, treeBatchOf(rec));
    const pages = async (seq: number) => ({ headers: [...c.headers, rec].filter((h) => h.seq > seq), entries: [...c.entries.values()], leaves: [...c.byHash.values()] });
    const over = { from: c.checkedAt(2), chainHead: atR, headersAfter: pages };
    /* RED WHEN: a device with no record of the heads it checked follows a recovery from one it cannot vouch for. */
    expect((await forward(c, [...heads, atR], over).run).stop).toMatchObject({ stop: 'not-given' });
    const earlier = (h: Hex) => [c.checkedAt(0), c.checkedAt(1)].find((x) => x.head === h);
    const r = await forward(c, [...heads, atR], { ...over, earlier }).run;
    expect(r.stop).toBeNull();
    expect(r.reached.head).toBe(atR);
    /* RED WHEN: the batches a recovery gives up go back unsaid: the device says the quorum gave them up. */
    expect(r.recovered).toEqual({ resumedFrom: c.checkedAt(1), gaveUpTo: 2 });
  });
  it('nothing anchored is the empty head reached at once, asking nothing', async () => {
    /* RED WHEN: a device at the head on chain asks the service for headers. */
    const { c } = built(0);
    const { run, asked } = forward(c, []);
    expect((await run)).toEqual({ reached: GENESIS, stop: null });
    expect(asked).toEqual([]);
  });
});

describe('THE TREE AS THE SERVICE KEEPS IT', () => {
  const keptOf = (c: ReturnType<typeof aCompany>, extra: readonly TreeHeader[] = []): TreeKept => new TreeKept([...c.headers, ...extra]);
  /** `kept`, counting every header, node and leaf a read looks up. */
  const counted = (kept: KeptTree) => {
    const n = { headers: 0, seqs: [] as number[], nodes: 0, leaves: 0 };
    const view: KeptTree = {
      headersAt: (seq) => { n.headers += kept.headersAt(seq).length; n.seqs.push(seq); return kept.headersAt(seq); },
      makingRoot: (root) => kept.makingRoot(root),
      leaf: (h) => { n.leaves += 1; return kept.leaf(h); },
      node: (h) => { n.nodes += 1; return kept.node(h); },
    };
    return { view, n };
  };
  it('keeps a header that follows one it keeps, and refuses one that does not, or whose roots its changes do not make', () => {
    /* RED WHEN: the service keeps a header that follows nothing, or one needing an entry it does not hold. */
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1'))]);
    const h1 = c.anchor([entered(person('p1', 2, 'a2'))]);
    const kept = keptOf({ ...c, headers: [c.headers[0]!] } as any);
    expect(treeHeaderFilingRefusal(kept, (id) => c.entries.get(id), h1)).toBeNull();
    expect(treeHeaderFilingRefusal(new TreeKept(), (id) => c.entries.get(id), h1)).toMatch(/does not follow/u);
    expect(treeHeaderFilingRefusal(kept, (id) => c.entries.get(id), resigned(h1, (x) => { x.root = 'ee'.repeat(32); }))).toMatch(/root/u);
    expect(treeHeaderFilingRefusal(kept, () => undefined, h1)).toMatch(/does not hold/u);
    /* RED WHEN: a header kept from stored data whose changes do not make the root it names makes that root readable. */
    const forged = resigned(h1, (x) => { x.root = 'ee'.repeat(32); });
    expect(new TreeKept([c.headers[0]!, forged]).makingRoot('ee'.repeat(32))).toBeUndefined();
    expect(new TreeKept([c.headers[0]!, h1]).makingRoot(h1.root)).toEqual(h1);
  });
  it('serves a page of headers with their entries and older leaves, and every header filed at a seq it covers', () => {
    /* RED WHEN: a page drops the last seq it covers, its entries, or its older leaves. */
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1'))]);
    c.anchor([entered(person('p1', 2, 'a2'))]);
    c.anchor([entered(person('p1', 3, 'a3'))]);
    const twin = resigned(c.headers[1]!, (x) => { x.at = '2026-10-11T00:00:00.000Z'; });
    const page = headersPageOf(keptOf(c, [twin]), (id) => c.entries.get(id), 0, 2);
    expect(page.headers.map((h: any) => h.seq)).toEqual([1, 1, 2]);
    expect(page.entries).toHaveLength(2);
    expect((page.leaves as TreeLeaf[]).map((l) => l.version)).toEqual([1]);
  });
  it('proves any records and kinds against any root it keeps, in one answer a device checks', () => {
    /* RED WHEN: the older leaves are not served, or an unknown root is proven against another. */
    const c = aCompany();
    c.anchor([entered(person('p1', 1, 'a1')), entered({ store: 'run', kind: 'run', id: 'r1', version: 1, digest: 'c3'.repeat(32) })]);
    const r0 = c.tree.root();
    c.anchor([entered(person('p1', 2, 'a2'))]);
    const kept = keptOf(c);
    const asked = { root: r0, records: [{ store: 'company' as const, kind: 'person', id: 'p1' }, { store: 'company' as const, kind: 'person', id: 'p9' }], kinds: [{ store: 'run' as const, kind: 'run' }] };
    const given = proofsOf(kept, asked)!;
    expect(given.records[0]!.version).toBe(1);
    expect(given.records[1]).toBeNull();
    expect(provenRefusal(r0, { records: asked.records.map((name, i) => ({ name, leaf: given.records[i]! })), kinds: [{ kind: asked.kinds[0]!, leaves: given.kinds[0]! }] }, given.proof)).toBeNull();
    const now = proofsOf(kept, { ...asked, root: c.tree.root() })!;
    expect(now.records[0]!.version).toBe(2);
    expect(now.older.map((l) => l.version)).toEqual([1]);
    expect(proofsOf(kept, { ...asked, root: 'ee'.repeat(32) })).toBeNull();
  });
  it('reads a page of headers and one read\'s proofs without walking the history: the nodes are kept as headers are', () => {
    /*
     * RED WHEN: proofs are made by replaying the headers from the first (the tree rebuilt per request), or a page reads
     * every header kept rather than the seqs it covers; or the nodes kept prove other than the tree they stand for.
     */
    const c = aCompany();
    for (let i = 1; i <= 120; i += 1) c.anchor([entered(person(`p${i % 40}`, Math.ceil(i / 40), (i % 250).toString(16).padStart(2, '0')))]);
    const kept = keptOf(c);
    const asked = { root: c.headers[100]!.root, records: [{ store: 'company' as const, kind: 'person', id: 'p7' }], kinds: [] };
    const { view, n } = counted(kept);
    const given = proofsOf(view, asked)!;
    expect(n.headers).toBe(0);
    /* One path down: the kind's 64 shared bits and about log2(40) more, and the leaf and its older versions - not the 120 headers. */
    expect(n.nodes).toBeLessThan(64 + 16);
    expect(n.leaves).toBeLessThan(5);
    expect(provenRefusal(asked.root, { records: [{ name: asked.records[0]!, leaf: given.records[0]! }] }, given.proof)).toBeNull();
    /* The same proof the whole tree at that root would give. */
    const whole = new SparseTree();
    for (const h of c.headers.slice(0, 101)) for (const ch of h.changes) whole.set(treeKeyOf(ch.leaf), leafHashOf(ch.leaf));
    expect(given.proof).toEqual(whole.proofFor({ keys: [treeKeyOf(asked.records[0]!)] }));
    const page = counted(kept);
    expect(headersPageOf(page.view, (id) => c.entries.get(id), 110, 3).headers.map((h) => (h as TreeHeader).seq)).toEqual([111, 112, 113]);
    expect(page.n.seqs).toEqual([111, 112, 113]);
    expect(page.n.nodes).toBe(0);
    /* RED WHEN: a kind's whole list is not the one the whole tree at that root proves, or is read by walking the headers. */
    const kinds = counted(kept);
    const list = proofsOf(kinds.view, { root: asked.root, records: [], kinds: [{ store: 'company', kind: 'person' }] })!;
    expect(kinds.n.headers).toBe(0);
    expect(list.kinds[0]).toHaveLength(40);
    expect(list.proof).toEqual(whole.proofFor({ keys: [], kinds: [{ store: 'company', kind: 'person' }] }));
    /* RED WHEN: the entries waiting at a root are found by walking the headers, or against another root's leaves. */
    const waiting = counted(kept);
    const later = [...c.entries.values()].filter((e) => e.id === 'p7');
    expect(pendingAt(waiting.view, later, c.headers[50]!.root)!.map((e) => e.version)).toEqual([3]);
    expect(waiting.n.headers).toBe(0);
    expect(waiting.n.nodes).toBeLessThan(64 + 16);
  });
});

describe('A RUN\'S FRESH HALF IS MADE FROM THE HEAD ITS RAISER CHECKED, AND A RANDOM VALUE', () => {
  const HEAD = '1a'.repeat(32) as Hex;
  const R = '2b'.repeat(32) as Hex;

  it('is SHA-256 over its own domain, the head and the value, so the id every signer approves binds the head', () => {
    const expected = hexOfBytes(sha256(new Uint8Array([
      ...utf8('confidential-accounts/record-tree/vouched-fresh/v1'), ...bytesOfHex(HEAD), ...bytesOfHex(R)])));
    expect(vouchedFreshOf(HEAD, R)).toBe(expected);
    expect(vouchedFreshOf(HEAD.toUpperCase() as Hex, R)).toBe(expected);
  });

  it('changes with the head and with the value', () => {
    expect(vouchedFreshOf('1c'.repeat(32) as Hex, R)).not.toBe(vouchedFreshOf(HEAD, R));
    expect(vouchedFreshOf(HEAD, '2d'.repeat(32) as Hex)).not.toBe(vouchedFreshOf(HEAD, R));
  });

  it('is refused for a head or a value that is not thirty-two bytes, and for the empty head, which vouches for nothing', () => {
    expect(vouchedRefusal({ head: HEAD, r: R })).toBeNull();
    expect(vouchedRefusal({ head: HEAD.slice(2), r: R })).not.toBeNull();
    expect(vouchedRefusal({ head: HEAD, r: 'zz'.repeat(32) })).not.toBeNull();
    expect(vouchedRefusal({ head: EMPTY_HEAD, r: R })).not.toBeNull();
    expect(vouchedRefusal(undefined)).not.toBeNull();
  });
});
