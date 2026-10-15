/**
 * **THE COMPANY'S RECORDS ARE ANCHORED FROM A SIGNER'S DEVICE: EVERY ENTRY NOT
 * YET ANCHORED, IN THE NEXT HEADER OF THE COMPANY'S RECORD TREE, WHOSE DIGEST
 * THE HEAD THE CHAIN HOLDS BINDS.**
 *
 * Over real HTTP with the company's record tree and directory as the service
 * keeps them and the directory as each device believes it. The chain is the test's:
 * one head, moved on only by a call naming the head it holds - the account's
 * compare-and-swap - with the account's own `anchorHeadOf`; a call naming any
 * other head is refused, as the chain refuses a transaction whose read no longer
 * matches. The proving is the worker's stand-in: the "proof" names the head and
 * the batch.
 *
 * The one to read first is "ANOTHER DEVICE ANCHORING FIRST".
 */
import { leavesOfTheContract } from '../testing/directory-seats.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { aChainAnchor, anchoredOver, anchorFunctions, headAfter, heldBy, holdersOf, onChainOf, tagInATest, anchorSentInATest } from '../testing/record-tree-double.js';
import { directoryWithItsRecordsHere, foundedOnChainHere } from 'vaults-web-shared/vault-page-doors.js';
import type { AccountDeployed } from 'vaults-web-shared/governed-call-builder.js';
import { signCompanyFiling } from '../midnight/sealed-record-wire.js';
import { sealRoster } from '../core/roster-record.js';
import { signedFoundingState } from '../core/founding-state.js';
import { newSigningKeypair } from '../core/crypto.js';
import { newStateBlinding, sealState } from '../core/account.js';
import type { Hex } from '../core/crypto.js';
import { EMPTY_HEAD, entryIdOf, proposalEntry, signManifestEntry, type ManifestEntry, type ManifestEntryBody } from '../midnight/record-manifest.js';
import { treeBatchOf, type TreeHeader } from '../midnight/record-tree.js';
import type { RecordsAsked, RecordsHeld } from '../midnight/records-held.js';
import { signProposalFiling } from '../core/proposal-filing.js';
import type { SealedProposal } from '../core/types.js';
import { FiledNotEntered, manifestServiceFor, recordsEnteredFor, treeServiceFor, type TreeService } from 'vaults-web-shared/record-entered-here.js';
import {
  ANCHORED_AT_LEAST_EVERY_MS, AnchorNotMade, anchoredOnTheWayIn, anchorTheRecordsHere, recordsHeldHere, treeHeaderHere, type AnchorDoors,
  anchorServiceFor,
} from 'vaults-web-shared/records-anchored-here.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryWithItsFold, acmeClock, acmeHeldNow, acmeDirectory, ADA, ADDRESS, apiAs, aRecordFiledBy, BO, chains, CO, EVE,
  heldByMoreThanOneKey, KEY, OTHER, OTHER_ADDRESS, OTHER_LABEL, peopleRecords, store, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();


/* The chain, as every device here reads it: Acme's anchor on the test's chain, and what happened to it, in order. */
const head = (): Hex => acmeChain.head();
const log: string[] = [];
/** Run once when a device sends its anchor, before the chain applies it: what another device does meanwhile. */
let meanwhile: (() => Promise<void>) | null = null;
/** While set, a send fails before it reaches the chain. */
let sendFails: string | null = null;

const builder: AnchorDoors['builder'] = {
  ...anchorFunctions,
  anchor: anchorSentInATest,
};
const doorsOf = (s: Seat, tree: TreeService = treeServiceFor(apiAs(s.person))): AnchorDoors => ({
  accountId: CO,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceFor(apiAs(s.person)),
  tree: {
    ...tree,
    fileHeader: async (company, header) => { log.push(`${s.person} kept a batch`); await tree.fileHeader(company, header); },
  },
  directory: () => acmeDirectoryWithItsFold(),
  directoryFilings: async () => store.directoryFilingsOf(CO),
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_company, tx) => {
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      log.push(`${s.person} sent`);
      const before = meanwhile;
      meanwhile = null;
      await before?.();
      if (sendFails !== null) throw new Error(sendFails);
      /* The account's compare-and-swap, as the chain applies it: a stale head refuses the whole call. */
      acmeChain.move(previous, batch, held, tag);
      log.push(`${s.person} anchored`);
    },
    sealedProposals: async (company) => store.listProposals(company),
    foundingRecords: anchorServiceFor(apiAs(s.person)).foundingRecords,
  },
  builder,
});
/** A record filed by `s` and entered by it, as its device does: the entry it entered. */
const enter = async (s: Seat, id: string): Promise<ManifestEntryBody> => {
  const entry = await aRecordFiledBy(s, id, s === BO ? 'proposal' : 'policy');
  await s.entered.enter([entry]);
  return entry;
};

beforeEach(() => { log.length = 0; meanwhile = null; sendFails = null; });

/** Every kind of record these cases file, asked whole: what a read here holds. */
const ALL: RecordsAsked = { kinds: [
  ...(['policy', 'proposal', 'roster', 'state', 'person'] as const).map((kind) => ({ store: 'company' as const, kind })),
  { store: 'proposal', kind: 'proposal' }, { store: 'directory', kind: 'directory' },
] };
/** What a device holds now of the company's records. */
const heldNow = async (d: AnchorDoors, asked: RecordsAsked = ALL) => (await recordsHeldHere(d, asked)).records;
/** The newest version a read holds of a record, with the digest it holds it at. */
const newestOf = (f: RecordsHeld, key: string) => { const v = f.history.get(key)?.at(-1); return v === undefined ? undefined : { version: v.version, digest: v.digest }; };
/** Every header of Acme's record tree the service keeps, in the order kept. */
const headers = (company = CO): readonly TreeHeader[] => store.keptTreeOf(company).headers;
/** A tree service over `all` with `id`'s entry left out of what it says waits, and of every page of headers. */
const leavingOutOf = (all: TreeService, left: (e: ManifestEntry) => boolean): TreeService => ({
  ...all,
  pending: async (c, root) => { const p = await all.pending(c, root); return p === null ? null : p.filter((e) => !left(e as ManifestEntry)); },
  headersAfter: async (c, seq, limit) => { const p = await all.headersAfter(c, seq, limit); return { ...p, entries: p.entries.filter((e) => !left(e as ManifestEntry)) }; },
});

describe('ANCHORING FROM A DEVICE', () => {
  it('A FILING ENTERED IS ANCHORED FROM ADA\'S DEVICE: THE DIRECTORY WITNESSED, THE BATCH KEPT BEFORE THE CALL IS SENT, AND THE HEAD FOLDS IT', async () => {
    const a1 = await enter(ADA, 'emp_anchored_a1');
    /* The head Acme's founding batch left. */
    const founded = head();
    const out = await anchorTheRecordsHere(doorsOf(ADA));
    /* RED WHEN: the header is kept after the call is sent - a device stopping between the two leaves a batch no device was given. */
    expect(log).toEqual(['ada kept a batch', 'ada sent', 'ada anchored']);
    const [, batch] = headers();
    /* RED WHEN: the head the chain moves to is not this header's digest folded into the head before it with the account's own anchorHeadOf. */
    expect(batch!.previous).toBe(founded);
    expect(head()).toBe(headAfter(founded, treeBatchOf(batch!), batch!.held, batch!.tag));
    expect(out).toEqual({ anchored: batch!.changes.length, head: head() });
    const nowHeld = await heldNow(doorsOf(ADA));
    expect(nowHeld.stopped).toBeNull();
    expect(newestOf(nowHeld, 'company:policy:emp_anchored_a1')).toEqual({ version: 1, digest: a1.digest });
    /* RED WHEN: the directory's versions are not witnessed and anchored with the records - a stale directory would go unseen. */
    expect(newestOf(nowHeld, 'directory:directory:directory')?.version).toBe(store.directoryFilingsOf(CO).length);
    log.length = 0;
    /* RED WHEN: a device anchors when nothing is waiting - a call, and its fee, for nothing. */
    await expect(anchorTheRecordsHere(doorsOf(ADA))).resolves.toEqual({ anchored: 0, head: head() });
    expect(log).toEqual([]);
  });

  it('ANOTHER DEVICE ANCHORING FIRST: THE CHAIN REFUSES THIS DEVICE\'S CALL, AND IT READS THE HEAD AGAIN AND ANCHORS WHAT IS LEFT', async () => {
    await enter(ADA, 'emp_anchored_a2');
    meanwhile = async () => {
      /* Bo's device anchors what is waiting first; then one more filing of Ada's arrives. */
      await anchorTheRecordsHere(doorsOf(BO));
      await enter(ADA, 'emp_anchored_a3');
    };
    const out = await anchorTheRecordsHere(doorsOf(ADA));
    /* RED WHEN: a refusal of the call for a stale head ends the anchoring, or is reported as a failure the person must act on. */
    expect(log).toEqual(['ada kept a batch', 'ada sent', 'bo kept a batch', 'bo sent', 'bo anchored', 'ada kept a batch', 'ada sent', 'ada anchored']);
    expect(out.anchored).toBe(1);
    const nowHeld = await heldNow(doorsOf(BO));
    /* RED WHEN: a batch lost to the race is held as though it landed, or what was left is not anchored. */
    expect(nowHeld.stopped).toBeNull();
    expect(newestOf(nowHeld, 'company:policy:emp_anchored_a2')?.version).toBe(1);
    expect(newestOf(nowHeld, 'company:policy:emp_anchored_a3')?.version).toBe(1);
    expect(nowHeld.notYetAnchored).toEqual([]);
  });

  it('OTHER DEVICES ANCHORING FIRST EVERY TIME: AFTER READING THE HEAD AGAIN A FEW TIMES, THIS DEVICE SAYS SO, AND WHAT THEY ANCHORED IS BELIEVED', async () => {
    let n = 0;
    /* Bo's device anchors what is waiting first, and then one more filing arrives for Ada's next read: every time. */
    const raced = async () => {
      n += 1;
      await anchorTheRecordsHere(doorsOf(BO));
      await enter(ADA, `emp_raced_00${n}`);
      meanwhile = raced;
    };
    await enter(ADA, 'emp_raced_000');
    meanwhile = raced;
    /* RED WHEN: a device reads the head again without end, or gives up before reading it again. */
    await expect(anchorTheRecordsHere(doorsOf(ADA))).rejects.toThrow(/other devices anchored the company's records first, or who holds the company's account changed, 3 times running/u);
    expect(log.filter((l) => l === 'ada sent')).toHaveLength(3);
    meanwhile = null;
    const nowHeld = await heldNow(doorsOf(BO));
    expect(newestOf(nowHeld, 'company:policy:emp_raced_000')?.version).toBe(1);
  });

  it('AN ENTRY SIGNED BY A SEAT WHOSE ROLE MAY NOT FILE ITS RECORD, SERVED BY THE SERVICE, IS NEVER ANCHORED FROM A DEVICE', async () => {
    const all = treeServiceFor(apiAs('ada'));
    /* Bo is an approver: a roster is not his to file, and an honest service would never have entered this. */
    const bos = signManifestEntry(CO, { store: 'company', kind: 'roster', id: 'roster', version: 99, digest: 'b0'.repeat(32) }, BO.signingSecret as Hex);
    const lying: TreeService = { ...all, pending: async (c, root) => { const p = await all.pending(c, root); return p === null ? null : [...p, bos]; } };
    await enter(ADA, 'emp_with_a_lie_d1');
    await anchorTheRecordsHere(doorsOf(ADA, lying));
    const anchoredIn = headers().at(-1)!.changes.map((c) => c.leaf.entryId);
    /* RED WHEN: a device anchors an entry its own directory says that seat may not file - every other device then stops there. */
    expect(anchoredIn).not.toContain(entryIdOf(bos));
    expect(anchoredIn).toContain(entryIdOf(store.manifestOf(CO).entries.find((e) => e.id === 'emp_with_a_lie_d1')!));
  });

  it('A PROPOSAL WHOSE ENTRY WAS NOT KEPT IS ENTERED AGAIN BY THE DEVICE THAT FILED IT WHEN IT ANCHORS, AND BY NO OTHER SEAT', async () => {
    /* Ada's device wrote a proposal down and the service kept it; its entry was never kept. */
    const filing = signProposalFiling(CO, {
      id: 'prp_notentered01', digest: 'd7'.repeat(32) as Hex, chainId: 'c7'.repeat(32) as Hex, keyEpoch: 0,
      createdAt: '2026-10-09T10:00:00.000Z', sealed: { iv: 'aa', tag: 'bb', body: 'cc' },
    }, ADA.signingSecret as Hex);
    store.putProposal({
      id: filing.id, accountId: CO, status: 'open', createdAt: filing.createdAt, digest: filing.digest, chainId: filing.chainId,
      approvalCount: 0, keyEpoch: 0, sealed: filing.sealed, filedBy: filing.filedBy,
    } as SealedProposal);
    /* And one the service made up under Ada's key, which her seat never signed. */
    store.putProposal({
      id: 'prp_madeupbysvc1', accountId: CO, status: 'open', createdAt: filing.createdAt, digest: filing.digest, chainId: filing.chainId,
      approvalCount: 0, keyEpoch: 0, sealed: filing.sealed, filedBy: { publicKey: filing.filedBy.publicKey, signature: 'ee'.repeat(64) },
    } as SealedProposal);
    const named = () => store.manifestOf(CO).entries.filter((e) => e.id === filing.id);
    await anchorTheRecordsHere(doorsOf(BO));
    /* RED WHEN: a seat enters a proposal another seat filed - the service refuses it, and the anchor stops on it. */
    expect(named()).toEqual([]);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* RED WHEN: a proposal whose entry was not kept is never entered again - it is never anchored, and its leg never believed. */
    expect(named().map((e) => e.filedBy.publicKey)).toEqual([ADA.statement.signingKey]);
    /* RED WHEN: a device enters a proposal its own seat's signature does not cover - the anchor would vouch for what the service made up. */
    expect(store.manifestOf(CO).entries.filter((e) => e.id === 'prp_madeupbysvc1')).toEqual([]);
    expect(newestOf(await heldNow(doorsOf(BO)), `proposal:proposal:${filing.id}`))
      .toEqual({ version: 1, digest: proposalEntry(CO, filing).digest });
  });

  it('THE HEAD IS THE ONE THE ACCOUNT\'S HISTORY HOLDS AT THE WALLET\'S INDEXER: A STATE THE SERVICE SERVES OLDER CHANGES NOTHING A DEVICE BELIEVES OR ANCHORS ON', async () => {
    await enter(ADA, 'emp_head_from_the_wallet_h1');
    await anchorTheRecordsHere(doorsOf(ADA));
    await enter(ADA, 'emp_head_from_the_wallet_h2');
    const onChainNow = head();
    /* The service serves the account as it stood before any anchor: a genuine, older state. */
    const older: AnchorDoors = {
      ...doorsOf(ADA),
      service: { ...doorsOf(ADA).service, callState: async () => ({ account: ADDRESS, accountState: EMPTY_HEAD, parameters: '', blockHash: 'b' }) as never },
    };
    const read = await heldNow(older);
    /* RED WHEN: the head read is the one the service's state holds - an older state served has every batch since read as never anchored. */
    expect(read.head).toBe(onChainNow);
    expect(read.stopped).toBeNull();
    expect(newestOf(read, 'company:policy:emp_head_from_the_wallet_h1')?.version).toBe(1);
    const sent: string[] = [];
    const watching: AnchorDoors = { ...older, builder: { ...builder, anchor: async (a) => { sent.push(a.previous); return builder.anchor(a); } } };
    await anchorTheRecordsHere(watching);
    /* RED WHEN: a device anchors on the head the service's state holds rather than the one the account's history holds. */
    expect(sent).toEqual([onChainNow]);
    expect(newestOf(await heldNow(doorsOf(BO)), 'company:policy:emp_head_from_the_wallet_h2')?.version).toBe(1);
  });

  it('A FILING WHOSE ENTRY THE SERVICE DID NOT KEEP IS ENTERED AGAIN BY ITS FILER\'S DEVICE WHEN IT ANCHORS, AND ANCHORED', async () => {
    const all = manifestServiceFor(apiAs('ada'));
    /* The service takes the filing and drops its entry. */
    const dropping = { ...all, enter: async () => { throw new Error('the service dropped the connection'); } };
    const entry = await aRecordFiledBy(ADA, 'emp_entry_dropped_e1');
    await expect(recordsEnteredFor(dropping, CO, ADA.signingSecret as Hex).enter([entry])).rejects.toBeInstanceOf(FiledNotEntered);
    expect(store.manifestOf(CO).entries.some((e) => e.id === 'emp_entry_dropped_e1')).toBe(false);
    await anchorTheRecordsHere(doorsOf(ADA));
    /* RED WHEN: a filing whose entry was not kept is never entered again - it is in no batch, for as long as the service likes. */
    expect(newestOf(await heldNow(doorsOf(BO)), 'company:policy:emp_entry_dropped_e1')).toEqual({ version: 1, digest: entry.digest });
  });

  it('A FILING THE SERVICE KEEPS LEAVING OUT OF WHAT IT SERVES STOPS ITS FILER\'S ANCHOR, SAID, AND NOTHING IS SENT', async () => {
    const entry = await aRecordFiledBy(ADA, 'emp_entry_withheld_w1');
    await ADA.entered.enter([entry]);
    const leavingOut = leavingOutOf(treeServiceFor(apiAs('ada')), (e) => e.id === 'emp_entry_withheld_w1');
    log.length = 0;
    /* RED WHEN: the filer anchors what it is served and leaves its own filing out - the record held at its older version unseen. */
    await expect(anchorTheRecordsHere(doorsOf(ADA, leavingOut)))
      .rejects.toThrow(/the service keeps leaving version 1 of company record emp_entry_withheld_w1, which this device filed and entered, out of the company's records/u);
    expect(log.filter((l) => l.endsWith('sent'))).toEqual([]);
    /* Served whole again, it is anchored, and let go of: left out once anchored, it is a batch the service does not give. */
    await anchorTheRecordsHere(doorsOf(ADA));
    expect(newestOf(await heldNow(doorsOf(BO)), 'company:policy:emp_entry_withheld_w1')?.version).toBe(1);
    /* RED WHEN: an entry the anchor holds is kept on the page and entered again for ever. */
    await expect(anchorTheRecordsHere(doorsOf(ADA, leavingOut))).rejects.toThrow(/the service did not give the entry of version 1 of company record emp_entry_withheld_w1/u);
  });

  it('A FILING WHOSE ENTRY WAS NOT KEPT, BEHIND A NEWER VERSION OF THE SAME RECORD, IS LET GO OF AND NOT ENTERED AGAIN', async () => {
    const dropping = { ...manifestServiceFor(apiAs('ada')), enter: async () => { throw new Error('the service dropped the connection'); } };
    await expect(recordsEnteredFor(dropping, CO, ADA.signingSecret as Hex).enter([await aRecordFiledBy(ADA, 'emp_superseded_s1')]))
      .rejects.toBeInstanceOf(FiledNotEntered);
    const second = await aRecordFiledBy(ADA, 'emp_superseded_s1');
    await ADA.entered.enter([second]);
    /* RED WHEN: an entry behind a newer version is entered again - the service refuses it as not newer, and nothing is anchored. */
    await expect(anchorTheRecordsHere(doorsOf(ADA))).resolves.toMatchObject({ anchored: expect.any(Number) });
    expect(newestOf(await heldNow(doorsOf(BO)), 'company:policy:emp_superseded_s1')?.version).toBe(2);
  });

  it('A FILING THE SERVICE GIVES TO EVERY READ BUT THE ONE THE BATCH IS MADE FROM STILL STOPS ITS FILER\'S ANCHOR', async () => {
    const entry = await aRecordFiledBy(ADA, 'emp_hidden_from_the_fold_h1');
    await ADA.entered.enter([entry]);
    const all = treeServiceFor(apiAs('ada'));
    /* The service leaves the entry out only of the read made while the device reads the records - the one its header is made from. */
    let reading = false;
    const twoFaced: TreeService = {
      ...all,
      pending: async (company, root) => {
        const m = await all.pending(company, root);
        if (!reading || m === null) return m;
        reading = false;
        return m.filter((e) => (e as { id: string }).id !== 'emp_hidden_from_the_fold_h1');
      },
    };
    log.length = 0;
    const d = doorsOf(ADA, twoFaced);
    /* RED WHEN: whether the service gives the filing is asked of another read than the check's - the batch leaves it out unseen. */
    await expect(anchorTheRecordsHere({ ...d, onChain: async () => { reading = true; return d.onChain(); } }))
      .rejects.toThrow(/the service keeps leaving version 1 of company record emp_hidden_from_the_fold_h1/u);
    expect(log.filter((l) => l.endsWith('sent'))).toEqual([]);
    await anchorTheRecordsHere(doorsOf(ADA));
  });

  it('A SEND THAT FAILS WITH THE HEAD UNMOVED IS NOT READ AS A RACE: IT IS SAID, AND NOT SENT AGAIN', async () => {
    await enter(ADA, 'emp_unsent_b1');
    sendFails = 'the node dropped the connection';
    /* RED WHEN: any failed send is taken for another device's anchor and sent again, or swallowed. */
    const said = await anchorTheRecordsHere(doorsOf(ADA)).then(() => null, (e: unknown) => e);
    expect(said).toBeInstanceOf(AnchorNotMade);
    expect((said as Error).message).toMatch(/the anchor was not sent \(the node dropped the connection\)/u);
    expect(log.filter((l) => l === 'ada sent')).toHaveLength(1);
    sendFails = null;
    await anchorTheRecordsHere(doorsOf(ADA));
  });

  it("THE BATCH'S HEADER NAMES WHO HOLDS THE ACCOUNT AS THE HISTORY SHOWS IT, AND A DEVICE WHOSE WALLET READ OTHER HOLDERS SENDS NOTHING", async () => {
    await enter(ADA, 'emp_holders_named_h1');
    const d = doorsOf(ADA);
    const before = headers().length;
    await anchorTheRecordsHere(d);
    const header = headers().at(-1)!;
    /* RED WHEN: the header names any holders but those the account's history at the wallet's indexer shows now. */
    expect(headers().length).toBe(before + 1);
    expect(header.held).toEqual((await acmeChain.onChain()).now);
    log.length = 0;
    await enter(ADA, 'emp_holders_named_h2');
    /* The history shows the account at another number of approvals than the wallet read: one of the two is behind. */
    const behind: AnchorDoors = { ...d, onChain: async () => { const r = await acmeChain.onChain(); return { ...r, now: { ...r.now, approvals: r.now.approvals + 1 } }; } };
    /* RED WHEN: a device anchors a batch it judged against its wallet's holders under a header naming other holders. */
    await expect(anchorTheRecordsHere(behind)).rejects.toThrow(/who holds the company's account, as your wallet read it, is not what the account's history at its indexer shows yet/u);
    expect(log).toEqual([]);
    /* The history shows the same approvals and a seat fewer than the wallet read. */
    const fewer: AnchorDoors = { ...d, onChain: async () => { const r = await acmeChain.onChain(); return { ...r, seatsNow: r.seatsNow.slice(1) }; } };
    /* RED WHEN: the seats the wallet read are not compared with the seats the history shows. */
    await expect(anchorTheRecordsHere(fewer)).rejects.toThrow(/who holds the company's account, as your wallet read it, is not what the account's history/u);
    const other: AnchorDoors = { ...d, onChain: async () => { const r = await acmeChain.onChain(); return { ...r, seatsNow: [...r.seatsNow.slice(1), 'ee'.repeat(32)] }; } };
    await expect(anchorTheRecordsHere(other)).rejects.toThrow(/who holds the company's account, as your wallet read it, is not what the account's history/u);
    expect(log).toEqual([]);
    await anchorTheRecordsHere(d);
  });

  it('A BATCH WHOSE FILINGS THE SERVICE DOES NOT GIVE STOPS THE DEVICE: IT ANCHORS NOTHING PAST IT, AND NAMES WHO ANCHORED IT', async () => {
    const firstEntry = headers()[0]!.changes[0]!.leaf;
    expect(firstEntry.store).toBe('directory');
    const withholding = leavingOutOf(treeServiceFor(apiAs('ada')), (e) => entryIdOf(e) === firstEntry.entryId);
    await enter(ADA, 'emp_withheld_c1');
    /* RED WHEN: a device skips a header it cannot check, and anchors on past it. The entry withheld is the directory's first
     * version - Ada's own claim - and the header is given whole otherwise: not given, the service's doing, naming no seat. */
    /* A device that checks the records from the first header: Acme held by more than one key, none of its runs vouching. */
    await heldByMoreThanOneKey(() => expect(anchorTheRecordsHere(doorsOf(ADA, withholding)))
      .rejects.toThrow(/the service did not give the entry of version 1 of directory record directory of batch 1 of the company's records/u));
    expect(log).toEqual([]);
  });

  it('HEADS THE DEVICE\'S OWN BUILDER DID NOT READ FOR EVERY BATCH STOP IT: NOTHING IS BELIEVED OR ANCHORED', async () => {
    await enter(ADA, 'emp_heads_unread_c3');
    const short = { ...doorsOf(ADA), builder: { ...builder, anchorHeads: async () => ({ after: [] }) } };
    /* RED WHEN: a device checks headers with heads it never read, and believes or anchors past a batch it could not place. */
    await expect(anchorTheRecordsHere(short as never)).rejects.toThrow(/this device could not read the anchor's heads/u);
    const holed = { ...doorsOf(ADA), builder: { ...builder, anchorHeads: async (a: Parameters<typeof builder.anchorHeads>[0]) => {
      const read = await builder.anchorHeads(a);
      return { ...read, after: read.after.map(() => undefined) };
    } } };
    await expect(anchorTheRecordsHere(holed as never)).rejects.toThrow(/the anchor's heads were not read for every batch/u);
    expect(log).toEqual([]);
  });

  it('A BATCH ANCHORED BY A SEAT WHOSE ROLE MAY NOT ANCHOR STOPS THE DEVICE, THOUGH THE KEY IS A SEAT\'S', async () => {
    await enter(ADA, 'emp_anchored_by_bo_b7');
    await anchorTheRecordsHere(doorsOf(BO));
    log.length = 0;
    /* A directory in which Bo's seat only ever viewed the company, at every version: his key is a seat's, and his role files nothing. */
    const viewing = async () => {
      const d = await acmeDirectory();
      const asViewer = <T extends { seats: typeof d.dir.seats }>(dir: T): T =>
        ({ ...dir, seats: dir.seats.map((x) => (x.seat === BO.seat ? { ...x, role: 'viewer' as const } : x)) });
      return { ...d, dir: asViewer(d.dir), at: (v: number) => { const then = d.at(v); return then && { ...then, dir: asViewer(then.dir) }; } };
    };
    const read = await heldNow({ ...doorsOf(ADA), directory: viewing as never });
    /* RED WHEN: a batch is believed from a seat because it holds the key, whatever its role allows. */
    expect(read.stopped).toMatchObject({ stop: 'dishonest', anchoredBy: BO.statement.signingKey });
    expect(log).toEqual([]);
  });

  it('A BATCH ANCHORED BY A KEY NO SEAT OF THE COMPANY HOLDS STOPS THE DEVICE: NOTHING FROM IT ON IS BELIEVED, AND NOTHING IS ANCHORED', async () => {
    await enter(ADA, 'emp_strange_f1');
    await anchorTheRecordsHere(doorsOf(ADA));
    log.length = 0;
    const all = treeServiceFor(apiAs('ada'));
    /* Ada files one more record; another company's seat makes the next header over it, and the chain folds it in. */
    const f2 = await enter(ADA, 'emp_strange_f2');
    const waiting = ((await all.pending(CO, (await heldNow(doorsOf(BO))).reached.root))! as ManifestEntry[]).filter((e) => e.id === f2.id);
    const strange = (await treeHeaderHere({ accountId: CO, tree: all, signingSecret: EVE.signingSecret as Hex, tag: tagInATest(EVE.signingSecret as Hex), held: holdersOf(acmeHeldNow()), at: new Date('2026-10-09T10:00:00.000Z') },
      (await heldNow(doorsOf(BO))).reached, waiting))!.header;
    acmeChain.landAt(headAfter(head(), treeBatchOf(strange), strange.held, strange.tag));
    const serving: TreeService = {
      ...all,
      headersAfter: async (c, seq, limit) => {
        const p = await all.headersAfter(c, seq, limit);
        return strange.seq > seq ? { ...p, headers: [...p.headers, strange], entries: [...p.entries, ...waiting] } : p;
      },
    };
    const read = await heldNow(doorsOf(BO, serving));
    /* RED WHEN: a header is believed from a key no seat the directory believes holds. */
    expect(read.stopped).toMatchObject({ stop: 'dishonest', anchoredBy: strange.anchoredBy.publicKey });
    await expect(anchorTheRecordsHere(doorsOf(ADA, serving))).rejects.toThrow(/is not honest: it was anchored by a key no seat that may anchor held, in the directory as anchored with it/u);
    expect(log).toEqual([]);
  });

  it('A HEAD ON CHAIN NO BATCH THE SERVICE GAVE REACHES STOPS THE DEVICE: NOTHING IS BELIEVED, AND NOTHING IS ANCHORED', async () => {
    /* A signer anchored a digest whose header was never filed: the chain folds through a batch nobody holds. */
    acmeChain.landAt(headAfter(head(), 'ee'.repeat(32), holdersOf(acmeHeldNow()), tagInATest(EVE.signingSecret as Hex)));
    const read = await heldNow(doorsOf(BO));
    expect(read.stopped).toMatchObject({ stop: 'not-given' });
    /* RED WHEN: a device believes the records it can check, or anchors on, past a head it cannot reach: no directory is believed, so no reader acts. */
    await expect(acmeDirectory()).rejects.toThrow(/cannot be read past a batch this device cannot open/u);
    await expect(anchorTheRecordsHere(doorsOf(ADA))).rejects.toThrow(/the service did not give its header of batch \d+ of the company's records/u);
    expect(log).toEqual([]);
  });

});

describe('THE ONE-A-DAY ANCHOR, ON THE WAY INTO THE COMPANY', () => {
  const HOUR = 60 * 60 * 1000;
  /* A clock well past every batch earlier tests anchored, so the last of those was more than a day ago. */
  const T = Date.now() + 30 * 24 * HOUR;
  /* A device whose clock reads `ms`, on a chain whose next block is set at the same time. */
  const at = (ms: number) => { acmeClock.now = () => ms; return { ...doorsOf(ADA), now: () => new Date(ms) }; };
  /* The chain put back at the furthest head a header the service keeps made and the chain took, whatever a test above moved it to. */
  beforeEach(() => {
    const took = new Set(acmeChain.landed.map((l) => l.head));
    const tips = headers().map((h) => ({ seq: h.seq, head: headAfter(h.previous, treeBatchOf(h), h.held, h.tag) })).filter((t) => took.has(t.head));
    const reached = tips.sort((x, y) => y.seq - x.seq)[0]?.head ?? EMPTY_HEAD;
    if (head() !== reached) acmeChain.landAt(reached);
  });

  it('A FILING WAITING WHEN THE LAST BATCH IS A DAY OLD IS ANCHORED BY THE SEAT ENTERING; WITHIN THE DAY IT WAITS, AND NOTHING IS SENT', async () => {
    await anchorTheRecordsHere(doorsOf(ADA));
    log.length = 0;
    await enter(ADA, 'emp_on_the_way_in_d1');
    /* RED WHEN: entering the company anchors nothing though the last batch is a day old - a filing could wait unanchored for ever between raises. */
    expect(await anchoredOnTheWayIn(at(T))).toMatchObject({ anchored: 1 });
    expect(log).toEqual(['ada kept a batch', 'ada sent', 'ada anchored']);
    log.length = 0;
    await enter(ADA, 'emp_on_the_way_in_d2');
    /* RED WHEN: every entry into the company anchors - a call, and its fee, for every page opened. */
    expect(await anchoredOnTheWayIn(at(T + 23 * HOUR))).toEqual({ waits: 'anchored-within-a-day' });
    expect(log).toEqual([]);
    expect((await heldNow(doorsOf(ADA))).notYetAnchored).toHaveLength(1);
    /* RED WHEN: a day after the last batch the filing still waits. */
    expect(await anchoredOnTheWayIn(at(T + ANCHORED_AT_LEAST_EVERY_MS))).toMatchObject({ anchored: 1 });
    expect(log).toEqual(['ada kept a batch', 'ada sent', 'ada anchored']);
  });

  it('WHEN THE LAST ANCHOR LANDED IS THE TIME ITS BLOCK WAS SET, NOT THE TIME ITS SEAT WROTE IN THE HEADER', async () => {
    const X = T + 2000 * 24 * HOUR;
    await enter(ADA, 'emp_block_time_t1');
    /* The anchor lands in a block set at X; the anchoring seat's clock wrote X plus a day and a half into its header. */
    acmeClock.now = () => X;
    await anchorTheRecordsHere({ ...doorsOf(ADA), now: () => new Date(X + 36 * HOUR - HOUR) });
    expect(Date.parse(headers().at(-1)!.at)).toBe(X + 35 * HOUR);
    await enter(ADA, 'emp_block_time_t2');
    log.length = 0;
    /* RED WHEN: the day is counted from the time the seat wrote - an hour ago - so a filing waits on one seat's word. */
    expect(await anchoredOnTheWayIn(at(X + 36 * HOUR))).toMatchObject({ anchored: 1 });
    expect(log).toEqual(['ada kept a batch', 'ada sent', 'ada anchored']);
  });

  it('NOTHING WAITING IS ANSWERED SO, WHENEVER THE LAST BATCH WAS: NO CALL IS MADE', async () => {
    await anchorTheRecordsHere(doorsOf(ADA));
    log.length = 0;
    /* RED WHEN: a device anchors on the way in with nothing waiting. */
    await expect(anchoredOnTheWayIn(at(T + 400 * 24 * HOUR))).resolves.toEqual({ anchored: 0, head: head() });
    expect(log).toEqual([]);
  });

  it('A PROPOSAL OF THIS SEAT\'S WHOSE ENTRY WAS NOT KEPT IS ENTERED AND ANCHORED ON THE WAY IN, THOUGH NOTHING ELSE WAITS', async () => {
    await anchorTheRecordsHere(doorsOf(ADA));
    const filing = signProposalFiling(CO, {
      id: 'prp_onthewayin01', digest: 'd8'.repeat(32) as Hex, chainId: 'c8'.repeat(32) as Hex, keyEpoch: 0,
      createdAt: '2026-10-09T11:00:00.000Z', sealed: { iv: 'aa', tag: 'bb', body: 'cc' },
    }, ADA.signingSecret as Hex);
    store.putProposal({
      id: filing.id, accountId: CO, status: 'open', createdAt: filing.createdAt, digest: filing.digest, chainId: filing.chainId,
      approvalCount: 0, keyEpoch: 0, sealed: filing.sealed, filedBy: filing.filedBy,
    } as SealedProposal);
    /* RED WHEN: entering the company a day on reads only what the manifest names, so a proposal whose entry was lost is never anchored. */
    expect(await anchoredOnTheWayIn(at(T + 500 * 24 * HOUR))).toMatchObject({ anchored: 1 });
    expect(newestOf(await heldNow(doorsOf(BO)), `proposal:proposal:${filing.id}`))
      .toEqual({ version: 1, digest: proposalEntry(CO, filing).digest });
  });

  it('A LAST BATCH WHOSE TIME IS AHEAD OF THIS DEVICE\'S CLOCK HOLDS NOTHING OFF', async () => {
    await enter(ADA, 'emp_on_the_way_in_f1');
    await anchoredOnTheWayIn(at(T + 300 * 24 * HOUR));
    await enter(ADA, 'emp_on_the_way_in_f2');
    log.length = 0;
    /* RED WHEN: a batch dated ahead - one seat's clock, or its word - stops every device anchoring until that date. */
    expect(await anchoredOnTheWayIn(at(T + 2 * 24 * HOUR))).toMatchObject({ anchored: 1 });
    expect(log).toEqual(['ada kept a batch', 'ada sent', 'ada anchored']);
  });

  it('A SEAT WHOSE ROLE MAY NOT ANCHOR ANCHORS NOTHING ON THE WAY IN, AND SAYS SO', async () => {
    await enter(ADA, 'emp_on_the_way_in_v1');
    log.length = 0;
    const viewing = async () => {
      const d = await acmeDirectory();
      return { ...d, dir: { ...d.dir, seats: d.dir.seats.map((x) => (x.seat === BO.seat ? { ...x, role: 'viewer' as const } : x)) } };
    };
    /* RED WHEN: a seat whose role files nothing proves and sends an anchor no device's check would ever believe. */
    expect(await anchoredOnTheWayIn({ ...doorsOf(BO), directory: viewing as never, now: () => new Date(T + 900 * 24 * HOUR) }))
      .toEqual({ waits: 'this-seat-does-not-anchor' });
    expect(log).toEqual([]);
  });

  it('A SEAT THAT HAS RETIRED ANCHORS NOTHING ON THE WAY IN', async () => {
    await enter(ADA, 'emp_on_the_way_in_r1');
    log.length = 0;
    const retired = async () => {
      const d = await acmeDirectory();
      return { ...d, dir: { ...d.dir, seats: d.dir.seats.map((x) => (x.seat === ADA.seat ? { ...x, retired: {} } : x)) } };
    };
    /* RED WHEN: a retired seat still on the committee anchors - a batch every device's check stops at. */
    expect(await anchoredOnTheWayIn({ ...at(T + 1100 * 24 * HOUR), directory: retired as never })).toEqual({ waits: 'this-seat-does-not-anchor' });
    expect(log).toEqual([]);
  });

  it('A COMPANY NEVER ANCHORED IS ANCHORED ON THE WAY IN AT ONCE: IT DOES NOT WAIT A DAY', async () => {
    const d = at(T + 1200 * 24 * HOUR);
    /* The company as it stood before its first anchor: no batch, the chain's head the empty one. */
    const never: AnchorDoors = {
      ...d,
      tree: {
        ...d.tree, headersAfter: async () => ({ headers: [], entries: [], leaves: [] }), fileHeader: async () => { log.push('kept'); },
      },
      onChain: async () => onChainOf([], acmeHeldNow()),
      service: {
        ...d.service,
        callState: async () => ({ account: ADDRESS, accountState: EMPTY_HEAD, parameters: '', blockHash: 'b' }) as never,
        sendProven: async () => { log.push('sent'); },
      },
    };
    log.length = 0;
    /* RED WHEN: a company with no batch yet is taken as anchored within the day, so its first anchor never comes between raises. */
    expect(await anchoredOnTheWayIn(never)).toMatchObject({ anchored: expect.any(Number) });
    expect(log).toEqual(['kept', 'sent']);
  });

  it('A CHECK STOPPED AT A BATCH IS SAID ON THE WAY IN, EVEN WHEN THE LAST BATCH IS RECENT', async () => {
    /* Two batches within the hour; the service then withholds an entry of the second, so the check passes the first and stops. */
    await enter(ADA, 'emp_on_the_way_in_s1');
    await anchoredOnTheWayIn(at(T + 1300 * 24 * HOUR));
    await enter(ADA, 'emp_on_the_way_in_s2');
    await anchorTheRecordsHere(at(T + 1300 * 24 * HOUR + 60_000));
    const d = at(T + 1300 * 24 * HOUR + HOUR);
    const last = headers().at(-1)!;
    /* The service withholds one entry of the last batch. */
    const withheld: AnchorDoors = { ...d, tree: leavingOutOf(d.tree, (e) => entryIdOf(e) === last.changes[0]!.leaf.entryId) };
    log.length = 0;
    /* RED WHEN: a stopped check is answered as anchored within the day - the device says nothing of records it cannot believe. */
    expect(await anchoredOnTheWayIn(withheld)).toMatchObject({ notAnchored: expect.stringMatching(/the service did not give/u) });
    expect(log).toEqual([]);
  });

  it('AN ANCHOR THAT FAILS ON THE WAY IN IS ANSWERED IN WORDS, NOT THROWN, AND TWO ENTRIES AT ONCE SEND ONE CALL', async () => {
    await enter(ADA, 'emp_on_the_way_in_x1');
    sendFails = 'the node did not answer';
    /* RED WHEN: an anchor failing on the way in throws, so the company is not entered. */
    expect(await anchoredOnTheWayIn(at(T + 1000 * 24 * HOUR))).toEqual({
      notAnchored: 'the company\'s records were not anchored: the anchor was not sent (the node did not answer). Reload the page and anchor again.',
    });
    sendFails = null;
    log.length = 0;
    const both = await Promise.all([anchoredOnTheWayIn(at(T + 1001 * 24 * HOUR)), anchoredOnTheWayIn(at(T + 1001 * 24 * HOUR))]);
    /* RED WHEN: two reads of the company at once each anchor, and the second's call is refused for a fee. */
    expect(log).toEqual(['ada kept a batch', 'ada sent', 'ada anchored']);
    expect(both[0]).toBe(both[1]);
  });
});

describe('A COMPANY\'S FIRST ANCHOR HOLDS THE RECORDS IT WAS FOUNDED WITH, ENTERED BY ITS FOUNDING SIGNER\'S DEVICE', () => {
  /* Eve's company, on a chain of its own: her seat alone holds its account, and nothing of it is anchored yet. */
  const otherChain = aChainAnchor(() => heldBy(chains.get(OTHER)!));
  const otherDirectory = (asked?: RecordsAsked) => directoryWithItsRecordsHere({
    accountId: OTHER, label: OTHER_LABEL, viewingKey: KEY, filings: async () => store.directoryFilingsOf(OTHER), attested: async () => [],
    holders: async () => ({ ...chains.get(OTHER)!.seats, approvals: 1, adoptedVaults: [], account: OTHER_ADDRESS }) as never,
    leaves: leavesOfTheContract,
    anchored: anchoredOver(apiAs('eve'), OTHER, otherChain.read),
  }, asked);
  const evesDoors = (over: Partial<AnchorDoors['service']> = {}): AnchorDoors => ({
    accountId: OTHER,
    material: { signingSecret: EVE.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
    manifest: manifestServiceFor(apiAs('eve')),
    tree: treeServiceFor(apiAs('eve')),
    directory: () => otherDirectory(),
    directoryFilings: async () => store.directoryFilingsOf(OTHER),
    onChain: otherChain.onChain,
    service: {
      callState: async () => ({ account: OTHER_ADDRESS }) as never,
      sendProven: async (_company, tx) => {
        const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
        otherChain.move(previous, batch, held, tag);
      },
      sealedProposals: async (company) => store.listProposals(company),
      foundingRecords: anchorServiceFor(apiAs('eve')).foundingRecords,
      ...over,
    },
    builder,
  });

  it('NO FIRST ANCHOR IS MADE FROM A FIRST BATCH WHOSE STATE OR ROSTER IS A LATER VERSION THAN THE FIRST', async () => {
    /* Entries Eve's seat signed for her company's state and roster, as a manifest might serve them: never kept here. */
    const entryOf = (kind: 'state' | 'roster', id: string, version: number) => signManifestEntry(OTHER, {
      store: 'company', kind, id, version, digest: (kind === 'state' ? 'a1' : 'a2').repeat(32),
    } as ManifestEntryBody, EVE.signingSecret as Hex);
    const serving = (entries: ReturnType<typeof entryOf>[]): AnchorDoors => ({
      ...evesDoors({ foundingRecords: async () => ({ state: null, roster: null }) }),
      tree: {
        ...treeServiceFor(apiAs('eve')),
        pending: async (c, root) => { const m = await treeServiceFor(apiAs('eve')).pending(c, root); return m === null ? null : [...m, ...entries]; },
      },
    });
    /* RED WHEN: a first anchor is made with a roster entry of a version past the first - the company could never be founded from it. */
    await expect(anchorTheRecordsHere(serving([entryOf('state', '0', 1), entryOf('roster', 'signers', 2)])))
      .rejects.toThrow(/first anchor holds the records it was founded with/u);
    /* RED WHEN: a first anchor is made with a state entry of a version past the first. */
    await expect(anchorTheRecordsHere(serving([entryOf('state', '0', 2), entryOf('roster', 'signers', 1)])))
      .rejects.toThrow(/first anchor holds the records it was founded with/u);
    expect(otherChain.landed).toEqual([]);
  });

  it('NO FIRST ANCHOR IS MADE WITHOUT THEM, NONE FROM RECORDS ANOTHER KEY SIGNED, AND THE ONE MADE WITH THEM FOUNDS THE COMPANY', async () => {
    const pol = await aRecordFiledBy(EVE, 'pol_eves_first', 'policy', OTHER);
    await EVE.entered.enter([pol]);
    /* RED WHEN: a first anchor is made without the company's first state and roster - its founding seat could then never be said. */
    await expect(anchorTheRecordsHere(evesDoors())).rejects.toThrow(/first anchor holds the records it was founded with/u);
    expect(otherChain.landed).toEqual([]);
    expect(headers(OTHER)).toEqual([]);
    /* Eve's founding device kept her first roster and first state with the company. */
    const roster = signCompanyFiling(sealRoster(OTHER, { name: 'Other', signers: [] }, 1, 0, KEY), EVE.signingSecret as Hex);
    const state = signedFoundingState(OTHER, sealState({ entries: [] }, newStateBlinding(), KEY, 0), EVE.signingSecret as Hex);
    expect(store.fileRoster(roster)).toBeNull();
    await peopleRecords.put(state);
    /* The service serves a first roster another key signed in place of Eve's, and no first state. */
    const forgedRoster = signCompanyFiling(sealRoster(OTHER, { name: 'Other', signers: [] }, 1, 0, KEY), newSigningKeypair().secret);
    await expect(anchorTheRecordsHere(evesDoors({ foundingRecords: async () => ({ state: null, roster: forgedRoster }) })))
      .rejects.toThrow(/first anchor holds the records it was founded with/u);
    /* RED WHEN: a device enters a first roster its own seat did not sign as the one it founded the company with - anchored in batch 0, the company could never be founded. */
    expect(store.manifestOf(OTHER).entries.filter((e) => e.kind === 'roster')).toEqual([]);
    expect(otherChain.landed).toEqual([]);
    /* The service serves a first state another key signed in place of Eve's. */
    const forged = signedFoundingState(OTHER, sealState({ entries: [] }, newStateBlinding(), KEY, 0), newSigningKeypair().secret);
    /* RED WHEN: a device enters a first state its own seat did not sign as the one it founded the company with. */
    await expect(anchorTheRecordsHere(evesDoors({ foundingRecords: async () => ({ state: forged, roster }) })))
      .rejects.toThrow(/first anchor holds the records it was founded with/u);
    expect(otherChain.landed).toEqual([]);
    /* RED WHEN: the founding device does not enter its own first state and roster before the company's first anchor. */
    await expect(anchorTheRecordsHere(evesDoors())).resolves.toMatchObject({ anchored: 4 });
    const first = headers(OTHER)[0]!;
    const named = store.manifestOf(OTHER).entries.filter((e) => first.changes.some((c) => c.leaf.entryId === entryIdOf(e)))
      .map((e) => `${e.store}:${e.kind}:${e.id}@${e.version}`).sort();
    expect(named).toEqual(['company:policy:pol_eves_first@1', 'company:roster:signers@1', 'company:state:0@1', 'directory:directory:directory@1']);
    /* RED WHEN: the company is not founded on chain once that first batch lands. */
    expect(foundedOnChainHere(await otherDirectory({ founding: true }))).toBeNull();
  });

  it('A COMPANY WHOSE ACCOUNT WAS NOT MADE ON ITS FOUNDING SIGNER\'S DEVICE, HELD BY THEIR WALLET ALONE FROM ITS DEPLOY, HAS NO FOUNDING SEAT', async () => {
    /* Eve's company as the test before this one founded it: anchored first by her seat with her first state and roster. */
    expect(otherChain.landed.length).toBeGreaterThan(0);
    const deployedAs = (deployed: AccountDeployed | null) => directoryWithItsRecordsHere({
      accountId: OTHER, label: OTHER_LABEL, viewingKey: KEY, filings: async () => store.directoryFilingsOf(OTHER), attested: async () => [],
      holders: async () => ({ ...chains.get(OTHER)!.seats, approvals: 1, adoptedVaults: [], account: OTHER_ADDRESS }) as never,
      leaves: leavesOfTheContract,
      anchored: anchoredOver(apiAs('eve'), OTHER, () => ({ ...otherChain.read(), deployed })),
    }, { founding: true });
    const onHerDevice = otherChain.read().deployed!;
    expect(onHerDevice).toMatchObject({ seats: [EVE.seat.toLowerCase()], threshold: 1, updates: 0, ranSecondStep: false });
    expect(foundedOnChainHere(await deployedAs(onHerDevice))).toBeNull();
    const noSeat = /was not held by its founding signer's own wallet alone from its deploy, so it has no founding seat/u;
    /* RED WHEN: an account deployed held by a key other than the founding seat's own - the service's, on the path where it made the founding secrets - founds a company. */
    const servicesKey = { tag: 'schnorr', value: 'cd'.repeat(32) };
    expect(foundedOnChainHere(await deployedAs({ ...onHerDevice, committee: [servicesKey] }))).toMatch(noSeat);
    /* RED WHEN: a committee of two, the founding seat's key among them, founds a company. */
    expect(foundedOnChainHere(await deployedAs({ ...onHerDevice, committee: [...onHerDevice.committee, servicesKey] }))).toMatch(noSeat);
    /* RED WHEN: a threshold other than one - none, so an update needs no signature - founds a company. */
    expect(foundedOnChainHere(await deployedAs({ ...onHerDevice, threshold: 0 }))).toMatch(noSeat);
    /* RED WHEN: an account deployed already running its anchor - so its first anchor needed no signature of the founding wallet - founds a company. */
    expect(foundedOnChainHere(await deployedAs({ ...onHerDevice, ranSecondStep: true }))).toMatch(noSeat);
    /* RED WHEN: a first state whose committee was already updated in the deploy's block - by a committee the deploy named - founds a company. */
    expect(foundedOnChainHere(await deployedAs({ ...onHerDevice, updates: 1 }))).toMatch(noSeat);
    /* RED WHEN: an account deployed seating another seat, or two, founds a company. */
    expect(foundedOnChainHere(await deployedAs({ ...onHerDevice, seats: ['ef'.repeat(32)] }))).toMatch(noSeat);
    expect(foundedOnChainHere(await deployedAs({ ...onHerDevice, seats: [...onHerDevice.seats, 'ef'.repeat(32)] }))).toMatch(noSeat);
    /* RED WHEN: a history that does not open with the account's deploy founds a company. */
    expect(foundedOnChainHere(await deployedAs(null))).toMatch(noSeat);
  });
});
