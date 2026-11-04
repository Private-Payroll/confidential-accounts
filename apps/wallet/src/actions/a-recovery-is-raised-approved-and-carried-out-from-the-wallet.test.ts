import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import { routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { ACT_INTENTS } from 'midnight-identity/profile/act-intents';
import { newSigningKeypair, type Hex } from '../../../../src/core/crypto.js';
import { signManifestEntry, type BatchHolders, type ManifestEntryBody } from '../../../../src/midnight/record-manifest.js';
import {
  ACCOUNT_IN_A_TEST, aTreeCompany, anchorFunctions, headAfterStep, headsByTheAccount, tagInATest,
} from '../../../../src/testing/record-tree-double.js';
import { pureCircuits } from '../../../../contracts/managed/contract/index.js';
import {
  buildGovernedCall, identityOfAChange, lastRecoveryIn, type GovernanceOnTheWire, type GovernedCallDeps,
} from '../../../../packages/web-shared/src/governed-call-builder.js';
import { fullCheckHere } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { approveRecoveryHere, recoveryFileOf, type RecoveryDoors } from '../../../../packages/web-shared/src/records-recovered-here.js';
import { treeKeptInMemory, type TreeKept } from '../../../../packages/web-shared/src/tree-kept-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { approveProposalAction } from './approve-proposal.js';
import { StepRefused, type ActionDefinition, type StepContext } from './definition.js';
import { moreThanTheFeeRefusal, notOneCallRefusal, recoveryAction, type OwnWalletDoors, type RecoveryReach } from './recovery.js';
import * as ledger from '@midnightntwrk/ledger-v9';

/*
 * **A RECOVERY OF THE COMPANY'S RECORDS IS RAISED, APPROVED AND CARRIED OUT FROM EACH SIGNER'S OWN WALLET.** The
 * recovery's own code is the real one (`raiseRecoveryHere`, `approveRecoveryHere`, `carryOutRecoveryHere`), over a
 * company's records, a chain and a wallet stood in for here, as the shared recovery test stands them in. What is pinned:
 * the window runs on the chain and the heads the device kept alone, asks the page for no call and no relay, sends every
 * call from the person's own wallet, which adds only DUST for the fee, and refuses a call that moves a coin or calls
 * anything else before a fee is paid. Start with "A RECOVERY RAISED IN ONE WALLET".
 */

const COMPANY = 'acct_recovered';
const ACCOUNT = ACCOUNT_IN_A_TEST;
const LABEL = drawCompanyLabel();
const A = { ...newSigningKeypair(), blinding: '0a'.repeat(32) as Hex };
const B = { ...newSigningKeypair(), blinding: '0b'.repeat(32) as Hex };
const C = { ...newSigningKeypair(), blinding: '0c'.repeat(32) as Hex };
const SCOPE = '5c'.repeat(32) as Hex;
const seats = new Map<Hex, string>([[A.publicKey, 'seat-a'], [B.publicKey, 'seat-b'], [C.publicKey, 'seat-c']]);
const HELD: BatchHolders = { approvals: 2, signerRoot: '0e'.repeat(32), signers: ['a1'.repeat(32), 'b1'.repeat(32), 'c1'.repeat(32)] };
const INDEXER = { indexerUri: 'https://indexer.invalid/api', indexerWsUri: 'wss://indexer.invalid/ws' };
const NOW = new Date('2026-10-11T00:00:00Z');
const LATEST_SECONDS = String(new Date('2026-10-12T00:00:00Z').getTime() / 1000);
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const hexOfBytes = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const person = (id: string, version: number, digest: string): ManifestEntryBody => ({ store: 'company', kind: 'person', id, version, digest: digest.repeat(32) });

/** The account on a test's chain, as the shared recovery test stands it in: raised, approved by distinct seats, carried out once. */
const aChain = (c: ReturnType<typeof aTreeCompany>) => {
  const proposals = new Map<string, { held: 'open' | 'closed'; approvals: number; by: Set<string>; outrun?: true }>();
  const sent: string[] = [];
  const latest: { recovery: string | null } = { recovery: null };
  const takes = (tx: string): void => {
    const t = JSON.parse(Buffer.from(tx, 'base64').toString());
    sent.push(t.circuit);
    const p = proposals.get(t.proposal);
    if (t.circuit === 'propose') { proposals.set(t.proposal, { held: 'open', approvals: 1, by: new Set([t.by]) }); return; }
    if (p === undefined || p.held !== 'open') throw new Error('no such open proposal');
    if (t.circuit === 'approve') { p.by.add(t.by); p.approvals += 1; return; }
    const next = headAfterStep({ previous: t.previous, batch: t.batch, held: HELD, tag: t.tag, resumesFrom: t.resumesFrom });
    c.landed.push({ head: next, seatBar: seatBarOf(HELD.approvals, null), tag: t.tag, height: c.landed.length + 1, at: 0 });
    latest.recovery = next;
    p.held = 'closed';
  };
  const state = (): string => b64(JSON.stringify({ anchor: c.landed.length === 0 ? '00'.repeat(32) : c.landed[c.landed.length - 1]!.head, lastRecovery: latest.recovery }));
  return { proposals, sent, takes, state };
};

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

/** The wallet's builder over the test's chain: each call built by the real builder, its proof stood in for by its own words. */
const builderOver = (c: ReturnType<typeof aTreeCompany>, chain: ReturnType<typeof aChain>, fails = false) => ({
  ownSeat: async (m: { blinding: string }) => m.blinding,
  anchorsOnChain: async () => c.onChain(),
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
        createUnprovenCallTxFromInitialStates: async (_zk: unknown, o: { circuitId: string; initialPrivateState: unknown }) => {
          circuit = o.circuitId;
          return { private: { nextPrivateState: o.initialPrivateState, unprovenTx: 'UNPROVEN' } };
        },
      },
      accountCompiled: 'COMPILED', accountZkConfig: 'ZK', accountPure: pureCircuits,
      prove: async () => ({ serialize: () => new TextEncoder().encode('proved') }),
      random: (n: number) => new Uint8Array(n).fill(7),
      /* This wallet's clock is the test's, which a raise's deadline is judged against. */
      now: () => NOW.getTime(),
    } as unknown as GovernedCallDeps;
    await buildGovernedCall(deps, { ...input, chain: { accountState: new Uint8Array(0), parameters: new Uint8Array(0) } });
    return { tx: b64(JSON.stringify({ circuit, proposal: String(input.order.proposal).toLowerCase(), by: input.material.signingSecret })) };
  },
  roundsOnChain: async ({ chainIds, seat }: { chainIds: readonly string[]; seat?: string }) => Object.fromEntries(chainIds.map((id) => {
    const p = chain.proposals.get(id.toLowerCase());
    const mine = seat === undefined ? {} : { approvedHere: p?.by.has(seat) ?? false };
    return [id.toLowerCase(), p === undefined ? { held: 'never' as const, approvals: 0, ...mine }
      : { held: p.held, approvals: p.approvals, ...(p.outrun === true ? { outrun: true as const } : {}), ...mine }];
  })),
  accountCallChain: async () => ({ blockHash: 'b1'.repeat(32), accountState: chain.state(), parameters: '' }),
  lastRecovery: async ({ accountState }: { accountState: string }) => lastRecoveryIn(stateReader, Buffer.from(accountState, 'base64')),
  recoverAnchor: async (input: Parameters<VaultBuilderClient['recoverAnchor']>[0]) => (fails ? Promise.reject(new Error('the indexer did not answer')) : {
    tx: b64(JSON.stringify({ circuit: 'recoverAnchor', ...input, material: undefined, tag: tagInATest(input.material.signingSecret as Hex, ACCOUNT, input.material.blinding as Hex) })),
    placement: 'fallible' as const,
  }),
  anchorTag: anchorFunctions.anchorTag,
  anchorHeads: anchorFunctions.anchorHeads,
});

/** A proven call as the ledger reads it: the one call its words name, to the account, moving nothing, unless `over` adds to it. */
/** One intent as the ledger shapes it: every field the checks read is there, set only where `over` sets it. */
const intentOf = (actions: readonly unknown[], over: Record<string, unknown> = {}) =>
  ({ actions, guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined, dustActions: undefined, ...over });
const callRead = (raw: string, over: Record<string, unknown> = {}) => {
  const t = JSON.parse(Buffer.from(raw, 'base64').toString()) as { circuit: string };
  return {
    raw, guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, intentOf([{ address: ACCOUNT, entryPoint: t.circuit }])]]),
    imbalances: () => new Map(), ...over,
  };
};

/** The person's own wallet: pays each call's fee with one DUST spend and hands it to the chain; `adds` is anything more it would add. */
interface Over { call?: Record<string, unknown>; adds?: Record<string, unknown>; noDust?: boolean; approvals?: number; carryFails?: boolean }
const ownWalletOver = (chain: ReturnType<typeof aChain>, log: string[], o: Over = {}): OwnWalletDoors => ({
  ledger: async () => ({ Transaction: { deserialize: (_s: 'signature', _p: 'proof', _b: 'pre-binding', raw: Uint8Array) => callRead(Buffer.from(raw).toString('base64'), o.call) } }),
  keys: () => ({ shieldedSecretKeys: 'shielded', dustSecretKey: 'dust' }),
  signSegment: () => (async () => 'signed') as never,
  facade: async () => ({
    dust: { state: { subscribe: (w: { next: (s: { progress: { isConnected: boolean; isStrictlyComplete(): boolean } }) => void }) => { w.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } } },
    balanceUnboundTransaction: async (call: never, _k: unknown, options: { tokenKindsToBalance: string[] }) => {
      if (o.noDust === true) throw Object.assign(new Error('Insufficient funds'), { name: 'InsufficientFundsError' });
      log.push(`fee in ${options.tokenKindsToBalance.join(',')}`);
      return {
        baseTransaction: call,
        balancingTransaction: { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, intentOf([], { dustActions: { spends: [1], registrations: [] } })]]), ...o.adds },
      };
    },
    signRecipe: async (r: never) => r,
    finalizeRecipe: async (r: never) => r,
    submitTransaction: async (r: never) => { const raw = (r as { baseTransaction: { raw: string } }).baseTransaction.raw; log.push('own wallet sent'); chain.takes(raw); },
    revert: async () => { log.push('fee undone'); },
  }),
});

const aCompany = async () => {
  const c = aTreeCompany(COMPANY, HELD);
  await c.anchor([signManifestEntry(COMPANY, person('p1', 1, '1a'), A.secret)], A.secret);
  return c;
};

/** One signer's wallet: its saved seat, the heads its device kept from reading the records, the chain and its own wallet. */
const aWallet = async (c: Awaited<ReturnType<typeof aCompany>>, chain: ReturnType<typeof aChain>, who: typeof A, log: string[], o: Over = {}) => {
  const kept: TreeKept = treeKeptInMemory();
  await fullCheckHere({ accountId: COMPANY, tree: c.service, onChain: c.onChain, headsOf: headsByTheAccount, seatOf: (k: Hex) => seats.get(k) ?? null, checked: kept.checked });
  const builder = builderOver(c, chain, o.carryFails === true);
  const reach: RecoveryReach = {
    chain: () => ({
      holders: async () => ({ seats: [A.blinding, B.blinding, C.blinding], committee: [], approvals: o.approvals ?? HELD.approvals, seatBar: o.approvals ?? 2, policyBar: null, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }) as never,
      callState: async () => null,
      indexer: INDEXER,
    }),
    builder: () => builder as unknown as VaultBuilderClient,
    kept: () => kept,
    ownWallet: () => ownWalletOver(chain, log, o),
    now: () => NOW.getTime(),
    pause: async () => {},
    watch: { everyMs: 1000, withinMs: 3000 },
  };
  const ctxOf = (intent: ActIntent) => {
    const told: Record<string, string | number> = {};
    const ctx = {
      intent, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
      held: { identity: identityFromSecret(newSecret()), account: 0 }, at: { step: 1, steps: 3 }, signal: new AbortController().signal,
      relay: async () => { log.push('relay asked'); throw new Error('a recovery relays nothing through the page'); },
      call: async () => { log.push('call asked'); throw new Error('a recovery asks the service nothing'); },
      tell: (x: Record<string, string | number>) => { Object.assign(told, x); },
      show: () => {},
      sentByTheWallet: () => { log.push('act told of a send'); },
      keyring: { open: () => ({ read: () => ({ accounts: { [COMPANY]: { signerId: 's', signingSecret: who.secret, blinding: who.blinding, scope: SCOPE, wrappingSecret: '02'.repeat(32) } } }) }), keep: async () => {} },
    } as unknown as StepContext;
    return { ctx, told };
  };
  const run = async (def: ActionDefinition, intent: ActIntent, told: Record<string, string | number> = {}) => {
    const { ctx, told: here } = ctxOf(intent);
    try {
      for (const step of def.steps(intent)) await step.run(ctx);
    } finally {
      Object.assign(told, here);
    }
    return told;
  };
  const doors = (): RecoveryDoors => ({
    accountId: COMPANY, account: ACCOUNT, material: { signingSecret: who.secret, blinding: who.blinding, scope: SCOPE }, indexer: INDEXER,
    builder: builder as unknown as RecoveryDoors['builder'], onChain: c.onChain, checked: kept.checked, headers: kept.headers,
    send: { ownWallet: { send: async (tx: string) => chain.takes(tx), chosen: async () => true } },
    watch: { everyMs: 1000, withinMs: 3000, sleep: async () => {} }, now: () => NOW,
  });
  return { reach, run, doors };
};

const BASE = { record: COMPANY, company: LABEL, account: ACCOUNT };
const raising = (): ActIntent => ({ name: 'recovery', fields: { ...BASE, step: 'raise', latest: LATEST_SECONDS } }) as unknown as ActIntent;
const fileFields = (told: Record<string, string | number>) => ({
  proposal: String(told['proposal']), salt: String(told['salt']), latest: String(told['latest']), lastRecovery: String(told['lastRecovery']),
  resumesFrom: String(told['resumesFrom']), root: String(told['root']), seq: String(told['seq']),
});
const approving = (told: Record<string, string | number>): ActIntent =>
  ({ name: 'approve-proposal', fields: { ...BASE, kind: 'recovery', ...fileFields(told) } }) as unknown as ActIntent;
const carrying = (told: Record<string, string | number>): ActIntent =>
  ({ name: 'recovery', fields: { ...BASE, step: 'carry', ...fileFields(told) } }) as unknown as ActIntent;

/** A company whose records stop at a batch nobody kept, its devices having read the batch before. */
const stopped = async () => {
  const c = await aCompany();
  const chain = aChain(c);
  const log: string[] = [];
  const a = await aWallet(c, chain, A, log);
  const b = await aWallet(c, chain, B, log);
  c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
  return { c, chain, log, a, b };
};

const refusalOf = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};

describe('A RECOVERY RUN FROM EACH SIGNER\'S OWN WALLET, ON THE CHAIN ALONE', () => {
  it('A RECOVERY RAISED IN ONE WALLET IS APPROVED IN ANOTHER AND CARRIED OUT THERE, EVERY CALL FROM THE PERSON\'S OWN WALLET', async () => {
    const { c, chain, log, a, b } = await stopped();
    const raised = await a.run(recoveryAction(a.reach), raising());
    /* RED WHEN: a raise is not sent, or the page is not told where it stands and the parts of its file. */
    expect(raised).toMatchObject({ state: 'waiting-for-approvals', approvals: 1, needed: 2, seq: 0, latest: LATEST_SECONDS, resumesFrom: c.checkedAt(0).head });
    expect(chain.sent).toEqual(['propose']);
    const approved = await b.run(approveProposalAction({ recovery: b.reach } as never), approving(raised));
    /* RED WHEN: the approval of a recovery is not the one approval action's recovery kind, or a met bar is not carried out in its window. */
    expect(approved).toEqual({ state: 'carried-out', approvals: 2, needed: 2 });
    expect(chain.sent).toEqual(['propose', 'approve', 'recoverAnchor']);
    /* RED WHEN: the head the chain moved to is not the recovery's: the batch nobody kept is still the newest. */
    expect(c.landed[c.landed.length - 1]!.head).not.toBe('ee'.repeat(32));
    /* RED WHEN: a recovery's step asks the page to call the service or to relay, or any call goes but from the person's own wallet, paying in DUST alone. */
    expect(log.filter((l) => l === 'call asked' || l === 'relay asked')).toEqual([]);
    expect(log.filter((l) => l === 'own wallet sent')).toHaveLength(3);
    expect(log.filter((l) => l.startsWith('fee in'))).toEqual(['fee in dust', 'fee in dust', 'fee in dust']);
    /* RED WHEN: a recovery's call the person's own wallet sent is not told to the act, so a stop after it says nothing left the wallet. */
    expect(log.filter((l) => l === 'act told of a send')).toHaveLength(3);
  });

  it('A RECOVERY APPROVED ELSEWHERE IS CARRIED OUT FROM ITS FILE IN THE RAISER\'S WALLET, AND ONE SHORT OF ITS APPROVALS SENDS NOTHING', async () => {
    const { chain, a, b } = await stopped();
    const raised = await a.run(recoveryAction(a.reach), raising());
    /* RED WHEN: a carrying out short of its approvals sends a call that could only be refused, its fee paid. */
    expect(await a.run(recoveryAction(a.reach), carrying(raised))).toMatchObject({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
    expect(chain.sent).toEqual(['propose']);
    await approveRecoveryHere(b.doors(), recoveryFileOf({
      company: COMPANY, account: ACCOUNT, chainId: String(raised['proposal']), salt: String(raised['salt']), latest: String(raised['latest']),
      lastRecovery: String(raised['lastRecovery']), resumesFrom: { seq: Number(raised['seq']), head: String(raised['resumesFrom']), root: String(raised['root']) },
    }), { withoutTheService: true });
    /* RED WHEN: a recovery opened from its file's parts is not the one raised, or is not carried out once the chain counts its approvals. */
    expect(await a.run(recoveryAction(a.reach), carrying(raised))).toMatchObject({ state: 'carried-out', approvals: 2, needed: 2 });
    expect(chain.sent).toEqual(['propose', 'approve', 'recoverAnchor']);
    /* RED WHEN: a recovery the chain no longer holds open is carried out again. */
    expect(await refusalOf(a.run(recoveryAction(a.reach), carrying(raised)))).toBe('act.recovery.why.closed');
  });

  it('A CALL THAT MOVES A COIN OR CALLS ANYTHING ELSE IS REFUSED BEFORE ANY FEE IS PAID, AND NOTHING IS SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    const log: string[] = [];
    const coin = await aWallet(c, chain, A, log, { call: { guaranteedOffer: { inputs: [], outputs: [{ contractAddress: 'ff'.repeat(32) }], transients: [] } } });
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    /* RED WHEN: a raise whose call also makes a coin has its fee paid or is sent. */
    expect(await refusalOf(coin.run(recoveryAction(coin.reach), raising()))).toBe('act.recovery.why.not-raised-here');
    const other = await aWallet(c, chain, A, log, { call: { intents: new Map([[1, intentOf([{ address: 'ff'.repeat(32), entryPoint: 'propose' }])]]) } });
    /* RED WHEN: a call to another contract than the company's account has its fee paid or is sent. */
    expect(await refusalOf(other.run(recoveryAction(other.reach), raising()))).toBe('act.recovery.why.not-raised-here');
    const more = await aWallet(c, chain, A, log, { adds: { guaranteedOffer: { inputs: [{}], outputs: [], transients: [] } } });
    /* RED WHEN: what the wallet adds to pay the fee also spends a coin, and is signed or sent; the fee booked is not undone. */
    expect(await refusalOf(more.run(recoveryAction(more.reach), raising()))).toBe('act.recovery.why.not-raised-here');
    expect(chain.sent).toEqual([]);
    expect(log.filter((l) => l === 'own wallet sent')).toEqual([]);
    expect(log.filter((l) => l === 'fee undone')).toHaveLength(1);
  });

  it('THE ONE CALL A STEP MAKES, AND A FEE THAT SPENDS DUST ALONE, ARE ALL THAT IS EVER PAID FOR', () => {
    const one = (over: Record<string, unknown> = {}) => ({
      guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, intentOf([{ address: ACCOUNT, entryPoint: 'approve' }])]]), imbalances: () => new Map(), ...over,
    });
    expect(notOneCallRefusal(one(), ACCOUNT, 'approve')).toBeNull();
    /* RED WHEN: a call to another circuit, a second call, public money, DUST already spent, or a token owed besides the fee is paid for. */
    expect(notOneCallRefusal(one(), ACCOUNT, 'recoverAnchor')).toMatch(/calls "approve"/u);
    expect(notOneCallRefusal(one({ intents: new Map([[1, intentOf([{ address: ACCOUNT, entryPoint: 'approve' }, { address: ACCOUNT, entryPoint: 'approve' }])]]) }), ACCOUNT, 'approve')).toMatch(/2 calls/u);
    expect(notOneCallRefusal(one({ intents: new Map([[1, intentOf([{ address: ACCOUNT, entryPoint: 'approve' }], { guaranteedUnshieldedOffer: { inputs: [{}], outputs: [] } })]]) }), ACCOUNT, 'approve')).toMatch(/public money/u);
    expect(notOneCallRefusal(one({ intents: new Map([[1, intentOf([{ address: ACCOUNT, entryPoint: 'approve' }], { dustActions: { spends: [{}], registrations: [] } })]]) }), ACCOUNT, 'approve')).toMatch(/DUST/u);
    expect(notOneCallRefusal(one({ imbalances: () => new Map([[{ tag: 'shielded', raw: 'aa' }, -5n]]) }), ACCOUNT, 'approve')).toMatch(/not its fee/u);
    expect(notOneCallRefusal(one({ imbalances: () => new Map([[{ tag: 'dust' }, -5n]]) }), ACCOUNT, 'approve')).toBeNull();
    const call = one();
    const fee = (over: Record<string, unknown> = {}) => ({
      baseTransaction: call,
      balancingTransaction: { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, intentOf([], { dustActions: { spends: [{}], registrations: [] } })]]), ...over },
    });
    expect(moreThanTheFeeRefusal(fee(), call)).toBeNull();
    /* RED WHEN: the wallet pays for a call changed as it balanced, or adds a call, public money, a DUST registration, or nothing at all. */
    expect(moreThanTheFeeRefusal({ ...fee(), baseTransaction: one() }, call)).toMatch(/change the call/u);
    expect(moreThanTheFeeRefusal(fee({ intents: new Map([[1, intentOf([{}], { dustActions: { spends: [{}], registrations: [] } })]]) }), call)).toMatch(/make a call/u);
    expect(moreThanTheFeeRefusal(fee({ intents: new Map([[1, intentOf([], { fallibleUnshieldedOffer: { inputs: [], outputs: [{}] }, dustActions: { spends: [{}], registrations: [] } })]]) }), call)).toMatch(/public money/u);
    expect(moreThanTheFeeRefusal(fee({ intents: new Map([[1, intentOf([], { dustActions: { spends: [{}], registrations: [{}] } })]]) }), call)).toMatch(/register DUST/u);
    expect(moreThanTheFeeRefusal(fee({ intents: new Map() }), call)).toMatch(/nothing to pay the fee/u);
  });

  it('THE WINDOW SHOWS BOTH CHOICES THE PASSKEY APPROVES, AND A RECOVERY LISTS NO CALL AND NO RELAY FOR THE PAGE', async () => {
    const { a, b } = await stopped();
    const raised = await a.run(recoveryAction(a.reach), raising());
    const keysOf = async (def: ActionDefinition, i: ActIntent) => (await def.shown(i)).map((l) => l.key);
    /* RED WHEN: going on without the service or paying the fee from the person's own wallet is not a line the passkey approves. */
    for (const keys of [await keysOf(recoveryAction(a.reach), raising()), await keysOf(recoveryAction(a.reach), carrying(raised)),
      await keysOf(approveProposalAction({ recovery: b.reach } as never), approving(raised))]) {
      expect(keys).toEqual(expect.arrayContaining(['act.recovery.shown.without-the-service', 'act.recovery.shown.own-wallet']));
      expect(keys.filter((k) => k.startsWith('act.upkeep.'))).toEqual([]);
    }
    /* RED WHEN: a recovery may ask the page to call the service or to relay a transaction. */
    const shape = ACT_INTENTS.recovery;
    expect(shape.calls).toEqual([]);
    expect('relays' in shape).toBe(false);
    expect(routeOf(shape, 'POST', '/api/proposals/p/approve')).toBeNull();
    /* RED WHEN: the window or a refusal names words the wallet does not have. */
    const said = readFileSync(new URL('./recovery.ts', import.meta.url), 'utf8').match(/['`]act\.recovery\.[a-z.-]+['`]|why\('[a-z-]+'/gu) ?? [];
    const keys = said.map((k) => (k.startsWith('why(') ? `act.recovery.why.${k.slice(5, -1)}` : k.slice(1, -1)));
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((k) => WORDS[k] === undefined)).toEqual([]);
  });

  it('A RECOVERY IS REFUSED BEFORE THE WINDOW WITH NO WALLET ACCOUNT TO PAY ITS FEE, AND WITH A FILE NOT WHOLE', async () => {
    const def = recoveryAction({} as RecoveryReach);
    /* RED WHEN: a recovery opens its window when nothing can pay its fee, or when a part of its file is missing. */
    expect((await def.check(raising(), {} as never))?.key).toBe('act.recovery.why.no-account');
    expect((await def.check(raising(), { account: 0 } as never))).toBeNull();
    const notWhole = { ...carrying({ proposal: 'aa'.repeat(32) }), fields: { ...BASE, step: 'carry', latest: LATEST_SECONDS, proposal: 'aa'.repeat(32) } } as unknown as ActIntent;
    expect((await def.check(notWhole, { account: 0 } as never))?.key).toBe('act.recovery.why.not-a-recovery');
    const kind = approveProposalAction({} as never);
    expect((await kind.check({ name: 'approve-proposal', fields: { ...BASE, kind: 'recovery', proposal: 'aa'.repeat(32) } } as unknown as ActIntent, {} as never))?.key)
      .toBe('act.approve-proposal.why.not-a-proposal');
  });
  it('A RECOVERY APPROVED THROUGH THE ONE APPROVAL LISTS ITS OWN CHECKS, AND NO OTHER KIND\'S CHECKS CHANGE', async () => {
    const { a } = await stopped();
    const raised = await a.run(recoveryAction(a.reach), raising());
    const def = approveProposalAction({ recovery: a.reach } as never);
    /* RED WHEN: a recovery's window lists the invitation or upkeep checks it never runs, or not the fee-only check it does run. */
    expect(def.checksFor!(approving(raised)).map((w) => w.key)).toEqual(['act.recovery.check.seat', 'act.recovery.check.standing', 'act.recovery.check.fee-only']);
    /* RED WHEN: another kind's window loses or changes its checks. */
    expect(def.checksFor!({ name: 'approve-proposal', fields: { ...BASE, kind: 'add-signer', proposal: 'p' } } as unknown as ActIntent)).toBe(def.checks);
    expect(def.checks.map((w) => w.key)).toEqual([
      'act.approve-proposal.check.seat', 'act.approve-proposal.check.same', 'act.approve-proposal.check.one-seat', 'act.approve-proposal.check.chain', 'act.upkeep.check.worked-out',
    ]);
  });

  it('THE WINDOW SAYS HOW MANY BATCHES THE RECOVERY GIVES UP, READ FROM THE CHAIN, AND THAT THIS WALLET HAS NOT CHECKED THEM', async () => {
    const { a, b } = await stopped();
    const raised = await a.run(recoveryAction(a.reach), raising());
    /* RED WHEN: the window does not say how many anchored batches the recovery gives up, as this wallet reads the chain. */
    const given = { key: 'act.recovery.shown.given-up', values: { count: 1, seq: 0 }, from: 'wallet' };
    expect(await recoveryAction(a.reach).shown(raising())).toContainEqual(given);
    expect(await approveProposalAction({ recovery: b.reach } as never).shown(approving(raised))).toContainEqual(given);
    expect(await recoveryAction(a.reach).shown(carrying(raised))).toContainEqual(given);
    /* RED WHEN: a recovery's words claim no signer's device can check what is given up, when only this wallet has not checked it. */
    const words = Object.entries(WORDS).filter(([k]) => k.startsWith('act.recovery.')).map(([, v]) => v).join(' ');
    expect(words).not.toMatch(/no signer's device|no device here|which no/u);
    expect(WORDS['act.recovery.shown.given-up']).toMatch(/this wallet has not checked/u);
  });

  it('A RECOVERY A REMOVAL OUTRAN IS NEITHER APPROVED NOR CARRIED OUT, AND NO FEE IS SPENT ON IT', async () => {
    const { chain, log, a, b } = await stopped();
    const raised = await a.run(recoveryAction(a.reach), raising());
    chain.proposals.get(String(raised['proposal']))!.outrun = true;
    /* RED WHEN: a signer approves or carries out a recovery raised before a removal, paying a fee for a call the account refuses. */
    expect(await refusalOf(b.run(approveProposalAction({ recovery: b.reach } as never), approving(raised)))).toBe('act.recovery.why.outrun');
    expect(await refusalOf(a.run(recoveryAction(a.reach), carrying(raised)))).toBe('act.recovery.why.outrun');
    expect(chain.sent).toEqual(['propose']);
    expect(log.filter((l) => l === 'own wallet sent')).toHaveLength(1);
  });

  it('A RAISE WHOSE CARRYING OUT IS REFUSED STILL HANDS THE PAGE ITS FILE, SALT AND ALL', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    const log: string[] = [];
    const one = await aWallet(c, chain, A, log, { approvals: 1, carryFails: true });
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    const told: Record<string, string | number> = {};
    expect(await refusalOf(one.run(recoveryAction(one.reach), raising(), told))).toBe('act.recovery.why.not-carried');
    /* RED WHEN: a raise the chain holds loses its salt because the carrying out after it was refused: nobody could then approve or carry it out. */
    expect(chain.sent).toEqual(['propose']);
    expect(String(told['salt'])).toMatch(/^[0-9a-f]{64}$/u);
    expect(told['proposal']).toBe([...chain.proposals.keys()][0]);
  });

  it('A WALLET WITH TOO LITTLE DUST FOR THE FEE IS TOLD SO, AND NOTHING IS PAID OR SENT', async () => {
    const c = await aCompany();
    const chain = aChain(c);
    const log: string[] = [];
    const poor = await aWallet(c, chain, A, log, { noDust: true });
    c.landed.push({ head: 'ee'.repeat(32), seatBar: seatBarOf(HELD.approvals, null), tag: tagInATest(C.secret), height: c.landed.length + 1, at: 0 });
    /* RED WHEN: a wallet without the DUST for the fee is answered in the network's words, or anything is sent. */
    expect(await refusalOf(poor.run(recoveryAction(poor.reach), raising()))).toBe('act.recovery.why.no-dust');
    expect(chain.sent).toEqual([]);
    expect(log).toEqual([]);
  });

  it('THE CHECKS READ THE LEDGER\'S OWN TRANSACTIONS: A PUBLIC OFFER, A COIN OR A DUST REGISTRATION IS REFUSED, AND A FIELD NOT THERE IS NEVER READ AS EMPTY', () => {
    const op = new ledger.ContractOperation();
    const nothing = { value: [], alignment: [] };
    const ttl = new Date(Date.now() + 60_000);
    const intent = () => ledger.Intent.new(ttl).addCall(new ledger.ContractCallPrototype(
      ACCOUNT, 'approve', op, undefined, undefined, [], nothing as never, nothing as never, ledger.communicationCommitmentRandomness(), 'k'));
    const tx = (i: ReturnType<typeof intent>, coin?: unknown) => ledger.Transaction.fromParts('undeployed', coin as never, undefined, i);
    /* RED WHEN: one call to the account, as the ledger itself makes it, is not paid for. */
    expect(notOneCallRefusal(tx(intent()), ACCOUNT, 'approve')).toBeNull();
    const pub = intent();
    pub.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([], [{ value: 5n, owner: 'cd'.repeat(32), type: ledger.nativeToken().raw }], []);
    /* RED WHEN: a call the ledger reads as moving public money is paid for. */
    expect(notOneCallRefusal(tx(pub), ACCOUNT, 'approve')).toMatch(/public money/u);
    const keys = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(3));
    const coin = ledger.ZswapOffer.fromOutput(
      ledger.ZswapOutput.new(ledger.createShieldedCoinInfo(ledger.shieldedToken().raw, 10n), 0, keys.coinPublicKey, keys.encryptionPublicKey),
      ledger.shieldedToken().raw, 10n);
    /* RED WHEN: a call the ledger reads as making a coin is paid for. */
    expect(notOneCallRefusal(tx(intent(), coin), ACCOUNT, 'approve')).toMatch(/coin/u);
    const reg = intent();
    reg.dustActions = new ledger.DustActions('signature', 'pre-proof', new Date(), [], [
      new ledger.DustRegistration('signature', ledger.signatureVerifyingKey(ledger.sampleSigningKey()), undefined, 0n),
    ]);
    const registered = tx(reg);
    /* RED WHEN: a call or a fee the ledger reads as registering DUST is paid for. */
    expect(notOneCallRefusal(registered, ACCOUNT, 'approve')).toMatch(/DUST/u);
    const call = tx(intent());
    expect(moreThanTheFeeRefusal({ baseTransaction: call, balancingTransaction: registered }, call)).toMatch(/make a call|register DUST/u);
    /* RED WHEN: a part whose field the checks read is missing - renamed in the ledger - is read as empty and paid for. */
    const renamed = { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, { actions: [{ address: ACCOUNT, entryPoint: 'approve' }] }]]), imbalances: () => new Map() };
    expect(notOneCallRefusal(renamed, ACCOUNT, 'approve')).toMatch(/can read/u);
    expect(notOneCallRefusal({ ...renamed, intents: new Map([[1, intentOf([{ address: ACCOUNT, entryPoint: 'approve' }], { guaranteedUnshieldedOffer: { outputs: [] } })]]) }, ACCOUNT, 'approve'))
      .toMatch(/public money/u);
  });
});
