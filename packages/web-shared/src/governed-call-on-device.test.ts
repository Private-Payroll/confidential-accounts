import { describe, it, expect, vi } from 'vitest';
import {
  approveOnDevice, changeThresholdOnDevice, governOnDevice, governedCallServiceFor, nothingWasSentBy, raiseRetryOnDevice, raiseRunOnDevice,
  SentAndNotYetSeen, sendRaiseFromDevice, sendRetryFromDevice, withdrawOnDevice,
  type GovernanceDoors, type GovernedCallService, type LegPaymentsOnTheWire, type RaiseDoors, type RaiseOrderOnTheWire,
  type RetryOrderOnTheWire, type RoundOnThePage,
} from './governed-call-on-device.js';
import type { GovernanceOnTheWire, OpenedRound, RoundOnChain } from './governed-call-builder.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { paysCommitmentOf } from '../../../src/core/proposal-filing.js';

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
vi.mock('./round-opened-here.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./round-opened-here.js')>()),
  openTheRoundHere: (_s: unknown, _a: string, proposalId: string, viewingKey: string, forARaise: boolean) =>
    seams.opens(proposalId, viewingKey, forARaise),
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
import type { SealedProposal } from '../../../src/core/types.js';
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
/* What a proposal written down for `payments` commits to paying, as its filing carries it, under ORDER's vault and salt. */
const paysFor = (payments: LegPaymentsOnTheWire['payments'], asset: string = TOKEN): string => paysCommitmentOf({ vault: VAULT, asset, payments }, SALT);

const ORDER: RaiseOrderOnTheWire = {
  proposalId: 'prp_1', chainId: 'cc'.repeat(32),
  order: {
    circuit: 'propose',
    run: { root: '88'.repeat(32), payees: '3', opensAt: '1', closesAt: '2', vault: VAULT },
    half: { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: SALT, changeAmount: '1', changeBatchDigest: '77'.repeat(32) },
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
 * closed by a withdrawal sent. A round no call of this device's reached is
 * never held. A case whose chain holds what another device sent gives its own
 * (`chainSays`).
 */
const aChainOfWhatWasSent = () => {
  const held = new Map<string, { approvals: number; closed: boolean }>();
  const of = (chainId: string) => held.get(String(chainId).toLowerCase());
  return {
    raised: (chainId: string) => { if (of(chainId) === undefined) held.set(String(chainId).toLowerCase(), { approvals: 0, closed: false }); },
    approved: (chainId: string) => { const r = of(chainId); if (r !== undefined && !r.closed) r.approvals += 1; },
    withdrawn: (chainId: string) => { const r = of(chainId); if (r !== undefined) r.closed = true; },
    says: (served: RoundOnThePage): RoundOnChain => {
      const r = of(served.chainId);
      return r === undefined ? { held: 'never', approvals: 0 }
        : r.closed ? { held: 'closed', approvals: 0, raisedAt: 1, closedBy: ['cancel'] } : { held: 'open', approvals: r.approvals, raisedAt: 1 };
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
  pool?: PoolNote[]; chainNotes?: string[]; fitFails?: Error;
  /** The pool as each check finds it, first check first; the last one stands for every later check. */
  poolAtCheck?: PoolNote[][];
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
  const onChain = aChainOfWhatWasSent();
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
    ...served,
    send: kept(landing(served.send, 'propose', (id) => onChain.raised(id)))!,
    approve: kept(landing(served.approve, 'approve', (id) => onChain.approved(id)))!,
    cancel: kept(landing(served.cancel, 'cancel', (id) => onChain.withdrawn(id))),
    ...(served.file === undefined ? {} : { file: kept(landing(served.file, 'propose', (id) => onChain.raised(id)))! }),
    standing: kept(served.standing)!,
  };
  const chainSays = over.chainSays ?? onChain.says;
  const holdings = deviceVaultHoldings({
    chain: async (vault) => { log.push(`vault read ${vault}`); return { onChain: true, notesFromThisBuild: true, notes: over.chainNotes ?? poolNow().map(committed) }; },
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
  const doors: RaiseDoors = {
    service, holdings, assets: registryWithTestPrivateForms(),
    /* The person's own wallet's read of this file's chain: what it shows of each round the service named. */
    records: {
      roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => {
        const r = lastServed.get(id.toLowerCase());
        return [id.toLowerCase(), r === undefined ? { held: 'never', approvals: 0 } : chainSays(r)];
      })),
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
    const approved = aDevice({ chainSays: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    await approveOnDevice(approved.doors, { round: round(), viewingKey: 'vk' }).catch(() => undefined);
    const writtenOnly = aDevice({ standings: [round()] });
    await withdrawOnDevice(writtenOnly.doors, { round: round(), viewingKey: 'vk' });
    const held = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: { ['cc'.repeat(32)]: 0 } });
    await withdrawOnDevice(held.doors, { round: round(), viewingKey: 'vk' });
    /* RED WHEN: a relay carries no filing key, or another than this device's own, so the service cannot tell which of the person's seats acts. */
    expect([...raised.filers, ...approved.filers, ...writtenOnly.filers, ...held.filers])
      .toEqual([`send ${own}`, `approve ${own}`, `cancel ${own}`, `cancel ${own}`]);
  });
});

describe('APPROVING FROM THIS DEVICE', () => {
  it('reads the standing first, builds the approval for the proposal\'s chain identity, sends only the proven call, and waits for the chain to count one more', async () => {
    /* The chain holds the proposal with one approval, and counts this device's a read later than the service answers. */
    const counts = [1, 1, 1, 2];
    let reads = 0;
    const d = aDevice({ chainSays: () => ({ held: 'open', approvals: counts[Math.min(reads++, counts.length - 1)]!, raisedAt: 1 }) });
    const done = await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    expect(done.approvalCount).toBe(2);
    /* RED WHEN: the approval carries anything beside the proven call - a signer id, a signature or a key. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build approve for ${'ac'.repeat(32)} on AS`, 'approve prp_1 TX-approve',
      /* RED WHEN: the wait stops at a count the chain already had before this approval. */
      'standing prp_1', 'standing prp_1',
    ]);
  });

  it('AN APPROVAL IS BUILT ONLY FOR THE PROPOSAL THE PERSON WAS SHOWN', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32) })] });
    /* RED WHEN: the device proves an approval of whatever id the service names now. */
    await expect(approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' }))
      .rejects.toThrow(/another proposal than the one shown here/u);
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('approve'))).toEqual([]);
  });

  it('a count past one more ends the wait, a status the service names does not, and one the chain never counts is sent and not seen', async () => {
    /* The chain holds the proposal, with the approvals the service says it counted. */
    const held = (r: RoundOnThePage): RoundOnChain => ({ held: 'open', approvals: r.approvalCount ?? 0, raisedAt: 1 });
    const d = aDevice({ standings: [round({ approvalCount: 1 }), round({ approvalCount: 3 })], chainSays: held });
    /* RED WHEN: another signer's approval landing in the same block keeps this device waiting for an exact count. */
    expect((await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).approvalCount).toBe(3);
    /* RED WHEN: the wait ends on a status the service writes rather than on the chain's count. */
    const named = aDevice({ standings: [round({ approvalCount: 1 }), round({ approvalCount: 1, status: 'approved' })], chainSays: held });
    await expect(approveOnDevice(named.doors, { round: round(), viewingKey: 'vk' })).rejects.toBeInstanceOf(SentAndNotYetSeen);
    const never = aDevice({ standings: [round()], chainSays: held });
    await expect(approveOnDevice(never.doors, { round: round(), viewingKey: 'vk' }))
      .rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('THE ONE MORE APPROVAL WAITED FOR IS ONE MORE THAN THE CHAIN COUNTED BEFORE, NOT THAN THE SERVICE SAID', async () => {
    /* The service says three before this approval; the chain counts one, then two once this approval lands. */
    let reads = 0;
    const d = aDevice({
      standings: [round({ approvalCount: 3 }), round({ approvalCount: 3 })],
      chainSays: () => { reads += 1; return { held: 'open', approvals: reads === 1 ? 1 : 2, raisedAt: 1 }; },
    });
    /* RED WHEN: the count waited for is one more than the service's - the device waits for four, which never comes. */
    expect((await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).approvalCount).toBe(2);
  });

  it('THE APPROVALS COUNTED, BEFORE AND AFTER, ARE THE CHAIN\'S, NEVER THE COUNT THE SERVICE ANSWERS WITH', async () => {
    /* The chain holds the proposal with one approval throughout; the service answers that it counts three. */
    const one = (): RoundOnChain => ({ held: 'open', approvals: 1, raisedAt: 1 });
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

describe('THE VAULT\'S PRIVATE MONEY IS ASKED ON THIS DEVICE BEFORE A RAISE WRITTEN DOWN IS SENT', () => {
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

  it('A PUBLIC PAYMENT IS LEFT TO THE COMPANY, WHICH CAN READ PUBLIC MONEY, AND NOT REFUSED HERE', async () => {
    const asked: string[] = [];
    const d = aDevice({
      standings: [round({ raisedAt: 'now' })],
      legPayments: async (runId, body) => {
        asked.push(`${runId} ${JSON.stringify(body)}`);
        return { asset: '0'.repeat(64), payments: [{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }] };
      },
      raiseOrder: async () => orderPaying([{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }], '0'.repeat(64)),
    });
    /* RED WHEN: this device asks itself about public money it cannot read - every run with a public payee is then refused here. */
    expect((await sendRaiseFromDevice(d.doors, { ...RAISE, asset: '0'.repeat(64) })).raisedAt).toBe(new Date(1).toISOString());
    expect(d.log.filter((l) => l.startsWith('vault read'))).toEqual([]);
    /* RED WHEN: the device check is skipped outright before the send. */
    expect(asked).toEqual([`run_1 {"viewingKey":"vk","asset":"${'0'.repeat(64)}"}`]);
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
    /* RED WHEN the refusal stops saying in plain words which payments came back, which were asked for, and that nothing was sent or spent (ruled copy fix, 1 Oct). */
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
  it('one only written down is withdrawn with no call, and nothing is built', async () => {
    const d = aDevice({ standings: [round()] });
    expect((await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).status).toBe('cancelled');
    /* RED WHEN: a proposal the chain never held is withdrawn by a proven call, or not withdrawn at all. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual(['standing prp_1', 'cancel prp_1 {}']);
  });

  it('one the service says the chain holds, and the chain never held, is withdrawn with no call, and nothing is built', async () => {
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], chainSays: () => ({ held: 'never', approvals: 0 }) });
    await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    /* RED WHEN: whether a proven call withdraws it is decided on the service's word that the chain holds it. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual(['standing prp_1', 'cancel prp_1 {}']);
  });

  it('one the chain holds is withdrawn by the cancel call this device proves for the proposal it opened', async () => {
    /* Raised from another device: the chain holds it. */
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })], heldBefore: { ['cc'.repeat(32)]: 0 } });
    await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    /* RED WHEN: the withdrawal of a held proposal is sent with no proven call, or proves anything but a cancel. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build cancel for ${'ac'.repeat(32)} on AS`, 'cancel prp_1 {"tx":"TX-cancel"}',
    ]);
  });

  it('a proposal the company now names differently is not withdrawn, and a page with no withdrawal says so', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32), raisedAt: 'then' })] });
    /* RED WHEN: the device withdraws whatever the service names now under the id the page showed. */
    await expect(withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toThrow(/another proposal than the one shown here/u);
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

  it('a send answered under another proposal\'s identity does not put that proposal on the chain, and the raise is read as its own', async () => {
    const other = 'ee'.repeat(32);
    const d = aDevice({ send: async (id) => round({ id, chainId: other, raisedAt: 'now', txRef: 't1' }) });
    const raised = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk' });
    /* RED WHEN: the chain this file stands for holds whatever proposal the service names, so a raise answered as another proposal reads as raised. */
    expect(raised.chainId).toBe(ORDER.chainId);
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
  /** What the chain shows of the proposal, given whether the builder has refused an approval as made already. */
  chain: (refused: boolean) => RoundOnChain;
  /** The approvals the account needs. */
  bar?: number;
  /** The approvals a policy change needs, as the account stores them; absent, none is stored. */
  policyBar?: number;
  /** The change the proposal the company holds opens as; absent, the threshold raised to three. */
  governance?: GovernanceOnTheWire;
  /** The person's wallet read the account without its seat bar. */
  noSeatBar?: boolean;
  /** The builder refuses an approval as made already. */
  alreadyApproved?: boolean;
}) => {
  const log: string[] = [];
  let refused = false;
  const opened: OpenedRound = { chainId: GOVERNED_ID, digest: '', vault: '', salt: GOVERNED_SALT, summary: '', governance: o.governance ?? THREE };
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
      standing: async (id) => { log.push(`standing ${id}`); return page(o.standing); },
      carry: async (id, body) => { log.push(`carry ${id} ${body.circuit}`); return page({ status: 'executed' }); },
      /* A door to the service's read of the chain's bars that a device must never take: asking it fails the case. */
      bars: async () => { log.push('bars'); throw new Error('the device asked the service for the account\'s bars'); },
    } as GovernanceDoors['service'],
    builder: {
      governedCall: async ({ order }) => {
        log.push(`build ${order.circuit}`);
        if (order.circuit === 'approve' && o.alreadyApproved) {
          refused = true;
          throw Object.assign(new Error('you have already approved this proposal'), { name: 'CallNotBuilt' });
        }
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
      roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id.toLowerCase(), o.chain(refused)])),
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

  it('an approval the builder refuses as made already leaves the proposal where the chain counts it: enough approvals, and it is carried out', async () => {
    /* The service still counts one; the chain counts the approval this signer already made, and the bar is two. */
    const d = aGovernedDevice({
      held: true, bar: 2, alreadyApproved: true, standing: { approvalCount: 1 },
      chain: (refused) => ({ held: 'open', approvals: refused ? 2 : 1, raisedAt: 1 }),
    });
    const out = await changeThresholdOnDevice(d.doors, change);
    /* RED WHEN: the count after "already approved" is the service's - a proposal the chain has enough approvals for is left waiting. */
    expect(out.state).toBe('done');
    expect(d.log.filter((l) => /^(approve|carry)/u.test(l))).toEqual(['carry prp_gov setThreshold']);
  });

  it('an approval the builder refuses as made already leaves the proposal where the chain counts it: too few approvals, and it is left for the others', async () => {
    /* The service says the bar is met; the chain counts one of the two needed. */
    const d = aGovernedDevice({
      held: true, bar: 2, alreadyApproved: true, standing: { approvalCount: 2 },
      chain: () => ({ held: 'open', approvals: 1, raisedAt: 1 }),
    });
    const out = await changeThresholdOnDevice(d.doors, change);
    /* RED WHEN: the count after "already approved" is the service's - a proposal short of approvals on the chain is carried out. */
    expect(out.state).toBe('waiting-for-approvals');
    expect(d.log.filter((l) => /^(approve|carry)/u.test(l))).toEqual([]);
  });
});

describe('THE BAR A PROPOSAL IS CARRIED OUT AT IS READ FROM THE PERSON\'S OWN WALLET, NEVER FROM THE SERVICE', () => {
  const SEAT_ADDED: GovernanceOnTheWire = { kind: 'add-signer', leaf: 'e5'.repeat(32) };
  const seatAdded = { viewingKey: GOVERNED_KEY, change: SEAT_ADDED, summary: 'Add a signer', body: { signerId: 'sig_1' } } as Parameters<typeof governOnDevice>[1];

  it('a signer seated is carried out only at the seat bar: two approvals at a threshold of two wait while the account stores a policy bar of three', async () => {
    const d = aGovernedDevice({ held: true, bar: 2, policyBar: 3, governance: SEAT_ADDED, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 2, raisedAt: 1 }) });
    /* RED WHEN: adding a signer is counted against the account's threshold, below the seat bar the chain's own seating holds it to. */
    expect((await governOnDevice(d.doors, seatAdded)).state).toBe('waiting-for-approvals');
    expect(d.log.filter((l) => /^carry/u.test(l))).toEqual([]);
    /* At the seat bar it is carried out. */
    const met = aGovernedDevice({ held: true, bar: 2, policyBar: 3, governance: SEAT_ADDED, alreadyApproved: true, chain: () => ({ held: 'open', approvals: 3, raisedAt: 1 }) });
    expect((await governOnDevice(met.doors, seatAdded)).state).toBe('done');
    expect(met.log.filter((l) => /^carry/u.test(l))).toEqual(['carry prp_gov amendSigner']);
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
