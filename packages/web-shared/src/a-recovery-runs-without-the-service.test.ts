/**
 * **A RECOVERY OF THE RECORD ANCHOR IS RAISED, APPROVED AND CARRIED OUT ON THE
 * SIGNERS' OWN DEVICES, AND NONE OF IT NEEDS THE COMPANY'S SERVICE.**
 *
 * A batch no device can check - its header kept by nobody, or false - stops
 * every device's read of the company's records. The quorum moves the anchor
 * on past it from the last header their devices checked. The seat raising it
 * hands the others a file; each device checks the file against the chain at
 * the indexer the person's own wallet names, and approves only where its own
 * read holds to the rule: the header the recovery resumes from is one
 * it checked, and the header right after is one it cannot. A call is believed
 * sent only when the chain shows it; one the service will not send, or says it
 * sent and the chain does not show, goes from the person's own wallet when the
 * person chooses it. The one to read first is "A HEADER NOBODY KEPT".
 */
import { describe, expect, it } from 'vitest';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import { newSigningKeypair, type Hex } from '../../../src/core/crypto.js';
import { signManifestEntry, type ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import { nextTreeHeader, signTreeHeader, type TreeHeader } from '../../../src/midnight/record-tree.js';
import { anchorFunctions, aTreeCompany, headAfterStep, headsByTheAccount, ACCOUNT_IN_A_TEST, tagInATest } from '../../../src/testing/record-tree-double.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { buildGovernedCall, identityOfAChange, lastRecoveryIn, type GovernanceOnTheWire, type GovernedCallDeps } from './governed-call-builder.js';
import type { BatchHolders } from '../../../src/midnight/record-manifest.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { fullCheckHere } from './records-anchored-here.js';
import { treeKeptInMemory, type TreeKept } from './tree-kept-here.js';
import {
  PROPOSAL_FILE_FORMAT, proposalFileRead, proposalFileText, sentFromHere, type ProposalFile,
} from './governance-from-the-chain.js';
import {
  approveRecoveryHere, carryOutRecoveryHere, raiseRecoveryHere, RecoveryNotCarriedOut, recoveryRefusal, type OwnStanding, type RecoveryDoors,
} from './records-recovered-here.js';

const COMPANY = 'acct_recovered';
const ACCOUNT = ACCOUNT_IN_A_TEST;
const A = { ...newSigningKeypair(), blinding: '0a'.repeat(32) as Hex };
const B = { ...newSigningKeypair(), blinding: '0b'.repeat(32) as Hex };
const C = { ...newSigningKeypair(), blinding: '0c'.repeat(32) as Hex };
const seats = new Map<Hex, string>([[A.publicKey, 'seat-a'], [B.publicKey, 'seat-b'], [C.publicKey, 'seat-c']]);
/** Who holds the account: any two of the three. */
const HELD: BatchHolders = { approvals: 2, signerRoot: '0e'.repeat(32), signers: ['a1'.repeat(32), 'b1'.repeat(32), 'c1'.repeat(32)] };
const INDEXER = { indexerUri: 'https://indexer.invalid/api', indexerWsUri: 'wss://indexer.invalid/ws' };
const person = (id: string, version: number, digest: string): ManifestEntryBody =>
  ({ store: 'company', kind: 'person', id, version, digest: digest.repeat(32) });
const b64 = (s: string) => Buffer.from(s).toString('base64');
/** Every device's clock in these tests, and the last time each recovery is raised to be carried out by. */
const NOW = new Date('2026-10-11T00:00:00Z');
const LATEST = new Date('2026-10-12T00:00:00Z');
const LATEST_SECONDS = String(LATEST.getTime() / 1000);

/**
 * **THE ACCOUNT ON A TEST'S CHAIN, AS THE WALLET'S INDEXER SHOWS IT**: proposals
 * opened by a raise, counted by approvals from distinct seats, and closed by
 * the recovery that carries one out. A recovery naming another head than the
 * one the chain holds lands refused, as one in its transaction's fallible
 * section does - its fee paid, nothing written, its proposal left open and the
 * refused call in the history - and so do one past its last time and one naming
 * another latest recovery than the account holds; one for other holders is
 * refused whole. `bar` is the approvals a recovery needs, as the account
 * counts them (the higher of its threshold and its policy bar). The account's
 * state, as the wallet's indexer hands it over, holds its record anchor's head
 * and the head the latest recovery carried out wrote, under the account's own
 * keys; `handed` is every state it handed over.
 */
const aChain = (c: ReturnType<typeof aTreeCompany>) => {
  const proposals = new Map<string, { held: 'open' | 'closed'; approvals: number; by: Set<string>; failed: string[] }>();
  const sent: string[] = [];
  const bar = { needed: HELD.approvals };
  /* The head the latest recovery carried out wrote: none before the first. */
  const latest: { recovery: string | null } = { recovery: null };
  const handed = new Set<string>();
  /* The chain's block time, in seconds: the recovery is refused from its latest time on, as the account's circuit refuses it. */
  const time = { now: NOW.getTime() / 1000 };
  const takes = (tx: string): void => {
    const t = JSON.parse(Buffer.from(tx, 'base64').toString());
    sent.push(t.circuit);
    const p = proposals.get(t.proposal);
    if (t.circuit === 'propose') {
      if (p !== undefined) throw new Error('that proposal is already open');
      proposals.set(t.proposal, { held: 'open', approvals: 0, by: new Set(), failed: [] });
      return;
    }
    /* A recovery whose proposal another carrying out closed lands refused, as one in the fallible section does. */
    if (t.circuit === 'recoverAnchor' && p?.held === 'closed') return;
    if (p === undefined || p.held !== 'open') throw new Error('no such open proposal');
    if (t.circuit === 'approve') {
      if (p.by.has(t.by)) throw new Error('already approved');
      p.by.add(t.by);
      p.approvals += 1;
      return;
    }
    /* recoverAnchor */
    if (p.approvals < bar.needed) throw new Error('not approved');
    const head = c.landed.length === 0 ? '00'.repeat(32) : c.landed[c.landed.length - 1]!.head;
    /* Landed refused: its fee paid, nothing written, the proposal still open. */
    if (t.previous !== head || !(Number(t.latest) > time.now) || t.lastRecovery !== (latest.recovery ?? '00'.repeat(32))) {
      for (const q of proposals.values()) if (q.held === 'open') q.failed.push('recoverAnchor');
      return;
    }
    if (t.held.approvals !== HELD.approvals || t.held.signerRoot !== HELD.signerRoot) throw new Error('the account\'s signers changed');
    const next = headAfterStep({ previous: t.previous, batch: t.batch, held: HELD, tag: t.tag, resumesFrom: t.resumesFrom });
    c.landed.push({ head: next, seatBar: seatBarOf(HELD.approvals, null), tag: t.tag, height: c.landed.length + 1, at: 0 });
    latest.recovery = next;
    p.held = 'closed';
  };
  /* The account's state now, as the indexer the wallet names hands it over. */
  const state = (): string => {
    const s = b64(JSON.stringify({ anchor: c.landed.length === 0 ? '00'.repeat(32) : c.landed[c.landed.length - 1]!.head, lastRecovery: latest.recovery }));
    handed.add(s);
    return s;
  };
  return { proposals, sent, takes, time, bar, latest, state, handed };
};

const hexOfBytes = (b: Uint8Array): string => Buffer.from(b).toString('hex');
/** The account's own reader of a test chain's state: its roles, under the account's own keys for the anchor and the latest recovery. */
const stateReader = {
  accountPure: pureCircuits as unknown as GovernedCallDeps['accountPure'],
  runtimeState: { deserialize: (b: Uint8Array) => ({ data: b }) },
  accountLedger: (data: unknown) => {
    const o = JSON.parse(Buffer.from(data as Uint8Array).toString()) as { anchor: string; lastRecovery: string | null };
    const roles = new Map<string, string>([[hexOfBytes(pureCircuits.anchorKey()), o.anchor]]);
    if (o.lastRecovery !== null) roles.set(hexOfBytes(pureCircuits.lastRecoveryKey()), o.lastRecovery);
    return { signerRoles: { member: (k: Uint8Array) => roles.has(hexOfBytes(k)), lookup: (k: Uint8Array) => Buffer.from(roles.get(hexOfBytes(k))!, 'hex') } };
  },
};

/** A device's worker, as a test builds it: the account's own functions, and the real builder of a raise and an approval with no proof. */
const workerFor = (chain: ReturnType<typeof aChain>): RecoveryDoors['builder'] => ({
  proposalIdentity: async (change: GovernanceOnTheWire, salt: string) => identityOfAChange({ accountPure: pureCircuits as unknown as GovernedCallDeps['accountPure'] }, change, salt),
  governedCall: async (input: Parameters<VaultBuilderClient['governedCall']>[0]) => {
    let circuit = '';
    const deps = {
      ledger: {
        ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk', clear: () => {} }) },
        ZswapChainState: class { }, LedgerParameters: { deserialize: (b: Uint8Array) => b },
      },
      runtimeState: { deserialize: (b: Uint8Array) => ({ data: b }) },
      contracts: {
        createUnprovenCallTxFromInitialStates: async (_zk: unknown, o: any) => {
          circuit = o.circuitId;
          return { private: { nextPrivateState: o.initialPrivateState, unprovenTx: 'UNPROVEN' } };
        },
      },
      accountCompiled: 'COMPILED', accountZkConfig: 'ZK', accountPure: pureCircuits,
      prove: async () => ({ serialize: () => new TextEncoder().encode('proved') }),
      random: (n: number) => new Uint8Array(n).fill(7),
    } as unknown as GovernedCallDeps;
    await buildGovernedCall(deps, { ...input, chain: { accountState: new Uint8Array(0), parameters: new Uint8Array(0) } });
    return { tx: b64(JSON.stringify({ circuit, proposal: String(input.order.proposal).toLowerCase(), by: input.material.signingSecret })) };
  },
  roundsOnChain: async ({ chainIds }: { chainIds: readonly string[] }) => Object.fromEntries(chainIds.map((id) => {
    const p = chain.proposals.get(id.toLowerCase());
    return [id.toLowerCase(), p === undefined ? { held: 'never' as const, approvals: 0 }
      : { held: p.held, approvals: p.approvals, ...(p.failed.length === 0 ? {} : { failedCalls: [...p.failed] }) }];
  })),
  /* The account's state, only at the indexer the person's own wallet names. */
  accountCallChain: async (q: { account: string; indexer: typeof INDEXER }) => (q.account === ACCOUNT && q.indexer.indexerUri === INDEXER.indexerUri
    && q.indexer.indexerWsUri === INDEXER.indexerWsUri ? { blockHash: 'b1'.repeat(32), accountState: chain.state(), parameters: '' } : null),
  /* The account's own reader and key over the state given. */
  lastRecovery: async ({ accountState }: { accountState: string }) => lastRecoveryIn(stateReader, Buffer.from(accountState, 'base64')),
  /* The account's own check of the approvals, as building the call runs it: the real one is held by the keyed test on the chain. */
  recoverAnchor: async (input: Parameters<VaultBuilderClient['recoverAnchor']>[0]) => {
    if ((chain.proposals.get(String(input.proposal).toLowerCase())?.approvals ?? 0) < chain.bar.needed) {
      throw new Error('the recovery of the company\'s records was not carried out: not enough approvals yet. Nothing was built or sent.');
    }
    return {
      tx: b64(JSON.stringify({ circuit: 'recoverAnchor', ...input, material: undefined, tag: tagInATest(input.material.signingSecret as Hex, ACCOUNT, input.material.blinding as Hex) })),
      placement: 'fallible' as const,
    };
  },
  anchorTag: anchorFunctions.anchorTag,
  anchorHeads: anchorFunctions.anchorHeads,
} as unknown as RecoveryDoors['builder']);

/** A company of three seats, any two of which hold its account; its first batch anchored by A, honestly. */
const aCompany = async () => {
  const c = aTreeCompany(COMPANY, HELD);
  await c.anchor([signManifestEntry(COMPANY, person('p1', 1, '1a'), A.secret)], A.secret);
  return c;
};

/** One signer's device: its own kept heads, its read of the records at the service's tree, and everything else at the wallet's indexer. */
const aDevice = (
  c: Awaited<ReturnType<typeof aCompany>>, chain: ReturnType<typeof aChain>, who: typeof A,
  over: { serviceGone?: boolean; asked?: string[]; declines?: boolean } = {},
) => {
  const kept: TreeKept = treeKeptInMemory();
  const asked = over.asked ?? [];
  const service = over.serviceGone === true ? undefined : async (tx: string) => { asked.push('service sent'); chain.takes(tx); };
  const d = { clock: NOW };
  const doors: RecoveryDoors = {
    accountId: COMPANY, account: ACCOUNT, material: { signingSecret: who.secret, blinding: who.blinding, scope: '5c'.repeat(32) as Hex }, indexer: INDEXER,
    builder: workerFor(chain),
    send: {
      ...(service === undefined ? {} : { service }),
      ownWallet: {
        send: async (tx: string) => { asked.push('own wallet sent'); chain.takes(tx); },
        chosen: async () => { asked.push('the person chose their own wallet'); return over.declines !== true; },
      },
    },
    watch: { everyMs: 1000, withinMs: 3000, sleep: async () => {} },
    read: async () => {
      if (over.serviceGone === true) throw new Error('the service did not answer');
      return fullCheckHere({ accountId: COMPANY, tree: c.service, onChain: c.onChain, headsOf: headsByTheAccount, seatOf: (k: Hex) => seats.get(k) ?? null, checked: kept.checked });
    },
    checked: kept.checked, headers: kept.headers, onChain: c.onChain,
    ...(over.serviceGone === true ? {} : { tree: { fileHeader: async (_: string, h: TreeHeader) => { asked.push('service kept a header'); await c.keep(h); } } }),
    now: () => d.clock, random: (n: number) => new Uint8Array(n).fill(who === A ? 0xa5 : who === B ? 0xb5 : 0xc5),
  };
  return { doors, kept, asked, at: (t: Date) => { d.clock = t; } };
};

/** The full check of a device that has read the records from the first header. */
const readTo = async (d: ReturnType<typeof aDevice>) => d.doors.read();

describe('A RECOVERY ON THE SIGNERS\' OWN DEVICES', () => {
  it('A HEADER NOBODY KEPT: THE QUORUM RECOVERS PAST IT FROM A FILE AND THE CHAIN, AND EVERY DEVICE THEN READS TO THE HEAD', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    /* Batch 1 lands with a header nobody kept: every device's read stops there. */
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    for (const d of [a, b]) expect((await readTo(d)).stop).toMatchObject({ stop: 'not-given', seq: 1 });

    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    /* RED WHEN: the recovery resumes from anything but the last header the raiser checked, or names another head than its file's. */
    expect(file.resumesFrom).toEqual({ seq: 0, head: c.checkedAt(0).head, root: c.checkedAt(0).root });
    /*
     * RED WHEN: the recovery's change does not carry the last time it may be carried out, or names anything but
     * thirty-two zero bytes as the latest recovery on an account that has carried none out: the approvals bind both.
     */
    expect(file.change).toEqual({ kind: 'recover-anchor', resumesFrom: c.checkedAt(0).head, latest: LATEST_SECONDS, lastRecovery: '00'.repeat(32) });
    /* Handed over as a file: what B's device reads is the text A saved. */
    const handed = proposalFileRead(proposalFileText(file));
    expect(handed).toEqual(file);

    /* RED WHEN: a recovery short of its approvals is carried out - the call would only be refused, its fee paid. */
    await expect(carryOutRecoveryHere(a.doors, handed)).rejects.toThrow(/recovery of the company's records was not carried out: not enough approvals yet\. Nothing was built or sent/u);
    expect(await a.kept.headers.at(COMPANY, 1)).toEqual([]);
    await approveRecoveryHere(b.doors, handed);
    await approveRecoveryHere(a.doors, handed);
    expect(chain.proposals.get(file.chainId)?.approvals).toBe(2);

    const done = await carryOutRecoveryHere(a.doors, handed);
    /* RED WHEN: the recovery's header is an anchor's, resumes from another header, or is not filed before the call is sent. */
    expect(done.header).toMatchObject({ kind: 'recovery', seq: 1, resumesFrom: file.resumesFrom, salt: file.salt, changes: [] });
    expect(done.filed).toBe(true);
    /* RED WHEN: the head the carrier works out is not the one the chain moved to. */
    expect(done.head).toBe(c.landed[c.landed.length - 1]!.head);
    expect(chain.sent).toEqual(['propose', 'approve', 'approve', 'recoverAnchor']);
    /* RED WHEN: the recovery's header is not kept on the carrier's device, to file again if the service loses it. */
    expect((await a.kept.headers.at(COMPANY, 1)).map((k) => k.header)).toEqual([done.header]);

    /* B's device, stopped at batch 1, now reads past the batch given up to the head the chain holds. */
    const after = await readTo(b);
    expect(after.stop).toBeNull();
    expect(after.reached.head).toBe(done.head);
  });

  it('WITH THE SERVICE GONE: A DEVICE READS WHERE IT STANDS FROM WHAT IT KEPT, THE PERSON CHOOSES TO GO ON, AND THE CALLS GO FROM THEIR OWN WALLET', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    const askedA: string[] = [];
    const askedB: string[] = [];
    /* Both devices read the first batch while the service was there. */
    const a0 = aDevice(c, chain, A);
    const b0 = aDevice(c, chain, B);
    await readTo(a0);
    await readTo(b0);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    /* Then the service is gone: the same devices, keeping what they kept, with nothing of the service. */
    const gone = (d: typeof a0, who: typeof A, asked: string[]) => {
      const g = aDevice(c, chain, who, { serviceGone: true, asked });
      return { ...g, doors: { ...g.doors, checked: d.kept.checked, headers: d.kept.headers } };
    };
    const a = gone(a0, A, askedA);
    const b = gone(b0, B, askedB);
    /* RED WHEN: a device without the service raises a recovery without the person choosing to give the batch up. */
    await expect(raiseRecoveryHere(a.doors, { latest: LATEST })).rejects.toThrow(/could not be reached.*Choose to go on without the service/su);
    const { file, sentBy } = await raiseRecoveryHere(a.doors, { latest: LATEST, withoutTheService: true });
    /* RED WHEN: a call is sent any way but the person's own wallet while the service is gone. */
    expect(sentBy).toBe('own-wallet');
    await expect(approveRecoveryHere(b.doors, file)).rejects.toThrow(/Choose to go on without the service/u);
    await approveRecoveryHere(b.doors, file, { withoutTheService: true });
    await approveRecoveryHere(a.doors, file, { withoutTheService: true });
    const done = await carryOutRecoveryHere(a.doors, file, { withoutTheService: true });
    /* RED WHEN: a recovery cannot be carried out because the service cannot keep its header: it is kept on the device. */
    expect(done.filed).toBe(false);
    expect(done.sentBy).toBe('own-wallet');
    expect(c.landed[c.landed.length - 1]!.head).toBe(done.head);
    /* RED WHEN: any step reads or sends through the company's service. */
    expect([...askedA, ...askedB].every((x) => x === 'own wallet sent' || x === 'the person chose their own wallet')).toBe(true);
    /* RED WHEN: a call goes from the person's own wallet without the person choosing it, each time. */
    expect([...askedA, ...askedB].filter((x) => x === 'own wallet sent')).toHaveLength(4);
    expect([...askedA, ...askedB].filter((x) => x === 'the person chose their own wallet')).toHaveLength(4);
    /* The service back: the carrier files the header it kept, and every device reads to the head. */
    await c.keep((await a0.kept.headers.at(COMPANY, 1))[0]!.header);
    expect((await readTo(aDevice(c, chain, B))).reached.head).toBe(done.head);
  });

  it('A FALSE HEADER: A DEVICE STOPPED AT IT APPROVES; ONE THAT CHECKED THE BATCH IT WOULD GIVE UP DOES NOT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    /* B anchors batch 1, and signs as its header one whose change says another batch: a header the chain holds that no device can check. */
    const given = await (async () => {
      const made = nextTreeHeader({
        company: COMPANY, before: c.checkedAt(0), entries: [], current: new Map(), proof: { siblings: [] }, priorChain: () => undefined,
        held: HELD, at: '2026-10-11T00:00:00.000Z', tag: tagInATest(B.secret), recovery: { previous: c.checkedAt(0).head, salt: '5a'.repeat(32) },
      }, B.secret)!.header;
      /* A recovery nobody approved, landed as if it were the anchor: what a seat outside the rules sends. */
      return signTreeHeader({ ...made, kind: 'anchor', resumesFrom: undefined, salt: undefined, previous: c.checkedAt(0).head } as never, B.secret);
    })();
    await c.land(given);
    const a = aDevice(c, chain, A);
    expect((await readTo(a)).stop).toMatchObject({ stop: 'dishonest', seq: 1 });
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(a.doors, file);
    /* A device that believes batch 1 - here, one kept from before batch 1 was read as false - refuses to give it up. */
    const own: OwnStanding = { reached: { ...c.checkedAt(0), seq: 1, head: 'ff'.repeat(32) }, stop: { stop: 'not-given', seq: 2, what: 'x' }, serviceUnreached: false };
    expect(recoveryRefusal(own, file.resumesFrom!)).toMatch(/checked batch 1, the one after the batch this recovery resumes from/u);
  });

  it('A DEVICE WHOSE OWN READ IS NOT STOPPED RIGHT AFTER THE HEADER A RECOVERY RESUMES FROM RAISES, APPROVES AND CARRIES OUT NOTHING, AND SENDS NOTHING', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    /* A device whose read reaches the head the chain holds: here, the same read with nothing stopped. */
    const reachesTheHead = (d: ReturnType<typeof aDevice>) => {
      const read = d.doors.read;
      return { ...d.doors, read: async () => ({ ...(await read()), stop: null }) };
    };
    /* RED WHEN: a device raises a recovery without its own read holding to the rule - it would give up a batch it can check. */
    await expect(raiseRecoveryHere(reachesTheHead(a), { latest: LATEST })).rejects.toThrow(/nothing is stopped/u);
    expect(chain.sent).toEqual([]);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    /* RED WHEN: a device approves a recovery without its own read holding to the rule. */
    await expect(approveRecoveryHere(reachesTheHead(b), file)).rejects.toThrow(/nothing is stopped/u);
    expect(chain.proposals.get(file.chainId)?.approvals).toBe(0);
    await approveRecoveryHere(b.doors, file);
    await approveRecoveryHere(a.doors, file);
    expect(chain.sent).toEqual(['propose', 'approve', 'approve']);
    /* RED WHEN: a device carries out an approved recovery without its own read holding to the rule. */
    await expect(carryOutRecoveryHere(reachesTheHead(b), file)).rejects.toThrow(/nothing is stopped/u);
    expect(chain.sent).toEqual(['propose', 'approve', 'approve']);
    expect(await b.kept.headers.at(COMPANY, 1)).toEqual([]);
  });

  it('THE RULE: RESUMES FROM A HEADER THIS DEVICE CHECKED, WITH THE ONE RIGHT AFTER IT ONE IT CANNOT CHECK, AND NOTHING ELSE', () => {
    const at = { seq: 3, head: '3a'.repeat(32) as Hex, root: '3b'.repeat(32) as Hex, dirVersion: 2 };
    const r = { seq: 3, head: at.head, root: at.root };
    const stopped = (o: Partial<OwnStanding>): OwnStanding => ({ reached: at, stop: { stop: 'dishonest', seq: 4, anchoredBy: null, why: 'x' }, serviceUnreached: false, ...o });
    expect(recoveryRefusal(stopped({}), r)).toBeNull();
    expect(recoveryRefusal(stopped({ stop: { stop: 'not-given', seq: 4, what: 'x' } }), r)).toBeNull();
    /* RED WHEN: a device whose read reaches the head approves a recovery - it would give up batches it checked. */
    expect(recoveryRefusal(stopped({ stop: null }), r)).toMatch(/nothing is stopped/u);
    /* RED WHEN: a device that checked past the header the recovery resumes from approves it. */
    expect(recoveryRefusal(stopped({ reached: { ...at, seq: 4 } }), r)).toMatch(/checked batch 4/u);
    /* RED WHEN: a device that never reached the header the recovery resumes from vouches for it. */
    expect(recoveryRefusal(stopped({ reached: { ...at, seq: 2 } }), r)).toMatch(/only up to batch 2/u);
    /* RED WHEN: a header checked as another is taken as the one the recovery resumes from. */
    expect(recoveryRefusal(stopped({ reached: { ...at, head: '3c'.repeat(32) as Hex } }), r)).toMatch(/as another batch/u);
    expect(recoveryRefusal(stopped({ reached: { ...at, root: '3c'.repeat(32) as Hex } }), r)).toMatch(/as another batch/u);
  });

  it('A RECOVERY IS RAISED TO BE CARRIED OUT BY A TIME; PAST IT, NO DEVICE APPROVES OR CARRIES IT OUT, AND NOTHING IS KEPT OR SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    /* RED WHEN: a recovery is raised with a last time already past, which no device could ever carry out. */
    await expect(raiseRecoveryHere(a.doors, { latest: NOW })).rejects.toThrow(/must be later than now. Nothing was sent/u);
    expect(chain.sent).toEqual([]);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, file);
    /* Past its last time, by the device's clock. */
    a.at(LATEST);
    /* RED WHEN: a device approves a recovery past its last time. */
    await expect(approveRecoveryHere(a.doors, file)).rejects.toThrow(/passed at 2026-10-12T00:00:00.000Z, so approving it now cannot carry it out/u);
    a.at(NOW);
    await approveRecoveryHere(a.doors, file);
    a.at(LATEST);
    /* RED WHEN: a device carries out a recovery past its last time: its header would be kept and filed for a call the chain refuses. */
    await expect(carryOutRecoveryHere(a.doors, file)).rejects.toThrow(/so carrying it out now cannot carry it out.*raise it again, with a later time/su);
    expect(chain.sent).toEqual(['propose', 'approve', 'approve']);
    expect(await a.kept.headers.at(COMPANY, 1)).toEqual([]);
    /* A device whose clock is behind the chain's builds and sends it; the chain refuses it, and the head stays. */
    a.at(NOW);
    chain.time.now = Number(LATEST_SECONDS);
    const head = c.landed[c.landed.length - 1]!.head;
    /* RED WHEN: a carrying out the chain took and refused - read off its transaction - is believed, or said as never sent. */
    await expect(carryOutRecoveryHere(a.doors, file)).rejects
      .toThrow(/account refused this carrying out as the chain took it - its time had passed, who holds the account changed, or another recovery was carried out, since it was built - so it wrote nothing and its fee was paid/u);
    expect(c.landed[c.landed.length - 1]!.head).toBe(head);
    /* RED WHEN: the person is offered their own wallet for a call the chain already took. */
    expect(a.asked).not.toContain('the person chose their own wallet');
  });

  it('A RECOVERY\'S LAST TIME IS AT MOST SEVEN DAYS AHEAD: THE RAISING DEVICE AND EVERY APPROVING DEVICE REFUSE ONE FURTHER', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const DAYS_7 = 7 * 24 * 60 * 60 * 1000;
    /* RED WHEN: a device raises a recovery whose approval would stay good for more than seven days. */
    await expect(raiseRecoveryHere(a.doors, { latest: new Date(NOW.getTime() + DAYS_7 + 1000) }))
      .rejects.toThrow(/at most 7 days from now. Nothing was sent. Choose a nearer time/u);
    expect(chain.sent).toEqual([]);
    const { file } = await raiseRecoveryHere(a.doors, { latest: new Date(NOW.getTime() + DAYS_7) });
    /* B's device reads the time an hour earlier: the recovery's last time is then more than seven days after it approves. */
    b.at(new Date(NOW.getTime() - 3600 * 1000));
    /* RED WHEN: an approving device approves a recovery whose last time is more than seven days after the moment it approves. */
    await expect(approveRecoveryHere(b.doors, file))
      .rejects.toThrow(/more than 7 days after now.*raise it again with a nearer time/su);
    expect(chain.sent).toEqual(['propose']);
    b.at(NOW);
    await approveRecoveryHere(b.doors, file);
    expect(chain.sent).toEqual(['propose', 'approve']);
  });

  it('A FILE IS BELIEVED IN NOTHING: ANOTHER COMPANY\'S, ONE WHOSE SALT MAKES ANOTHER PROPOSAL, OR ONE THE CHAIN DOES NOT HOLD OPEN, IS REFUSED BEFORE ANYTHING IS SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    const before = [...chain.sent];
    const refused = async (f: unknown, words: RegExp) => {
      await expect(approveRecoveryHere(b.doors, f as ProposalFile)).rejects.toThrow(words);
      expect(chain.sent).toEqual(before);
    };
    /* RED WHEN: a file is acted on for a company other than the one open here. */
    await refused({ ...file, company: 'acct_other' }, /another company/u);
    /* RED WHEN: a file whose salt was changed is approved: its identity is made again here from the change and the salt. */
    await refused({ ...file, salt: '00'.repeat(32) }, /make another proposal/u);
    /* RED WHEN: a file naming a recovery from another head than its change is read at all. */
    await refused({ ...file, resumesFrom: { ...file.resumesFrom!, head: '11'.repeat(32) } }, /not the one its change names/u);
    /* RED WHEN: a file whose last time was moved later is approved: the identity made again from the change refuses it. */
    await refused({ ...file, change: { ...file.change, latest: String(Number(LATEST_SECONDS) + 1) } }, /make another proposal/u);
    /* RED WHEN: a recovery file that names no last time is read at all. */
    await refused({ ...file, change: { kind: 'recover-anchor', resumesFrom: file.resumesFrom!.head, lastRecovery: '00'.repeat(32) } }, /until when the recovery may be carried out/u);
    /* RED WHEN: a recovery file that names no latest recovery carried out, or one that is not thirty-two bytes, is read at all. */
    await refused({ ...file, change: { kind: 'recover-anchor', resumesFrom: file.resumesFrom!.head, latest: LATEST_SECONDS } },
      /which recovery of the company's records was the latest carried out when it was raised/u);
    await refused({ ...file, change: { ...file.change, lastRecovery: '00'.repeat(31) } }, /which recovery of the company's records was the latest carried out/u);
    /* RED WHEN: a file naming another latest recovery than the one its approvals bind is approved: the identity made again from the change refuses it. */
    await refused({ ...file, change: { ...file.change, lastRecovery: '11'.repeat(32) } }, /make another proposal/u);
    await refused({ ...file, format: 'something-else' }, /not a proposal/u);
    /* RED WHEN: a proposal the chain does not hold open is approved: one closed already, or never raised. */
    chain.proposals.get(file.chainId)!.held = 'closed';
    await refused(file, /no longer holds this proposal open/u);
    chain.proposals.delete(file.chainId);
    await refused(file, /does not hold this proposal/u);
    /* And a file that is not a recovery is not approved as one. */
    await refused({ ...file, change: { kind: 'threshold', threshold: '1' }, resumesFrom: undefined }, /not a recovery/u);
    expect(PROPOSAL_FILE_FORMAT).toBe(file.format);
  });

  it('AN APPROVED RECOVERY IS CARRIED OUT ONLY FROM ITS OWN FILE: THE FILE\'S CHANGE AND SALT ARE MADE INTO ITS IDENTITY AGAIN, AND ONE THAT MAKES ANOTHER PROPOSAL IS REFUSED BEFORE ANYTHING IS BUILT OR SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, file);
    await approveRecoveryHere(a.doors, file);
    const before = [...chain.sent];
    for (const f of [{ ...file, salt: '00'.repeat(32) }, { ...file, change: { ...file.change, latest: String(Number(LATEST_SECONDS) + 1) } }]) {
      /* RED WHEN: the carrying out does not make the file's identity again from its change and salt before building, so a file that names another proposal reaches the call builder. */
      await expect(carryOutRecoveryHere(a.doors, f as ProposalFile)).rejects.toThrow(/make another proposal/u);
      expect(chain.sent).toEqual(before);
      expect(await a.kept.headers.at(COMPANY, 1)).toEqual([]);
    }
    /* And from its own file it is carried out. */
    await carryOutRecoveryHere(a.doors, file);
    expect(chain.sent.at(-1)).toBe('recoverAnchor');
  });

  it('A CARRYING OUT ANOTHER ANCHOR BEATS WRITES NOTHING AND LEAVES THE RECOVERY OPEN; THE DEVICE SAYS SO, AND IT IS CARRIED OUT AGAIN', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, file);
    await approveRecoveryHere(a.doors, file);
    /* Between this device building the call and the chain taking it, another anchor moves the head on. */
    const beaten = {
      ...a.doors,
      send: { ...a.doors.send, service: async (tx: string) => {
        c.landed.push({ head: 'e1'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
        chain.takes(tx);
      } },
    };
    /* RED WHEN: a carrying out the chain took refused is believed carried out, or said as the service not sending it. */
    const said = await carryOutRecoveryHere(beaten, file).then(() => null, (e: unknown) => e);
    expect(said).toBeInstanceOf(RecoveryNotCarriedOut);
    expect((said as Error).message)
      .toMatch(/another anchor of the company's records got there first, so this carrying out wrote nothing and its fee was paid\. The recovery is still open: carry it out again before 2026-10-12T00:00:00\.000Z/u);
    expect(chain.sent.at(-1)).toBe('recoverAnchor');
    /* RED WHEN: a beaten carrying out offers the person's own wallet - the chain already took it. */
    expect(a.asked).not.toContain('the person chose their own wallet');
    expect(chain.proposals.get(file.chainId)?.held).toBe('open');
    expect(c.landed[c.landed.length - 1]!.head).toBe('e1'.repeat(32));
    /* Carried out again, from the head the chain holds now, within its window: it lands. */
    const done = await carryOutRecoveryHere(a.doors, file);
    expect(done.head).toBe(c.landed[c.landed.length - 1]!.head);
    expect(done.placement).toBe('fallible');
    expect(chain.proposals.get(file.chainId)?.held).toBe('closed');
  });

  it('TWO DEVICES CARRY OUT ONE RECOVERY AT ONCE: THE ONE THE CHAIN TOOK SECOND IS TOLD ANOTHER CARRIED IT OUT, AND BELIEVES NOTHING OF ITS OWN', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, file);
    await approveRecoveryHere(a.doors, file);
    /* B's carrying out lands between A's device building its own and the chain taking it. */
    let bDone: Awaited<ReturnType<typeof carryOutRecoveryHere>> | undefined;
    let taken!: () => void;
    const bothTaken = new Promise<void>((r) => { taken = r; });
    const raced = {
      ...a.doors,
      send: { ...a.doors.send, service: async (tx: string) => { bDone = await carryOutRecoveryHere(b.doors, file); chain.takes(tx); taken(); } },
      /* A's device reads the chain again only once the chain has taken both. */
      watch: { ...a.doors.watch, sleep: () => bothTaken },
    };
    /* RED WHEN: a device believes its own carrying out landed when another's did, and hands back a head the chain never held. */
    await expect(carryOutRecoveryHere(raced, file)).rejects
      .toThrow(/the chain no longer holds this recovery open, and the head this device sent is not on it: another signer's device carried it out first/u);
    expect(c.landed[c.landed.length - 1]!.head).toBe(bDone!.head);
    expect(a.asked).not.toContain('the person chose their own wallet');
  });

  it('ITS OWN CARRYING OUT LANDING BETWEEN TWO READS OF THE CHAIN IS READ AS LANDED, NEVER AS BEATEN', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, file);
    await approveRecoveryHere(a.doors, file);
    /* The first read of where the proposal stands after the send is from before the call landed; the heads read next are after it. */
    let sent = false;
    let stale = true;
    const builder = { ...a.doors.builder, roundsOnChain: async (q: Parameters<RecoveryDoors['builder']['roundsOnChain']>[0]) => {
      if (sent && stale) { stale = false; return { [file.chainId]: { held: 'open' as const, approvals: 2 } }; }
      return a.doors.builder.roundsOnChain(q);
    } } as RecoveryDoors['builder'];
    const between = { ...a.doors, builder, send: { ...a.doors.send, service: async (tx: string) => { chain.takes(tx); sent = true; } } };
    /* RED WHEN: a carrying out that landed is said as beaten because the proposal was read open before the heads were read. */
    const done = await carryOutRecoveryHere(between, file);
    expect(done.head).toBe(c.landed[c.landed.length - 1]!.head);
    expect(stale).toBe(false);
  });

  it('A SERVICE THAT SAYS IT SENT A CALL AND DID NOT IS NOT BELIEVED: THE PERSON IS TOLD AND CHOOSES THEIR OWN WALLET, OR DECLINES AND NOTHING MORE IS SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const liar = (d: ReturnType<typeof aDevice>) => ({ ...d.doors, send: { ...d.doors.send, service: async () => { d.asked.push('service said sent'); } } });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    const bDeclines = aDevice(c, chain, B, { declines: true });
    await readTo(b);
    await readTo(bDeclines);
    /* RED WHEN: a raise the service says it sent, and the chain never shows, is believed raised. */
    const { file, sentBy } = await raiseRecoveryHere(liar(a), { latest: LATEST });
    expect(sentBy).toBe('own-wallet');
    expect(a.asked).toEqual(['service said sent', 'the person chose their own wallet', 'own wallet sent']);
    expect(chain.proposals.get(file.chainId)?.held).toBe('open');
    /* RED WHEN: the person's own wallet sends without the person choosing it - declined, nothing more is sent. */
    await expect(approveRecoveryHere(liar(bDeclines), file))
      .rejects.toThrow(/the company's service said it sent the call, but the chain, as your wallet's indexer shows it, did not show it within 3 seconds, and you chose not to send it from your own wallet/u);
    expect(bDeclines.asked).toEqual(['service said sent', 'the person chose their own wallet']);
    expect(chain.proposals.get(file.chainId)?.approvals).toBe(0);
    await approveRecoveryHere(liar(b), file);
    await approveRecoveryHere(liar(a), file);
    /* RED WHEN: a carrying out the service says it sent, and the chain never shows, is believed carried out: the recovery would stop there. */
    const done = await carryOutRecoveryHere(liar(a), file);
    expect(done.sentBy).toBe('own-wallet');
    expect(chain.sent).toEqual(['propose', 'approve', 'approve', 'recoverAnchor']);
    expect(chain.proposals.get(file.chainId)?.held).toBe('closed');
  });

  it('A RECOVERY SHORT OF THE APPROVALS THE ACCOUNT ASKS IS REFUSED AS IT IS BUILT, IN THE ACCOUNT\'S WORDS, AND NOTHING IS KEPT, FILED OR SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    /* The account asks three approvals for a change of who is seated: its policy bar above its threshold of two. */
    chain.bar.needed = 3;
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, chain.bar.needed), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, file);
    await approveRecoveryHere(a.doors, file);
    /* RED WHEN: the device judges the approvals by a rule of its own - the threshold - and keeps and files a header for a call the account refuses. */
    await expect(carryOutRecoveryHere(a.doors, file)).rejects.toThrow(/recovery of the company's records was not carried out: not enough approvals yet\. Nothing was built or sent/u);
    expect(await a.kept.headers.at(COMPANY, 1)).toEqual([]);
    expect(a.asked).not.toContain('service kept a header');
    expect(chain.sent).toEqual(['propose', 'approve', 'approve']);
  });

  it('A RECOVERY NAMES THE HEAD THE LATEST ONE CARRIED OUT WROTE, READ OFF THE ACCOUNT\'S STATE AT THE WALLET\'S INDEXER, AND IS CARRIED OUT FROM THERE', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file: first } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, first);
    await approveRecoveryHere(a.doors, first);
    const done = await carryOutRecoveryHere(a.doors, first);
    expect(chain.latest.recovery).toBe(done.head);
    /* Then batch 2 lands with a header nobody kept: the anchor's head moves on past the one the recovery wrote. */
    c.landed.push({ head: 'ef'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const asked: string[] = [];
    const watched = { ...b.doors, builder: { ...b.doors.builder, lastRecovery: async (q: { accountState: string }) => { asked.push(q.accountState); return b.doors.builder.lastRecovery(q); } } };
    const { file } = await raiseRecoveryHere(watched, { latest: LATEST });
    /* RED WHEN: a recovery is raised naming anything but the head the latest recovery carried out wrote - none, or the anchor's head now. */
    expect(file.change).toMatchObject({ kind: 'recover-anchor', resumesFrom: done.head, lastRecovery: done.head });
    /* RED WHEN: the latest recovery is read off anything but a state of the account that the indexer the person's own wallet names handed over. */
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((x) => chain.handed.has(x))).toBe(true);
    await approveRecoveryHere(a.doors, file);
    await approveRecoveryHere(b.doors, file);
    /* RED WHEN: a recovery naming the latest one carried out is not carried out with it - the account would refuse it. */
    const second = await carryOutRecoveryHere(b.doors, file);
    expect(c.landed[c.landed.length - 1]!.head).toBe(second.head);
    expect(chain.latest.recovery).toBe(second.head);
  });

  it('ONCE ONE RECOVERY IS CARRIED OUT, EVERY OTHER APPROVED BEFORE IT IS VOID: NO DEVICE APPROVES OR CARRIES ONE OUT, AND NOTHING IS BUILT, KEPT OR SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    const third = aDevice(c, chain, C);
    await readTo(b);
    await readTo(third);
    const { file: one } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    const { file: two } = await raiseRecoveryHere(b.doors, { latest: LATEST });
    for (const f of [one, two]) {
      await approveRecoveryHere(a.doors, f);
      await approveRecoveryHere(b.doors, f);
    }
    await carryOutRecoveryHere(a.doors, one);
    const sent = [...chain.sent];
    /* What the refusal says: the head the file names, the head this device read, and what resolves it. */
    const voided = (step: string) => new RegExp(`^this recovery names ${'00'.repeat(32)} as the head the latest recovery carried out wrote, `
      + `and the account at your wallet's indexer holds ${chain.latest.recovery}, so as this device reads it, it is void and the account would refuse it; `
      + `${step} could only spend a fee\\. Nothing was built or sent\\. .*raise it again, and have it approved, once this device's read of the account is current`, 'u');
    /* RED WHEN: a device approves a recovery another carried out since has voided - the account would refuse it, and the approval only spends a fee. */
    /* RED WHEN: the refusal does not show the head the file names next to the head this device read, so nobody can tell which device is behind. */
    await expect(approveRecoveryHere(third.doors, two)).rejects.toThrow(voided('approving it'));
    let built = 0;
    const counted = { ...b.doors, builder: { ...b.doors.builder, recoverAnchor: async (i: Parameters<VaultBuilderClient['recoverAnchor']>[0]) => { built += 1; return b.doors.builder.recoverAnchor(i); } } };
    /* RED WHEN: a device carries out a recovery another carried out since has voided: the account refuses it after its fee is paid. */
    await expect(carryOutRecoveryHere(counted, two)).rejects.toThrow(voided('carrying it out'));
    expect(built).toBe(0);
    expect(chain.sent).toEqual(sent);
    expect(chain.proposals.get(two.chainId)).toMatchObject({ held: 'open', failed: [] });
    expect(await b.kept.headers.at(COMPANY, 1)).toEqual([]);
  });

  it('A RECOVERY CARRIED OUT BY ANOTHER DEVICE WHILE THIS ONE BUILDS ITS OWN IS READ OFF THE STATE ITS CALL IS BUILT ON, AND NOTHING IS BUILT OR SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file: one } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    const { file: two } = await raiseRecoveryHere(b.doors, { latest: LATEST });
    for (const f of [one, two]) {
      await approveRecoveryHere(a.doors, f);
      await approveRecoveryHere(b.doors, f);
    }
    /* B's device carries out the first after A's device has checked its own read and while it makes its header. */
    let once = true;
    let built = 0;
    const racing = {
      ...a.doors,
      builder: {
        ...a.doors.builder,
        anchorHeads: async (q: Parameters<VaultBuilderClient['anchorHeads']>[0]) => {
          if (once) { once = false; await carryOutRecoveryHere(b.doors, one); }
          return a.doors.builder.anchorHeads(q);
        },
        recoverAnchor: async (i: Parameters<VaultBuilderClient['recoverAnchor']>[0]) => { built += 1; return a.doors.builder.recoverAnchor(i); },
      },
    };
    /* RED WHEN: the call is built on a state other than the one the latest recovery was last read off - it would be sent, refused, and its fee paid. */
    await expect(carryOutRecoveryHere(racing, two)).rejects.toThrow(/as the head the latest recovery carried out wrote, .* so as this device reads it, it is void .*carrying it out could only spend a fee/su);
    expect(once).toBe(false);
    expect(built).toBe(0);
    expect(chain.sent.filter((x) => x === 'recoverAnchor')).toHaveLength(1);
    expect(await a.kept.headers.at(COMPANY, 1)).toEqual([]);
  });

  it('A RECOVERY\'S CALL IS BUILT ON THE VERY STATE OF THE ACCOUNT ITS LATEST RECOVERY WAS LAST READ OFF', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const a = aDevice(c, chain, A);
    const b = aDevice(c, chain, B);
    await readTo(b);
    const { file } = await raiseRecoveryHere(a.doors, { latest: LATEST });
    await approveRecoveryHere(b.doors, file);
    await approveRecoveryHere(a.doors, file);
    /* Every read of the account's state is told apart by its turn, so two reads of an unchanged account are not taken for one. */
    let reads = 0;
    const read: string[] = [];
    let builtOn: string | undefined;
    const watched = {
      ...a.doors,
      builder: {
        ...a.doors.builder,
        accountCallChain: async (q: Parameters<VaultBuilderClient['accountCallChain']>[0]) => {
          const got = await a.doors.builder.accountCallChain(q);
          if (got === null) return got;
          reads += 1;
          const accountState = b64(JSON.stringify({ ...JSON.parse(Buffer.from(got.accountState, 'base64').toString()), read: reads }));
          chain.handed.add(accountState);
          return { ...got, accountState };
        },
        lastRecovery: async (q: { accountState: string }) => { read.push(q.accountState); return a.doors.builder.lastRecovery(q); },
        recoverAnchor: async (i: Parameters<VaultBuilderClient['recoverAnchor']>[0]) => { builtOn = i.chain.accountState; return a.doors.builder.recoverAnchor(i); },
      },
    };
    await carryOutRecoveryHere(watched, file);
    /* RED WHEN: the call is built on a read of the account other than the one its latest recovery was last checked against: a recovery carried out between the two would be sent, refused, and its fee paid. */
    expect(read.length).toBeGreaterThan(1);
    expect(builtOn).toBe(read[read.length - 1]);
  });

  it('A CALL IS BELIEVED SENT ONLY WHEN THE CHAIN SHOWS IT; WHERE THE SERVICE IS GONE, REFUSES, OR SAYS IT SENT IT AND IT DOES NOT SHOW, THE PERSON CHOOSES THEIR OWN WALLET; NONE, AND IT SAYS SO', async () => {
    const went: string[] = [];
    let onChain = false;
    const shows = async () => (onChain ? true : null);
    const watch = { everyMs: 1000, withinMs: 3000, sleep: async () => { went.push('waited'); } };
    const service = async () => { went.push('service'); onChain = true; };
    const drops = async () => { went.push('service said sent'); };
    const refuses = async () => { went.push('service refused'); throw new Error('the service is down'); };
    const wallet = (chooses: boolean, lands = true) => ({
      send: async () => { went.push('wallet'); onChain = lands; },
      chosen: async (why: string) => { went.push(`asked: ${why}`); return chooses; },
    });
    expect((await sentFromHere({ send: { service, ownWallet: wallet(true) }, watch }, 'tx', shows)).sentBy).toBe('service');
    expect(went).toEqual(['service']);
    went.length = 0; onChain = false;
    /* RED WHEN: a call the service says it sent is believed sent before the chain shows it. */
    expect((await sentFromHere({ send: { service: drops, ownWallet: wallet(true) }, watch }, 'tx', shows)).sentBy).toBe('own-wallet');
    expect(went).toEqual(['service said sent', 'waited', 'waited', 'waited',
      'asked: the company\'s service said it sent the call, but the chain, as your wallet\'s indexer shows it, did not show it within 3 seconds. Your own wallet can send it instead, and pay its fee',
      'wallet']);
    went.length = 0; onChain = false;
    /* RED WHEN: a call the service refuses is not offered to the person's own wallet - the service could stop the company. */
    expect((await sentFromHere({ send: { service: refuses, ownWallet: wallet(true) }, watch }, 'tx', shows)).sentBy).toBe('own-wallet');
    expect(went[1]).toBe('asked: the company\'s service did not send the call (the service is down). Your own wallet can send it instead, and pay its fee');
    went.length = 0; onChain = false;
    /* RED WHEN: the device waits on a service that never answers - the service could stop the call by saying nothing. */
    const silent = () => { went.push('service handed it'); return new Promise<never>(() => {}); };
    expect((await sentFromHere({ send: { service: silent, ownWallet: wallet(true) }, watch }, 'tx', shows)).sentBy).toBe('own-wallet');
    expect(went).toContain('asked: the company\'s service did not answer within 3 seconds, and the chain, as your wallet\'s indexer shows it, does not show the call. '
      + 'Your own wallet can send it instead, and pay its fee');
    went.length = 0; onChain = false;
    expect((await sentFromHere({ send: { ownWallet: wallet(true) }, watch }, 'tx', shows)).sentBy).toBe('own-wallet');
    expect(went[0]).toBe('asked: the company\'s service is not reachable from this page. Your own wallet can send it instead, and pay its fee');
    went.length = 0; onChain = false;
    /* RED WHEN: the person's own wallet sends a call the person declined. */
    await expect(sentFromHere({ send: { service: drops, ownWallet: wallet(false) }, watch }, 'tx', shows)).rejects.toThrow(/you chose not to send it from your own wallet/u);
    expect(went).not.toContain('wallet');
    await expect(sentFromHere({ send: { service: refuses }, watch }, 'tx', shows)).rejects.toThrow(/the service is down.*Connect your wallet/su);
    await expect(sentFromHere({ send: { service: refuses, ownWallet: { send: async () => { throw new Error('no funds'); }, chosen: async () => true } }, watch }, 'tx', shows))
      .rejects.toThrow(/did not send the call \(the service is down\), and your wallet did not send it either \(no funds\)/u);
    onChain = false;
    /* RED WHEN: a call the person's own wallet sent is believed sent before the chain shows it. */
    await expect(sentFromHere({ send: { ownWallet: wallet(true, false) }, watch }, 'tx', shows))
      .rejects.toThrow(/your wallet sent the call, but the chain, as your wallet's indexer shows it, did not show it within 3 seconds/u);
  });
});
