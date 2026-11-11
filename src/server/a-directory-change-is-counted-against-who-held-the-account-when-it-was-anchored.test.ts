/**
 * **A RETIREMENT IS COUNTED AGAINST WHO HELD THE ACCOUNT WHEN IT WAS
 * ANCHORED.** A device replays the company's directory from every filing,
 * and each change's quorum is counted against the holders the batch that first
 * anchored that version names - the approvals the account required and the
 * seats its signer tree held, which the account's anchor call checked as it
 * ran - never against who holds the account now, and never against the state
 * after the call's block. So a signer of a retirement who leaves the account
 * later changes nothing about it: the retired seat stays retired, and a batch
 * it anchors is stopped. And a signer who leaves between a device's read and
 * its anchor landing makes the account refuse that anchor: the device reads
 * again and anchors again, and every header is checked.
 *
 * Over real HTTP with the company's record tree and directory as the service
 * keeps them. The chain is the test's: one head, moved on only by a call naming
 * the head and the holders it holds, each call kept with the committee as it
 * landed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { sign, type Hex } from '../core/crypto.js';
import { directoryEntry, entryIdOf, signManifestEntry, type BatchHolders, type ManifestEntry } from '../midnight/record-manifest.js';
import { treeBatchOf, type TreeHeader } from '../midnight/record-tree.js';
import { newestAnchored, type RecordsAsked, type RecordsHeld } from '../midnight/records-held.js';
import { directoryChangeMessage, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorServiceFor, anchorTheRecordsHere, recordsHeldHere, treeHeaderHere, type AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryWithItsFold, acmeDirectory, acmeDirectoryDeps, acmeHeldNow, ADA, ADDRESS, apiAs, aRecordFiledBy, BO, chains, CO, LABEL,
  seatOf, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';
import { anchoredOver, anchorFunctions, headAfter as headAfterAs, holdersOf, tagInATest, anchorSentInATest } from '../testing/record-tree-double.js';
import { directoryHere } from 'vaults-web-shared/vault-page-doors.js';

aCompanyOfTwoSeats();

/* Seven more seats Ada's seat invited, each entered and held by the account, so each case retires a seat of its own. */
const [CY, DEE, FAY, GUS, HAL, IVY, JO] = ['cy', 'dee', 'fay', 'gus', 'hal', 'ivy', 'jo']
  .map((p, i) => seatOf(p, 11 + i, LABEL, ADDRESS, CO, ADA)) as [Seat, Seat, Seat, Seat, Seat, Seat, Seat];
const MORE = [CY, DEE, FAY, GUS, HAL, IVY, JO];

/** Run once when a device sends its anchor, before the chain applies it: what lands on the account meanwhile. */
let meanwhile: (() => void) | null = null;
/** Every anchor call the chain refused, with why. */
const refused: string[] = [];

const doorsOf = (s: Seat): AnchorDoors => ({
  accountId: CO,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceFor(apiAs(s.person)),
  tree: treeServiceFor(apiAs(s.person)),
  directory: () => acmeDirectoryWithItsFold(),
  directoryFilings: async () => store.directoryFilingsOf(CO),
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_company, tx) => {
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      const before = meanwhile;
      meanwhile = null;
      before?.();
      try {
        acmeChain.move(previous, batch, held, tag);
      } catch (e) {
        refused.push((e as Error).message);
        throw e;
      }
    },
    sealedProposals: async (company) => store.listProposals(company),
    foundingRecords: anchorServiceFor(apiAs(s.person)).foundingRecords,
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
});

/** The account held, on the test's chain, by these seats and the seven more, at the approvals it requires. */
const heldBy = (seats: readonly Seat[]) => {
  const all = [...seats, ...MORE];
  chains.set(CO, { seats: { committee: all.map((s) => s.committeeKey), threshold: 1, seats: all.map((s) => s.seat) }, approvals: 1, seatBar: 1 });
};
beforeAll(async () => {
  const account = store.getAccount(CO)!;
  store.putAccount({ ...account, memberUserIds: [...account.memberUserIds, ...MORE.map((s) => s.person)] });
  heldBy([ADA, BO]);
  for (const s of MORE) {
    const version = store.directoryFilingsOf(CO).length + 1;
    const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify({ company: CO, version, change: { kind: 'claim', entry: s.entry } }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
});

/** The next directory version: `seat` retired, keeping nothing it filed, signed by `by` as a quorum of one, the account's approvals. */
const retiredBy = async (seat: Seat, by: Seat) => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { kind: 'retire', seat: seat.seat, filedUpTo: {}, threshold: 1, signatures: [] } as unknown as DirectoryChange;
  const signature = sign(directoryChangeMessage(CO, version, unsigned), by.signingSecret);
  const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: by.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
  const r = await sendAs(by.person)(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};
const retiredOf = async (s: Seat) => (await acmeDirectory()).dir.seats.find((x) => x.seat === s.seat)?.retired;
/** What `s`'s device holds now of the company's records, for what it asks. */
const heldNow = async (s: Seat, asked: RecordsAsked = {}) => (await recordsHeldHere(doorsOf(s), asked)).records;
/** One record a test filed, as a read asks for it. */
const asking = (kind: string, id: string): RecordsAsked => ({ records: [{ store: 'company', kind, id }] });
/** The newest version a read holds of a record, with the digest it holds it at. */
const newestOf = (f: RecordsHeld, key: string) => { const v = f.history.get(key)?.at(-1); return v === undefined ? undefined : { version: v.version, digest: v.digest }; };
/** Every entry the service gives as not yet anchored at the root `s`'s device checked last. */
const waitingFor = async (s: Seat): Promise<ManifestEntry[]> =>
  (await treeServiceFor(apiAs(s.person)).pending(CO, (await heldNow(s)).reached.root))! as ManifestEntry[];
/**
 * **A HEADER `s`'S DEVICE MAKES BY HAND** for `entries`, following the head it
 * checked last, naming `held` as who held the account, and kept in the service's
 * store past its own route: nothing of the device's rules, or the route's, on who
 * may anchor is applied, as a service that keeps whatever it is handed would.
 */
const handMade = async (s: Seat, entries: readonly ManifestEntry[], held: BatchHolders): Promise<TreeHeader> => {
  const { reached } = await heldNow(s);
  const tree = treeServiceFor(apiAs(s.person));
  const made = (await treeHeaderHere({ accountId: CO, tree, signingSecret: s.signingSecret as Hex, tag: tagInATest(s.signingSecret as Hex), held, at: new Date() }, reached, entries))!;
  expect(store.fileTreeHeader(CO, made.header)).toBeNull();
  return made.header;
};

describe('A CHANGE IS COUNTED AGAINST WHO HELD THE ACCOUNT WHEN IT WAS ANCHORED, NEVER WHO HOLDS IT NOW', () => {
  it('A RETIREMENT SIGNED AT THE THRESHOLD, ANCHORED IN A BLOCK WHOSE STATE HOLDS A HIGHER POLICY BAR, IS NOT BELIEVED, THOUGH THE BAR FALLS AFTER', async () => {
    heldBy([ADA, BO]);
    await retiredBy(CY, ADA);
    /* The account stores a policy bar of two before the retirement is anchored: a change of who is seated then needs two. */
    chains.set(CO, { ...chains.get(CO)!, seatBar: 2 });
    expect((await anchorTheRecordsHere(doorsOf(ADA))).anchored).toBeGreaterThan(0);
    expect(acmeChain.landed.at(-1)?.seatBar).toBe(2);
    /* The bar falls back to the threshold afterwards. */
    chains.set(CO, { ...chains.get(CO)!, seatBar: 1 });
    /* RED WHEN: an anchored retirement is held to the threshold its batch's header names, not the seat bar of the block it landed in. */
    expect(await retiredOf(CY)).toBeNull();
  });

  it('A RETIREMENT SIGNED AT THE THRESHOLD AND NOT YET ANCHORED IS NOT BELIEVED WHILE THE WALLET READS A HIGHER POLICY BAR ON THE ACCOUNT', async () => {
    heldBy([ADA, BO]);
    await retiredBy(DEE, ADA);
    expect(await retiredOf(DEE)).toEqual({});
    /* The account now stores a policy bar of two, as the person's own wallet reads it. */
    chains.set(CO, { ...chains.get(CO)!, seatBar: 2 });
    /* RED WHEN: a device judges a retirement not yet anchored against the account's threshold, as its wallet read it, below its seat bar. */
    expect(await retiredOf(DEE)).toBeNull();
    chains.set(CO, { ...chains.get(CO)!, seatBar: 1 });
  });

  it('TWO ANCHORS IN ONE BLOCK: A CHANGE FIRST ANCHORED AT A HEAD THE HISTORY NEVER SHOWS IS COUNTED AGAINST THE HOLDERS ITS BATCH NAMED', async () => {
    heldBy([ADA, BO]);
    await retiredBy(FAY, ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    const first = acmeChain.landed.length - 1;
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_same_block_b1')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* Both calls landed in one block: the history shows the state after it, so the head between them is never read. */
    acmeChain.landed.splice(first, 1);
    heldBy([BO]);
    /* RED WHEN: a change first anchored at a head the history never shows is read as anchored with nobody known to hold the
     * account - left unbelieved for good, though its batch names who held the account and the call checked them. */
    expect(await retiredOf(FAY)).toEqual({});
  });

  it('NO LATER HEADER NAMES AN ANCHORED VERSION AGAIN: THE CALL THAT FIRST ANCHORED IT IS WHAT IT IS COUNTED AGAINST', async () => {
    /* Bo, still on the account now that Ada has left it, makes a header naming every directory version again. */
    const named = store.directoryFilingsOf(CO).map((f) => signManifestEntry(CO, directoryEntry(f), BO.signingSecret as Hex));
    const tree = treeServiceFor(apiAs('bo'));
    /* RED WHEN: a header can name a directory version again - Ada's change could be counted against the last call naming it. */
    expect(await treeHeaderHere({ accountId: CO, tree, signingSecret: BO.signingSecret as Hex, tag: tagInATest(BO.signingSecret as Hex), held: holdersOf(acmeHeldNow()), at: new Date() },
      (await heldNow(BO)).reached, named)).toBeNull();
    expect((await heldNow(BO)).stopped).toBeNull();
    /* RED WHEN: a version is counted against who holds the account now - Ada's change, anchored before she left, is forgotten. */
    expect(await retiredOf(FAY)).toEqual({});
  });

  it("A CHANGE'S SIGNER REMOVED BETWEEN AN ANCHOR'S BUILD AND ITS LANDING: THE ANCHOR IS REFUSED, ANCHORED AGAIN, AND EVERY HEADER IS CHECKED", async () => {
    heldBy([ADA, BO]);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* Ada retires Gus, and Bo files a record: both wait for the next anchor. */
    await retiredBy(GUS, ADA);
    const bos = await aRecordFiledBy(BO, 'prp_bo_race', 'proposal');
    await BO.entered.enter([bos]);
    refused.length = 0;
    /* Bo's device judges its batch with Ada seated; before its anchor lands, Ada's removal lands. */
    meanwhile = () => { heldBy([BO]); };
    expect((await anchorTheRecordsHere(doorsOf(BO))).anchored).toBeGreaterThan(0);
    /* RED WHEN: the anchor call does not bind who held the account as the batch was judged - it lands, and nothing is refused. */
    expect(refused).toEqual(['the account\'s signers changed after this device judged the batch']);
    const f = await heldNow(BO, asking('proposal', 'prp_bo_race'));
    /* RED WHEN: the batch lands judged against Ada's seat and is counted against the account after its block, so every device stops at that batch for good. */
    expect(f.stopped).toBeNull();
    /* Judged again against who holds the account now: Ada's retirement of Gus, signed by a seat that left before it was anchored, is not believed. */
    expect(await retiredOf(GUS)).toBeNull();
    expect(newestOf(f, 'company:proposal:prp_bo_race')).toEqual({ version: 1, digest: bos.digest });
  });

  it("THE APPROVALS THE ACCOUNT REQUIRES CHANGE BETWEEN AN ANCHOR'S BUILD AND ITS LANDING: THE ANCHOR IS REFUSED, AND ANCHORED AGAIN", async () => {
    heldBy([ADA, BO]);
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_approvals_race')]);
    refused.length = 0;
    /* Before Ada's anchor lands, the account's threshold changes from 1 to 2: the same seats, other approvals. */
    meanwhile = () => { chains.set(CO, { ...chains.get(CO)!, approvals: 2, seatBar: 2 }); };
    expect((await anchorTheRecordsHere(doorsOf(ADA))).anchored).toBeGreaterThan(0);
    /* RED WHEN: a refusal whose head did not move is not read again - the approvals moved, and the device must anchor again. */
    expect(refused).toEqual(['the approvals the account requires changed after this device judged the batch']);
    expect(newestAnchored(await heldNow(ADA, asking('policy', 'pol_approvals_race')), { store: 'company', kind: 'policy', id: 'pol_approvals_race' })).toBe(1);
  });

  it('A BATCH WHOSE HEADER NAMES SEATS THAT DO NOT MAKE THE ROOT THE CALL CHECKED: ITS DIRECTORY VERSIONS ARE NOT KNOWN, AND NOT BELIEVED', async () => {
    heldBy([ADA, BO]);
    await retiredBy(HAL, ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    expect(await retiredOf(HAL)).toEqual({});
    await retiredBy(IVY, ADA);
    /* Ada's device witnesses the new directory version, as an anchoring device does. */
    const v = signManifestEntry(CO, directoryEntry(store.directoryFilingsOf(CO).at(-1)!), ADA.signingSecret as Hex);
    await manifestServiceFor(apiAs('ada')).enter(CO, [v]);
    /* Ada names the root the account holds, but a seat list of her own: one the root does not have. */
    const named = holdersOf(acmeHeldNow());
    const forged: BatchHolders = { ...named, signers: [...named.signers, ADA.seat as Hex] };
    const header = await handMade(ADA, [v], forged);
    acmeChain.move(acmeChain.head(), treeBatchOf(header), header.held, header.tag);
    /* RED WHEN: the seats a header names are believed without making the root the account's call checked. */
    expect(await retiredOf(IVY)).toBeNull();
  });

  it('A DIRECTORY VERSION WHOSE FIRST BATCH THE SERVICE WITHHOLDS AN ENTRY OF IS NOT KNOWN, NOT COUNTED AGAINST NOW, AND THE DIRECTORY REFUSES', async () => {
    heldBy([ADA, BO]);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* Ada retires Jo and her device anchors the retirement. */
    await retiredBy(JO, ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    const version = store.directoryFilingsOf(CO).length;
    const header = store.keptTreeOf(CO).headers.at(-1)!;
    const retirement = header.changes.find((c) => c.leaf.store === 'directory' && c.leaf.version === version)?.leaf;
    expect(retirement).toBeDefined();
    /* The service leaves the retirement's entry out of the headers it serves, so the batch that first anchored it cannot be checked. */
    const withholding = async (path: string, init?: RequestInit): Promise<any> => {
      const r = await apiAs('ada')(path, init);
      if (!path.includes('/manifest/tree/headers') || r === null || !Array.isArray(r.entries)) return r;
      return { ...r, entries: r.entries.filter((e: ManifestEntry) => entryIdOf(e) !== retirement!.entryId) };
    };
    const read = await recordsHeldHere({ ...doorsOf(ADA), tree: treeServiceFor(withholding) }, {});
    expect(read.records.stopped).toMatchObject({ stop: 'not-given' });
    /* RED WHEN: a version a stopped batch may name is counted against the account now (undefined), where the retirement would be
     * believed or forgotten on the chain's word now, not as anchored. */
    expect(read.records.held!(version)).toBeNull();
    /* RED WHEN: the directory readers act on - who may act, who is wrapped to, the roster - is replayed while the check is stopped. */
    await expect(directoryHere({ ...acmeDirectoryDeps(), anchored: anchoredOver(withholding, CO, acmeChain.read) }))
      .rejects.toThrow(/the company's records cannot be read past a batch this device cannot open: the service did not give .* of batch \d+ of the company's records/u);
    /* Served whole, the retirement is believed as anchored. */
    expect(await retiredOf(JO)).toEqual({});
  });

  it('THE SIGNER OF A RETIREMENT REMOVED AFTER IT WAS ANCHORED: THE RETIRED SEAT STAYS RETIRED, AND A BATCH IT ANCHORS IS DISHONEST', async () => {
    heldBy([ADA, BO]);
    /* Ada retires Bo, and her device anchors the change; the chain still holds Bo. */
    await retiredBy(BO, ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    expect(await retiredOf(BO)).toEqual({});
    /* Ada is removed from the account; Bo is still on it. */
    heldBy([BO]);
    /* RED WHEN: Ada's retirement of Bo, anchored while she held the account, is counted against the account now and forgotten. */
    expect(await retiredOf(BO)).toEqual({});
    /* Bo's device files a proposal, enters it and anchors a batch of it itself: the chain takes any signer's call. */
    const bos = await aRecordFiledBy(BO, 'prp_bo_retired_p2', 'proposal');
    await BO.entered.enter([bos]);
    const entry = (await waitingFor(BO)).find((e) => e.id === 'prp_bo_retired_p2')!;
    const header = await handMade(BO, [entry], holdersOf(acmeHeldNow()));
    acmeChain.move(acmeChain.head(), treeBatchOf(header), header.held, header.tag);
    const f = await heldNow(ADA, asking('proposal', 'prp_bo_retired_p2'));
    /* RED WHEN: a batch anchored by a retired seat is checked as honest, because its retirement's signer has since left. */
    expect(f.stopped).toMatchObject({ stop: 'dishonest', anchoredBy: BO.statement.signingKey });
    expect(f.history.has('company:proposal:prp_bo_retired_p2')).toBe(false);
  });

  it("A BATCH WHOSE HEADER NAMES OTHER HOLDERS THAN THE CALL CHECKED NEVER REACHES THE CHAIN'S HEAD", async () => {
    heldBy([ADA, BO]);
    /* The batch Bo anchored as a retired seat, above, which every device stops at, is taken off the test's chain: this case is this header's own. */
    acmeChain.landed.pop();
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_other_holders')]);
    const e = (await waitingFor(ADA)).find((x) => x.id === 'pol_other_holders')!;
    const truly = holdersOf(acmeHeldNow());
    /* The header says two approvals; the call names the one the account requires, and lands. */
    const header = await handMade(ADA, [e], { ...truly, approvals: 2 });
    acmeChain.landAt(headAfterAs(acmeChain.head(), treeBatchOf(header), truly, header.tag));
    /* RED WHEN: the head is reached without the holders the header names - a header could name holders no call checked. */
    expect((await heldNow(ADA)).stopped).toMatchObject({ stop: 'not-given' });
  });
});

