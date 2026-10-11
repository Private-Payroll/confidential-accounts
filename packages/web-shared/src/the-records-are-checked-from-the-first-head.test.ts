/**
 * **THE FULL CHECK: EVERY HEADER OF A COMPANY'S RECORDS FROM THE FIRST, CHECKED
 * ONCE PER DEVICE, KEEPING ONLY THE HEADS.**
 *
 * A device checks every batch's header against the one before it, from the
 * company's first, up to the head the account's history shows at the indexer
 * the person's own wallet names. It keeps the heads it checked - and the last
 * one checked from the first - in its own storage, never the headers, so a
 * check cut short carries on from where it stopped. The one to read first is
 * "A CHECK CUT SHORT CARRIES ON FROM THE LAST HEAD IT CHECKED".
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, type Hex } from '../../../src/core/crypto.js';
import { entryIdOf, signManifestEntry, type ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import { GENESIS, signTreeHeader, type TreeHeader } from '../../../src/midnight/record-tree.js';
import { aTreeCompany, HELD_IN_A_TEST, headsByTheAccount, tagInATest } from '../../../src/testing/record-tree-double.js';
import { IDBFactory } from 'fake-indexeddb';
import { fullCheckHere, treeHeaderHere, type FullCheckDoors } from './records-anchored-here.js';
import { checkedHeadsInMemory, treeKeptHere, type CheckedHeads, type CheckedHeadsStore, type KeptHeader } from './tree-kept-here.js';
import type { TreeService } from './record-entered-here.js';

const COMPANY = 'acct_full_check';
const A = newSigningKeypair();
const seats = new Map<Hex, string>([[A.publicKey, 'seat-a']]);
const person = (id: string, version: number, digest: string): ManifestEntryBody =>
  ({ store: 'company', kind: 'person', id, version, digest: digest.repeat(32) });

const aCompanyOf = async (n: number) => {
  const c = aTreeCompany(COMPANY);
  for (let i = 0; i < n; i += 1) {
    await c.anchor([signManifestEntry(COMPANY, person(`p${i % 2}`, Math.floor(i / 2) + 1, (16 + i).toString(16)), A.secret)], A.secret);
  }
  return c;
};
const doorsOf = (c: Awaited<ReturnType<typeof aCompanyOf>>, checked: CheckedHeadsStore, tree: TreeService = c.service): FullCheckDoors => ({
  accountId: COMPANY, tree, onChain: c.onChain, headsOf: headsByTheAccount, seatOf: (k: Hex) => seats.get(k) ?? null, checked, pageSize: 2,
});

describe('THE FULL CHECK', () => {
  it('checks every header from the first to the head on chain, keeping each head and the last one checked from the first', async () => {
    const c = await aCompanyOf(5);
    const checked = checkedHeadsInMemory();
    const r = await fullCheckHere(doorsOf(c, checked));
    /* RED WHEN: the check stops short of the head the chain holds, or says it stopped. */
    expect(r.stop).toBeNull();
    expect(r.reached.head).toBe(c.head.head);
    const kept = (await checked.read(COMPANY))!;
    /* RED WHEN: a head checked is not kept, or the last one checked from the first is not the head reached. */
    expect(kept.heads).toEqual(c.landed.map((l) => l.head));
    expect(kept.fromZero).toEqual(c.head);
    expect(kept.latest).toEqual(c.head);
  });

  it('A CHECK CUT SHORT CARRIES ON FROM THE LAST HEAD IT CHECKED, asking the service for nothing before it', async () => {
    const c = await aCompanyOf(5);
    const checked = checkedHeadsInMemory();
    const asked: number[] = [];
    const withholding: TreeService = {
      ...c.service,
      headersAfter: async (company, seq, limit) => {
        asked.push(seq);
        const p = await c.service.headersAfter(company, seq, limit);
        return { ...p, headers: p.headers.filter((h) => (h as TreeHeader).seq !== 3) };
      },
    };
    const cut = await fullCheckHere(doorsOf(c, checked, withholding));
    /* RED WHEN: a header the service withholds is not stopped at as `not-given`. */
    expect(cut.stop).toMatchObject({ stop: 'not-given', seq: 3 });
    expect((await checked.read(COMPANY))!.fromZero!.seq).toBe(2);
    asked.length = 0;
    const counting: TreeService = { ...c.service, headersAfter: async (company, seq, limit) => { asked.push(seq); return c.service.headersAfter(company, seq, limit); } };
    const again = await fullCheckHere(doorsOf(c, checked, counting));
    expect(again.stop).toBeNull();
    /* RED WHEN: the check starts again from the first header instead of the last head it kept. */
    expect(asked[0]).toBe(2);
    expect((await checked.read(COMPANY))!.heads).toEqual(c.landed.map((l) => l.head));
  });

  it('a dishonest header the chain holds stops the check there, naming its key, and keeps every head before it', async () => {
    const c = await aCompanyOf(2);
    const bad = signTreeHeader({ ...structuredClone(c.headers[1]!), seq: 1, dirVersion: 4, changes: c.headers[1]!.changes.map((ch) => ({ ...ch, leaf: { ...ch.leaf, dirVersion: 4 } })) } as any, A.secret);
    const d = aTreeCompany(COMPANY);
    await d.land(c.headers[0]!);
    await d.land(bad);
    for (const [id, e] of c.entries) d.entries.set(id, e);
    const checked = checkedHeadsInMemory();
    const r = await fullCheckHere(doorsOf(d, checked));
    expect(r.stop).toMatchObject({ stop: 'dishonest', seq: 1, anchoredBy: A.publicKey });
    expect((await checked.read(COMPANY))!.heads).toEqual([d.landed[0]!.head]);
  });

  it('ON A DEVICE THAT STARTED FROM A LATER HEAD, keeps what that start gave it while the check runs, and holds the check in its place only once it reaches the head on chain', async () => {
    const c = await aCompanyOf(5);
    const checked = checkedHeadsInMemory();
    const started: CheckedHeads = {
      latest: c.head, fromZero: null, heads: [c.landed[3]!.head, c.landed[4]!.head], base: 3,
      from: { by: 'vouched', seq: 3, head: c.landed[3]!.head, run: 'ee'.repeat(32), at: 1 },
    };
    await checked.write(COMPANY, started);
    const withholding: TreeService = {
      ...c.service,
      headersAfter: async (company, seq, limit) => {
        const p = await c.service.headersAfter(company, seq, limit);
        return { ...p, headers: p.headers.filter((h) => (h as TreeHeader).seq !== 3) };
      },
    };
    const cut = await fullCheckHere(doorsOf(c, checked, withholding));
    expect(cut.stop).toMatchObject({ stop: 'not-given', seq: 3 });
    /* RED WHEN: a check cut short writes over what the device's start gave it - it would then hold heads from the first that stop short. */
    expect(await checked.read(COMPANY)).toEqual(started);
    const again = await fullCheckHere(doorsOf(c, checked));
    expect(again.stop).toBeNull();
    /* RED WHEN: a check that reached the head on chain from the first is not held in place of the start. */
    expect(await checked.read(COMPANY)).toEqual({
      latest: c.head, fromZero: c.head, heads: c.landed.map((l) => l.head), recent: c.landed.map((_, i) => c.checkedAt(i)),
    });
  });

  it('nothing anchored yet is the empty head, checked at once', async () => {
    const c = await aCompanyOf(0);
    const r = await fullCheckHere(doorsOf(c, checkedHeadsInMemory()));
    expect(r).toEqual({ reached: GENESIS, stop: null });
  });
});

describe('WHAT A DEVICE KEEPS OF THE CHECK, IN ITS OWN DATABASE', () => {
  const head = (n: number) => n.toString(16).padStart(64, '0') as Hex;
  const heads = (n: number): CheckedHeads => ({
    latest: { ...GENESIS, seq: n - 1, head: head(n) }, fromZero: { ...GENESIS, seq: n - 1, head: head(n) }, heads: Array.from({ length: n }, (_, i) => head(i + 1)),
  });
  /** A database whose every write to the heads is undone as it is made: what a browser does when a large write fails. */
  const failingWrites = (f: IDBFactory): IDBFactory => {
    const open = f.open.bind(f);
    return Object.assign(Object.create(f), {
      open: (name: string, version?: number) => {
        const req = open(name, version);
        req.addEventListener('success', () => {
          const db = req.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((stores: string | string[], mode?: IDBTransactionMode) => {
            const tx = transaction(stores, mode);
            if (mode === 'readwrite') {
              const objectStore = tx.objectStore.bind(tx);
              tx.objectStore = (n: string) => {
                const st = objectStore(n);
                if (n !== 'checked-heads') return st;
                const put = st.put.bind(st);
                st.put = ((v: unknown, k?: IDBValidKey) => { const r = put(v, k); tx.abort(); return r; }) as never;
                return st;
              };
            }
            return tx;
          }) as never;
        });
        return req;
      },
    });
  };
  it('keeps the heads per company, read back as written by a fresh read of the same database, and nothing for another company', async () => {
    const db = new IDBFactory();
    await treeKeptHere(db).checked.write(COMPANY, heads(2));
    await treeKeptHere(db).checked.write(COMPANY, heads(3));
    /* RED WHEN: what was kept is not read back from the device's database, on a fresh read. */
    expect(await treeKeptHere(db).checked.read(COMPANY)).toEqual(heads(3));
    expect(await treeKeptHere(db).checked.read('acct_other')).toBeNull();
  });
  it('KEEPS THE HEADS IT CHECKED LAST WHOLE, FOR A RECOVERY RESUMING FROM ONE, AND DROPS ANY THAT ARE NOT HEADS CHECKED', async () => {
    const db = new IDBFactory();
    const two = heads(2);
    const recent = [two.fromZero!, { ...two.latest, seq: two.latest.seq + 1 }].map((h) => ({ ...h }));
    await treeKeptHere(db).checked.write(COMPANY, { ...two, recent });
    /* RED WHEN: the heads checked last are not kept whole - a device that checked a batch a recovery gave up stops at it for good. */
    expect((await treeKeptHere(db).checked.read(COMPANY))?.recent).toEqual(recent);
    await treeKeptHere(db).checked.write(COMPANY, { ...two, recent: [{ seq: 'x' } as never] });
    /* RED WHEN: a kept head that is not one is believed, and a recovery followed from it. */
    expect((await treeKeptHere(db).checked.read(COMPANY))?.recent).toBeUndefined();
    expect((await treeKeptHere(db).checked.read(COMPANY))?.latest).toEqual(two.latest);
  });
  it('keeps where a device new to the company started, and the heads from it; a check from the first in their place writes every row again', async () => {
    const db = new IDBFactory();
    const started: CheckedHeads = {
      ...heads(1500), fromZero: null, base: 900, from: { by: 'vouched', seq: 900, head: head(901), run: 'ee'.repeat(32), at: 1_800_000_000_000 },
    };
    await treeKeptHere(db).checked.write(COMPANY, started);
    /* RED WHEN: where the device started, or the seq its heads start from, is not kept, or not read back. */
    expect(await treeKeptHere(db).checked.read(COMPANY)).toEqual(started);
    /* RED WHEN: a check from the first written in its place keeps the rows the started heads wrote - other heads under the same seqs. */
    const whole = { ...heads(1600), heads: Array.from({ length: 1600 }, (_, i) => head(i + 5000)) };
    await treeKeptHere(db).checked.write(COMPANY, whole);
    expect(await treeKeptHere(db).checked.read(COMPANY)).toEqual(whole);
  });
  it('keeps more heads than one row holds, a row at a time, and reads every one back in order', async () => {
    const db = new IDBFactory();
    await treeKeptHere(db).checked.write(COMPANY, heads(1500));
    await treeKeptHere(db).checked.write(COMPANY, heads(2100));
    /* RED WHEN: a head past the first row is lost, read out of order, or the rows written again drop one. */
    expect(await treeKeptHere(db).checked.read(COMPANY)).toEqual(heads(2100));
  });
  it('A WRITE THAT FAILS THROWS AWAY NOTHING KEPT BEFORE IT, AND REFUSES NOTHING: THE CHECK CARRIES ON FROM WHAT WAS KEPT', async () => {
    const db = new IDBFactory();
    await treeKeptHere(db).checked.write(COMPANY, heads(2));
    /* RED WHEN: a failed write throws, or leaves less than was kept before it, or keeps a count of heads it did not keep - the check would run from the first batch again. */
    await expect(treeKeptHere(failingWrites(db)).checked.write(COMPANY, heads(5))).resolves.toBeUndefined();
    expect(await treeKeptHere(db).checked.read(COMPANY)).toEqual(heads(2));
  });
  it('a browser with no database keeps nothing and refuses nothing: the check runs from the first again', async () => {
    const none = { open: () => { throw new Error('blocked'); } } as unknown as IDBFactory;
    await treeKeptHere(none).checked.write(COMPANY, heads(1));
    expect(await treeKeptHere(none).checked.read(COMPANY)).toBeNull();
    expect(await treeKeptHere(none).headers.at(COMPANY, 0)).toEqual([]);
  });
  it('keeps every header it signed and the last one it checked, with their entries and older leaves, read back by batch', async () => {
    const c = await aCompanyOf(3);
    const db = new IDBFactory();
    const keptOf = (h: TreeHeader): KeptHeader => ({ header: h, entries: h.changes.map((ch) => c.entries.get(ch.leaf.entryId)!), leaves: [] });
    await treeKeptHere(db).headers.signed(COMPANY, keptOf(c.headers[1]!));
    /* A second header this device signed at the same batch - one that lost a race - is kept beside the first. */
    const loser = signTreeHeader({ ...c.headers[1]!, at: '2026-10-11T00:00:00.000Z' }, A.secret);
    await treeKeptHere(db).headers.signed(COMPANY, keptOf(loser));
    await treeKeptHere(db).headers.checked(COMPANY, keptOf(c.headers[2]!));
    await treeKeptHere(db).headers.checked(COMPANY, keptOf(c.headers[1]!));
    /* RED WHEN: a header kept is not read back by its batch, or the last checked does not replace the one checked before it. */
    expect((await treeKeptHere(db).headers.at(COMPANY, 1)).map((k) => k.header)).toEqual([c.headers[1], loser, c.headers[1]]);
    expect(await treeKeptHere(db).headers.at(COMPANY, 2)).toEqual([]);
    expect((await treeKeptHere(db).headers.at(COMPANY, 1))[0]!.entries).toEqual(keptOf(c.headers[1]!).entries);
  });
});

describe('THE DIRECTORY CHANGES A DEVICE FILED AGAIN, KEPT IN ITS OWN DATABASE UNTIL ANCHORED', () => {
  const role = (seat: string) => ({ kind: 'role', seat, role: 'approver', threshold: 1, signatures: [] }) as const;
  it('keeps one change per version signed for, oldest first, read back by a fresh read; lets go of one; keeps nothing for another company', async () => {
    const db = new IDBFactory();
    await treeKeptHere(db).changes.keep(COMPANY, { signedAt: 5, change: role('bb'.repeat(32)) });
    await treeKeptHere(db).changes.keep(COMPANY, { signedAt: 3, change: role('aa'.repeat(32)) });
    /* RED WHEN: the changes kept are read back in the order they were kept, not the order they were first filed - filed again out of order. */
    expect((await treeKeptHere(db).changes.all(COMPANY)).map((k) => k.signedAt)).toEqual([3, 5]);
    await treeKeptHere(db).changes.keep(COMPANY, { signedAt: 5, change: role('cc'.repeat(32)) });
    /* RED WHEN: a change kept is not read back from the device's database, out of order, or two are kept for one version. */
    expect(await treeKeptHere(db).changes.all(COMPANY)).toEqual([{ signedAt: 3, change: role('aa'.repeat(32)) }, { signedAt: 5, change: role('cc'.repeat(32)) }]);
    expect(await treeKeptHere(db).changes.all('acct_other')).toEqual([]);
    await treeKeptHere(db).changes.letGo(COMPANY, 3);
    /* RED WHEN: a change let go of is still kept, or letting go of one drops another. */
    expect(await treeKeptHere(db).changes.all(COMPANY)).toEqual([{ signedAt: 5, change: role('cc'.repeat(32)) }]);
  });
  it('A DATABASE A PAGE BEFORE THIS ONE MADE GAINS THE PLACE FOR THEM, KEEPING THE HEADS IT HELD', async () => {
    const db = new IDBFactory();
    const latest = { seq: 0, head: '1a'.repeat(32), root: '2b'.repeat(32), dirVersion: 1 };
    /* The database as a page before this one made it, at its first version, holding one checked head. */
    await new Promise<void>((resolve, reject) => {
      const req = db.open('record-tree-kept', 1);
      req.onupgradeneeded = () => { for (const st of ['checked-heads', 'checked-latest', 'kept-headers']) req.result.createObjectStore(st); };
      req.onsuccess = () => {
        const tx = req.result.transaction(['checked-heads', 'checked-latest'], 'readwrite');
        tx.objectStore('checked-heads').put([latest.head], `${COMPANY}|${'0'.repeat(12)}`);
        tx.objectStore('checked-latest').put({ latest, fromZero: latest, count: 1 }, COMPANY);
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    await treeKeptHere(db).changes.keep(COMPANY, { signedAt: 2, change: role('aa'.repeat(32)) });
    /* RED WHEN: a database made before changes were kept never gains their place, so nothing filed again is kept. */
    expect(await treeKeptHere(db).changes.all(COMPANY)).toEqual([{ signedAt: 2, change: role('aa'.repeat(32)) }]);
    /* RED WHEN: gaining it loses what the database held before: the heads this device checked at its first version. */
    expect(await treeKeptHere(db).checked.read(COMPANY)).toEqual({ latest, fromZero: latest, heads: [latest.head] });
  });
});

describe('THE NEXT HEADER, MADE ON THIS DEVICE FROM PROOFS IT CHECKED', () => {
  it('makes a header from the leaves the service proves against the head this device checked, which the next check passes', async () => {
    const c = await aCompanyOf(3);
    const e = signManifestEntry(COMPANY, person('p0', 3, '7f'), A.secret);
    c.entries.set(entryIdOf(e), e);
    /* RED WHEN: the older leaves the service proves with are not used - the rolled-back check cannot walk the record's chain. */
    const made = (await treeHeaderHere({ accountId: COMPANY, tree: c.service, signingSecret: A.secret, tag: tagInATest(A.secret as Hex), held: HELD_IN_A_TEST, at: new Date('2026-10-10T00:00:00Z') }, c.head, [e]))!;
    expect(made.header.seq).toBe(3);
    expect(made.header.changes[0]!.prior!.version).toBe(2);
    await c.land(made.header);
    /* RED WHEN: the header made here does not pass the check every other device makes. */
    expect((await fullCheckHere(doorsOf(c, checkedHeadsInMemory()))).stop).toBeNull();
  });
  it('refuses to make one from leaves that do not prove into the root it follows, or a root the service does not keep', async () => {
    const c = await aCompanyOf(2);
    const e = signManifestEntry(COMPANY, person('p0', 2, '7f'), A.secret);
    const lying: TreeService = { ...c.service, proofs: async (company, ask) => ({ ...(await c.service.proofs(company, ask))!, records: [null] }) };
    const doors = { accountId: COMPANY, tree: lying, signingSecret: A.secret, held: HELD_IN_A_TEST, at: new Date(), tag: tagInATest(A.secret) };
    /* RED WHEN: a header is made on leaves the service swapped - it would anchor a record back to an older version. */
    await expect(treeHeaderHere(doors, c.head, [e])).rejects.toThrow(/do not make the root the anchor holds/u);
    await expect(treeHeaderHere({ ...doors, tree: { ...c.service, proofs: async () => null } }, c.head, [e])).rejects.toThrow(/keeps no header/u);
  });
});
