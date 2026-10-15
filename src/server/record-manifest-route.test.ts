/**
 * **THE COMPANY'S MANIFEST ON THE SERVICE, OVER REAL HTTP.** Each entry is kept
 * only for the seat whose key signed it, as the next version of its record, and
 * an entry already held is answered as entered; a header is kept only signed by
 * the seat posting it and following one kept. The service decides nothing a
 * device believes - every device checks what it serves - so these are
 * the honest server's own checks, the ones that keep a stale or foreign entry
 * from being offered to the next batch at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { aCompanyOfTwoSeats, acmeChain, ADA, apiAs, aRecordFiledBy, BO, CO, EVE, sendAs, store } from './a-company-of-two-seats.test-support.js';
import { treeHeaderHere } from 'vaults-web-shared/records-anchored-here.js';
import { treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import {
  directoryEntry, entryIdOf, proposalEntry, runEntry, signManifestEntry, type BatchHolders, type ManifestEntry, type ManifestEntryBody,
} from '../midnight/record-manifest.js';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { MemoryStore } from '../core/store.js';
import type { SealedProposal } from '../core/types.js';
import { signProposalFiling } from '../core/proposal-filing.js';
import { signRunFiling, type RunToFile } from '../core/run-filing.js';
import {
  checkedAfter, EMPTY_ROOT, GENESIS, nextTreeHeader, pendingAt as pendingIn, proofsOf, provenRefusal, signTreeHeader, treeKeyOf,
  type CheckedHead, type TreeHeader, headStepOf } from '../midnight/record-tree.js';
import { headsByTheAccount, HELD_IN_A_TEST, tagInATest } from '../testing/record-tree-double.js';

aCompanyOfTwoSeats();

const person = (id: string, version: number, digest = 'a1'): ManifestEntryBody =>
  ({ store: 'company', kind: 'person', id, version, digest: digest.repeat(32) });
const enter = (as: string, entries: readonly unknown[], company = CO) =>
  sendAs(as)(`/api/accounts/${company}/manifest/entries`, { method: 'POST', body: JSON.stringify({ entries }) });
const byAda = (e: ManifestEntryBody) => signManifestEntry(CO, e, ADA.signingSecret as Hex);
/** A key no seat of the company holds. */
const STRANGER = newSigningKeypair();

/** Who held the account as a batch below was judged: the service keeps a header whatever it names, and only a device's check asks. */
const HELD: BatchHolders = { approvals: 1, signerRoot: 'ab'.repeat(32) as Hex, signers: ['cd'.repeat(32) as Hex] };

describe('ENTERING A FILING', () => {
  it('keeps the next version of a record for the seat that signed it, and answers one sent again as entered, keeping it once', async () => {
    const first = byAda(await aRecordFiledBy(ADA, 'emp_manifest1'));
    expect((await enter('ada', [first])).status).toBe(201);
    /* RED WHEN: an entry sent again is refused - a filer whose answer was lost could never enter its filing. */
    expect((await enter('ada', [first])).status).toBe(201);
    /* RED WHEN: an entry sent again is kept twice. */
    expect(store.manifestOf(CO).entries.filter((e) => e.id === 'emp_manifest1')).toHaveLength(1);
  });

  it('refuses a version no newer than one entered, or a second entry at a version already entered, and keeps nothing of the request', async () => {
    const one = byAda(await aRecordFiledBy(ADA, 'emp_manifest2'));
    await aRecordFiledBy(ADA, 'emp_manifest2');
    const three = byAda(await aRecordFiledBy(ADA, 'emp_manifest2'));
    const held = store.manifestOf(CO).entries.length;
    /* RED WHEN: an older version is entered after a newer one - a service could put a stale version last in the tail. */
    expect((await enter('ada', [three, one])).body).toMatchObject({ refused: 'superseded' });
    expect(store.manifestOf(CO).entries.length).toBe(held);
    /* RED WHEN: a version past a gap is refused - a record filed before its company kept entries could never be entered again. */
    expect((await enter('ada', [three])).status).toBe(201);
    /* RED WHEN: a late entry below a version already entered is told to file again, which can never work, not that it was superseded. */
    expect((await enter('ada', [one])).body).toMatchObject({
      refused: 'superseded', error: expect.stringMatching(/version 1 of company record .* was superseded: version 3 of it is already in the company's records/u),
    });
    expect(JSON.stringify((await enter('ada', [one])).body)).not.toMatch(/file it again/u);
    /* RED WHEN: a second entry with other bytes at a version already entered is kept - two "newest" versions of one record. */
    expect(store.enterInManifest(CO, [byAda({ ...three, digest: 'b2'.repeat(32) })])).toMatchObject({ why: 'not-newer' });
    expect((await enter('ada', [byAda({ ...three, digest: 'b2'.repeat(32) })])).body).toMatchObject({ refused: 'not-the-filed-bytes' });
  });

  it('refuses an entry naming bytes the service keeps no signed record of, and one signed by another seat than the record\'s own filer', async () => {
    /* RED WHEN: an entry is kept for bytes nobody filed - a seat could make the anchor vouch for a record that does not exist. */
    expect((await enter('ada', [byAda(person('emp_manifest_unfiled', 1))])).body).toMatchObject({ refused: 'not-the-filed-bytes' });
    /* Ada files a proposal-kind record; Bo, who may file proposals too, enters it first, signed by his own key. */
    const adas = await aRecordFiledBy(ADA, 'emp_manifest_adas', 'proposal');
    /* RED WHEN: a seat may enter a record another seat filed - it could take the record's version before its filer does. */
    expect((await enter('bo', [signManifestEntry(CO, adas, BO.signingSecret as Hex)])).body).toMatchObject({ refused: 'not-the-filer' });
    expect((await enter('ada', [byAda(adas)])).status).toBe(201);
  });

  it('A PROPOSAL ENTERED FIRST BY ANOTHER SEAT: REFUSED WHETHER IT NAMES THE RAISER\'S BYTES OR OTHER ONES, AND THE RAISER\'S OWN ENTRY IS KEPT', async () => {
    const filing = signProposalFiling(CO, {
      id: 'prp_enteredfirst', digest: 'd1'.repeat(32) as Hex, chainId: 'c1'.repeat(32) as Hex, keyEpoch: 0,
      createdAt: '2026-10-09T10:00:00.000Z', sealed: { iv: 'aa', tag: 'bb', body: 'cc' },
    }, ADA.signingSecret as Hex);
    store.putProposal({
      id: filing.id, accountId: CO, status: 'open', createdAt: filing.createdAt, digest: filing.digest, chainId: filing.chainId,
      approvalCount: 0, keyEpoch: 0, sealed: filing.sealed, filedBy: filing.filedBy,
    } as SealedProposal);
    const raised = proposalEntry(CO, filing);
    /* RED WHEN: an approver who sees a proposal before its raiser enters it may take its only version with the raiser's bytes. */
    expect((await enter('bo', [signManifestEntry(CO, raised, BO.signingSecret as Hex)])).body).toMatchObject({ refused: 'not-the-filer' });
    /* RED WHEN: an approver may take its only version with bytes of his own - the raiser's proposal could never be anchored. */
    expect((await enter('bo', [signManifestEntry(CO, { ...raised, digest: 'b0'.repeat(32) }, BO.signingSecret as Hex)])).body)
      .toMatchObject({ refused: 'not-the-filed-bytes' });
    expect((await enter('ada', [byAda(raised)])).status).toBe(201);
  });

  it('A RUN ROLLED BACK: ITS NEWEST VERSION ENTERED AS THE BYTES OF AN OLDER ONE IS REFUSED, THOUGH THE SERVICE KEEPS THOSE BYTES AGAIN', async () => {
    const run = { id: 'run_rolledback01', accountId: CO, period: '2026-09', status: 'draft', keyEpoch: 0, payslips: [],
      sealed: { iv: '00', tag: '00', body: '00' } } as unknown as RunToFile;
    const file = (r: RunToFile) => { store.putRun(signRunFiling(CO, r, ADA.signingSecret as Hex) as never); };
    file(run);
    expect((await enter('ada', [byAda(runEntry(CO, run, 1))])).status).toBe(201);
    const later = { ...run, status: 'proposed' } as RunToFile;
    file(later);
    expect((await enter('ada', [byAda(runEntry(CO, later, 2))])).status).toBe(201);
    /* The seat files the run's first bytes again, and enters them as the newest version. */
    file(run);
    /* RED WHEN: a run's newest version may be entered as an older version's bytes - a stale version made to look anchored. */
    expect((await enter('ada', [byAda(runEntry(CO, run, 3))])).body).toMatchObject({ refused: 'rolled-back' });
    expect(store.manifestOf(CO).entries.filter((e) => e.id === run.id).map((e) => e.version)).toEqual([1, 2]);
  });

  it('takes an entry another seat signed from any member, judged by its own signature; refuses one no seat signed, and one whose signature does not cover it; judges no role', async () => {
    /* RED WHEN: an entry is judged by who hands it in, not by who signed it - a device keeping another seat's entry could never file it again. */
    const adas = byAda(await aRecordFiledBy(ADA, 'emp_manifest4'));
    expect((await enter('bo', [adas])).status).toBe(201);
    expect(store.manifestOf(CO).entries.map(entryIdOf)).toContain(entryIdOf(adas));
    /* RED WHEN: an entry signed by a key no seat holds is entered, whoever hands it in. */
    expect((await enter('bo', [signManifestEntry(CO, person('emp_manifest3', 1), STRANGER.secret)])).body).toMatchObject({ refused: 'no-entry' });
    const bent = { ...byAda(person('emp_manifest3', 1)), version: 2 };
    expect((await enter('ada', [bent])).body).toMatchObject({ refused: 'not-an-entry' });
    /*
     * Bo is an approver, and a roster is not his to file: RED WHEN the service refuses his entry for his role rather than
     * for what it can check - here, that no roster of that digest is kept. Only a member's device judges his role.
     */
    const roster = signManifestEntry(CO, { store: 'company', kind: 'roster', id: 'roster', version: 1, digest: 'c3'.repeat(32) }, BO.signingSecret as Hex);
    expect((await enter('bo', [roster])).body).not.toMatchObject({ refused: 'role-may-not-file' });
    /* RED WHEN: somebody who is not a member of the company reaches its manifest at all. */
    expect((await sendAs('eve')(`/api/accounts/${CO}/manifest`, { method: 'GET' })).status).toBe(404);
    expect((await enter('eve', [signManifestEntry(CO, person('emp_manifest3', 1), EVE.signingSecret as Hex)])).status).toBe(404);
  });

  it('keeps a directory version\'s entry only when it is the digest of the directory filing kept at that version', async () => {
    const filings = store.directoryFilingsOf(CO);
    const wrong = byAda({ ...directoryEntry(filings[0]!), digest: 'd4'.repeat(32) });
    /* RED WHEN: a seat may witness a directory version with bytes the directory never held. */
    expect((await enter('ada', [wrong])).body).toMatchObject({ refused: 'not-the-directory' });
    expect((await enter('bo', [signManifestEntry(CO, directoryEntry(filings[0]!), BO.signingSecret as Hex)])).status).toBe(201);
  });
});

describe('THE NEWEST VERSION ENTERED, AND THE ENTRIES NOT YET ANCHORED', () => {
  const newest = (records: unknown) => sendAs('ada')(`/api/accounts/${CO}/manifest/newest`, { method: 'POST', body: JSON.stringify({ records }) });
  const pendingAt = (root: string) => sendAs('ada')(`/api/accounts/${CO}/manifest/tree/pending?root=${root}`, { method: 'GET' });
  it('answers the newest version entered of each record asked, 0 for one never entered, and refuses a list that names no record', async () => {
    await aRecordFiledBy(ADA, 'emp_newest1');
    const two = byAda(await aRecordFiledBy(ADA, 'emp_newest1'));
    expect((await enter('ada', [two])).status).toBe(201);
    /* RED WHEN: the version a filer numbers its next entry from is not the newest entered, or a record never entered is given one. */
    expect((await newest([{ store: 'company', kind: two.kind, id: 'emp_newest1' }, { store: 'run', kind: 'run', id: 'run_never' }])).body)
      .toEqual({ versions: [2, 0] });
    expect((await newest([{ store: 'nowhere', kind: 'x', id: 'y' }])).status).toBe(400);
  });
  it('serves every entry newer than its record\'s leaf at a root it keeps, refuses a root it keeps none for, and keeps no whole-manifest or batch route', async () => {
    const e = byAda(await aRecordFiledBy(ADA, 'emp_pending1'));
    expect((await enter('ada', [e])).status).toBe(201);
    const founding = store.keptTreeOf(CO).headers[0]!;
    /* The company's whole manifest, watched: the entries waiting at a root are read from the records open there alone. */
    const whole = vi.spyOn(store, 'manifestOf');
    /* RED WHEN: an entry not yet anchored at the root asked is left out, or one its leaf there already holds is served as waiting. */
    const waiting = ((await pendingAt(founding.root)).body as { entries: ManifestEntry[] }).entries.map(entryIdOf);
    /* RED WHEN: the route reads every entry the company ever filed to find those waiting at one root, past its store's type. */
    expect(whole).not.toHaveBeenCalled();
    whole.mockRestore();
    expect(waiting).toContain(entryIdOf(e));
    expect(waiting).not.toContain(founding.changes[0]!.leaf.entryId);
    /* At the empty tree every entry is waiting. */
    expect(((await pendingAt(GENESIS.root)).body as { entries: ManifestEntry[] }).entries.map(entryIdOf)).toContain(founding.changes[0]!.leaf.entryId);
    /* RED WHEN: a root no header kept makes is read against anyway. */
    expect((await pendingAt('ee'.repeat(32))).body).toMatchObject({ refused: 'root-not-kept' });
    /* RED WHEN: the old whole manifest or the old batch header is still served or kept beside the tree. */
    expect((await sendAs('ada')(`/api/accounts/${CO}/manifest`, { method: 'GET' })).status).toBe(404);
    expect((await sendAs('ada')(`/api/accounts/${CO}/manifest/batches`, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('THE STORE ITSELF, GIVEN ONE REQUEST THAT ROLLS A RECORD BACK', () => {
  it('REFUSES A REQUEST WHOSE LATER ENTRY NAMES BYTES AN EARLIER ENTRY OF THE SAME REQUEST NAMED, AND KEEPS NOTHING OF IT', () => {
    const kept = new MemoryStore();
    const at = (version: number, digest: string) =>
      ({ store: 'company', kind: 'policy', id: 'pol_rolled', version, digest, filedBy: { publicKey: '0a'.repeat(32), signature: '' } }) as never;
    /* RED WHEN: a rollback inside one request is kept - a third version naming the first's bytes, entered beside them. */
    expect(kept.enterInManifest('acc_rolled', [at(1, 'd1'.repeat(32)), at(2, 'd2'.repeat(32)), at(3, 'd1'.repeat(32))])).toMatchObject({ why: 'rolled-back' });
    expect(kept.manifestOf('acc_rolled').entries).toEqual([]);
  });
});


describe('THE COMPANY\'S RECORD TREE ON THE SERVICE', () => {
  const page = async (after: number, limit = 64) => sendAs('ada')(`/api/accounts/${CO}/manifest/tree/headers?after=${after}&limit=${limit}`, { method: 'GET' });
  const keepHeader = (as: string, header: unknown) =>
    sendAs(as)(`/api/accounts/${CO}/manifest/tree/headers`, { method: 'POST', body: JSON.stringify({ header }) });
  const prove = (body: unknown) => sendAs('ada')(`/api/accounts/${CO}/manifest/tree/proofs`, { method: 'POST', body: JSON.stringify(body) });
  /* The header Acme was founded with is kept already, Ada's first anchor: the one a test's next header follows. */
  const founding = () => store.keptTreeOf(CO).headers[0]!;
  const nextHeader = async () => {
    const e = byAda(await aRecordFiledBy(ADA, 'emp_tree1'));
    expect((await enter('ada', [e])).status).toBe(201);
    const f = founding();
    const before = { seq: f.seq, head: acmeChain.landed[0]!.head as Hex, root: f.root, dirVersion: f.dirVersion };
    const made = (await treeHeaderHere({ accountId: CO, tree: treeServiceFor(apiAs('ada')), signingSecret: ADA.signingSecret as Hex, tag: tagInATest(ADA.signingSecret as Hex), held: HELD, at: new Date() }, before, [e]))!;
    return { e, made };
  };

  it('keeps the next header signed by a seat that may anchor, serves it a page at a time with its entries, and proves its leaf', async () => {
    const { e, made } = await nextHeader();
    const before = store.keptTreeOf(CO);
    const kept = before.headers.length;
    /* RED WHEN: a header that a seat signed and whose changes make its roots is not kept - no device could ever check it. */
    expect((await keepHeader('ada', made.header)).status).toBe(201);
    /* RED WHEN: the tree is built again from every header for a read, rather than grown as each header is kept. */
    expect(store.keptTreeOf(CO)).toBe(before);
    expect(before.makingRoot(made.header.root)).toEqual(made.header);
    /* RED WHEN: a header filed again is kept twice. */
    expect((await keepHeader('ada', made.header)).status).toBe(201);
    expect(store.keptTreeOf(CO).headers).toHaveLength(kept + 1);
    const p = (await page(made.header.seq - 1)).body as any;
    /* RED WHEN: the page leaves out the header, or the entry its change names. */
    expect(p.headers).toHaveLength(1);
    expect(p.entries.map(entryIdOf)).toEqual([entryIdOf(e)]);
    expect(((await page(made.header.seq)).body as any).headers).toHaveLength(0);
    const asked = { root: made.header.root, records: [{ store: 'company', kind: e.kind, id: e.id }], kinds: [{ store: 'run', kind: 'run' }] };
    const given = (await prove(asked)).body as any;
    /* RED WHEN: the proof served does not make the root the header names, for the leaf and the empty kind asked. */
    expect(provenRefusal(made.header.root, {
      records: [{ name: asked.records[0] as never, leaf: given.records[0] }], kinds: [{ kind: asked.kinds[0] as never, leaves: given.kinds[0] }],
    }, given.proof)).toBeNull();
    /* RED WHEN: a root no header kept makes is proven against anyway. */
    expect((await prove({ ...asked, root: 'ee'.repeat(32) })).body).toMatchObject({ refused: 'root-not-kept' });
  });

  it('refuses a header that does not follow one kept, one not signed as it says, and one from a key no seat of the person holds', async () => {
    const kept = founding();
    const held = store.keptTreeOf(CO).headers.length;
    const e = byAda(await aRecordFiledBy(ADA, 'emp_tree2'));
    expect((await enter('ada', [e])).status).toBe(201);
    const stray = signTreeHeader({ ...kept, seq: 5 }, ADA.signingSecret as Hex);
    /* RED WHEN: a header following no header kept is kept - a device could be served a tree that starts nowhere. */
    expect((await keepHeader('ada', stray)).body).toMatchObject({ refused: 'not-the-next-header' });
    /* RED WHEN: a header whose signature does not cover it is kept. */
    expect((await keepHeader('ada', { ...kept, at: '2026-10-11T00:00:00.000Z' })).body).toMatchObject({ refused: 'not-a-header' });
    /* RED WHEN: a header signed by a key no seat that may anchor holds is kept, whoever hands it in. */
    expect((await keepHeader('bo', signTreeHeader(kept, STRANGER.secret))).status).toBe(403);
    expect(store.keptTreeOf(CO).headers).toHaveLength(held);
    /*
     * RED WHEN: a header is judged by the directory now rather than as it stood at the version the header names - Bo's
     * seat may anchor now, but held no seat at the founding header's version, so he could not have anchored it.
     */
    expect(kept.dirVersion).toBe(1);
    expect((await keepHeader('ada', signTreeHeader(kept, BO.signingSecret as Hex))).status).toBe(403);
    expect(store.keptTreeOf(CO).headers).toHaveLength(held);
    /* RED WHEN: a header is judged by who hands it in, not by who signed it - a device keeping another seat's header could never file it again. */
    expect((await keepHeader('bo', kept)).status).toBe(201);
    expect(store.keptTreeOf(CO).headers).toHaveLength(held);
    /* RED WHEN: a page is read with no seq to read after. */
    expect((await sendAs('ada')(`/api/accounts/${CO}/manifest/tree/headers`, { method: 'GET' })).status).toBe(400);
  });

  it('keeps a header, serves a page and answers the newest versions without reading every entry the company filed', async () => {
    const { e, made } = await nextHeader();
    /* Every entry the company filed, as the store keeps them, made to throw if anything reads through them. */
    const kept = (store as any).data.manifests[CO];
    const all = kept.entries;
    kept.entries = new Proxy(all, { get: (t, k) => {
      if (k === 'length' || k === Symbol.iterator || (typeof k === 'string' && /^\d+$/u.test(k))) throw new Error('every entry was read');
      return Reflect.get(t, k);
    } });
    try {
      /* RED WHEN: keeping a header, a page or the newest versions find an entry by reading every entry the company ever filed. */
      expect((await keepHeader('ada', made.header)).status).toBe(201);
      expect(((await page(made.header.seq - 1)).body as any).entries).toContainEqual(e);
      expect((await sendAs('ada')(`/api/accounts/${CO}/manifest/newest`, { method: 'POST', body: JSON.stringify({ records: [{ store: e.store, kind: e.kind, id: e.id }] }) })).body)
        .toEqual({ versions: [e.version] });
    } finally {
      kept.entries = all;
    }
  });
  it('builds the kept tree and the entries again when the data they were built from is replaced, as a reset or a failed write does', async () => {
    const { e } = await nextHeader();
    const held = store.keptTreeOf(CO);
    expect(store.manifestEntryOf(CO, entryIdOf(e))).toEqual(e);
    const data = (store as any).data;
    (store as any).data = { ...data, trees: {}, manifests: {} };
    try {
      /* RED WHEN: the store answers from a tree or an entry kept for data that is gone. */
      expect(store.keptTreeOf(CO)).not.toBe(held);
      expect(store.keptTreeOf(CO).headers).toEqual([]);
      expect(store.manifestEntryOf(CO, entryIdOf(e))).toBeUndefined();
    } finally {
      (store as any).data = data;
    }
  });
  it('reads the tree through the page\'s own client: a page, the proofs, the entries not yet anchored, and a root not kept answered as none', async () => {
    const client = treeServiceFor(apiAs('ada'));
    const kept = founding();
    /* RED WHEN: the client drops the entries or the older leaves a page carries, or reads a page that is not one. */
    const p = await client.headersAfter(CO, -1, 1);
    expect(p.headers).toEqual([kept]);
    expect(p.entries.map((x) => entryIdOf(x as ManifestEntry)).sort()).toEqual(kept.changes.map((c) => c.leaf.entryId).sort());
    const asked = { root: kept.root, records: [{ store: kept.changes[0]!.leaf.store, kind: kept.changes[0]!.leaf.kind, id: kept.changes[0]!.leaf.id }], kinds: [] };
    const given = (await client.proofs(CO, asked))!;
    expect(provenRefusal(kept.root, { records: [{ name: asked.records[0]!, leaf: given.records[0]! }] }, given.proof)).toBeNull();
    /* RED WHEN: the entries not yet anchored are not read, or a root not kept is read as an empty tree. */
    expect(Array.isArray(await client.pending(CO, kept.root))).toBe(true);
    expect(await client.pending(CO, 'ee'.repeat(32))).toBeNull();
    /* RED WHEN: a root the service keeps no header for is read as an empty tree rather than as none. */
    expect(await client.proofs(CO, { ...asked, root: 'ee'.repeat(32) })).toBeNull();
  });
});

describe('THE ENTRIES WAITING AT A ROOT ARE READ FROM THE RECORDS OPEN THERE, NEVER FROM EVERY ENTRY FILED', () => {
  const COMPANY = 'acct_open_at';
  const KEY = newSigningKeypair();
  const p = (id: string, version: number) => signManifestEntry(COMPANY, { store: 'company', kind: 'person', id, version, digest: `${id}v${version}`.padEnd(64, '0').replace(/[^0-9a-f]/gu, 'a') as Hex }, KEY.secret);
  it('serves at every root what reading every entry would, and reads the entries of the open records only', async () => {
    const kept = new MemoryStore();
    let head: CheckedHead = GENESIS;
    /** Anchors `es` from the head kept last - or, with `from`, from that head: an anchor that races the one kept. */
    const anchor = async (es: readonly ManifestEntry[], from: CheckedHead = head): Promise<TreeHeader> => {
      const records = [...new Map(es.map((e) => [treeKeyOf(e), { store: e.store, kind: e.kind, id: e.id }])).values()];
      const given = proofsOf(kept.keptTreeOf(COMPANY), { root: from.root, records, kinds: [] })!;
      const made = nextTreeHeader({
        company: COMPANY, before: from, entries: es, current: new Map(records.map((r, i) => [treeKeyOf(r), given.records[i]!])),
        proof: given.proof, priorChain: (h) => kept.keptTreeOf(COMPANY).leaf(h), held: HELD_IN_A_TEST, at: '2026-10-11T00:00:00.000Z', tag: tagInATest(KEY.secret),
      }, KEY.secret)!;
      expect(kept.fileTreeHeader(COMPANY, made.header)).toBeNull();
      const [next] = await headsByTheAccount([headStepOf(made.header)]);
      if (from === head) head = checkedAfter(made.header, next!);
      return made.header;
    };
    const ones = Array.from({ length: 40 }, (_, i) => p(`p${i}`, 1));
    expect(kept.enterInManifest(COMPANY, ones)).toBeNull();
    const first = await anchor(ones);
    const atFirst = head;
    const [p7, p8, p9] = [p('p7', 2), p('p8', 2), p('p9', 2)];
    expect(kept.enterInManifest(COMPANY, [p7, p8, p9])).toBeNull();
    const second = await anchor([p7]);
    /* An anchor that raced the second, from the first's head, anchoring Bo's p8 at version 2: kept, never the chain's. */
    const raced = await anchor([p8], atFirst);
    const all = kept.manifestOf(COMPANY).entries;
    for (const root of [EMPTY_ROOT, first.root, second.root, raced.root]) {
      /* RED WHEN: the records open at a root leave out one whose entry waits there - the device would hold a filing as never entered. */
      expect(pendingIn(kept.keptTreeOf(COMPANY), kept.entriesOpenAt(COMPANY, root)!, root)).toEqual(pendingIn(kept.keptTreeOf(COMPANY), all, root));
    }
    expect(pendingIn(kept.keptTreeOf(COMPANY), kept.entriesOpenAt(COMPANY, second.root)!, second.root)!.map((e) => `${e.id}@${e.version}`)).toEqual(['p8@2', 'p9@2']);
    /* RED WHEN: the entries waiting at the newest root are found by reading every entry the company filed. */
    expect(kept.entriesOpenAt(COMPANY, second.root)!.map((e) => e.id).sort()).toEqual(['p7', 'p7', 'p8', 'p8', 'p9', 'p9']);
    expect(kept.entriesOpenAt(COMPANY, 'ee'.repeat(32) as Hex)).toBeNull();
  });
});

describe('A HEADER FILED AGAIN WITH ITS ENTRIES, WHERE THE SERVICE NO LONGER HOLDS THEM', () => {
  const COMPANY = 'acct_header_entries';
  const KEY = newSigningKeypair();
  const p = (id: string, version: number) => signManifestEntry(COMPANY, { store: 'company', kind: 'person', id, version, digest: `${id}v${version}`.padEnd(64, '0').replace(/[^0-9a-f]/gu, 'a') as Hex }, KEY.secret);
  const headerOver = (kept: MemoryStore, from: CheckedHead, es: readonly ManifestEntry[]): TreeHeader => {
    const records = es.map((e) => ({ store: e.store, kind: e.kind, id: e.id }));
    const given = proofsOf(kept.keptTreeOf(COMPANY), { root: from.root, records, kinds: [] })!;
    return nextTreeHeader({
      company: COMPANY, before: from, entries: es, current: new Map(records.map((r, i) => [treeKeyOf(r), given.records[i]!])),
      proof: given.proof, priorChain: (h) => kept.keptTreeOf(COMPANY).leaf(h), held: HELD_IN_A_TEST, at: '2026-10-11T00:00:00.000Z', tag: tagInATest(KEY.secret),
    }, KEY.secret)!.header;
  };

  it('keeps the entries its changes name with it, needing no record bytes, and never one it does not name', async () => {
    const kept = new MemoryStore();
    const a = p('pa', 1);
    expect(kept.enterInManifest(COMPANY, [a])).toBeNull();
    const first = headerOver(kept, GENESIS, [a]);
    expect(kept.fileTreeHeader(COMPANY, first)).toBeNull();
    const [next] = await headsByTheAccount([headStepOf(first)]);
    /* The entry the second header names is one this store no longer holds: never entered here, as after a lost write. */
    const lost = p('pb', 1);
    const second = headerOver(kept, checkedAfter(first, next!), [lost]);
    /* RED WHEN: a header is kept naming an entry nobody handed in. */
    expect(kept.fileTreeHeader(COMPANY, second)).toMatch(/does not hold/u);
    /* RED WHEN: an entry its changes do not name is kept with it - any member could put entries in the company's records. */
    const other = p('pc', 1);
    expect(kept.fileTreeHeader(COMPANY, second, [other])).toMatch(/does not hold/u);
    expect(kept.manifestEntryOf(COMPANY, entryIdOf(other))).toBeUndefined();
    /* RED WHEN: the entry handed in with the header is not kept with it - the header would stay one every device stops at. */
    expect(kept.fileTreeHeader(COMPANY, second, [lost, other])).toBeNull();
    expect(kept.manifestEntryOf(COMPANY, entryIdOf(lost))).toEqual(lost);
    expect(kept.manifestEntryOf(COMPANY, entryIdOf(other))).toBeUndefined();
    expect(kept.newestEntered(COMPANY, 'company:person:pb')).toBe(1);
  });

  it('the route refuses what is handed in with a header that is not a signed entry of this company, or that its changes do not name', async () => {
    const keepWith = (header: unknown, entries: unknown[]) =>
      sendAs('ada')(`/api/accounts/${CO}/manifest/tree/headers`, { method: 'POST', body: JSON.stringify({ header, entries }) });
    const founding = store.keptTreeOf(CO).headers[0]!;
    const named = store.manifestEntryOf(CO, founding.changes[0]!.leaf.entryId)!;
    /* RED WHEN: an entry no change of the header names is taken with it. */
    expect((await keepWith(founding, [byAda(person('emp_not_named', 1))])).body).toMatchObject({ refused: 'not-the-headers-entry' });
    /* RED WHEN: what is handed in with a header is not checked to be a signed entry of this company before anything else is read of it. */
    expect((await keepWith(founding, [{ ...named, filedBy: undefined }])).body).toMatchObject({ refused: 'not-the-headers-entry' });
    /* A header's own entry handed in with it is answered as the header is: kept once. */
    expect((await keepWith(founding, [named])).status).toBe(201);
  });

  it('THE ROUTE KEEPS AN ENTRY HANDED IN WITH A HEADER ONLY FOR A SEAT THAT COULD FILE ITS RECORD AS THE DIRECTORY STOOD AT THE HEADER, SO NO ANCHORING SEAT CAN PUT A VERSION OF ANOTHER SEAT\'S RECORD IN THE COMPANY\'S RECORDS', async () => {
    const keepWith = (header: unknown, entries: unknown[]) =>
      sendAs('ada')(`/api/accounts/${CO}/manifest/tree/headers`, { method: 'POST', body: JSON.stringify({ header, entries }) });
    const f = store.keptTreeOf(CO).headers[0]!;
    const before = { seq: f.seq, head: acmeChain.landed[0]!.head as Hex, root: f.root, dirVersion: f.dirVersion };
    /* A header racing the one the chain holds, signed by Ada's seat, which may anchor, naming a high version of a person record. */
    const headerNaming = async (e: ManifestEntry) => (await treeHeaderHere({
      accountId: CO, tree: treeServiceFor(apiAs('ada')), signingSecret: ADA.signingSecret as Hex, tag: tagInATest(ADA.signingSecret as Hex), held: HELD, at: new Date(),
    }, before, [e]))!.header;
    /* Bo held no seat at the version that header names, and a stranger's key holds none at all. */
    for (const by of [BO.signingSecret as Hex, STRANGER.secret]) {
      const forged = signManifestEntry(CO, person('emp_forged', 50), by);
      const res = await keepWith(await headerNaming(forged), [forged]);
      /*
       * RED WHEN: an entry handed in with a header is kept without its filer judged - one seat that may anchor could raise
       * another record's newest version to any number, and every honest later version of it is refused as superseded.
       */
      expect(res.status).toBe(403);
      expect(store.newestEntered(CO, 'company:person:emp_forged')).toBe(0);
      expect(store.manifestEntryOf(CO, entryIdOf(forged))).toBeUndefined();
    }
  });
});
