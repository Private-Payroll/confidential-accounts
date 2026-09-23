/**
 * **RAISING A PAYROLL PROPOSAL AND APPROVING ONE, FROM THIS DEVICE.**
 *
 * The page's side of it. The company's service writes a proposal down and hands
 * over what the device needs to build it; the worker builds and proves the call
 * with this signer's own key material; the service pays the network fee and
 * sends what the device proved. **Nothing that proves membership leaves this
 * device**: what the service receives is a proven transaction and, for an
 * approval, a signature.
 *
 * **A SEND ENDS ONE OF THREE WAYS.** Refused before anything was sent, which
 * the service marks and this module keeps. Sent and counted by the chain. Or
 * sent and not yet seen, which is said as exactly that, and the person is told
 * not to send it again. The service sends a proposal again only when the chain
 * says it does not hold it, and the chain refuses a second approval from one
 * signer; **the screen does not yet say the first of the three any differently
 * from any other failure.**
 */
import { assets as theAssets, type AssetId, type AssetRegistry } from '../core/assets.js';
import { refuseWhatTheVaultCannotPay, type PaymentAsked, type VaultHoldings } from '../core/vault-holdings.js';
import { DEVICE_RAISE_VERSION, paymentsCheckedDigest } from '../core/device-raise.js';
import type { SignerMaterial, GovernedCallOrder } from './governed-call-builder.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';

/** A proposal written down and not yet sent, as the service hands it to the device that builds it. */
export interface RaiseOrderOnTheWire {
  readonly proposalId: string;
  readonly chainId: string;
  readonly order: Extract<GovernedCallOrder, { circuit: 'propose' }>;
}

/** A retry written down and not yet sent: its proposal, and the people it pays as positions in the leg. */
export interface RetryOrderOnTheWire extends RaiseOrderOnTheWire {
  readonly indices: ReadonlyArray<number>;
}

/** The parts of a proposal this module reads. */
export interface RoundOnThePage {
  readonly id: string;
  readonly chainId: string;
  readonly status: string;
  readonly txRef?: string;
  readonly raisedAt?: string;
  readonly approvalRound?: { readonly state: string; readonly approvals?: number };
}

/**
 * What raising one leg will ask its vault to pay, as the service hands it over:
 * a kind, a token and an amount per payment, and nothing about who is paid.
 */
export interface LegPaymentsOnTheWire {
  readonly asset: string;
  readonly payments: ReadonlyArray<{ readonly kind: string; readonly token: string; readonly amount: string }>;
}

/** What this module asks of the company's service. */
export interface GovernedCallService {
  legPayments(runId: string, body: { viewingKey: string; asset?: string }): Promise<LegPaymentsOnTheWire>;
  raiseRun(runId: string, body: {
    viewingKey: string; asset?: string; vault: string; opensAt: string; closesAt: string; onDevice: true;
    version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<{ proposal: RoundOnThePage; order: RaiseOrderOnTheWire | null }>;
  raiseOrder(runId: string, body: { viewingKey: string; asset?: string }): Promise<RaiseOrderOnTheWire>;
  sendRaise(runId: string, body: {
    viewingKey: string; asset?: string; tx: string; version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<RoundOnThePage>;
  /** What a retry of some of one leg's people will ask its vault to pay, in the shape `legPayments` answers. */
  retryPayments(runId: string, body: { viewingKey: string; asset?: string; indices: number[] }): Promise<LegPaymentsOnTheWire>;
  raiseRetry(runId: string, body: {
    viewingKey: string; asset?: string; indices: number[]; vault: string; opensAt: string; closesAt: string; onDevice: true;
    version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<{ proposal: RoundOnThePage; order: RetryOrderOnTheWire | null }>;
  retryOrder(runId: string, body: { viewingKey: string; asset?: string; proposalId: string }): Promise<RetryOrderOnTheWire>;
  sendRetry(runId: string, body: {
    viewingKey: string; asset?: string; proposalId: string; tx: string; version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<RoundOnThePage>;
  callState(accountId: string): Promise<AccountCallChainOnTheWire & { readonly account: string }>;
  approve(proposalId: string, body: { signerId: string; signature: string; viewingKey: string; tx: string }): Promise<RoundOnThePage>;
  standing(proposalId: string, body: { viewingKey: string }): Promise<RoundOnThePage>;
}

export type GovernedStage = 'checking-the-vault' | 'writing-down' | 'reading-the-chain' | 'building' | 'sending' | 'waiting-for-the-chain';

export interface GovernedCallDoors {
  readonly service: GovernedCallService;
  readonly builder: Pick<VaultBuilderClient, 'governedCall'>;
  /** This signer's own three, from the keyring this device opened. */
  readonly material: SignerMaterial;
  readonly accountId: string;
  readonly progress?: (stage: GovernedStage) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the chain to show what was sent, and how often to ask. */
  readonly waitMs?: number;
  readonly everyMs?: number;
}

/** Sent, and the chain has not shown it yet. Not a failure, and not to be sent again. */
export class SentAndNotYetSeen extends Error {
  constructor(what: string, readonly round: RoundOnThePage) {
    super(
      `${what} was sent and the chain has not shown it yet. Do not send it again: open the run later ` +
        'and it will say where the proposal stands.',
    );
    this.name = 'SentAndNotYetSeen';
  }
}

/** The service's own mark of whether a refused send reached the chain, kept rather than guessed. */
export const nothingWasSentBy = (e: unknown): boolean =>
  (e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true
  || /Nothing was sent/u.test(String((e as { message?: unknown } | null)?.message ?? ''));

const counted = (r: RoundOnThePage): number =>
  (r.approvalRound && typeof r.approvalRound.approvals === 'number' ? r.approvalRound.approvals : 0);

/**
 * **WHAT THE SERVICE HANDS OVER FOR A RAISE IS A RAISE, OF THE PROPOSAL IT
 * NAMES, AND OF WHAT THE PERSON CHOSE.** Anything else is refused before the
 * worker is asked: a device proves what it is handed, so this is the last place
 * a different call, a different proposal or a different vault or window can be
 * noticed.
 */
export function refuseAnOrderThatIsNotThisRaise(
  order: RaiseOrderOnTheWire, chosen?: { vault: string; opensAt: string; closesAt: string },
): void {
  const o = order.order as { circuit?: unknown; proposal?: unknown; run?: RaiseOrderOnTheWire['order']['run'] };
  if (o.circuit !== 'propose' || String(o.proposal).toLowerCase() !== String(order.chainId).toLowerCase()) {
    throw new Error('what the company handed this device is not the proposal it wrote down. Nothing was built or sent.');
  }
  if (chosen !== undefined && (o.run?.vault.toLowerCase() !== chosen.vault.toLowerCase()
    || o.run?.opensAt !== chosen.opensAt || o.run?.closesAt !== chosen.closesAt)) {
    throw new Error(
      'the proposal the company wrote down names another vault or another window than the ones chosen here. '
        + 'Nothing was built or sent.');
  }
}

/** Asks where a proposal stands until `seen` says so, or until the wait is over. */
const waitFor = async (
  doors: GovernedCallDoors, what: string, proposalId: string, viewingKey: string,
  seen: (r: RoundOnThePage) => boolean, last: RoundOnThePage,
): Promise<RoundOnThePage> => {
  const sleep = doors.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = doors.waitMs ?? 5 * 60_000;
  const everyMs = doors.everyMs ?? 6_000;
  doors.progress?.('waiting-for-the-chain');
  let now = last;
  for (let waited = 0; waited < waitMs; waited += everyMs) {
    await sleep(everyMs);
    try {
      now = await doors.service.standing(proposalId, { viewingKey });
    } catch {
      /* A read that failed says nothing about what was sent; ask again. */
      continue;
    }
    if (seen(now)) return now;
  }
  throw new SentAndNotYetSeen(what, now);
};

/**
 * Builds the proposal the service wrote down, sends it, and waits for the chain
 * to hold it. **The vault is checked on this device first, every time** - a
 * first send and a send again alike - because a proposal written down days ago
 * is paid from the vault as it is now. The send carries the digest of what was
 * checked, and the service refuses it unless that is the proposal it wrote down.
 */
export async function sendRaiseFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; order?: RaiseOrderOnTheWire;
    /** What the person chose, when this device is raising the leg now: the order must describe exactly that. */
    chosen?: { vault: string; opensAt: string; closesAt: string };
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = input.asset === undefined ? {} : { asset: input.asset };
  const order = input.order ?? await service.raiseOrder(input.runId, { viewingKey: input.viewingKey, ...asked });
  refuseAnOrderThatIsNotThisRaise(order, input.chosen);
  doors.progress?.('checking-the-vault');
  const checked = await refuseALegTheVaultCannotPay(doors, {
    runId: input.runId, viewingKey: input.viewingKey, ...asked, vault: order.order.run.vault,
  });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.sendRaise(input.runId, {
    viewingKey: input.viewingKey, ...asked, tx, version: DEVICE_RAISE_VERSION, checked,
  }));
}

/** Builds and proves what the service wrote down, hands it to `send`, and waits for the chain to hold it. */
async function buildAndSend(
  doors: GovernedCallDoors, order: RaiseOrderOnTheWire, viewingKey: string,
  send: (tx: string) => Promise<RoundOnThePage>,
): Promise<RoundOnThePage> {
  doors.progress?.('reading-the-chain');
  const chain = await doors.service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: order.order, material: doors.material, chain,
  });
  doors.progress?.('sending');
  const sent = await send(tx);
  return waitFor(doors, 'this proposal', order.proposalId, viewingKey, (r) => Boolean(r.raisedAt), sent);
}

/** A raise also needs to know what the vault holds privately, which only this device can read. */
export interface RaiseDoors extends GovernedCallDoors {
  /** The vault's private money, read from the pool this device opens. */
  readonly holdings: VaultHoldings;
  /** The asset rows the payments are checked against. The product's own when not given. */
  readonly assets?: AssetRegistry;
}

const DIGITS = /^[0-9]+$/u;

/**
 * **WHETHER THE VAULT CAN PAY THIS LEG'S PRIVATE PAYMENTS, ASKED HERE BEFORE THE
 * SERVICE IS ASKED TO WRITE ANYTHING DOWN.** The vault's notes are opened on
 * this device and nowhere else, so this is the one place the question can be
 * answered; the service asks the rest. A refusal writes nothing and spends
 * nothing. The only thing that goes to the service to ask it is what it already
 * had: the run, the leg and the viewing key. What comes back is the digest of
 * the payments checked, which is all the service is told about the check.
 */
async function refuseALegTheVaultCannotPay(
  doors: RaiseDoors, input: { runId: string; viewingKey: string; asset?: string; vault: string },
): Promise<string> {
  const leg = await doors.service.legPayments(input.runId, {
    viewingKey: input.viewingKey, ...(input.asset === undefined ? {} : { asset: input.asset }),
  });
  return refusePaymentsTheVaultCannotPay(doors, leg, input);
}

/**
 * **THE CHECK ITSELF, OVER WHATEVER PAYMENTS THE SERVICE HANDED OVER** - a
 * leg's, or a retry's. The digest returned is over exactly what was handed
 * over, in its order.
 */
async function refusePaymentsTheVaultCannotPay(
  doors: RaiseDoors, leg: LegPaymentsOnTheWire, input: { asset?: string; vault: string },
): Promise<string> {
  if (input.asset !== undefined && leg.asset !== input.asset) {
    throw new Error(`the company answered for its ${leg.asset} payments when ${input.asset} is being raised. `
      + 'Nothing was raised and no fee was spent.');
  }
  const payments = leg.payments.map((p, at): PaymentAsked => {
    const kind = p.kind;
    if ((kind !== 'shielded' && kind !== 'unshielded') || !DIGITS.test(String(p.amount))) {
      throw new Error(`payment ${at + 1} on this run came back from the company in a shape this device cannot `
        + 'check. Nothing was raised and no fee was spent.');
    }
    return { payee: { kind }, token: String(p.token), amount: BigInt(p.amount) };
  });
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault: input.vault,
    asset: (doors.assets ?? theAssets).require(leg.asset as AssetId),
    total: payments.reduce((a, p) => a + p.amount, 0n),
    payees: BigInt(payments.length),
    payments,
  }, ['shielded']);
  return paymentsCheckedDigest(leg.payments.map((p) => [p.kind, p.token, p.amount] as const));
}

/**
 * **ONE LEG OF A RUN, RAISED FROM THIS DEVICE.** Its private payments are
 * checked against the vault's notes here first. The service then writes the
 * proposal down, so a device that stops part way leaves a proposal that can be
 * sent again with `sendRaiseFromDevice`, never a second proposal over the same
 * people.
 */
export async function raiseRunOnDevice(
  doors: RaiseDoors,
  input: { runId: string; viewingKey: string; asset?: string; vault: string; opensAt: string; closesAt: string },
): Promise<RoundOnThePage> {
  doors.progress?.('checking-the-vault');
  const checked = await refuseALegTheVaultCannotPay(doors, input);
  doors.progress?.('writing-down');
  const raised = await doors.service.raiseRun(input.runId, {
    viewingKey: input.viewingKey, vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt,
    ...(input.asset === undefined ? {} : { asset: input.asset }), onDevice: true,
    version: DEVICE_RAISE_VERSION, checked,
  });
  /* A proposal the chain already holds - one raised before and seen since - has nothing to send. */
  if (raised.order === null) return raised.proposal;
  return sendRaiseFromDevice(doors, {
    runId: input.runId, viewingKey: input.viewingKey, order: raised.order,
    chosen: { vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt },
    ...(input.asset === undefined ? {} : { asset: input.asset }),
  });
}

/**
 * **WHO A RETRY OF A STOPPED RUN PAYS: THE PEOPLE THE RUN HAS NOT PAID, AND
 * NOBODY ELSE.** Read from the run's own payment view, as positions in the leg.
 * A person the account records as paid is never named, and neither is one a
 * person decided not to pay. Nothing is offered when the view could not say who
 * was paid, or could not prove its people are this run's: a retry chosen from an
 * answer about another payroll would be a retry of the wrong people.
 *
 * **AND ONLY WHEN THE RETRY CAN BE RAISED: NOBODY WHILE THE RUN'S WINDOW HAS NOT
 * CLOSED, AND NOBODY A SENT RETRY CAN STILL PAY.** While the run's own round can
 * still pay them a retry would be a second round over the same people, and so
 * would a retry over people another retry on the chain still covers; the
 * company refuses both. So the people offered are the view's `stranded` - owed,
 * with nothing left that can pay them - and none of its `outstanding` beyond.
 */
export function unpaidToRetry(view: {
  readonly answered: boolean;
  readonly status?: {
    readonly verified: boolean;
    readonly outstanding: ReadonlyArray<{ readonly index: number; readonly state: string }>;
    readonly phase?: string;
    readonly stranded?: ReadonlyArray<{ readonly index: number; readonly state: string }>;
  };
}): number[] {
  if (!view.answered || !view.status?.verified) return [];
  if (view.status.phase !== 'closed') return [];
  return (view.status.stranded ?? [])
    .filter((p) => p.state === 'failed' || p.state === 'unsent')
    .map((p) => p.index)
    .sort((a, b) => a - b);
}

const refuseAnOrderThatIsNotThisRetry = (order: RetryOrderOnTheWire, indices: ReadonlyArray<number>): void => {
  if (order.indices.length !== indices.length || order.indices.some((i, at) => i !== indices[at])) {
    throw new Error('the retry on record pays other people than the ones chosen on this page. Reload the run and choose '
      + 'again. Nothing was built or sent.');
  }
};

/**
 * **A RETRY WRITTEN DOWN AND NOT YET SENT, BUILT AND SENT FROM THIS DEVICE.**
 * The vault is checked here for exactly the retry's payments right before the
 * send, every time, as a leg's are.
 */
export async function sendRetryFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; proposalId: string; order?: RetryOrderOnTheWire;
    chosen?: { indices: ReadonlyArray<number>; vault: string; opensAt: string; closesAt: string };
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = input.asset === undefined ? {} : { asset: input.asset };
  const order = input.order ?? await service.retryOrder(input.runId, {
    viewingKey: input.viewingKey, ...asked, proposalId: input.proposalId,
  });
  if (order.proposalId !== input.proposalId) {
    throw new Error('the retry this device was handed is not the one on record. Reload the page and try again. Nothing '
      + 'was built or sent.');
  }
  refuseAnOrderThatIsNotThisRaise(order, input.chosen);
  if (input.chosen !== undefined) refuseAnOrderThatIsNotThisRetry(order, input.chosen.indices);
  doors.progress?.('checking-the-vault');
  const checked = await refusePaymentsTheVaultCannotPay(doors, await service.retryPayments(input.runId, {
    viewingKey: input.viewingKey, ...asked, indices: [...order.indices],
  }), { ...asked, vault: order.order.run.vault });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.sendRetry(input.runId, {
    viewingKey: input.viewingKey, ...asked, proposalId: order.proposalId, tx, version: DEVICE_RAISE_VERSION, checked,
  }));
}

/**
 * **A RETRY OF SOME OF ONE LEG'S PEOPLE, RAISED FROM THIS DEVICE.** Their
 * payments are checked against the vault's notes here first; the service then
 * writes the retry down under every rule a retry has, and this device builds,
 * proves and sends it. A device that stops part way leaves a retry that raising
 * the same people again sends as itself.
 */
export async function raiseRetryOnDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; indices: ReadonlyArray<number>;
    vault: string; opensAt: string; closesAt: string;
  },
): Promise<RoundOnThePage> {
  const asked = input.asset === undefined ? {} : { asset: input.asset };
  const indices = [...input.indices];
  doors.progress?.('checking-the-vault');
  const checked = await refusePaymentsTheVaultCannotPay(doors, await doors.service.retryPayments(input.runId, {
    viewingKey: input.viewingKey, ...asked, indices,
  }), { ...asked, vault: input.vault });
  doors.progress?.('writing-down');
  const raised = await doors.service.raiseRetry(input.runId, {
    viewingKey: input.viewingKey, ...asked, indices, vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt,
    onDevice: true, version: DEVICE_RAISE_VERSION, checked,
  });
  if (raised.order === null) return raised.proposal;
  return sendRetryFromDevice(doors, {
    runId: input.runId, viewingKey: input.viewingKey, ...asked, proposalId: raised.order.proposalId, order: raised.order,
    chosen: { indices, vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt },
  });
}

/**
 * **ONE APPROVAL, FROM THIS DEVICE.** The signature is made by the caller with
 * the keyring, the approval is built and proved in the worker, and both go to
 * the service together. Then the chain is asked until it counts one more.
 */
export async function approveOnDevice(
  doors: GovernedCallDoors,
  input: { round: RoundOnThePage; signerId: string; signature: string; viewingKey: string },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const before = await service.standing(input.round.id, { viewingKey: input.viewingKey });
  /* The proposal proved is the one the person was shown and signed for, or nothing is built. */
  if (String(before.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
    throw new Error('the company now names another proposal than the one shown here. Nothing was built or sent.');
  }
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: { circuit: 'approve', proposal: before.chainId }, material: doors.material, chain,
  });
  doors.progress?.('sending');
  const sent = await service.approve(input.round.id, {
    signerId: input.signerId, signature: input.signature, viewingKey: input.viewingKey, tx,
  });
  const wanted = counted(before) + 1;
  return waitFor(doors, 'your approval', input.round.id, input.viewingKey,
    (r) => r.status === 'approved' || counted(r) >= wanted, sent);
}

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** A refusal from the service keeps the service's own mark of whether anything was sent. */
const marked = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    throw Object.assign(new Error(message), { nothingWasSent: nothingWasSentBy(e) });
  }
};

/** The service's routes, over this page's own sign-in. Every key travels in a body, never in an address. */
export const governedCallServiceFor = (api: Api): GovernedCallService => {
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const run = (id: string) => `/api/runs/${encodeURIComponent(id)}`;
  const proposal = (id: string) => `/api/proposals/${encodeURIComponent(id)}`;
  return {
    legPayments: (runId, body) => post(`${run(runId)}/leg-payments`, body),
    raiseRun: (runId, body) => post(`${run(runId)}/propose`, body),
    raiseOrder: (runId, body) => post(`${run(runId)}/raise-order`, body),
    sendRaise: (runId, body) => marked(() => post(`${run(runId)}/raise-send`, body)),
    retryPayments: (runId, body) => post(`${run(runId)}/retry-payments`, body),
    raiseRetry: (runId, body) => post(`${run(runId)}/retry`, body),
    retryOrder: (runId, body) => post(`${run(runId)}/retry-order`, body),
    sendRetry: (runId, body) => marked(() => post(`${run(runId)}/retry-send`, body)),
    callState: (accountId) => api(`/api/accounts/${encodeURIComponent(accountId)}/call-state`),
    approve: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/approve`, body)),
    standing: (proposalId, body) => post(`${proposal(proposalId)}/standing`, body),
  };
};
