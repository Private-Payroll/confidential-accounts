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
 * keeps them, and the test's chain. Bo's entry (version 2) and his retirement
 * (version 3) are filed before anything anchors them; Ada's device anchors a
 * later version while the service keeps both out of what it hands her.
 */
import { describe, expect, it } from 'vitest';
import { sign, type Hex } from '../core/crypto.js';
import { directoryChangeMessage, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import {
  anchoredOnTheWayIn, anchorServiceFor, anchorTheRecordsHere, type AnchorDoors,
} from 'vaults-web-shared/records-anchored-here.js';
import { passedOverSaid } from 'vaults-web-shared/vault-page-doors.js';
import { anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectory, chains, acmeDirectoryWithItsFold, ADA, ADDRESS, apiAs, aRecordFiledBy, BO, CO, LABEL, seatOf, sendAs, store,
  type Seat,
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

/** `seat` retired by Ada's quorum of one, the account's approvals, keeping its versions up to `upTo` of one record, as the directory's next version. */
const retiredBy = async (seat: Seat, upTo = 0): Promise<number> => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { kind: 'retire', seat: seat.seat, filedUpTo: upTo === 0 ? {} : { 'policy:pol_kept': upTo }, threshold: 1, signatures: [] } as unknown as DirectoryChange;
  const signature = sign(directoryChangeMessage(CO, version, unsigned), ADA.signingSecret);
  const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
  const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return version;
};
/** Another entry for Ada's seat under a new filing key: a version the service keeps and every device passes over, resting on nothing. */
const adaAgain = async (): Promise<number> => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify({ company: CO, version, change: { kind: 'claim', entry: seatOf('ada', 1).entry } }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return version;
};
/** A seat Ada's seat invited, entered now and held by the account from now on. */
const seatedNow = async (person: string, n: number): Promise<Seat> => {
  const s = seatOf(person, n, LABEL, ADDRESS, CO, ADA);
  const account = store.getAccount(CO)!;
  store.putAccount({ ...account, memberUserIds: [...account.memberUserIds, person] });
  const held = chains.get(CO)!;
  chains.set(CO, { ...held, seats: { ...held.seats, committee: [...held.seats.committee, s.committeeKey], seats: [...held.seats.seats, s.seat] } });
  const version = store.directoryFilingsOf(CO).length + 1;
  const r = await sendAs(person)(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify({ company: CO, version, change: { kind: 'claim', entry: s.entry } }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return s;
};

describe('A DIRECTORY VERSION NEVER ENTERED', () => {
  /* What Bo's device keeps of the company's record tree, across its ways in. */
  const bos = treeKeptInMemory();
  it('IS ANCHORED PAST AND NOT APPLIED: THE DIRECTORY DISAGREES WITH THE CHAIN AND SAYS THE WAY PAST IT', async () => {
    await retiredBy(BO);
    const four = await adaAgain();
    /* Ada's device is handed every filing but Bo's entry and retirement, so it witnesses only version 4, and anchors past 2 and 3. */
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== 2 && f.version !== 3)));
    const here = await acmeDirectory();
    expect([...here.records.directory.keys()].sort()).toEqual([1, four]);
    /* RED WHEN: a directory version the anchor passed over is applied - an entry nothing anchored believed. */
    expect(here.dir.seats.map((x) => x.seat)).not.toContain(BO.seat);
    expect(here.dir.seats.find((x) => x.seat === ADA.seat)?.retired).toBeNull();
    /* The chain holds Bo's seat, and the directory holds no entry for it: said, with the way past it. */
    expect(here.holders.seats).toContain(BO.seat);
    /* RED WHEN: the versions passed over are left unsaid, or said without the way past them. */
    expect(here.passedOver?.map((f) => f.version)).toEqual([2, 3]);
    expect(passedOverSaid(here)).toMatch(/passed over versions 2, 3 of its directory .* the seat whose entry version 2 holds files it again in its next action in its wallet; the change signed for version 3 is filed again, under the signatures it was made with, at the next action a seat of the company that may anchor makes in its wallet, once the entry of the seat it rests on is filed again/u);
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
    /* Bo's retirement (version 3) rested on his entry, passed over with it. His entry filed again, his seat may anchor: his device filed the retirement again on its last way in. */
    const filings = store.directoryFilingsOf(CO);
    const at = filings.length;
    /* RED WHEN: no device files a quorum's change passed over again - the change is lost for good. */
    /* RED WHEN: the change is filed again under other signatures, or without the version they were made for. */
    expect(filings.at(-1)).toEqual({ company: CO, version: at, change: filings[2]!.change, signedAt: 3 });
    /* RED WHEN: the device filing it keeps nothing, so a change the service passes over again is lost with the service. */
    expect(await bos.changes.all(CO)).toEqual([{ signedAt: 3, change: filings[2]!.change }]);
    /* The service passes it over again: the next anchors are handed every filing but it. */
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== at)));
    await adaAgain();
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== at)));
    expect((await acmeDirectory()).passedOver?.map((f) => f.version)).toContain(at);
    /* Bo is not retired until the change is applied. */
    expect((await acmeDirectory()).dir.seats.find((x) => x.seat === BO.seat)?.retired).toBeNull();
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
    /* RED WHEN: a change is filed before it is kept, so one whose filing fails is kept nowhere; a filing that fails holds the way in back. */
    const fresh = treeKeptInMemory();
    const failing = { ...doorsOf(BO, (all) => all, fresh), fileDirectory: async () => { throw new Error('the service is away'); } };
    expect(await anchoredOnTheWayIn(failing)).not.toHaveProperty('notAnchored');
    expect((await fresh.changes.all(CO)).map((k) => k.signedAt)).toEqual([3]);
    const servedNone = { ...doorsOf(BO, (all) => all.filter((f) => f.signedAt === undefined), bos), directory: async () => ({ ...(await acmeDirectoryWithItsFold()), notApplied: [] }) };
    /* RED WHEN: a change filed again from what the device kept is not anchored at once by that device. */
    expect(await anchoredOnTheWayIn(servedNone)).toMatchObject({ filedAgain: 'directory-changes' });
    expect(store.directoryFilingsOf(CO).at(-1)).toMatchObject({ change: filings[2]!.change, signedAt: 3 });
    /* Not yet anchored, Bo's seat leaves the chain: a retirement filed again is believed with its seat on the chain or off it. */
    /* RED WHEN: a retirement filed again is refused once the chain has removed its seat, which it may do before or after the retirement is filed. */
    expect((await withoutBo(() => acmeDirectory())).refiledRefused).toEqual([]);
    /* RED WHEN: a change passed over again after it was filed again is said as if nothing were wrong: the service may be withholding it. */
    expect(passedOverSaid(await acmeDirectory())).toMatch(/the change signed for version 3 was passed over again after it was filed again: if it keeps happening, the service is withholding it from the devices that anchor/u);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* RED WHEN: the change filed again and anchored is not applied. */
    expect((await acmeDirectory()).dir.seats.find((x) => x.seat === BO.seat)?.retired).toEqual({});
    /* RED WHEN: a change anchored at last is kept and filed again for ever. Bo, retired now, anchors nothing; a way in that may anchor lets it go. */
    expect(await anchoredOnTheWayIn(doorsOf(BO, (all) => all, bos))).not.toHaveProperty('filedAgain');
    expect(await anchoredOnTheWayIn(doorsOf(ADA, (all) => all, bos))).not.toHaveProperty('filedAgain');
    expect(await bos.changes.all(CO)).toEqual([]);
    /*
     * Anchored, it is counted against who held the account as it was anchored, like any version: RED WHEN Bo's seat leaving the
     * chain later undoes, on every device, the retirement a quorum signed and the anchor holds.
     */
    const anchored = await withoutBo(() => acmeDirectoryWithItsFold());
    expect(anchored.refiledRefused).toEqual([]);
    expect(anchored.dir.seats.find((x) => x.seat === BO.seat)?.retired).toEqual({});
    /* Cy is seated and retired, passed over; a day on, Ada's way in files it again and anchors it at once. */
    const CY = await seatedNow('cy', 3);
    await anchorTheRecordsHere(doorsOf(ADA));
    const cyOut = await retiredBy(CY);
    await adaAgain();
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== cyOut)));
    const dayOn = { ...doorsOf(ADA), now: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) };
    /* RED WHEN: filing a change again holds the way in back from the anchor that is due - a service passing changes over could put it off for ever. */
    expect(await anchoredOnTheWayIn(dayOn)).not.toHaveProperty('waits');
    expect((await acmeDirectory()).dir.seats.find((x) => x.seat === CY.seat)?.retired).toEqual({});
  });

  it('A CHANGE FILED AGAIN THAT WOULD UNDO A LATER CHANGE IS NOT FILED, REFUSED BY THE SERVICE, AND SAID WITH WHY', async () => {
    /* Dee seated; her retirement keeping one version, passed over; then her retirement keeping two, anchored. */
    const DEE = await seatedNow('dee', 4);
    await anchorTheRecordsHere(doorsOf(ADA));
    const first = await retiredBy(DEE, 1);
    await adaAgain();
    await anchorTheRecordsHere(doorsOf(ADA, (all) => all.filter((f) => f.version !== first)));
    await retiredBy(DEE, 2);
    await anchorTheRecordsHere(doorsOf(ADA));
    const filings = store.directoryFilingsOf(CO);
    /* RED WHEN: a device files again a change that would reverse a later one. */
    expect(await anchoredOnTheWayIn(doorsOf(ADA))).not.toHaveProperty('filedAgain');
    expect(store.directoryFilingsOf(CO).length).toBe(filings.length);
    /* RED WHEN: the service files it anyway: one rule for the service and every device. */
    const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${filings.length + 1}`, {
      method: 'POST', body: JSON.stringify({ company: CO, version: filings.length + 1, change: filings[first - 1]!.change, signedAt: first }),
    });
    expect([r.status, (r.body as { refused?: string }).refused]).toEqual([422, 'reverses-a-later-change']);
    const here = await acmeDirectory();
    expect(here.dir.seats.find((x) => x.seat === DEE.seat)?.retired).toEqual({ 'policy:pol_kept': 2 });
    /* RED WHEN: a change passed over that will not be filed again is said as if it will be, or without why. */
    expect(passedOverSaid(here)).toMatch(new RegExp(`the change signed for version ${first} is not filed again: that change, filed again, would undo a change to the same seat applied after the version it was signed for`, 'u'));
  });

});

describe('A HEADER FILED AGAIN IS JUDGED BY WHO ITS SEAT WAS WHEN IT WAS SIGNED', () => {
  it('A HEADER FAY ANCHORED WHILE SEATED IS KEPT WHEN ADA HANDS IT IN AFTER FAY IS RETIRED', async () => {
    const FAY = await seatedNow('fay', 5);
    await anchorTheRecordsHere(doorsOf(ADA));
    await aRecordFiledBy(FAY, 'pol_then_k1').then((e) => FAY.entered.enter([e]));
    await anchorTheRecordsHere(doorsOf(FAY));
    const hers = store.keptTreeOf(CO).headers.at(-1)!;
    expect(hers.anchoredBy.publicKey).toBe(FAY.statement.signingKey);
    await retiredBy(FAY);
    /* RED WHEN: a header filed again is judged by its seat now - a seat retired since could never have its honest header filed again. */
    const r = await sendAs('ada')(`/api/accounts/${CO}/manifest/tree/headers`, { method: 'POST', body: JSON.stringify({ header: hers }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});
