/**
 * **ONE COMPANY'S RECORDS, FROM ONE SEAT'S DEVICE TO ANOTHER'S, THROUGH THE
 * ANCHOR ON CHAIN.** Ada's device files a person, changes them, and anchors;
 * Bo's device reads them as the service serves them - stale, withheld,
 * reordered, or newer and not yet anchored - and believes only what folds into
 * the head the chain holds. Two devices anchor the same head at once, and the
 * one whose send the chain dropped without a word reads where the head went
 * and finishes. And a leg charged to its vault's period, retried, is charged
 * once.
 *
 * What is real here: the company's service and its routes, every device's
 * filing, entering, folding and anchoring, and, for the charge, the compiled
 * account run by its own circuits. What is the test's: the chain an anchor
 * lands on, which moves only as the account's circuit would.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../core/crypto.js';
import { fromHex, toHex } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { theNetwork } from '../midnight/network.js';
import { toCompanyWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { newestAnchored } from '../midnight/records-held.js';
import { anchorServiceFor, anchorTheRecordsHere, type AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import { inviteHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { readPeopleHere, setStatusHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { directoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { anchoredOver, anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { NO_LEG, retryArgsOf } from '../midnight/spending-policy-record.js';
import { payoutTreeOf, AccountSimulator, change, privateStateFor, TEST_TOKEN_BYTES } from '../../contracts/test/simulator.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import type { PolicyOpening } from '../../contracts/src/witnesses.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryDeps, acmeDirectoryWithItsFold, ACME, ADA, ADDRESS, aRecordFiledBy, apiAs, BO, CO,
  fromAda, ORIGIN, personVersions, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';
/** The day a payee leaves when a test marks them a leaver: their first day, with no month raised yet to leave out. */
const LEFT = { leavingDate: '2026-10-01', pastDraft: async (): Promise<string[]> => [] };

aCompanyOfTwoSeats();

const NETWORK = theNetwork();

/** One seat's device anchoring what is waiting, on the test's chain; `send` is how its proven call reaches the chain. */
const anchoringOn = (s: Seat, send: (tx: string) => Promise<unknown> = async (tx) => landed(tx)): AnchorDoors => ({
  accountId: CO, manifest: manifestServiceFor(apiAs(s.person)), tree: treeServiceFor(apiAs(s.person)),
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  directory: () => acmeDirectoryWithItsFold(), directoryFilings: async () => store.directoryFilingsOf(CO),
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_c, tx) => send(tx),
    sealedProposals: async (c) => store.listProposals(c),
    foundingRecords: anchorServiceFor(apiAs(s.person)).foundingRecords,
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
  /* The account's history read again at once while a send has not answered. */
  watch: { everyMs: 1, sleep: async () => { await new Promise((r) => { setImmediate(r); }); } },
});
/** An anchor call landing on the test's chain, refused there as the account's circuit refuses it. */
const landed = (tx: string): void => {
  const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
  acmeChain.move(previous, batch, held, tag);
};

/** A seat's device reading the company's people, over what `serve` makes of the list the service sends, and of its manifest. */
const peopleOn = (
  s: Seat, serve: (body: unknown) => unknown = (b) => b, manifest: (m: any) => any = (m) => m,
): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, network: NETWORK, entered: s.entered,
  directory: (asked) => directoryHere({
    ...acmeDirectoryDeps(),
    anchored: anchoredOver(async (path, init) => {
      const r = await apiAs(s.person)(path, init);
      return path.includes('/manifest/tree/headers') ? manifest(r) : r;
    }, CO, acmeChain.read),
  }, asked),
  send: async (path, init) => {
    const r = await sendAs(s.person)(path, init);
    return path.endsWith('/people') && init.method === 'GET' ? { ...r, body: serve(r.body) } : r;
  },
});
/** The service's list with `id`'s record replaced by `version` of it. */
const serving = (id: string, version: SealedCompanyRecord) => (body: unknown) => ({
  ...(body as object),
  people: ((body as { people: Array<{ filed: { id: string } }> }).people).map((row) => (row.filed.id === id ? { ...row, filed: toCompanyWire(version) } : row)),
});
/** The service's list with `id` left out. */
const leavingOut = (id: string) => (body: unknown) => ({
  ...(body as object), people: (body as { people: Array<{ filed: { id: string } }> }).people.filter((row) => row.filed.id !== id),
});
const pay = { name: 'Pat', email: 'pat-e2e@acme.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500_202n, classification: 'full-time' as const, startDate: '2026-10-01' };

describe('WHAT A SECOND DEVICE BELIEVES OF THE COMPANY\'S RECORDS IS WHAT THE ANCHOR HOLDS', () => {
  it('STALE, WITHHELD AND REORDERED ARE REFUSED ON BO\'S DEVICE, NEWER IS HELD AS NOT YET ANCHORED, AND A DROPPED ANCHOR FINISHES', async () => {
    /* Ada's device invites Pat, anchors, marks Pat a leaver, and anchors again. */
    const pat = (await inviteHere(ACME, ADA, 'employee', pay, ORIGIN, fromAda)).person!;
    await anchorTheRecordsHere(anchoringOn(ADA));
    const atFirst = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === pat)!;
    await setStatusHere(peopleOn(ADA), atFirst, 'leaver', LEFT);
    await anchorTheRecordsHere(anchoringOn(ADA));
    const [first, second] = await personVersions(pat);
    /* Bo's device believes the anchored newest version. */
    expect((await readPeopleHere(peopleOn(BO))).people.find((p) => p.person.id === pat)?.version).toBe(2);
    /* RED WHEN: Bo's device believes a version older than the one the anchor holds - a leaver served as still invited. */
    expect((await readPeopleHere(peopleOn(BO, serving(pat, first!)))).notBelieved).toContain(pat);
    /* RED WHEN: Bo's device reads a person the anchor holds and the service leaves out as nobody. */
    const withheld = await readPeopleHere(peopleOn(BO, leavingOut(pat)));
    expect(withheld.notBelieved).toContain(pat);
    expect(withheld.people.map((p) => p.person.id)).not.toContain(pat);
    /* The service serves the company's records with the entries of its largest batch in another order than its seat signed them. */
    const kept = store.keptTreeOf(CO).headers;
    const largest = kept.reduce((best, h, i, all) => (h.changes.length > all[best]!.changes.length ? i : best), 0);
    const reordered = (m: { headers: Array<{ seq: number; changes: unknown[] }> }) => ({
      ...m, headers: m.headers.map((h) => (h.seq === kept[largest]!.seq ? { ...h, changes: [...h.changes].reverse() } : h)),
    });
    expect(kept[largest]!.changes.length).toBeGreaterThan(1);
    /* RED WHEN: records served in another order than the anchor holds them are believed on Bo's device. */
    await expect(readPeopleHere(peopleOn(BO, (b) => b, reordered))).rejects.toThrow(/cannot be read past a batch this device cannot open/u);
    /* Ada's device changes Pat again and enters it; nothing anchors it yet. */
    const now = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === pat)!;
    await setStatusHere(peopleOn(ADA), now, 'leaver', LEFT);
    /* RED WHEN: a version entered and not yet anchored is refused as forged on Bo's device - every filing would wait for the next anchor. */
    expect((await readPeopleHere(peopleOn(BO))).people.find((p) => p.person.id === pat)?.version).toBe(3);
    /* RED WHEN: the anchored version served in place of the newer one entered is read as the newest on Bo's device. */
    expect((await readPeopleHere(peopleOn(BO, serving(pat, second!)))).notBelieved).toContain(pat);

    /* Bo's device files a proposal and anchors; while its call is with the node, Ada's device anchors the same head and lands. */
    const bos = await aRecordFiledBy(BO, 'prp_e2e_bo', 'proposal');
    await BO.entered.enter([bos]);
    let sends = 0;
    const dropped = anchoringOn(BO, async (tx) => {
      sends += 1;
      if (sends > 1) return landed(tx);
      await anchorTheRecordsHere(anchoringOn(ADA));
      /* The node dropped Bo's call for Ada's, which named the same head, and nothing ever answers it. */
      return new Promise(() => {});
    });
    /* RED WHEN: a send the chain dropped without a word is waited on for good - Bo's device never finishes, and nothing it filed is anchored by it. */
    await expect(anchorTheRecordsHere(dropped)).resolves.toMatchObject({ anchored: 0 });
    expect(sends).toBe(1);
    /* What Bo's device filed is held by the anchor Ada's device made. */
    const boFiled = { store: 'company' as const, kind: 'proposal', id: 'prp_e2e_bo' };
    expect(newestAnchored((await acmeDirectoryWithItsFold({ records: [boFiled] })).records, boFiled)).toBe(1);
  });
});

/* A vault under a spending policy on the compiled account, with two signers who approve. */
const A = privateStateFor(1);
const B = privateStateFor(2);
const NOW = 1_800_000_000;
const DAY = 86_400;
const VAULT = Uint8Array.from({ length: 32 }, (_, i) => (0xc1 + i) & 0xff);
const bytes = (seed: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (seed * 37 + i * 11 + 5) & 0xff);
const POLICY: PolicyOpening = {
  terms: {
    bands: [{ ceiling: 1_000n, approvals: 2n }, { ceiling: 5_000n, approvals: 2n }, { ceiling: 10_000n, approvals: 2n }, { ceiling: 100_000n, approvals: 2n }],
    periodLimit: 1_500n, periodStart: BigInt(NOW - 10 * DAY), periodLength: BigInt(30 * DAY),
  },
  blinding: bytes(900),
};
const periodKey = () => pureCircuits.periodKeyOf(
  pureCircuits.policyKeyOf(VAULT, pureCircuits.assetKeyOf(TEST_TOKEN_BYTES, A.assetBlinding)), pureCircuits.policyCommitmentOf(POLICY), 0n);

describe('A LEG CHARGED TO ITS VAULT\'S PERIOD, RETRIED, IS CHARGED ONCE', () => {
  it('THE RETRY IS CHARGED ONLY FOR WHAT ITS LEG\'S CHARGE DID NOT COUNT, WITH WHAT THE DEVICE SENDS FOR A RETRY', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    await sim.adoptVault(VAULT, [A, B]);
    /* The vault's policy, set by the account's own circuit. */
    const pc = change(0n, 701);
    const commitment = pureCircuits.policyCommitmentOf(POLICY);
    const policyPayload = pureCircuits.setPolicyPayload(VAULT, pureCircuits.assetKeyOf(TEST_TOKEN_BYTES, A.assetBlinding), commitment);
    await sim.as(sim.applying(A, pc)).propose(policyPayload);
    const policyId = sim.proposalId(policyPayload, pc.salt);
    /* A's raise is A's approval. */
    for (const s of [B]) await sim.as(s).approve(policyId);
    await sim.as({ ...sim.applying(A, pc), policy: POLICY }).setPolicy(VAULT, commitment, policyId);
    /* A leg of two people, raised with the salt a leg's raise names (no leg), approved, and charged. */
    const payments = [0, 1].map((i) => ({ details: toHex(bytes(10 + i)), nonce: toHex(bytes(70 + i)) }));
    const leg = payoutTreeOf(payments, [600n, 400n], TEST_TOKEN_BYTES);
    const from = BigInt(NOW - 3_600); const until = BigInt(NOW + 3_600);
    const raised = async (tree: typeof leg, seed: number, legRoot: Uint8Array) => {
      const fresh = bytes(seed + 300);
      const c = { ...change(0n, seed, TEST_TOKEN_BYTES), salt: pureCircuits.retrySaltOf(legRoot, fresh) };
      await sim.as(sim.applying(A, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from, until, vault: VAULT, required: 2n });
      const id = sim.proposalId(pureCircuits.runPayload(fromHex(tree.root), tree.payees, from, until, 2n), c.salt, VAULT);
      for (const s of [B]) await sim.as(sim.applying(s, c)).approve(id);
      return { id, c, fresh, tree };
    };
    const charge = (r: Awaited<ReturnType<typeof raised>>, spent: bigint, retry?: { leg: Uint8Array; legTop: bigint; legTotal: bigint }) => {
      /* What the device sends for the run: its leg (none for a leg of the run), its fresh salt, and the leg's top and total. */
      const [legRoot, fresh, legTop, legTotal] = retryArgsOf(r.fresh, retry);
      return sim.as({ ...sim.applying(A, r.c), policy: POLICY, periodSpent: spent, legTaken: 0n }).clearRun({
        proposal: r.id, vault: VAULT, root: fromHex(r.tree.root), payees: r.tree.payees, from, until, required: 2n, salt: r.c.salt,
        top: r.tree.top, total: r.tree.total, period: 0n, fresh,
        ...(retry === undefined ? {} : { retry: { leg: legRoot, legTop, legTotal } }),
      });
    };
    const first = await raised(leg, 711, NO_LEG());
    await charge(first, 0n);
    expect(sim.roleEntry(periodKey())).toEqual(pureCircuits.periodTotalOf(1_000n, pureCircuits.periodBlindingOf(POLICY.blinding, 0n)));
    /* A retry of the second person, raised over the leg's root, charged as the device charges a retry. */
    const retryTree = payoutTreeOf([payments[1]!], [400n]);
    const retry = await raised(retryTree, 712, fromHex(leg.root));
    await charge(retry, 1_000n, { leg: fromHex(leg.root), legTop: leg.top, legTotal: leg.total });
    /* RED WHEN: a retry is charged to the period again for what its leg's charge already counted - the period would read 1,400. */
    expect(sim.roleEntry(periodKey())).toEqual(pureCircuits.periodTotalOf(1_000n, pureCircuits.periodBlindingOf(POLICY.blinding, 0n)));
    expect(sim.openChange(retry.id)).toEqual(pureCircuits.clearedMark());
  });
});
