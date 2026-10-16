/**
 * **A ROLE OR RETIREMENT CHANGE IS COUNTED AGAINST WHO HELD THE ACCOUNT WHEN IT
 * WAS ANCHORED.** A device replays the company's directory from every filing,
 * and each change's quorum is counted against the holders the batch that first
 * anchored that version names - the approvals the account required and the
 * seats its signer tree held, which the account's anchor call checked as it
 * ran - never against who holds the account now, and never against the state
 * after the call's block. So a signer of a change who leaves the account later
 * changes nothing about it: a promotion they signed still opens every batch the
 * promoted seat anchored, and a demotion they signed still stops a batch the
 * demoted seat anchors. And a signer who leaves between a device's read and
 * its anchor landing makes the account refuse that anchor: the device reads
 * again and anchors again, and every header is checked.
 *
 * Over real HTTP with the company's record tree and directory as the service
 * keeps them. The chain is the test's: one head, moved on only by a call naming
 * the head and the holders it holds, each call kept with the committee as it
 * landed.
 */
import { describe, expect, it } from 'vitest';
import { sign, type Hex } from '../core/crypto.js';
import type { Role } from '../core/types.js';
import { directoryEntry, entryIdOf, signManifestEntry, type BatchHolders, type ManifestEntry } from '../midnight/record-manifest.js';
import { treeBatchOf, type TreeHeader } from '../midnight/record-tree.js';
import { newestAnchored, type RecordsAsked, type RecordsHeld } from '../midnight/records-held.js';
import { directoryChangeMessage, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorServiceFor, anchorTheRecordsHere, recordsHeldHere, treeHeaderHere, type AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryWithItsFold, acmeDirectory, acmeDirectoryDeps, acmeHeldNow, ADA, ADDRESS, apiAs, aRecordFiledBy, BO, chains, CO, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';
import { anchoredOver, anchorFunctions, headAfter as headAfterAs, holdersOf, tagInATest, anchorSentInATest } from '../testing/record-tree-double.js';
import { directoryHere } from 'vaults-web-shared/vault-page-doors.js';

aCompanyOfTwoSeats();

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

/** The account held, on the test's chain, by these seats alone, at the approvals it requires. */
const heldBy = (seats: readonly Seat[]) =>
  chains.set(CO, { seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1, seatBar: 1 });

/** The next directory version: a change of `seat`'s role signed by `by` as a quorum of one, the account's approvals. */
const roleSetBy = async (seat: Seat, role: Role, by: Seat) => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { kind: 'role', seat: seat.seat, role, threshold: 1, signatures: [] } as unknown as DirectoryChange;
  const signature = sign(directoryChangeMessage(CO, version, unsigned), by.signingSecret);
  const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: by.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
  const r = await sendAs(by.person)(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};
const roleOf = async (s: Seat) => (await acmeDirectory()).dir.seats.find((x) => x.seat === s.seat)?.role;
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
  it('THE SIGNER OF A PROMOTION REMOVED AFTER THE PROMOTED SEAT ANCHORED: EVERY HEADER IS STILL CHECKED, AND THE SEAT KEEPS ITS ROLE', async () => {
    heldBy([ADA, BO]);
    /* Ada sets Bo to viewer; Bo, a quorum of one, sets himself back to approver. */
    await roleSetBy(BO, 'viewer', ADA);
    await roleSetBy(BO, 'approver', BO);
    const bos = await aRecordFiledBy(BO, 'prp_bo_promoted_p1', 'proposal');
    await BO.entered.enter([bos]);
    /* Bo files a proposal and anchors it, with the directory's versions witnessed in the same batch. */
    expect((await anchorTheRecordsHere(doorsOf(BO))).anchored).toBeGreaterThan(0);
    expect((await heldNow(ADA)).stopped).toBeNull();
    /* Bo is removed from the account. */
    heldBy([ADA]);
    const f = await heldNow(ADA, asking('proposal', 'prp_bo_promoted_p1'));
    /* RED WHEN: Bo's own promotion is counted against the account now - he has left it, so it is forgotten, his role is viewer
     * again and the batch he anchored stops every device's check for good. */
    expect(f.stopped).toBeNull();
    expect(newestOf(f, 'company:proposal:prp_bo_promoted_p1')).toEqual({ version: 1, digest: bos.digest });
    /* RED WHEN: the directory a device acts on is replayed against the account now - Bo's anchored promotion is forgotten. */
    expect(await roleOf(BO)).toBe('approver');
  });

  it('A DEMOTION SIGNED AT THE THRESHOLD, ANCHORED IN A BLOCK WHOSE STATE HOLDS A HIGHER POLICY BAR, IS NOT BELIEVED, THOUGH THE BAR FALLS AFTER', async () => {
    heldBy([ADA, BO]);
    const before = await roleOf(BO);
    await roleSetBy(BO, 'viewer', ADA);
    /* The account stores a policy bar of two before the demotion is anchored: a change of who is seated then needs two. */
    chains.set(CO, { ...chains.get(CO)!, seatBar: 2 });
    expect((await anchorTheRecordsHere(doorsOf(ADA))).anchored).toBeGreaterThan(0);
    expect(acmeChain.landed.at(-1)?.seatBar).toBe(2);
    /* The bar falls back to the threshold afterwards. */
    chains.set(CO, { ...chains.get(CO)!, seatBar: 1 });
    /* RED WHEN: an anchored demotion is held to the threshold its batch's header names, not the seat bar of the block it landed in. */
    expect(await roleOf(BO)).toBe(before);
    expect(before).not.toBe('viewer');
  });

  it('A DEMOTION SIGNED AT THE THRESHOLD AND NOT YET ANCHORED IS NOT BELIEVED WHILE THE WALLET READS A HIGHER POLICY BAR ON THE ACCOUNT', async () => {
    heldBy([ADA, BO]);
    const before = await roleOf(BO);
    await roleSetBy(BO, 'viewer', ADA);
    expect(await roleOf(BO)).toBe('viewer');
    /* The account now stores a policy bar of two, as the person's own wallet reads it. */
    chains.set(CO, { ...chains.get(CO)!, seatBar: 2 });
    /* RED WHEN: a device judges a demotion not yet anchored against the account's threshold, as its wallet read it, below its seat bar. */
    expect(await roleOf(BO)).toBe(before);
    chains.set(CO, { ...chains.get(CO)!, seatBar: 1 });
  });

  it('TWO ANCHORS IN ONE BLOCK: A CHANGE FIRST ANCHORED AT A HEAD THE HISTORY NEVER SHOWS IS COUNTED AGAINST THE HOLDERS ITS BATCH NAMED', async () => {
    heldBy([ADA, BO]);
    await roleSetBy(BO, 'initiator', ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    const first = acmeChain.landed.length - 1;
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_same_block_b1')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* Both calls landed in one block: the history shows the state after it, so the head between them is never read. */
    acmeChain.landed.splice(first, 1);
    heldBy([BO]);
    /* RED WHEN: a change first anchored at a head the history never shows is read as anchored with nobody known to hold the
     * account - left unbelieved for good, though its batch names who held the account and the call checked them. */
    expect(await roleOf(BO)).toBe('initiator');
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
    expect(await roleOf(BO)).toBe('initiator');
  });

  it("A CHANGE'S SIGNER REMOVED BETWEEN AN ANCHOR'S BUILD AND ITS LANDING: THE ANCHOR IS REFUSED, ANCHORED AGAIN, AND EVERY HEADER IS CHECKED", async () => {
    heldBy([ADA, BO]);
    /* Bo is an approver, as anchored while both hold the account. */
    await roleSetBy(BO, 'approver', ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* Ada promotes Bo to admin, and Bo files a record only an admin may file: both wait for the next anchor. */
    await roleSetBy(BO, 'admin', ADA);
    const bos = await aRecordFiledBy(BO, 'pol_bo_promoted_race', 'policy');
    await BO.entered.enter([bos]);
    refused.length = 0;
    /* Bo's device judges its batch with Ada seated; before its anchor lands, Ada's removal lands. */
    meanwhile = () => { heldBy([BO]); };
    expect((await anchorTheRecordsHere(doorsOf(BO))).anchored).toBeGreaterThan(0);
    /* RED WHEN: the anchor call does not bind who held the account as the batch was judged - it lands, and nothing is refused. */
    expect(refused).toEqual(['the account\'s signers changed after this device judged the batch']);
    const f = await heldNow(BO, asking('policy', 'pol_bo_promoted_race'));
    /* RED WHEN: the batch lands judged against Ada's seat and is counted against the account after its block: the promotion is
     * forgotten, Bo's admin-only record fails and every device stops at that batch for good. */
    expect(f.stopped).toBeNull();
    /* Judged again against who holds the account now: Ada's promotion, signed by a seat that left before it was anchored, is
     * not believed, and Bo's admin-only record is not anchored. */
    expect(await roleOf(BO)).toBe('approver');
    expect(f.history.has('company:policy:pol_bo_promoted_race')).toBe(false);
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
    await roleSetBy(BO, 'approver', ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    expect(await roleOf(BO)).toBe('approver');
    await roleSetBy(BO, 'initiator', ADA);
    /* Ada's device witnesses the new directory version, as an anchoring device does. */
    const v = signManifestEntry(CO, directoryEntry(store.directoryFilingsOf(CO).at(-1)!), ADA.signingSecret as Hex);
    await manifestServiceFor(apiAs('ada')).enter(CO, [v]);
    /* Ada names the root the account holds, but a seat list of her own: one the root does not have. */
    const named = holdersOf(acmeHeldNow());
    const forged: BatchHolders = { ...named, signers: [...named.signers, ADA.seat as Hex] };
    const header = await handMade(ADA, [v], forged);
    acmeChain.move(acmeChain.head(), treeBatchOf(header), header.held, header.tag);
    /* RED WHEN: the seats a header names are believed without making the root the account's call checked. */
    expect(await roleOf(BO)).toBe('approver');
  });

  it('A DIRECTORY VERSION WHOSE FIRST BATCH THE SERVICE WITHHOLDS AN ENTRY OF IS NOT KNOWN, NOT COUNTED AGAINST NOW, AND THE DIRECTORY REFUSES', async () => {
    heldBy([ADA, BO]);
    await roleSetBy(BO, 'approver', ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* Ada demotes Bo to viewer and her device anchors the demotion. */
    await roleSetBy(BO, 'viewer', ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    const version = store.directoryFilingsOf(CO).length;
    const header = store.keptTreeOf(CO).headers.at(-1)!;
    const demotion = header.changes.find((c) => c.leaf.store === 'directory' && c.leaf.version === version)?.leaf;
    expect(demotion).toBeDefined();
    /* The service leaves the demotion's entry out of the headers it serves, so the batch that first anchored it cannot be checked. */
    const withholding = async (path: string, init?: RequestInit): Promise<any> => {
      const r = await apiAs('ada')(path, init);
      if (!path.includes('/manifest/tree/headers') || r === null || !Array.isArray(r.entries)) return r;
      return { ...r, entries: r.entries.filter((e: ManifestEntry) => entryIdOf(e) !== demotion!.entryId) };
    };
    const read = await recordsHeldHere({ ...doorsOf(ADA), tree: treeServiceFor(withholding) }, {});
    expect(read.records.stopped).toMatchObject({ stop: 'not-given' });
    /* RED WHEN: a version a stopped batch may name is counted against the account now (undefined), where the demotion would be
     * believed or forgotten on the chain's word now, not as anchored. */
    expect(read.records.held!(version)).toBeNull();
    /* RED WHEN: the directory readers act on - who may act, who is wrapped to, the roster - is replayed while the check is stopped. */
    await expect(directoryHere({ ...acmeDirectoryDeps(), anchored: anchoredOver(withholding, CO, acmeChain.read) }))
      .rejects.toThrow(/the company's records cannot be read past a batch this device cannot open: the service did not give .* of batch \d+ of the company's records/u);
    /* Served whole, the demotion is believed as anchored. */
    expect(await roleOf(BO)).toBe('viewer');
  });

  it('THE SIGNER OF A DEMOTION REMOVED AFTER IT WAS ANCHORED: THE DEMOTED SEAT STAYS DEMOTED, AND A BATCH IT ANCHORS IS DISHONEST', async () => {
    heldBy([ADA, BO]);
    /* Ada demotes Bo to viewer, and her device anchors the change. */
    await roleSetBy(BO, 'viewer', ADA);
    await anchorTheRecordsHere(doorsOf(ADA));
    expect(await roleOf(BO)).toBe('viewer');
    /* Ada is removed from the account; Bo is still on it. */
    heldBy([BO]);
    /* RED WHEN: Ada's demotion, anchored while she held the account, is counted against the account now and forgotten. */
    expect(await roleOf(BO)).toBe('viewer');
    /* Bo's device files a proposal, enters it and anchors a batch of it itself: the chain takes any signer's call. */
    const bos = await aRecordFiledBy(BO, 'prp_bo_demoted_p2', 'proposal');
    await BO.entered.enter([bos]);
    const entry = (await waitingFor(BO)).find((e) => e.id === 'prp_bo_demoted_p2')!;
    const header = await handMade(BO, [entry], holdersOf(acmeHeldNow()));
    acmeChain.move(acmeChain.head(), treeBatchOf(header), header.held, header.tag);
    const f = await heldNow(ADA, asking('proposal', 'prp_bo_demoted_p2'));
    /* RED WHEN: a batch anchored by a seat demoted to viewer is checked as honest, because the demotion's signer has since left. */
    expect(f.stopped).toMatchObject({ stop: 'dishonest', anchoredBy: BO.statement.signingKey });
    expect(f.history.has('company:proposal:prp_bo_demoted_p2')).toBe(false);
  });

  it("A BATCH WHOSE HEADER NAMES OTHER HOLDERS THAN THE CALL CHECKED NEVER REACHES THE CHAIN'S HEAD", async () => {
    heldBy([ADA, BO]);
    /* The batch Bo anchored as a viewer, above, which every device stops at, is taken off the test's chain: this case is this header's own. */
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

