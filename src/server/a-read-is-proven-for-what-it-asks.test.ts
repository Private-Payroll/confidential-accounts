/**
 * **A READ OF THE COMPANY'S RECORDS IS PROVEN FOR WHAT IT ASKS, FROM THE LAST
 * HEAD THIS DEVICE CHECKED.** Each read names the records and kinds it will
 * judge; every header since the last head the device keeps is checked; the
 * leaves asked are proven against the root the chain's head binds, the entries
 * the service says wait are held to those leaves, and the company's first
 * header is believed only as the head the chain took from the empty one.
 *
 * Over real HTTP with the company's record tree and directory as the service
 * keeps them; the chain is the test's.
 */
import { describe, expect, it } from 'vitest';
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import { batchDigestOf, sealPayrollProposal, signProposalFiling } from '../core/proposal-filing.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { NO_LEG } from '../midnight/spending-policy-record.js';
import { vouchedRunIdentityOf } from 'vaults-web-shared/governed-call-builder.js';
import { vouchedRunsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { proposalEntry, signManifestEntry } from '../midnight/record-manifest.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { manifestServiceFor, treeServiceFor, type TreeService } from 'vaults-web-shared/record-entered-here.js';
import {
  anchorServiceFor, anchorTheRecordsHere, heldFor, recordsHeldHere, type AnchorDoors,
} from 'vaults-web-shared/records-anchored-here.js';
import { checkedHeadsInMemory, treeKeptInMemory, type CheckedHeads, type CheckedHeadsStore, type HeadersKeptStore } from 'vaults-web-shared/tree-kept-here.js';
import { nextTreeHeader, recoveredSaid, signTreeHeader, transitionStopSaid, treeBatchOf, vouchedFreshOf, type TreeHeader, headStepOf } from '../midnight/record-tree.js';
import { directoryHere, directoryJudge, foundingSeatHere, namedHere, type DirectoryHereDeps } from 'vaults-web-shared/vault-page-doors.js';
import { anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { companyRecordKey } from '../midnight/seat-directory.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryDeps, acmeDirectoryWithItsFold, ADA, ADDRESS, BO, apiAs, aRecordFiledBy, CO, heldByMoreThanOneKey, KEY,
  peopleRecords, store, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

/** Every `headersAfter` a tree service is asked, by the seq it reads after. */
const counting = (tree: TreeService, asked: number[]): TreeService => ({
  ...tree, headersAfter: async (c, seq, limit) => { asked.push(seq); return tree.headersAfter(c, seq, limit); },
});
const doorsOf = (s: Seat, tree: TreeService = treeServiceFor(apiAs(s.person)), checked?: CheckedHeadsStore, headers?: HeadersKeptStore): AnchorDoors => ({
  accountId: CO, manifest: manifestServiceFor(apiAs(s.person)), tree, ...(checked === undefined ? {} : { checked }), ...(headers === undefined ? {} : { headers }),
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  directory: () => acmeDirectoryWithItsFold(), directoryFilings: async () => store.directoryFilingsOf(CO),
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
/** Acme's directory read through `tree`, keeping what it checked in `checked`. */
const directoryDepsOver = (tree: TreeService, checked?: CheckedHeadsStore): DirectoryHereDeps => ({
  ...acmeDirectoryDeps(),
  anchored: heldFor({ accountId: CO, tree, onChain: acmeChain.onChain, builder: anchorFunctions, ...(checked === undefined ? {} : { checked }) }),
});
const policy = (id: string): RecordsAsked => ({ records: [{ store: 'company', kind: 'policy', id }] });

describe('A READ CHECKS EVERY HEADER SINCE THE LAST HEAD THIS DEVICE KEPT, AND NO OTHER', () => {
  it('a second read checks nothing it checked before; one after a new anchor reads only the headers since; and the directory is held as anchored', async () => {
    const kept = checkedHeadsInMemory();
    const asked: number[] = [];
    const tree = counting(treeServiceFor(apiAs('ada')), asked);
    const first = await directoryHere(directoryDepsOver(tree, kept));
    expect(asked[0]).toBe(-1);
    asked.length = 0;
    /* RED WHEN: the heads this device checked are not kept, or not read back - every read checks the company's whole history again. */
    await directoryHere(directoryDepsOver(tree, kept));
    expect(asked).toEqual([]);
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_since_k1')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    const again = await directoryHere(directoryDepsOver(tree, kept), policy('pol_since_k1'));
    /* RED WHEN: a read after a new anchor starts again from the first header rather than the last head it kept. */
    expect(asked[0]).toBe(first.records.reached.seq);
    expect(again.records.history.get('company:policy:pol_since_k1')?.at(-1)?.version).toBe(1);
    /* RED WHEN: the directory read from a head kept loses who held the account as each of its versions was anchored - every seat of it unbelieved. */
    expect(again.dir.seats.map((x) => [x.seat, x.role])).toEqual(first.dir.seats.map((x) => [x.seat, x.role]));
  });

  it('heads kept from a check that did not start at the first header are not trusted: the read checks from the first', async () => {
    /* Acme held by more than one key, whose runs vouch for nothing: a device new to it checks from the first header. */
    await heldByMoreThanOneKey(async () => {
      const asked: number[] = [];
      const tree = counting(treeServiceFor(apiAs('ada')), asked);
      const kept = checkedHeadsInMemory();
      const real = await recordsHeldHere(doorsOf(ADA, tree, kept), {});
      await kept.write(CO, { latest: real.records.reached, fromZero: null, heads: [real.records.reached.head] });
      asked.length = 0;
      /* RED WHEN: a device trusts heads it never checked from the company's first header - storage could skip it past any header. */
      await recordsHeldHere(doorsOf(ADA, tree, kept), {});
      expect(asked[0]).toBe(-1);
    });
  });
});

describe('WHAT THE SERVICE SAYS WAITS, AND WHAT IT PROVES, ARE HELD TO THE ROOT', () => {
  it('an entry the service lists as waiting that a leaf already holds is not held as not yet anchored', async () => {
    const e = await aRecordFiledBy(ADA, 'pol_waits_w1');
    await ADA.entered.enter([e]);
    await anchorTheRecordsHere(doorsOf(ADA));
    const all = treeServiceFor(apiAs('ada'));
    /* Version 1 again, with other bytes, signed by its filer: only its leaf says version 1 is anchored already. */
    const entered = signManifestEntry(CO, { ...e, digest: 'ab'.repeat(32) as Hex }, ADA.signingSecret as Hex);
    const listing: TreeService = { ...all, pending: async (c, root) => [...((await all.pending(c, root)) ?? []), entered] };
    const read = await recordsHeldHere(doorsOf(ADA, listing), policy('pol_waits_w1'));
    /* RED WHEN: what the service says waits is believed without its leaf - an anchored version served again as the next. */
    expect(read.records.notYetAnchored.map((x) => x.id)).not.toContain('pol_waits_w1');
    expect(read.records.history.get('company:policy:pol_waits_w1')?.at(-1)?.version).toBe(1);
  });

  it('a leaf the service changes does not prove into the root, and the read is refused', async () => {
    const all = treeServiceFor(apiAs('ada'));
    const changing: TreeService = {
      ...all,
      proofs: async (c, ask) => {
        const given = (await all.proofs(c, ask))!;
        return { ...given, records: given.records.map((l) => (l === null ? l : { ...l, digest: 'ee'.repeat(32) as Hex })) };
      },
    };
    /* RED WHEN: the leaves given are believed without being proven against the root the chain's head binds. */
    await expect(recordsHeldHere(doorsOf(ADA, changing), policy('pol_waits_w1'))).rejects.toThrow(/do not prove into the root the anchor on chain holds/u);
  });

  it('seats the device\'s own builder did not read for every holder set a header names stop the read', async () => {
    const short = { ...doorsOf(ADA), builder: { ...doorsOf(ADA).builder, anchorHeads: async (x: Parameters<typeof anchorFunctions.anchorHeads>[0]) => {
      const a = await anchorFunctions.anchorHeads(x);
      return x.holders === undefined || x.holders.length === 0 ? a : { ...a, holderSeats: a.holderSeats.slice(1) };
    } } };
    /* RED WHEN: holders whose seats were never read are taken as no seat - a header judged on seats nobody named. */
    await expect(recordsHeldHere(short, policy('pol_waits_w1'))).rejects.toThrow(/could not read which seats the company's headers name/u);
  });

  it('a list of a kind the service gives short of one leaf does not prove into the root, and the read is refused', async () => {
    const all = treeServiceFor(apiAs('ada'));
    const short: TreeService = {
      ...all,
      proofs: async (c, ask) => {
        const given = (await all.proofs(c, ask))!;
        return { ...given, kinds: given.kinds.map((k) => k.slice(1)) };
      },
    };
    const kind = { kinds: [{ store: 'company' as const, kind: 'policy' }] };
    expect((await recordsHeldHere(doorsOf(ADA, all), kind)).records.history.size).toBeGreaterThan(0);
    /* RED WHEN: a kind's leaves are listed without its subtree proven - a record left out of a list unseen. */
    await expect(recordsHeldHere(doorsOf(ADA, short), kind)).rejects.toThrow(/do not prove into the root the anchor on chain holds/u);
  });

  it('the company\'s first header is believed only as the head the chain took from the empty one', async () => {
    const all = treeServiceFor(apiAs('ada'));
    const first = store.keptTreeOf(CO).headers[0]!;
    /* The service serves its first header with another time in it: its seat's signature no longer covers it. */
    const forging: TreeService = {
      ...all,
      headersAfter: async (c, seq, limit) => {
        const p = await all.headersAfter(c, seq, limit);
        return seq === -1 && limit === 1 ? { ...p, headers: [{ ...first, at: '2020-01-01T00:00:00.000Z' }] } : p;
      },
    };
    const kept = checkedHeadsInMemory();
    /* A device that checked every header already, so its read of the founding goes back for the first one. */
    await recordsHeldHere(doorsOf(ADA, all, kept), {});
    /* RED WHEN: a first header the chain never took is believed - the founding seat would be the service's word. */
    await expect(recordsHeldHere(doorsOf(ADA, forging, kept), { founding: true })).rejects.toThrow(/did not give the company's first header as the chain holds it/u);
    /* The same header with another time, signed again by its own seat: its transition holds, but the chain never took its head. */
    const { anchoredBy: _by, ...unsigned } = first;
    const resigned = signTreeHeader({ ...unsigned, at: '2020-01-01T00:00:00.000Z' }, ADA.signingSecret as Hex);
    const resigning: TreeService = {
      ...all,
      headersAfter: async (c, seq, limit) => {
        const p = await all.headersAfter(c, seq, limit);
        return seq === -1 && limit === 1 ? { ...p, headers: [resigned] } : p;
      },
    };
    /* RED WHEN: a first header is believed because its seat signed it, without the head the chain took from the empty one. */
    await expect(recordsHeldHere(doorsOf(ADA, resigning, kept), { founding: true })).rejects.toThrow(/did not give the company's first header as the chain holds it/u);
    const here = await directoryHere(directoryDepsOver(all, kept), { founding: true });
    expect(foundingSeatHere(here)).toMatchObject({ seat: ADA.seat });
    /* A first header the service keeps first, filed before a call the chain refused, beside the one the chain took. */
    const both: TreeService = {
      ...all,
      headersAfter: async (c, seq, limit) => {
        const p = await all.headersAfter(c, seq, limit);
        return seq === -1 && limit === 1 ? { ...p, headers: [resigned, ...p.headers] } : p;
      },
    };
    /* RED WHEN: the first header is the first the service gives, not the one whose head the chain took - founding could never be read again. */
    expect((await recordsHeldHere(doorsOf(ADA, both, kept), { founding: true })).records.first).toEqual(first);
  });

  it('a chain at the wallet\'s indexer behind a head this device checked is said, and nothing is read or blamed', async () => {
    const kept = checkedHeadsInMemory();
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_behind_k1')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    await recordsHeldHere(doorsOf(ADA, treeServiceFor(apiAs('ada')), kept), {});
    const behind = async () => { const now = await acmeChain.onChain(); return { ...now, landed: now.landed.slice(0, -1) }; };
    /* RED WHEN: an indexer serving an older chain reads as the service withholding a header, or the read goes on from it. */
    await expect(recordsHeldHere({ ...doorsOf(ADA, treeServiceFor(apiAs('ada')), kept), onChain: behind }, {}))
      .rejects.toThrow(/behind what this device has already checked/u);
  });

  it('an anchoring read with more waiting records than one proofs request holds asks in parts, each proven', async () => {
    const all = treeServiceFor(apiAs('ada'));
    const sizes: number[] = [];
    const waiting = Array.from({ length: 300 }, (_, i) => signManifestEntry(CO, {
      store: 'company', kind: 'policy', id: `pol_many_${i}`, version: 1, digest: (i + 1).toString(16).padStart(64, '0') as Hex,
    }, ADA.signingSecret as Hex));
    const many: TreeService = {
      ...all,
      pending: async (c, root) => { const p = await all.pending(c, root); return p === null ? null : [...p, ...waiting]; },
      proofs: async (c, ask) => { sizes.push(ask.records.length); return all.proofs(c, ask); },
    };
    /* RED WHEN: every waiting record goes in one request, which the service refuses past its bound, so no device can anchor again. */
    const read = await recordsHeldHere(doorsOf(ADA, many), { everyPending: true });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256);
    expect(sizes.reduce((x, y) => x + y, 0)).toBeGreaterThan(300);
    expect(read.records.notYetAnchored.filter((e) => e.id.startsWith('pol_many_'))).toHaveLength(300);
  });
});

describe('A RECORD A READ DID NOT ASK FOR IS REFUSED', () => {
  it('a judge made for one record refuses another, and a list of a kind not asked is not made', async () => {
    const asked = await aRecordFiledBy(ADA, 'pol_asked_a1');
    const unasked = await aRecordFiledBy(ADA, 'pol_unasked_a2');
    await ADA.entered.enter([asked, unasked]);
    await anchorTheRecordsHere(doorsOf(ADA));
    const judge = await directoryJudge(acmeDirectoryDeps())(policy('pol_asked_a1'));
    const by = ADA.statement.signingKey as Hex;
    /* RED WHEN: a record no proof covered is judged - a read believes what it never had proven. */
    expect(judge(by, 'policy', companyRecordKey('policy', 'pol_asked_a1'), asked, true)).toBeNull();
    expect(judge(by, 'policy', companyRecordKey('policy', 'pol_unasked_a2'), unasked, true))
      .toMatch(/this read did not have it proven against the anchor on chain, so it is not believed/u);
    expect(judge.withheld?.({ store: 'company', kind: 'policy', id: 'pol_unasked_a2' })).toMatch(/did not have it proven/u);
    /* RED WHEN: a list is made of a kind the read did not ask for whole. */
    const here = await directoryHere(acmeDirectoryDeps(), policy('pol_asked_a1'));
    expect(() => namedHere(here, 'run', 'run')).toThrow(/did not ask for every run record of kind run, so it cannot list them/u);
    const whole = await directoryHere(acmeDirectoryDeps(), { kinds: [{ store: 'run', kind: 'run' }] });
    expect(namedHere(whole, 'run', 'run')).toEqual([]);
  });
});

describe('A HEADER THE SERVICE NO LONGER GIVES IS FILED AGAIN FROM A DEVICE THAT KEPT IT', () => {
  /** The service's tree, losing `lost` from every page until a device files it again through it. */
  const losing = (tree: TreeService, lost: () => TreeHeader | undefined): TreeService & { readonly refiled: () => boolean } => {
    let refiled = false;
    const isLost = (h: unknown) => !refiled && lost() !== undefined && treeBatchOf(h as TreeHeader) === treeBatchOf(lost()!);
    return {
      ...tree,
      refiled: () => refiled,
      headersAfter: async (c, seq, limit) => { const p = await tree.headersAfter(c, seq, limit); return { ...p, headers: p.headers.filter((h) => !isLost(h)) }; },
      fileHeader: async (c, h) => { if (lost() !== undefined && treeBatchOf(h) === treeBatchOf(lost()!)) refiled = true; await tree.fileHeader(c, h); },
    };
  };

  it('BY THE DEVICE THAT SIGNED IT: A DEVICE NEW TO THE COMPANY STOPS AT IT AS NOT GIVEN, AND READS ON ONCE THE SIGNER\'S DEVICE HAS READ', async () => {
    const adas = treeKeptInMemory();
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_lost_k1')]);
    await anchorTheRecordsHere(doorsOf(ADA, treeServiceFor(apiAs('ada')), adas.checked, adas.headers));
    const lostHeader = store.keptTreeOf(CO).headers.at(-1)!;
    /* RED WHEN: the anchoring device does not keep the header it signed, with the entries its changes name. */
    const kept = await adas.headers.at(CO, lostHeader.seq);
    expect(kept.map((k) => treeBatchOf(k.header))).toContain(treeBatchOf(lostHeader));
    expect(kept[0]!.entries.map((e) => e.id)).toContain('pol_lost_k1');
    const tree = losing(treeServiceFor(apiAs('ada')), () => lostHeader);
    /* A device new to the company, keeping nothing, stops where the service withholds a header the chain holds. */
    expect((await recordsHeldHere(doorsOf(ADA, tree), {})).records.stopped).toMatchObject({ stop: 'not-given', seq: lostHeader.seq });
    /* RED WHEN: the head nobody gave a header for is not put down to the seat whose tag the account wrote beside it. */
    const adasTag = await anchorFunctions.anchorTag({ account: ADDRESS, material: doorsOf(ADA).material });
    const named = await recordsHeldHere({ ...doorsOf(ADA, tree), tagSeats: async () => new Map([[adasTag, ADA.seat]]) }, {});
    expect(named.records.stopped).toMatchObject({ stop: 'not-given', seq: lostHeader.seq, movedBy: ADA.seat });
    expect(transitionStopSaid(named.records.stopped!)).toContain(`The seat ${ADA.seat} moved the anchor past it`);
    /* The history shows two anchors in the block that moved the head past it: the account kept only the block's last tag. */
    const movedPast = acmeChain.landed.at(-1)!;
    (movedPast as { anchorsInBlock?: number }).anchorsInBlock = 2;
    try {
      const shared = await recordsHeldHere({ ...doorsOf(ADA, tree), tagSeats: async () => new Map([[adasTag, ADA.seat]]) }, {});
      /* RED WHEN: a seat is named as the one that moved the head past a header nobody gave, where its block held other anchors. */
      expect(shared.records.stopped).toMatchObject({ stop: 'not-given', seq: lostHeader.seq, movedBy: ADA.seat, anchorsInBlock: 2 });
      expect(transitionStopSaid(shared.records.stopped!)).toContain(
        `The seat ${ADA.seat} anchored last in the block that moved the anchor past it, which held 2 anchors, so the seat that moved it may be another of them`);
    } finally {
      delete (movedPast as { anchorsInBlock?: number }).anchorsInBlock;
    }
    /* RED WHEN: the device that kept the header does not file it again where the service does not give it - every device stops there for good. */
    const signer = await recordsHeldHere(doorsOf(ADA, tree, checkedHeadsInMemory(), adas.headers), policy('pol_lost_k1'));
    expect(tree.refiled()).toBe(true);
    expect(signer.records.stopped).toBeNull();
    expect((await recordsHeldHere(doorsOf(ADA, tree), policy('pol_lost_k1'))).records.history.get('company:policy:pol_lost_k1')?.at(-1)?.version).toBe(1);
  });

  it('BY ANY DEVICE THAT CHECKED IT LAST: IT KEEPS THAT HEADER, AND FILES IT AGAIN WHEN THE SERVICE DOES NOT GIVE IT', async () => {
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_lost_k2')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    const lastHeader = store.keptTreeOf(CO).headers.at(-1)!;
    /* A reader that did not sign it checks it, and keeps it as the last header it checked. */
    const readers = treeKeptInMemory();
    await recordsHeldHere(doorsOf(ADA, treeServiceFor(apiAs('ada')), checkedHeadsInMemory(), readers.headers), {});
    /* RED WHEN: a device does not keep the last header it checked. */
    expect((await readers.headers.at(CO, lastHeader.seq)).map((k) => treeBatchOf(k.header))).toEqual([treeBatchOf(lastHeader)]);
    const tree = losing(treeServiceFor(apiAs('ada')), () => lastHeader);
    expect((await recordsHeldHere(doorsOf(ADA, tree), {})).records.stopped).toMatchObject({ stop: 'not-given' });
    /* RED WHEN: a device that checked the header last does not file it again where the service withholds it. */
    expect((await recordsHeldHere(doorsOf(ADA, tree, checkedHeadsInMemory(), readers.headers), {})).records.stopped).toBeNull();
    expect(tree.refiled()).toBe(true);
  });
  it('WITH ITS ENTRIES, WHEN THE SERVICE LOST THE ENTRY AND THE RECORD\'S BYTES TOO: THE HEADER IS KEPT AGAIN AND ONLY THAT RECORD IS WITHHELD', async () => {
    const adas = treeKeptInMemory();
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_lost_k3')]);
    await anchorTheRecordsHere(doorsOf(ADA, treeServiceFor(apiAs('ada')), adas.checked, adas.headers));
    const lostHeader = store.keptTreeOf(CO).headers.at(-1)!;
    /* The service loses the header, the entry and the record's bytes: what a lost write or a restore from an older copy leaves. */
    const data = (store as any).data;
    const filed = (peopleRecords as any).filed as Map<string, unknown>;
    const bytesKey = [...filed.keys()].find((k) => k.endsWith('\u0000policy\u0000pol_lost_k3'))!;
    const bytes = filed.get(bytesKey);
    (store as any).data = {
      ...data,
      trees: { ...data.trees, [CO]: { headers: data.trees[CO].headers.filter((h: TreeHeader) => treeBatchOf(h) !== treeBatchOf(lostHeader)) } },
      manifests: { ...data.manifests, [CO]: { entries: data.manifests[CO].entries.filter((e: { id: string }) => e.id !== 'pol_lost_k3') } },
    };
    filed.delete(bytesKey);
    try {
      expect((await recordsHeldHere(doorsOf(ADA), {})).records.stopped).toMatchObject({ stop: 'not-given', seq: lostHeader.seq });
      /* RED WHEN: a header filed again needs its entries entered first, which the service refuses for want of the record's bytes - every device stopped for good. */
      const signer = await recordsHeldHere(doorsOf(ADA, treeServiceFor(apiAs('ada')), checkedHeadsInMemory(), adas.headers), policy('pol_lost_k3'));
      expect(signer.records.stopped).toBeNull();
      /* RED WHEN: the record is believed with no bytes, or said as anything but named and withheld by the service. */
      expect(signer.records.history.get('company:policy:pol_lost_k3')?.at(-1)?.version).toBe(1);
      const judge = await directoryJudge(acmeDirectoryDeps())(policy('pol_lost_k3'));
      expect(judge.withheld?.({ store: 'company', kind: 'policy', id: 'pol_lost_k3' })).toMatch(/name version 1 of it and the service did not give it/u);
      /* RED WHEN: a device new to the company still stops where the service lost them. */
      expect((await recordsHeldHere(doorsOf(ADA), {})).records.stopped).toBeNull();
    } finally {
      if (!filed.has(bytesKey)) filed.set(bytesKey, bytes);
      /* Left lost, the later cases would read a company stopped here: the data is put back. */
      if (!store.keptTreeOf(CO).headers.some((h) => treeBatchOf(h) === treeBatchOf(lostHeader))) (store as any).data = data;
    }
  });
});

/**
 * A leg's run Ada's device raised over `head`, its proposal filed - and, unless
 * `entered` is false, entered - as a raising device files it: the identity the
 * chain approves is made from the head it seals. `madeWith` is the value the
 * identity was made with, when a case seals another.
 */
const aRunRaisedOver = async (id: string, head: Hex, r: Hex, opts: { readonly entered?: boolean; readonly madeWith?: Hex; readonly retry?: boolean } = {}) => {
  const root = 'ab'.repeat(32) as Hex;
  const vault = 'cd'.repeat(32) as Hex;
  const window = { root, payees: '2', opensAt: '1800000000', closesAt: '1800600000' };
  const chainId = vouchedRunIdentityOf({ accountPure: pureCircuits } as never, { ...window, required: '2', vault, head, r: opts.madeWith ?? r })! as Hex;
  const digest = toHex(pureCircuits.runPayload(fromHex(root), 2n, 1_800_000_000n, 1_800_600_000n, 2n)) as Hex;
  const salt = toHex(pureCircuits.retrySaltOf(NO_LEG(), fromHex(vouchedFreshOf(head, opts.madeWith ?? r)))) as Hex;
  const sealed = sealPayrollProposal({
    accountId: CO, viewingKey: KEY, vault, summary: 'Payroll', payload: { runId: 'run_vouching', form: 'shielded', entries: [], window, ...(opts.retry === true ? { retry: [0] } : {}) } as never,
    change: { asset: 'TEST', amount: 0n, batchDigest: batchDigestOf([]), salt, vouched: { head, r } }, required: 2n, proposedBy: ADA.seat,
  });
  const filing = signProposalFiling(CO, { id, digest, chainId, keyEpoch: 0, createdAt: '2026-10-11T00:00:00.000Z', sealed }, ADA.signingSecret as Hex);
  store.putProposal({ ...filing, accountId: CO, status: 'proposed', approvalCount: 0 } as never);
  if (opts.entered !== false) await ADA.entered.enter([proposalEntry(CO, filing as never)]);
  return chainId;
};
/** A device new to Acme, with the company's viewing key and the account's own functions: what it reads the runs that vouch with. */
const vouchingHere = {
  runs: async (ids: readonly string[]) => vouchedRunsHere(store.listProposals(CO), CO, KEY, ids),
  identity: async (run: Parameters<typeof vouchedRunIdentityOf>[1]) => vouchedRunIdentityOf({ accountPure: pureCircuits } as never, run),
};

/**
 * Every page of headers a tree service is asked for by the seq it reads after - not a single seq's headers, which a
 * device new to the company reads only to find which head a batch before its start left.
 */
const pagesOf = (tree: TreeService, asked: number[]): TreeService => ({
  ...tree, headersAfter: async (c, seq, limit) => { if (limit > 1) asked.push(seq); return tree.headersAfter(c, seq, limit); },
});

describe('A DEVICE NEW TO THE COMPANY STARTS FROM THE NEWEST HEAD A PAYROLL RUN\'S APPROVERS VOUCHED FOR', () => {
  it('held by more than one key: from the vouched head, the directory before it held as anchored; past a run that does not vouch, or with none, from the first header', () => heldByMoreThanOneKey(async () => {
    try {
      await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_vouch_v1')]);
      await anchorTheRecordsHere(doorsOf(ADA));
      const vouchedHead = acmeChain.head();
      const vouchedSeq = acmeChain.landed.length - 1;
      const run = await aRunRaisedOver('prp_vouches_aaaa', vouchedHead, '2b'.repeat(32) as Hex);
      await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_vouch_v2')]);
      await anchorTheRecordsHere(doorsOf(ADA));
      /* The account's history shows the run paid with its threshold of approvals. */
      acmeChain.vouching.push({ chainId: run, height: 7, at: 1_800_000_123_000 });
      const fromTheFirst = await recordsHeldHere(doorsOf(ADA, treeServiceFor(apiAs('ada')), checkedHeadsInMemory()), {});
      expect(fromTheFirst.records.checkedFrom).toBeUndefined();

      const asked: number[] = [];
      const kept = checkedHeadsInMemory();
      const read = await recordsHeldHere({ ...doorsOf(ADA, pagesOf(treeServiceFor(apiAs('ada')), asked), kept), vouching: vouchingHere }, policy('pol_vouch_v2'));
      /* RED WHEN: a device new to a company of more than one key checks from the first header though a run vouches for a later head. */
      expect(asked).not.toContain(-1);
      expect(read.records.checkedFrom).toEqual({ by: 'vouched', seq: vouchedSeq, head: vouchedHead, run, at: 1_800_000_123_000 });
      /* RED WHEN: the start is not kept, or kept as if checked from the first header - an approver could then approve over a head it never checked. */
      expect(await kept.read(CO)).toMatchObject({ fromZero: null, base: vouchedSeq, heads: [vouchedHead, acmeChain.head()] });
      expect(read.records.history.get('company:policy:pol_vouch_v2')?.at(-1)?.version).toBe(1);
      expect(read.records.reached.head).toBe(acmeChain.head());
      /* RED WHEN: the directory anchored before the start loses who held the account as it was anchored - every seat unbelieved. */
      const dirFromTheFirst = await directoryHere(directoryDepsOver(treeServiceFor(apiAs('ada')), checkedHeadsInMemory()));
      const dirVouched = await directoryHere({ ...acmeDirectoryDeps(), anchored: heldFor({ accountId: CO, tree: treeServiceFor(apiAs('ada')), onChain: acmeChain.onChain, builder: anchorFunctions, checked: checkedHeadsInMemory(), vouching: vouchingHere }) });
      expect(dirVouched.records.checkedFrom?.by).toBe('vouched');
      expect(dirVouched.dir.seats.map((x) => [x.seat, x.role])).toEqual(dirFromTheFirst.dir.seats.map((x) => [x.seat, x.role]));

      /* RED WHEN: a run whose sealed head does not make its identity on chain is believed to vouch for it. */
      acmeChain.vouching.length = 0;
      const forged = await aRunRaisedOver('prp_vouches_bbbb', vouchedHead, '2c'.repeat(32) as Hex, { madeWith: '2d'.repeat(32) as Hex });
      acmeChain.vouching.push({ chainId: forged, height: 8, at: 1 });
      asked.length = 0;
      const notVouched = await recordsHeldHere({ ...doorsOf(ADA, pagesOf(treeServiceFor(apiAs('ada')), asked), checkedHeadsInMemory()), vouching: vouchingHere }, {});
      expect([asked[0], notVouched.records.checkedFrom]).toEqual([-1, undefined]);

      /* RED WHEN: a run whose proposal the company's records do not hold is taken to vouch: its approvers' head is passed over. */
      acmeChain.vouching.length = 0;
      const unentered = await aRunRaisedOver('prp_vouches_cccc', vouchedHead, '2e'.repeat(32) as Hex, { entered: false });
      acmeChain.vouching.push({ chainId: unentered, height: 9, at: 1 });
      asked.length = 0;
      const store_ = checkedHeadsInMemory();
      const written: CheckedHeads[] = [];
      const recorded: CheckedHeadsStore = { read: store_.read, write: async (c, h) => { written.push(h); await store_.write(c, h); } };
      const unheld = await recordsHeldHere({ ...doorsOf(ADA, pagesOf(treeServiceFor(apiAs('ada')), asked), recorded), vouching: vouchingHere }, {});
      expect([asked.includes(-1), unheld.records.checkedFrom]).toEqual([true, undefined]);
      /* RED WHEN: a start is kept on the device before its run's proposal proves into the root reached from it - a start later passed over. */
      expect(written.length).toBeGreaterThan(0);
      expect(written.filter((h) => h.from !== undefined || (h.base ?? 0) !== 0)).toEqual([]);

      /* RED WHEN: a company of more than one key whose runs vouch for nothing is read from anywhere but its first header (A starts by itself). */
      acmeChain.vouching.length = 0;
      asked.length = 0;
      await recordsHeldHere({ ...doorsOf(ADA, pagesOf(treeServiceFor(apiAs('ada')), asked), checkedHeadsInMemory()), vouching: vouchingHere }, {});
      expect(asked[0]).toBe(-1);
    } finally {
      acmeChain.vouching.length = 0;
    }
  }));

  it('a retry vouches for nothing: its salt names its leg\'s root, which its proposal does not carry', async () => {
    const head = acmeChain.head();
    const leg = await aRunRaisedOver('prp_vouches_dddd', head, '3a'.repeat(32) as Hex, { entered: false });
    const retry = await aRunRaisedOver('prp_vouches_eeee', head, '3b'.repeat(32) as Hex, { entered: false, retry: true });
    /* RED WHEN: a retry is read as vouching, its identity made as a leg's - never what its approvers approved. */
    expect(vouchedRunsHere(store.listProposals(CO), CO, KEY, [leg, retry]).map((v) => v.chainId)).toEqual([leg]);
    /* RED WHEN: a run the account's history does not show vouching is opened as if it did. */
    expect(vouchedRunsHere(store.listProposals(CO), CO, KEY, [retry])).toEqual([]);
  });

  it('held by one key: from the header before the latest, so the latest is checked against it, and never from the first', async () => {
    const asked: number[] = [];
    const kept = checkedHeadsInMemory();
    const read = await recordsHeldHere(doorsOf(ADA, pagesOf(treeServiceFor(apiAs('ada')), asked), kept), {});
    const latest = acmeChain.landed.length - 1;
    /* RED WHEN: a device new to a company one key holds checks from its first header, or trusts the latest header without checking it against the one before. */
    expect(asked).not.toContain(-1);
    expect(read.records.checkedFrom).toEqual({ by: 'latest', seq: latest - 1, head: acmeChain.landed[latest - 1]!.head });
    expect(await kept.read(CO)).toMatchObject({ base: latest - 1, heads: [acmeChain.landed[latest - 1]!.head, acmeChain.head()] });
    expect(read.records.reached.head).toBe(acmeChain.head());
  });

  it('A DEVICE THAT STARTED PAST THE FIRST HEADER FINDS IT AMONG EVERY ANCHOR OF THE ACCOUNT\'S FIRST BLOCK, WHOSE HISTORY SHOWS ONLY THE LAST', async () => {
    /* The account's first two anchors landed in one block: its history at the wallet's indexer shows only the head the second left. */
    const oneBlock = async () => { const r = await acmeChain.onChain(); return { ...r, landed: r.landed.slice(1) }; };
    expect(acmeChain.landed.length).toBeGreaterThan(3);
    const read = await recordsHeldHere({ ...doorsOf(ADA, treeServiceFor(apiAs('ada')), checkedHeadsInMemory()), onChain: oneBlock }, { founding: true });
    expect(read.records.checkedFrom?.by).toBe('latest');
    /* RED WHEN: the first header is looked for only by the first head the history shows - two anchors in the first block hide it for good. */
    const zeros = store.keptTreeOf(CO).headers.filter((h) => h.seq === 0);
    const firstHeads = (await anchorFunctions.anchorHeads({ after: zeros.map(headStepOf) })).after;
    const taken = zeros.find((_, i) => String(firstHeads[i]).toLowerCase() === acmeChain.landed[0]!.head.toLowerCase());
    expect(taken).toBeDefined();
    expect(read.records.first).toEqual(taken);
    expect(read.records.firstSeats).toEqual([ADA.seat]);
  });
});

describe('A RECOVERY RESUMING FROM A HEAD THIS DEVICE CHECKED BEFORE ITS LAST', () => {
  it('THE DEVICE FOLLOWS THE QUORUM FROM THAT HEAD, SAYS IT WAS THE QUORUM THAT GAVE THE BATCHES UP, AND WHAT THEY HELD WAITS TO BE ANCHORED AGAIN', async () => {
    const xs = treeKeptInMemory();
    const tree = () => treeServiceFor(apiAs('ada'));
    /* This device checks the company's records to Ada's latest batch, then the next one, holding a record filed for it. */
    const before = (await recordsHeldHere(doorsOf(ADA, tree(), xs.checked), {})).records.reached;
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_new_4')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    const givenUp = store.keptTreeOf(CO).headers.at(-1)!;
    expect((await recordsHeldHere(doorsOf(ADA, tree(), xs.checked), policy('pol_new_4'))).records.reached.seq).toBe(givenUp.seq);
    /* The quorum, whose devices could not check that batch, recovers from the head before it: Ada's device carries it out. */
    const data = (store as any).data;
    const landedBefore = acmeChain.landed.length;
    const material = doorsOf(ADA).material;
    const tag = await anchorFunctions.anchorTag({ account: ADDRESS, material });
    const recovery = nextTreeHeader({
      company: CO, before, entries: [], current: new Map(), proof: { siblings: [] }, priorChain: () => undefined,
      held: acmeChain.read().now, at: '2026-10-11T00:00:00.000Z', tag, recovery: { previous: acmeChain.head(), salt: '5a'.repeat(32) as Hex },
    }, ADA.signingSecret as Hex)!.header;
    await tree().fileHeader(CO, recovery);
    acmeChain.recover(acmeChain.head(), treeBatchOf(recovery), recovery.held, tag, before.head);
    try {
      const after = (await recordsHeldHere(doorsOf(ADA, tree(), xs.checked), policy('pol_new_4'))).records;
      /* RED WHEN: a device that checked a batch the quorum gave up stops at the recovery for good, as not given. */
      expect(after.stopped).toBeNull();
      expect(after.reached.head).toBe(acmeChain.head());
      /* RED WHEN: the batches given up go back unsaid, or are said as the service's doing. */
      expect(after.recovered).toEqual({ resumedFrom: before, gaveUpTo: givenUp.seq });
      expect(recoveredSaid(after.recovered!)).toBe(`The company's signers recovered its records from batch ${before.seq}, giving up batch ${givenUp.seq} `
        + 'that this device had checked: what was anchored in it is no longer the company\'s, and what was filed for it waits to be anchored again.');
      /* RED WHEN: what the given-up batch held is still believed, or is lost rather than waiting to be anchored again. */
      expect(after.history.get('company:policy:pol_new_4')).toBeUndefined();
      expect(after.notYetAnchored.map((e) => e.id)).toContain('pol_new_4');
    } finally {
      (store as any).data = data;
      acmeChain.landed.length = landedBefore;
    }
  });
});

describe('A RECOVERY RESUMING FROM FURTHER BACK THAN THE HEADS A DEVICE KEEPS WHOLE', () => {
  it('THE DEVICE CANNOT FOLLOW IT FROM WHAT IT KEPT, AND SAYS THE QUORUM GAVE THE BATCHES UP IF IT RESUMED FROM FURTHER BACK, AND THE WAY ON EITHER WAY', async () => {
    const xs = treeKeptInMemory();
    const tree = () => treeServiceFor(apiAs('ada'));
    const before = (await recordsHeldHere(doorsOf(ADA, tree(), xs.checked), {})).records.reached;
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_f101')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    const givenUp = store.keptTreeOf(CO).headers.at(-1)!;
    expect((await recordsHeldHere(doorsOf(ADA, tree(), xs.checked), policy('pol_f101'))).records.reached.seq).toBe(givenUp.seq);
    /* This device keeps whole only heads after the one the recovery resumes from: as one that checked more batches past it than it keeps. */
    const kept = (await xs.checked.read(CO))!;
    await xs.checked.write(CO, { ...kept, recent: (kept.recent ?? []).filter((r) => r.seq > before.seq) });
    const data = (store as any).data;
    const landedBefore = acmeChain.landed.length;
    const material = doorsOf(ADA).material;
    const tag = await anchorFunctions.anchorTag({ account: ADDRESS, material });
    const recovery = nextTreeHeader({
      company: CO, before, entries: [], current: new Map(), proof: { siblings: [] }, priorChain: () => undefined,
      held: acmeChain.read().now, at: '2026-10-11T00:00:00.000Z', tag, recovery: { previous: acmeChain.head(), salt: '5b'.repeat(32) as Hex },
    }, ADA.signingSecret as Hex)!.header;
    await tree().fileHeader(CO, recovery);
    acmeChain.recover(acmeChain.head(), treeBatchOf(recovery), recovery.held, tag, before.head);
    /* The account's history names the call that moved the head there: a recovery. */
    (acmeChain.landed.at(-1) as { recovered?: boolean }).recovered = true;
    try {
      const after = (await recordsHeldHere(doorsOf(ADA, tree(), xs.checked), policy('pol_f101'))).records;
      /* RED WHEN: the device says the service withholds a header when the quorum gave the batches up - it would blame the service for the quorum's act. */
      expect(after.stopped).toMatchObject({ stop: 'not-given', seq: givenUp.seq + 1, recovery: true });
      /* RED WHEN: the stop is said as the service withholding alone, or as the quorum's for certain - the chain does not say which batch it resumed from. */
      expect(transitionStopSaid(after.stopped!)).toMatch(
        new RegExp(`^the company's signers recovered its records on the chain after batch ${givenUp.seq + 1}, the last this device checked, and this device cannot follow the recovery from what it kept\\. If the recovery resumed from a batch further back than those this device keeps whole, the quorum gave up the batches after it - its doing, not the service's - and checking the company's records from the first batch reads on from it; if not, the service is withholding its header of batch ${givenUp.seq + 2}`, 'u'));
    } finally {
      (store as any).data = data;
      acmeChain.landed.length = landedBefore;
    }
  });
});

describe('A DEVICE\'S READ JUDGES EACH HEADER\'S TAG AGAINST THE SEAT ITS KEY HOLDS', () => {
  it('A HEADER WHOSE ANCHORING KEY IS ONE SEAT\'S AND WHOSE TAG IS MAPPED TO ANOTHER STOPS EVERY READ AS DISHONEST; MAPPED TO ITS OWN SEAT, THE READ GOES ON', async () => {
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'pol_tag_k1')]);
    await anchorTheRecordsHere(doorsOf(ADA));
    const anchored = store.keptTreeOf(CO).headers.at(-1)!;
    const adasTag = await anchorFunctions.anchorTag({ account: ADDRESS, material: doorsOf(ADA).material });
    /* The tag the account wrote beside Ada's head, mapped to her seat as her own opening maps it: the read reaches the head. */
    const honest = await recordsHeldHere({ ...doorsOf(ADA), tagSeats: async () => new Map([[adasTag, ADA.seat]]) }, {});
    expect(honest.records.stopped).toBeNull();
    /*
     * RED WHEN: a device's read does not hand its map of tags to the check of each header - a seat could sign a header
     * naming itself for a head another seat's tag moved, and every device would believe it.
     */
    const swapped = await recordsHeldHere({ ...doorsOf(ADA), tagSeats: async () => new Map([[adasTag, BO.seat]]) }, {});
    expect(swapped.records.stopped).toMatchObject({ stop: 'dishonest', seq: anchored.seq });
  });
});
