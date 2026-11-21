/**
 * **AN ANCHOR READS AND WRITES THROUGH THE STEP'S ONE READ OF THE COMPANY.**
 * Handed the step's view, a device anchoring the company's records reads held,
 * the directory with its records, its filings, the manifest, the record tree
 * and the account's anchors through it, keeps what it signs in the view's own
 * stores, and writes every entry, header, directory filing and the anchor's own
 * send through the view's one write: the check that nobody else changed the
 * company runs before each, and the view forgets what each write changes. An
 * attempt after another device anchored first reads from a fresh view; a write
 * the service refuses ends the view, and nothing is read again from what it kept.
 *
 * Over real HTTP with the company's manifest, tree and directory as the service
 * keeps them, its proposals as the store lists them; the chain is the test's,
 * moved by the anchor the service is sent.
 * Each view reads held as a device's judges do (`heldReaderOver`), against the
 * directory believed over that same view. Every door the anchor would use
 * without a view refuses here, so a read or write around the view fails the case.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { sign, type Hex } from '../core/crypto.js';
import { manifestPaths } from '../midnight/record-manifest.js';
import { treeBatchOf, type TreeHeader } from '../midnight/record-tree.js';
import { directoryChangeMessage, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import { anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { directoryChangeFiledHere } from 'vaults-web-shared/anchored-on-the-way-in.js';
import { heldHere } from 'vaults-web-shared/anchored-through-the-view.js';
import { companyViewFor, viewHeldOver, ViewEnded, type CompanyView, type HeldReader, type ViewHeld } from 'vaults-web-shared/company-view.js';
import { heldReaderOver, judgeReadsOf } from 'vaults-web-shared/company-view-judges.js';
import { FiledNotEntered, recordsEnteredFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorTheRecordsHere, type AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import { throughAView } from '../testing/anchor-doors-through-a-view.js';
import { anchorServiceThrough } from 'vaults-web-shared/anchored-through-the-view.js';
import { manifestServiceOf, serviceSource, treeServiceOf } from 'vaults-web-shared/records-source.js';
import { treeKeptInMemory, type TreeKept } from 'vaults-web-shared/tree-kept-here.js';
import { directoryWithItsRecordsHere } from 'vaults-web-shared/vault-page-doors.js';
import type { VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryDeps, acmeReads, ADA, ADDRESS, apiAs, aRecordFiledBy, BO, CO, store, type Seat,
} from './a-company-of-two-seats.test-support.js';
import { foundingRecordsOver } from '../testing/writes-over-a-send.js';

aCompanyOfTwoSeats();

/** Every request a device's view sent, in order, as `read|write METHOD path`. */
const sent: string[] = [];
/** How many writes the views had sent when each held read was made. */
const heldReadAfter: number[] = [];
/** Run once when the service is sent an anchor, before the chain applies it: what another device does meanwhile. */
let meanwhile: (() => Promise<void>) | null = null;

beforeEach(() => { sent.length = 0; heldReadAfter.length = 0; meanwhile = null; });

const writes = (): number => sent.filter((r) => r.startsWith('write ')).length;
const aroundTheView = (what: string) => async (): Promise<never> => { throw new Error(`${what} was used around the view`); };
const builder = { ...anchorFunctions, anchor: anchorSentInATest } as unknown as VaultBuilderClient;

/** A header the service has lost, given again only once a device files it again. */
interface Losing { readonly batch: Hex; refiled: boolean }

/**
 * The service as `s`'s device reaches it: the routes mounted here, and the chain moved by an anchor sent to it. With
 * `losing`, the service leaves that header out of every page of headers until a device files it again.
 */
const serviceFor = (s: Seat, losing?: Losing) => async (path: string, init?: RequestInit & { read?: boolean }): Promise<unknown> => {
  const writing = init?.method !== undefined && init.method !== 'GET' && init.read !== true;
  sent.push(`${writing ? 'write' : 'read'} ${init?.method ?? 'GET'} ${path}`);
  if (path === `/api/accounts/${CO}/proven`) {
    const { previous, batch, held, tag } = JSON.parse(JSON.parse(String(init!.body)).tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
    const before = meanwhile;
    meanwhile = null;
    await before?.();
    acmeChain.move(previous, batch, held, tag);
    return { ok: true };
  }
  /* The company's proposals, as the service lists them; its route is not mounted here. */
  if (path === `/api/accounts/${CO}/proposals`) return store.listProposals(CO);
  const isLost = (h: TreeHeader) => losing !== undefined && !losing.refiled && treeBatchOf(h) === losing.batch;
  if (writing && path === manifestPaths.treeHeaders(CO) && isLost(JSON.parse(String(init!.body)).header)) losing!.refiled = true;
  const answer = await apiAs(s.person)(path, init).catch((e: unknown) => { sent.push(`refused ${path}`); throw e; });
  if (!writing && path.startsWith(`${manifestPaths.treeHeaders(CO)}?`)) return { ...answer, headers: answer.headers.filter((h: TreeHeader) => !isLost(h)) };
  return answer;
};

/** A view of Acme for `s`'s device, its stores `kept`: held read as the judges read it, against the directory believed over it. */
const viewFor = (s: Seat, kept: Partial<TreeKept> = treeKeptInMemory(), losing?: Losing): CompanyView<AccountHoldersRead> => {
  const call = serviceFor(s, losing);
  const reader = heldReaderOver({ kept: () => { throw new Error('a store was used around the view'); }, builder: async () => builder });
  const held: HeldReader = (view, asked) => { heldReadAfter.push(writes()); return reader(view, asked); };
  return companyViewFor(serviceSource(call, CO), {
    holders: acmeReads.holders as () => Promise<AccountHoldersRead>,
    onChain: acmeChain.onChain, builder: { anchorHeads: anchorFunctions.anchorHeads },
    kept: () => kept,
    directory: (view) => directoryWithItsRecordsHere({
      ...acmeDirectoryDeps(), filings: () => view.filings(), holders: () => view.holders(),
      anchored: judgeReadsOf({ view: () => view }, CO).anchored,
    }),
  }, held);
};

/** `s`'s anchor doors with the step's view: every door the anchor reads or writes without a view refuses. */
const doorsThrough = (s: Seat, view: ViewHeld<unknown>): AnchorDoors => ({
  accountId: CO,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: { newest: aroundTheView('the manifest'), enter: aroundTheView('the manifest') },
  tree: { headersAfter: aroundTheView('the tree'), fileHeader: aroundTheView('the tree'), proofs: aroundTheView('the tree'), pending: aroundTheView('the tree') },
  directory: aroundTheView('the caller\'s directory'),
  directoryFilings: aroundTheView('the directory\'s filings'),
  fileDirectory: aroundTheView('the directory'),
  onChain: aroundTheView('the chain'),
  /* The service the wallet builds for its anchor: its reads and send refuse, so they go through each attempt's own view or nowhere. */
  service: {
    ...anchorServiceThrough(view),
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
  },
  builder,
  view,
});

/** `s`'s doors as another device anchors: its own view, over the service as it reaches it. */
const plainDoorsOf = (s: Seat): AnchorDoors => throughAView({
  ...doorsThrough(s, viewHeldOver(() => viewFor(s))), fileDirectory: undefined,
  manifest: manifestServiceOf(serviceSource(apiAs(s.person), CO)), tree: treeServiceOf(serviceSource(apiAs(s.person), CO)),
  directory: () => directoryWithItsRecordsHere(acmeDirectoryDeps()),
  directoryFilings: async () => store.directoryFilingsOf(CO), onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_company, tx) => { await serviceFor(s)(`/api/accounts/${CO}/proven`, { method: 'POST', body: JSON.stringify({ tx }) }); },
    sealedProposals: async (company) => store.listProposals(company),
    foundingRecords: foundingRecordsOver(apiAs(s.person), CO),
  },
});

/** A record `s` filed whose entry the service dropped: what `s`'s device enters again when it anchors. */
const filedAndDropped = async (s: Seat, id: string) => {
  const dropping = { ...manifestServiceOf(serviceSource(apiAs(s.person), CO)), enter: async () => { throw new Error('the service dropped the connection'); } };
  const entry = await aRecordFiledBy(s, id);
  await expect(recordsEnteredFor(dropping, CO, s.signingSecret as Hex).enter([entry])).rejects.toBeInstanceOf(FiledNotEntered);
  return entry;
};

describe('AN ANCHOR HANDED THE STEP\'S VIEW', () => {
  it('ENTERS, FILES AND SENDS EVERYTHING THROUGH THE VIEW, CHECKED BEFORE EACH WRITE, AND READS HELD ONCE, AFTER ITS OWN ENTRIES', async () => {
    const entry = await filedAndDropped(ADA, 'pol_through_the_view');
    const out = await anchorTheRecordsHere(doorsThrough(ADA, viewHeldOver(() => viewFor(ADA))));
    expect(out.anchored).toBeGreaterThan(0);
    /* RED WHEN: the entry, the header or the send is written around the view - the doors without it refuse, and nothing is anchored. */
    expect(store.manifestOf(CO).entries.some((e) => e.id === entry.id)).toBe(true);
    const written = sent.filter((r) => r.startsWith('write '));
    expect(written.slice(-2)).toEqual([`write POST ${manifestPaths.treeHeaders(CO)}`, `write POST /api/accounts/${CO}/proven`]);
    expect(new Set(written.slice(0, -2))).toEqual(new Set([`write POST ${manifestPaths.entries(CO)}`]));
    /* RED WHEN: a batch of writes is sent without the check before it: the directory's filings and the newest versions read again. */
    let from = 0;
    for (const w of written) {
      const at = sent.indexOf(w, from);
      const before = sent.slice(from, at);
      expect(before, w).toContain(`read GET /api/accounts/${CO}/directory`);
      expect(before.some((r) => r === `read POST ${manifestPaths.newest(CO)}`), w).toBe(true);
      from = at + 1;
    }
    /* RED WHEN: held is read before the anchor's own entry is entered (it would be left out), or read more than once with nothing written between. */
    expect(heldReadAfter).toEqual([written.length - 2]);
  });

  it('A HEADER IT SIGNED THROUGH THE VIEW AND THE SERVICE THEN LOSES IS FILED AGAIN BY THE NEXT READ THROUGH A VIEW', async () => {
    const kept = treeKeptInMemory();
    await filedAndDropped(ADA, 'pol_signed_then_lost');
    await anchorTheRecordsHere(doorsThrough(ADA, viewHeldOver(() => viewFor(ADA, kept))));
    const losing: Losing = { batch: treeBatchOf(store.keptTreeOf(CO).headers.at(-1)!), refiled: false };
    const read = await heldHere(doorsThrough(ADA, viewHeldOver(() => viewFor(ADA, kept, losing))), {});
    /* RED WHEN: the anchor keeps the header it signed somewhere other than the stores the view's reads file again from. */
    expect(losing.refiled).toBe(true);
    expect(read.records.stopped).toBeNull();
  });

  it('AFTER ANOTHER DEVICE ANCHORS FIRST, READS AGAIN FROM A FRESH VIEW, ITS DIRECTORY BELIEVED OVER THAT VIEW, AND ANCHORS WHAT IS LEFT', async () => {
    await filedAndDropped(ADA, 'pol_raced_through_the_view');
    const views: CompanyView<AccountHoldersRead>[] = [];
    const held = viewHeldOver(() => { const v = viewFor(ADA); views.push(v); return v; });
    /* Bo's device anchors what is waiting first, while Ada's call is on its way to the service. */
    meanwhile = async () => { await anchorTheRecordsHere(plainDoorsOf(BO)); };
    /* RED WHEN: the attempt after the race reads the view the race moved past, or a directory not believed over the fresh view. */
    const out = await anchorTheRecordsHere(doorsThrough(ADA, held));
    expect(views.length).toBe(2);
    expect(views[0]!.ended).toMatch(/refused, or its outcome is not known/u);
    expect(views[1]!.ended).toBeNull();
    expect(out.anchored).toBe(0);
  });

  it('A DIRECTORY FILING THE SERVICE REFUSES ENDS THE VIEW, AND THE NEXT USE READS THE COMPANY AGAIN', async () => {
    const held = viewHeldOver(() => viewFor(ADA));
    const first = held.current();
    const version = store.directoryFilingsOf(CO).length + 1;
    const change = { kind: 'retire', seat: BO.seat, filedUpTo: {}, statement: BO.statement, threshold: 1, signatures: [] } as unknown as DirectoryChange;
    /* Signed by Bo's key over another version: the service refuses it. */
    const signature = sign(directoryChangeMessage(CO, version + 7, change), BO.signingSecret);
    const signed = { ...change, signatures: [{ publicKey: BO.statement.signingKey as Hex, signature }] } as unknown as DirectoryFiling['change'];
    await expect(directoryChangeFiledHere(doorsThrough(ADA, held), signed as never, version)).rejects.toThrow();
    /* RED WHEN: the filing goes around the view, or a refused write leaves the view answering from what it kept. */
    expect(sent.filter((r) => r.startsWith('write '))).toEqual([`write PUT /api/accounts/${CO}/directory/${version}`]);
    expect(first.ended).toMatch(/refused/u);
    await expect(first.filings()).rejects.toBeInstanceOf(ViewEnded);
    expect(held.current()).not.toBe(first);
    await expect(held.current().filings()).resolves.toBeDefined();
  });
});
