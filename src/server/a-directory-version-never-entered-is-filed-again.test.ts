/**
 * **A DIRECTORY VERSION NEVER ENTERED HOLDS NOTHING UNANCHORED, AND ITS CHANGE
 * IS NEVER LOST FOR GOOD.** A version of the company's directory filed and never
 * entered is passed over by the next header that anchors a later version: no
 * device applies its change, since nothing unanchored is believed. The directory
 * then disagrees with who holds the account on chain, and says so with the way
 * past it: a seat's own entry is filed again, as a new version, by that seat's
 * own device the next time it enters the company, and anchored like any other.
 *
 * Over real HTTP with the company's directory and record tree as the service
 * keeps them, and the test's chain. Bo's entry (version 2) and his role (version
 * 3) are filed before anything anchors them; Ada's device anchors a later
 * version while the service keeps both out of what it hands her.
 */
import { describe, expect, it } from 'vitest';
import { sign, type Hex } from '../core/crypto.js';
import { directoryChangeMessage, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import {
  anchoredOnTheWayIn, anchorServiceFor, anchorTheRecordsHere, recordsHeldHere, treeHeaderHere, type AnchorDoors,
} from 'vaults-web-shared/records-anchored-here.js';
import { signManifestEntry } from '../midnight/record-manifest.js';
import { treeBatchOf } from '../midnight/record-tree.js';
import { passedOverSaid } from 'vaults-web-shared/vault-page-doors.js';
import { anchorFunctions, holdersOf, tagInATest, anchorSentInATest } from '../testing/record-tree-double.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectory, chains, acmeDirectoryWithItsFold, acmeHeldNow, ADA, ADDRESS, apiAs, aRecordFiledBy, BO, CO, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

/** A seat's device anchoring, the service handing it the directory's filings as `filings` makes them. */
const doorsOf = (s: Seat, filings: (all: readonly DirectoryFiling[]) => readonly DirectoryFiling[] = (all) => all, kept = treeKeptInMemory()): AnchorDoors => ({
  accountId: CO,
  changes: kept.changes,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceFor(apiAs(s.person)),
  tree: treeServiceFor(apiAs(s.person)),
  directory: () => acmeDirectoryWithItsFold(),
  directoryFilings: async () => filings(store.directoryFilingsOf(CO)),
  fileDirectory: async (filing) => {
    const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${filing.version}`, { method: 'POST', body: JSON.stringify(filing) });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  },
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_c, tx) => {
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      acmeChain.move(previous, batch, held, tag);
    },
    sealedProposals: async (c) => store.listProposals(c),
    foundingRecords: anchorServiceFor(apiAs(s.person)).foundingRecords,
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
});

/** `seat`'s role set by Ada's quorum of one, the account's approvals, as the directory's next version. */
const roleSet = async (seat: Seat, role: string): Promise<number> => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { kind: 'role', seat: seat.seat, role, threshold: 1, signatures: [] } as unknown as DirectoryChange;
  const signature = sign(directoryChangeMessage(CO, version, unsigned), ADA.signingSecret);
  const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
  const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return version;
};
/** Ada's role set again by her own quorum of one: a change that rests on no version before it but her own entry. */
const adaRoleAgain = () => roleSet(ADA, 'admin');

describe('A DIRECTORY VERSION NEVER ENTERED', () => {
  /* What Bo's device keeps of the company's record tree, across its ways in. */
  const bos = treeKeptInMemory();
  it('IS ANCHORED PAST AND NOT APPLIED: THE DIRECTORY DISAGREES WITH THE CHAIN AND SAYS THE WAY PAST IT', async () => {
    const four = await adaRoleAgain();
    /* Ada's device is handed every filing but Bo's entry and role, so it witnesses only version 4, and anchors past 2 and 3. */
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== 2 && f.version !== 3)));
    const here = await acmeDirectory();
    expect([...here.records.directory.keys()].sort()).toEqual([1, four]);
    /* RED WHEN: a directory version the anchor passed over is applied - an entry nothing anchored believed. */
    expect(here.dir.seats.map((x) => x.seat)).not.toContain(BO.seat);
    expect(here.dir.seats.find((x) => x.seat === ADA.seat)?.role).toBe('admin');
    /* The chain holds Bo's seat, and the directory holds no entry for it: said, with the way past it. */
    expect(here.holders.seats).toContain(BO.seat);
    /* RED WHEN: the versions passed over are left unsaid, or said without the way past them. */
    expect(here.passedOver?.map((f) => f.version)).toEqual([2, 3]);
    expect(passedOverSaid(here)).toMatch(/passed over versions 2, 3 of its directory .* the seat whose entry version 2 holds files it again by opening the company on its own device; the change signed for version 3 is filed again, under the signatures it was made with, by the next device of the company that may anchor as it opens the company, once the entry of the seat it rests on is filed again/u);
  });

  it('IS FILED AGAIN AS A NEW VERSION BY ITS OWN SEAT\'S DEVICE ON THE WAY IN, AND ANCHORED, SO ITS SEAT IS BELIEVED', async () => {
    const before = store.directoryFilingsOf(CO).length;
    /* RED WHEN: the seat's device does not file its own passed-over entry again, or the service refuses it as a seat taken. */
    /* RED WHEN: the entry filed again waits for a later anchor, so a change of who holds the account can lose it first. */
    expect(await anchoredOnTheWayIn(doorsOf(BO))).toMatchObject({ filedAgain: 'own-entry', anchored: 1 });
    const again = store.directoryFilingsOf(CO);
    expect(again.length).toBe(before + 1);
    expect(again.at(-1)!.change).toEqual(again[1]!.change);
    /* Anchored by the next anchor, like any other version. */
    await anchorTheRecordsHere(doorsOf(ADA));
    const here = await acmeDirectory();
    /* RED WHEN: the entry filed again is never anchored, so the seat stays unbelieved for good. */
    expect(here.dir.seats.map((x) => x.seat)).toContain(BO.seat);
    /* Filed again once: a second way in files nothing. */
    /* The service hands Bo's anchor every filing but the change his device files again, so that change is left unanchored. */
    expect(await anchoredOnTheWayIn(doorsOf(BO, (all) => all.filter((f) => f.signedAt === undefined), bos))).toMatchObject({ filedAgain: 'directory-changes' });
  });

  it('A QUORUM\'S CHANGE PASSED OVER IS FILED AGAIN UNDER ITS OWN SIGNATURES BY A DEVICE THAT MAY ANCHOR, KEPT THERE UNTIL ANCHORED, AND APPLIED', async () => {
    /* Bo's role (version 3) rested on his entry, passed over with it. His entry filed again, his seat may anchor: his device filed the role again on its last way in. */
    const filings = store.directoryFilingsOf(CO);
    const at = filings.length;
    /* RED WHEN: no device files a quorum's change passed over again - the change is lost for good. */
    /* RED WHEN: the change is filed again under other signatures, or without the version they were made for. */
    expect(filings.at(-1)).toEqual({ company: CO, version: at, change: filings[2]!.change, signedAt: 3 });
    /* RED WHEN: the device filing it keeps nothing, so a change the service passes over again is lost with the service. */
    expect(await bos.changes.all(CO)).toEqual([{ signedAt: 3, change: filings[2]!.change }]);
    /* The service passes it over again: the next anchors are handed every filing but it. */
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== at)));
    await adaRoleAgain();
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== at)));
    expect((await acmeDirectory()).passedOver?.map((f) => f.version)).toContain(at);
    /* Bo keeps the role his invitation gave him until the change is applied. */
    expect((await acmeDirectory()).dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('admin');
    /*
     * RED WHEN: a change filed again and passed over again is not filed again from what its device kept, so a service
     * that no longer serves it - here, serving none of the changes not applied - drops it for good.
     */
    /** Acme's directory read while Bo's seat has left the account on chain. */
    const withoutBo = async <T>(read: () => Promise<T>): Promise<T> => {
      const was = chains.get(CO)!;
      chains.set(CO, { seats: { ...was.seats, seats: was.seats.seats.filter((x) => x !== BO.seat) }, approvals: was.approvals, seatBar: was.seatBar });
      try { return await read(); } finally { chains.set(CO, was); }
    };
    /* RED WHEN: the service files a change again that disagrees with who holds the account now: one rule for the service and every device. */
    const next = store.directoryFilingsOf(CO).length + 1;
    const offChain = await withoutBo(() => sendAs('ada')(`/api/accounts/${CO}/directory/${next}`, {
      method: 'POST', body: JSON.stringify({ company: CO, version: next, change: filings[2]!.change, signedAt: 3 }),
    }));
    expect([offChain.status, (offChain.body as { refused?: string }).refused]).toEqual([422, 'not-as-the-chain-holds']);
    /* RED WHEN: a change is filed before it is kept, so one whose filing fails is kept nowhere; a filing that fails holds the way in back. */
    const fresh = treeKeptInMemory();
    const failing = { ...doorsOf(BO, (all) => all, fresh), fileDirectory: async () => { throw new Error('the service is away'); } };
    expect(await anchoredOnTheWayIn(failing)).not.toHaveProperty('notAnchored');
    expect((await fresh.changes.all(CO)).map((k) => k.signedAt)).toEqual([3]);
    const servedNone = { ...doorsOf(BO, (all) => all.filter((f) => f.signedAt === undefined), bos), directory: async () => ({ ...(await acmeDirectoryWithItsFold()), notApplied: [] }) };
    /* RED WHEN: a change filed again from what the device kept is not anchored at once by that device. */
    expect(await anchoredOnTheWayIn(servedNone)).toMatchObject({ filedAgain: 'directory-changes' });
    expect(store.directoryFilingsOf(CO).at(-1)).toMatchObject({ change: filings[2]!.change, signedAt: 3 });
    const pending = store.directoryFilingsOf(CO).at(-1)!.version;
    /* Not yet anchored, Bo's seat leaves the chain: the role filed again no longer agrees with it, and is said not applied, with why. */
    const unanchored = await withoutBo(() => acmeDirectory());
    /* RED WHEN: a change filed again that the replay refuses is not said, or said without why. */
    expect(unanchored.refiledRefused).toEqual([{ version: pending, signedAt: 3, why: 'not-as-the-chain-holds' }]);
    expect(passedOverSaid(unanchored)).toMatch(new RegExp(`version ${pending}, the change signed for version 3 filed again, is not applied: that change, filed again, does not agree with who holds the company's account on the chain now`, 'u'));
    /* RED WHEN: a change passed over again after it was filed again is said as if nothing were wrong: the service may be withholding it. */
    expect(passedOverSaid(await acmeDirectory())).toMatch(/the change signed for version 3 was passed over again after it was filed again: if it keeps happening, the service is withholding it from the devices that anchor/u);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* RED WHEN: the change filed again and anchored is not applied. */
    expect((await acmeDirectory()).dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('approver');
    /* RED WHEN: a change anchored at last is kept and filed again for ever. */
    expect(await anchoredOnTheWayIn(doorsOf(BO, (all) => all, bos))).not.toHaveProperty('filedAgain');
    expect(await bos.changes.all(CO)).toEqual([]);
    /*
     * Anchored, it is counted against who held the account as it was anchored, like any version: RED WHEN Bo's seat leaving the
     * chain later undoes, on every device, the role a quorum gave it and the anchor holds.
     */
    const anchored = await withoutBo(() => acmeDirectoryWithItsFold());
    expect(anchored.refiledRefused).toEqual([]);
    expect(anchored.dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('approver');
    /* Bo made an initiator, passed over; a day on, Ada's way in files it again and anchors it at once. */
    const initiator = await roleSet(BO, 'initiator');
    await adaRoleAgain();
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== initiator)));
    const dayOn = { ...doorsOf(ADA), now: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) };
    /* RED WHEN: filing a change again holds the way in back from the anchor that is due - a service passing changes over could put it off for ever. */
    expect(await anchoredOnTheWayIn(dayOn)).not.toHaveProperty('waits');
    expect((await acmeDirectory()).dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('initiator');
  });

  it('A CHANGE FILED AGAIN THAT WOULD UNDO A LATER CHANGE IS NOT FILED, REFUSED BY THE SERVICE, AND SAID WITH WHY', async () => {
    /* Bo made an admin, passed over; then a viewer, anchored. */
    const admin = await roleSet(BO, 'admin');
    await adaRoleAgain();
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== admin)));
    await roleSet(BO, 'viewer');
    await anchorTheRecordsHere(doorsOf(ADA));
    const filings = store.directoryFilingsOf(CO);
    /* RED WHEN: a device files again a change that would reverse a later one. */
    expect(await anchoredOnTheWayIn(doorsOf(ADA))).not.toHaveProperty('filedAgain');
    expect(store.directoryFilingsOf(CO).length).toBe(filings.length);
    /* RED WHEN: the service files it anyway: one rule for the service and every device. */
    const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${filings.length + 1}`, {
      method: 'POST', body: JSON.stringify({ company: CO, version: filings.length + 1, change: filings[admin - 1]!.change, signedAt: admin }),
    });
    expect([r.status, (r.body as { refused?: string }).refused]).toEqual([422, 'reverses-a-later-change']);
    const here = await acmeDirectory();
    expect(here.dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('viewer');
    /* RED WHEN: a change passed over that will not be filed again is said as if it will be, or without why. */
    expect(passedOverSaid(here)).toMatch(new RegExp(`the change signed for version ${admin} is not filed again: that change, filed again, would undo a change to the same seat applied after the version it was signed for`, 'u'));
  });

});

describe('A HEADER FILED AGAIN IS JUDGED BY WHO ITS SEAT WAS WHEN IT WAS SIGNED', () => {
  it('A HEADER ADA ANCHORED AS AN ADMIN IS KEPT WHEN BO HANDS IT IN AFTER SHE IS MADE A VIEWER', async () => {
    await aRecordFiledBy(ADA, 'pol_then_k1').then((e) => ADA.entered.enter([e]));
    await anchorTheRecordsHere(doorsOf(ADA));
    const hers = store.keptTreeOf(CO).headers.at(-1)!;
    expect(hers.anchoredBy.publicKey).toBe(ADA.statement.signingKey);
    await roleSet(ADA, 'viewer');
    /* RED WHEN: a header filed again is judged by its seat's role now - a seat demoted since could never have its honest header filed again. */
    const r = await sendAs('bo')(`/api/accounts/${CO}/manifest/tree/headers`, { method: 'POST', body: JSON.stringify({ header: hers }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe('A DIRECTORY VERSION NEVER ENTERED, AND WHO MAY ANCHOR', () => {
  it('A SEAT WHOSE ROLE RESTS ON A VERSION PASSED OVER MAY NOT ANCHOR: A HEADER IT ANCHORS ANYWAY STOPS EVERY DEVICE AS DISHONEST', async () => {
    /* Ada is an admin again. Bo is made a viewer, anchored; then an admin, passed over by Ada's next anchor. His device anchors anyway, past the service's own check. */
    await roleSet(ADA, 'admin');
    await roleSet(BO, 'viewer');
    await anchorTheRecordsHere(doorsOf(ADA));
    const admin = await roleSet(BO, 'admin');
    await adaRoleAgain();
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== admin)));
    expect((await acmeDirectory()).dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('viewer');
    const entry = signManifestEntry(CO, await aRecordFiledBy(BO, 'prp_passedover01', 'proposal'), BO.signingSecret as Hex);
    expect(store.enterInManifest(CO, [entry])).toBeNull();
    const { reached } = (await recordsHeldHere(doorsOf(ADA), {})).records;
    const made = (await treeHeaderHere({
      accountId: CO, tree: treeServiceFor(apiAs('bo')), signingSecret: BO.signingSecret as Hex, tag: tagInATest(BO.signingSecret as Hex), held: holdersOf(acmeHeldNow()), at: new Date('2026-10-11T00:00:00Z'),
    }, reached, [entry]))!;
    expect(store.fileTreeHeader(CO, made.header)).toBeNull();
    acmeChain.move(reached.head, treeBatchOf(made.header), made.header.held, made.header.tag);
    /* RED WHEN: the version passed over is judged by who holds the account now as a header is checked - Bo read as an approver who may anchor. */
    expect((await recordsHeldHere(doorsOf(ADA), {})).records.stopped).toMatchObject({
      stop: 'dishonest', why: expect.stringMatching(/anchored by a key no seat that may anchor held/u),
    });
  });
});
