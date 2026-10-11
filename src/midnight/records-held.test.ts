/**
 * **WHAT ONE READ BELIEVES OF A COMPANY'S RECORDS**, judged on its own: a record
 * the read did not ask for is never believed; the versions a leaf's prior chain
 * gives are read oldest first, and a chain cut short is no chain; a kind is
 * listed only when it was asked whole; and each record read is anchored, older,
 * other bytes, past a stop, not yet anchored or not entered, as what the read
 * holds says.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, signingPublicKeyOf, type Hex } from '../core/crypto.js';
import { recordKeyOf, signManifestEntry, type ManifestEntry } from './record-manifest.js';
import { GENESIS, leafHashOf, ZERO, type TreeLeaf } from './record-tree.js';
import {
  askedFor, DIRECTORY, directoryVersionsOf, FOUNDING_RECORDS, heldStandingOf, kindKeyOf, namedIn, neverEnteredIn, newestAnchored, recordsProvenFor, versionsOf,
  type HeldVersion, type RecordsHeld,
} from './records-held.js';

const CO = 'acct_held';
const A = newSigningKeypair();
const B = newSigningKeypair();
const HELD = { approvals: 1, signerRoot: 'ab'.repeat(32) as Hex, signers: ['cd'.repeat(32) as Hex] };
const leaf = (id: string, version: number, digest: string, prior: Hex = ZERO, store: 'company' | 'directory' = 'company'): TreeLeaf => ({
  store, kind: store === 'directory' ? 'directory' : 'person', id, version, digest: digest.repeat(32) as Hex, filedBy: signingPublicKeyOf(A.secret),
  entryId: 'e0'.repeat(32) as Hex, batch: version - 1, dirVersion: 0, prior, ...(store === 'directory' ? { held: HELD } : {}),
});
const v1 = leaf('p1', 1, 'a1');
const v2 = leaf('p1', 2, 'a2', leafHashOf(v1));
const v3 = leaf('p1', 3, 'a3', leafHashOf(v2));
const byHash = new Map([v1, v2, v3].map((l) => [leafHashOf(l), l] as const));
const entered = (id: string, version: number, digest: string, by = A): ManifestEntry =>
  signManifestEntry(CO, { store: 'company', kind: 'person', id, version, digest: digest.repeat(32) as Hex }, by.secret);
const read = (id: string, version: number | undefined, digest: string) => ({ store: 'company' as const, kind: 'person', id, digest: digest.repeat(32) as Hex, version });

/** What a read holds that asked for `records` and `kinds`: p1 anchored at v3, and v4 entered after it. */
const holding = (o: Partial<RecordsHeld> & { records?: readonly string[]; kinds?: readonly string[] } = {}): RecordsHeld => ({
  head: 'aa'.repeat(32) as Hex, reached: GENESIS, stopped: null,
  asked: { records: new Set(o.records ?? [recordKeyOf(read('p1', 1, 'a1'))]), kinds: new Set(o.kinds ?? []) },
  history: new Map([[recordKeyOf(v3), versionsOf(v3, (h) => byHash.get(h))!]]),
  notYetAnchored: [entered('p1', 4, 'a4')], directory: new Map(), ...o,
});

describe('WHAT A READ ASKED, AND NOTHING ELSE', () => {
  it('a record the read did not ask for, by name or by its kind, is never believed', () => {
    /* RED WHEN: the asked check is taken out - a record no proof covered would be judged against nothing and read as not entered. */
    expect(heldStandingOf(holding(), read('p2', 1, 'b1')).standing).toBe('not-asked');
    expect(heldStandingOf(holding({ records: [], kinds: [kindKeyOf({ store: 'company', kind: 'person' })] }), read('p2', 1, 'b1')).standing).toBe('not-entered');
    expect(askedFor(holding(), read('p1', 1, 'a1'))).toBe(true);
    expect(askedFor(holding(), read('p2', 1, 'a1'))).toBe(false);
  });
  it('the directory is always proven, and the founding records only when founding is asked', () => {
    /* RED WHEN: a read is proven without the directory its seats are judged by, or founding records it did not ask for are proven. */
    expect(recordsProvenFor({}).map(recordKeyOf)).toEqual([recordKeyOf(DIRECTORY)]);
    expect(recordsProvenFor({ founding: true }).map(recordKeyOf)).toEqual([DIRECTORY, ...FOUNDING_RECORDS].map(recordKeyOf));
    expect(recordsProvenFor({ records: [DIRECTORY, { store: 'run', kind: 'run', id: 'r1' }] }).map(recordKeyOf)).toEqual([recordKeyOf(DIRECTORY), 'run:run:r1']);
  });
  it('a kind is listed only when the read asked for it whole: its anchored ids and those entered after', () => {
    const k = { store: 'company' as const, kind: 'person' };
    /* RED WHEN: a list is made of a kind no subtree proof covered - a record left out of the list would never be missed. */
    expect(() => namedIn(holding(), k)).toThrow(/did not ask for every company record of kind person/u);
    const asked = holding({ kinds: [kindKeyOf(k)], notYetAnchored: [entered('p9', 1, 'c1')] });
    expect([...namedIn(asked, k)].sort()).toEqual(['p1', 'p9']);
  });
});

describe('A RECORD\'S VERSIONS, FROM ITS LEAF AND ITS PRIOR CHAIN', () => {
  it('reads every version oldest first, and a chain with a version missing is no chain', () => {
    /* RED WHEN: the versions come newest first, or a chain cut short is read as the versions it reached. */
    expect((versionsOf(v3, (h) => byHash.get(h)) as HeldVersion[]).map((x) => x.version)).toEqual([1, 2, 3]);
    expect(versionsOf(v3, (h) => (h === leafHashOf(v1) ? undefined : byHash.get(h)))).toBeNull();
    expect(newestAnchored(holding(), read('p1', 1, 'a1'))).toBe(3);
    expect(newestAnchored(holding(), read('p2', 1, 'a1'))).toBe(0);
  });
  it('reads every directory version with who held the account as its batch was judged, and refuses one naming no holders', () => {
    const d1 = leaf('directory', 1, 'd1', ZERO, 'directory');
    const d2 = leaf('directory', 2, 'd2', leafHashOf(d1), 'directory');
    const both = new Map([d1, d2].map((l) => [leafHashOf(l), l] as const));
    /* RED WHEN: a directory version is read without the holders it is counted against, or a version missing is passed over. */
    expect([...directoryVersionsOf(d2, (h) => both.get(h))!.entries()]).toEqual([[2, { digest: d2.digest, batch: 1, held: HELD }], [1, { digest: d1.digest, batch: 0, held: HELD }]]);
    expect(directoryVersionsOf(d2, () => undefined)).toBeNull();
    const { held: _gone, ...noHolders } = d2;
    expect(directoryVersionsOf(noHolders as TreeLeaf, (h) => both.get(h))).toBeNull();
  });
});

describe('ONE RECORD READ, AGAINST WHAT THE READ HOLDS', () => {
  const by = signingPublicKeyOf(A.secret);
  it('the newest anchored, an older one, other bytes at an anchored version, and another filer\'s are told apart', () => {
    /* Each RED WHEN the line's own case is taken out: the record then reads as another standing. */
    expect(heldStandingOf(holding(), read('p1', 3, 'a3'), by)).toEqual({ standing: 'anchored', version: 3, newest: 4 });
    expect(heldStandingOf(holding(), read('p1', 2, 'a2'), by).standing).toBe('older-than-anchored');
    expect(heldStandingOf(holding(), read('p1', 3, 'ff'), by).standing).toBe('not-the-anchored-bytes');
    expect(heldStandingOf(holding(), read('p1', 1, 'ff'), by).standing).toBe('older-than-anchored');
    expect(heldStandingOf(holding(), read('p1', 3, 'a3'), signingPublicKeyOf(B.secret)).standing).toBe('not-the-filers-entry');
  });
  it('newer than every leaf: not yet anchored when entered by its own filer, not entered otherwise, and past a stop when a header was not checked', () => {
    expect(heldStandingOf(holding(), read('p1', 4, 'a4'), by)).toEqual({ standing: 'not-yet-anchored', version: 4, newest: 4 });
    /* RED WHEN: an entry another key signed counts for a record whose own signature is this filer's. */
    expect(heldStandingOf(holding(), read('p1', 4, 'a4'), signingPublicKeyOf(B.secret)).standing).toBe('not-the-filers-entry');
    expect(heldStandingOf(holding(), read('p1', 5, 'a5'), by).standing).toBe('not-entered');
    /* RED WHEN: a version past a header this device could not check is read as not entered - the header may hold it. */
    expect(heldStandingOf(holding({ stopped: { stop: 'not-given', seq: 3, what: 'its header' } }), read('p1', 5, 'a5'), by).standing).toBe('past-a-stop');
  });
});

describe('A VERSION NEVER ENTERED: ANCHORED PAST, SHOWN AS SUCH, NEVER BELIEVED', () => {
  /* p1 anchored at versions 1 and 3: the header that anchored version 3 passed over version 2, whose entry was never entered. */
  const past = leaf('p1', 3, 'a3', leafHashOf(v1));
  const chain = new Map([v1, past].map((l) => [leafHashOf(l), l] as const));
  const gapped = (o: Partial<RecordsHeld> = {}) => holding({ history: new Map([[recordKeyOf(past), versionsOf(past, (h) => chain.get(h))!]]), notYetAnchored: [], ...o });
  it('names every version a record\'s prior chain passes over, from the first, in a store whose every version is read back', () => {
    /* RED WHEN: the versions passed over are left unsaid, so a list of versions would skip one silently. */
    expect(neverEnteredIn(gapped(), read('p1', 1, 'a1'))).toEqual([2]);
    expect(neverEnteredIn(holding(), read('p1', 1, 'a1'))).toEqual([]);
    /* RED WHEN: a run's versions, which only rise because it is kept whole, are said to have been passed over. */
    const run = { store: 'run' as const, kind: 'run', id: 'r1' };
    const r3 = { ...past, ...run, prior: ZERO };
    expect(neverEnteredIn({ history: new Map([[recordKeyOf(run), versionsOf(r3, () => undefined)!]]) }, run)).toEqual([]);
  });
  it('a version read at a gap is never entered: not believed, and not said to be stale or other bytes', () => {
    /* RED WHEN: heldStandingOf reads a version the anchor passed over as an older version served stale. */
    expect(heldStandingOf(gapped(), read('p1', 2, 'a2')).standing).toBe('never-entered');
    expect(heldStandingOf(gapped(), read('p1', 2, 'a2')).version).toBeNull();
    /* RED WHEN: a version on either side of the gap stops reading as the anchor holds it. */
    expect(heldStandingOf(gapped(), read('p1', 1, 'a1')).standing).toBe('older-than-anchored');
    expect(heldStandingOf(gapped(), read('p1', 3, 'a3')).standing).toBe('anchored');
    /* An entry of the passed-over version, entered after a later one was anchored, is below the leaf: never not-yet-anchored. */
    expect(heldStandingOf(gapped({ notYetAnchored: [entered('p1', 2, 'a2')] }), read('p1', 2, 'a2')).standing).toBe('never-entered');
  });
});
