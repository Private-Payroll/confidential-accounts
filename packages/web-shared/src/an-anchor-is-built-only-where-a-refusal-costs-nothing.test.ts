/**
 * **THE ANCHOR CALL, BUILT ON THE SIGNER'S OWN DEVICE: FROM THE HEAD IT READ,
 * WITH ITS SIGNER'S THREE AND NOTHING ELSE, AND SENT ONLY FROM THE GUARANTEED
 * SECTION OF ITS TRANSACTION.**
 *
 * A call in the guaranteed section that reads a head another device has since
 * moved fails the whole transaction, fee and all; in the fallible section the
 * transaction lands, its fee paid, and the anchor is not written. So where the
 * call landed is read off the transaction before anything is proved. A
 * recovery alone may land in the fallible section - its checks are over the
 * guaranteed section's budget - and where it landed is handed back.
 *
 * The call builder and the prover are stand-ins here, so every decision the
 * builder makes before and after them can be watched; the account's own
 * `anchorHeadOf` makes the heads.
 */
import { describe, expect, it } from 'vitest';
import { CompactTypeBytes, CompactTypeMerkleTreeDigest, StateBoundedMerkleTree } from '@midnight-ntwrk/compact-runtime';
import { anchorServiceFor } from './records-anchored-here.js';
import { CREATION_STEPS } from '../../../src/midnight/deferral.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import {
  accountDeployedIn, anchorHeadsAfter, anchorsLandedIn, anchorPlacementOf, AnchorNotBuilt, buildAnchorCall, buildRecoverAnchorCall, lastRecoveryIn, signerRootOf, type GovernedCallDeps,
} from './governed-call-builder.js';

const ACCOUNT = 'c0'.repeat(32);
const material = { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) };
const chain = { accountState: new Uint8Array([1]), parameters: new Uint8Array([2]) };
const PREVIOUS = 'ab'.repeat(32);
const BATCH = 'cd'.repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** Who held the account as the batch was judged, as its header names them and the call is handed them. */
const HELD = { approvals: 2, signerRoot: '0a'.repeat(32) };
const accountTree = { StateBoundedMerkleTree, CompactTypeBytes, CompactTypeMerkleTreeDigest } as unknown as GovernedCallDeps['accountTree'];

/** A transaction holding these calls, in one intent, as the ledger's own type lays them out. */
const txOf = (...calls: Array<{ entryPoint: string | Uint8Array; guaranteed?: boolean; fallible?: boolean }>) => ({
  intents: new Map([[1, {
    actions: calls.map((c) => ({
      entryPoint: c.entryPoint,
      guaranteedTranscript: c.guaranteed === false ? undefined : { ops: [] },
      fallibleTranscript: c.fallible === true ? { ops: [] } : undefined,
    })),
  }]]),
});

const depsWith = (log: string[], unproven: unknown, handed: any[] = []): GovernedCallDeps => ({
  ledger: {
    ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk', clear: () => {} }) },
    ZswapChainState: class { },
    LedgerParameters: { deserialize: (b: Uint8Array) => ({ parameters: [...b] }) },
  },
  runtimeState: { deserialize: (b: Uint8Array) => ({ state: [...b], data: 'DATA' }) },
  contracts: {
    createUnprovenCallTxFromInitialStates: async (_zk: unknown, options: any) => {
      log.push(`built ${options.circuitId}`);
      handed.push(options);
      return { private: { nextPrivateState: options.initialPrivateState, unprovenTx: unproven } };
    },
  },
  accountCompiled: 'COMPILED',
  accountZkConfig: 'ZK',
  accountPure: { ...(pureCircuits as any) },
  prove: async (_u: unknown, circuit?: string) => { log.push(`proved ${circuit}`); return { serialize: () => new Uint8Array([9]) }; },
  random: (n: number) => new Uint8Array(n).fill(7),
} as unknown as GovernedCallDeps);

describe('WHERE THE ANCHOR CALL LANDS', () => {
  it('reads one anchor call in the guaranteed section as guaranteed, and anything else as fallible or unread', () => {
    expect(anchorPlacementOf(txOf({ entryPoint: 'anchor' }))).toBe('guaranteed');
    /* RED WHEN: an entry point the ledger gives as bytes is not read as its name. */
    expect(anchorPlacementOf(txOf({ entryPoint: new TextEncoder().encode('anchor') }))).toBe('guaranteed');
    /* RED WHEN: a call with any fallible part is read as guaranteed - a refused anchor there still pays its fee. */
    expect(anchorPlacementOf(txOf({ entryPoint: 'anchor', fallible: true }))).toBe('fallible');
    expect(anchorPlacementOf(txOf({ entryPoint: 'anchor', guaranteed: false, fallible: true }))).toBe('fallible');
    /* RED WHEN: a transaction carrying a second call, or another circuit, is read as one anchor call. */
    expect(anchorPlacementOf(txOf({ entryPoint: 'anchor' }, { entryPoint: 'anchor' }))).toBe('unread');
    expect(anchorPlacementOf(txOf({ entryPoint: 'approve' }))).toBe('unread');
    expect(anchorPlacementOf(txOf({ entryPoint: 'anchor', guaranteed: false }))).toBe('unread');
    expect(anchorPlacementOf('UNPROVEN')).toBe('unread');
  });
});

describe('ONE ANCHOR CALL', () => {
  it('is built from the head this device read and the batch, with the signer\'s three only, and proved for the anchor', async () => {
    const log: string[] = [];
    const handed: any[] = [];
    const out = await buildAnchorCall(depsWith(log, txOf({ entryPoint: 'anchor' }), handed), {
      account: ACCOUNT.toUpperCase(), material, chain, previous: PREVIOUS, batch: BATCH, held: HELD,
    });
    expect(out.proven).toEqual(new Uint8Array([9]));
    expect(log).toEqual(['built anchor', 'proved anchor']);
    const options = handed[0]!;
    expect(options.contractAddress).toBe(ACCOUNT);
    /* RED WHEN: the head and the batch change places, or either is taken from anywhere but what was handed in. */
    expect(options.args.slice(0, 2).map(hex)).toEqual([PREVIOUS, BATCH]);
    /* RED WHEN: the call does not name who held the account as the batch was judged - it would land whoever holds it now. */
    expect(options.args.slice(2)).toEqual([2n, { field: BigInt(`0x${HELD.signerRoot}`) }]);
    /* RED WHEN: the record answers an account field: the anchor needs none, and an answer would be a guess proved against. */
    expect(() => options.initialPrivateState.proposalSalt).toThrow(/the anchor call read "proposalSalt"/u);
    /* RED WHEN: the signer's three are left in memory after the call. */
    expect(hex(options.initialPrivateState.secretKey)).toBe('00'.repeat(32));
  });

  it('A CALL THAT WOULD LAND IN THE FALLIBLE SECTION IS NEVER PROVED OR SENT', async () => {
    const log: string[] = [];
    /* RED WHEN: a call whose refusal would still pay its fee is proved. */
    await expect(buildAnchorCall(depsWith(log, txOf({ entryPoint: 'anchor', fallible: true })), {
      account: ACCOUNT, material, chain, previous: PREVIOUS, batch: BATCH, held: HELD,
    })).rejects.toThrow(/its fee would be paid and nothing written/u);
    await expect(buildAnchorCall(depsWith(log, 'UNPROVEN'), { account: ACCOUNT, material, chain, previous: PREVIOUS, batch: BATCH, held: HELD }))
      .rejects.toThrow(AnchorNotBuilt);
    expect(log).toEqual(['built anchor', 'built anchor']);
  });

  it('is refused before anything is built for a head or a batch that is not thirty-two bytes, or no account', async () => {
    const log: string[] = [];
    for (const bad of [
      { previous: 'ab' }, { batch: 'cd'.repeat(31) }, { account: 'nobody' },
      /* RED WHEN: a call naming no approvals, or no root, is built: it would bind nothing the batch was judged against. */
      { held: { ...HELD, approvals: 0 } }, { held: { ...HELD, signerRoot: 'zz' } },
    ]) {
      await expect(buildAnchorCall(depsWith(log, txOf({ entryPoint: 'anchor' })), {
        account: ACCOUNT, material, chain, previous: PREVIOUS, batch: BATCH, held: HELD, ...bad,
      })).rejects.toThrow();
    }
    expect(log).toEqual([]);
  });
});

describe('ONE RECOVERY OF THE RECORD ANCHOR', () => {
  const RESUMES = '1a'.repeat(32);
  const PROPOSAL = '2b'.repeat(32);
  const SALT = '3c'.repeat(32);
  const LATEST = '1800003600';
  const LAST = '4d'.repeat(32);
  it('is built as an anchor call is, naming the head it resumes from, its last time, the latest recovery\'s head and its approved proposal, with the proposal\'s salt the one thing answered', async () => {
    const log: string[] = [];
    const handed: any[] = [];
    const out = await buildRecoverAnchorCall(depsWith(log, txOf({ entryPoint: 'recoverAnchor' }), handed), {
      account: ACCOUNT, material, chain, previous: PREVIOUS, batch: BATCH, held: HELD, resumesFrom: RESUMES.toUpperCase(), latest: LATEST,
      lastRecovery: LAST.toUpperCase(), proposal: PROPOSAL, proposalSalt: SALT,
    });
    expect(out.proven).toEqual(new Uint8Array([9]));
    expect(out.placement).toBe('guaranteed');
    /* RED WHEN: the recovery is built or proved as another circuit - an anchor call would never resume from anything. */
    expect(log).toEqual(['built recoverAnchor', 'proved recoverAnchor']);
    const options = handed[0]!;
    /* RED WHEN: the head it resumes from, its last time, the latest recovery's head and the proposal change places, or any is not the one handed in. */
    expect(options.args.slice(0, 2).map(hex)).toEqual([PREVIOUS, BATCH]);
    expect(options.args.slice(2, 4)).toEqual([2n, { field: BigInt(`0x${HELD.signerRoot}`) }]);
    expect(hex(options.args[4])).toBe(RESUMES);
    expect(options.args[5]).toBe(BigInt(LATEST));
    expect(hex(options.args[6])).toBe(LAST);
    expect(hex(options.args[7])).toBe(PROPOSAL);
    expect(options.args).toHaveLength(8);
    /* RED WHEN: the proposal's salt is not answered: the account could not make the identity of the proposal it carries out. */
    expect(hex(options.initialPrivateState.proposalSalt)).toBe(SALT);
    /* RED WHEN: the record answers anything else the recovery never needs. */
    expect(() => options.initialPrivateState.assetBlinding).toThrow(/the recovery call read "assetBlinding"/u);
  });
  it('is proved where it lands in the fallible section, saying so, and never where the transaction is an anchor call instead', async () => {
    const log: string[] = [];
    const input = {
      account: ACCOUNT, material, chain, previous: PREVIOUS, batch: BATCH, held: HELD, resumesFrom: RESUMES, latest: LATEST, lastRecovery: LAST, proposal: PROPOSAL, proposalSalt: SALT,
    };
    /* RED WHEN: a recovery landing in the fallible section is refused - at the ledger's initial parameters it always does, so no recovery could be carried out. */
    const fallible = await buildRecoverAnchorCall(depsWith(log, txOf({ entryPoint: 'recoverAnchor', fallible: true })), input);
    /* RED WHEN: where it landed is not handed back, so a beaten carrying out could not say its fee was paid. */
    expect(fallible.placement).toBe('fallible');
    expect(log).toEqual(['built recoverAnchor', 'proved recoverAnchor']);
    log.length = 0;
    /* RED WHEN: a recovery's placement is read off an anchor call - the circuit asked for is the one read. */
    await expect(buildRecoverAnchorCall(depsWith(log, txOf({ entryPoint: 'anchor' })), input)).rejects.toThrow(AnchorNotBuilt);
    /* RED WHEN: a head it resumes from, or a proposal, that is not thirty-two bytes is built. */
    await expect(buildRecoverAnchorCall(depsWith(log, txOf({ entryPoint: 'recoverAnchor' })), { ...input, resumesFrom: 'ab' })).rejects.toThrow();
    await expect(buildRecoverAnchorCall(depsWith(log, txOf({ entryPoint: 'recoverAnchor' })), { ...input, proposal: 'ab' })).rejects.toThrow();
    /* RED WHEN: a latest recovery's head that is not thirty-two bytes is built. */
    await expect(buildRecoverAnchorCall(depsWith(log, txOf({ entryPoint: 'recoverAnchor' })), { ...input, lastRecovery: 'ab' }))
      .rejects.toThrow(/the latest recovery's head this proposal was handed is not thirty-two bytes/u);
    /* RED WHEN: a last time that is not a whole number is built. */
    await expect(buildRecoverAnchorCall(depsWith(log, txOf({ entryPoint: 'recoverAnchor' })), { ...input, latest: 'soon' }))
      .rejects.toThrow(/the recovery's last time this proposal was handed is not a whole number/u);
    expect(log).toEqual(['built recoverAnchor']);
  });
});

describe('THE HEADS, MADE WITH THE ACCOUNT\'S OWN FUNCTIONS', () => {
  const at = (held: string | null): Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'> => ({
    accountPure: pureCircuits as any,
    runtimeState: { deserialize: () => ({ data: 'DATA' }) },
    accountLedger: () => ({
      signerRoles: {
        member: (k: Uint8Array) => held !== null && hex(k) === hex(pureCircuits.anchorKey()),
        lookup: () => Buffer.from(held!, 'hex'),
      },
    }),
  });
  it('reads the head under the anchor\'s own key, the empty head before the first anchor, and the head after each batch', () => {
    const step = { state: new Uint8Array([1]), block: { height: 4, at: 4_000 } };
    /* The seat bar each state holds, as a test's reader of the account's approvals answers it: two more than the state's first byte. */
    const barOf = (state: Uint8Array) => 2 + state[0]!;
    /* RED WHEN: an account with no anchor yet is read as holding a head - the empty head is not one anchor call that landed. */
    expect(anchorsLandedIn(at(null), [step], barOf)).toEqual([]);
    /* RED WHEN: the head an anchor call left is read from anywhere but the state under the anchor's own key, or the block is
     * not the step's own. */
    expect(anchorsLandedIn(at(PREVIOUS), [step], barOf)).toEqual([{ head: PREVIOUS, seatBar: 3, height: 4, at: 4_000 }]);
    /* Three states, two anchors: each landing is read off its own state and block. */
    const heads = ['', 'a1'.repeat(32), 'a2'.repeat(32)];
    const tags = ['', 'c1'.repeat(32), 'c2'.repeat(32)];
    const seatKey = hex(pureCircuits.anchorSeatKey());
    const each: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'> = {
      accountPure: pureCircuits as any,
      runtimeState: { deserialize: (b: Uint8Array) => ({ data: b[0] }) } as any,
      accountLedger: (data: unknown) => ({
        signerRoles: {
          member: () => data !== 0,
          lookup: (k: Uint8Array) => Buffer.from((hex(k) === seatKey ? tags : heads)[data as number]!, 'hex'),
        },
      }),
    };
    const landed = anchorsLandedIn(each, [0, 1, 1, 2].map((n, i) => ({ state: new Uint8Array([n]), block: { height: i, at: i } })), barOf);
    /* RED WHEN: a landing's head or block is any state's but its own. */
    expect(landed.map((l) => [l.head, l.height])).toEqual([[heads[1], 1], [heads[2], 3]]);
    /* RED WHEN: a landing's seat bar is read from any state but the one its block left. */
    expect(landed.map((l) => l.seatBar)).toEqual([3, 4]);
    /* RED WHEN: a state whose seat bar cannot be read is landed with none, so a change it anchored would be judged against no bar. */
    expect(() => anchorsLandedIn(at(PREVIOUS), [step], () => Number.NaN)).toThrow(/approvals a change of who is seated needs could not be read/);
    /* RED WHEN: a landing does not carry the tag the account wrote beside its head - the seat that moved it read from nowhere. */
    expect(landed.map((l) => l.tag)).toEqual([tags[1], tags[2]]);
    /* RED WHEN: a history that names no call is read as naming how many anchors a block held. */
    expect(landed.every((l) => l.anchorsInBlock === undefined && l.recovered === undefined)).toBe(true);
  });

  it('reads the head the latest recovery carried out wrote under its own key, thirty-two zero bytes before any, and refuses without the account\'s key', () => {
    const roles = (entries: Record<string, string>): Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'> => ({
      accountPure: pureCircuits as any,
      runtimeState: { deserialize: () => ({ data: 'DATA' }) },
      accountLedger: () => ({ signerRoles: { member: (k: Uint8Array) => hex(k) in entries, lookup: (k: Uint8Array) => Buffer.from(entries[hex(k)]!, 'hex') } }),
    });
    const recoveryKey = hex(pureCircuits.lastRecoveryKey());
    const anchorKey = hex(pureCircuits.anchorKey());
    /* RED WHEN: an account no recovery was carried out on reads as holding a head - an approval naming it would be refused. */
    expect(lastRecoveryIn(roles({ [anchorKey]: PREVIOUS }), new Uint8Array([1]))).toBe('00'.repeat(32));
    /* RED WHEN: the latest recovery is read from anywhere but its own key: the anchor's head moves on with every anchor. */
    expect(lastRecoveryIn(roles({ [anchorKey]: PREVIOUS, [recoveryKey]: BATCH }), new Uint8Array([1]))).toBe(BATCH);
    /* RED WHEN: a device not given the account's key reads the latest recovery some other way. */
    const { lastRecoveryKey: _, ...without } = pureCircuits;
    expect(() => lastRecoveryIn({ ...roles({}), accountPure: without as any }, new Uint8Array([1]))).toThrow(/not given the account's reader for its latest recovery.*Reload the page/su);
  });

  it('counts the calls that moved the anchor in each landing\'s block, and whether a recovery was one, from the calls the history names', () => {
    const heads = ['', 'a1'.repeat(32), 'a2'.repeat(32)];
    const each: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'> = {
      accountPure: pureCircuits as any,
      runtimeState: { deserialize: (b: Uint8Array) => ({ data: b[0] }) } as any,
      accountLedger: (data: unknown) => ({ signerRoles: { member: () => data !== 0, lookup: (k: Uint8Array) => Buffer.from(hex(k) === hex(pureCircuits.anchorSeatKey()) ? 'c1'.repeat(32) : heads[data as number]!, 'hex') } }),
    };
    const step = (n: number, height: number, entryPoint: string, succeeded = true) => ({ state: new Uint8Array([n]), block: { height, at: height }, entryPoint, succeeded });
    const landed = anchorsLandedIn(each, [
      step(0, 1, 'propose'),
      /* One block, two anchors and a recovery refused in its fallible section: the state is the block's last. */
      step(1, 2, 'anchor'), step(1, 2, 'anchor'), step(1, 2, 'recoverAnchor', false),
      /* The next block: a recovery that landed. */
      step(2, 3, 'recoverAnchor'), step(2, 3, 'approve'),
    ], () => 1);
    /*
     * RED WHEN: a block's calls to move the anchor are not all counted - a seat would be named for a head another call of that block
     * may have moved, an anchor in a guaranteed section moving it even where its transaction succeeded only in part.
     */
    expect(landed.map((l) => l.anchorsInBlock)).toEqual([3, 1]);
    /* RED WHEN: a refused recovery is read as one that moved the anchor, or one that landed is not read as a recovery. */
    expect(landed.map((l) => l.recovered)).toEqual([false, true]);
  });

  it("the head after a batch folds the batch with the holders its header names, and the seats are believed only when they make the root", () => {
    const deps = { accountPure: pureCircuits as any, accountTree };
    const signers = ['a1'.repeat(32), hex(pureCircuits.vacantSlot()), 'a3'.repeat(32)];
    const held = { approvals: 2, signerRoot: signerRootOf(deps, signers), signers };
    const TAG = 'c7'.repeat(32);
    const out = anchorHeadsAfter(deps, { after: [{ previous: PREVIOUS, batch: BATCH, held, tag: TAG }] });
    const root = { field: BigInt(`0x${held.signerRoot}`) };
    /* RED WHEN: the head after a batch is made by anything but anchorHeadOf over anchorHeldOf of the batch, its holders and its seat's tag. */
    expect(out.after).toEqual([hex(pureCircuits.anchorHeadOf(Buffer.from(PREVIOUS, 'hex'),
      pureCircuits.anchorHeldOf(Buffer.from(BATCH, 'hex'), 2n, root, Buffer.from(TAG, 'hex'))))]);
    /* RED WHEN: a recovery's head is made as an anchor's - a plain anchor read as a recovery, or the head it resumes from left out. */
    const RESUMED = 'd4'.repeat(32);
    expect(anchorHeadsAfter(deps, { after: [{ previous: PREVIOUS, batch: BATCH, held, tag: TAG, resumesFrom: RESUMED }] }).after).toEqual([
      hex(pureCircuits.anchorHeadOf(Buffer.from(PREVIOUS, 'hex'),
        pureCircuits.anchorRecoveredOf(Buffer.from(BATCH, 'hex'), 2n, root, Buffer.from(TAG, 'hex'), Buffer.from(RESUMED, 'hex'))))]);
    /* RED WHEN: the vacant-slot leaf is counted as a seat. */
    expect(out.seats).toEqual([['a1'.repeat(32), 'a3'.repeat(32)]]);
    /* RED WHEN: seats are believed from a header whose leaves do not make the root it names - one the call never checked. */
    const padded = { ...held, signers: [...signers, 'a4'.repeat(32)] };
    expect(anchorHeadsAfter(deps, { after: [{ previous: PREVIOUS, batch: BATCH, held: padded, tag: TAG }] }).seats).toEqual([null]);
    const swapped = { ...held, signers: [signers[2]!, signers[1]!, signers[0]!] };
    expect(anchorHeadsAfter(deps, { after: [{ previous: PREVIOUS, batch: BATCH, held: swapped, tag: TAG }] }).seats).toEqual([null]);
    /* RED WHEN: a header naming a root that is no field element stops every read; it folds to the empty head, which no batch on the chain's path leaves. */
    expect(anchorHeadsAfter(deps, { after: [{ previous: PREVIOUS, batch: BATCH, held: { ...held, signerRoot: 'ff'.repeat(32) }, tag: TAG }] }).after).toEqual(['00'.repeat(32)]);
  });
});

describe('THE ANCHOR\'S ROUTES, OVER THIS PAGE\'S OWN SIGN-IN', () => {
  it('builds the call on the account the call-state route serves and sends the proven anchor to the account\'s proven-call route', async () => {
    const asked: Array<[string, RequestInit | undefined]> = [];
    const service = anchorServiceFor(async (path, init) => { asked.push([path, init]); return {}; });
    await service.callState('acct one');
    await service.sendProven('acct one', 'beef');
    /* RED WHEN: the anchor reads another account's state, or is sent anywhere but the route that checks a proven call before it reaches the node. */
    expect(asked).toEqual([
      ['/api/accounts/acct%20one/call-state', undefined],
      ['/api/accounts/acct%20one/proven', { method: 'POST', body: JSON.stringify({ tx: 'beef' }) }],
    ]);
  });
});

describe('HOW THE ACCOUNT WAS DEPLOYED, AS ITS FIRST STEP SHOWS IT', () => {
  const SEAT = 'A1'.repeat(32);
  const KEY = { tag: 'schnorr', value: 'EF'.repeat(32) };
  /** Who holds the account, as its seats reader reads that step's bytes. */
  const seatsIn = () => ({ seats: [SEAT], committee: [KEY], threshold: 1 });
  /** The contract runtime's reading of the deploy's state: the authority it carries and the circuits it already ran. */
  const reading = (maintenanceAuthority: unknown, ops: string[] = []): Pick<GovernedCallDeps, 'runtimeState'> => ({
    runtimeState: { deserialize: () => ({ maintenanceAuthority, operations: () => ops }) } as any,
  });
  const held = (counter: unknown) => ({ committee: [KEY], threshold: 1, counter });
  const deploy = [{ kind: 'deploy', state: new Uint8Array([1]) }];

  it('reads the seats, the committee, its threshold, its updates and the second step off the deploy', () => {
    /* RED WHEN: a deploy is read with its seats or its committee key in any case but lower, or its updates from anywhere but its own counter. */
    expect(accountDeployedIn(reading(held(0n)), deploy, seatsIn)).toEqual({
      seats: ['a1'.repeat(32)], committee: [{ tag: 'schnorr', value: 'ef'.repeat(32) }], threshold: 1, updates: 0, ranSecondStep: false,
    });
    /* RED WHEN: an account its committee had already updated by the end of the deploy's block reads as deployed with no update. */
    expect(accountDeployedIn(reading(held(2n)), deploy, seatsIn)?.updates).toBe(2);
    /* RED WHEN: an account that already ran a circuit of the second creation step reads as not having run one. */
    expect(accountDeployedIn(reading(held(0n), [CREATION_STEPS.second[0]!]), deploy, seatsIn)?.ranSecondStep).toBe(true);
    /* RED WHEN: a history that does not open with the deploy is read as how the account was deployed. */
    expect(accountDeployedIn(reading(held(0n)), [{ kind: 'call', state: new Uint8Array([1]) }], seatsIn)).toBeNull();
  });

  it('does not believe a deploy whose maintenance authority cannot be read', () => {
    /*
     * RED WHEN: a deploy whose update counter is not a bigint of at least zero is believed - a counter of "0" would read as an
     * account no update had touched, and its founding seat would be believed.
     */
    expect(() => accountDeployedIn(reading(held('0')), deploy, seatsIn)).toThrow(/how the company's account was deployed cannot be read.*counter is not a bigint of at least zero/su);
    expect(() => accountDeployedIn(reading(held(-1n)), deploy, seatsIn)).toThrow(/counter is not a bigint of at least zero/u);
    /* RED WHEN: a deploy whose state carries no maintenance authority at all is believed. */
    expect(() => accountDeployedIn(reading(undefined), deploy, seatsIn)).toThrow(/carries no maintenance authority/u);
  });
});
