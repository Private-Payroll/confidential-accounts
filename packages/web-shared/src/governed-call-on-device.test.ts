import { kindKeyOf } from '../../../src/midnight/records-held.js';
import { describe, it, expect, vi } from 'vitest';
import {
  ApprovalNotOwed, theRoundAsked, approveOnDevice, changeThresholdOnDevice, changeVaultThresholdOnDevice, governOnDevice, governedCallServiceFor, nothingWasSentBy, raiseRetryOnDevice, raiseRunOnDevice,
  SentAndNotYetSeen, sendRaiseFromDevice, sendRetryFromDevice, withdrawOnDevice, type WithdrawalStop,
  type GovernanceDoors, type GovernedCallService, type LegPaymentsOnTheWire, type RaiseDoors, type RaiseOrderOnTheWire,
  type RetryOrderOnTheWire, type RoundOnThePage,
} from './governed-call-on-device.js';
import type { GovernanceOnTheWire, OpenedRound, RoundOnChain } from './governed-call-builder.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { paysCommitmentOf } from '../../../src/core/proposal-filing.js';
import type { ChainCall } from './hand-over.js';

/**
 * **WHAT THIS DEVICE MAKES FROM THE COMPANY'S RECORDS, AND THE PROPOSAL IT OPENS
 * FROM THEM, STAND IN FOR THE RECORDS HERE**, through the modules that make
 * them, so the send, the vault check and the waiting can be watched in order.
 * Nothing in the product takes them from anywhere but the records: what is made
 * from real records is the subject of `a-raise-is-made-from-the-companys-records.test.ts`,
 * and what is opened, of `the-device-proves-what-it-opened.test.ts`.
 */
const seams = vi.hoisted(() => ({
  made: undefined as unknown as MadeHereDoors,
  opens: undefined as unknown as (proposalId: string, viewingKey: string, forARaise: boolean) => Promise<OpenedRound>,
  raiseLeg: undefined as unknown as () => Promise<RoundOnThePage>,
  raiseRetry: undefined as unknown as () => Promise<RoundOnThePage>,
  /* The seat whose filing of each proposal the opener believes. */
  filedBy: 'a7'.repeat(32),
  /* The deadline the opener reads from each proposal's signed record, in seconds. */
  raiseBy: '2000' as string | undefined,
}));
vi.mock('./material-made-here.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./material-made-here.js')>();
  type W = { asset?: string; form?: LedgerForm };
  return {
    ...real,
    legPaymentsHere: (_r: unknown, _a: string, runId: string, viewingKey: string, which?: W) => seams.made.legPayments(runId, viewingKey, which),
    retryPaymentsHere: (_r: unknown, _a: string, runId: string, viewingKey: string, indices: readonly number[], which?: W) =>
      seams.made.retryPayments(runId, viewingKey, indices, which),
    raiseOrderHere: (_r: unknown, _a: string, runId: string, viewingKey: string, which?: W) => seams.made.raiseOrder(runId, viewingKey, which),
    retryOrderHere: (_r: unknown, _a: string, runId: string, viewingKey: string, proposalId: string, which?: W) =>
      seams.made.retryOrder(runId, viewingKey, proposalId, which),
  };
});
/* A leg or a retry raised from the records is the subject of its own file; here only what the device does with the service's answer to it. */
vi.mock('./run-raised-here.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-raised-here.js')>()),
  raiseLegHere: () => seams.raiseLeg(),
  raiseRetryHere: () => seams.raiseRetry(),
}));
/**
 * The company's directory and records as a read that names no seat and no proposal of the company's records gives
 * them: nobody is under a removal, so who raised a run holds nothing up here.
 */
const NOBODY_LEAVING = {
  dir: { seats: [] }, holders: { seats: [], seatBar: 1 },
  records: { history: new Map(), notYetAnchored: [], asked: { records: new Set(), kinds: new Set([kindKeyOf({ store: 'proposal', kind: 'proposal' })]) } },
};
/* Who raised each proposal, as the opener believes it, where a test does not say: a seat of the company's under no removal. */
vi.mock('./round-opened-here.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./round-opened-here.js')>()),
  openTheRoundHere: async (_s: unknown, _a: string, proposalId: string, viewingKey: string, forARaise: boolean) =>
    ({
      filedBy: seams.filedBy, ...(seams.raiseBy === undefined ? {} : { raiseBy: seams.raiseBy }),
      ...(await seams.opens(proposalId, viewingKey, forARaise)),
    }),
}));
/** What a raise or a retry is made from on this device, as the page's modules make it. */
interface MadeHereDoors {
  legPayments(runId: string, viewingKey: string, which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  retryPayments(runId: string, viewingKey: string, indices: readonly number[], which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  raiseOrder(runId: string, viewingKey: string, which?: { asset?: string; form?: LedgerForm }): Promise<RaiseOrderOnTheWire>;
  retryOrder(runId: string, viewingKey: string, proposalId: string, which?: { asset?: string; form?: LedgerForm }): Promise<RetryOrderOnTheWire>;
}
import type { LedgerForm } from '../../../src/core/assets.js';
import { deviceVaultHoldings, type PoolNote } from './device-vault-holdings.js';
import { paymentsFitNotes } from './vault-builder.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../src/testing/assets.js';
import { canonical, newSigningKeypair, newSymmetricKey, seal, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { approverRosterFrom } from '../../../src/core/vault-approvers.js';
import type { RetirementSignature, SealedProposal } from '../../../src/core/types.js';
import { heldEntering } from '../../../src/testing/record-tree-double.js';
import type { LegRaiseDoors } from './run-raised-here.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { DEVICE_RAISE_VERSION, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED } from '../../../src/core/device-raise.js';
import { opensAs } from '../../../src/testing/sealed-records.js';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import { sealRoster } from '../../../src/core/roster-record.js';
import { signCompanyFiling } from '../../../src/midnight/sealed-record-wire.js';

/* The page's side, over a service and a worker that write down what they were asked, in order. */
const material = { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) };
/* The vault's private money, as this device's pool records it and the chain holds it. */
/* A token with both forms, which the fixture registry holds beside the product's own: what each leg here pays. */
const TOKEN = TEST_TOKEN as Hex;
const note = (n: number, value: bigint): PoolNote => ({
  nonce: n.toString(16).padStart(64, '0') as Hex, token: TOKEN, value, createdIn: 'ee'.repeat(32) as Hex,
});
const committed = (n: PoolNote) => `c${n.nonce.slice(1)}`;
const LEG: LegPaymentsOnTheWire = {
  asset: TOKEN, payments: [0, 1, 2].map(() => ({ kind: 'shielded', token: TOKEN, amount: '10000' })),
};
const PLENTY = [note(1, 1_000_000n)];
const VAULT = '99'.repeat(32);
const SALT = '66'.repeat(32);
/* The deadline every proposal opened here carries, in seconds, and the chain's time, in milliseconds, at it. */
const RAISE_BY = '2000';
const AT_THE_DEADLINE = 2_000_000;
const ASSET_BLINDING = '55'.repeat(32);
/* What a proposal written down for `payments` commits to paying, as its filing carries it, under ORDER's vault, salt and asset blinding. */
const paysFor = (payments: LegPaymentsOnTheWire['payments'], asset: string = TOKEN): string => paysCommitmentOf({ vault: VAULT, asset, payments }, SALT, ASSET_BLINDING);

const ORDER: RaiseOrderOnTheWire = {
  proposalId: 'prp_1', chainId: 'cc'.repeat(32),
  order: {
    circuit: 'propose',
    run: { root: '88'.repeat(32), payees: '3', opensAt: '1', closesAt: '2', vault: VAULT },
    half: { assetId: '44'.repeat(32), assetBlinding: ASSET_BLINDING, proposalSalt: SALT, changeAmount: '1', changeBatchDigest: '77'.repeat(32) },
    proposal: 'cc'.repeat(32),
  },
  pays: paysFor(LEG.payments),
};
/* The proposal written down for another set of payments than LEG's: its count of payees and its commitment follow them. */
const orderPaying = (payments: LegPaymentsOnTheWire['payments'], asset: string = TOKEN): RaiseOrderOnTheWire => ({
  ...ORDER, order: { ...ORDER.order, run: { ...ORDER.order.run, payees: String(payments.length) } },
  pays: paysFor(payments, asset),
});
/* A retry of the leg's second and third people, written down and not yet sent. */
const RETRY_ORDER: RetryOrderOnTheWire = {
  ...ORDER, proposalId: 'prp_r', chainId: 'cd'.repeat(32),
  order: { ...ORDER.order, run: { ...ORDER.order.run, payees: '2' }, proposal: 'cd'.repeat(32) },
  indices: [1, 2],
  pays: paysFor(LEG.payments.slice(1)),
};
const round = (over: Partial<RoundOnThePage> = {}): RoundOnThePage => ({ id: 'prp_1', chainId: 'cc'.repeat(32), status: 'open', ...over });

/**
 * **WHAT THIS FILE'S CHAIN HOLDS**, by default, kept from what this device
 * sent and never from what the service answers: a round is held from the
 * send of its raise, with an approval counted for each approval sent, and
 * closed by a withdrawal sent; this seat's approval is held once this device
 * sent one. A round no call of this device's reached is never held. A case
 * whose chain holds what another device sent gives its own (`chainSays`).
 */
const aChainOfWhatWasSent = (closedBy: readonly string[] = ['cancel'], whileHeld: Partial<RoundOnChain> = {}) => {
  const held = new Map<string, { approvals: number; closed: boolean; mine: boolean }>();
  const of = (chainId: string) => held.get(String(chainId).toLowerCase());
  return {
    raised: (chainId: string) => { if (of(chainId) === undefined) held.set(String(chainId).toLowerCase(), { approvals: 0, closed: false, mine: false }); },
    approved: (chainId: string, mine = false) => {
      const r = of(chainId);
      if (r !== undefined && !r.closed) { r.approvals += 1; r.mine ||= mine; }
    },
    withdrawn: (chainId: string) => { const r = of(chainId); if (r !== undefined) r.closed = true; },
    says: (served: RoundOnThePage): RoundOnChain => {
      const r = of(served.chainId);
      return r === undefined ? { held: 'never', approvals: 0, approvedHere: false }
        : r.closed ? { held: 'closed', approvals: 0, raisedAt: 1, closedBy: [...closedBy], approvedHere: r.mine }
          : { held: 'open', approvals: r.approvals, raisedAt: 1, approvedHere: r.mine, ...whileHeld };
    },
  };
};

/**
 * What this device makes a raise or a retry from, as fakes that log what they were asked in the shape the service's
 * routes once were. What is made from real records is the subject of `a-raise-is-made-from-the-companys-records.test.ts`.
 */
interface Leg { viewingKey: string; asset?: string; form?: LedgerForm }
interface MadeOver {
  legPayments?: (runId: string, body: Leg) => Promise<LegPaymentsOnTheWire>;
  raiseOrder?: (runId: string, body: Leg) => Promise<RaiseOrderOnTheWire>;
  retryPayments?: (runId: string, body: Leg & { indices: number[] }) => Promise<LegPaymentsOnTheWire>;
  retryOrder?: (runId: string, body: Leg & { proposalId: string }) => Promise<RetryOrderOnTheWire>;
}

const aDevice = (over: Partial<GovernedCallService> & MadeOver & {
  standings?: RoundOnThePage[]; buildFails?: Error;
  /** What the chain shows of the proposal the service last answered for; by default what this device's own calls left (`aChainOfWhatWasSent`). */
  chainSays?: (served: RoundOnThePage) => RoundOnChain;
  /** Rounds the chain already holds when the case starts, raised from another device, by identity on chain, with their approvals. */
  heldBefore?: Readonly<Record<string, number>>;
  /** What the chain also says of a round while it holds it (who raised it, a run's window), and the calls of the block that closed it. */
  whileHeld?: Partial<RoundOnChain>; closedBy?: readonly string[];
  /** The seat whose filing the opener believes; by default another seat's. */
  filedBy?: string;
  /** The deadline, in seconds, the opener reads from the proposal's signed record; by default `RAISE_BY`. */
  raiseBy?: string;
  pool?: PoolNote[]; chainNotes?: string[]; fitFails?: Error;
  /** What the vault holds publicly as the chain shows it; by default plenty of every token a case pays publicly. */
  publicBalances?: Array<{ token: string; amount: string }>;
  /** The pool as each check finds it, first check first; the last one stands for every later check. */
  poolAtCheck?: PoolNote[][];
  /**
   * Each finished call sent straight to the chain from the person's own wallet rather than through the service;
   * `no-wallet` names that path on a device that reaches no wallet.
   */
  straight?: true | 'no-wallet';
} = {}) => {
  const log: string[] = [];
  const standings = [...(over.standings ?? [])];
  let checks = 0;
  const poolNow = (): PoolNote[] => (over.poolAtCheck
    ? over.poolAtCheck[Math.min(checks, over.poolAtCheck.length) - 1] ?? over.poolAtCheck[0]!
    : over.pool ?? PLENTY);
  const asked: Required<MadeOver> = {
    legPayments: async (runId, body) => { checks += 1; log.push(`made leg-payments ${runId} ${JSON.stringify(body)}`); return LEG; },
    raiseOrder: async (runId) => { log.push(`made order ${runId}`); return ORDER; },
    retryPayments: async (runId, body) => {
      checks += 1; log.push(`made retry-payments ${runId} ${JSON.stringify(body)}`);
      return { asset: LEG.asset, payments: body.indices.map((i) => LEG.payments[i]!) };
    },
    retryOrder: async (runId, body) => { log.push(`made retry-order ${runId} ${body.proposalId}`); return RETRY_ORDER; },
    ...Object.fromEntries((['legPayments', 'raiseOrder', 'retryPayments', 'retryOrder'] as const)
      .filter((k) => over[k] !== undefined).map((k) => [k, over[k]])),
  };
  const made: MadeHereDoors = {
    legPayments: (runId, viewingKey, which) => asked.legPayments(runId, { viewingKey, ...which }),
    raiseOrder: (runId, viewingKey, which) => asked.raiseOrder(runId, { viewingKey, ...which }),
    retryPayments: (runId, viewingKey, indices, which) => asked.retryPayments(runId, { viewingKey, ...which, indices: [...indices] }),
    retryOrder: (runId, viewingKey, proposalId, which) => asked.retryOrder(runId, { viewingKey, ...which, proposalId }),
  };
  /* The filing key each relay carried, kept apart from the log, which says what was relayed. */
  const filers: string[] = [];
  const served: GovernedCallService = {
    /* The service names the proposal it was asked to send, as the company's records name it. */
    send: async (id, body) => {
      filers.push(`send ${body.filer}`); log.push(`send ${id} ${body.tx} ${body.version}`);
      return round({ id, chainId: id === RETRY_ORDER.proposalId ? RETRY_ORDER.chainId : ORDER.chainId, txRef: 't1' });
    },
    callState: async (id) => { log.push(`state ${id}`); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
    approve: async (id, body) => { filers.push(`approve ${body.filer}`); log.push(`approve ${id} ${body.tx}`); return round(); },
    cancel: async (id, { filer, ...body }) => { filers.push(`cancel ${filer}`); log.push(`cancel ${id} ${JSON.stringify(body)}`); return round({ status: 'cancelled' }); },
    standing: async (id) => { log.push(`standing ${id}`); return standings.shift() ?? round(); },
    ...over,
  };
  /* This file's chain, moved only by the calls this device sent through the service, as each lands, and by another device before. */
  const onChain = aChainOfWhatWasSent(over.closedBy, over.whileHeld);
  for (const [chainId, approvals] of Object.entries(over.heldBefore ?? {})) {
    onChain.raised(chainId);
    for (let i = 0; i < approvals; i += 1) onChain.approved(chainId);
  }
  /* The proposal each answer of the service named, by its identity on chain: what this file's chain is read for. */
  const lastServed = new Map<string, RoundOnThePage>();
  const kept = <A extends unknown[]>(f: ((...a: A) => Promise<RoundOnThePage>) | undefined) => (f === undefined ? undefined
    : async (...a: A) => { const r = await f(...a); lastServed.set(String(r.chainId).toLowerCase(), r); return r; });
  /* The proposal each kind of call was last built for: what the chain takes when that call lands. */
  const proven = new Map<string, string>();
  /*
   * A call this device sent: the chain takes the proposal its proven transaction was built for, whatever identity the
   * service answers with.
   */
  const landing = <A extends unknown[]>(
    f: ((...a: A) => Promise<RoundOnThePage>) | undefined, circuit: string, lands: (chainId: string) => void,
  ) => (f === undefined ? undefined : async (...a: A) => {
    const r = await f(...a);
    const built = proven.get(circuit);
    if ((a[1] as { tx?: unknown } | undefined)?.tx !== undefined && built !== undefined) lands(built);
    return r;
  });
  const service: GovernedCallService = {
    /* The company's proposals, as a read of who is leaving asks for them: none is a removal here. */
    sealedProposals: async () => [],
    ...served,
    send: kept(landing(served.send, 'propose', (id) => onChain.raised(id)))!,
    approve: kept(landing(served.approve, 'approve', (id) => onChain.approved(id, true)))!,
    cancel: kept(landing(served.cancel, 'cancel', (id) => onChain.withdrawn(id))),
    ...(served.file === undefined ? {} : { file: kept(landing(served.file, 'propose', (id) => onChain.raised(id)))! }),
    standing: kept(served.standing)!,
  };
  const chainSays = over.chainSays ?? onChain.says;
  const holdings = deviceVaultHoldings({
    chain: async (vault) => {
      log.push(`vault read ${vault}`);
      const publicBalances = over.publicBalances ?? [TOKEN, '0'.repeat(64)].map((token) => ({ token, amount: '1000000000' }));
      return { onChain: true, notesFromThisBuild: true, notes: over.chainNotes ?? poolNow().map(committed), publicBalances } as never;
    },
    pool: async () => poolNow(),
    heldCommitmentOf: async (_vault, n) => committed(n),
    paymentsFit: async (notes, payments) => {
      if (over.fitFails) throw over.fitFails;
      return paymentsFitNotes({
        notes: notes.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value.toString(), createdIn: n.createdIn! })),
        payments: payments.map((p) => ({ token: p.token, amount: p.amount.toString() })),
      });
    },
  });
  seams.made = made;
  seams.opens = opensAs({ prp_1: 'cc'.repeat(32), prp_r: 'cd'.repeat(32) });
  seams.filedBy = over.filedBy ?? 'a7'.repeat(32);
  seams.raiseBy = 'raiseBy' in over ? over.raiseBy : RAISE_BY;
  const doors: RaiseDoors = {
    service, holdings, assets: registryWithTestPrivateForms(),
    /* The person's own wallet's read of this file's chain: what it shows of each round the service named. */
    records: {
      roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => {
        const r = lastServed.get(id.toLowerCase());
        return [id.toLowerCase(), r === undefined ? { held: 'never', approvals: 0, approvedHere: false } : chainSays(r)];
      })),
      directory: async () => NOBODY_LEAVING,
    } as unknown as CompanyRecordsHere,
    builder: {
      governedCall: async (input) => {
        log.push(`build ${input.order.circuit} for ${input.account} on ${input.chain.accountState}`);
        proven.set(input.order.circuit, String((input.order as { proposal?: unknown }).proposal));
        if (JSON.stringify(input.material) !== JSON.stringify(material)) throw new Error('not this signer\'s material');
        if (over.buildFails) throw over.buildFails;
        return { tx: `TX-${input.order.circuit}` };
      },
    },
    material, accountId: 'acc_1',
    progress: (s) => log.push(`stage ${s}`),
    sleep: async () => {}, waitMs: 3, everyMs: 1,
    ...(over.straight === undefined ? {} : {
      handOver: over.straight === 'no-wallet' ? { path: 'chain' as const } : {
        path: 'chain' as const,
        /* The person's own wallet: the chain takes the proposal the proven call was built for, as it does a relayed one. */
        toChain: async (tx: string, call: ChainCall) => {
          log.push(`to the chain ${call.kind} ${call.circuit} ${tx} on ${call.contract}`);
          const built = proven.get(call.circuit);
          if (built === undefined) return;
          if (call.circuit === 'propose') onChain.raised(built);
          if (call.circuit === 'approve') onChain.approved(built, true);
          if (call.circuit === 'cancel') onChain.withdrawn(built);
        },
      },
    }),
  };
  return { log, doors, filers };
};

describe('RAISING A LEG FROM THIS DEVICE', () => {
  it('A PROPOSAL WRITTEN DOWN AND NOT YET SENT IS SENT AGAIN AS ITSELF', async () => {
    const again = aDevice();
    await sendRaiseFromDevice(again.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN });
    /* RED WHEN: sending again asks for anything but the proposal already written down and what its vault can pay. */
    expect(again.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'made order run_1', `made leg-payments run_1 {"viewingKey":"vk","asset":"${TOKEN}"}`,
      `vault read ${'99'.repeat(32)}`, `vault read ${'99'.repeat(32)}`,
      'state acc_1', `build propose for ${'ac'.repeat(32)} on AS`,
      `send prp_1 TX-propose ${DEVICE_RAISE_VERSION}`,
    ]);
  });

  it('WHAT IS MADE HERE IS SENT AGAIN ONLY IF IT IS A RAISE OF THE PROPOSAL IT NAMES', async () => {
    /* RED WHEN: sending a written-down proposal again builds an approval of it, named exactly as the proposal. */
    const resend = aDevice({ raiseOrder: async () => ({ ...ORDER, order: { circuit: 'approve', proposal: ORDER.chainId } as never }) });
    await expect(sendRaiseFromDevice(resend.doors, { runId: 'run_1', viewingKey: 'vk' })).rejects.toThrow(/not the proposal it wrote down/u);
    expect(resend.log.filter((l) => l.startsWith('build') || l.startsWith('send'))).toEqual([]);
  });

  it('A RAISE THE SERVICE SAYS THE CHAIN HOLDS, AND THE CHAIN DOES NOT, IS SENT AND NOT SEEN', async () => {
    const d = aDevice({
      standings: [round({ raisedAt: 'now' })], chainSays: () => ({ held: 'never', approvals: 0 }),
      /* The service answers the send itself saying the chain holds it. */
      send: async (id) => round({ id, raisedAt: 'now', txRef: 't1' }),
    });
    /* RED WHEN: the service's word that the chain holds the proposal ends the wait - a person is told it is raised when it is not. */
    await expect(sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN })).rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('A SEND THE CHAIN DOES NOT SHOW IN TIME IS SAID AS SENT AND NOT SEEN, NOT AS A FAILURE TO SEND', async () => {
    /* The chain has not taken the send yet. */
    const d = aDevice({ chainSays: () => ({ held: 'never', approvals: 0 }) });
    const late = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk' }).catch((e) => e);
    /* RED WHEN: a proposal that was sent is reported as not sent - a person then sends it again. */
    expect(late).toBeInstanceOf(SentAndNotYetSeen);
    expect(late.message).toMatch(/was sent and the chain has not shown it yet\. Do not send it again/u);
    expect(nothingWasSentBy(late)).toBe(false);
  });
});

describe('EVERY RELAY CARRIES THIS DEVICE\'S OWN FILING KEY', () => {
  it('a raise, an approval and both withdrawals name the seat this device files under, so the service pays for that seat and no other', async () => {
    const own = signingPublicKeyOf(material.signingSecret as Hex);
    const raised = aDevice();
    await sendRaiseFromDevice(raised.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN });
    const approved = aDevice({ chainSays: () => ({ held: 'open', approvals: 2, raisedAt: 1, approvedHere: false }) });
    await approveOnDevice(approved.doors, { round: round(), viewingKey: 'vk' }).catch(() => undefined);
    const writtenOnly = aDevice({ standings: [round()], filedBy: own });
    await withdrawOnDevice(writtenOnly.doors, { round: round(), viewingKey: 'vk', chainTime: async () => AT_THE_DEADLINE });
    const held = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: { ['cc'.repeat(32)]: 0 }, whileHeld: { raisedHere: true } });
    await withdrawOnDevice(held.doors, { round: round(), viewingKey: 'vk' });
    /* RED WHEN: a relay carries no filing key, or another than this device's own, so the service cannot tell which of the person's seats acts. */
    expect([...raised.filers, ...approved.filers, ...writtenOnly.filers, ...held.filers])
      .toEqual([`send ${own}`, `approve ${own}`, `cancel ${own}`, `cancel ${own}`]);
  });
});

describe('APPROVING FROM THIS DEVICE', () => {
  it('reads the standing first, builds the approval for the proposal\'s chain identity, sends only the proven call, and waits for the chain to hold this seat\'s approval', async () => {
    /* The chain holds the proposal with one approval, and holds this device's a read later than the service answers. */
    const counts = [1, 1, 1, 2];
    let reads = 0;
    const d = aDevice({
      chainSays: () => { const n = counts[Math.min(reads++, counts.length - 1)]!; return { held: 'open', approvals: n, raisedAt: 1, approvedHere: n === 2 }; },
    });
    const done = await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    expect(done.approvalCount).toBe(2);
    /* RED WHEN: the approval carries anything beside the proven call - a signer id, a signature or a key. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build approve for ${'ac'.repeat(32)} on AS`, 'approve prp_1 TX-approve',
      /* RED WHEN: the wait stops before the chain holds this seat's approval. */
      'standing prp_1', 'standing prp_1',
    ]);
  });

  it('a seat whose approval the chain already holds is told so, and nothing is built or sent', async () => {
    const d = aDevice({ chainSays: () => ({ held: 'open', approvals: 1, raisedAt: 1, approvedHere: true }) });
    /* RED WHEN: a raiser's approval of its own counted proposal is built, and the device learns it was counted only from the account's refusal. */
    await expect(approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toBeInstanceOf(ApprovalNotOwed);
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('approve'))).toEqual([]);
  });

  it('a chain read that does not say whether this seat approved builds nothing', async () => {
    const d = aDevice({ chainSays: () => ({ held: 'open', approvals: 1, raisedAt: 1 }) });
    /* RED WHEN: an approval is built on a guess, when the chain was not read for this seat. */
    await expect(approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toThrow(/already counted was not read from the chain/u);
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('approve'))).toEqual([]);
  });

  it('AN APPROVAL IS BUILT ONLY FOR THE PROPOSAL THE PERSON WAS SHOWN', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32) })] });
    /* RED WHEN: the device proves an approval of whatever id the service names now. */
    await expect(approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' }))
      .rejects.toThrow(/another proposal than the one shown here/u);
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('approve'))).toEqual([]);
  });

  it('ANOTHER SIGNER\'S APPROVAL LANDING AFTER THE SEND DOES NOT END THE WAIT: ONLY THIS SEAT\'S ON THE CHAIN DOES', async () => {
    /* Before the send the chain counts one; another signer's approval lands first (two), then this seat's (three). */
    const reads: RoundOnChain[] = [
      { held: 'open', approvals: 1, raisedAt: 1, approvedHere: false },
      { held: 'open', approvals: 2, raisedAt: 1, approvedHere: false },
      { held: 'open', approvals: 3, raisedAt: 1, approvedHere: true },
    ];
    let n = 0;
    const d = aDevice({ chainSays: () => reads[Math.min(n++, reads.length - 1)]! });
    /* RED WHEN: the wait ends at one more than the count before the send, on another signer's approval, before this seat's is on the chain. */
    expect((await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).approvalCount).toBe(3);
    /* RED WHEN: the wait ends on a status the service writes rather than on the chain. */
    const held = (r: RoundOnThePage): RoundOnChain => ({ held: 'open', approvals: r.approvalCount ?? 0, raisedAt: 1, approvedHere: false });
    const named = aDevice({ standings: [round({ approvalCount: 1 }), round({ approvalCount: 2, status: 'approved' })], chainSays: held });
    await expect(approveOnDevice(named.doors, { round: round(), viewingKey: 'vk' })).rejects.toBeInstanceOf(SentAndNotYetSeen);
    const never = aDevice({ standings: [round()], chainSays: held });
    await expect(approveOnDevice(never.doors, { round: round(), viewingKey: 'vk' }))
      .rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('WHETHER THIS SEAT\'S APPROVAL LANDED IS THE CHAIN\'S, NOT THE SERVICE\'S COUNT', async () => {
    /* The service says three throughout; the chain counts one, then two once this seat's approval lands. */
    let reads = 0;
    const d = aDevice({
      standings: [round({ approvalCount: 3 }), round({ approvalCount: 3 })],
      chainSays: () => { reads += 1; return { held: 'open', approvals: reads === 1 ? 1 : 2, raisedAt: 1, approvedHere: reads > 1 }; },
    });
    /* RED WHEN: the approval is taken from the service's count. */
    expect((await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).approvalCount).toBe(2);
  });

  it('THE APPROVALS COUNTED, BEFORE AND AFTER, ARE THE CHAIN\'S, NEVER THE COUNT THE SERVICE ANSWERS WITH', async () => {
    /* The chain holds the proposal with one approval throughout; the service answers that it counts three. */
    const one = (): RoundOnChain => ({ held: 'open', approvals: 1, raisedAt: 1, approvedHere: false });
    const d = aDevice({ standings: [round({ approvalCount: 1 }), round({ approvalCount: 3 })], chainSays: one });
    /* RED WHEN: the wait ends on the service's count - a device then says approved what the chain has not counted. */
    await expect(approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('A SERVICE REFUSAL KEEPS ITS OWN MARK OF WHETHER ANYTHING WAS SENT', async () => {
    const calls: string[] = [];
    const api = async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`);
      if (path.endsWith('/approve')) throw new Error('this seat may not approve. Nothing was sent.');
      if (path.endsWith('/send')) throw new Error('the node dropped the connection');
      return {};
    };
    const service = governedCallServiceFor(api);
    /* RED WHEN: the mark is dropped - a refusal then reads as maybe sent, and a failure at the send as nothing sent. */
    expect(nothingWasSentBy(await service.approve('p 1', { tx: 'T', filer: 'F' }).catch((e) => e))).toBe(true);
    expect(nothingWasSentBy(await service.send('p 1', { tx: 'T', version: DEVICE_RAISE_VERSION, filer: 'F' }).catch((e) => e))).toBe(false);
    await service.callState('acc 1');
    await service.standing('p 1');
    await service.cancel!('p 1', { filer: 'F' });
    await service.cancel!('p 1', { tx: 'T', filer: 'F' });
    await service.carry!('p 1', { tx: 'T', circuit: 'setThreshold', filer: 'F' });
    /* RED WHEN: a relay names a route the service no longer has, carries a secret or a signature, drops its filing key, or an id is not escaped. */
    expect(calls).toEqual([
      'POST /api/proposals/p%201/approve {"tx":"T","filer":"F"}',
      `POST /api/proposals/p%201/send {"tx":"T","version":${DEVICE_RAISE_VERSION},"filer":"F"}`,
      'GET /api/accounts/acc%201/call-state ',
      'POST /api/proposals/p%201/standing {}',
      'POST /api/proposals/p%201/cancel {"filer":"F"}',
      'POST /api/proposals/p%201/cancel {"tx":"T","filer":"F"}',
      'POST /api/proposals/p%201/carry {"tx":"T","circuit":"setThreshold","filer":"F"}',
    ]);
    expect(calls.join('\n')).not.toMatch(/viewingKey|signature|signerId/u);
  });
});

describe('THE VAULT\'S MONEY, PRIVATE AND PUBLIC, IS ASKED ON THIS DEVICE BEFORE A RAISE WRITTEN DOWN IS SENT', () => {
  /* A leg's raise written down and not yet sent; a first raise is checked the same way where it is made (`run-raised-here.ts`). */
  const RAISE = { runId: 'run_1', viewingKey: 'vk', asset: TOKEN };
  const serviceCalls = (log: string[]) => log.filter((l) => /^(raise|send|state|approve|standing) /u.test(l));

  it('1. A RUN THE POOL CANNOT PAY IS REFUSED HERE, AND NOTHING IS BUILT OR SENT', async () => {
    const short = aDevice({ pool: [note(1, 15_000n)] });
    const refused = await sendRaiseFromDevice(short.doors, RAISE).catch((e) => e);
    /* RED WHEN: the device check is gone, or runs after the raise - the company then writes down a run the vault cannot pay. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(refused?.held).toBe(15_000n);
    expect(refused?.asked).toBe(30_000n);
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(serviceCalls(short.log)).toEqual([]);

    /* Enough in total, and no two notes can make the second payment: a question about notes, not a sum. */
    const split = aDevice({
      pool: [note(1, 20_000n), note(2, 4_000n), note(3, 4_000n), note(4, 4_000n)],
      legPayments: async () => ({ asset: TOKEN, payments: [0, 1].map(() => ({ kind: 'shielded', token: TOKEN, amount: '15000' })) }),
      raiseOrder: async () => orderPaying([0, 1].map(() => ({ kind: 'shielded', token: TOKEN, amount: '15000' }))),
    });
    const unfit = await sendRaiseFromDevice(split.doors, RAISE).catch((e) => e);
    /* RED WHEN: the notes are not walked payment by payment - the run is raised and stops halfway on payday. */
    expect(unfit?.why).toBe('does-not-fit');
    expect(String(unfit?.message)).toMatch(/payment 2 of 2 cannot be made out of this vault/u);
    expect(serviceCalls(split.log)).toEqual([]);
  });

  it('2. A POOL THAT DISAGREES WITH THE CHAIN IS NAMED AS A DISAGREEMENT, NEVER READ AS A BALANCE', async () => {
    for (const [why, chainNotes] of [
      ['a recorded note the chain does not hold', ['c' + 'f'.repeat(63)]],
    ] as const) {
      const d = aDevice({ chainNotes: [...chainNotes] });
      const refused = await sendRaiseFromDevice(d.doors, RAISE).catch((e) => e);
      /* RED WHEN: the pool is summed without being compared with the chain, in either direction. */
      expect(refused?.why, why).toBe('contradicted');
      expect(String(refused?.message), why).toMatch(/disagrees with the chain/u);
      expect(serviceCalls(d.log), why).toEqual([]);
    }
  });

  it('2b. A NOTE THE CHAIN HOLDS THAT NOTHING HERE NAMES IS IGNORED: THE RAISE GOES AHEAD ON THE NOTES THE POOL HOLDS', async () => {
    /* A stranger's deposit. RED WHEN: it is read as a disagreement - one deposit would then stop every run from this vault. */
    const d = aDevice({ chainNotes: [...PLENTY.map(committed), 'c' + 'f'.repeat(63)], standings: [round({ raisedAt: 'now' })] });
    /* When the chain first held it is the time of that block, never a time the service wrote. */
    expect((await sendRaiseFromDevice(d.doors, RAISE)).raisedAt).toBe(new Date(1).toISOString());
  });

  it('A PUBLIC PAYMENT IS ASKED ON THIS DEVICE TOO, SINCE THE COMPANY NO LONGER ASKS IT, AND REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const PUBLIC = '0'.repeat(64);
    const pays = [{ kind: 'unshielded', token: PUBLIC, amount: '5' }];
    const asked: string[] = [];
    const short = aDevice({
      publicBalances: [{ token: PUBLIC, amount: '4' }],
      legPayments: async (runId, body) => { asked.push(`${runId} ${JSON.stringify(body)}`); return { asset: PUBLIC, payments: pays }; },
      raiseOrder: async () => orderPaying(pays, PUBLIC),
    });
    const refused = await sendRaiseFromDevice(short.doors, { ...RAISE, asset: PUBLIC }).catch((e) => e);
    /* RED WHEN: a raise sent again checks private money only, so a public leg the vault cannot pay is sent and refused at payout. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(serviceCalls(short.log)).toEqual([]);
    expect(asked).toEqual([`run_1 {"viewingKey":"vk","asset":"${PUBLIC}"}`]);
    /* RED WHEN: a public leg the vault holds enough for publicly is refused here. */
    const d = aDevice({ standings: [round({ raisedAt: 'now' })], legPayments: async () => ({ asset: PUBLIC, payments: pays }), raiseOrder: async () => orderPaying(pays, PUBLIC) });
    expect((await sendRaiseFromDevice(d.doors, { ...RAISE, asset: PUBLIC })).raisedAt).toBe(new Date(1).toISOString());
    expect(d.log.indexOf('stage checking-the-vault')).toBeLessThan(d.log.indexOf('stage building'));
  });

  it('THE PRIVATE HALF OF A RUN THAT ALSO PAYS PUBLICLY IS STILL ASKED HERE', async () => {
    /* A run paying TOKEN both ways is two legs side by side; raising its private leg names the token and the form. */
    const asked: string[] = [];
    const mixed = aDevice({
      pool: [note(1, 5_000n)],
      legPayments: async (runId, body) => {
        asked.push(`${runId} ${JSON.stringify(body)}`);
        return { asset: TOKEN, form: 'shielded', payments: [{ kind: 'shielded', token: TOKEN, amount: '10000' }] };
      },
      raiseOrder: async () => orderPaying([{ kind: 'shielded', token: TOKEN, amount: '10000' }]),
    });
    const refused = await sendRaiseFromDevice(mixed.doors, { ...RAISE, form: 'shielded' }).catch((e) => e);
    /* RED WHEN: a leg with any public payment skips the device check - its private half is then checked nowhere. */
    expect(refused?.why).toBe('short');
    expect(refused?.form).toBe('shielded');
    expect(serviceCalls(mixed.log)).toEqual([]);
    /* RED WHEN the form is not sent beside the token, so the company cannot tell which of the run's two legs is raised. */
    expect(asked).toEqual([`run_1 {"viewingKey":"vk","asset":"${TOKEN}","form":"shielded"}`]);
  });

  it('WHAT THE COMPANY SAYS THE LEG PAYS IS CHECKED FOR BEING THIS LEG, AND FOR A SHAPE THIS DEVICE CAN READ', async () => {
    for (const [why, answer, says] of [
      /* A leg the device could pass on its own terms, so only the asset being another's refuses it. */
      ['another asset\'s leg', { asset: '0'.repeat(64), payments: [{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }] }, /Nothing was sent for approval and no fee was spent\.$/u],
      ['a kind that is neither private nor public', { asset: TOKEN, payments: [{ kind: 'Shielded', token: TOKEN, amount: '10000' }] }, /Nothing was raised and no fee was spent/u],
      ['an amount that is not a whole number', { asset: TOKEN, payments: [{ kind: 'shielded', token: TOKEN, amount: '1e4' }] }, /Nothing was raised and no fee was spent/u],
    ] as const) {
      const d = aDevice({ legPayments: async () => answer as LegPaymentsOnTheWire });
      /* RED WHEN: the device checks payments other than the leg being raised, or skips one it cannot read. */
      await expect(sendRaiseFromDevice(d.doors, RAISE), why).rejects.toThrow(says);
      expect(serviceCalls(d.log), why).toEqual([]);
    }
    /* RED WHEN the private leg of a run is checked with the public leg's payments, or the refusal names a token rather than its symbol. */
    const otherForm = aDevice({ legPayments: async () => ({ asset: TOKEN, form: 'unshielded', payments: [{ kind: 'unshielded', token: TOKEN, amount: '5' }] }) });
    const refused = await sendRaiseFromDevice(otherForm.doors, { ...RAISE, form: 'shielded' }).catch((e) => e);
    /* RED WHEN the refusal stops saying in plain words which payments came back, which were asked for, and that nothing was sent or spent. */
    expect(String(refused?.message)).toBe('The service returned the public tPAY payments when the private tPAY payments were asked for. '
      + 'Nothing was sent for approval and no fee was spent.');
    expect(serviceCalls(otherForm.log)).toEqual([]);
  });

  it('A FAILURE TO ASK IS NOT SAID AS MONEY SHORT', async () => {
    const d = aDevice({ fitFails: new Error('the part of this page that builds vault transactions did not start.') });
    const refused = await sendRaiseFromDevice(d.doors, RAISE).catch((e) => e);
    /* RED WHEN: any error from the walk becomes "deposit more" - a person then moves money to fix a page that did not load. */
    expect(refused?.why).toBe('failed');
    expect(String(refused?.message)).not.toMatch(/Deposit/u);
    expect(serviceCalls(d.log)).toEqual([]);
  });

  it('6. NOTHING THIS DEVICE SENDS THE COMPANY CARRIES A NOTE, THE POOL OR A BALANCE', async () => {
    /* Values that appear nowhere but in this vault's pool, so any of them reaching a body is a leak. */
    const secretNotes = [note(0xabc, 987_654_321n), note(0xdef, 123_456_789n)];
    const bodies: string[] = [];
    const d = aDevice({
      pool: secretNotes,
      standings: [round({ raisedAt: 'now' })],
      send: async (id, body) => { bodies.push(JSON.stringify({ id, ...body })); return round({ txRef: 't1' }); },
      callState: async (id) => { bodies.push(id); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
      standing: async (id) => { bodies.push(JSON.stringify({ id })); return round({ raisedAt: 'now' }); },
    });
    await sendRaiseFromDevice(d.doors, RAISE);
    const vaultReads = d.log.filter((l) => l.startsWith('vault read'));
    const sent = [...bodies, ...vaultReads].join('\n');
    /* RED WHEN: a note, its nonce, its value, the pool's total or anything the pool holds reaches the company. */
    for (const n of secretNotes) {
      expect(sent).not.toContain(n.nonce);
      expect(sent).not.toContain(n.nonce.replace(/^0+/u, ''));
      expect(sent).not.toContain(n.value.toString());
      expect(sent).not.toContain(committed(n));
    }
    expect(sent).not.toContain((987_654_321n + 123_456_789n).toString());
    expect(sent).not.toMatch(/notes|nonce|pool|balance|held/u);
    /* And the send carries only the version and its seat's public filing key beside the proven transaction: no secret, and nothing the vault was checked with. */
    const sendBody = bodies.map((b) => JSON.parse(b.startsWith('{') ? b : '{}')).find((b) => 'tx' in b);
    expect(Object.keys(sendBody).sort()).toEqual(['filer', 'id', 'tx', 'version']);
    expect(vaultReads).toEqual(Array(2).fill(`vault read ${'99'.repeat(32)}`));
  });

  it('A PAGE THAT CAN READ NEITHER THE COMPANY\'S RECORDS NOR WHAT IS MADE FROM THEM BUILDS NOTHING', async () => {
    const d = aDevice();
    const { records: _r, ...unread } = d.doors;
    /* RED WHEN: a raise is built or sent from anything but what this device made from the company's records. */
    await expect(sendRaiseFromDevice(unread, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN })).rejects.toThrow(/cannot read the company's records/u);
    expect(d.log.filter((l) => /^(build|send)/u.test(l))).toEqual([]);
  });

  it('ASKS THE COMPANY FOR NOTHING A RAISE, A RETRY OR A SEAT IS BUILT FROM: THOSE ARE MADE HERE', () => {
    const service = governedCallServiceFor(async () => ({})) as unknown as Record<string, unknown>;
    /* RED WHEN: the page asks the company's service again for a leg's payments, a written-down order, or what carries out a seat. */
    for (const gone of ['legPayments', 'raiseOrder', 'retryPayments', 'retryOrder', 'seatOrder', 'thresholdOrder']) {
      expect(service[gone], gone).toBeUndefined();
    }
  });
});

describe('EVERY SEND IS CHECKED AGAINST THE VAULT ON THIS DEVICE FIRST, AND SAYS WHICH PAGE CHECKED WHAT', () => {
  const builtOrSent = (log: string[]) => log.filter((l) => /^(state|build|send) /u.test(l));

  it('4. A SEND AGAIN OF A WRITTEN-DOWN PROPOSAL CHECKS THE VAULT FIRST, AND A VAULT THAT CAN NO LONGER PAY IS REFUSED BEFORE ANYTHING IS BUILT OR SENT', async () => {
    const d = aDevice({ pool: [note(1, 29_999n)] });
    const refused = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN }).catch((e) => e);
    /* RED WHEN: a send again goes out on the check made when the proposal was written down, days before. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(builtOrSent(d.log)).toEqual([]);
    /* The vault asked about is the one the written-down proposal names, and it is asked before the chain is read. */
    expect(d.log.filter((l) => !l.startsWith('stage')).slice(0, 2)).toEqual(['made order run_1', `made leg-payments run_1 {"viewingKey":"vk","asset":"${TOKEN}"}`]);
    expect(d.log).toContain(`vault read ${ORDER.order.run.vault}`);
    expect(d.log).toContain('stage checking-the-vault');
  });

  it('4c. THE SEND NAMES THIS PAGE\'S VERSION, AND GOES ONLY WHEN THE PROPOSAL WRITTEN DOWN PAYS EXACTLY WHAT THIS CHECK WAS HANDED', async () => {
    /* A public leg of the same token and amount as a private one, so the kind is part of what is compared at this call site. */
    const other: LegPaymentsOnTheWire = { asset: TOKEN, form: 'unshielded', payments: [{ kind: 'unshielded', token: TOKEN, amount: '12345' }] };
    const bodies: Array<{ tx: string; version: number }> = [];
    const d = aDevice({
      standings: [round({ raisedAt: 'now' })],
      legPayments: async () => other,
      raiseOrder: async () => orderPaying(other.payments),
      send: async (_id, body) => { bodies.push(body); return round({ txRef: 't1' }); },
    });
    await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN, form: 'unshielded' });
    /* RED WHEN: the send carries no version, or a stale one. */
    expect(bodies).toEqual([{ tx: 'TX-propose', version: DEVICE_RAISE_VERSION, filer: signingPublicKeyOf(material.signingSecret as Hex) }]);
    /* RED WHEN: a proposal written down for the same amounts of the other kind is sent on this check. */
    const kindSwapped = aDevice({
      legPayments: async () => other,
      raiseOrder: async () => orderPaying([{ kind: 'shielded', token: TOKEN, amount: '12345' }]),
    });
    await expect(sendRaiseFromDevice(kindSwapped.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN, form: 'unshielded' }))
      .rejects.toThrow(WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED);
    expect(builtOrSent(kindSwapped.log)).toEqual([]);
  });
});

describe('A RETRY WRITTEN DOWN IS SENT FROM THIS DEVICE, WITH THE VAULT CHECKED FOR EXACTLY THE RETRY', () => {
  /* A retry's first raise is made where it is raised (`run-raised-here.ts`); what is sent again is checked here the same way. */
  const RETRY = { runId: 'run_1', viewingKey: 'vk', asset: TOKEN, proposalId: 'prp_r' };
  const serviceCalls = (log: string[]) => log.filter((l) => /^(retry|send|state|build|standing) /u.test(l));

  it('4. A RETRY THE VAULT CANNOT PAY IS REFUSED ON THIS DEVICE BEFORE ANYTHING IS BUILT OR SENT', async () => {
    /* Enough for one of the two people this retry pays, and not for both. */
    const short = aDevice({ pool: [note(1, 15_000n)] });
    const refused = await sendRetryFromDevice(short.doors, RETRY).catch((e) => e);
    /* RED WHEN: the device check is skipped for a retry sent again. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(refused?.asked).toBe(20_000n);
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(serviceCalls(short.log)).toEqual([]);
  });

  it('A RETRY SENT AGAIN IS CHECKED AGAINST THE VAULT FOR THE PEOPLE IT WAS WRITTEN DOWN WITH', async () => {
    const d = aDevice();
    await sendRetryFromDevice(d.doors, RETRY);
    /* RED WHEN: sending a retry again checks anything but the people the written-down retry pays. */
    expect(d.log.filter((l) => !l.startsWith('stage') && !l.startsWith('vault read'))).toEqual([
      'made retry-order run_1 prp_r', `made retry-payments run_1 {"viewingKey":"vk","asset":"${TOKEN}","indices":[1,2]}`,
      'state acc_1', `build propose for ${'ac'.repeat(32)} on AS`,
      `send prp_r TX-propose ${DEVICE_RAISE_VERSION}`,
    ]);
    /* RED WHEN: the leg's payments are checked instead of the retry's. */
    expect(d.log.filter((l) => l.startsWith('made leg-payments'))).toEqual([]);
  });

  it('A PUBLIC RETRY SENT AGAIN IS ASKED OF THE VAULT\'S PUBLIC MONEY ON THIS DEVICE', async () => {
    const PUBLIC = '0'.repeat(64);
    const pays = [{ kind: 'unshielded', token: PUBLIC, amount: '7' }, { kind: 'unshielded', token: PUBLIC, amount: '8' }];
    const d = aDevice({
      publicBalances: [{ token: PUBLIC, amount: '14' }],
      retryPayments: async () => ({ asset: PUBLIC, payments: pays }),
      retryOrder: async () => ({ ...RETRY_ORDER, pays: paysFor(pays, PUBLIC) }),
    });
    const refused = await sendRetryFromDevice(d.doors, { ...RETRY, asset: PUBLIC }).catch((e) => e);
    /* RED WHEN: a retry sent again checks private money only, so its public payments go to the chain unasked. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(serviceCalls(d.log)).toEqual([]);
  });

  it('6. NOTHING A RETRY SENT FROM THIS DEVICE CARRIES TO THE COMPANY IS A NOTE, THE POOL OR A BALANCE', async () => {
    const d = aDevice({ standings: [round({ id: 'prp_r', raisedAt: 'now' })] });
    await sendRetryFromDevice(d.doors, RETRY);
    const toTheCompany = d.log.filter((l) => /^(retry|send|standing) /u.test(l)).join('\n');
    /* RED WHEN: a retry's request gains a note, the pool, a balance or the vault's holdings. */
    for (const n of PLENTY) {
      expect(toTheCompany).not.toContain(n.nonce);
      expect(toTheCompany).not.toContain(n.value.toString());
    }
    expect(toTheCompany).not.toMatch(/nonce|pool|balance|held|notes/u);
  });
});

describe('WITHDRAWING A PROPOSAL FROM THIS DEVICE', () => {
  const own = signingPublicKeyOf(material.signingSecret as Hex);
  const HELD = { ['cc'.repeat(32)]: 0 };
  const sentFrom = (d: ReturnType<typeof aDevice>) => d.log.filter((l) => /^(state|build|cancel)/u.test(l));
  const refusedFor = async (d: ReturnType<typeof aDevice>, why: WithdrawalStop, input: Partial<Parameters<typeof withdrawOnDevice>[1]> = {}) => {
    const e = await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk', ...input }).then(() => null, (x: unknown) => x);
    expect((e as { name?: string; why?: string } | null)?.name).toBe('WithdrawalRefused');
    expect((e as { why?: string }).why).toBe(why);
    expect(nothingWasSentBy(e)).toBe(true);
    /* Refused before anything is built or sent. */
    expect(sentFrom(d)).toEqual([]);
  };

  it('one the chain does not hold, written down by this seat, is marked withdrawn in the records with no call once its raise can no longer land, and is never reported withdrawn', async () => {
    const d = aDevice({ standings: [round()], filedBy: own });
    const done = await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk', chainTime: async () => AT_THE_DEADLINE });
    /* RED WHEN: a proposal is reported withdrawn on the service's word that no raise of it was sent, which a raise it held could still undo. */
    expect([done.status, done.withdrawal]).toEqual(['cancelled', 'records-withdrawn-not-on-chain']);
    /* RED WHEN: a proposal the chain never held is withdrawn by a proven call, or not withdrawn at all. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual(['standing prp_1', 'cancel prp_1 {}']);
  });

  it('one the chain does not hold, written down by this seat, is refused while a raise of it may still land, by the chain\'s time', async () => {
    const before = aDevice({ standings: [round()], filedBy: own });
    /* RED WHEN: a proposal the chain does not show is marked withdrawn while a raise sent before its deadline may still open it. */
    await refusedFor(before, 'may-still-land', { chainTime: async () => AT_THE_DEADLINE - 1 });
    const e = await withdrawOnDevice(aDevice({ standings: [round()], filedBy: own }).doors, {
      round: round(), viewingKey: 'vk', chainTime: async () => AT_THE_DEADLINE - 1,
    }).then(() => null, (x: unknown) => x as Error);
    /* RED WHEN: the refusal does not say until when a raise may still land. */
    expect(e?.message).toContain(`until ${new Date(AT_THE_DEADLINE).toISOString()}, by the chain's time`);
    /* RED WHEN: the deadline is judged on this device's clock when the chain's time is not read. */
    await refusedFor(aDevice({ standings: [round()], filedBy: own }), 'chain-time-not-read', { chainTime: async () => { throw new Error('unread'); } });
    const unread = aDevice({ standings: [round()], filedBy: own, raiseBy: undefined });
    /* RED WHEN: a proposal whose record names no deadline is marked withdrawn with nothing to judge it by. */
    await expect(withdrawOnDevice(unread.doors, { round: round(), viewingKey: 'vk', chainTime: async () => AT_THE_DEADLINE }))
      .rejects.toThrow(/does not say when it was written down/u);
    expect(unread.log.filter((l) => /^(state|build|cancel)/u.test(l))).toEqual([]);
  });

  it('one the chain did not hold when first read is not withdrawn if the chain holds it once its time is read past the deadline', async () => {
    let reads = 0;
    const landed = aDevice({
      standings: [round()], filedBy: own,
      chainSays: () => (reads++ === 0 ? { held: 'never', approvals: 0 } : { held: 'open', approvals: 0, raisedAt: 1, raisedHere: true }),
    });
    const e = await withdrawOnDevice(landed.doors, { round: round(), viewingKey: 'vk', chainTime: async () => AT_THE_DEADLINE })
      .then(() => null, (x: unknown) => x as Error);
    /* RED WHEN: where the chain stands is judged only from a read made before its time, so a raise that landed between the two is withdrawn in the records while the chain holds it. */
    expect(e?.message).toMatch(/the chain now shows this proposal/u);
    expect(landed.log.filter((l) => /^(state|build|cancel)/u.test(l))).toEqual([]);
    expect(reads).toBe(2);
  });

  it('one only written down by another seat is refused before anything is sent', async () => {
    /* RED WHEN: any signer can have the company's records mark another signer's proposal withdrawn before it is sent. */
    await refusedFor(aDevice({ standings: [round()] }), 'filed-by-another');
  });

  it('one the service says was sent, and the chain does not hold, is refused: it may still arrive', async () => {
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], chainSays: () => ({ held: 'never', approvals: 0 }), filedBy: own });
    /* RED WHEN: a proposal on its way to the chain is marked withdrawn in the company's records, and then lands open. */
    await refusedFor(d, 'sent-not-yet-seen');
  });

  it('one the service says was sent, and the chain does not hold, is marked withdrawn once the chain\'s time passes its deadline', async () => {
    const sentOnce = () => aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], chainSays: () => ({ held: 'never', approvals: 0 }), filedBy: own });
    /* RED WHEN: a raise the service says it sent is given up on before the chain's time reaches its deadline, while it may still land. */
    await refusedFor(sentOnce(), 'sent-not-yet-seen', { chainTime: async () => AT_THE_DEADLINE - 1 });
    const d = sentOnce();
    const done = await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk', chainTime: async () => AT_THE_DEADLINE });
    /* RED WHEN: a raise that can never land any more keeps its record waiting for good on the service's word that it was sent. */
    expect([done.status, done.withdrawal]).toEqual(['cancelled', 'records-withdrawn-not-on-chain']);
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual(['standing prp_1', 'cancel prp_1 {}']);
    /* RED WHEN: past its deadline, another seat's record is marked withdrawn by this one. */
    await refusedFor(aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], chainSays: () => ({ held: 'never', approvals: 0 }) }),
      'filed-by-another', { chainTime: async () => AT_THE_DEADLINE });
  });

  it('a change to the company the chain holds is withdrawn by the cancel this device proves, and the outcome is the chain\'s', async () => {
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { raisedHere: true } });
    const done = await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    /* RED WHEN: the withdrawal of a held proposal is sent with no proven call, or proves anything but a cancel. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build cancel for ${'ac'.repeat(32)} on AS`, 'cancel prp_1 {"tx":"TX-cancel"}',
    ]);
    /* RED WHEN: the outcome is taken from the service's answer rather than from the chain no longer holding it. */
    expect([done.status, done.withdrawal]).toEqual(['cancelled', 'withdrawn']);
  });

  it('a removal whose leaving seat is already written down as retired is refused before any build', async () => {
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { raisedHere: true } });
    seams.opens = async () => ({ chainId: 'cc'.repeat(32), digest: '', vault: '', salt: '', summary: '', kind: 'remove-signer', removes: 'a4'.repeat(32) });
    let leaving: { seat: string; retired: unknown } = { seat: 'a4'.repeat(32), retired: { at: 1 } };
    const read = { ...d.doors, records: { ...d.doors.records!, directory: async () => ({ ...NOBODY_LEAVING, dir: { seats: [leaving] } }) } as never };
    /* RED WHEN: a removal is withdrawn after its retirement is filed, leaving the directory retired and the chain seated, so every later change is refused. */
    await refusedFor({ ...d, doors: read }, 'retirement-filed');
    leaving = { ...leaving, retired: null };
    expect((await withdrawOnDevice(read, { round: round(), viewingKey: 'vk' })).withdrawal).toBe('withdrawn');
  });

  it('a change to the company raised by another seat is refused before any build', async () => {
    /* RED WHEN: a signer who did not raise a change builds a withdrawal the chain refuses, paying its fee for nothing. */
    await refusedFor(aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { raisedHere: false } }), 'not-raised-here');
    /* RED WHEN: who raised it is guessed when the chain was not read for it. */
    await refusedFor(aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD }), 'raiser-not-read');
  });

  it('a run is withdrawn by any signer before its time to be paid begins, and refused from then on', async () => {
    const before = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { opensAt: 2_000, raisedHere: false } });
    /* RED WHEN: a run raised by another signer cannot be withdrawn before its window opens, as the chain allows. */
    expect((await withdrawOnDevice(before.doors, { round: round(), viewingKey: 'vk', chainTime: async () => 1_999_000 })).withdrawal).toBe('withdrawn');
    /* RED WHEN: a run whose window has opened is built into a withdrawal the chain refuses. */
    await refusedFor(aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { opensAt: 2_000, raisedHere: true } }),
      'started', { chainTime: async () => 2_000_000 });
  });

  it('whether a run\'s time to be paid has begun is judged by the chain\'s newest block, never by this device\'s clock', async () => {
    const DEVICE_NOW = Date.now();
    const atTheChain = (opensAt: number) => aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { opensAt, raisedHere: true } });
    const behind = DEVICE_NOW - 3_600_000;
    /* RED WHEN: a run the chain still lets anyone withdraw is refused because this device's clock is ahead of the chain. */
    expect((await withdrawOnDevice(atTheChain(Math.floor(DEVICE_NOW / 1000) - 600).doors, { round: round(), viewingKey: 'vk', chainTime: async () => behind }))
      .withdrawal).toBe('withdrawn');
    /* RED WHEN: a run whose time the chain has begun is built into a withdrawal because this device's clock is behind the chain. */
    await refusedFor(atTheChain(Math.floor(DEVICE_NOW / 1000) + 600), 'started', { chainTime: async () => DEVICE_NOW + 3_600_000 });
  });

  it('a run is not withdrawn when the chain\'s time cannot be read, and this device\'s clock is never asked instead', async () => {
    const run = () => aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { opensAt: 4_000_000_000, raisedHere: true } });
    /* RED WHEN: a run is withdrawn on this device's clock when nothing read the chain's time. */
    await refusedFor(run(), 'chain-time-not-read');
    /* RED WHEN: a failed read of the chain's time is taken as a time, or falls back to this device's clock. */
    await refusedFor(run(), 'chain-time-not-read', { chainTime: async () => { throw new Error('the indexer answered 502.'); } });
    for (const bad of [0, -1, Number.NaN, 1.5]) await refusedFor(run(), 'chain-time-not-read', { chainTime: async () => bad });
  });

  it('a run whose time has begun is told by where it stands: short of its approvals, able to be paid, or already charged', async () => {
    const started = (whileHeld: Partial<RoundOnChain>) => aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { opensAt: 2_000, raisedHere: true, ...whileHeld } });
    const at = { chainTime: async () => 2_000_000 };
    /* RED WHEN: a run that cannot be paid without more approvals is told as one that may be paid now. */
    await refusedFor(started({ approvals: 1, needed: 2 }), 'started', at);
    /* RED WHEN: a run with the approvals it was raised needing is told to be left unapproved, when it can be paid now and only a hold stops it. */
    await refusedFor(started({ approvals: 2, needed: 2 }), 'started-may-be-paid', at);
    /* RED WHEN: a run whose count of needed approvals was not read is told it cannot be paid. */
    await refusedFor(started({ approvals: 1 }), 'started-may-be-paid', at);
    /* RED WHEN: a run charged to its period is told it can still be held. */
    await refusedFor(aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], chainSays: () => ({ held: 'cleared', approvals: 2, raisedAt: 1, needed: 2, opensAt: 2_000 }) }),
      'started-charged');
  });

  it('a run the chain would still take a withdrawal of, refused by this device\'s own build on its clock, is told as that clock being ahead', async () => {
    const STARTED = new Error('this withdrawal could not be built on this device: that run has already started; it can no longer be cancelled. Nothing was proved or sent.');
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { opensAt: 2_000, raisedHere: true }, buildFails: STARTED });
    const e = await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk', chainTime: async () => 1_999_000 }).then(() => null, (x: unknown) => x);
    /* RED WHEN: a run the chain would still take a withdrawal of is told as started, because the build judged it on this device's clock. */
    expect([(e as { name?: string })?.name, (e as { why?: string })?.why, nothingWasSentBy(e)]).toEqual(['WithdrawalRefused', 'clock-ahead', true]);
    expect(d.log.filter((l) => l.startsWith('cancel'))).toEqual([]);
    const other = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { opensAt: 2_000, raisedHere: true }, buildFails: new Error('the prover is down') });
    /* RED WHEN: any failure to build a run's withdrawal is blamed on this device's clock. */
    await expect(withdrawOnDevice(other.doors, { round: round(), viewingKey: 'vk', chainTime: async () => 1_999_000 })).rejects.toThrow(/the prover is down/u);
  });

  it('a change to the company has no time to be paid, so its withdrawal never reads the chain\'s time', async () => {
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { raisedHere: true } });
    let asked = 0;
    /* RED WHEN: a change to the company is refused, or waits on a read it does not need, when the chain's time is not read. */
    expect((await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk', chainTime: async () => { asked += 1; throw new Error('unread'); } })).withdrawal)
      .toBe('withdrawn');
    expect(asked).toBe(0);
  });

  it('one the chain has closed is refused, and the kind the caller checks is refused before any build', async () => {
    await refusedFor(aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], chainSays: () => ({ held: 'closed', approvals: 0, raisedAt: 1, closedBy: ['setThreshold'] }) }), 'closed');
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { raisedHere: true } });
    const seen: string[] = [];
    const refused = await withdrawOnDevice(d.doors, {
      round: round(), viewingKey: 'vk', check: (_o, c) => { seen.push(c.held); throw new Error('not this kind'); },
    }).then(() => null, (e: unknown) => e);
    /* RED WHEN: the caller's own refusal of the kind opened is run after the withdrawal is built, or not at all. */
    expect([String((refused as Error).message), seen]).toEqual(['not this kind', ['open']]);
    expect(sentFrom(d)).toEqual([]);
  });

  it('a close the chain shows beside another closing call in its block is told plainly as either, and one with no withdrawal as closed otherwise', async () => {
    const beside = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { raisedHere: true }, closedBy: ['cancel', 'setThreshold'] });
    /* RED WHEN: a block holding the withdrawal and another proposal's carrying out is read as this withdrawal for certain. */
    expect((await withdrawOnDevice(beside.doors, { round: round(), viewingKey: 'vk' })).withdrawal).toBe('withdrawn-or-closed');
    const other = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD, whileHeld: { raisedHere: true }, closedBy: ['setThreshold'] });
    /* RED WHEN: a proposal carried out before the withdrawal landed is reported withdrawn. */
    expect((await withdrawOnDevice(other.doors, { round: round(), viewingKey: 'vk' })).withdrawal).toBe('closed-otherwise');
  });

  it('a withdrawal the chain does not show taken is reported as sent and not yet seen', async () => {
    const d = aDevice({
      standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: HELD,
      chainSays: () => ({ held: 'open', approvals: 0, raisedAt: 1, raisedHere: true }),
    });
    /* RED WHEN: a withdrawal sent is reported done before the chain stops holding the proposal. */
    await expect(withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('a proposal the company now names differently is not withdrawn, and a page with no withdrawal says so', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32), raisedAt: 'then' })] });
    /* RED WHEN: the device withdraws whatever the service names now under the id the page showed. */
    await expect(withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toThrow(/another proposal than/u);
    expect(d.log.filter((l) => /^(build|cancel)/u.test(l))).toEqual([]);
    const old = aDevice();
    const { cancel: _c, ...noCancel } = old.doors.service;
    /* RED WHEN: a page without the relay sends a withdrawal some other way. */
    await expect(withdrawOnDevice({ ...old.doors, service: noCancel }, { round: round(), viewingKey: 'vk' }))
      .rejects.toThrow(/cannot withdraw proposals/u);
  });
});

describe('A PROPOSAL STANDS WHERE THE CHAIN SAYS, NEVER WHERE THE SERVICE ANSWERS: A LEG AND A RETRY RAISED HERE', () => {
  const NEVER: RoundOnChain = { held: 'never', approvals: 0 };
  const HELD: RoundOnChain = { held: 'open', approvals: 0, raisedAt: 1 };
  const LEG_RAISE = { runId: 'run_1', viewingKey: 'vk', vault: VAULT, opensAt: '1', closesAt: '2' };
  const RETRY_RAISE = { ...LEG_RAISE, indices: [1, 2] };
  /* The company's answer to the raise this device filed with its proven call. */
  const filedWith = (d: ReturnType<typeof aDevice>) => () =>
    d.doors.service.file!('acc_1', { proposal: {} as never, tx: 'TX-propose', version: DEVICE_RAISE_VERSION, salt: SALT });

  it('a leg raised from this device is raised only when the chain holds it, whatever the service answers', async () => {
    const claimed = aDevice({ file: async () => round({ raisedAt: 'now', txRef: 't1' }), chainSays: () => NEVER });
    seams.raiseLeg = filedWith(claimed);
    /* RED WHEN: a leg is reported raised on the service's word that the chain holds it - a person is told it is raised when it is not. */
    await expect(raiseRunOnDevice(claimed.doors as unknown as LegRaiseDoors, LEG_RAISE)).rejects.toThrow(/^this proposal was sent and the chain has not shown it yet/u);

    const unsaid = aDevice({ file: async () => round(), chainSays: () => HELD });
    seams.raiseLeg = filedWith(unsaid);
    const seen = await raiseRunOnDevice(unsaid.doors as unknown as LegRaiseDoors, LEG_RAISE);
    /* RED WHEN: a leg the chain holds is waited on because the service did not say so - the device asks again for what it already knows. */
    expect(seen.raisedAt).toBeDefined();
    expect(unsaid.log.filter((l) => l.startsWith('standing'))).toEqual([]);
  });

  it('a retry raised from this device is raised only when the chain holds it, whatever the service answers', async () => {
    const claimed = aDevice({ file: async () => round({ raisedAt: 'now', txRef: 't1' }), chainSays: () => NEVER });
    seams.raiseRetry = filedWith(claimed);
    /* RED WHEN: a retry is reported raised on the service's word that the chain holds it - the people it pays are told it is on its way when it is not. */
    await expect(raiseRetryOnDevice(claimed.doors as unknown as LegRaiseDoors, RETRY_RAISE)).rejects.toThrow(/^this retry was sent and the chain has not shown it yet/u);

    const unsaid = aDevice({ file: async () => round(), chainSays: () => HELD });
    seams.raiseRetry = filedWith(unsaid);
    const seen = await raiseRetryOnDevice(unsaid.doors as unknown as LegRaiseDoors, RETRY_RAISE);
    /* RED WHEN: a retry the chain holds is waited on because the service did not say so. */
    expect(seen.raisedAt).toBeDefined();
    expect(unsaid.log.filter((l) => l.startsWith('standing'))).toEqual([]);
  });
});

describe('A RAISE UNDER ANOTHER PROPOSAL\'S IDENTITY IS NEVER HELD BY THE CHAIN', () => {
  it('a raise handed over under another proposal\'s identity is neither built nor sent, so the chain holds neither', async () => {
    const other = 'ee'.repeat(32);
    const d = aDevice({ raiseOrder: async () => ({ ...ORDER, order: { ...ORDER.order, proposal: other } as never }) });
    /* RED WHEN: a raise built for one proposal is sent as another's - the chain then holds a proposal nobody wrote down. */
    await expect(sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk' })).rejects.toThrow(/not the proposal it wrote down/u);
    expect(d.log.filter((l) => /^(build|send|state)/u.test(l))).toEqual([]);
  });

  it('a send answered under another proposal\'s identity or name is refused, and nothing is read or waited on from it', async () => {
    const other = 'ee'.repeat(32);
    const d = aDevice({ send: async (id) => round({ id, chainId: other, raisedAt: 'now', txRef: 't1' }) });
    /* RED WHEN: the service's answer to a send names another proposal's identity and this device reads that proposal's standing as the raise's own. */
    await expect(sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk' })).rejects.toThrow(/answered about another proposal than the one this device asked about/u);
    const renamed = aDevice({ send: async () => round({ id: 'prp_other', chainId: ORDER.chainId, raisedAt: 'now' }) });
    /* RED WHEN: an answer under another proposal's name is taken as the answer for the proposal sent. */
    await expect(sendRaiseFromDevice(renamed.doors, { runId: 'run_1', viewingKey: 'vk' })).rejects.toThrow(/answered about another proposal than the one this device asked about/u);
    /* RED WHEN: the refusal of an answer after a send says nothing was sent. */
    expect(nothingWasSentBy((() => { try { theRoundAsked(round({ id: 'prp_other' }), 'prp_1'); } catch (e) { return e; } })())).toBe(false);
  });

  it('an approval answered under another proposal\'s identity is refused, so the wait never ends on another proposal\'s count', async () => {
    const d = aDevice({
      approve: async () => round({ chainId: 'ee'.repeat(32), approvalCount: 9 }),
      chainSays: (r) => ({ held: 'open', approvals: r.approvalCount ?? 1, raisedAt: 1, approvedHere: r.approvalCount === 9 }),
    });
    /* RED WHEN: the service answers an approval with another proposal's identity and its count ends this approval's wait. */
    await expect(approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toThrow(/answered about another proposal than the one this device asked about/u);
    const late = aDevice({ standings: [round({ id: 'prp_other' })] });
    /* RED WHEN: a standing answered under another proposal's name is read as the standing of the one shown. */
    await expect(approveOnDevice(late.doors, { round: round(), viewingKey: 'vk' })).rejects.toThrow(/answered about another proposal than the one this device asked about/u);
  });
});

/*
 * A governance change over a service that answers what a case tells it to and a builder that writes down what it is asked
 * for. The company's records are the ones the founding seat signed; what a proposal opens as is the one change asked for.
 */
const GOVERNED_ID = 'aa'.repeat(32);
const GOVERNED_SALT = 'cd'.repeat(32);
const GOVERNED_KEY = newSymmetricKey();
const founder = newSigningKeypair();
const FOUNDING_SEAT = '41'.repeat(32);
const COMMITTEE = { tag: 'schnorr', value: '7a'.repeat(32) };
const FOUNDING_STATE = signedFoundingState('acc_1', {
  keyEpoch: 0, sealed: seal(canonical({ state: {}, blinding: { assetBlinding: '55'.repeat(32), payRecordKey: 'ab'.repeat(32) } }), GOVERNED_KEY),
}, founder.secret);
const THREE: GovernanceOnTheWire = { kind: 'threshold', threshold: '3' };
/* The company's first roster, which its founding seat anchored with the first state: no signer is seated beside it before. */
const FOUNDING_ROSTER = signCompanyFiling(sealRoster('acc_1', { name: 'Acme', signers: [] }, 1, 0, GOVERNED_KEY), founder.secret);

const aGovernedDevice = (o: {
  /** Whether the company already holds a proposal for the change, written down and listed by the service. */
  held?: boolean;
  /** What the service answers to the filing of a new proposal, to the send of one written down, and to a question of where one stands. */
  filed?: Partial<RoundOnThePage>; sent?: Partial<RoundOnThePage>; standing?: Partial<RoundOnThePage>;
  /** What the chain shows of the proposal, given how many times the service has been asked where it stands. */
  chain: (asked: number) => RoundOnChain;
  /** The approvals the account needs. */
  bar?: number;
  /** The approvals a policy change needs, as the account stores them; absent, none is stored. */
  policyBar?: number;
  /** The change the proposal the company holds opens as; absent, the threshold raised to three. */
  governance?: GovernanceOnTheWire;
  /** The person's wallet read the account without its seat bar. */
  noSeatBar?: boolean;
  /** The chain already holds this seat's approval of the proposal: its raise, sent on an earlier attempt, counted it. */
  alreadyApproved?: boolean;
  /** The proposal opens with no signed filing this device believes, so who raised it cannot be said. */
  filedByNobody?: boolean;
}) => {
  const log: string[] = [];
  /* How many times the service was asked where the proposal stands: each read of the chain that follows sees this many. */
  let asked = 0;
  const opened: OpenedRound = {
    chainId: GOVERNED_ID, digest: '', vault: '', salt: GOVERNED_SALT, summary: '', governance: o.governance ?? THREE,
    ...(o.filedByNobody ? { filedBy: undefined } : {}),
  };
  seams.opens = async () => opened;
  const page = (over: Partial<RoundOnThePage> = {}): RoundOnThePage => ({ id: 'prp_gov', chainId: GOVERNED_ID, status: 'open', ...over });
  const doors: GovernanceDoors = {
    service: {
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
      sealedProposals: async () => (o.held ? [{
        createdAt: '2026-10-01', id: 'prp_gov', accountId: 'acc_1', status: 'open', chainId: GOVERNED_ID, approvalCount: 0,
      }] as unknown as SealedProposal[] : []),
      file: async () => { log.push('file'); return page(o.filed); },
      send: async (id) => { log.push(`send ${id}`); return page(o.sent); },
      approve: async (id) => { log.push(`approve ${id}`); return page(); },
      standing: async (id) => { asked += 1; log.push(`standing ${id}`); return page(o.standing); },
      carry: async (id, body) => { log.push(`carry ${id} ${body.circuit}`); return page({ status: 'executed' }); },
      /* A door to the service's read of the chain's bars that a device must never take: asking it fails the case. */
      bars: async () => { log.push('bars'); throw new Error('the device asked the service for the account\'s bars'); },
    } as GovernanceDoors['service'],
    builder: {
      governedCall: async ({ order }) => {
        log.push(`build ${order.circuit}`);
        return { tx: `TX-${order.circuit}` };
      },
      proposalIdentity: async () => ({ digest: 'dd'.repeat(32), chainId: GOVERNED_ID, noVault: '00'.repeat(32) }),
    },
    material: { signingSecret: founder.secret, blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: 'acc_1',
    records: {
      directory: async () => {
        const believed = {
          dir: { company: 'acc_1', version: 0, seats: [{ seat: FOUNDING_SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin' as const, retired: null }] },
          /* The account as the person's own wallet read it: its threshold, the policy bar it stores, and the seat bar of the two. */
          holders: {
            committee: [COMMITTEE], seats: [FOUNDING_SEAT], approvals: o.bar ?? 2, vaultThresholds: [], policyBar: o.policyBar ?? null,
            ...(o.noSeatBar ? {} : { seatBar: seatBarOf(o.bar ?? 2, o.policyBar ?? null) }), adoptedVaults: [], account: 'ac'.repeat(32),
          },
          another: new Set<string>(),
          refusedAt: new Set<number>(),
        };
        return {
          ...believed,
          records: await heldEntering('acc_1', [], { seat: FOUNDING_SEAT, signingSecret: founder.secret, records: [FOUNDING_STATE, FOUNDING_ROSTER], committee: [COMMITTEE] }, believed as never),
        } as never;
      },
      state: async (id: string) => (id === '0' ? FOUNDING_STATE : null),
      roundIdentity: pureCircuits,
      roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id.toLowerCase(), { approvedHere: o.alreadyApproved === true, ...o.chain(asked) }])),
    } as unknown as CompanyRecordsHere,
    filing: {
      seat: FOUNDING_SEAT, keyEpoch: 0, salt: () => GOVERNED_SALT, newId: () => 'prp_gov',
      entered: { enter: async () => undefined },
    },
    approvers: async () => approverRosterFrom({
      threshold: 1, vaultThresholds: [], seated: [1, 2, 3, 4].map((n) => ({ leaf: `e${n}` })), adoptedVaults: [], companyWide: 'cc'.repeat(32),
    }),
    vaultName: () => 'company-wide runs',
    sleep: async () => {}, waitMs: 3, everyMs: 1,
  };
  return { doors, log };
};

describe('A GOVERNANCE PROPOSAL STANDS WHERE THE CHAIN SAYS, NEVER WHERE THE SERVICE ANSWERS', () => {
  const NEVER: RoundOnChain = { held: 'never', approvals: 0 };
  const change = { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4 };

  it('a change written down here is raised only when the chain holds it, whatever the service answers', async () => {
    const d = aGovernedDevice({ filed: { raisedAt: 'now' }, chain: () => NEVER });
    const refused = await changeThresholdOnDevice(d.doors, change).catch((e) => e);
    /* RED WHEN: a proposal is taken as raised on the service's word that the chain holds it - it is approved and carried out before it is there. */
    expect(refused).toBeInstanceOf(SentAndNotYetSeen);
    expect(String(refused.message)).toMatch(/^this proposal was sent and the chain has not shown it yet/u);
    expect(d.log.filter((l) => /^(approve|carry)/u.test(l))).toEqual([]);
  });

  it('a change written down earlier and sent now is raised only when the chain holds it, whatever the service answers', async () => {
    const d = aGovernedDevice({ held: true, sent: { raisedAt: 'now' }, chain: () => NEVER });
    const refused = await changeThresholdOnDevice(d.doors, change).catch((e) => e);
    /* RED WHEN: a proposal sent again is taken as raised on the service's word that the chain holds it. */
    expect(refused).toBeInstanceOf(SentAndNotYetSeen);
    expect(String(refused.message)).toMatch(/^this proposal was sent and the chain has not shown it yet/u);
    expect(d.log.filter((l) => /^(approve|carry)/u.test(l))).toEqual([]);
  });

  it('a seat whose approval the chain already holds approves nothing, and the proposal stands where the chain counts it: enough approvals, and it is carried out', async () => {
    /* The service still counts one; the chain holds this seat's approval, and another signer's lands by the read after it. */
    const d = aGovernedDevice({
      held: true, bar: 2, alreadyApproved: true, standing: { approvalCount: 1 },
      chain: (asked) => ({ held: 'open', approvals: asked > 1 ? 2 : 1, raisedAt: 1 }),
    });
    const out = await changeThresholdOnDevice(d.doors, change);
    /* RED WHEN: the count after the chain says this seat already approved is the service's - a proposal the chain has enough approvals for is left waiting. */
    expect(out.state).toBe('done');
    /* RED WHEN: an approval the chain already holds is built and sent again. */
    expect(d.log.filter((l) => /^(build approve|approve|carry)/u.test(l))).toEqual(['carry prp_gov setThreshold']);
  });

  it('a seat whose approval the chain already holds approves nothing, and the proposal stands where the chain counts it: too few approvals, and it is left for the others', async () => {
    /* The service says the bar is met; the chain counts one of the two needed. */
    const d = aGovernedDevice({
      held: true, bar: 2, alreadyApproved: true, standing: { approvalCount: 2 },
      chain: () => ({ held: 'open', approvals: 1, raisedAt: 1 }),
    });
    const out = await changeThresholdOnDevice(d.doors, change);
    /* RED WHEN: the count after the chain says this seat already approved is the service's - a proposal short of approvals on the chain is carried out. */
    expect(out.state).toBe('waiting-for-approvals');
    expect(d.log.filter((l) => /^(build approve|approve|carry)/u.test(l))).toEqual([]);
  });

  it('A RAISER RESUMING A REMOVAL IT RAISED HANDS ITS RETIREMENT SIGNATURE ONCE AND APPROVES NOTHING, BECAUSE THE CHAIN HOLDS ITS RAISE AS ITS APPROVAL', async () => {
    const signature = { publicKey: founder.publicKey, signature: 'ee'.repeat(64) } as unknown as RetirementSignature;
    const raised = { viewingKey: GOVERNED_KEY, change: THREE, summary: 'Change the approval threshold to 3 of 4', body: { newThreshold: 3 } } as Parameters<typeof governOnDevice>[1];
    const handed: string[] = [];
    const resumed = (alreadyApproved: boolean) => {
      const d = aGovernedDevice({ held: true, bar: 2, alreadyApproved, chain: () => ({ held: 'open', approvals: 1, raisedAt: 1 }) });
      const doors: GovernanceDoors = {
        ...d.doors,
        service: { ...d.doors.service, retire: async (id: string) => { handed.push(`${alreadyApproved} ${id}`); return d.doors.service.standing(id); } } as never,
      };
      return { d, doors };
    };
    const raiser = resumed(true);
    const out = await governOnDevice(raiser.doors, { ...raised, signs: async () => signature });
    /* RED WHEN: a raiser resuming its own removal builds an approval the chain already holds, or never hands its retirement signature. */
    expect(out.state).toBe('waiting-for-approvals');
    expect(raiser.d.log.filter((l) => /^(build approve|approve)/u.test(l))).toEqual([]);
    expect(handed).toEqual(['true prp_gov']);
    /* Another seat resuming the same proposal approves it, and its signature goes with that approval, not on its own. */
    const other = resumed(false);
    await governOnDevice(other.doors, { ...raised, signs: async () => signature }).catch(() => undefined);
    /* RED WHEN: a seat the chain holds no approval from is told it approved, and its retirement signature goes on its own. */
    expect(other.d.log.filter((l) => /^(build approve|approve)/u.test(l))).toEqual(['build approve', 'approve prp_gov']);
    expect(handed).toEqual(['true prp_gov']);
    /* Asked only to approve, a seat whose approval the chain already holds is told so, and nothing is built, sent or handed. */
    const asked = resumed(true);
    const refused = await governOnDevice(asked.doors, { ...raised, approveOnly: GOVERNED_ID, signs: async () => signature }).catch((e: unknown) => e);
    /* RED WHEN: a step asked only to approve tells an approval the chain already held as given, or hands the signature on its own. */
    expect(refused instanceof ApprovalNotOwed ? refused.why : refused).toBe('counted');
    expect(asked.d.log.filter((l) => /^(build approve|approve|carry)/u.test(l))).toEqual([]);
    expect(handed).toEqual(['true prp_gov']);
  });
});

describe('THE BAR A PROPOSAL IS CARRIED OUT AT IS READ FROM THE PERSON\'S OWN WALLET, NEVER FROM THE SERVICE', () => {
  const SEAT_ADDED: GovernanceOnTheWire = { kind: 'add-signer', address: 'e5'.repeat(32), scope: '5c'.repeat(32) };
  const seatAdded = { viewingKey: GOVERNED_KEY, change: SEAT_ADDED, summary: 'Add a signer', body: { signerId: 'sig_1' } } as Parameters<typeof governOnDevice>[1];

  it('an invitation is left for the invitee only at the seat bar: two approvals at a threshold of two wait while the account stores a policy bar of three', async () => {
    const d = aGovernedDevice({ held: true, bar: 2, policyBar: 3, governance: SEAT_ADDED, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    /* RED WHEN: adding a signer is counted against the account's threshold, below the seat bar the chain's own seating holds it to. */
    expect((await governOnDevice(d.doors, seatAdded)).state).toBe('waiting-for-approvals');
    expect(d.log.filter((l) => /^carry/u.test(l))).toEqual([]);
    /* At the seat bar it waits for the person invited, and no signer's device carries it out. */
    const met = aGovernedDevice({ held: true, bar: 2, policyBar: 3, governance: SEAT_ADDED, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 3, raisedAt: 1 }) });
    expect((await governOnDevice(met.doors, seatAdded)).state).toBe('waiting-for-the-invitee');
    /* RED WHEN: a signer's device carries out an approved invitation. */
    expect(met.log.filter((l) => /^carry/u.test(l))).toEqual([]);
  });

  it('no device asks the service for the account\'s bars, and a wallet read without the seat bar is refused, never taken as met', async () => {
    const d = aGovernedDevice({ held: true, bar: 2, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    expect((await changeThresholdOnDevice(d.doors, { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4 })).state).toBe('done');
    /* RED WHEN: a device takes the bar a proposal is carried out at from the service's read of the chain rather than its own wallet's. */
    expect(d.log).not.toContain('bars');
    /* RED WHEN: the service's routes still give a device a read of the chain's bars. */
    expect('bars' in governedCallServiceFor(async () => { throw new Error('no route is asked'); })).toBe(false);
    const blind = aGovernedDevice({ held: true, bar: 2, noSeatBar: true, governance: SEAT_ADDED, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    /* RED WHEN: a wallet read with no seat bar is taken as a bar met, and a signer is seated short of it. */
    await expect(governOnDevice(blind.doors, seatAdded)).rejects.toThrow(/did not say how many approvals a change of who is seated needs/u);
    expect(blind.log.filter((l) => /^carry/u.test(l))).toEqual([]);
  });
});

describe('NOTHING IS WRITTEN DOWN FROM THIS DEVICE WHILE THE COMPANY\'S KEY IS BEING CHANGED', () => {
  it('a governance proposal is not sealed or filed while sealing is paused, and every record still opens', async () => {
    const { CompanyKeyBeingChanged } = await import('./company-key-here.js');
    /* The company's keys while a signer's removal is carried out and the key they held is not yet replaced. */
    const paused = {
      epoch: 0, key: GOVERNED_KEY, newest: 0, keyAt: () => GOVERNED_KEY,
      sealing: () => { throw new CompanyKeyBeingChanged('the company\'s key is being changed'); },
    };
    const d = aGovernedDevice({ filed: { raisedAt: 'now' }, chain: () => ({ held: 'never', approvals: 0 }) });
    /* RED WHEN: the governance proposal is sealed under the key in force without asking whether sealing is paused. */
    await expect(changeThresholdOnDevice(d.doors, { viewingKey: paused, newThreshold: 3, seated: 4 })).rejects.toThrow(CompanyKeyBeingChanged);
    expect(d.log).not.toContain('file');
  });
});

describe('A THRESHOLD CHANGE IS CHECKED BEFORE EVERY SEND, AND CARRIED OUT IN A STEP OF ITS OWN', () => {
  const NEVER: RoundOnChain = { held: 'never', approvals: 0 };
  /* Two seats that may approve company-wide runs: a threshold of three would leave those runs unable to be paid. */
  const twoApprovers = () => approverRosterFrom({
    threshold: 2, vaultThresholds: [], seated: [{ leaf: 'e1' }, { leaf: 'e2' }], adoptedVaults: [], companyWide: 'cc'.repeat(32),
  });

  it('a raise written down earlier and sent again is checked first, and one that would leave a vault unable to pay is neither built nor sent', async () => {
    const d = aGovernedDevice({ held: true, sent: { raisedAt: 'now' }, chain: () => NEVER });
    const doors: GovernanceDoors = { ...d.doors, approvers: async () => twoApprovers() };
    /* RED WHEN: a proposal written down and not yet raised is proved and sent again with no check, though carrying it out would leave a vault unable to pay. */
    await expect(changeThresholdOnDevice(doors, { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4 })).rejects.toThrow(/unable to pay/u);
    expect(d.log.filter((l) => /^(build|send|file)/u.test(l))).toEqual([]);
  });

  it('a change at its bar can be left for a step that carries it out, and that step approves nothing', async () => {
    const atBar = aGovernedDevice({ held: true, bar: 2, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    /* RED WHEN: a change asked to stop at its bar is carried out in the same call. */
    expect((await changeThresholdOnDevice(atBar.doors, { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4, approveOnly: GOVERNED_ID, stopBeforeCarry: true })).state).toBe('ready-to-carry');
    expect(atBar.log.filter((l) => /^carry/u.test(l))).toEqual([]);
    const carried = aGovernedDevice({ held: true, bar: 2, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    expect((await changeThresholdOnDevice(carried.doors, { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4, approveOnly: GOVERNED_ID, carryOnly: true })).state).toBe('done');
    expect(carried.log.filter((l) => /^(build|carry)/u.test(l))).toEqual(['build setThreshold', 'carry prp_gov setThreshold']);
    const short = aGovernedDevice({ held: true, bar: 2, chain: () => ({ held: 'open', approvals: 1, raisedAt: 1 }) });
    /* RED WHEN: the step that only carries out sends an approval of a change short of its bar. */
    expect((await changeThresholdOnDevice(short.doors, { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4, approveOnly: GOVERNED_ID, carryOnly: true })).state).toBe('waiting-for-approvals');
    expect(short.log.filter((l) => /^(build|approve|carry)/u.test(l))).toEqual([]);
  });

  it('a vault lowered, or raised past the approvals a policy change needs, is carried out only at the seat bar', async () => {
    const VAULT = 'ab'.repeat(32);
    const lowered: GovernanceOnTheWire = { kind: 'vault-threshold', vault: VAULT, threshold: '1' };
    const d = aGovernedDevice({ held: true, bar: 2, policyBar: 3, governance: lowered, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    /* RED WHEN: a vault lowered is carried out at the account's threshold, below the seat bar the chain carries it out at. */
    expect((await changeVaultThresholdOnDevice(d.doors, { viewingKey: GOVERNED_KEY, vault: VAULT, newThreshold: 1, seated: 4 })).state).toBe('waiting-for-approvals');
    expect(d.log.filter((l) => /^carry/u.test(l))).toEqual([]);
    const within: GovernanceOnTheWire = { kind: 'vault-threshold', vault: VAULT, threshold: '3' };
    const met = aGovernedDevice({ held: true, bar: 2, policyBar: 3, governance: within, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    /* A vault raised within the seat bar is carried out at the account's threshold. */
    expect((await changeVaultThresholdOnDevice(met.doors, { viewingKey: GOVERNED_KEY, vault: VAULT, newThreshold: 3, seated: 4 })).state).toBe('done');
  });
});

describe('A RAISE SENT AGAIN IS REFUSED IF A SIGNER ON THEIR WAY OUT MAY HAVE FILED IT, AND A LOWERED THRESHOLD NEVER SKIPS AN APPROVAL', () => {
  it('a raise written down earlier whose filer cannot be said is neither built nor sent again', async () => {
    const d = aGovernedDevice({ held: true, filedByNobody: true, sent: { raisedAt: 'now' }, chain: () => ({ held: 'never', approvals: 0 }) });
    /* RED WHEN: a raise written down earlier is proved and sent again before this device knows a signer on their way out did not file it. */
    await expect(changeThresholdOnDevice(d.doors, { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4 })).rejects.toThrow(/who raised it cannot be said/u);
    expect(d.log.filter((l) => /^(build|send|file)/u.test(l))).toEqual([]);
  });

  it('a proposal raised when the threshold was three is not taken as at its bar at two approvals once the threshold is two', async () => {
    const d = aGovernedDevice({ held: true, bar: 2, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, needed: 3, raisedAt: 1 }) });
    /* RED WHEN: the bar a proposal is judged at is the threshold now, below what the chain holds it to, and it is carried out short. */
    expect((await changeThresholdOnDevice(d.doors, { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4 })).state).toBe('waiting-for-approvals');
    expect(d.log.filter((l) => /^carry/u.test(l))).toEqual([]);
  });
});

describe('A SPENDING POLICY IS COUNTED AGAINST ITS VAULT\'S APPROVERS AT ITS BANDS BEFORE EVERY SEND', () => {
  const VAULT = 'ab'.repeat(32);
  const POLICY: GovernanceOnTheWire = { kind: 'spending-policy', vault: VAULT, assetKey: 'a5'.repeat(32), commitment: 'c5'.repeat(32) };
  /* Two seats that may approve the vault's runs, at a threshold of one; the account stores a policy bar of three, so no removal is asked about. */
  const twoOnTheVault = () => approverRosterFrom({
    threshold: 1, vaultThresholds: [], seated: [{ leaf: 'e1' }, { leaf: 'e2' }], adoptedVaults: [VAULT], companyWide: 'cc'.repeat(32),
  });
  const approving = (highestBand: number, bandsInForce?: () => Promise<readonly { vault: string; band: number }[]>) => {
    const d = aGovernedDevice({ held: true, bar: 1, policyBar: 3, governance: POLICY, chain: () => ({ held: 'open', approvals: 1, needed: 3, raisedAt: 1 }) });
    const doors: GovernanceDoors = { ...d.doors, approvers: async () => twoOnTheVault(), vaultName: (v) => `vault ${v.slice(0, 4)}` };
    const asked = { viewingKey: GOVERNED_KEY, change: POLICY, summary: 'Set this vault\'s spending policy for one currency', body: {}, highestBand,
      ...(bandsInForce === undefined ? {} : { bandsInForce }), approveOnly: GOVERNED_ID, stopBeforeCarry: true } as Parameters<typeof governOnDevice>[1];
    return { log: d.log, out: governOnDevice(doors, asked) };
  };

  it('a policy whose highest band asks for more signers than may approve its vault\'s runs is neither approved nor carried out', async () => {
    const short = approving(3, async () => []);
    /* RED WHEN: a policy is approved without its bands counted against its vault, and no run in its top band could ever be paid. */
    await expect(short.out).rejects.toThrow(/unable to pay: vault abab \(its runs need 3 approvals and 2 signers could give them\)/u);
    expect(short.log.filter((l) => /^(build|approve|carry)/u.test(l))).toEqual([]);
    /* RED WHEN: a policy whose bands the vault's approvers can give is refused, so no spending policy is ever approved. */
    const within = approving(2, async () => [{ vault: VAULT, band: 1 }]);
    await within.out.catch(() => undefined);
    expect(within.log.filter((l) => /^build/u.test(l))).toEqual(['build approve']);
  });

  it('a policy this device was not told the bands in force for, or its highest band, is refused before any build', async () => {
    const unread = approving(2);
    /* RED WHEN: a policy is approved with the bands in force on its vault never read, so the vault is counted as asking for none. */
    await expect(unread.out).rejects.toThrow(/cannot count who approves the vault's runs at its bands/u);
    expect(unread.log.filter((l) => /^(build|approve|carry)/u.test(l))).toEqual([]);
  });
});

describe('A FINISHED CALL GOES STRAIGHT TO THE CHAIN FROM THE PERSON\'S OWN WALLET WHEN THE ACT ASKS', () => {
  const own = signingPublicKeyOf(material.signingSecret as Hex);
  const relayed = (d: ReturnType<typeof aDevice>) => d.log.filter((l) => /^(send|approve|cancel) /u.test(l));

  it('a raise written down is sent by the wallet, as the one propose call to the company\'s account, and the service is only asked where it stands', async () => {
    const d = aDevice({ straight: true });
    const done = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN });
    expect(done.raisedAt).toBeDefined();
    /* RED WHEN: a raise the act sends straight to the chain is still relayed by the service, or not sent by the wallet at all. */
    expect(relayed(d)).toEqual([]);
    expect(d.log).toContain(`to the chain account-call propose TX-propose on ${'ac'.repeat(32)}`);
    expect(d.log).toContain('standing prp_1');
  });

  it('an approval is sent by the wallet and never relayed, and the wait still ends only on the chain\'s count of this seat', async () => {
    const d = aDevice({ straight: true, heldBefore: { ['cc'.repeat(32)]: 1 } });
    const done = await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    /* RED WHEN: an approval sent straight to the chain is relayed by the service as well, so it is sent twice. */
    expect(relayed(d)).toEqual([]);
    expect(d.log).toContain(`to the chain account-call approve TX-approve on ${'ac'.repeat(32)}`);
    expect(done.approvalCount).toBe(2);
  });

  it('a withdrawal is sent by the wallet, and the service\'s record is closed only after the chain no longer holds the proposal', async () => {
    const d = aDevice({
      straight: true, standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: { ['cc'.repeat(32)]: 0 }, whileHeld: { raisedHere: true },
      closed: async (id, body) => { d.log.push(`closed ${id} ${body.how} ${body.filer}`); return round({ status: 'cancelled' }); },
    });
    const done = await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    expect(done.withdrawal).toBe('withdrawn');
    /* RED WHEN: a withdrawal sent straight to the chain is relayed too, or the service's record is left open. */
    expect(relayed(d)).toEqual([]);
    const sent = d.log.indexOf(`to the chain account-call cancel TX-cancel on ${'ac'.repeat(32)}`);
    const closed = d.log.indexOf(`closed prp_1 withdrawn ${own}`);
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(sent);
  });

  it('a device that reaches no wallet sends nothing on the chain path, and says nothing was sent', async () => {
    const d = aDevice({ straight: 'no-wallet', heldBefore: { ['cc'.repeat(32)]: 1 } });
    const e = await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' }).then(() => null, (x: unknown) => x);
    /* RED WHEN: with no wallet to send it, an approval asked for the chain path falls back to the service, or is said as maybe sent. */
    expect(nothingWasSentBy(e)).toBe(true);
    expect(relayed(d)).toEqual([]);
  });

  it('without a path named, every call goes through the service as before and the wallet sends nothing', async () => {
    const d = aDevice();
    await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN });
    /* RED WHEN: the service path stops relaying, or the wallet is asked to send a call the service relays. */
    expect(relayed(d)).toEqual([`send prp_1 TX-propose ${DEVICE_RAISE_VERSION}`]);
    expect(d.log.some((l) => l.startsWith('to the chain'))).toBe(false);
  });
});

describe('A GOVERNANCE CHANGE THE ACT SENDS STRAIGHT TO THE CHAIN', () => {
  const change = { viewingKey: GOVERNED_KEY, newThreshold: 3, seated: 4 };
  const straight = (d: ReturnType<typeof aGovernedDevice>): GovernanceDoors => ({
    ...d.doors,
    service: {
      ...d.doors.service,
      file: async (id, body) => { d.log.push(`file ${body.tx === undefined ? 'its record only' : 'with its call'}`); return d.doors.service.file!(id, body); },
      closed: async (id, body) => { d.log.push(`closed ${id} ${body.how}`); return { id, chainId: GOVERNED_ID, status: 'executed' }; },
    },
    handOver: { path: 'chain', toChain: async (tx, call) => { d.log.push(`to the chain ${call.circuit} ${tx}`); } },
  });

  it('is written down first with no call, raised and carried out by the wallet, and its record closed from the chain: the service relays nothing', async () => {
    const d = aGovernedDevice({ bar: 1, chain: (asked) => (asked === 0 ? { held: 'never', approvals: 0 } : { held: 'open', approvals: 1, raisedAt: 1 }) });
    const out = await changeThresholdOnDevice(straight(d), change);
    expect(out.state).toBe('done');
    /* RED WHEN: the record is filed with the call, so the service sends it too; or the carry is relayed; or the record is never closed. */
    expect(d.log.filter((l) => /^(file|to the chain|send|carry|closed)/u.test(l))).toEqual([
      'file its record only', 'file', 'to the chain propose TX-propose', 'to the chain setThreshold TX-setThreshold', 'closed prp_gov carried',
    ]);
  });
});
